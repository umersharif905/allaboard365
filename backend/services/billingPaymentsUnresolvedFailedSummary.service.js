'use strict';

const { sql } = require('../config/database');
const {
  UNRESOLVED_FAILED_PAYMENTS_FROM_P,
  UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE,
  UNRESOLVED_FAILED_PAYMENTS_BUCKET_KEY_SQL
} = require('./billingAuditUnresolvedFailedPayments');

/**
 * Sum of unresolved failed exposure: one Amount per bucket (latest PaymentDate),
 * not the sum of every failed attempt row. Optionally scoped by list filters (dates, group, etc.).
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 * @param {{
 *   unresolvedFailedOnly?: boolean,
 *   status?: string,
 *   startDate?: string,
 *   endDate?: string,
 *   groupId?: string,
 *   memberId?: string,
 *   agentId?: string,
 *   agencyId?: string,
 *   viewerAgentId?: string,
 *   sellingPaymentWhere?: string,
 *   bindSelling?: (r: import('mssql').Request) => void
 * }} opts
 * @returns {Promise<number>}
 */
async function sumUnresolvedFailedDedupedAmount(pool, tenantId, opts = {}) {
  const {
    unresolvedFailedOnly = false,
    status,
    startDate,
    endDate,
    groupId,
    memberId,
    agentId,
    agencyId,
    viewerAgentId,
    sellingPaymentWhere,
    bindSelling
  } = opts;

  const includeFailedUnresolved =
    unresolvedFailedOnly === true ||
    !status ||
    String(status).trim() === '' ||
    status === 'Failed';

  if (!includeFailedUnresolved) return 0;

  const req = pool.request();
  req.input('tenantId', sql.UniqueIdentifier, tenantId);

  let whereClause = 'WHERE p.TenantId = @tenantId';
  whereClause += UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE;

  if (!unresolvedFailedOnly) {
    if (startDate) {
      whereClause += ' AND CAST(p.PaymentDate AS DATE) >= @startDate';
      req.input('startDate', sql.Date, startDate);
    }
    if (endDate) {
      whereClause += ' AND CAST(p.PaymentDate AS DATE) <= @endDate';
      req.input('endDate', sql.Date, endDate);
    }
  }
  if (groupId) {
    whereClause += ' AND (p.GroupId = @groupId OR m.GroupId = @groupId)';
    req.input('groupId', sql.UniqueIdentifier, groupId);
  }
  if (memberId) {
    whereClause +=
      ' AND (m.MemberId = @memberId OR p.HouseholdId IN (SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId))';
    req.input('memberId', sql.UniqueIdentifier, memberId);
  }
  if (agentId) {
    whereClause += ' AND (p.AgentId = @agentId OR e.AgentId = @agentId)';
    req.input('agentId', sql.UniqueIdentifier, agentId);
  }
  if (agencyId) {
    whereClause += ' AND ag.AgencyId = @agencyId';
    req.input('agencyId', sql.UniqueIdentifier, agencyId);
  }
  if (viewerAgentId) {
    whereClause += `
      AND (
        (m.MemberId IS NOT NULL AND m.AgentId = @viewerAgentId)
        OR EXISTS (
          SELECT 1 FROM oe.Groups gx
          WHERE gx.GroupId = COALESCE(p.GroupId, m.GroupId) AND gx.GroupId IS NOT NULL AND gx.AgentId = @viewerAgentId
        )
      )`;
    req.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
  }
  if (sellingPaymentWhere && typeof sellingPaymentWhere === 'string' && sellingPaymentWhere.trim()) {
    whereClause += ` ${sellingPaymentWhere}`;
    if (typeof bindSelling === 'function') bindSelling(req);
  }

  const sqlText = `
    SELECT ISNULL(SUM(v.Amount), 0) AS TotalFailedUnresolvedDeduped
    FROM (
      SELECT CAST(ISNULL(p.Amount, 0) AS DECIMAL(18, 2)) AS Amount,
        ROW_NUMBER() OVER (
          PARTITION BY ${UNRESOLVED_FAILED_PAYMENTS_BUCKET_KEY_SQL}
          ORDER BY p.PaymentDate DESC
        ) AS rn
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON (p.HouseholdId IS NOT NULL AND m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P') OR e.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId OR e.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
      ${UNRESOLVED_FAILED_PAYMENTS_FROM_P}
      ${whereClause}
    ) v
    WHERE v.rn = 1
  `;

  const result = await req.query(sqlText);
  return Number(result.recordset[0]?.TotalFailedUnresolvedDeduped) || 0;
}

module.exports = {
  sumUnresolvedFailedDedupedAmount
};
