'use strict';

const sql = require('mssql');
const { isUplineAncestor } = require('./agentHierarchy');
const agencyAdmins = require('./agencyAdmins');

/**
 * All downline AgentIds under viewerAgentId (excludes self). oe.AgentHierarchy recursive.
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} viewerAgentId
 * @returns {Promise<string[]>}
 */
async function getStrictDownlineAgentIds(pool, viewerAgentId) {
  if (!viewerAgentId) return [];
  const r = pool.request();
  r.input('root', sql.UniqueIdentifier, viewerAgentId);
  const result = await r.query(`
    WITH Tree AS (
      SELECT ah.AgentId
      FROM oe.AgentHierarchy ah
      WHERE ah.ParentId = @root AND ah.Status = N'Active'
      UNION ALL
      SELECT ah2.AgentId
      FROM oe.AgentHierarchy ah2
      INNER JOIN Tree t ON ah2.ParentId = t.AgentId
      WHERE ah2.Status = N'Active'
    )
    SELECT DISTINCT AgentId FROM Tree
  `);
  return (result.recordset || []).map((row) => row.AgentId).filter(Boolean);
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} agencyIds
 */
async function fetchAgentsInAgencies(pool, agencyIds) {
  if (!agencyIds || agencyIds.length === 0) return [];
  const req = pool.request();
  const clauses = agencyIds.map((_, i) => {
    req.input(`ag${i}`, sql.UniqueIdentifier, agencyIds[i]);
    return `@ag${i}`;
  });
  const q = `
    SELECT
      a.AgentId,
      a.UserId,
      u.FirstName,
      u.LastName,
      u.Email,
      ag.AgencyName
    FROM oe.Agents a
    INNER JOIN oe.Users u ON u.UserId = a.UserId
    LEFT JOIN oe.Agencies ag ON ag.AgencyId = a.AgencyId
    WHERE a.Status = N'Active'
      AND a.AgencyId IN (${clauses.join(', ')})
    ORDER BY u.FirstName, u.LastName
  `;
  const result = await req.query(q);
  return (result.recordset || []).map((row) => ({
    agentId: row.AgentId,
    userId: row.UserId,
    firstName: row.FirstName || '',
    lastName: row.LastName || '',
    email: row.Email || '',
    agencyName: row.AgencyName || ''
  }));
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} agentIds
 */
async function fetchAgentsByIds(pool, agentIds) {
  if (!agentIds || agentIds.length === 0) return [];
  const req = pool.request();
  const clauses = agentIds.map((_, i) => {
    req.input(`aid${i}`, sql.UniqueIdentifier, agentIds[i]);
    return `@aid${i}`;
  });
  const q = `
    SELECT
      a.AgentId,
      a.UserId,
      u.FirstName,
      u.LastName,
      u.Email,
      ag.AgencyName
    FROM oe.Agents a
    INNER JOIN oe.Users u ON u.UserId = a.UserId
    LEFT JOIN oe.Agencies ag ON ag.AgencyId = a.AgencyId
    WHERE a.AgentId IN (${clauses.join(', ')})
      AND a.Status = N'Active'
    ORDER BY u.FirstName, u.LastName
  `;
  const result = await req.query(q);
  return (result.recordset || []).map((row) => ({
    agentId: row.AgentId,
    userId: row.UserId,
    firstName: row.FirstName || '',
    lastName: row.LastName || '',
    email: row.Email || '',
    agencyName: row.AgencyName || ''
  }));
}

/**
 * Agencies administered by this agent (oe.AgencyAdmins).
 * @returns {Promise<string[]>} AgencyId GUIDs
 */
async function getOwnedAgencyIds(pool, viewerAgentId) {
  const res = await agencyAdmins.getAdministeredAgenciesForAgent(pool, viewerAgentId);
  return (res.recordset || []).map((r) => r.AgencyId).filter(Boolean);
}

function normId(id) {
  return id ? String(id).replace(/[{}]/g, '').toLowerCase() : '';
}

/**
 * Whether group's current agent belongs to an agency the viewer administers.
 */
async function groupAgentIsInOwnedAgencies(pool, groupId, ownedAgencyIdSet) {
  if (!groupId || ownedAgencyIdSet.size === 0) return false;
  const r = pool.request();
  r.input('gid', sql.UniqueIdentifier, groupId);
  const gRes = await r.query(`SELECT AgentId FROM oe.Groups WHERE GroupId = @gid`);
  const ga = gRes.recordset[0]?.AgentId;
  if (!ga) return true;
  const aRes = await pool.request()
    .input('aid', sql.UniqueIdentifier, ga)
    .query(`SELECT AgencyId FROM oe.Agents WHERE AgentId = @aid AND Status = N'Active'`);
  const agy = aRes.recordset[0]?.AgencyId;
  if (!agy) return false;
  return ownedAgencyIdSet.has(normId(agy));
}

/**
 * Whether individual member's current agent is in an administered agency (or no agent).
 */
async function memberAgentEligibleForAgencyAdmin(pool, memberId, ownedAgencyIdSet) {
  const r = pool.request();
  r.input('mid', sql.UniqueIdentifier, memberId);
  const mRes = await r.query(`SELECT AgentId, GroupId FROM oe.Members WHERE MemberId = @mid`);
  const row = mRes.recordset[0];
  if (!row) return false;
  if (row.GroupId) return false;
  if (!row.AgentId) return true;
  const aRes = await pool.request()
    .input('aid', sql.UniqueIdentifier, row.AgentId)
    .query(`SELECT AgencyId FROM oe.Agents WHERE AgentId = @aid AND Status = N'Active'`);
  const agy = aRes.recordset[0]?.AgencyId;
  if (!agy) return false;
  return ownedAgencyIdSet.has(normId(agy));
}

/**
 * Current assignee is viewer or in viewer's downline (strict descendants of viewer).
 */
async function assigneeIsViewerOrDownline(pool, currentAgentId, viewerAgentId) {
  if (!currentAgentId || !viewerAgentId) return true;
  if (normId(currentAgentId) === normId(viewerAgentId)) return true;
  return isUplineAncestor(pool, currentAgentId, viewerAgentId);
}

/**
 * Agents the logged-in agent may assign to (member/group), for UI and server checks.
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} userId oe.Users.UserId
 * @param {{ forGroupId?: string, forMemberId?: string }} ctx
 * @returns {Promise<{ mode: 'agency'|'downline'|'none', agents: Array<{ agentId: string, userId: string, firstName: string, lastName: string, email: string }> }>}
 */
async function getAssignableAgentsForViewer(pool, userId, ctx = {}) {
  const { forGroupId, forMemberId } = ctx;
  const vr = pool.request();
  vr.input('userId', sql.UniqueIdentifier, userId);
  const viewerRow = await vr.query(`
    SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'
  `);
  const viewerAgentId = viewerRow.recordset[0]?.AgentId;
  if (!viewerAgentId) {
    return { mode: 'none', agents: [] };
  }

  const ownedAgencyIds = await getOwnedAgencyIds(pool, viewerAgentId);
  const ownedSet = new Set(ownedAgencyIds.map((id) => normId(id)));

  if (ownedAgencyIds.length > 0) {
    if (forGroupId) {
      const ok = await groupAgentIsInOwnedAgencies(pool, forGroupId, ownedSet);
      if (!ok) return { mode: 'none', agents: [] };
    }
    if (forMemberId) {
      const ok = await memberAgentEligibleForAgencyAdmin(pool, forMemberId, ownedSet);
      if (!ok) return { mode: 'none', agents: [] };
    }
    const agents = await fetchAgentsInAgencies(pool, ownedAgencyIds);
    return { mode: 'agency', agents };
  }

  const downlineIds = await getStrictDownlineAgentIds(pool, viewerAgentId);
  if (downlineIds.length === 0) {
    return { mode: 'none', agents: [] };
  }

  if (forGroupId) {
    const gr = pool.request();
    gr.input('gid', sql.UniqueIdentifier, forGroupId);
    const gRes = await gr.query(`SELECT AgentId FROM oe.Groups WHERE GroupId = @gid`);
    const cur = gRes.recordset[0]?.AgentId;
    if (cur && !(await assigneeIsViewerOrDownline(pool, cur, viewerAgentId))) {
      return { mode: 'none', agents: [] };
    }
  }
  if (forMemberId) {
    const mr = pool.request();
    mr.input('mid', sql.UniqueIdentifier, forMemberId);
    const mRes = await mr.query(`SELECT AgentId, GroupId FROM oe.Members WHERE MemberId = @mid`);
    const row = mRes.recordset[0];
    if (!row) return { mode: 'none', agents: [] };
    if (row.GroupId) return { mode: 'none', agents: [] };
    const cur = row.AgentId;
    if (cur && !(await assigneeIsViewerOrDownline(pool, cur, viewerAgentId))) {
      return { mode: 'none', agents: [] };
    }
  }

  const agents = await fetchAgentsByIds(pool, downlineIds);
  return { mode: 'downline', agents };
}

/**
 * Validate target AgentId for an Agent-role user changing assignment.
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} viewerUserId
 * @param {string} targetAgentId oe.Agents.AgentId
 * @param {{ forGroupId?: string, forMemberId?: string }} ctx
 * @returns {Promise<string|null>} Error message or null if OK
 */
async function assertAgentMayAssignToTargetAgent(pool, viewerUserId, targetAgentId, ctx = {}) {
  if (!targetAgentId || !viewerUserId) return 'Invalid assignment';
  const vr = pool.request();
  vr.input('userId', sql.UniqueIdentifier, viewerUserId);
  const viewerRow = await vr.query(
    `SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'`
  );
  const viewerAgentId = viewerRow.recordset[0]?.AgentId;
  if (viewerAgentId && normId(viewerAgentId) === normId(targetAgentId)) {
    return null;
  }
  const list = await getAssignableAgentsForViewer(pool, viewerUserId, ctx);
  const ok = list.agents.some((a) => normId(a.agentId) === normId(targetAgentId));
  if (!ok) {
    return 'You are not allowed to assign this agent.';
  }
  return null;
}

module.exports = {
  getAssignableAgentsForViewer,
  assertAgentMayAssignToTargetAgent,
  getStrictDownlineAgentIds,
  getOwnedAgencyIds
};
