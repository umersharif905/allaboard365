/**
 * Group/agent scope for the agent portal. Uses oe.AgencyAdmins for every agency the viewer
 * administers (union of that agency’s agents). Downline-only when not an agency admin.
 * Does not use JWT AgencyOwner.
 */
const sql = require('mssql');
const { getSelfAndDownlineAgentIds, getAgentIdsForAgency } = require('./agentHierarchy');
const agencyAdmins = require('./agencyAdmins');

const normalizeId = (value) => (value ? String(value).toLowerCase() : '');

async function getViewerAgentContext(pool, userId) {
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT AgentId, AgencyId
      FROM oe.Agents
      WHERE UserId = @userId AND Status = 'Active'
    `);

  if (result.recordset.length === 0) return null;
  return result.recordset[0];
}

async function getAccessibleAgentIdsForUser(pool, user) {
  if (!user?.UserId) return [];

  const context = await getViewerAgentContext(pool, user.UserId);
  if (!context?.AgentId) return [];

  const administered = await agencyAdmins.getAdministeredAgenciesForAgent(pool, context.AgentId);
  const administeredAgencyIds = (administered.recordset || [])
    .map((r) => r.AgencyId)
    .filter(Boolean);

  if (administeredAgencyIds.length > 0) {
    const seen = new Set();
    const out = [];
    for (const agencyId of administeredAgencyIds) {
      const ids = await getAgentIdsForAgency(pool, agencyId);
      for (const id of ids) {
        const key = normalizeId(id);
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(id);
        }
      }
    }
    return out;
  }

  return getSelfAndDownlineAgentIds(pool, user.UserId);
}

function buildAgentScopeClause(request, agentIds, columnName, paramPrefix = 'scopeAgent') {
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return '1 = 0';
  }

  const uniqueAgentIds = [...new Set(agentIds.map(normalizeId).filter(Boolean))];
  if (uniqueAgentIds.length === 0) {
    return '1 = 0';
  }

  uniqueAgentIds.forEach((agentId, index) => {
    request.input(`${paramPrefix}${index}`, sql.UniqueIdentifier, agentId);
  });

  return `${columnName} IN (${uniqueAgentIds.map((_, index) => `@${paramPrefix}${index}`).join(', ')})`;
}

function canAccessAgentId(agentIds, targetAgentId) {
  const allowed = new Set((agentIds || []).map(normalizeId).filter(Boolean));
  return allowed.has(normalizeId(targetAgentId));
}

module.exports = {
  getAccessibleAgentIdsForUser,
  buildAgentScopeClause,
  canAccessAgentId
};
