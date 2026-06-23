/**
 * Tracks SendGrid mail after the v3 Mail Send API returns 202: inserts MessageHistory for direct sends
 * (e.g. quick quote) and updates MessageHistory + EmailLogs when Event Webhook fires (delivered/bounce/dropped).
 */
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');

const NULL_RECIPIENT_SENTINEL = '00000000-0000-0000-0000-000000000000';

/** Accept API handoff; not final delivery — webhook sets Delivered or Failed. */
const MH_STATUS_SENDING = 'Sending';

function normalizeSendGridMessageIdForMatch(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (!s) return '';
  return s.includes('.') ? s.split('.')[0] : s;
}

/**
 * @param {string} sgMessageId raw from API or webhook (may include .recvd- suffix)
 * @returns {string[]}
 */
function providerIdLookupKeys(sgMessageId) {
  const raw = String(sgMessageId || '').trim().replace(/^<|>$/g, '');
  if (!raw) return [];
  const keys = new Set([raw]);
  const base = normalizeSendGridMessageIdForMatch(raw);
  if (base && base !== raw) keys.add(base);
  return [...keys];
}

/**
 * One newline-delimited audit line from a SendGrid Event Webhook payload (ISO time prefix for UI timeline).
 * @param {object} ev — raw SendGrid event object
 * @returns {string}
 */
function formatSendGridEventLine(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const tsRaw = e.timestamp;
  const ts =
    tsRaw !== undefined && tsRaw !== null && !Number.isNaN(Number(tsRaw))
      ? new Date(Number(tsRaw) * 1000).toISOString()
      : new Date().toISOString();
  const event = String(e.event || 'unknown');
  const parts = [`SendGrid ${event}`];
  const push = (label, val) => {
    if (val === undefined || val === null || val === '') return;
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    parts.push(s.length > 500 ? `${label}=${s.slice(0, 497)}...` : `${label}=${s}`);
  };
  push('reason', e.reason);
  push('status', e.status);
  push('response', e.response);
  push('type', e.type);
  if (e['smtp-id'] !== undefined) push('smtp-id', e['smtp-id']);
  if (e.smtp_id !== undefined) push('smtp-id', e.smtp_id);
  if (e.attempt !== undefined) push('attempt', e.attempt);
  if (e.tls !== undefined) push('tls', e.tls);
  push('bounce_classification', e.bounce_classification);
  push('sg_event_id', e.sg_event_id);
  push('ip', e.ip);
  push('url_offset', e.url_offset);
  push('useragent', e.useragent);
  const detail = parts.join(' · ');
  return `[${ts}] ${detail}`.slice(0, 7800);
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} keys
 * @param {string} line
 * @returns {Promise<number>} rows affected (best-effort sum across keys)
 */
async function appendSendGridLineMessageHistory(pool, keys, line) {
  let n = 0;
  for (const k of keys) {
    const req = pool.request();
    req.input('line', sql.NVarChar(sql.MAX), line);
    req.input('kExact', sql.NVarChar(300), k);
    req.input('kLike', sql.NVarChar(301), `${k}.%`);
    const hr = await req.query(`
      UPDATE oe.MessageHistory
      SET ErrorMessage = CASE
        WHEN ErrorMessage IS NULL OR LTRIM(RTRIM(CAST(ErrorMessage AS NVARCHAR(MAX)))) = N'' THEN @line
        ELSE CAST(ErrorMessage AS NVARCHAR(MAX)) + NCHAR(10) + @line
      END
      WHERE MessageType = N'Email'
        AND (ProviderMessageId = @kExact OR ProviderMessageId LIKE @kLike)
    `);
    n += (hr.rowsAffected && hr.rowsAffected[0]) || 0;
  }
  return n;
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} keys
 * @param {string} line
 * @returns {Promise<number>}
 */
async function appendSendGridLineEmailLogs(pool, keys, line) {
  let n = 0;
  for (const k of keys) {
    const req = pool.request();
    req.input('line', sql.NVarChar(sql.MAX), line);
    req.input('kExact', sql.NVarChar(255), k);
    req.input('kLike', sql.NVarChar(256), `${k}%`);
    const er = await req.query(`
      UPDATE oe.EmailLogs
      SET Error = CASE
        WHEN Error IS NULL OR LTRIM(RTRIM(CAST(Error AS NVARCHAR(MAX)))) = N'' THEN @line
        ELSE CAST(Error AS NVARCHAR(MAX)) + NCHAR(10) + @line
      END
      WHERE MessageId = @kExact
         OR MessageId LIKE @kLike
    `);
    n += (er.rowsAffected && er.rowsAffected[0]) || 0;
  }
  return n;
}

/**
 * Append webhook line and set terminal status on MessageHistory (cumulative log).
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} keys
 * @param {string} line
 * @param {string} nextStatus Delivered | Failed
 * @returns {Promise<number>}
 */
async function terminalUpdateMessageHistory(pool, keys, line, nextStatus) {
  let n = 0;
  for (const k of keys) {
    const req = pool.request();
    req.input('line', sql.NVarChar(sql.MAX), line);
    req.input('st', sql.NVarChar(20), nextStatus);
    req.input('kExact', sql.NVarChar(300), k);
    req.input('kLike', sql.NVarChar(301), `${k}.%`);
    const hr = await req.query(`
      UPDATE oe.MessageHistory
      SET
        ErrorMessage = CASE
          WHEN ErrorMessage IS NULL OR LTRIM(RTRIM(CAST(ErrorMessage AS NVARCHAR(MAX)))) = N'' THEN @line
          ELSE CAST(ErrorMessage AS NVARCHAR(MAX)) + NCHAR(10) + @line
        END,
        Status = CASE
          WHEN @st = N'Delivered' AND Status = N'Failed' THEN Status
          WHEN @st = N'Delivered' THEN N'Delivered'
          WHEN @st = N'Failed' THEN N'Failed'
          ELSE Status
        END
      WHERE MessageType = N'Email'
        AND (ProviderMessageId = @kExact OR ProviderMessageId LIKE @kLike)
    `);
    n += (hr.rowsAffected && hr.rowsAffected[0]) || 0;
  }
  return n;
}

/**
 * Advance MessageHistory.Status to targetStatus, but only if the current
 * Status is in allowedFromStatuses. Also appends the SendGrid event line
 * to ErrorMessage (cumulative log). No-op on rows whose Status is already
 * terminal or past the target in the state machine.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} keys  — provider id lookup keys (exact + normalized)
 * @param {string} line    — formatted SendGrid event line for ErrorMessage log
 * @param {string} targetStatus  — Deferred | Opened
 * @param {string[]} allowedFromStatuses  — Status values the row must currently hold
 * @returns {Promise<number>} rows affected (best-effort sum)
 */
async function advanceStatusIfAllowed(pool, keys, line, targetStatus, allowedFromStatuses) {
  let n = 0;
  const placeholders = allowedFromStatuses.map((_, i) => `@from${i}`).join(',');
  for (const k of keys) {
    const req = pool.request();
    req.input('line', sql.NVarChar(sql.MAX), line);
    req.input('st', sql.NVarChar(20), targetStatus);
    req.input('kExact', sql.NVarChar(300), k);
    req.input('kLike', sql.NVarChar(301), `${k}.%`);
    allowedFromStatuses.forEach((s, i) => req.input(`from${i}`, sql.NVarChar(20), s));
    const hr = await req.query(`
      UPDATE oe.MessageHistory
      SET
        ErrorMessage = CASE
          WHEN ErrorMessage IS NULL OR LTRIM(RTRIM(CAST(ErrorMessage AS NVARCHAR(MAX)))) = N'' THEN @line
          ELSE CAST(ErrorMessage AS NVARCHAR(MAX)) + NCHAR(10) + @line
        END,
        Status = @st
      WHERE MessageType = N'Email'
        AND (ProviderMessageId = @kExact OR ProviderMessageId LIKE @kLike)
        AND Status IN (${placeholders})
    `);
    n += (hr.rowsAffected && hr.rowsAffected[0]) || 0;
  }
  return n;
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} keys
 * @param {string} line
 * @param {string} nextLower delivered | failed (EmailLogs.Status convention)
 * @returns {Promise<number>}
 */
async function terminalUpdateEmailLogs(pool, keys, line, nextLower) {
  let n = 0;
  for (const k of keys) {
    const req = pool.request();
    req.input('line', sql.NVarChar(sql.MAX), line);
    req.input('st', sql.NVarChar(50), nextLower);
    req.input('kExact', sql.NVarChar(255), k);
    req.input('kLike', sql.NVarChar(256), `${k}%`);
    const er = await req.query(`
      UPDATE oe.EmailLogs
      SET
        Error = CASE
          WHEN Error IS NULL OR LTRIM(RTRIM(CAST(Error AS NVARCHAR(MAX)))) = N'' THEN @line
          ELSE CAST(Error AS NVARCHAR(MAX)) + NCHAR(10) + @line
        END,
        Status = CASE
          WHEN @st = N'delivered' AND Status = N'failed' THEN Status
          WHEN @st = N'delivered' THEN N'delivered'
          WHEN @st = N'failed' THEN N'failed'
          ELSE Status
        END
      WHERE MessageId = @kExact
         OR MessageId LIKE @kLike
    `);
    n += (er.rowsAffected && er.rowsAffected[0]) || 0;
  }
  return n;
}

/**
 * Record a quick-quote (or other direct SendGrid) email in MessageHistory so delivery webhooks can update it.
 * MessageId is standalone (no MessageQueue row).
 *
 * @returns {Promise<{ historyId: string, messageId: string }|null>} Row ids for polling Message History, or null if skipped/failed
 */
async function insertQuickQuoteMessageHistory({ tenantId, recipientEmail, subject, providerMessageId }) {
  const pid = String(providerMessageId || '').trim();
  if (!pid || pid === 'unknown' || pid === 'dev-mode-skip') {
    return null;
  }
  try {
    const pool = await getPool();
    const historyId = crypto.randomUUID();
    const historyMessageId = crypto.randomUUID();
    await pool
      .request()
      .input('HistoryId', sql.UniqueIdentifier, historyId)
      .input('MessageId', sql.UniqueIdentifier, historyMessageId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('RecipientId', sql.UniqueIdentifier, NULL_RECIPIENT_SENTINEL)
      .input('RecipientAddress', sql.NVarChar(500), recipientEmail)
      .input('Subject', sql.NVarChar(200), subject || null)
      .input('ProviderMessageId', sql.NVarChar(300), pid)
      .input('initialStatus', sql.NVarChar(20), MH_STATUS_SENDING)
      .query(`
        INSERT INTO oe.MessageHistory (
          HistoryId, MessageId, TenantId, RecipientId, MessageType,
          RecipientAddress, Subject, Status, ProviderMessageId, ErrorMessage, SentDate, BatchId
        )
        VALUES (
          @HistoryId, @MessageId, @TenantId, @RecipientId, N'Email',
          @RecipientAddress, @Subject, @initialStatus, @ProviderMessageId, NULL, GETUTCDATE(), NULL
        )
      `);
    return { historyId, messageId: historyMessageId };
  } catch (err) {
    console.error('[sendGridEmailDeliveryTracking] MessageHistory insert failed:', err.message);
    return null;
  }
}

/**
 * Apply one SendGrid event to MessageHistory and EmailLogs.
 * Status transitions (never downgrade):
 *   processed           → append-only log, no Status change
 *   deferred            → Status: Sent → Deferred
 *   delivered           → Status: → Delivered (unless Failed)
 *   bounce/dropped      → Status: → Failed
 *   open                → Status: Sent/Deferred/Delivered → Opened
 * @param {object} ev — raw SendGrid event object
 */
async function applySendGridDeliveryEvent(ev) {
  const eventType = ev && String(ev.event || '').toLowerCase();
  const sg = ev && ev.sg_message_id;
  if (!eventType || !sg) {
    return { ok: false, reason: 'missing_fields' };
  }

  const appendOnly = ['processed'];
  const terminal = ['delivered', 'bounce', 'dropped'];
  const deferredEvent = 'deferred';
  const openEvent = 'open';
  const handled = new Set([...appendOnly, ...terminal, deferredEvent, openEvent]);

  if (!handled.has(eventType)) {
    return { ok: false, reason: 'not_delivery_event' };
  }

  const keys = providerIdLookupKeys(sg);
  if (keys.length === 0) {
    return { ok: false, reason: 'empty_sg_message_id' };
  }

  const line = formatSendGridEventLine(ev);
  const pool = await getPool();

  if (appendOnly.includes(eventType)) {
    const historyRows = await appendSendGridLineMessageHistory(pool, keys, line);
    const emailLogRows = await appendSendGridLineEmailLogs(pool, keys, line);
    return { ok: true, event: eventType, historyRows, emailLogRows };
  }

  if (eventType === deferredEvent) {
    // Only advance Sent -> Deferred. Do NOT downgrade Delivered/Opened/Failed.
    const historyRows = await advanceStatusIfAllowed(pool, keys, line, 'Deferred', ['Sent']);
    const emailLogRows = await appendSendGridLineEmailLogs(pool, keys, line);
    return { ok: true, event: eventType, historyRows, emailLogRows };
  }

  if (eventType === openEvent) {
    // Advance Sent/Deferred/Delivered -> Opened. Never override Opened/Failed.
    const historyRows = await advanceStatusIfAllowed(
      pool,
      keys,
      line,
      'Opened',
      ['Sent', 'Deferred', 'Delivered']
    );
    const emailLogRows = await appendSendGridLineEmailLogs(pool, keys, line);
    return { ok: true, event: eventType, historyRows, emailLogRows };
  }

  if (terminal.includes(eventType)) {
    const nextMH = eventType === 'delivered' ? 'Delivered' : 'Failed';
    const nextEL = eventType === 'delivered' ? 'delivered' : 'failed';
    const historyRows = await terminalUpdateMessageHistory(pool, keys, line, nextMH);
    const emailLogRows = await terminalUpdateEmailLogs(pool, keys, line, nextEL);
    return { ok: true, event: eventType, historyRows, emailLogRows };
  }

  return { ok: false, reason: 'not_delivery_event' };
}

module.exports = {
  insertQuickQuoteMessageHistory,
  applySendGridDeliveryEvent,
  providerIdLookupKeys,
  normalizeSendGridMessageIdForMatch,
  advanceStatusIfAllowed
};
