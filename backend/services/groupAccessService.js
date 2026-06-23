'use strict';

/**
 * Central group access checks for detail/resolve APIs.
 *
 * Rules (based on req.user.currentRole):
 *  - SysAdmin: any group
 *  - TenantAdmin: group.TenantId must match active tenant (req.tenantId)
 *  - GroupAdmin: user must be assigned to that group (oe.GroupAdmins)
 *  - Agent: group.AgentId must be self, a downline agent (any upline depth), or any agent
 *    in an agency the viewer administers
 */

const { sql } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');
const { getAccessibleAgentIdsForUser, buildAgentScopeClause } = require('../utils/agentGroupAccess');

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} groupId
 * @param {object} user - req.user (UserId, currentRole, TenantId, GroupId?)
 * @param {{ tenantId?: string }} [options] - Active tenant from requireTenantAccess (req.tenantId)
 * @returns {Promise<{ hasAccess: boolean, group: object|null, reason?: string }>}
 */
async function verifyGroupAccess(pool, groupId, user, options = {}) {
    const currentRole = user?.currentRole || getUserRoles(user)[0];
    const activeTenantId = options.tenantId ?? user?.TenantId;

    if (!groupId || !user?.UserId) {
        return { hasAccess: false, group: null, reason: 'missing_context' };
    }

    if (currentRole === 'SysAdmin') {
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, groupId);
        const result = await request.query(`
            SELECT g.GroupId, g.TenantId, g.AgentId, g.AllAboardMasterGroupId, g.Name, g.Status
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `);
        return {
            hasAccess: result.recordset.length > 0,
            group: result.recordset[0] || null,
        };
    }

    let query = `
        SELECT g.GroupId, g.TenantId, g.AgentId, g.AllAboardMasterGroupId, g.Name, g.Status
        FROM oe.Groups g
        WHERE g.GroupId = @groupId
    `;
    const request = pool.request();
    request.input('groupId', sql.UniqueIdentifier, groupId);

    if (currentRole === 'GroupAdmin') {
        let userGroupId = user.GroupId || user.groupId;
        if (!userGroupId) {
            const groupIdResult = await pool.request()
                .input('userId', sql.UniqueIdentifier, user.UserId)
                .query(`
                    SELECT TOP 1 GroupId
                    FROM oe.GroupAdmins
                    WHERE UserId = @userId AND Status = 'Active'
                `);
            userGroupId = groupIdResult.recordset[0]?.GroupId;
        }
        if (!userGroupId) {
            return { hasAccess: false, group: null, reason: 'group_admin_unassigned' };
        }
        query += ' AND g.GroupId = @userGroupId';
        request.input('userGroupId', sql.UniqueIdentifier, userGroupId);
    } else if (currentRole === 'Agent') {
        const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, user);
        if (!accessibleAgentIds.length) {
            return { hasAccess: false, group: null, reason: 'agent_no_scope' };
        }
        const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agAccess');
        query += ` AND ${agentScopeClause}`;
    } else if (currentRole === 'TenantAdmin') {
        if (!activeTenantId) {
            return { hasAccess: false, group: null, reason: 'missing_tenant' };
        }
        query += ' AND g.TenantId = @activeTenantId';
        request.input('activeTenantId', sql.UniqueIdentifier, activeTenantId);
    } else {
        return { hasAccess: false, group: null, reason: 'unsupported_role' };
    }

    const result = await request.query(query);
    return {
        hasAccess: result.recordset.length > 0,
        group: result.recordset[0] || null,
    };
}

/**
 * Resolve a group by UUID or AllAboardMasterGroupId, then enforce access.
 * Returns null when not found or caller lacks access (caller should respond 404).
 */
async function resolveGroupIdentifierForUser(pool, identifier, user, options = {}) {
    const activeTenantId = options.tenantId ?? user?.TenantId;
    const isSysAdmin = (user?.currentRole || getUserRoles(user)[0]) === 'SysAdmin';
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    let groupId = null;
    if (uuidRe.test(String(identifier || ''))) {
        groupId = identifier;
    } else {
        const lookup = pool.request().input('Identifier', sql.NVarChar(100), identifier);
        let query = `
            SELECT g.GroupId
            FROM oe.Groups g
            WHERE g.AllAboardMasterGroupId = @Identifier
              AND (g.Status = 'Active' OR g.Status = 'Archived')
        `;
        if (!isSysAdmin && activeTenantId) {
            lookup.input('TenantId', sql.UniqueIdentifier, activeTenantId);
            query += ' AND g.TenantId = @TenantId';
        }
        const found = await lookup.query(query);
        if (!found.recordset.length) {
            return null;
        }
        groupId = found.recordset[0].GroupId;
    }

    const access = await verifyGroupAccess(pool, groupId, user, options);
    return access.hasAccess ? access.group : null;
}

module.exports = {
    verifyGroupAccess,
    resolveGroupIdentifierForUser,
};
