'use strict';

/**
 * Phase 6 — Read-only helpers for surfacing pending clawback balances to UI.
 *
 * Two ledgers feed the netting that happens at NACHA generation time:
 *
 *   1. oe.Commissions  — negative Refund/Chargeback rows, Status='Pending',
 *      AppliedToNACHAId IS NULL. These flip to 'Paid' (and stamp
 *      AppliedToNACHAId) only when the NACHA is marked Sent. If the NACHA is
 *      reverted, they go back to 'Pending'. So filtering Status='Pending'
 *      always gives you the current pending agent / agency clawback balance.
 *
 *   2. oe.PayoutClawbacks — Vendor + Tenant override clawbacks. RemainingAmount
 *      drains immediately at NACHA generation (Status -> PartiallyApplied /
 *      FullyApplied, AppliedToNACHAId stamped). If the NACHA is reverted,
 *      RemainingAmount is restored. So Status IN ('Available',
 *      'PartiallyApplied') AND RemainingAmount > 0 always reflects the current
 *      pending balance.
 *
 * Both helpers are read-only and safe to call from any breakdown / preview
 * endpoint.
 */

const sql = require('mssql');
const { getPool } = require('../config/database');

/**
 * Pending negative-commission balance per recipient (Agent / Agency).
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {Array<{entityType:'Agent'|'Agency', entityId:string}>} opts.recipients
 *        Whitelist of recipients; if omitted/empty, returns balances for all
 *        agents/agencies in the tenant that currently carry pending negatives.
 * @returns {Promise<Map<string, { entityType, entityId, amount, count, oldestDate }>>}
 *          Keyed `${entityType}_${entityId}`. Amount is positive (magnitude
 *          of clawback, e.g. $25 = $25 they owe back).
 */
async function getCommissionClawbackBalances({ tenantId, recipients = [] } = {}) {
  if (!tenantId) throw new Error('getCommissionClawbackBalances: tenantId required');

  const map = new Map();
  const agentIds = new Set();
  const agencyIds = new Set();
  for (const r of recipients) {
    if (!r || !r.entityId) continue;
    if (r.entityType === 'Agent') agentIds.add(String(r.entityId).toUpperCase());
    else if (r.entityType === 'Agency') agencyIds.add(String(r.entityId).toUpperCase());
  }
  const recipientFilterProvided = recipients && recipients.length > 0;
  if (recipientFilterProvided && agentIds.size === 0 && agencyIds.size === 0) {
    return map;
  }

  const pool = await getPool();
  const reqst = pool.request();
  reqst.input('TenantId', sql.UniqueIdentifier, tenantId);

  let agentFilter = '';
  let agencyFilter = '';
  if (recipientFilterProvided) {
    if (agentIds.size > 0) {
      const ids = Array.from(agentIds).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
      agentFilter = `AND c.AgentId IN (${ids})`;
    } else {
      agentFilter = `AND 1 = 0`;
    }
    if (agencyIds.size > 0) {
      const ids = Array.from(agencyIds).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
      agencyFilter = `AND c.AgencyId IN (${ids})`;
    } else {
      agencyFilter = `AND 1 = 0`;
    }
  }

  // Tenant scoping: agent.TenantId or agency.TenantId must match.
  const result = await reqst.query(`
    SELECT
      'Agent' AS EntityType,
      c.AgentId AS EntityId,
      SUM(ABS(c.Amount)) AS Amount,
      COUNT(*) AS Cnt,
      MIN(c.CreatedDate) AS OldestDate
    FROM oe.Commissions c
    LEFT JOIN oe.Agents a ON a.AgentId = c.AgentId
    WHERE c.Status = N'Pending'
      AND c.TransactionType IN (N'Refund', N'Chargeback')
      AND c.Amount < 0
      AND c.AppliedToNACHAId IS NULL
      AND c.AgentId IS NOT NULL
      AND a.TenantId = @TenantId
      ${agentFilter}
    GROUP BY c.AgentId

    UNION ALL

    SELECT
      'Agency' AS EntityType,
      c.AgencyId AS EntityId,
      SUM(ABS(c.Amount)) AS Amount,
      COUNT(*) AS Cnt,
      MIN(c.CreatedDate) AS OldestDate
    FROM oe.Commissions c
    LEFT JOIN oe.Agencies ag ON ag.AgencyId = c.AgencyId
    WHERE c.Status = N'Pending'
      AND c.TransactionType IN (N'Refund', N'Chargeback')
      AND c.Amount < 0
      AND c.AppliedToNACHAId IS NULL
      AND c.AgencyId IS NOT NULL
      AND ag.TenantId = @TenantId
      ${agencyFilter}
    GROUP BY c.AgencyId
  `);

  for (const row of result.recordset || []) {
    const id = row.EntityId ? row.EntityId.toString() : null;
    if (!id) continue;
    const key = `${row.EntityType}_${id}`;
    map.set(key, {
      entityType: row.EntityType,
      entityId: id,
      amount: Math.round(Number(row.Amount || 0) * 100) / 100,
      count: Number(row.Cnt || 0),
      oldestDate: row.OldestDate || null
    });
  }
  return map;
}

/**
 * Pending payout-clawback balance per recipient (Vendor / Tenant override).
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {'Vendor'|'TenantOverride'} opts.payoutType
 * @param {Array<string>} [opts.recipientEntityIds]  Whitelist; empty = all in tenant.
 * @returns {Promise<Map<string, { recipientEntityId, amount, count, oldestDate }>>}
 *          Keyed by entityId (string).
 */
async function getPayoutClawbackBalances({ tenantId, payoutType, recipientEntityIds = [] } = {}) {
  if (!tenantId) throw new Error('getPayoutClawbackBalances: tenantId required');
  if (!payoutType) throw new Error('getPayoutClawbackBalances: payoutType required');

  const map = new Map();
  const ids = new Set((recipientEntityIds || []).filter(Boolean).map((id) => String(id).toUpperCase()));
  const filterProvided = recipientEntityIds && recipientEntityIds.length > 0;
  if (filterProvided && ids.size === 0) return map;

  const pool = await getPool();
  const reqst = pool.request();
  reqst.input('TenantId', sql.UniqueIdentifier, tenantId);
  reqst.input('PayoutType', sql.NVarChar(20), payoutType);

  let recipientFilter = '';
  if (filterProvided) {
    const idList = Array.from(ids).map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    recipientFilter = `AND RecipientEntityId IN (${idList})`;
  }

  const result = await reqst.query(`
    IF OBJECT_ID(N'oe.PayoutClawbacks', N'U') IS NULL
    BEGIN
      SELECT TOP 0
        CAST(NULL AS UNIQUEIDENTIFIER) AS RecipientEntityId,
        CAST(0 AS DECIMAL(18,2)) AS Amount,
        CAST(0 AS INT) AS Cnt,
        CAST(NULL AS DATETIME2) AS OldestDate
      RETURN
    END

    SELECT
      RecipientEntityId,
      SUM(RemainingAmount) AS Amount,
      COUNT(*) AS Cnt,
      MIN(CreatedDate) AS OldestDate
    FROM oe.PayoutClawbacks
    WHERE TenantId = @TenantId
      AND PayoutType = @PayoutType
      AND Status IN (N'Available', N'PartiallyApplied')
      AND RemainingAmount > 0
      ${recipientFilter}
    GROUP BY RecipientEntityId
  `);

  for (const row of result.recordset || []) {
    const id = row.RecipientEntityId ? row.RecipientEntityId.toString() : null;
    if (!id) continue;
    map.set(id, {
      recipientEntityId: id,
      amount: Math.round(Number(row.Amount || 0) * 100) / 100,
      count: Number(row.Cnt || 0),
      oldestDate: row.OldestDate || null
    });
  }
  return map;
}

/**
 * Detail rows behind a single recipient's pending commission clawback.
 * Each row pairs a pending negative oe.Commissions entry with the source
 * refund (matched by PaymentId + closest CreatedDate) so the UI can render a
 * "what caused this clawback" modal.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {'Agent'|'Agency'} opts.entityType
 * @param {string} opts.entityId
 * @returns {Promise<Array<Object>>}
 */
async function getCommissionClawbackDetails({ tenantId, entityType, entityId } = {}) {
  if (!tenantId) throw new Error('getCommissionClawbackDetails: tenantId required');
  if (!entityType || !entityId) throw new Error('getCommissionClawbackDetails: entityType + entityId required');
  const isAgent = entityType === 'Agent';
  const isAgency = entityType === 'Agency';
  if (!isAgent && !isAgency) throw new Error('getCommissionClawbackDetails: entityType must be Agent or Agency');

  const pool = await getPool();
  const reqst = pool.request();
  reqst.input('TenantId', sql.UniqueIdentifier, tenantId);
  reqst.input('EntityId', sql.UniqueIdentifier, entityId);

  // Tenant scoping is via the recipient's own tenant (Agent.TenantId /
  // Agency.TenantId), matching getCommissionClawbackBalances.
  const recipientFilter = isAgent
    ? `c.AgentId = @EntityId AND a.TenantId = @TenantId`
    : `c.AgencyId = @EntityId AND ag.TenantId = @TenantId`;

  // No oe.Households table — household name resolves via the primary member
  // (RelationshipType='P') joined to oe.Users.
  const result = await reqst.query(`
    SELECT
      c.CommissionId,
      c.PaymentId,
      c.OriginalCommissionId,
      c.Amount,
      c.TransactionType,
      c.CreatedDate,
      p.HouseholdId,
      p.GroupId,
      p.Amount AS PaymentAmount,
      p.PaymentDate,
      ref.RefundId,
      ref.Amount AS RefundAmount,
      ref.RefundDate,
      ref.RefundReason,
      ref.Notes AS RefundNotes,
      ref.Status AS RefundStatus,
      hh.HouseholdName,
      hh.PrimaryMemberId,
      g.Name AS GroupName,
      orig.Amount AS OriginalCommissionAmount
    FROM oe.Commissions c
    LEFT JOIN oe.Agents a ON a.AgentId = c.AgentId
    LEFT JOIN oe.Agencies ag ON ag.AgencyId = c.AgencyId
    LEFT JOIN oe.Payments p ON p.PaymentId = c.PaymentId
    LEFT JOIN oe.Groups g ON g.GroupId = p.GroupId
    LEFT JOIN oe.Commissions orig ON orig.CommissionId = c.OriginalCommissionId
    OUTER APPLY (
      SELECT TOP 1
        r.RefundId, r.Amount, r.RefundDate, r.RefundReason, r.Notes, r.Status, r.CreatedDate
      FROM oe.Refunds r
      WHERE r.PaymentId = c.PaymentId
        AND r.CreatedDate <= DATEADD(second, 30, c.CreatedDate)
      ORDER BY r.CreatedDate DESC
    ) ref
    OUTER APPLY (
      SELECT TOP 1
        COALESCE(u.FirstName + ' ' + u.LastName, NULL) AS HouseholdName,
        m.MemberId AS PrimaryMemberId
      FROM oe.Members m
      LEFT JOIN oe.Users u ON u.UserId = m.UserId
      WHERE m.HouseholdId = p.HouseholdId
        AND m.RelationshipType = 'P'
    ) hh
    WHERE c.Status = N'Pending'
      AND c.TransactionType IN (N'Refund', N'Chargeback')
      AND c.Amount < 0
      AND c.AppliedToNACHAId IS NULL
      AND ${recipientFilter}
    ORDER BY c.CreatedDate DESC
  `);

  return (result.recordset || []).map((row) => ({
    commissionId: row.CommissionId ? row.CommissionId.toString() : null,
    paymentId: row.PaymentId ? row.PaymentId.toString() : null,
    originalCommissionId: row.OriginalCommissionId ? row.OriginalCommissionId.toString() : null,
    amount: Math.round(Math.abs(Number(row.Amount || 0)) * 100) / 100,
    transactionType: row.TransactionType || null,
    createdDate: row.CreatedDate || null,
    householdId: row.HouseholdId ? row.HouseholdId.toString() : null,
    householdName: row.HouseholdName || null,
    primaryMemberId: row.PrimaryMemberId ? row.PrimaryMemberId.toString() : null,
    groupId: row.GroupId ? row.GroupId.toString() : null,
    groupName: row.GroupName || null,
    paymentAmount: row.PaymentAmount != null ? Number(row.PaymentAmount) : null,
    paymentDate: row.PaymentDate || null,
    refundId: row.RefundId ? row.RefundId.toString() : null,
    refundAmount: row.RefundAmount != null ? Number(row.RefundAmount) : null,
    refundDate: row.RefundDate || null,
    refundReason: row.RefundReason || null,
    refundNotes: row.RefundNotes || null,
    refundStatus: row.RefundStatus || null,
    originalCommissionAmount:
      row.OriginalCommissionAmount != null ? Number(row.OriginalCommissionAmount) : null
  }));
}

/**
 * Detail rows behind a single recipient's pending payout clawback (vendor /
 * tenant override). Joins oe.PayoutClawbacks → oe.Refunds → oe.Payments to
 * surface what refund created each clawback.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {'Vendor'|'TenantOverride'} opts.payoutType
 * @param {string} opts.recipientEntityId
 * @returns {Promise<Array<Object>>}
 */
async function getPayoutClawbackDetails({ tenantId, payoutType, recipientEntityId } = {}) {
  if (!tenantId) throw new Error('getPayoutClawbackDetails: tenantId required');
  if (!payoutType) throw new Error('getPayoutClawbackDetails: payoutType required');
  if (!recipientEntityId) throw new Error('getPayoutClawbackDetails: recipientEntityId required');

  const pool = await getPool();
  const reqst = pool.request();
  reqst.input('TenantId', sql.UniqueIdentifier, tenantId);
  reqst.input('PayoutType', sql.NVarChar(20), payoutType);
  reqst.input('RecipientEntityId', sql.UniqueIdentifier, recipientEntityId);

  const result = await reqst.query(`
    IF OBJECT_ID(N'oe.PayoutClawbacks', N'U') IS NULL
    BEGIN
      SELECT TOP 0
        CAST(NULL AS UNIQUEIDENTIFIER) AS ClawbackId
      RETURN
    END

    SELECT
      pc.ClawbackId,
      pc.SourcePaymentId,
      pc.SourceRefundId,
      pc.Amount,
      pc.RemainingAmount,
      pc.Status,
      pc.Notes AS ClawbackNotes,
      pc.CreatedDate,
      ref.RefundId AS ResolvedRefundId,
      ref.Amount AS RefundAmount,
      ref.RefundDate,
      ref.RefundReason,
      ref.Notes AS RefundNotes,
      ref.Status AS RefundStatus,
      p.HouseholdId,
      p.GroupId,
      p.Amount AS PaymentAmount,
      p.PaymentDate,
      hh.HouseholdName,
      hh.PrimaryMemberId,
      g.Name AS GroupName
    FROM oe.PayoutClawbacks pc
    LEFT JOIN oe.Payments p ON p.PaymentId = pc.SourcePaymentId
    LEFT JOIN oe.Groups g ON g.GroupId = p.GroupId
    OUTER APPLY (
      -- Prefer the explicit SourceRefundId linkage. Fall back to most recent
      -- refund on the same source payment created near this clawback (older
      -- clawback rows pre-dating SourceRefundId backfill won't have the FK).
      SELECT TOP 1
        r.RefundId, r.Amount, r.RefundDate, r.RefundReason, r.Notes, r.Status, r.CreatedDate
      FROM oe.Refunds r
      WHERE
        (pc.SourceRefundId IS NOT NULL AND r.RefundId = pc.SourceRefundId)
        OR (pc.SourceRefundId IS NULL AND r.PaymentId = pc.SourcePaymentId
            AND r.CreatedDate <= DATEADD(second, 30, pc.CreatedDate))
      ORDER BY
        CASE WHEN pc.SourceRefundId IS NOT NULL AND r.RefundId = pc.SourceRefundId THEN 0 ELSE 1 END,
        r.CreatedDate DESC
    ) ref
    OUTER APPLY (
      SELECT TOP 1
        COALESCE(u.FirstName + ' ' + u.LastName, NULL) AS HouseholdName,
        m.MemberId AS PrimaryMemberId
      FROM oe.Members m
      LEFT JOIN oe.Users u ON u.UserId = m.UserId
      WHERE m.HouseholdId = p.HouseholdId
        AND m.RelationshipType = 'P'
    ) hh
    WHERE pc.TenantId = @TenantId
      AND pc.PayoutType = @PayoutType
      AND pc.RecipientEntityId = @RecipientEntityId
      AND pc.Status IN (N'Available', N'PartiallyApplied')
      AND pc.RemainingAmount > 0
    ORDER BY pc.CreatedDate ASC
  `);

  return (result.recordset || []).map((row) => ({
    clawbackId: row.ClawbackId ? row.ClawbackId.toString() : null,
    paymentId: row.SourcePaymentId ? row.SourcePaymentId.toString() : null,
    refundId: (row.SourceRefundId || row.ResolvedRefundId)
      ? (row.SourceRefundId || row.ResolvedRefundId).toString()
      : null,
    amount: Math.round(Number(row.Amount || 0) * 100) / 100,
    remainingAmount: Math.round(Number(row.RemainingAmount || 0) * 100) / 100,
    status: row.Status || null,
    clawbackNotes: row.ClawbackNotes || null,
    createdDate: row.CreatedDate || null,
    refundAmount: row.RefundAmount != null ? Number(row.RefundAmount) : null,
    refundDate: row.RefundDate || null,
    refundReason: row.RefundReason || null,
    refundNotes: row.RefundNotes || null,
    refundStatus: row.RefundStatus || null,
    householdId: row.HouseholdId ? row.HouseholdId.toString() : null,
    householdName: row.HouseholdName || null,
    primaryMemberId: row.PrimaryMemberId ? row.PrimaryMemberId.toString() : null,
    groupId: row.GroupId ? row.GroupId.toString() : null,
    groupName: row.GroupName || null,
    paymentAmount: row.PaymentAmount != null ? Number(row.PaymentAmount) : null,
    paymentDate: row.PaymentDate || null
  }));
}

module.exports = {
  getCommissionClawbackBalances,
  getPayoutClawbackBalances,
  getCommissionClawbackDetails,
  getPayoutClawbackDetails
};
