/**
 * Agency admins: oe.AgencyAdmins (many agents per agency). Replaces oe.Agencies.OwnerAgentId.
 */
const { sql } = require('../config/database');

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} agencyId
 * @param {string} agentId
 * @returns {Promise<boolean>}
 */
async function isAgencyAdmin(pool, agencyId, agentId) {
  if (!agencyId || !agentId) return false;
  const r = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .input('AgentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT COUNT(*) AS c FROM oe.AgencyAdmins
      WHERE AgencyId = @AgencyId AND AgentId = @AgentId AND Status = 'Active'
    `);
  return (r.recordset[0]?.c || 0) > 0;
}

/**
 * Agencies this agent administers (active).
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} currentAgentId
 */
async function getAdministeredAgenciesForAgent(pool, currentAgentId) {
  if (!currentAgentId) return { recordset: [] };
  return pool.request()
    .input('AgentId', sql.UniqueIdentifier, currentAgentId)
    .query(`
      SELECT a.AgencyId, a.AgencyName, a.Status, a.CreatedDate, a.IsPrimary,
             COALESCE(cl.SortOrder, a.CommissionTierLevel, 0) AS CommissionTierLevel,
             a.CommissionLevelId,
             cl.DisplayName AS CommissionLevelName,
             a.ContactEmail as Email, a.ContactPhone as Phone,
             a.CommissionGroupId, cg.Name as CommissionGroupName, a.TenantId
      FROM oe.Agencies a
      LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
      LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId
      INNER JOIN oe.AgencyAdmins aa ON aa.AgencyId = a.AgencyId AND aa.Status = 'Active'
      WHERE aa.AgentId = @AgentId AND a.Status = 'Active'
    `);
}

/**
 * Deterministic pick for enrollment links / legacy single-agent resolution.
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} agencyId
 * @returns {Promise<string|null>}
 */
async function getRepresentativeAgentIdForAgency(pool, agencyId) {
  if (!agencyId) return null;
  const r = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .query(`
      SELECT TOP 1 AgentId FROM oe.AgencyAdmins
      WHERE AgencyId = @AgencyId AND Status = 'Active'
      ORDER BY AgentId
    `);
  return r.recordset.length ? r.recordset[0].AgentId : null;
}

/**
 * Replace all admins for an agency. Validates each agent belongs to tenant.
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} agencyId
 * @param {string[]} agentIds
 * @param {string} tenantId
 */
/**
 * Append one agency admin if not already present (validates agent is active tenant member assigned to this agency).
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} agencyId
 * @param {string} agentId
 * @param {string} tenantId
 * @returns {Promise<{ inserted: boolean }>}
 */
async function appendAgencyAdmin(pool, agencyId, agentId, tenantId) {
  const aid = String(agentId || '').replace(/[{}]/g, '').toLowerCase();
  if (!agencyId || !aid) {
    const err = new Error('AgencyId and AgentId are required.');
    err.statusCode = 400;
    throw err;
  }

  const check = await pool.request()
    .input('AgentId', sql.UniqueIdentifier, aid)
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT AgentId FROM oe.Agents
      WHERE AgentId = @AgentId AND TenantId = @TenantId AND Status = N'Active'
        AND AgencyId = @AgencyId
    `);
  if (check.recordset.length === 0) {
    const err = new Error('Invalid agency admin. Agent must be active, belong to this tenant, and be assigned to this agency.');
    err.statusCode = 400;
    throw err;
  }

  const exists = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .input('AgentId', sql.UniqueIdentifier, aid)
    .query(`
      SELECT 1 FROM oe.AgencyAdmins
      WHERE AgencyId = @AgencyId AND AgentId = @AgentId AND Status = N'Active'
    `);
  if (exists.recordset.length > 0) {
    return { inserted: false };
  }

  const ins = pool.request();
  ins.input('AgencyId', sql.UniqueIdentifier, agencyId);
  ins.input('AgentId', sql.UniqueIdentifier, aid);
  await ins.query(`
    INSERT INTO oe.AgencyAdmins (AgencyId, AgentId, Status)
    VALUES (@AgencyId, @AgentId, N'Active')
  `);
  return { inserted: true };
}

async function replaceAgencyAdmins(pool, agencyId, agentIds, tenantId) {
  const normalized = [...new Set((agentIds || []).filter(Boolean).map((id) => String(id).replace(/[{}]/g, '').toLowerCase()))];

  const del = pool.request();
  del.input('AgencyId', sql.UniqueIdentifier, agencyId);
  await del.query('DELETE FROM oe.AgencyAdmins WHERE AgencyId = @AgencyId');

  for (const aid of normalized) {
    const check = await pool.request()
      .input('AgentId', sql.UniqueIdentifier, aid)
      .input('AgencyId', sql.UniqueIdentifier, agencyId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT AgentId FROM oe.Agents
        WHERE AgentId = @AgentId AND TenantId = @TenantId AND Status = 'Active'
          AND AgencyId = @AgencyId
      `);
    if (check.recordset.length === 0) {
      const err = new Error('Invalid agency admin. Agent must be active, belong to this tenant, and be assigned to this agency.');
      err.statusCode = 400;
      throw err;
    }
    const ins = pool.request();
    ins.input('AgencyId', sql.UniqueIdentifier, agencyId);
    ins.input('AgentId', sql.UniqueIdentifier, aid);
    await ins.query(`
      INSERT INTO oe.AgencyAdmins (AgencyId, AgentId, Status)
      VALUES (@AgencyId, @AgentId, 'Active')
    `);
  }
}

/**
 * Whether this agent admins any agency in the tenant (for settings / products).
 */
async function isAgencyAdminInTenant(pool, tenantId, agentId) {
  if (!tenantId || !agentId) return false;
  const r = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('AgentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT COUNT(*) AS c
      FROM oe.AgencyAdmins aa
      INNER JOIN oe.Agencies a ON a.AgencyId = aa.AgencyId AND a.Status = 'Active'
      WHERE aa.AgentId = @AgentId AND aa.Status = 'Active' AND a.TenantId = @TenantId
    `);
  return (r.recordset[0]?.c || 0) > 0;
}

/**
 * Map AgencyId -> Admin AgentId[] (sorted) for many agencies in one round-trip.
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} agencyIds
 * @returns {Promise<Map<string, string[]>>}
 */
async function getAdminAgentIdsByAgencyMap(pool, agencyIds) {
  const map = new Map();
  const ids = [...new Set((agencyIds || []).filter(Boolean))];
  if (ids.length === 0) return map;
  const valuesClause = ids.map((_, i) => `(@aid${i})`).join(', ');
  const req = pool.request();
  ids.forEach((id, i) => {
    req.input(`aid${i}`, sql.UniqueIdentifier, id);
  });
  const r = await req.query(`
    SELECT aa.AgencyId, aa.AgentId
    FROM oe.AgencyAdmins aa
    WHERE aa.AgencyId IN (SELECT AgencyId FROM (VALUES ${valuesClause}) AS T(AgencyId))
      AND aa.Status = 'Active'
    ORDER BY aa.AgencyId, aa.AgentId
  `);
  for (const row of r.recordset || []) {
    const k = String(row.AgencyId).toLowerCase().replace(/[{}]/g, '');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row.AgentId);
  }
  return map;
}

/**
 * Ensure all active agency admins for an agency have the AgencyOwner role in oe.UserRoles.
 * This is additive only (does not remove roles) for safe compatibility during migration.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} agencyId
 * @param {string|null} createdBy
 * @returns {Promise<number>} count of inserted oe.UserRoles rows
 */
async function ensureAgencyOwnerRolesForAgency(pool, agencyId, createdBy = null) {
  if (!agencyId) return 0;
  const r = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .input('CreatedBy', sql.UniqueIdentifier, createdBy)
    .query(`
      INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
      SELECT NEWID(), src.UserId, roleRow.RoleId, @CreatedBy, GETUTCDATE()
      FROM (
        SELECT DISTINCT a.UserId
        FROM oe.AgencyAdmins aa
        INNER JOIN oe.Agents a
          ON a.AgentId = aa.AgentId
         AND a.Status = 'Active'
        WHERE aa.AgencyId = @AgencyId
          AND aa.Status = 'Active'
          AND a.UserId IS NOT NULL
      ) src
      CROSS JOIN (
        SELECT TOP 1 RoleId
        FROM oe.Roles
        WHERE Name = 'AgencyOwner'
      ) roleRow
      LEFT JOIN oe.UserRoles ur
        ON ur.UserId = src.UserId
       AND ur.RoleId = roleRow.RoleId
      WHERE ur.UserRoleId IS NULL
    `);
  return Array.isArray(r.rowsAffected) ? (r.rowsAffected[0] || 0) : 0;
}

module.exports = {
  isAgencyAdmin,
  getAdministeredAgenciesForAgent,
  getRepresentativeAgentIdForAgency,
  appendAgencyAdmin,
  replaceAgencyAdmins,
  isAgencyAdminInTenant,
  getAdminAgentIdsByAgencyMap,
  ensureAgencyOwnerRolesForAgency
};
