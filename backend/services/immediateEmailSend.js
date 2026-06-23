const sgMail = require('@sendgrid/mail');
const { sql } = require('../config/database');
const { buildEmailHtmlParts } = require('./messageEmailContent');
const { resolveFromEmailFromAdvancedSettings, platformDefaultFromEmail } = require('../utils/tenantEmailFrom');

const NULL_RECIPIENT_SENTINEL = '00000000-0000-0000-0000-000000000000';

/**
 * Resolve Send From for email (same rules as messageCenter/shared/tenantMessaging.js).
 */
async function resolveSendFromStrict(pool, tenantId, log) {
  const res = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT Name, AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);

  if (!res.recordset || res.recordset.length === 0) {
    throw new Error('Tenant not found for TenantId ' + tenantId);
  }

  const row = res.recordset[0];
  const fromName = row.Name && String(row.Name).trim() ? String(row.Name).trim() : 'AllAboard365';

  const fromEmail = resolveFromEmailFromAdvancedSettings(row.AdvancedSettings);
  if (log) {
    log(
      fromEmail === platformDefaultFromEmail()
        ? 'Using platform default from address: ' + fromEmail
        : 'Using tenant custom from address: ' + fromEmail
    );
  }

  return { fromName, fromEmail };
}

const noopContext = {
  log: () => {}
};

/**
 * Send one email via SendGrid and write oe.MessageHistory (no MessageQueue row).
 * Matches MessageProcessor behavior for a single Email row.
 *
 * @returns {Promise<boolean>} true if sent and recorded; false to fall back to queue
 */
async function trySendEmailImmediate({
  pool,
  messageId,
  tenantId,
  recipientId,
  toEmail,
  subject,
  emailBody,
  batchId
}) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('⚠️ [immediateEmail] SENDGRID_API_KEY not set; skipping immediate send (will queue)');
    return false;
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const { emailText, emailHtml, replyToParam, metaFromQueue, listUnsubscribeHeaders } = buildEmailHtmlParts(emailBody, noopContext);

  const resolved = await resolveSendFromStrict(pool, tenantId, (msg) => console.log(`📬 [immediateEmail] ${msg}`));
  let fromName = resolved.fromName;
  let fromEmail = resolved.fromEmail;
  if (metaFromQueue.fromName && String(metaFromQueue.fromName).trim()) {
    fromName = String(metaFromQueue.fromName).trim();
  }
  if (metaFromQueue.fromEmail && String(metaFromQueue.fromEmail).trim()) {
    fromEmail = String(metaFromQueue.fromEmail).trim();
  }
  const fromHeader = fromName + ' <' + fromEmail + '>';

  const msg = {
    to: toEmail,
    from: fromHeader,
    subject: subject || 'Notification',
    ...(emailText && emailText !== emailHtml ? { text: emailText } : {}),
    html: emailHtml,
    ...(replyToParam ? { reply_to: replyToParam, replyTo: replyToParam } : {}),
    ...(listUnsubscribeHeaders ? { headers: listUnsubscribeHeaders } : {}),
    trackingSettings: {
      clickTracking: { enable: false },
      openTracking: { enable: true }
    }
  };

  const defaultFrom = platformDefaultFromEmail();

  let providerId;
  try {
    const responseArr = await sgMail.send(msg);
    const response = responseArr && responseArr[0] ? responseArr[0] : null;
    providerId = response && response.headers ? (response.headers['x-message-id'] || 'accepted-202') : 'accepted-202';
  } catch (sendErr) {
    const is403 = sendErr.code === 403 || sendErr.response?.statusCode === 403;
    if (is403 && fromEmail !== defaultFrom) {
      console.warn(
        `⚠️ [immediateEmail] SendGrid 403 for ${fromEmail}; retrying with ${defaultFrom} (messageId=${messageId})`
      );
      try {
        const fallbackMsg = { ...msg, from: fromName + ' <' + defaultFrom + '>' };
        const responseArr = await sgMail.send(fallbackMsg);
        const response = responseArr && responseArr[0] ? responseArr[0] : null;
        providerId =
          response && response.headers ? (response.headers['x-message-id'] || 'accepted-202') : 'accepted-202';
      } catch (retryErr) {
        console.warn(`⚠️ [immediateEmail] SendGrid send failed for ${messageId}: ${retryErr.message}`);
        return false;
      }
    } else {
      console.warn(`⚠️ [immediateEmail] SendGrid send failed for ${messageId}: ${sendErr.message}`);
      return false;
    }
  }

  const recipientIdForHistory = recipientId || NULL_RECIPIENT_SENTINEL;
  try {
    await pool.request()
      .input('MessageId', sql.UniqueIdentifier, messageId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('RecipientId', sql.UniqueIdentifier, recipientIdForHistory)
      .input('MessageType', sql.NVarChar, 'Email')
      .input('RecipientAddress', sql.NVarChar, toEmail)
      .input('Subject', sql.NVarChar, subject || null)
      .input('ProviderMessageId', sql.NVarChar, providerId || null)
      .input('ErrorMessage', sql.NVarChar, null)
      .input('batchId', sql.UniqueIdentifier, batchId || null)
      .input('Body', sql.NVarChar(sql.MAX), emailHtml || null)
      .input('FromAddress', sql.NVarChar(320), fromEmail || null)
      .query(`
        INSERT INTO oe.MessageHistory (
          HistoryId, MessageId, TenantId, RecipientId, MessageType,
          RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage,
          SentDate, BatchId, Body, FromAddress
        )
        VALUES (
          NEWID(), @MessageId, @TenantId, @RecipientId, @MessageType,
          @RecipientAddress, @Subject, 'Sent', @ProviderMessageId, @ErrorMessage,
          GETDATE(), @batchId, @Body, @FromAddress
        )
      `);
  } catch (historyErr) {
    console.error(`❌ [immediateEmail] Email accepted by SendGrid (${providerId}) but MessageHistory insert failed: ${historyErr.message}`);
    return true;
  }

  return true;
}

module.exports = {
  trySendEmailImmediate
};
