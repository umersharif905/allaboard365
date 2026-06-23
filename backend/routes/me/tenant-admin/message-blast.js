/**
 * Message Blast - Tenant Admin sends SMS/email to agents + optional manual addresses
 * GET  /api/me/tenant-admin/message-blast/agents - list agents (email, phone) for recipient picker
 * POST /api/me/tenant-admin/message-blast/estimate - estimate SMS cost
 * POST /api/me/tenant-admin/message-blast/send - send blast
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const twilio = require('twilio');
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const MessageQueueService = require('../../../services/messageQueue.service');
const blastAudience = require('../../../services/blastAudience.service');
const { resolveMessagingScope } = require('../../../services/messagingScope.service');

const BLAST_ROLES = ['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent'];

const SMS_COST_PER_SEGMENT = Number(process.env.SMS_COST_PER_SEGMENT) || 0.0079;
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

/** Strip HTML to plain text for SMS (preserves newlines and link URLs). */
function stripHtmlForSMS(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') return '';
  let text = htmlContent;
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, (match, url, linkText) => {
    const cleanLinkText = linkText ? linkText.trim() : '';
    return cleanLinkText ? `${cleanLinkText} (${url})` : `(${url})`;
  });
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.split('\n').map((line) => line.trim()).join('\n');
  return text.trim();
}

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return null;
}

function smsSegments(text) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) return 1;
  const gsm7 = isGsm7Text(normalized);

  if (gsm7) {
    const septetLength = gsm7SeptetLength(normalized);
    if (septetLength <= 160) return 1;
    return Math.ceil(septetLength / 153);
  }

  // UCS-2 (unicode) lengths
  const codePointLength = Array.from(normalized).length;
  if (codePointLength <= 70) return 1;
  return Math.ceil(codePointLength / 67);
}

function gsm7SeptetLength(text) {
  const ext = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);
  let total = 0;
  for (const ch of Array.from(text)) {
    total += ext.has(ch) ? 2 : 1;
  }
  return total;
}

function isGsm7Text(text) {
  const gsmBasic = new Set([
    '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
    'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', ' ', '!', '"', '#', '¤', '%',
    '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', '0', '1', '2', '3', '4', '5', '6',
    '7', '8', '9', ':', ';', '<', '=', '>', '?', '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G',
    'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X',
    'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§', '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
    'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'ä', 'ö', 'ñ', 'ü', 'à'
  ]);
  const gsmExtended = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

  for (const ch of Array.from(text)) {
    if (!gsmBasic.has(ch) && !gsmExtended.has(ch)) return false;
  }
  return true;
}

/**
 * GET /api/me/tenant-admin/message-blast/agents
 * List agents for current tenant with Email and Phone (for recipient picker)
 */
router.get('/agents', authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }
    const pool = await getPool();
    const result = await pool.request()
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT 
          a.AgentId AS Id,
          u.FirstName,
          u.LastName,
          u.Email,
          u.PhoneNumber AS Phone
        FROM oe.Agents a
        JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.TenantId = @TenantId
          AND a.Status = 'Active'
          AND u.Status = 'Active'
        ORDER BY u.LastName, u.FirstName
      `);
    const agents = (result.recordset || []).map((r) => ({
      id: r.Id,
      name: [r.FirstName, r.LastName].filter(Boolean).join(' ').trim() || r.Email,
      email: r.Email || null,
      phone: r.Phone || null
    }));
    return res.json({ success: true, data: agents });
  } catch (err) {
    console.error('Message blast agents list error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

/**
 * GET /api/me/tenant-admin/message-blast/audience-options
 * Products/bundles (with active enrollments) and agencies for the audience pickers.
 * Vendor users see only their own VendorId's products.
 */
router.get('/audience-options', authorize(BLAST_ROLES), async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }
    const { vendorIdFilter } = await resolveMessagingScope(req);
    const data = await blastAudience.getAudienceOptions(tenantId, vendorIdFilter);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('Message blast audience-options error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

/**
 * POST /api/me/tenant-admin/message-blast/audience-count
 * Body: { audienceType, productIds?, agencyIds? }
 * Returns resolved recipient counts + opt-out exclusions for live preview.
 */
router.post('/audience-count', authorize(BLAST_ROLES), async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }
    const { audienceType, productIds = [], agencyIds = [] } = req.body || {};
    const resolved = await blastAudience.resolveAudience({ tenantId, audienceType, productIds, agencyIds });
    return res.json({
      success: true,
      data: {
        emailRecipients: resolved.emails.length,
        smsRecipients: resolved.phones.length,
        emailOptedOut: resolved.emailOptedOut,
        smsOptedOut: resolved.smsOptedOut,
        maxRecipients: blastAudience.BLAST_MAX_RECIPIENTS
      }
    });
  } catch (err) {
    if (err instanceof blastAudience.AudienceError) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('Message blast audience-count error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

/**
 * POST /api/me/tenant-admin/message-blast/estimate
 * Body: { sendSMS: boolean, messageBody?: string, smsBody?: string, phoneCount: number }
 * When smsBody is provided, use it for segment count; otherwise strip HTML from messageBody.
 */
router.post('/estimate', authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), async (req, res) => {
  try {
    const { sendSMS, messageBody = '', smsBody: smsBodyParam = '', phoneCount = 0 } = req.body || {};
    if (!sendSMS || phoneCount <= 0) {
      return res.json({
        success: true,
        data: { estimatedCost: 0, segmentCount: 0, messageCount: 0 }
      });
    }
    const plainForSms = typeof smsBodyParam === 'string' && smsBodyParam.trim()
      ? smsBodyParam.trim()
      : stripHtmlForSMS(typeof messageBody === 'string' ? messageBody : '');
    const segmentCount = smsSegments(plainForSms);
    const messageCount = phoneCount;
    const estimatedCost = Math.round(segmentCount * messageCount * SMS_COST_PER_SEGMENT * 100) / 100;
    return res.json({
      success: true,
      data: { estimatedCost, segmentCount, messageCount, costPerSegment: SMS_COST_PER_SEGMENT }
    });
  } catch (err) {
    console.error('Message blast estimate error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

/**
 * POST /api/me/tenant-admin/message-blast/send
 * Body: { sendEmail, sendSMS, subject?, body, smsBody?, agentIds?: [], manualEmails?: [], manualPhones?: [] }
 * - body: HTML/rich content for email (required when sendEmail)
 * - smsBody: plain text for SMS (required when sendSMS; separate from body to avoid stripping HTML)
 * - Reply-To: prefix body with <!-- METADATA:{"replyToEmail":"..."} --> (Message Center bulkBlastProcessor / emailContent.js)
 */
router.post('/send', authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    const userId = req.user?.UserId || req.user?.userId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }
    const {
      sendEmail,
      sendSMS,
      subject = '',
      body,
      smsBody: smsBodyRaw,
      agentIds = [],
      manualEmails = [],
      manualPhones = [],
      audience = null
    } = req.body || {};

    if (!sendEmail && !sendSMS) {
      return res.status(400).json({ success: false, message: 'Select at least one of email or SMS' });
    }
    if (sendEmail && (!body || typeof body !== 'string' || !body.trim())) {
      return res.status(400).json({ success: false, message: 'Email message body is required' });
    }
    if (sendSMS) {
      const plain = typeof smsBodyRaw === 'string' && smsBodyRaw.trim()
        ? smsBodyRaw.trim()
        : (body && typeof body === 'string' ? stripHtmlForSMS(body.trim()) : '');
      if (!plain) {
        return res.status(400).json({ success: false, message: 'SMS message is required' });
      }
    }

    const pool = await getPool();
    const bodyTrimmed = sendEmail ? body.trim() : '';
    const smsPlainText = (typeof smsBodyRaw === 'string' && smsBodyRaw.trim())
      ? smsBodyRaw.trim()
      : (bodyTrimmed ? stripHtmlForSMS(bodyTrimmed) : '');
    const smsBody = smsPlainText;

    const emails = [];
    const phones = [];

    if (Array.isArray(agentIds) && agentIds.length > 0) {
      const ids = agentIds.filter(Boolean);
      if (ids.length > 0) {
        const placeholders = ids.map((_, i) => `@agentId${i}`).join(',');
        const req = pool.request();
        ids.forEach((id, i) => req.input(`agentId${i}`, sql.UniqueIdentifier, id));
        req.input('TenantId', sql.UniqueIdentifier, tenantId);
        const result = await req.query(`
          SELECT u.Email, u.PhoneNumber
          FROM oe.Agents a
          JOIN oe.Users u ON a.UserId = u.UserId
          WHERE a.AgentId IN (${placeholders}) AND a.TenantId = @TenantId AND u.Status = 'Active'
        `);
        (result.recordset || []).forEach((r) => {
          if (r.Email) emails.push(r.Email.toLowerCase());
          const p = normalizePhone(r.PhoneNumber);
          if (p) phones.push(p);
        });
      }
    }

    const manualE = Array.isArray(manualEmails) ? manualEmails : [];
    manualE.forEach((e) => {
      const s = typeof e === 'string' ? e.trim() : '';
      if (s && s.includes('@')) emails.push(s.toLowerCase());
    });

    const manualP = Array.isArray(manualPhones) ? manualPhones : [];
    manualP.forEach((p) => {
      const n = normalizePhone(typeof p === 'string' ? p : String(p));
      if (n) phones.push(n);
    });

    // Filtered-group audience: recipients are resolved server-side from the DB
    // (never trust a client-supplied list for group sends). Tenant-scoped,
    // opt-out aware. See blastAudience.service.js.
    if (audience && audience.audienceType) {
      try {
        const resolved = await blastAudience.resolveAudience({
          tenantId,
          audienceType: audience.audienceType,
          productIds: audience.productIds || [],
          agencyIds: audience.agencyIds || []
        });
        if (sendEmail) resolved.emails.forEach((e) => emails.push(e));
        if (sendSMS) resolved.phones.forEach((p) => phones.push(p));
      } catch (e) {
        if (e instanceof blastAudience.AudienceError) {
          return res.status(400).json({ success: false, message: e.message });
        }
        throw e;
      }
    }

    const uniqueEmails = [...new Set(emails)];
    const uniquePhones = [...new Set(phones)];

    // Enforce the recipient cap per channel (overridable via BLAST_MAX_RECIPIENTS).
    const maxRecipients = blastAudience.BLAST_MAX_RECIPIENTS;
    if (sendEmail && uniqueEmails.length > maxRecipients) {
      return res.status(400).json({
        success: false,
        message: `Too many email recipients (${uniqueEmails.length}). The limit is ${maxRecipients} per send. Narrow your audience or contact an administrator to raise the cap.`
      });
    }
    if (sendSMS && uniquePhones.length > maxRecipients) {
      return res.status(400).json({
        success: false,
        message: `Too many SMS recipients (${uniquePhones.length}). The limit is ${maxRecipients} per send. Narrow your audience or contact an administrator to raise the cap.`
      });
    }

    if (sendEmail && uniqueEmails.length === 0) {
      return res.status(400).json({ success: false, message: 'No email recipients. Add agents or manual email addresses.' });
    }
    if (sendSMS && uniquePhones.length === 0) {
      return res.status(400).json({ success: false, message: 'No SMS recipients. Add agents or manual phone numbers.' });
    }

    const sendBatchId = crypto.randomUUID();
    await pool.request()
      .input('BatchId', sql.UniqueIdentifier, sendBatchId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('Label', sql.NVarChar, 'Message blast')
      .input('SmsTotal', sql.Int, sendSMS ? uniquePhones.length : 0)
      .input('EmailTotal', sql.Int, sendEmail ? uniqueEmails.length : 0)
      .input('CreatedBy', sql.UniqueIdentifier, userId || null)
      .query(`
        INSERT INTO oe.MessageSendBatch (BatchId, TenantId, Label, SmsTotal, EmailTotal, CreatedDate, CreatedBy)
        VALUES (@BatchId, @TenantId, @Label, @SmsTotal, @EmailTotal, GETUTCDATE(), @CreatedBy)
      `);

    const emailsQueued = sendEmail ? uniqueEmails.length : 0;
    const smsQueued = sendSMS ? uniquePhones.length : 0;

    const bulkPayload = {
      v: 1,
      batchId: sendBatchId,
      tenantId,
      sendEmail: !!sendEmail && uniqueEmails.length > 0,
      sendSMS: !!sendSMS && uniquePhones.length > 0,
      subject: subject.trim() || 'Message from AllAboard',
      emailBody: bodyTrimmed,
      smsBody,
      emails: sendEmail ? uniqueEmails : [],
      phones: sendSMS ? uniquePhones : [],
      createdBy: userId || null
    };

    const bulkJobMessageId = await MessageQueueService.queueBulkBatchMessage({
      tenantId,
      batchId: sendBatchId,
      bodyPayload: bulkPayload,
      createdBy: userId || null
    });

    const segmentCount = smsSegments(smsPlainText);
    const estimatedCost = smsQueued > 0
      ? Math.round(segmentCount * smsQueued * SMS_COST_PER_SEGMENT * 100) / 100
      : 0;

    return res.json({
      success: true,
      message: 'Message blast queued successfully',
      data: {
        emailsQueued,
        smsQueued,
        estimatedCost,
        segmentCount,
        smsQueueMessageIds: [],
        sendBatchId,
        bulkJobMessageId
      }
    });
  } catch (err) {
    console.error('Message blast send error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

/**
 * POST /api/me/tenant-admin/message-blast/actual-cost
 * Body: { messageIds?: string[], sendBatchId?: string } — use sendBatchId for bulk-blast SMS rows.
 * Returns Twilio-reported actual totals for already-sent SMS.
 */
router.post('/actual-cost', authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), async (req, res) => {
  try {
    const { messageIds = [], sendBatchId: sendBatchIdRaw = null } = req.body || {};

    if (!twilioClient) {
      return res.status(400).json({
        success: false,
        message: 'Twilio actual-cost lookup unavailable: configure TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on backend app settings.'
      });
    }

    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }

    const pool = await getPool();

    let ids = (Array.isArray(messageIds) ? messageIds : []).filter((id) => typeof id === 'string' && id.trim());

    if (ids.length === 0 && sendBatchIdRaw && typeof sendBatchIdRaw === 'string' && sendBatchIdRaw.trim()) {
      const batchLookup = await pool.request()
        .input('TenantId', sql.UniqueIdentifier, tenantId)
        .input('BatchId', sql.UniqueIdentifier, sendBatchIdRaw.trim())
        .query(`
          SELECT mh.MessageId
          FROM oe.MessageHistory mh
          WHERE mh.TenantId = @TenantId
            AND mh.BatchId = @BatchId
            AND mh.MessageType = N'SMS'
        `);
      ids = (batchLookup.recordset || []).map((r) => String(r.MessageId));
    }

    if (ids.length === 0) {
      return res.json({
        success: true,
        data: {
          totalMessages: 0,
          resolvedMessages: 0,
          pendingMessages: 0,
          totalSegments: 0,
          totalActualCost: 0,
          currency: 'USD'
        }
      });
    }

    const placeholders = ids.map((_, i) => `@id${i}`).join(',');
    const dbReq = pool.request().input('TenantId', sql.UniqueIdentifier, tenantId);
    ids.forEach((id, i) => dbReq.input(`id${i}`, sql.UniqueIdentifier, id));

    const historyResult = await dbReq.query(`
      SELECT 
        mh.MessageId,
        mh.ProviderMessageId,
        mh.Status
      FROM oe.MessageHistory mh
      WHERE mh.TenantId = @TenantId
        AND mh.MessageType = 'SMS'
        AND mh.MessageId IN (${placeholders})
    `);

    const rows = historyResult.recordset || [];
    const byMessageId = new Map(rows.map((r) => [String(r.MessageId).toLowerCase(), r]));

    let totalSegments = 0;
    let totalActualCost = 0;
    let resolvedMessages = 0;
    let pendingMessages = 0;
    let currency = 'USD';

    for (const id of ids) {
      const row = byMessageId.get(String(id).toLowerCase());
      if (!row || !row.ProviderMessageId) {
        pendingMessages++;
        continue;
      }

      try {
        const twilioMessage = await twilioClient.messages(row.ProviderMessageId).fetch();
        const numSegments = Number(twilioMessage.numSegments || 0);
        const rawPrice = twilioMessage.price != null ? Number(twilioMessage.price) : null;
        const absPrice = rawPrice != null && Number.isFinite(rawPrice) ? Math.abs(rawPrice) : null;

        totalSegments += Number.isFinite(numSegments) ? numSegments : 0;
        if (absPrice != null) totalActualCost += absPrice;
        if (twilioMessage.priceUnit) currency = String(twilioMessage.priceUnit).toUpperCase();
        resolvedMessages++;
      } catch (e) {
        pendingMessages++;
      }
    }

    totalActualCost = Math.round(totalActualCost * 100) / 100;

    return res.json({
      success: true,
      data: {
        totalMessages: ids.length,
        resolvedMessages,
        pendingMessages,
        totalSegments,
        totalActualCost,
        currency
      }
    });
  } catch (err) {
    console.error('Message blast actual-cost error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

module.exports = router;
