const twilio = require('twilio');
const { sql } = require('../config/database');

const NULL_RECIPIENT_SENTINEL = '00000000-0000-0000-0000-000000000000';

/** E.164 normalization — same rules as messageCenter/shared/tenantMessaging formatPhone. */
function formatPhone(phone) {
  if (phone == null || phone === '') return phone;
  const s = String(phone).trim();
  if (!s) return '';
  let cleaned = s.replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  return cleaned;
}

/**
 * Resolve Twilio "from" number — same rules as messageCenter resolveSmsFromStrict.
 */
async function resolveSmsFromStrict(pool, tenantId) {
  const res = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);

  if (!res.recordset || res.recordset.length === 0) {
    throw new Error('Tenant not found for TenantId ' + tenantId);
  }

  const row = res.recordset[0];
  let fromPhone = null;

  if (row.AdvancedSettings) {
    try {
      const settings = JSON.parse(row.AdvancedSettings);
      const s = settings && settings.sms ? settings.sms : null;
      if (s && s.customFromPhone && String(s.customFromPhone).trim()) {
        fromPhone = formatPhone(String(s.customFromPhone).trim());
      }
    } catch (err) {
      console.warn('[immediateSms] AdvancedSettings JSON parse failed: ' + err.message);
    }
  }

  if (!fromPhone) {
    fromPhone = process.env.TWILIO_PHONE_NUMBER ? formatPhone(process.env.TWILIO_PHONE_NUMBER) : null;
  }

  return fromPhone;
}

/**
 * Send one SMS via Twilio and write oe.MessageHistory (no MessageQueue row).
 * Matches MessageProcessor SMS behavior for a single row.
 *
 * @returns {Promise<boolean>} true if sent and recorded; false to fall back to queue
 */
async function trySendSmsImmediate({
  pool,
  messageId,
  tenantId,
  recipientId,
  recipientAddress,
  messageBody,
  batchId
}) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('⚠️ [immediateSms] Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN); skipping immediate SMS (will queue)');
    return false;
  }

  const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  let fromPhone;
  try {
    fromPhone = await resolveSmsFromStrict(pool, tenantId);
  } catch (e) {
    console.warn(`⚠️ [immediateSms] Could not resolve from number: ${e.message}`);
    return false;
  }

  if (!fromPhone || !fromPhone.startsWith('+')) {
    console.warn('⚠️ [immediateSms] No SMS from number (TWILIO_PHONE_NUMBER or tenant AdvancedSettings.sms.customFromPhone); skipping immediate SMS (will queue)');
    return false;
  }

  const to = formatPhone(recipientAddress);
  if (!to || !to.startsWith('+')) {
    console.warn(`⚠️ [immediateSms] Invalid SMS recipient: ${recipientAddress}; skipping immediate SMS (will queue)`);
    return false;
  }

  let providerId;
  try {
    const result = await twilioClient.messages.create({
      body: messageBody || '',
      from: fromPhone,
      to,
      smartEncoded: false
    });
    providerId = result && result.sid ? result.sid : 'sent';
  } catch (sendErr) {
    console.warn(`⚠️ [immediateSms] Twilio send failed for ${messageId}: ${sendErr.message}`);
    return false;
  }

  const recipientIdForHistory = recipientId || NULL_RECIPIENT_SENTINEL;
  try {
    await pool.request()
      .input('MessageId', sql.UniqueIdentifier, messageId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('RecipientId', sql.UniqueIdentifier, recipientIdForHistory)
      .input('MessageType', sql.NVarChar, 'SMS')
      .input('RecipientAddress', sql.NVarChar, to)
      .input('Subject', sql.NVarChar, null)
      .input('ProviderMessageId', sql.NVarChar, providerId || null)
      .input('ErrorMessage', sql.NVarChar, null)
      .input('batchId', sql.UniqueIdentifier, batchId || null)
      .query(`
        INSERT INTO oe.MessageHistory (
          HistoryId, MessageId, TenantId, RecipientId, MessageType,
          RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage, SentDate, BatchId
        )
        VALUES (
          NEWID(), @MessageId, @TenantId, @RecipientId, @MessageType,
          @RecipientAddress, @Subject, 'Sent', @ProviderMessageId, @ErrorMessage, GETDATE(), @batchId
        )
      `);
  } catch (historyErr) {
    console.error(`❌ [immediateSms] SMS accepted by Twilio (${providerId}) but MessageHistory insert failed: ${historyErr.message}`);
    return true;
  }

  return true;
}

module.exports = {
  trySendSmsImmediate,
  formatPhone
};
