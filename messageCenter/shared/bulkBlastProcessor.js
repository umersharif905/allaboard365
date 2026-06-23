const crypto = require('crypto');
const sql = require('mssql');
const sgMail = require('@sendgrid/mail');
const twilio = require('twilio');
const { ensureConnected, resolveSendFromStrict, resolveSmsFromStrict, formatPhone, NULL_RECIPIENT_SENTINEL } = require('./tenantMessaging');
const { buildEmailHtmlParts } = require('./emailContent');

const SENDGRID_MAX_PERSONALIZATIONS = 1000;
const SMS_PARALLEL = 25;

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

/**
 * Insert a single recipient into MessageQueue for retry (same shape as backend MessageQueueService.queueMessage).
 */
async function queueSinglePending(pool, context, {
  tenantId,
  messageType,
  recipientAddress,
  subject,
  body,
  batchId,
  createdBy
}) {
  await ensureConnected(pool);
  const messageId = crypto.randomUUID();
  await pool.request()
    .input('messageId', sql.UniqueIdentifier, messageId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('recipientId', sql.UniqueIdentifier, null)
    .input('messageType', sql.NVarChar, messageType)
    .input('recipientAddress', sql.NVarChar, recipientAddress)
    .input('subject', sql.NVarChar, subject)
    .input('body', sql.NVarChar, body)
    .input('status', sql.NVarChar, 'Pending')
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .input('batchId', sql.UniqueIdentifier, batchId || null)
    .input('queuePriority', sql.Int, 0)
    .query(`
      INSERT INTO oe.MessageQueue (
        MessageId, TenantId, RecipientId, MessageType,
        RecipientAddress, Subject, Body, Status,
        RetryCount, CreatedDate, CreatedBy, BatchId, QueuePriority
      ) VALUES (
        @messageId, @tenantId, @recipientId, @messageType,
        @recipientAddress, @subject, @body, @status,
        0, GETUTCDATE(), @createdBy, @batchId, @queuePriority
      )
    `);
  if (context && context.log) {
    context.log('Queued single ' + messageType + ' retry for ' + recipientAddress + ' -> ' + messageId);
  }
  return messageId;
}

async function insertSentHistory(pool, {
  messageId,
  tenantId,
  recipientAddress,
  messageType,
  subject,
  providerMessageId,
  batchId,
  body,
  fromAddress
}) {
  await ensureConnected(pool);
  await pool.request()
    .input('MessageId', sql.UniqueIdentifier, messageId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('RecipientId', sql.UniqueIdentifier, NULL_RECIPIENT_SENTINEL)
    .input('MessageType', sql.NVarChar, messageType)
    .input('RecipientAddress', sql.NVarChar, recipientAddress)
    .input('Subject', sql.NVarChar, subject || null)
    .input('ProviderMessageId', sql.NVarChar, providerMessageId || null)
    .input('ErrorMessage', sql.NVarChar, null)
    .input('batchId', sql.UniqueIdentifier, batchId || null)
    .input('Body', sql.NVarChar(sql.MAX), body || null)
    .input('FromAddress', sql.NVarChar(320), fromAddress || null)
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
}

async function insertFailedHistory(pool, {
  messageId,
  tenantId,
  recipientAddress,
  messageType,
  subject,
  errorMessage,
  batchId,
  body,
  fromAddress
}) {
  await ensureConnected(pool);
  await pool.request()
    .input('MessageId', sql.UniqueIdentifier, messageId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('RecipientId', sql.UniqueIdentifier, NULL_RECIPIENT_SENTINEL)
    .input('MessageType', sql.NVarChar, messageType)
    .input('RecipientAddress', sql.NVarChar, recipientAddress)
    .input('Subject', sql.NVarChar, subject || null)
    .input('ErrorMessage', sql.NVarChar, (errorMessage || 'Unknown').slice(0, 4000))
    .input('batchId', sql.UniqueIdentifier, batchId || null)
    .input('Body', sql.NVarChar(sql.MAX), body || null)
    .input('FromAddress', sql.NVarChar(320), fromAddress || null)
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
}

async function markBulkJobSent(pool, context, jobMessageId) {
  await ensureConnected(pool);
  await pool.request()
    .input('MessageId', sql.UniqueIdentifier, jobMessageId)
    .query(`
      UPDATE oe.MessageQueue
         SET Status = 'Sent',
             ProcessedDate = GETDATE()
       WHERE MessageId = @MessageId
    `);
  if (context && context.log) context.log('BulkBatch job marked Sent: ' + jobMessageId);
}

async function markBulkJobFailed(pool, jobMessageId, errMsg, retryCount) {
  await ensureConnected(pool);
  const newRetryCount = (retryCount || 0) + 1;
  const newStatus = newRetryCount >= 3 ? 'Failed' : 'Pending';
  await pool.request()
    .input('MessageId', sql.UniqueIdentifier, jobMessageId)
    .input('RetryCount', sql.Int, newRetryCount)
    .input('Status', sql.NVarChar, newStatus)
    .input('ErrorMessage', sql.NVarChar, (errMsg || 'Bulk batch failed').slice(0, 4000))
    .query(`
      UPDATE oe.MessageQueue
         SET RetryCount = @RetryCount,
             Status = @Status,
             ErrorMessage = @ErrorMessage,
             ProcessedDate = CASE WHEN @Status = 'Failed' THEN GETDATE() ELSE NULL END
       WHERE MessageId = @MessageId
    `);
}

/**
 * Process one MessageQueue row with MessageType BulkBatch (JSON body).
 */
async function processBulkBatch(context, pool, message) {
  let payload;
  try {
    payload = JSON.parse(message.Body || '{}');
  } catch (e) {
    await markBulkJobFailed(pool, message.MessageId, 'Invalid BulkBatch JSON: ' + e.message, message.RetryCount);
    return;
  }

  if (payload.v !== 1 || !payload.batchId || !payload.tenantId) {
    await markBulkJobFailed(pool, message.MessageId, 'BulkBatch payload missing v, batchId, or tenantId', message.RetryCount);
    return;
  }

  const batchId = payload.batchId;
  const tenantId = payload.tenantId;
  const createdBy = payload.createdBy || null;
  const subject = payload.subject || 'Message from AllAboard';
  const emailBodyRaw = payload.emailBody || '';
  const smsBody = payload.smsBody || '';

  try {
    if (payload.sendEmail && Array.isArray(payload.emails) && payload.emails.length > 0) {
      const { emailText, emailHtml, replyToParam, metaFromQueue } = buildEmailHtmlParts(emailBodyRaw, context);
      const resolved = await resolveSendFromStrict(pool, tenantId, context);
      let fromName = resolved.fromName;
      let fromEmail = resolved.fromEmail;
      if (metaFromQueue.fromName && String(metaFromQueue.fromName).trim()) {
        fromName = String(metaFromQueue.fromName).trim();
      }
      if (metaFromQueue.fromEmail && String(metaFromQueue.fromEmail).trim()) {
        fromEmail = String(metaFromQueue.fromEmail).trim();
      }

      const emails = [...new Set(payload.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      for (let i = 0; i < emails.length; i += SENDGRID_MAX_PERSONALIZATIONS) {
        const chunk = emails.slice(i, i + SENDGRID_MAX_PERSONALIZATIONS);
        // Pre-generate a MessageId per recipient so it can be stamped into the
        // SendGrid personalization's custom_args.MessageId (for webhook linkage)
        // and reused when writing MessageHistory after send.
        const chunkMessageIds = chunk.map(() => crypto.randomUUID());
        const personalizations = chunk.map((email, idx) => ({
          to: [{ email }],
          custom_args: { MessageId: chunkMessageIds[idx] }
        }));
        const content = [];
        if (emailText && emailText.trim()) {
          content.push({ type: 'text/plain', value: emailText });
        }
        content.push({ type: 'text/html', value: emailHtml });

        const msg = {
          personalizations,
          from: { email: fromEmail, name: fromName },
          subject,
          content,
          ...(replyToParam ? { replyTo: replyToParam } : {}),
          trackingSettings: { clickTracking: { enable: false } }
        };

        try {
          const responseArr = await sgMail.send(msg);
          const response = responseArr && responseArr[0] ? responseArr[0] : null;
          const providerId = response && response.headers ? (response.headers['x-message-id'] || 'accepted-202') : 'accepted-202';
          for (let k = 0; k < chunk.length; k++) {
            const email = chunk[k];
            const mid = chunkMessageIds[k];
            try {
              await insertSentHistory(pool, {
                messageId: mid,
                tenantId,
                recipientAddress: email,
                messageType: 'Email',
                subject,
                providerMessageId: providerId,
                batchId,
                body: emailHtml,
                fromAddress: fromEmail
              });
            } catch (histErr) {
              if (context && context.log) context.log.warn('History insert failed for ' + email + ': ' + histErr.message);
            }
          }
        } catch (chunkErr) {
          if (context && context.log) {
            context.log.error('SendGrid bulk chunk failed: ' + chunkErr.message + '; queueing individual retries');
          }
          for (let k = 0; k < chunk.length; k++) {
            const email = chunk[k];
            const mid = chunkMessageIds[k];
            try {
              await insertFailedHistory(pool, {
                messageId: mid,
                tenantId,
                recipientAddress: email,
                messageType: 'Email',
                subject,
                errorMessage: chunkErr.message,
                batchId,
                body: emailHtml,
                fromAddress: fromEmail
              });
            } catch (h) {
              if (context && context.log) context.log.warn('Failed history for chunk fail: ' + h.message);
            }
            try {
              await queueSinglePending(pool, context, {
                tenantId,
                messageType: 'Email',
                recipientAddress: email,
                subject,
                body: emailBodyRaw,
                batchId,
                createdBy
              });
            } catch (q) {
              if (context && context.log) context.log.error('Queue single email failed: ' + q.message);
            }
          }
        }
      }
    }

    if (payload.sendSMS && Array.isArray(payload.phones) && payload.phones.length > 0) {
      if (!twilioClient) {
        throw new Error('Twilio not configured (missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)');
      }
      const fromPhone = await resolveSmsFromStrict(pool, tenantId, context);
      if (!fromPhone || !fromPhone.startsWith('+')) {
        throw new Error('No SMS from number configured');
      }

      const phones = [...new Set(payload.phones.map((p) => formatPhone(String(p))).filter((p) => p && p.startsWith('+')))];
      async function sendOneSms(to) {
        const mid = crypto.randomUUID();
        let providerId = null;
        try {
          const result = await twilioClient.messages.create({
            body: smsBody,
            from: fromPhone,
            to,
            smartEncoded: false
          });
          providerId = result && result.sid ? result.sid : 'sent';
        } catch (twilioErr) {
          const errMsg = twilioErr && twilioErr.message ? twilioErr.message : String(twilioErr);
          try {
            await insertFailedHistory(pool, {
              messageId: mid,
              tenantId,
              recipientAddress: to,
              messageType: 'SMS',
              subject: null,
              errorMessage: errMsg,
              batchId,
              body: smsBody,
              fromAddress: fromPhone
            });
          } catch (h) {
            if (context && context.log) context.log.warn('Failed SMS fail history: ' + h.message);
          }
          try {
            await queueSinglePending(pool, context, {
              tenantId,
              messageType: 'SMS',
              recipientAddress: to,
              subject: null,
              body: smsBody,
              batchId,
              createdBy
            });
          } catch (q) {
            if (context && context.log) context.log.error('Queue single SMS failed: ' + q.message);
          }
          return;
        }
        try {
          await insertSentHistory(pool, {
            messageId: mid,
            tenantId,
            recipientAddress: to,
            messageType: 'SMS',
            subject: null,
            providerMessageId: providerId,
            batchId,
            body: smsBody,
            fromAddress: fromPhone
          });
        } catch (histErr) {
          if (context && context.log) {
            context.log.warn('SMS sent but MessageHistory insert failed for ' + to + ': ' + histErr.message + ' (not re-queued to avoid double send)');
          }
        }
      }

      for (let i = 0; i < phones.length; i += SMS_PARALLEL) {
        const chunk = phones.slice(i, i + SMS_PARALLEL);
        await Promise.all(chunk.map((to) => sendOneSms(to)));
      }
    }

    await markBulkJobSent(pool, context, message.MessageId);
  } catch (fatal) {
    if (context && context.log) context.log.error('BulkBatch fatal: ' + fatal.message);
    await markBulkJobFailed(pool, message.MessageId, fatal.message, message.RetryCount);
  }
}

module.exports = {
  processBulkBatch
};
