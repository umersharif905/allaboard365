const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const {
    isUplineAncestor,
    getSelfAndDownlineAgentIds,
    getAgentIdsForAgency,
    getDirectDownlineAgentIds
} = require('../utils/agentHierarchy');
const agencyAdmins = require('../utils/agencyAdmins');
const {
  buildMemberMetricsSelectSql,
  buildMonthlyRosterPremiumSubquery,
} = require('../utils/memberStatsSql');

/**
 * Multi-tenant + roles: see `prompts/backend-system.md` (requireTenantAccess, active tenant, role validation).
 * This router is mounted in app.js with `authenticate` + `requireTenantAccess` — use `req.tenantId` for the
 * active (switched) tenant, not JWT alone.
 */

/**
 * Unified multi-role endpoint helper: resolve which role context applies for metrics scoping.
 * Never trust `req.query.currentRole` without verifying `getUserRoles(req.user).includes(...)`.
 * @param {object} req - Express request
 * @returns {string}
 */
function resolveEffectiveRoleForMetrics(req) {
    const userRoles = getUserRoles(req.user);
    if (!userRoles.length) {
        return String(req.user?.currentRole || '').trim() || 'Member';
    }
    const raw = req.query.currentRole != null ? String(req.query.currentRole).trim() : '';
    if (raw) {
        if (userRoles.includes(raw)) {
            return raw;
        }
        console.warn('⚠️ GET /api/metrics/members: ignoring unauthorized currentRole query', {
            attempted: raw,
            userId: req.user?.UserId,
            allowedRoles: userRoles
        });
    }
    const jwtRole = String(req.user?.currentRole || '').trim();
    if (jwtRole && userRoles.includes(jwtRole)) {
        return jwtRole;
    }
    return userRoles[0];
}

/**
 * Tenant-wide header stats vs agent book: TenantAdmin + Agent users need tenant scope when acting as
 * TenantAdmin (or GroupAdmin), and agent scope when `effectiveRole` is Agent / AgencyOwner.
 * @param {string[]} userRoles
 * @param {string} effectiveRole
 */
function shouldUseTenantWideMemberMetrics(userRoles, effectiveRole) {
    if (!userRoles.includes('TenantAdmin')) return false;
    return (
        effectiveRole === 'TenantAdmin' ||
        !userRoles.includes('Agent') ||
        (effectiveRole !== 'Agent' && effectiveRole !== 'AgencyOwner')
    );
}

/**
 * @route   GET /api/metrics/dashboard
 * @desc    Get dashboard metrics for members page (legacy endpoint)
 * @access  Private
 */
router.get('/dashboard', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);
        
        let query = `
            SELECT 
                (SELECT COUNT(*) FROM oe.Members m JOIN oe.Users u ON m.UserId = u.UserId WHERE m.Status = 'Active'`;
        
        let params = [];
        
        // Role-based filtering
        if (!userRoles.includes('SysAdmin')) {
            query += ` AND u.TenantId = @userTenantId`;
            params.push({ name: 'userTenantId', type: sql.UniqueIdentifier, value: req.user.TenantId });
        }
        
        query += `) as totalMembers,
                (SELECT COUNT(DISTINCT m.HouseholdId) FROM oe.Members m JOIN oe.Users u ON m.UserId = u.UserId WHERE m.HouseholdId IS NOT NULL`;
        
        if (!userRoles.includes('SysAdmin')) {
            query += ` AND u.TenantId = @userTenantId`;
        }
        
        query += `) as householdCount,
                (SELECT COUNT(*) FROM oe.Enrollments e 
                 JOIN oe.Members m ON e.MemberId = m.MemberId 
                 JOIN oe.Users u ON m.UserId = u.UserId 
                 WHERE (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())`;
        
        if (!userRoles.includes('SysAdmin')) {
            query += ` AND u.TenantId = @userTenantId`;
        }
        
        query += `) as activeEnrollments,
                ${buildMonthlyRosterPremiumSubquery({
                  memberWhereClause: `m.Status = 'Active'${!userRoles.includes('SysAdmin') ? ' AND u.TenantId = @userTenantId' : ''}`,
                })} as monthlyPremiums,
                (SELECT ISNULL(AVG(e.PremiumAmount), 0) FROM oe.Enrollments e 
                 JOIN oe.Members m ON e.MemberId = m.MemberId 
                 JOIN oe.Users u ON m.UserId = u.UserId 
                 WHERE (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())`;
        
        if (!userRoles.includes('SysAdmin')) {
            query += ` AND u.TenantId = @userTenantId`;
        }
        
        query += `) as avgPremium`;

        const request = pool.request();
        params.forEach(param => {
            request.input(param.name, param.type, param.value);
        });

        const result = await request.query(query);
        const metrics = result.recordset[0];

        res.json({ success: true, data: metrics });

    } catch (error) {
        console.error('Error fetching dashboard metrics:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server error while fetching metrics',
            error: {
                message: error.message,
                code: 'METRICS_FETCH_ERROR'
            }
        });
    }
});

/**
 * @route   GET /api/metrics/members
 * @desc    Get member-specific metrics with role-based filtering (unified multi-role; see prompts/backend-system.md)
 * @access  Private (SysAdmin, TenantAdmin, Agent, GroupAdmin)
 * @query   {string} [currentRole] — Optional; must match a role in `req.user.roles` (validated server-side).
 *          Frontend should send the active portal role from AuthContext when user has multiple roles.
 * @query   {string} [scope] — Agent/AgencyOwner: downline | agency | direct | auto (existing behavior)
 * @query   {string} [agentId] — Filter metrics to one agent (authorized downline/agency only)
 */
router.get('/members', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), async (req, res) => {
    try {
        const userRoles = getUserRoles(req.user);
        const effectiveRole = resolveEffectiveRoleForMetrics(req);

        console.log('🔍 GET /api/metrics/members - Request received');
        console.log('👤 User:', { 
            userId: req.user?.UserId,
            userRoles,
            effectiveRole,
            tenantId: req.tenantId || req.user?.TenantId
        });

        const pool = await getPool();
        
        // Active tenant after tenant switching (requireTenantAccess on /api/metrics) — prompts/backend-system.md
        const activeTenantId = req.tenantId || req.user.TenantId;
        
        // Build base metrics query with role-based filtering
        let baseFilter = `m.Status = 'Active'`;
        let params = [];
        /** For Agent responses: UI sublabel for header stats — 'agency' | 'downline' */
        let agentStatsScopeSublabel = null;

        // Role-based filtering
        if (!userRoles.includes('SysAdmin')) {
            baseFilter += ` AND u.TenantId = @userTenantId`;
            params.push({ name: 'userTenantId', type: sql.UniqueIdentifier, value: activeTenantId });
            
            const useTenantWideMemberMetrics = shouldUseTenantWideMemberMetrics(userRoles, effectiveRole);

            if (useTenantWideMemberMetrics) {
                // baseFilter is already tenant-scoped; nothing to add
            } else if (userRoles.includes('Agent')) {
                const metricsAgentIdRaw = req.query.agentId && String(req.query.agentId).trim();
                const scopeNorm = String(req.query.scope || '').toLowerCase();
                const scopeDownline = scopeNorm === 'downline';
                const scopeAgency = scopeNorm === 'agency';
                const scopeDirect = scopeNorm === 'direct';
                const scopeAuto = scopeNorm === 'auto';
                const hasAgencyOwnerRole = userRoles.includes('AgencyOwner');

                const agentRow = await pool.request()
                    .input('userId', sql.UniqueIdentifier, req.user.UserId)
                    .query('SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId AND Status = \'Active\'');
                const currentAgentId = agentRow.recordset[0]?.AgentId;
                const myAgencyId = agentRow.recordset[0]?.AgencyId;
                const isAgencyOwner =
                    hasAgencyOwnerRole ||
                    (currentAgentId && myAgencyId
                        ? await agencyAdmins.isAgencyAdmin(pool, myAgencyId, currentAgentId)
                        : false);

                if (metricsAgentIdRaw) {
                    const isSelf = currentAgentId && String(metricsAgentIdRaw).toLowerCase() === String(currentAgentId).toLowerCase();
                    const isDownline = currentAgentId && (await isUplineAncestor(pool, metricsAgentIdRaw, currentAgentId));
                    let sameAgency = false;
                    if (isAgencyOwner && myAgencyId) {
                        const check = await pool.request()
                            .input('requestedAgentId', sql.UniqueIdentifier, metricsAgentIdRaw)
                            .input('agencyId', sql.UniqueIdentifier, myAgencyId)
                            .query('SELECT AgentId FROM oe.Agents WHERE AgentId = @requestedAgentId AND AgencyId = @agencyId AND Status = \'Active\'');
                        sameAgency = check.recordset.length > 0;
                    }
                    if (!isSelf && !isDownline && !sameAgency) {
                        return res.status(403).json({
                            success: false,
                            message: 'Agent not in your downline.'
                        });
                    }
                    baseFilter += ` AND m.AgentId = @metricsAgentId`;
                    params.push({ name: 'metricsAgentId', type: sql.UniqueIdentifier, value: metricsAgentIdRaw });
                } else if (scopeAgency) {
                    agentStatsScopeSublabel = 'agency';
                    if (!isAgencyOwner) {
                        return res.status(403).json({ success: false, message: 'Agency-wide scope requires Agency Owner role.' });
                    }
                    if (!myAgencyId) {
                        baseFilter += ` AND 1 = 0`;
                    } else {
                        const downlineIds = await getAgentIdsForAgency(pool, myAgencyId);
                        if (downlineIds.length === 0) {
                            baseFilter += ` AND 1 = 0`;
                        } else {
                            const placeholders = downlineIds.map((_, i) => `@metScope${i}`).join(', ');
                            baseFilter += ` AND m.AgentId IN (${placeholders})`;
                            downlineIds.forEach((id, i) => {
                                params.push({ name: `metScope${i}`, type: sql.UniqueIdentifier, value: id });
                            });
                        }
                    }
                } else if (scopeDirect) {
                    agentStatsScopeSublabel = 'downline';
                    const downlineIds = await getDirectDownlineAgentIds(pool, currentAgentId);
                    if (downlineIds.length === 0) {
                        baseFilter += ` AND 1 = 0`;
                    } else {
                        const placeholders = downlineIds.map((_, i) => `@metScope${i}`).join(', ');
                        baseFilter += ` AND m.AgentId IN (${placeholders})`;
                        downlineIds.forEach((id, i) => {
                            params.push({ name: `metScope${i}`, type: sql.UniqueIdentifier, value: id });
                        });
                    }
                } else if (scopeDownline) {
                    agentStatsScopeSublabel = 'downline';
                    const downlineIds = await getSelfAndDownlineAgentIds(pool, req.user.UserId);
                    if (downlineIds.length === 0) {
                        baseFilter += ` AND 1 = 0`;
                    } else {
                        const placeholders = downlineIds.map((_, i) => `@metScope${i}`).join(', ');
                        baseFilter += ` AND m.AgentId IN (${placeholders})`;
                        downlineIds.forEach((id, i) => {
                            params.push({ name: `metScope${i}`, type: sql.UniqueIdentifier, value: id });
                        });
                    }
                } else if (scopeAuto) {
                    if (isAgencyOwner && myAgencyId) {
                        agentStatsScopeSublabel = 'agency';
                        const agencyAgentIds = await getAgentIdsForAgency(pool, myAgencyId);
                        if (agencyAgentIds.length === 0) {
                            baseFilter += ` AND 1 = 0`;
                        } else {
                            const placeholders = agencyAgentIds.map((_, i) => `@metScope${i}`).join(', ');
                            baseFilter += ` AND m.AgentId IN (${placeholders})`;
                            agencyAgentIds.forEach((id, i) => {
                                params.push({ name: `metScope${i}`, type: sql.UniqueIdentifier, value: id });
                            });
                        }
                    } else {
                        agentStatsScopeSublabel = 'downline';
                        const downlineIds = await getSelfAndDownlineAgentIds(pool, req.user.UserId);
                        if (downlineIds.length === 0) {
                            baseFilter += ` AND 1 = 0`;
                        } else {
                            const placeholders = downlineIds.map((_, i) => `@metScope${i}`).join(', ');
                            baseFilter += ` AND m.AgentId IN (${placeholders})`;
                            downlineIds.forEach((id, i) => {
                                params.push({ name: `metScope${i}`, type: sql.UniqueIdentifier, value: id });
                            });
                        }
                    }
                } else {
                    baseFilter += ` AND m.AgentId = (
                    SELECT a.AgentId FROM oe.Agents a WHERE a.UserId = @userId
                )`;
                    params.push({ name: 'userId', type: sql.UniqueIdentifier, value: req.user.UserId });
                }
            } else if (userRoles.includes('GroupAdmin')) {
                baseFilter += ` AND m.GroupId = (
                    SELECT m2.GroupId FROM oe.Members m2 WHERE m2.UserId = @userId
                )`;
                params.push({ name: 'userId', type: sql.UniqueIdentifier, value: req.user.UserId });
            }
        }

        const query = buildMemberMetricsSelectSql({ memberWhereClause: baseFilter });

        const request = pool.request();
        params.forEach(param => {
            request.input(param.name, param.type, param.value);
        });

        const result = await request.query(query);
        const metrics = result.recordset[0];

        if (userRoles.includes('Agent') && agentStatsScopeSublabel) {
            metrics.statsScopeSublabel = agentStatsScopeSublabel;
        }

        console.log('✅ Member metrics fetched successfully:', {
            totalMembers: metrics.totalMembers,
            householdCount: metrics.householdCount,
            activeEnrollments: metrics.activeEnrollments,
            scope: userRoles.includes('SysAdmin') ? 'All Tenants' : 'Current Tenant'
        });

        res.json({ 
            success: true, 
            data: metrics 
        });

    } catch (error) {
        console.error('❌ Error fetching member metrics:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error while fetching member metrics',
            error: {
                message: error.message,
                code: 'MEMBER_METRICS_ERROR'
            }
        });
    }
});

module.exports = router; 