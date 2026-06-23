'use strict';

const { getPool, sql } = require('../config/database');

const VALID_PRIORITIES = new Set(['normal', 'high', 'critical']);

/**
 * @param {object} opts
 * @param {string} opts.category
 * @param {string} opts.source
 * @param {string} opts.message
 * @param {string} [opts.severity]
 * @param {string} [opts.priority] - `normal` | `high` | `critical`. Controls whether the 15-min
 *   digest email picks this row up. Unknown values fall back to `normal`.
 * @param {string|null} [opts.tenantId]
 * @param {object} [opts.detail]
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
    await pool
      .request()
      .input('category', sql.NVarChar(64), category)
      .input('source', sql.NVarChar(128), source)
      .input('severity', sql.NVarChar(32), severity)
      .input('priority', sql.NVarChar(16), priority)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('message', sql.NVarChar(2000), message)
      .input('detailJson', sql.NVarChar(sql.MAX), detailJson)
      .query(`
        INSERT INTO oe.SystemIntegrationErrors (Category, Source, Severity, Priority, TenantId, Message, DetailJson)
        VALUES (@category, @source, @severity, @priority, @tenantId, @message, @detailJson)
      `);
  } catch (e) {
    // If the Priority column hasn't been migrated yet, retry without it so we never lose an error row.
    const msg = String(e && e.message || '');
    if (msg.includes('Invalid column name') && msg.includes('Priority')) {
      try {
        const pool = await getPool();
        await pool
          .request()
          .input('category', sql.NVarChar(64), String(opts.category || 'unknown').slice(0, 64))
          .input('source', sql.NVarChar(128), String(opts.source || 'unknown').slice(0, 128))
          .input('severity', sql.NVarChar(32), String(opts.severity || 'error').slice(0, 32))
          .input('tenantId', sql.UniqueIdentifier, opts.tenantId || null)
          .input('message', sql.NVarChar(2000), String(opts.message || '').slice(0, 2000))
          .input('detailJson', sql.NVarChar(sql.MAX), opts.detail != null ? (() => { try { return JSON.stringify(opts.detail).slice(0, 100000); } catch (_) { return null; } })() : null)
          .query(`
            INSERT INTO oe.SystemIntegrationErrors (Category, Source, Severity, TenantId, Message, DetailJson)
            VALUES (@category, @source, @severity, @tenantId, @message, @detailJson)
          `);
        return;
      } catch (inner) {
        console.error('recordIntegrationError (fallback):', inner.message);
        return;
      }
    }
    console.error('recordIntegrationError:', e.message);
  }
}

/**
 * @param {{ page?: number, limit?: number, category?: string }} query
 */
async function listIntegrationErrors(query = {}) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '50'), 10) || 50));
  const offset = (page - 1) * limit;
  const includeResolved = String(query.includeResolved || 'false').toLowerCase() === 'true';
  try {
  const pool = await getPool();
  const whereParts = [];
  if (query.category) whereParts.push('Category = @category');
  if (!includeResolved) whereParts.push('ISNULL(Resolved, 0) = 0');
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const countRequest = pool.request();
  const dataRequest = pool.request();
  if (query.category) {
    const c = String(query.category);
    countRequest.input('category', sql.NVarChar(64), c);
    dataRequest.input('category', sql.NVarChar(64), c);
  }
  dataRequest.input('limit', sql.Int, limit);
  dataRequest.input('offset', sql.Int, offset);

  const countRes = await countRequest.query(`
    SELECT COUNT(*) AS Total FROM oe.SystemIntegrationErrors ${whereClause}
  `);

  const listRes = await dataRequest.query(`
    SELECT IntegrationErrorId, Category, Source, Severity,
      ISNULL(TRY_CAST(Priority AS NVARCHAR(16)), N'normal') AS Priority,
      TenantId, Message, DetailJson, CreatedDate, NotificationSentAt,
      ISNULL(Resolved, 0) AS Resolved, ResolvedAt, ResolvedByUserId
    FROM oe.SystemIntegrationErrors
    ${whereClause}
    ORDER BY CreatedDate DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `);

  const total = countRes.recordset?.[0]?.Total ?? 0;
  const rows = (listRes.recordset || []).map((r) => ({
    integrationErrorId: r.IntegrationErrorId,
    category: r.Category,
    source: r.Source,
    severity: r.Severity,
    priority: r.Priority || 'normal',
    tenantId: r.TenantId ? String(r.TenantId) : null,
    message: r.Message,
    detailJson: r.DetailJson,
    createdDate: r.CreatedDate,
    notificationSentAt: r.NotificationSentAt || null,
    resolved: !!r.Resolved,
    resolvedAt: r.ResolvedAt || null,
    resolvedByUserId: r.ResolvedByUserId ? String(r.ResolvedByUserId) : null
  }));

  return { rows, total: Number(total) || 0, page, limit };
  } catch (e) {
    const msg = String(e.message || '');
    if (msg.includes('Invalid object name') && msg.includes('SystemIntegrationErrors')) {
      return { rows: [], total: 0, page, limit, migrationRequired: true };
    }
    // Optional columns missing (Priority, NotificationSentAt, Resolved, ResolvedAt, ResolvedByUserId).
    // Retry with only the always-present columns so the sysadmin UI keeps rendering; this lets an operator
    // see errors even before all migrations have been applied.
    const optionalColMissing = msg.includes('Invalid column name') && (
      msg.includes('Priority') ||
      msg.includes('NotificationSentAt') ||
      msg.includes('Resolved')
    );
    if (optionalColMissing) {
      const pool = await getPool();
      const whereClause = query.category ? 'WHERE Category = @category' : '';
      const req = pool.request();
      if (query.category) req.input('category', sql.NVarChar(64), String(query.category));
      req.input('limit', sql.Int, limit).input('offset', sql.Int, offset);
      const listRes = await req.query(`
        SELECT IntegrationErrorId, Category, Source, Severity, TenantId, Message, DetailJson, CreatedDate
        FROM oe.SystemIntegrationErrors
        ${whereClause}
        ORDER BY CreatedDate DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);
      const rows = (listRes.recordset || []).map((r) => ({
        integrationErrorId: r.IntegrationErrorId,
        category: r.Category,
        source: r.Source,
        severity: r.Severity,
        priority: 'normal',
        tenantId: r.TenantId ? String(r.TenantId) : null,
        message: r.Message,
        detailJson: r.DetailJson,
        createdDate: r.CreatedDate,
        notificationSentAt: null,
        resolved: false,
        resolvedAt: null,
        resolvedByUserId: null
      }));
      return { rows, total: rows.length, page, limit };
    }
    throw e;
  }
}

/**
 * Flip Resolved on/off for a single integration error row. We default `userId` to null rather than
 * rejecting so the endpoint still works against legacy auth tokens that don't carry a user id.
 *
 * @param {string} integrationErrorId
 * @param {boolean} resolved
 * @param {string|null} [userId]
 * @returns {Promise<{ updated: boolean, resolved: boolean, resolvedAt: Date|null, resolvedByUserId: string|null }>}
 */
async function setIntegrationErrorResolved(integrationErrorId, resolved, userId = null) {
  if (!integrationErrorId) throw new Error('integrationErrorId is required');
  const pool = await getPool();
  const req = pool.request()
    .input('id', sql.UniqueIdentifier, integrationErrorId)
    .input('resolved', sql.Bit, resolved ? 1 : 0)
    .input('resolvedBy', sql.UniqueIdentifier, resolved ? (userId || null) : null);
  const res = await req.query(`
    UPDATE oe.SystemIntegrationErrors
    SET Resolved = @resolved,
        ResolvedAt = CASE WHEN @resolved = 1 THEN SYSUTCDATETIME() ELSE NULL END,
        ResolvedByUserId = CASE WHEN @resolved = 1 THEN @resolvedBy ELSE NULL END
    OUTPUT inserted.IntegrationErrorId, inserted.Resolved, inserted.ResolvedAt, inserted.ResolvedByUserId
    WHERE IntegrationErrorId = @id
  `);
  const row = res.recordset?.[0];
  if (!row) return { updated: false, resolved: false, resolvedAt: null, resolvedByUserId: null };
  return {
    updated: true,
    resolved: !!row.Resolved,
    resolvedAt: row.ResolvedAt || null,
    resolvedByUserId: row.ResolvedByUserId ? String(row.ResolvedByUserId) : null
  };
}

module.exports = { recordIntegrationError, listIntegrationErrors, setIntegrationErrorResolved };
