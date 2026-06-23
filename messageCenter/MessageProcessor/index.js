const sql = require('mssql');
const sgMail = require('@sendgrid/mail');
const twilio = require('twilio');
const { ensureConnected, resolveSendFromStrict, resolveSmsFromStrict, formatPhone, NULL_RECIPIENT_SENTINEL } = require('../shared/tenantMessaging');
const { buildEmailHtmlParts } = require('../shared/emailContent');
const { processBulkBatch } = require('../shared/bulkBlastProcessor');
const { platformDefaultFromEmail } = require('../shared/tenantEmailFrom');

// === Initialize services ===
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

/**
 * Mark a message as Sent (unconditional), then read back status for visibility.
 * Uses only columns present in oe.MessageQueue: Status, ProcessedDate.
 */
async function forceMarkSent(pool, context, messageId) {
  await ensureConnected(pool);

  const result = await pool.request()
    .input('MessageId', sql.UniqueIdentifier, messageId)
    .query(`
      UPDATE oe.MessageQueue
         SET Status = 'Sent',
             ProcessedDate = GETDATE()
       WHERE MessageId = @MessageId;

      SELECT Status FROM oe.MessageQueue WHERE MessageId = @MessageId;
    `);

  const rows = Array.isArray(result.rowsAffected) ? result.rowsAffected[0] : result.rowsAffected;
  const statusNow = result.recordset && result.recordset[0] ? result.recordset[0].Status : null;
  if (context && context.log) {
    context.log('forceMarkSent -> rowsAffected=' + rows + ', statusNow=' + statusNow);
  }
  return statusNow === 'Sent';
}

/**
 * Mark a message as SentHistoryFailed when SMS/Email was sent but MessageHistory insert failed.
 * Message stays in queue (not cleaned up) for manual review; we do not retry (would double-send).
 */
async function markSentHistoryFailed(pool, context, messageId, historyErrorMsg) {
  await ensureConnected(pool);

  await pool.request()
    .input('MessageId', sql.UniqueIdentifier, messageId)
    .input('Status', sql.NVarChar, 'SentHistoryFailed')
    .input('ErrorMessage', sql.NVarChar, 'History insert failed: ' + (historyErrorMsg || 'Unknown'))
    .query(`
      UPDATE oe.MessageQueue
         SET Status = @Status,
             ErrorMessage = @ErrorMessage,
             ProcessedDate = GETDATE()
       WHERE MessageId = @MessageId
    `);

  if (context && context.log) {
    context.log.warn('Marked ' + messageId + ' as SentHistoryFailed (SMS/Email sent but history write failed)');
  }
}

/**
 * Clean up sent messages from MessageQueue after they've been recorded in MessageHistory.
 * This prevents the MessageQueue from growing indefinitely.
 */
async function cleanupSentMessages(pool, context) {
  await ensureConnected(pool);

  try {
    // Get count of sent messages to be cleaned up
    const countResult = await pool.request().query(`
      SELECT COUNT(*) as totalToCleanup
      FROM oe.MessageQueue 
      WHERE Status = 'Sent'
    `);

    const totalToCleanup = countResult.recordset[0]?.totalToCleanup || 0;

    if (totalToCleanup === 0) {
      context.log('No sent messages found in queue to cleanup');
      return 0;
    }

    // Delete sent messages from MessageQueue
    const deleteResult = await pool.request().query(`
      DELETE FROM oe.MessageQueue 
      WHERE Status = 'Sent'
    `);

    const actualDeleted = Array.isArray(deleteResult.rowsAffected) 
      ? deleteResult.rowsAffected[0] 
      : deleteResult.rowsAffected;

    context.log(`✅ Cleaned up ${actualDeleted} sent messages from MessageQueue`);
    return actualDeleted;

  } catch (error) {
    context.log(`❌ Error during MessageQueue cleanup: ${error.message}`);
    return 0;
  }
}

module.exports = async function (context, myTimer) {
  context.log('MessageProcessor (Email + SMS; Push stub) started');
  // Log which DB the running app is using (from Azure App Settings or local.settings.json); no secrets
  context.log('MessageProcessor DB config: DB_SERVER=' + (process.env.DB_SERVER || 'NOT SET') + ', DB_NAME=' + (process.env.DB_NAME || 'NOT SET'));

  const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false }
  };

  const pool = new sql.ConnectionPool(dbConfig);

  try {
    context.log('Connecting to database...');
    await pool.connect();
    context.log('Database connected successfully');

    // === Atomic claim of PENDING messages (Email, SMS, Push, BulkBatch) ===
    // Lower QueuePriority first (0 = transactional, 10 = bulk blast job).
    // Max messages per timer run (default 100). Override with MESSAGE_BATCH_SIZE app setting (1–500).
    const parsedBatch = parseInt(process.env.MESSAGE_BATCH_SIZE || '100', 10);
    const batchSize = Math.min(500, Math.max(1, Number.isFinite(parsedBatch) && parsedBatch > 0 ? parsedBatch : 100));
    context.log('Claiming pending messages (batch size ' + batchSize + ')...');

    const claimResult = await pool.request()
      .input('BatchSize', sql.Int, batchSize)
      .query(`
        ;WITH cte AS (
          SELECT TOP (@BatchSize) mq.MessageId
          FROM oe.MessageQueue AS mq WITH (ROWLOCK, READPAST, UPDLOCK)
          WHERE mq.Status = 'Pending'
            AND mq.RetryCount < 3
            AND (mq.ScheduledSendDate IS NULL OR mq.ScheduledSendDate <= GETUTCDATE())
            AND mq.MessageType IN ('Email','SMS','Push','BulkBatch')
          ORDER BY mq.QueuePriority ASC, mq.CreatedDate ASC
        )
        UPDATE mq
           SET mq.Status = 'Processing'
        OUTPUT inserted.MessageId,
               inserted.TenantId,
               inserted.RecipientId,
               inserted.MessageType,
               inserted.RecipientAddress,
               inserted.Subject,
               inserted.Body,
               inserted.RetryCount,
               inserted.BatchId
        FROM oe.MessageQueue AS mq
        INNER JOIN cte ON cte.MessageId = mq.MessageId;
      `);

    const messages = claimResult.recordset || [];
    if (!messages.length) {
      context.log('No pending messages to process');
      await pool.close();
      return;
    }

    context.log('Claimed ' + messages.length + ' messages');

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      context.log('Processing ' + (i + 1) + '/' + messages.length + ': ' + message.MessageId + ' (' + message.MessageType + ')');

      let providerId = null;

      try {
        if (message.MessageType === 'BulkBatch') {
          await processBulkBatch(context, pool, message);
          continue;
        }

        if (message.MessageType === 'Email') {
          // === EMAIL ===
          const { emailText, emailHtml, replyToParam, metaFromQueue, listUnsubscribeHeaders } = buildEmailHtmlParts(message.Body, context);

          const resolved = await resolveSendFromStrict(pool, message.TenantId, context);
          let fromName = resolved.fromName;
          let fromEmail = resolved.fromEmail;
          if (metaFromQueue.fromName && String(metaFromQueue.fromName).trim()) {
            fromName = String(metaFromQueue.fromName).trim();
          }
          if (metaFromQueue.fromEmail && String(metaFromQueue.fromEmail).trim()) {
            fromEmail = String(metaFromQueue.fromEmail).trim();
          }
          const fromHeader = fromName + ' <' + fromEmail + '>';
          if (context && context.log && (metaFromQueue.fromName || metaFromQueue.fromEmail)) {
            context.log('Applied METADATA from overrides for display/from where provided');
          }

          context.log('📧 Final email - Text length: ' + emailText.length + ', HTML length: ' + emailHtml.length);

          const msg = {
            to: message.RecipientAddress,
            from: fromHeader,
            subject: message.Subject || 'Notification',
            // Only include text if we have a separate text version (not for HTML-only emails)
            ...(emailText && emailText !== emailHtml ? { text: emailText } : {}),
            html: emailHtml, // Always include HTML
            // SendGrid: set both keys so Mail helper / API get Reply-To (API uses reply_to)
            ...(replyToParam ? { reply_to: replyToParam, replyTo: replyToParam } : {}),
            ...(listUnsubscribeHeaders ? { headers: listUnsubscribeHeaders } : {}),
            // Tag with MessageId so SendGrid event webhook can link events back
            // to this oe.MessageHistory row (Stage 3 consumer).
            custom_args: { MessageId: message.MessageId },
            trackingSettings: {
              clickTracking: {
                enable: false
              },
              openTracking: {
                enable: true
              }
            }
          };

          const defaultFrom = platformDefaultFromEmail();
          let responseArr;
          try {
            responseArr = await sgMail.send(msg);
          } catch (sendErr) {
            const is403 = sendErr.code === 403 || sendErr.response?.statusCode === 403;
            if (is403 && fromEmail !== defaultFrom) {
              context.log.warn(
                'SendGrid 403 for ' + fromEmail + '; retrying with ' + defaultFrom + ' (messageId=' + message.MessageId + ')'
              );
              const fallbackMsg = { ...msg, from: fromName + ' <' + defaultFrom + '>' };
              responseArr = await sgMail.send(fallbackMsg);
              fromEmail = defaultFrom;
            } else {
              throw sendErr;
            }
          }
          const response = responseArr && responseArr[0] ? responseArr[0] : null;
          providerId = response && response.headers ? (response.headers['x-message-id'] || 'accepted-202') : 'accepted-202';
          context.log('Email accepted by SendGrid with ID: ' + providerId);

          // Write history first; only mark Sent if history succeeds (do not remove from queue if history fails)
          const recipientIdForHistory = message.RecipientId || NULL_RECIPIENT_SENTINEL;
          try {
            await ensureConnected(pool);
            await pool.request()
              .input('HistoryId', sql.UniqueIdentifier, undefined) // NEWID() in SQL
              .input('MessageId', sql.UniqueIdentifier, message.MessageId)
              .input('TenantId', sql.UniqueIdentifier, message.TenantId)
              .input('RecipientId', sql.UniqueIdentifier, recipientIdForHistory)
              .input('MessageType', sql.NVarChar, message.MessageType)
              .input('RecipientAddress', sql.NVarChar, message.RecipientAddress)
              .input('Subject', sql.NVarChar, message.Subject || null)
              .input('ProviderMessageId', sql.NVarChar, providerId || null)
              .input('ErrorMessage', sql.NVarChar, null)
              .input('batchId', sql.UniqueIdentifier, message.BatchId || null)
              .input('Body', sql.NVarChar(sql.MAX), emailHtml || null)
              .input('FromAddress', sql.NVarChar(320), fromEmail || null)
              .query(`
                INSERT INTO oe.MessageHistory (
                  HistoryId, MessageId, TenantId, RecipientId, MessageType,
                  RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage, SentDate, BatchId,
                  Body, FromAddress
                )
                VALUES (
                  NEWID(), @MessageId, @TenantId, @RecipientId, @MessageType,
                  @RecipientAddress, @Subject, 'Sent', @ProviderMessageId, @ErrorMessage, GETDATE(), @batchId,
                  @Body, @FromAddress
                )
              `);
            const ok = await forceMarkSent(pool, context, message.MessageId);
            if (!ok) continue;
          } catch (historyError) {
            context.log.warn('Failed to write Sent email history: ' + historyError.message);
            await markSentHistoryFailed(pool, context, message.MessageId, historyError.message);
          }

        } else if (message.MessageType === 'SMS') {
          // === SMS ===
          if (!twilioClient) {
            throw new Error('Twilio not configured (missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)');
          }

          const fromPhone = await resolveSmsFromStrict(pool, message.TenantId, context);
          if (!fromPhone || !fromPhone.startsWith('+')) {
            throw new Error('No SMS from number configured (set TWILIO_PHONE_NUMBER or tenant AdvancedSettings.sms.customFromPhone)');
          }

          const to = formatPhone(message.RecipientAddress);
          if (!to || !to.startsWith('+')) {
            throw new Error('Invalid SMS recipient number: ' + message.RecipientAddress);
          }

          const result = await twilioClient.messages.create({
            body: message.Body || '',
            from: fromPhone,
            to,
            smartEncoded: false
          });

          providerId = result && result.sid ? result.sid : 'sent';
          context.log('SMS sent successfully with SID: ' + providerId);

          // Write history first; only mark Sent if history succeeds (do not remove from queue if history fails)
          const recipientIdForHistory = message.RecipientId || NULL_RECIPIENT_SENTINEL;
          try {
            await ensureConnected(pool);
            await pool.request()
              .input('MessageId', sql.UniqueIdentifier, message.MessageId)
              .input('TenantId', sql.UniqueIdentifier, message.TenantId)
              .input('RecipientId', sql.UniqueIdentifier, recipientIdForHistory)
              .input('MessageType', sql.NVarChar, message.MessageType)
              .input('RecipientAddress', sql.NVarChar, to)
              .input('Subject', sql.NVarChar, message.Subject || null)
              .input('ProviderMessageId', sql.NVarChar, providerId || null)
              .input('ErrorMessage', sql.NVarChar, null)
              .input('batchId', sql.UniqueIdentifier, message.BatchId || null)
              .input('Body', sql.NVarChar(sql.MAX), message.Body || null)
              .input('FromAddress', sql.NVarChar(320), fromPhone || null)
              .query(`
                INSERT INTO oe.MessageHistory (
                  HistoryId, MessageId, TenantId, RecipientId, MessageType,
                  RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage, SentDate, BatchId,
                  Body, FromAddress
                )
                VALUES (
                  NEWID(), @MessageId, @TenantId, @RecipientId, @MessageType,
                  @RecipientAddress, @Subject, 'Sent', @ProviderMessageId, @ErrorMessage, GETDATE(), @batchId,
                  @Body, @FromAddress
                )
              `);
            const ok = await forceMarkSent(pool, context, message.MessageId);
            if (!ok) continue;
          } catch (historyError) {
            context.log.warn('Failed to write Sent SMS history: ' + historyError.message);
            await markSentHistoryFailed(pool, context, message.MessageId, historyError.message);
          }

        } else if (message.MessageType === 'Push') {
          // === PUSH (stub) ===
          // Not implemented yet — mark as Failed to avoid endless retries.
          const errMsg = 'Push notification not implemented';
          context.log.warn(errMsg);

          await ensureConnected(pool);
          await pool.request()
            .input('MessageId', sql.UniqueIdentifier, message.MessageId)
            .input('RetryCount', sql.Int, (message.RetryCount || 0) + 1)
            .input('Status', sql.NVarChar, 'Failed')
            .input('ErrorMessage', sql.NVarChar, errMsg)
            .query(`
              UPDATE oe.MessageQueue
                 SET RetryCount = @RetryCount,
                     Status = @Status,
                     ErrorMessage = @ErrorMessage,
                     ProcessedDate = GETDATE()
               WHERE MessageId = @MessageId
            `);

          try {
            const recipientIdForHistory = message.RecipientId || NULL_RECIPIENT_SENTINEL;
            await pool.request()
              .input('MessageId', sql.UniqueIdentifier, message.MessageId)
              .input('TenantId', sql.UniqueIdentifier, message.TenantId)
              .input('RecipientId', sql.UniqueIdentifier, recipientIdForHistory)
              .input('MessageType', sql.NVarChar, message.MessageType)
              .input('RecipientAddress', sql.NVarChar, message.RecipientAddress)
              .input('Subject', sql.NVarChar, message.Subject || null)
              .input('ErrorMessage', sql.NVarChar, errMsg)
              .input('batchId', sql.UniqueIdentifier, message.BatchId || null)
              .input('Body', sql.NVarChar(sql.MAX), message.Body || null)
              .input('FromAddress', sql.NVarChar(320), null)
              .query(`
                INSERT INTO oe.MessageHistory (
                  HistoryId, MessageId, TenantId, RecipientId, MessageType,
                  RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage, SentDate, BatchId,
                  Body, FromAddress
                )
                VALUES (
                  NEWID(), @MessageId, @TenantId, @RecipientId, @MessageType,
                  @RecipientAddress, @Subject, 'Failed', NULL, @ErrorMessage, GETDATE(), @batchId,
                  @Body, @FromAddress
                )
              `);
          } catch (historyError) {
            context.log.warn('Failed to write Failed Push history: ' + historyError.message);
          }

        } else {
          throw new Error('Unsupported message type: ' + message.MessageType);
        }

      } catch (sendErr) {
        // Only increment retry when send/preconditions failed
        context.log.error('Failed to process ' + message.MessageType + ' ' + message.MessageId + ': ' + sendErr.message);
        try {
          await ensureConnected(pool);

          const newRetryCount = (message.RetryCount || 0) + 1;
          const newStatus = newRetryCount >= 3 ? 'Failed' : 'Pending';

          await pool.request()
            .input('MessageId', sql.UniqueIdentifier, message.MessageId)
            .input('RetryCount', sql.Int, newRetryCount)
            .input('Status', sql.NVarChar, newStatus)
            .input('ErrorMessage', sql.NVarChar, sendErr.message || 'Unknown error')
            .query(`
              UPDATE oe.MessageQueue
                 SET RetryCount = @RetryCount,
                     Status = @Status,
                     ErrorMessage = @ErrorMessage,
                     ProcessedDate = CASE WHEN @Status = 'Failed' THEN GETDATE() ELSE NULL END
               WHERE MessageId = @MessageId
            `);

          // Best-effort failure history (SMS: store E.164 same as Twilio)
          try {
            const recipientIdForHistory = message.RecipientId || NULL_RECIPIENT_SENTINEL;
            const addrForHistory =
              message.MessageType === 'SMS'
                ? (formatPhone(message.RecipientAddress) || message.RecipientAddress)
                : message.RecipientAddress;
            // Body captured best-effort from the queue row. FromAddress is not
            // reliably known in this catch (may have failed before resolution),
            // so store NULL and let the webhook/fallback paths fill in later.
            await pool.request()
              .input('MessageId', sql.UniqueIdentifier, message.MessageId)
              .input('TenantId', sql.UniqueIdentifier, message.TenantId)
              .input('RecipientId', sql.UniqueIdentifier, recipientIdForHistory)
              .input('MessageType', sql.NVarChar, message.MessageType)
              .input('RecipientAddress', sql.NVarChar, addrForHistory)
              .input('Subject', sql.NVarChar, message.Subject || null)
              .input('ErrorMessage', sql.NVarChar, sendErr.message || 'Unknown error')
              .input('batchId', sql.UniqueIdentifier, message.BatchId || null)
              .input('Body', sql.NVarChar(sql.MAX), message.Body || null)
              .input('FromAddress', sql.NVarChar(320), null)
              .query(`
                INSERT INTO oe.MessageHistory (
                  HistoryId, MessageId, TenantId, RecipientId, MessageType,
                  RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage, SentDate, BatchId,
                  Body, FromAddress
                )
                VALUES (
                  NEWID(), @MessageId, @TenantId, @RecipientId, @MessageType,
                  @RecipientAddress, @Subject, 'Failed', NULL, @ErrorMessage, GETDATE(), @batchId,
                  @Body, @FromAddress
                )
              `);
          } catch (histFailErr) {
            context.log.warn('Failed to write Failed history: ' + histFailErr.message);
          }

          context.log('Message ' + message.MessageId + ' retry count updated to ' + newRetryCount + ', status: ' + newStatus);
        } catch (updateError) {
          context.log.error('Failed to update retry count: ' + updateError.message);
        }
      }
    }

    // Clean up sent messages from MessageQueue after processing
    context.log('Starting MessageQueue cleanup...');
    const cleanedCount = await cleanupSentMessages(pool, context);
    if (cleanedCount > 0) {
      context.log(`MessageQueue cleanup completed: ${cleanedCount} sent messages removed`);
    }

    context.log('MessageProcessor completed successfully');

  } catch (error) {
    context.log.error('Fatal error in MessageProcessor: ' + error.message);
    context.log.error('Stack trace: ' + error.stack);
  } finally {
    try {
      if (pool && pool.connected) {
        await pool.close();
        context.log('Database connection closed');
      }
    } catch (closeError) {
      context.log.error('Error closing database connection: ' + closeError.message);
    }
  }
};
