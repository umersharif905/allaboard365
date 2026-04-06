'use strict';

const { getPool, sql } = require('./db');

/**
 * Persist integration failures for SysAdmin review (oe.SystemIntegrationErrors).
 * Safe to call when the table is missing (logs only).
 */
async function recordIntegrationError(opts) {
  try {
    const category = String(opts.category || 'unknown').slice(0, 64);
    const source = String(opts.source || 'unknown').slice(0, 128);
    const message = String(opts.message || '').slice(0, 2000);
    const severity = String(opts.severity || 'error').slice(0, 32);
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
    await pool
      .request()
      .input('category', sql.NVarChar(64), category)
      .input('source', sql.NVarChar(128), source)
      .input('severity', sql.NVarChar(32), severity)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('message', sql.NVarChar(2000), message)
      .input('detailJson', sql.NVarChar(sql.MAX), detailJson)
      .query(`
        INSERT INTO oe.SystemIntegrationErrors (Category, Source, Severity, TenantId, Message, DetailJson)
        VALUES (@category, @source, @severity, @tenantId, @message, @detailJson)
      `);
  } catch (e) {
    console.error('recordIntegrationError:', e.message);
  }
}

module.exports = { recordIntegrationError };
