/**
 * Batched hierarchy helpers: replace per-agency recursive COUNT (N+1) with one closure query,
 * and fetch scoped agent rows for lazy subtree loading.
 */

const { sql } = require('../config/database');

/**
 * For each agency in the tenant, count distinct agents reachable from seeds where the agent's
 * oe.Agents.AgencyId equals that agency (same semantics as legacy AgencyAgentHierarchy CTE).
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 * @returns {Promise<Map<string, number>>} normalized AgencyId (lowercase, no braces) -> count
 */
async function batchTotalAgentCountsByAgency(pool, tenantId) {
  const req = pool.request();
  req.input('TenantId', sql.UniqueIdentifier, tenantId);
  const result = await req.query(`
    WITH Seeds AS (
      SELECT ag.AgentId, ag.AgencyId AS RootAgencyId
      FROM oe.Agents ag
      INNER JOIN oe.Users u ON u.UserId = ag.UserId
      WHERE ag.TenantId = @TenantId
        AND ag.Status IN ('Active', 'Pending')
        AND u.Status IN ('Active', 'Pending')
        AND ag.AgencyId IS NOT NULL
    ),
    Closure AS (
      SELECT AgentId, RootAgencyId FROM Seeds
      UNION ALL
      SELECT ag2.AgentId, c.RootAgencyId
      FROM oe.AgentHierarchy ah
      INNER JOIN oe.Agents ag2 ON ah.AgentId = ag2.AgentId
      INNER JOIN oe.Users u2 ON u2.UserId = ag2.UserId
      INNER JOIN Closure c ON ah.ParentId = c.AgentId
      WHERE ah.Status = 'Active'
        AND ag2.TenantId = @TenantId
        AND ag2.Status IN ('Active', 'Pending')
        AND u2.Status IN ('Active', 'Pending')
    )
    SELECT RootAgencyId AS AgencyId, COUNT(DISTINCT AgentId) AS TotalAgentCount
    FROM Closure
    GROUP BY RootAgencyId
  `);
  const map = new Map();
  for (const row of result.recordset || []) {
    const k = String(row.AgencyId).toLowerCase().replace(/[{}]/g, '');
    map.set(k, Number(row.TotalAgentCount) || 0);
  }
  return map;
}

/**
 * Agent rows under one agency's subtree (legacy hierarchy semantics).
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 * @param {string} agencyId
 */
async function fetchAgentRowsForAgencySubtree(pool, tenantId, agencyId) {
  const req = pool.request();
  req.input('TenantId', sql.UniqueIdentifier, tenantId);
  req.input('AgencyId', sql.UniqueIdentifier, agencyId);

  const result = await req.query(`
    WITH SubtreeAgents AS (
      SELECT ag.AgentId
      FROM oe.Agents ag
      WHERE ag.AgencyId = @AgencyId
        AND ag.TenantId = @TenantId
        AND ag.Status IN ('Active', 'Pending')

      UNION ALL

      SELECT ag2.AgentId
      FROM oe.AgentHierarchy ah
      INNER JOIN oe.Agents ag2 ON ah.AgentId = ag2.AgentId
      INNER JOIN SubtreeAgents sa ON ah.ParentId = sa.AgentId
      WHERE ah.Status = 'Active'
        AND ag2.TenantId = @TenantId
        AND ag2.Status IN ('Active', 'Pending')
    )
    SELECT
      a.AgentId,
      a.AgencyId,
      a.BusinessName,
      a.CommissionRole,
      a.CommissionTierLevel,
      a.NPN,
      a.AgentCode,
      a.Status AS AgentStatus,
      a.CommissionGroupId,
      cg.Name AS CommissionGroupName,
      u.FirstName,
      u.LastName,
      u.Email,
      u.PhoneNumber,
      ah.HierarchyId,
      ah.ParentId,
      ah.Status AS HierarchyStatus
    FROM SubtreeAgents sa
    INNER JOIN oe.Agents a ON sa.AgentId = a.AgentId
    INNER JOIN oe.Users u ON a.UserId = u.UserId
    LEFT JOIN oe.AgentHierarchy ah ON a.AgentId = ah.AgentId AND ah.Status = 'Active'
    LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
    WHERE u.Status IN ('Active', 'Pending')
    ORDER BY u.FirstName, u.LastName
  `);

  return result.recordset || [];
}

module.exports = {
  batchTotalAgentCountsByAgency,
  fetchAgentRowsForAgencySubtree
};
