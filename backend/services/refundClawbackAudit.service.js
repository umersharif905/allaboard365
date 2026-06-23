'use strict';

/**
 * Phase 8a — Refunds-without-clawbacks audit detector.
 *
 * For every refund row in oe.Payments (TransactionType = 'Refund'), check whether
 * the original payment's enrollment(s) have at least one offsetting clawback:
 *   - Commission clawback: oe.Commissions row with negative Amount and
 *     TransactionType IN ('Refund','Chargeback') for the same EnrollmentId
 *     (or, fallback, MemberId+TenantId pair) that post-dates the refund.
 *   - Payout clawback: oe.PayoutClawbacks row referencing OriginalPaymentId
 *     (table arrives in Phase 3 — query is forward-compatible via OBJECT_ID guard).
 *
 * Returns rows for refunds that have NO matching clawback so SysAdmin can review.
 *
 * Idempotent / read-only — safe to call from the BillingIntegrity panel and
 * from a nightly scan.
 */

const sql = require('mssql');
const { getPool } = require('../config/database');

/**
 * @param {Object} [opts]
 * @param {string} [opts.tenantId]   Optional tenant filter (SysAdmin can pass null/'*' for all)
 * @param {number} [opts.lookbackDays=90]  Only consider refunds within this many days
 * @param {number} [opts.limit=200]
 * @returns {Promise<{ rows: Array, count: number, hasPayoutClawbacksTable: boolean }>}
 */
async function findRefundsWithoutClawbacks(opts = {}) {
  const tenantId = opts.tenantId && opts.tenantId !== '*' ? String(opts.tenantId) : null;
  const lookbackDays = Math.max(1, Math.min(3650, Number(opts.lookbackDays) || 90));
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 200));

  const pool = await getPool();

  // Detect optional Phase 3 clawback table without throwing if absent.
  const tableCheck = await pool.request().query(`
    SELECT
      OBJECT_ID(N'oe.PayoutClawbacks', N'U') AS PayoutClawbacksObjectId,
      OBJECT_ID(N'oe.Commissions', N'U') AS CommissionsObjectId
  `);
  const hasPayoutClawbacksTable = !!tableCheck.recordset?.[0]?.PayoutClawbacksObjectId;
  const hasCommissionsTable = !!tableCheck.recordset?.[0]?.CommissionsObjectId;

  const payoutClawbackJoin = hasPayoutClawbacksTable
    ? `LEFT JOIN oe.PayoutClawbacks pc ON pc.SourcePaymentId = r.OriginalPaymentId`
    : `OUTER APPLY (SELECT CAST(NULL AS UNIQUEIDENTIFIER) AS ClawbackId) pc`;

  const commissionsExists = hasCommissionsTable
    ? `
      EXISTS (
        SELECT 1
        FROM oe.Commissions c
        WHERE c.TenantId = r.TenantId
          AND c.EnrollmentId IS NOT NULL
          AND c.EnrollmentId = orig.EnrollmentId
          AND c.Amount < 0
          AND c.TransactionType IN (N'Refund', N'Chargeback')
          AND c.CreatedDate >= r.PaymentDate
      )
    `
    : `(0 = 1)`;

  const tenantClause = tenantId ? `AND r.TenantId = @tenantId` : '';

  const request = pool.request()
    .input('lookbackDays', sql.Int, lookbackDays)
    .input('limit', sql.Int, limit);
  if (tenantId) request.input('tenantId', sql.UniqueIdentifier, tenantId);

  const queryText = `
    SELECT TOP (@limit)
      r.PaymentId       AS RefundPaymentId,
      r.OriginalPaymentId,
      r.TenantId,
      r.PaymentDate     AS RefundDate,
      r.Amount          AS RefundAmount,
      orig.EnrollmentId,
      orig.HouseholdId,
      orig.GroupId,
      orig.MemberId,
      orig.Amount       AS OriginalAmount,
      pc.ClawbackId     AS PayoutClawbackId,
      CASE WHEN ${commissionsExists} THEN 1 ELSE 0 END AS HasCommissionClawback
    FROM oe.Payments r
    INNER JOIN oe.Payments orig ON orig.PaymentId = r.OriginalPaymentId
    ${payoutClawbackJoin}
    WHERE r.TransactionType = N'Refund'
      AND r.PaymentDate >= DATEADD(day, -@lookbackDays, GETUTCDATE())
      ${tenantClause}
      AND pc.ClawbackId IS NULL
      AND NOT (${commissionsExists})
    ORDER BY r.PaymentDate DESC
  `;

  const res = await request.query(queryText);
  return {
    rows: res.recordset || [],
    count: res.recordset?.length || 0,
    hasPayoutClawbacksTable
  };
}

/**
 * Phase 8b — Stale negative balance detector.
 *
 * Pending negative-amount clawback rows (oe.Commissions and oe.PayoutClawbacks)
 * that have not been settled into a NACHA cycle older than the threshold. These
 * indicate either: (a) a recipient with no positive payouts to net against (so
 * the clawback can never settle), or (b) a stuck row that's silently
 * carrying-forward forever.
 *
 * @param {Object} [opts]
 * @param {string} [opts.tenantId]
 * @param {number} [opts.thresholdDays=30]
 * @returns {Promise<{ commissions: Array, payoutClawbacks: Array, count: number }>}
 */
async function findStaleNegativeBalances(opts = {}) {
  const tenantId = opts.tenantId && opts.tenantId !== '*' ? String(opts.tenantId) : null;
  const thresholdDays = Math.max(1, Math.min(365, Number(opts.thresholdDays) || 30));
  const pool = await getPool();

  const tableCheck = await pool.request().query(`
    SELECT
      OBJECT_ID(N'oe.PayoutClawbacks', N'U') AS PayoutClawbacksObjectId,
      OBJECT_ID(N'oe.Commissions', N'U') AS CommissionsObjectId
  `);
  const hasPayoutClawbacksTable = !!tableCheck.recordset?.[0]?.PayoutClawbacksObjectId;
  const hasCommissionsTable = !!tableCheck.recordset?.[0]?.CommissionsObjectId;

  let commissions = [];
  if (hasCommissionsTable) {
    const req = pool.request().input('thresholdDays', sql.Int, thresholdDays);
    if (tenantId) req.input('tenantId', sql.UniqueIdentifier, tenantId);
    const res = await req.query(`
      SELECT TOP 500
        c.CommissionId,
        c.TenantId,
        c.AgentId,
        c.AgencyId,
        c.PaymentId,
        c.Amount,
        c.TransactionType,
        c.Status,
        c.CreatedDate
      FROM oe.Commissions c
      WHERE c.Status = N'Pending'
        AND c.Amount < 0
        AND c.TransactionType IN (N'Refund', N'Chargeback')
        AND c.CreatedDate < DATEADD(day, -@thresholdDays, GETUTCDATE())
        ${tenantId ? 'AND c.TenantId = @tenantId' : ''}
      ORDER BY c.CreatedDate ASC
    `);
    commissions = res.recordset || [];
  }

  let payoutClawbacks = [];
  if (hasPayoutClawbacksTable) {
    const req = pool.request().input('thresholdDays', sql.Int, thresholdDays);
    if (tenantId) req.input('tenantId', sql.UniqueIdentifier, tenantId);
    const res = await req.query(`
      SELECT TOP 500
        pc.ClawbackId,
        pc.TenantId,
        pc.PayoutType,
        pc.RecipientEntityType,
        pc.RecipientEntityId,
        pc.SourcePaymentId,
        pc.Amount,
        pc.RemainingAmount,
        pc.Status,
        pc.CreatedDate
      FROM oe.PayoutClawbacks pc
      WHERE pc.Status IN (N'Available', N'PartiallyApplied')
        AND pc.RemainingAmount > 0
        AND pc.CreatedDate < DATEADD(day, -@thresholdDays, GETUTCDATE())
        ${tenantId ? 'AND pc.TenantId = @tenantId' : ''}
      ORDER BY pc.CreatedDate ASC
    `);
    payoutClawbacks = res.recordset || [];
  }

  return {
    commissions,
    payoutClawbacks,
    count: commissions.length + payoutClawbacks.length,
    thresholdDays
  };
}

module.exports = {
  findRefundsWithoutClawbacks,
  findStaleNegativeBalances
};
