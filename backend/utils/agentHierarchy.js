/**
 * Shared agent hierarchy helpers for oe.AgentHierarchy.
 * Used by me/agent routes and tenant-admin-agents.
 */

const sql = require('mssql');

/**
 * Check if uplineAgentId is the direct upline (parent) of downlineAgentId in oe.AgentHierarchy
 */
async function isDirectUpline(pool, downlineAgentId, uplineAgentId) {
  if (!downlineAgentId || !uplineAgentId) return false;
  const r = pool.request();
  r.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);
  r.input('UplineAgentId', sql.UniqueIdentifier, uplineAgentId);
  const result = await r.query(`
    SELECT 1 as ok
    FROM oe.AgentHierarchy
    WHERE AgentId = @DownlineAgentId AND ParentId = @UplineAgentId AND Status = 'Active'
  `);
  return result.recordset.length > 0;
}

/**
 * Check if uplineAgentId is an ancestor (direct or indirect upline) of downlineAgentId in oe.AgentHierarchy
 */
async function isUplineAncestor(pool, downlineAgentId, uplineAgentId) {
  if (!downlineAgentId || !uplineAgentId) return false;
  const r = pool.request();
  r.input('DownlineAgentId', sql.UniqueIdentifier, downlineAgentId);
  r.input('UplineAgentId', sql.UniqueIdentifier, uplineAgentId);
  const result = await r.query(`
    WITH Ancestors AS (
      SELECT AgentId, ParentId, 1 as lvl
      FROM oe.AgentHierarchy
      WHERE AgentId = @DownlineAgentId AND Status = 'Active'
      UNION ALL
      SELECT ah.AgentId, ah.ParentId, a.lvl + 1
      FROM oe.AgentHierarchy ah
      INNER JOIN Ancestors a ON ah.AgentId = a.ParentId AND ah.Status = 'Active'
      WHERE a.lvl < 20
    )
    SELECT 1 as ok FROM Ancestors WHERE ParentId = @UplineAgentId
  `);
  return result.recordset.length > 0;
}

/**
 * Self agent + all recursive downline AgentIds (oe.AgentHierarchy), active agents only.
 * Same recursion as GET /api/me/agent/agents/downline-agents.
 * @returns {Promise<Array>} Active agent GUIDs (mssql uniqueidentifier values)
 */
async function getSelfAndDownlineAgentIds(pool, userId) {
  if (!userId) return [];
  const r = pool.request();
  r.input('userId', sql.UniqueIdentifier, userId);
  const result = await r.query(`
    WITH Downline AS (
      SELECT a.AgentId FROM oe.Agents a WHERE a.UserId = @userId AND a.Status = 'Active'
      UNION ALL
      SELECT ah.AgentId FROM oe.AgentHierarchy ah
      INNER JOIN Downline d ON ah.ParentId = d.AgentId
      WHERE ah.Status = 'Active'
    )
    SELECT DISTINCT d.AgentId
    FROM Downline d
    INNER JOIN oe.Agents a ON a.AgentId = d.AgentId AND a.Status = 'Active'
  `);
  return (result.recordset || []).map((row) => row.AgentId);
}

/**
 * All active agent IDs in the same agency (oe.Agents.AgencyId).
 */
async function getAgentIdsForAgency(pool, agencyId) {
  if (!agencyId) return [];
  const r = pool.request();
  r.input('agencyId', sql.UniqueIdentifier, agencyId);
  const result = await r.query(`
    SELECT a.AgentId
    FROM oe.Agents a
    WHERE a.AgencyId = @agencyId AND a.Status = 'Active'
  `);
  return (result.recordset || []).map((row) => row.AgentId);
}

/**
 * Verify the given agent is in oe.AgencyAdmins for the given agency.
 * Used to gate agency-admin operations across me/agent routes.
 */
async function isAgencyAdmin(pool, currentAgentId, agencyId) {
  if (!currentAgentId || !agencyId) return false;
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, currentAgentId)
    .input('agencyId', sql.UniqueIdentifier, agencyId)
    .query(`
      SELECT TOP 1 1 AS Hit
      FROM oe.AgencyAdmins
      WHERE AgentId = @agentId AND AgencyId = @agencyId
    `);
  return result.recordset.length > 0;
}

/**
 * Direct child agents only (oe.AgentHierarchy where ParentId = parent agent).
 */
async function getDirectDownlineAgentIds(pool, parentAgentId) {
  if (!parentAgentId) return [];
  const r = pool.request();
  r.input('parentAgentId', sql.UniqueIdentifier, parentAgentId);
  const result = await r.query(`
    SELECT ah.AgentId
    FROM oe.AgentHierarchy ah
    INNER JOIN oe.Agents a ON a.AgentId = ah.AgentId AND a.Status = 'Active'
    WHERE ah.ParentId = @parentAgentId AND ah.Status = 'Active'
  `);
  return (result.recordset || []).map((row) => row.AgentId);
}

module.exports = {
  isDirectUpline,
  isUplineAncestor,
  isAgencyAdmin,
  getSelfAndDownlineAgentIds,
  getAgentIdsForAgency,
  getDirectDownlineAgentIds
};
