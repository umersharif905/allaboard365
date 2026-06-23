'use strict';

const { getPool, sql } = require('../config/database');

/**
 * List DIME payment webhook failures from oe.SystemIntegrationErrors (category payment_webhook).
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} [opts.startDate] YYYY-MM-DD
 * @param {string} [opts.endDate] YYYY-MM-DD
 * @param {number} [opts.limit]
 * @param {'unresolved'|'resolved'|'all'} [opts.resolutionStatus]
 */
async function listPaymentWebhookErrors(opts) {
  const tenantId = opts.tenantId;
  if (!tenantId) {
    throw new Error('tenantId required');
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const pool = await getPool();
  const request = pool.request();
  request.input('tenantId', sql.UniqueIdentifier, tenantId);
  let where = `
    WHERE s.Category = N'payment_webhook'
      AND s.Source = N'DimeWebhookHandler'
      AND s.TenantId = @tenantId
  `;
  const resolutionStatus = String(opts.resolutionStatus || 'unresolved').toLowerCase();
  if (resolutionStatus === 'resolved') {
    where += ` AND s.Resolved = 1`;
  } else if (resolutionStatus !== 'all') {
    where += ` AND ISNULL(s.Resolved, 0) = 0`;
  }
  if (opts.startDate) {
    where += ' AND s.CreatedDate >= @startDate';
    request.input('startDate', sql.DateTime2, new Date(`${opts.startDate}T00:00:00Z`));
  }
  if (opts.endDate) {
    where += ' AND s.CreatedDate < DATEADD(day, 1, CAST(@endDate AS DATE))';
    request.input('endDate', sql.Date, opts.endDate);
  }
  request.input('limit', sql.Int, limit);
  let result;
  try {
    result = await request.query(`
    SELECT TOP (@limit)
      s.IntegrationErrorId,
      s.Category,
      s.Source,
      s.Severity,
      s.TenantId,
      s.Message,
      s.DetailJson,
      s.CreatedDate,
      CAST(ISNULL(s.Resolved, 0) AS BIT) AS Resolved,
      s.ResolvedAt,
      s.ResolvedByUserId,
      CASE WHEN ISJSON(s.DetailJson) = 1
        THEN TRY_CAST(JSON_VALUE(s.DetailJson, '$.webhookEventId') AS INT)
        ELSE NULL
      END AS ParsedWebhookEventId,
      wh.TransactionId AS WebhookTransactionId,
      lp.PaymentId AS LinkedPaymentId,
      lp.Status AS LinkedPaymentStatus,
      lp.Amount AS LinkedAmount
    FROM oe.SystemIntegrationErrors s
    LEFT JOIN oe.PaymentWebhookEvents wh ON wh.WebhookEventId = CASE
      WHEN ISJSON(s.DetailJson) = 1
        THEN TRY_CAST(JSON_VALUE(s.DetailJson, '$.webhookEventId') AS INT)
      ELSE NULL
    END
    OUTER APPLY (
      SELECT TOP 1
        p.PaymentId,
        p.Status,
        p.Amount
      FROM oe.Payments p
      WHERE p.TenantId = s.TenantId
        AND wh.TransactionId IS NOT NULL
        AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) <> N''
        AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), wh.TransactionId)))
      ORDER BY p.PaymentDate DESC
    ) lp
    ${where}
    ORDER BY s.CreatedDate DESC
  `);
  } catch (e) {
    const msg = String(e.message || '');
    if (!msg.includes('Resolved')) throw e;
    // Backward-compatible fallback when resolution columns are not yet deployed.
    const legacyWhere = where
      .replace(/\s+AND s\.Resolved = 1/g, '')
      .replace(/\s+AND ISNULL\(s\.Resolved, 0\) = 0/g, '');
    result = await request.query(`
      SELECT TOP (@limit)
        s.IntegrationErrorId,
        s.Category,
        s.Source,
        s.Severity,
        s.TenantId,
        s.Message,
        s.DetailJson,
        s.CreatedDate,
        CAST(0 AS BIT) AS Resolved,
        CAST(NULL AS DATETIME2) AS ResolvedAt,
        CAST(NULL AS UNIQUEIDENTIFIER) AS ResolvedByUserId,
        CASE WHEN ISJSON(s.DetailJson) = 1
          THEN TRY_CAST(JSON_VALUE(s.DetailJson, '$.webhookEventId') AS INT)
          ELSE NULL
        END AS ParsedWebhookEventId,
        wh.TransactionId AS WebhookTransactionId,
        lp.PaymentId AS LinkedPaymentId,
        lp.Status AS LinkedPaymentStatus,
        lp.Amount AS LinkedAmount
      FROM oe.SystemIntegrationErrors s
      LEFT JOIN oe.PaymentWebhookEvents wh ON wh.WebhookEventId = CASE
        WHEN ISJSON(s.DetailJson) = 1
          THEN TRY_CAST(JSON_VALUE(s.DetailJson, '$.webhookEventId') AS INT)
        ELSE NULL
      END
      OUTER APPLY (
        SELECT TOP 1
          p.PaymentId,
          p.Status,
          p.Amount
        FROM oe.Payments p
        WHERE p.TenantId = s.TenantId
          AND wh.TransactionId IS NOT NULL
          AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) <> N''
          AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), wh.TransactionId)))
        ORDER BY p.PaymentDate DESC
      ) lp
      ${legacyWhere}
      ORDER BY s.CreatedDate DESC
    `);
  }
  return (result.recordset || []).map((row) => ({
    integrationErrorId: row.IntegrationErrorId,
    category: row.Category,
    source: row.Source,
    severity: row.Severity,
    tenantId: row.TenantId,
    message: row.Message,
    detailJson: row.DetailJson,
    createdDate: row.CreatedDate ? new Date(row.CreatedDate).toISOString() : null,
    resolved: !!row.Resolved,
    resolvedAt: row.ResolvedAt ? new Date(row.ResolvedAt).toISOString() : null,
    resolvedByUserId: row.ResolvedByUserId ? String(row.ResolvedByUserId) : null,
    webhookEventId: row.ParsedWebhookEventId != null ? Number(row.ParsedWebhookEventId) : null,
    webhookTransactionId:
      row.WebhookTransactionId != null && String(row.WebhookTransactionId).trim() !== ''
        ? String(row.WebhookTransactionId).trim()
        : null,
    linkedPaymentId: row.LinkedPaymentId ? String(row.LinkedPaymentId) : null,
    linkedPaymentStatus: row.LinkedPaymentStatus || null,
    linkedAmount: row.LinkedAmount != null ? Number(row.LinkedAmount) : null
  }));
}

async function setPaymentWebhookErrorResolved(opts) {
  const tenantId = opts.tenantId;
  const integrationErrorId = opts.integrationErrorId;
  const resolved = opts.resolved === true;
  const resolvedByUserId = opts.resolvedByUserId || null;
  if (!tenantId || !integrationErrorId) {
    throw new Error('tenantId and integrationErrorId required');
  }
  const pool = await getPool();
  const request = pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('integrationErrorId', sql.UniqueIdentifier, integrationErrorId)
    .input('resolved', sql.Bit, resolved ? 1 : 0)
    .input('resolvedByUserId', sql.UniqueIdentifier, resolved ? resolvedByUserId : null);
  let result;
  try {
    result = await request.query(`
      UPDATE oe.SystemIntegrationErrors
      SET
        Resolved = @resolved,
        ResolvedAt = CASE WHEN @resolved = 1 THEN GETUTCDATE() ELSE NULL END,
        ResolvedByUserId = CASE WHEN @resolved = 1 THEN @resolvedByUserId ELSE NULL END
      WHERE IntegrationErrorId = @integrationErrorId
        AND TenantId = @tenantId
        AND Category = N'payment_webhook'
        AND Source = N'DimeWebhookHandler'
    `);
  } catch (e) {
    const msg = String(e.message || '');
    if (msg.includes('Resolved')) {
      throw new Error('SystemIntegrationErrors resolution columns are missing. Run sql-changes/2026-04-08-system-integration-errors-resolution.sql');
    }
    throw e;
  }
  return { updated: Number(result.rowsAffected?.[0] || 0) };
}

module.exports = { listPaymentWebhookErrors, setPaymentWebhookErrorResolved };
