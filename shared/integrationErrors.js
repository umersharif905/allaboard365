'use strict';

const { getPool, sql } = require('./db');

const VALID_PRIORITIES = new Set(['normal', 'high', 'critical']);

/**
 * Persist integration failures for SysAdmin review (oe.SystemIntegrationErrors).
 * Safe to call when the table is missing (logs only).
 *
 * `priority` ('normal' | 'high' | 'critical') controls whether the 15-min
 * integration-error digest emails the row (high/critical only) — same contract
 * as backend/services/integrationErrorService.js.
 */
async function recordIntegrationError(opts) {
  try {
    const category = String(opts.category || 'unknown').slice(0, 64);
    const source = String(opts.source || 'unknown').slice(0, 128);
    const message = String(opts.message || '').slice(0, 2000);
    const severity = String(opts.severity || 'error').slice(0, 32);
    const rawPriority = String(opts.priority || 'normal').toLowerCase();
    const priority = VALID_PRIORITIES.has(rawPriority) ? rawPriority : 'normal';
    const tenantId = opts.tenantId || null;
    let detailJson = null;
    if (opts.detail != null) {
      try {
        detailJson = JSON.stringify(opts.detail).slice(0, 100000);
      } catch (_) {
        detailJson = null;
      }
    }
    const pool = await getPool();
    const baseRequest = () =>
      pool
        .request()
        .input('category', sql.NVarChar(64), category)
        .input('source', sql.NVarChar(128), source)
        .input('severity', sql.NVarChar(32), severity)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('message', sql.NVarChar(2000), message)
        .input('detailJson', sql.NVarChar(sql.MAX), detailJson);
    try {
      await baseRequest()
        .input('priority', sql.NVarChar(16), priority)
        .query(`
          INSERT INTO oe.SystemIntegrationErrors (Category, Source, Severity, Priority, TenantId, Message, DetailJson)
          VALUES (@category, @source, @severity, @priority, @tenantId, @message, @detailJson)
        `);
    } catch (e) {
      // If the Priority column hasn't been migrated yet, retry without it so we never lose an error row.
      const msg = String(e.message || '');
      if (msg.includes('Invalid column name') && msg.includes('Priority')) {
        await baseRequest().query(`
          INSERT INTO oe.SystemIntegrationErrors (Category, Source, Severity, TenantId, Message, DetailJson)
          VALUES (@category, @source, @severity, @tenantId, @message, @detailJson)
        `);
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error('recordIntegrationError:', e.message);
  }
}

/**
 * Record only if the same Source+Message hasn't been recorded in the last `dedupeDays`
 * days — lets 4×-daily timers alert without spamming the digest with repeats.
 * @returns {Promise<boolean>} true if a new row was recorded
 */
async function recordIntegrationErrorOnce(opts, dedupeDays = 7) {
  try {
    const pool = await getPool();
    const existing = await pool
      .request()
      .input('source', sql.NVarChar(128), String(opts.source || 'unknown').slice(0, 128))
      .input('message', sql.NVarChar(2000), String(opts.message || '').slice(0, 2000))
      .input('days', sql.Int, Math.max(1, Number(dedupeDays) || 7))
      .query(`
        SELECT TOP 1 1 AS Found
        FROM oe.SystemIntegrationErrors
        WHERE Source = @source AND Message = @message
          AND CreatedDate >= DATEADD(DAY, -@days, SYSUTCDATETIME())
      `);
    if (existing.recordset.length > 0) return false;
  } catch (e) {
    // Dedupe check failing should never block the alert itself.
    console.error('recordIntegrationErrorOnce dedupe check:', e.message);
  }
  await recordIntegrationError(opts);
  return true;
}

module.exports = { recordIntegrationError, recordIntegrationErrorOnce };
