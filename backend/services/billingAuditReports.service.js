'use strict';

const { getPool, sql } = require('../config/database');

/**
 * Persist a billing audit run (scheduled or manual).
 * @param {object} opts
 * @param {string|null} [opts.tenantId]
 * @param {string} opts.triggerName scheduled | manual
 * @param {object} opts.summary
 * @param {object} [opts.detail]
 * @param {string|null} [opts.createdBy]
 */
async function insertReport(opts) {
  const pool = await getPool();
  const summaryJson = JSON.stringify(opts.summary || {}).slice(0, 380000);
  const detailJson =
    opts.detail != null ? JSON.stringify(opts.detail).slice(0, 1500000) : null;
  const result = await pool
    .request()
    .input('tenantId', sql.UniqueIdentifier, opts.tenantId || null)
    .input('triggerName', sql.NVarChar(32), String(opts.triggerName || 'manual').slice(0, 32))
    .input('summaryJson', sql.NVarChar(sql.MAX), summaryJson)
    .input('detailJson', sql.NVarChar(sql.MAX), detailJson)
    .input('createdBy', sql.NVarChar(256), opts.createdBy || null)
    .query(`
    INSERT INTO oe.BillingAuditReports (ReportId, TenantId, RunAtUtc, TriggerName, SummaryJson, DetailJson, CreatedBy)
    OUTPUT inserted.ReportId, inserted.RunAtUtc
    VALUES (
      NEWID(),
      @tenantId,
      SYSUTCDATETIME(),
      @triggerName,
      @summaryJson,
      @detailJson,
      @createdBy
    )
  `);
  const ins = result.recordset[0];
  return {
    reportId: ins?.ReportId ? String(ins.ReportId) : null,
    runAtUtc: ins?.RunAtUtc ? new Date(ins.RunAtUtc).toISOString() : null
  };
}

/**
 * Latest report for tenant (or global when tenantId null for scheduled all-tenant summary).
 * @param {string|null} tenantId
 */
async function getLatestReport(tenantId) {
  const pool = await getPool();
  const req = pool.request();
  let where = '';
  if (tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    where = 'WHERE TenantId = @tenantId';
  } else {
    where = 'WHERE TenantId IS NULL';
  }
  const result = await req.query(`
    SELECT TOP 1
      ReportId,
      TenantId,
      RunAtUtc,
      TriggerName,
      SummaryJson,
      DetailJson,
      CreatedBy
    FROM oe.BillingAuditReports
    ${where}
    ORDER BY RunAtUtc DESC
  `);
  const row = result.recordset[0];
  if (!row) return null;
  let summary = null;
  let detail = null;
  try {
    summary = row.SummaryJson ? JSON.parse(row.SummaryJson) : null;
  } catch (_) {
    summary = null;
  }
  try {
    detail = row.DetailJson ? JSON.parse(row.DetailJson) : null;
  } catch (_) {
    detail = null;
  }
  return {
    reportId: String(row.ReportId),
    tenantId: row.TenantId ? String(row.TenantId) : null,
    runAtUtc: row.RunAtUtc ? new Date(row.RunAtUtc).toISOString() : null,
    triggerName: row.TriggerName,
    summary,
    detail,
    createdBy: row.CreatedBy
  };
}

module.exports = { insertReport, getLatestReport };
