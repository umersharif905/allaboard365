// backend/routes/me/agent/agents.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');
const { isUplineAncestor, isAgencyAdmin } = require('../../../utils/agentHierarchy');
const {
    getLimitedEditContext,
    buildNoEditableFieldsMessage
} = require('../../../utils/agentLimitedEdit');
const agencyAdmins = require('../../../utils/agencyAdmins');
const { buildMonthlyRosterPremiumSubquery } = require('../../../utils/memberStatsSql');
const {
    getMonthlyRecurringRevenueByAgencyMap,
    normalizeAgencyKey
} = require('../../../services/agencyMrr.service');
const {
    buildAgenciesWithAgents,
    buildDownlineAgencies
} = require('../../../services/shared/agent-hierarchy.service');
const { batchTotalAgentCountsByAgency } = require('../../../services/agentHierarchyBatch.service');

/**
 * @route   GET /api/me/agent/agents
 * @desc    Get all agents in the current agent's agency
 * @access  Private (Agent only)
 */
router.get('/', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
    logger.info('[AGENT-AGENCY-AGENTS] >> Fetching agents in same agency');
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-AGENCY-AGENTS] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId and AgencyId from the Agents table
        const agentQuery = `
            SELECT AgentId, AgencyId 
            FROM oe.Agents 
            WHERE UserId = @userId AND Status = 'Active'
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            logger.error('[AGENT-AGENCY-AGENTS] !! Agent not found for user');
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const { AgentId: currentAgentId, AgencyId: agencyId } = agentResult.recordset[0];

        // Agencies this agent administers (oe.AgencyAdmins)
        const ownerAgenciesResult = await agencyAdmins.getAdministeredAgenciesForAgent(pool, currentAgentId);

        const ownedAgencyIds = ownerAgenciesResult.recordset.map(a => a.AgencyId);

        // Agency owner (oe.AgencyAdmins): only agencies this agent administers — never the whole tenant
        // (primary-agency owners previously received all tenant agencies; that matched TenantAdmin and was incorrect for agent portal)
        if (ownedAgencyIds.length > 0) {
            logger.info(`[AGENT-AGENCY-AGENTS] >> Agent is agency owner of ${ownedAgencyIds.length} agency(ies), returning only those agencies and agents`);

                // Get all agents in owned agencies
                const valuesClause = ownedAgencyIds.map((_, i) => `(@agencyId${i})`).join(', ');
                const ownedAgenciesAgentsQuery = `
                    SELECT 
                        a.AgentId,
                        a.AgencyId,
                        a.BusinessName,
                        a.CommissionRole,
                        a.CommissionTierLevel,
                        a.NPN,
                        a.Status,
                        a.CreatedDate,
                        u.FirstName,
                        u.LastName,
                        u.Email,
                        u.PhoneNumber,
                        u.Status as UserStatus,
                        ag.AgencyName,
                        -- Statistics
                        (SELECT COUNT(*) FROM oe.Members m WHERE m.AgentId = a.AgentId AND m.Status = 'Active') as TotalMembers,
                        (SELECT COUNT(*) FROM oe.Groups g WHERE g.AgentId = a.AgentId AND g.Status = 'Active') as TotalGroups,
                        (SELECT COUNT(DISTINCT e.EnrollmentId) 
                         FROM oe.Enrollments e 
                         JOIN oe.Members m ON e.MemberId = m.MemberId 
                         WHERE m.AgentId = a.AgentId AND e.Status = 'Active') as ActiveEnrollments
                    FROM oe.Agents a
                    JOIN oe.Users u ON a.UserId = u.UserId
                    LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
                    WHERE a.AgencyId IN (SELECT AgencyId FROM (VALUES ${valuesClause}) AS AgencyIds(AgencyId))
                        AND a.Status IN ('Active', 'Pending')
                        AND u.Status IN ('Active', 'Pending')
                    ORDER BY ag.AgencyName, u.FirstName, u.LastName
                `;

                const agentsRequest = pool.request();
                ownedAgencyIds.forEach((agencyId, i) => {
                    agentsRequest.input(`agencyId${i}`, sql.UniqueIdentifier, agencyId);
                });
                const agentsResult = await agentsRequest.query(ownedAgenciesAgentsQuery);

                logger.info(`[AGENT-AGENCY-AGENTS] << Found ${agentsResult.recordset.length} agents in owned agencies`);

                const ownedAdminMap = await agencyAdmins.getAdminAgentIdsByAgencyMap(pool, ownedAgencyIds);

                let agencyMrrMap = new Map();
                try {
                    agencyMrrMap = await getMonthlyRecurringRevenueByAgencyMap(pool, req.user.TenantId);
                } catch (_mrr) {
                    /* optional */
                }
                
                // Return agencies and agents (similar to TenantAdmin format)
                const agenciesData = ownerAgenciesResult.recordset.map(agency => {
                    const aid = String(agency.AgencyId).toLowerCase().replace(/[{}]/g, '');
                    return {
                        AgencyId: agency.AgencyId,
                        AgencyName: agency.AgencyName,
                        Status: agency.Status,
                        CreatedDate: agency.CreatedDate,
                        IsPrimary: agency.IsPrimary,
                        CommissionTierLevel: agency.CommissionTierLevel,
                        Email: agency.Email,
                        Phone: agency.Phone,
                        CommissionGroupId: agency.CommissionGroupId || null,
                        CommissionGroupName: agency.CommissionGroupName || null,
                        AgencyAdminAgentIds: ownedAdminMap.get(aid) || [],
                        TotalMrr: agencyMrrMap.get(normalizeAgencyKey(agency.AgencyId)) ?? 0
                    };
                });

                res.json({
                    success: true,
                    data: [
                        ...agenciesData.map(agency => ({
                            AgentId: agency.AgencyId,
                            AgencyId: agency.AgencyId,
                            FirstName: agency.AgencyName,
                            LastName: '',
                            Email: agency.Email || '',
                            PhoneNumber: agency.Phone || '',
                            BusinessName: agency.AgencyName,
                            CommissionRole: null,
                            CommissionTierLevel: agency.CommissionTierLevel,
                            CommissionGroupId: agency.CommissionGroupId || null,
                            CommissionGroupName: agency.CommissionGroupName || null,
                            AgencyAdminAgentIds: agency.AgencyAdminAgentIds,
                            NPN: null,
                            Status: agency.Status,
                            CreatedDate: agency.CreatedDate,
                            UserStatus: agency.Status,
                            TotalMembers: 0,
                            TotalGroups: 0,
                            ActiveEnrollments: 0,
                            TotalMrr: agency.TotalMrr ?? 0,
                            Type: 'Agency'
                        })),
                        ...agentsResult.recordset.map(agent => ({
                            ...agent,
                            Type: 'Agent'
                        }))
                    ],
                    agencies: agenciesData,
                    currentAgentId: currentAgentId,
                    isOwnerView: true
                });
        } else {
            // Not an owner - return agency, current user's agent, and downline only (no other agency agents)
            logger.info(`[AGENT-AGENCY-AGENTS] >> Agent is not an owner, returning agency + self + downline only`);
            
            // Get agency info (include CommissionGroupId/Name for commission group label)
            const agencyQuery = `
                SELECT a.AgencyId, a.AgencyName, a.Status, a.CreatedDate, a.IsPrimary, a.CommissionTierLevel,
                       a.CommissionGroupId, cg.Name as CommissionGroupName
                FROM oe.Agencies a
                LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
                WHERE a.AgencyId = @agencyId
            `;

            const agencyResult = await pool.request()
                .input('agencyId', sql.UniqueIdentifier, agencyId)
                .query(agencyQuery);

            let agencyPayload = agencyResult.recordset[0] || null;
            if (agencyPayload) {
                const amap = await agencyAdmins.getAdminAgentIdsByAgencyMap(pool, [agencyId]);
                const aid = String(agencyId).toLowerCase().replace(/[{}]/g, '');
                agencyPayload = {
                    ...agencyPayload,
                    AgencyAdminAgentIds: amap.get(aid) || []
                };
            }

            // Current user's full agent row
            const selfQuery = `
                SELECT 
                    a.AgentId,
                    a.AgencyId,
                    a.BusinessName,
                    a.CommissionRole,
                    a.CommissionTierLevel,
                    a.NPN,
                    a.Status,
                    a.CreatedDate,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber,
                    u.Status as UserStatus,
                    ah.HierarchyId,
                    ah.ParentId,
                    ah.Status as HierarchyStatus,
                    (SELECT COUNT(*) FROM oe.Members m WHERE m.AgentId = a.AgentId AND m.Status = 'Active') as TotalMembers,
                    (SELECT COUNT(*) FROM oe.Groups g WHERE g.AgentId = a.AgentId AND g.Status = 'Active') as TotalGroups,
                    (SELECT COUNT(DISTINCT e.EnrollmentId) 
                     FROM oe.Enrollments e 
                     JOIN oe.Members m ON e.MemberId = m.MemberId 
                     WHERE m.AgentId = a.AgentId AND e.Status = 'Active') as ActiveEnrollments
                FROM oe.Agents a
                JOIN oe.Users u ON a.UserId = u.UserId
                LEFT JOIN oe.AgentHierarchy ah ON a.AgentId = ah.AgentId AND ah.Status = 'Active'
                WHERE a.AgentId = @currentAgentId AND a.Status IN ('Active', 'Pending') AND u.Status IN ('Active', 'Pending')
            `;
            const selfResult = await pool.request()
                .input('currentAgentId', sql.UniqueIdentifier, currentAgentId)
                .query(selfQuery);

            // Downline (recursive CTE: no aggregates allowed in recursive member; add stats in outer query)
            const downlineQuery = `
                WITH AgentTree AS (
                    SELECT ah.AgentId, 1 as Level
                    FROM oe.AgentHierarchy ah
                    JOIN oe.Agents a ON ah.AgentId = a.AgentId
                    WHERE ah.ParentId = @currentAgentId AND ah.Status = 'Active' AND a.Status IN ('Active', 'Pending')
                    UNION ALL
                    SELECT ah.AgentId, at.Level + 1
                    FROM oe.AgentHierarchy ah
                    JOIN oe.Agents a ON ah.AgentId = a.AgentId
                    JOIN AgentTree at ON ah.ParentId = at.AgentId
                    WHERE ah.Status = 'Active' AND a.Status IN ('Active', 'Pending') AND at.Level < 10
                )
                SELECT 
                    a.AgentId,
                    a.AgencyId,
                    a.BusinessName,
                    a.CommissionRole,
                    a.CommissionTierLevel,
                    a.NPN,
                    a.Status,
                    a.CreatedDate,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber,
                    u.Status as UserStatus,
                    ah.HierarchyId,
                    ah.ParentId,
                    ah.Status as HierarchyStatus,
                    (SELECT COUNT(*) FROM oe.Members m WHERE m.AgentId = a.AgentId AND m.Status = 'Active') as TotalMembers,
                    (SELECT COUNT(*) FROM oe.Groups g WHERE g.AgentId = a.AgentId AND g.Status = 'Active') as TotalGroups,
                    (SELECT COUNT(DISTINCT e.EnrollmentId) 
                     FROM oe.Enrollments e 
                     JOIN oe.Members m ON e.MemberId = m.MemberId 
                     WHERE m.AgentId = a.AgentId AND e.Status = 'Active') as ActiveEnrollments
                FROM AgentTree at
                JOIN oe.Agents a ON at.AgentId = a.AgentId
                JOIN oe.Users u ON a.UserId = u.UserId
                LEFT JOIN oe.AgentHierarchy ah ON a.AgentId = ah.AgentId AND ah.Status = 'Active'
                WHERE a.Status IN ('Active', 'Pending') AND u.Status IN ('Active', 'Pending')
                ORDER BY at.Level, u.FirstName, u.LastName
            `;
            const downlineResult = await pool.request()
                .input('currentAgentId', sql.UniqueIdentifier, currentAgentId)
                .query(downlineQuery);

            const selfRow = selfResult.recordset[0] || null;
            const downlineRows = downlineResult.recordset || [];
            const data = selfRow ? [selfRow, ...downlineRows] : downlineRows;

            logger.info(`[AGENT-AGENCY-AGENTS] << Returning self + ${downlineRows.length} downline agents`);
            
            res.json({
                success: true,
                data,
                agency: agencyPayload,
                currentAgentId: currentAgentId,
                isDownlineView: true
            });
        }

    } catch (error) {
        logger.error('[AGENT-AGENCY-AGENTS] !! Error fetching agency agents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch agency agents',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/agent/agents/stats
 * @desc    Get statistics about agents in the agent's agency
 * @access  Private (Agent only)
 */
router.get('/stats', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-AGENCY-STATS] >> Fetching agency statistics for agent');
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-AGENCY-STATS] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgencyId
        const agentQuery = `
            SELECT AgentId, AgencyId 
            FROM oe.Agents 
            WHERE UserId = @userId AND Status = 'Active'
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const { AgentId: currentAgentId } = agentResult.recordset[0];

        // Get comprehensive downline-only statistics (not agency-wide)
        const statsQuery = `
            WITH AgentDownline AS (
                -- Direct downline
                SELECT a.AgentId
                FROM oe.AgentHierarchy ah
                JOIN oe.Agents a ON ah.AgentId = a.AgentId
                WHERE ah.ParentId = @agentId
                    AND ah.Status = 'Active'
                    AND a.Status IN ('Active', 'Pending')
                
                UNION ALL
                
                -- Recursive downline
                SELECT a.AgentId
                FROM oe.AgentHierarchy ah
                JOIN oe.Agents a ON ah.AgentId = a.AgentId
                JOIN AgentDownline ad ON ah.ParentId = ad.AgentId
                WHERE ah.Status = 'Active'
                    AND a.Status IN ('Active', 'Pending')
            )
            SELECT 
                COUNT(DISTINCT ad.AgentId) as TotalAgents,
                COUNT(DISTINCT ad.AgentId) as ActiveAgents,
                -- Total members across downline agents
                ISNULL((SELECT COUNT(*) FROM oe.Members m 
                        JOIN AgentDownline ad2 ON m.AgentId = ad2.AgentId
                        WHERE m.Status = 'Active'), 0) as TotalMembers,
                -- Total groups across downline agents
                ISNULL((SELECT COUNT(*) FROM oe.Groups g 
                        JOIN AgentDownline ad2 ON g.AgentId = ad2.AgentId
                        WHERE g.Status = 'Active'), 0) as TotalGroups,
                -- Total active enrollments across downline agents
                ISNULL((SELECT COUNT(DISTINCT e.EnrollmentId)
                        FROM oe.Enrollments e
                        JOIN oe.Members m ON e.MemberId = m.MemberId
                        JOIN AgentDownline ad2 ON m.AgentId = ad2.AgentId
                        WHERE e.Status = 'Active'), 0) as TotalEnrollments
            FROM AgentDownline ad
        `;

        const result = await pool.request()
            .input('agentId', sql.UniqueIdentifier, currentAgentId)
            .query(statsQuery);

        logger.info('[AGENT-AGENCY-STATS] << Retrieved agency statistics');
        
        res.json({
            success: true,
            data: result.recordset[0]
        });

    } catch (error) {
        logger.error('[AGENT-AGENCY-STATS] !! Error fetching agency statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch agency statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/agent/agents/hierarchy
 * @desc    Get hierarchy tree of agent's downline
 * @access  Private (Agent only)
 */
router.get('/hierarchy', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-HIERARCHY] >> Fetching agent downline hierarchy');
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-HIERARCHY] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId and AgencyId
        const agentQuery = `
            SELECT AgentId, AgencyId 
            FROM oe.Agents 
            WHERE UserId = @userId AND Status = 'Active'
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const { AgentId: currentAgentId, AgencyId: agencyId } = agentResult.recordset[0];

        const ownerAgenciesResult = await agencyAdmins.getAdministeredAgenciesForAgent(pool, currentAgentId);

        const ownedAgencyIds = ownerAgenciesResult.recordset.map(a => a.AgencyId);
        if (ownedAgencyIds.length > 0) {
            // Agency admin (oe.AgencyAdmins): only administered agencies — never full tenant
            logger.info(`[AGENT-HIERARCHY] >> Agent administers ${ownedAgencyIds.length} agency/agencies, returning owned agencies hierarchy`);
            
            // Get owned agencies
            const ownedAgenciesQuery = `
                SELECT AgencyId, AgencyName, Status, IsPrimary, ContactEmail as Email, ContactPhone as Phone
                FROM oe.Agencies
                WHERE AgencyId IN (SELECT AgencyId FROM (VALUES ${ownedAgencyIds.map((_, i) => `(@agencyId${i})`).join(', ')}) AS AgencyIds(AgencyId))
                    AND Status = 'Active'
                ORDER BY AgencyName
            `;
            
            const agenciesRequest = pool.request();
            ownedAgencyIds.forEach((agencyId, i) => {
                agenciesRequest.input(`agencyId${i}`, sql.UniqueIdentifier, agencyId);
            });
            const agenciesResult = await agenciesRequest.query(ownedAgenciesQuery);
            
            // Calculate TotalAgentCount for each owned agency
            const tenantId = req.user.TenantId;
            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'Tenant context required' });
            }

            const countMap = await batchTotalAgentCountsByAgency(pool, tenantId);
            const agenciesWithCounts = agenciesResult.recordset.map((agency) => ({
                ...agency,
                TotalAgentCount: countMap.get(normalizeAgencyKey(agency.AgencyId)) ?? 0
            }));

            let agencyMrrMap = new Map();
            try {
                agencyMrrMap = await getMonthlyRecurringRevenueByAgencyMap(pool, tenantId);
            } catch (_mrr) {
                /* optional */
            }
            
            // Get all agents in owned agencies
            const valuesClause = ownedAgencyIds.map((_, i) => `(@agencyId${i})`).join(', ');
            const agentsRequest = pool.request();
            ownedAgencyIds.forEach((agencyId, i) => {
                agentsRequest.input(`agencyId${i}`, sql.UniqueIdentifier, agencyId);
            });
            const agentsResult = await agentsRequest.query(`
                SELECT
                    a.AgentId,
                    a.AgencyId,
                    a.BusinessName,
                    a.CommissionRole,
                    a.NPN,
                    a.CommissionTierLevel,
                    a.CommissionLevelId,
                    cl.DisplayName as CommissionLevelName,
                    a.CommissionGroupId,
                    cg.Name as CommissionGroupName,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber,
                    ah.HierarchyId,
                    ah.ParentId,
                    ah.Status as HierarchyStatus
                FROM oe.Agents a
                JOIN oe.Users u ON a.UserId = u.UserId
                LEFT JOIN oe.AgentHierarchy ah ON a.AgentId = ah.AgentId AND ah.Status = 'Active'
                LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
                LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
                WHERE a.AgencyId IN (SELECT AgencyId FROM (VALUES ${valuesClause}) AS AgencyIds(AgencyId))
                    AND a.Status IN ('Active', 'Pending')
                    AND u.Status IN ('Active', 'Pending')
                ORDER BY u.FirstName, u.LastName
            `);

            const ownedAdminMapForTree = await agencyAdmins.getAdminAgentIdsByAgencyMap(pool, ownedAgencyIds);

            // Shared tree builder — same shape TenantAdmin renders, so the Agent
            // view uses the identical nested-tree UI component with no divergence.
            const agencyRowsForBuilder = agenciesWithCounts.map((agency) => {
                const aid = String(agency.AgencyId).toLowerCase().replace(/[{}]/g, '');
                const adminList = ownedAdminMapForTree.get(aid) || [];
                return {
                    AgencyId: agency.AgencyId,
                    AgencyName: agency.AgencyName,
                    Status: agency.Status,
                    Email: agency.Email,
                    Phone: agency.Phone,
                    TotalAgentCount: agency.TotalAgentCount || 0,
                    OwnerAgentId: adminList[0] || null,
                    AgencyAdminAgentIds: adminList,
                    CommissionGroupId: agency.CommissionGroupId || null,
                    CommissionGroupName: agency.CommissionGroupName || null,
                    IsPrimary: agency.IsPrimary ?? false
                };
            });

            const mrrByAgencyKey = new Map();
            agenciesWithCounts.forEach((agency) => {
                const key = normalizeAgencyKey(agency.AgencyId);
                const mrr = agencyMrrMap.get(key);
                if (mrr != null) mrrByAgencyKey.set(key, mrr);
            });

            const agencies = buildAgenciesWithAgents(
                agencyRowsForBuilder,
                agentsResult.recordset,
                mrrByAgencyKey
            );

            logger.info(
                `[AGENT-HIERARCHY] << Retrieved owned agencies hierarchy with ${agencies.length} agencies and ${agentsResult.recordset.length} agents`
            );

            res.json({
                success: true,
                data: { agencies }
            });
        } else {
            // Not an owner - return downline hierarchy (existing behavior)
            // Optional query: search (filter to matching agents + ancestors), limit (cap size for performance)
            const searchParam = (req.query.search && String(req.query.search).trim()) || '';
            const limitParam = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);

            logger.info(`[AGENT-HIERARCHY] >> Agent is not an owner, returning downline hierarchy (search=${!!searchParam}, limit=${limitParam})`);

            const agencyQuery = `
                SELECT a.AgencyId, a.AgencyName, a.Status,
                       a.CommissionGroupId, cg.Name as CommissionGroupName
                FROM oe.Agencies a
                LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
                WHERE a.AgencyId = @agencyId
            `;

            const agencyResult = await pool.request()
                .input('agencyId', sql.UniqueIdentifier, agencyId)
                .query(agencyQuery);

            const agencyRow = agencyResult.recordset[0] || null;
            let agencyForHierarchy = null;
            if (agencyRow) {
                const amap = await agencyAdmins.getAdminAgentIdsByAgencyMap(pool, [agencyId]);
                const aid = String(agencyId).toLowerCase().replace(/[{}]/g, '');
                agencyForHierarchy = {
                    ...agencyRow,
                    AgencyAdminAgentIds: amap.get(aid) || [],
                    OwnerAgentId: (amap.get(aid) || [])[0] || null
                };
            }

            // Get all agents in downline hierarchy (recursive), with optional limit for performance
            const hierarchyQuery = `
                WITH AgentTree AS (
                    SELECT
                        a.AgentId,
                        a.AgencyId,
                        u.FirstName,
                        u.LastName,
                        u.Email,
                        a.CommissionRole,
                        a.CommissionTierLevel as CommissionTierLevel,
                        a.CommissionLevelId,
                        cl.DisplayName as CommissionLevelName,
                        a.NPN,
                        a.AgentCode,
                        a.CommissionGroupId,
                        cg.Name as CommissionGroupName,
                        ah.ParentId,
                        ah.Status as HierarchyStatus,
                        1 as Level
                    FROM oe.AgentHierarchy ah
                    JOIN oe.Agents a ON ah.AgentId = a.AgentId
                    JOIN oe.Users u ON a.UserId = u.UserId
                    LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
                    LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
                    WHERE ah.ParentId = @agentId
                        AND ah.Status = 'Active'
                        AND a.Status IN ('Active', 'Pending')
                    UNION ALL
                    SELECT
                        a.AgentId,
                        a.AgencyId,
                        u.FirstName,
                        u.LastName,
                        u.Email,
                        a.CommissionRole,
                        a.CommissionTierLevel as CommissionTierLevel,
                        a.CommissionLevelId,
                        cl.DisplayName as CommissionLevelName,
                        a.NPN,
                        a.AgentCode,
                        a.CommissionGroupId,
                        cg.Name as CommissionGroupName,
                        ah.ParentId,
                        ah.Status as HierarchyStatus,
                        at.Level + 1
                    FROM oe.AgentHierarchy ah
                    JOIN oe.Agents a ON ah.AgentId = a.AgentId
                    JOIN oe.Users u ON a.UserId = u.UserId
                    LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
                    LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
                    JOIN AgentTree at ON ah.ParentId = at.AgentId
                    WHERE ah.Status = 'Active'
                        AND a.Status IN ('Active', 'Pending')
                        AND at.Level < 10
                )
                SELECT TOP (@limit) * FROM AgentTree
                ORDER BY Level, FirstName, LastName
            `;

            const hierarchyResult = await pool.request()
                .input('agentId', sql.UniqueIdentifier, currentAgentId)
                .input('limit', sql.Int, limitParam)
                .query(hierarchyQuery);

            let hierarchyRows = hierarchyResult.recordset || [];

            // When search is provided: keep only agents matching search + their ancestors (so tree remains valid)
            if (searchParam) {
                const searchLower = searchParam.toLowerCase();
                const match = (r) => {
                    const name = [r.FirstName, r.LastName].filter(Boolean).join(' ').toLowerCase();
                    const email = (r.Email || '').toLowerCase();
                    const agentCode = (r.AgentCode || '').toLowerCase();
                    return name.includes(searchLower) || email.includes(searchLower) || agentCode.includes(searchLower);
                };
                const matchingIds = new Set(hierarchyRows.filter(match).map(r => r.AgentId));
                const collectAncestorIds = (agentIds) => {
                    const parentIds = hierarchyRows.filter(r => agentIds.has(r.AgentId)).map(r => r.ParentId).filter(Boolean);
                    if (parentIds.length === 0) return agentIds;
                    parentIds.forEach(id => agentIds.add(id));
                    return collectAncestorIds(agentIds);
                };
                const keepIds = collectAncestorIds(new Set(matchingIds));
                hierarchyRows = hierarchyRows.filter(r => keepIds.has(r.AgentId));
            }

            // Get current agent's name and tier level for tree root and commission UI
            const currentAgentResult = await pool.request()
                .input('currentAgentId', sql.UniqueIdentifier, currentAgentId)
                .query(`
                    SELECT a.AgentId, a.AgencyId, u.FirstName, u.LastName, u.Email,
                           a.CommissionRole, a.NPN, a.CommissionTierLevel as CommissionTierLevel,
                           a.CommissionLevelId, cl.DisplayName as CommissionLevelName,
                           a.CommissionGroupId, cg.Name as CommissionGroupName
                    FROM oe.Agents a
                    JOIN oe.Users u ON a.UserId = u.UserId
                    LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
                    LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
                    WHERE a.AgentId = @currentAgentId AND a.Status IN ('Active', 'Pending')
                `);
            const currentAgentRow = currentAgentResult.recordset[0];
            const currentAgent = currentAgentRow ? {
                AgentId: currentAgentRow.AgentId,
                FirstName: currentAgentRow.FirstName,
                LastName: currentAgentRow.LastName,
                CommissionTierLevel: currentAgentRow.CommissionTierLevel,
                CommissionLevelName: currentAgentRow.CommissionLevelName
            } : null;

            // Shared tree builder — same shape the TenantAdmin hierarchy uses,
            // so the Agent view renders through the identical frontend tree
            // component with no custom flattening/nesting on the client.
            const agenciesArray = buildDownlineAgencies(
                agencyForHierarchy,
                currentAgentRow || null,
                hierarchyRows
            );

            logger.info(
                `[AGENT-HIERARCHY] << Retrieved hierarchy with ${hierarchyRows.length} agents (pre-nested)`
            );

            res.json({
                success: true,
                data: {
                    agencies: agenciesArray,
                    // Legacy fields kept so older deployed frontends don't break.
                    agency: agencyForHierarchy,
                    hierarchy: hierarchyRows,
                    currentAgent
                }
            });
        }

    } catch (error) {
        logger.error('[AGENT-HIERARCHY] !! Error fetching hierarchy:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch hierarchy',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/agent/downline-agents
 * @desc    Get current agent + downline agents for filter dropdown (self + all downline)
 * @access  Private (Agent only)
 */
router.get('/downline-agents', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
    try {
        if (!req.user || !req.user.UserId) {
            return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
        }
        const pool = await getPool();
        const userRoles = getUserRoles(req.user) || [];
        const agencyPool = req.query.agencyPool === '1' || req.query.agencyPool === 'true';
        const meRow = await pool.request()
            .input('userId', sql.UniqueIdentifier, req.user.UserId)
            .query(`
                SELECT a.AgentId, a.AgencyId
                FROM oe.Agents a
                WHERE a.UserId = @userId AND a.Status = 'Active'
            `);
        const myAgentId = meRow.recordset[0]?.AgentId;
        const myAgencyId = meRow.recordset[0]?.AgencyId;
        const hasAgencyOwnerRole = userRoles.includes('AgencyOwner');
        const isAgencyOwner =
            hasAgencyOwnerRole ||
            (myAgentId && myAgencyId ? await agencyAdmins.isAgencyAdmin(pool, myAgencyId, myAgentId) : false);

        let result;
        if (isAgencyOwner && agencyPool) {
            if (!myAgencyId) {
                result = { recordset: [] };
            } else {
                const reqAg = pool.request();
                reqAg.input('agencyId', sql.UniqueIdentifier, myAgencyId);
                reqAg.input('userId', sql.UniqueIdentifier, req.user.UserId);
                result = await reqAg.query(`
                    SELECT a.AgentId, u.FirstName, u.LastName, u.Email,
                        COALESCE(cl.SortOrder, a.CommissionTierLevel, 0) AS CommissionTierLevel
                    FROM oe.Agents a
                    JOIN oe.Users u ON u.UserId = a.UserId
                    LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
                    WHERE a.AgencyId = @agencyId AND a.Status = 'Active'
                    ORDER BY CASE WHEN a.UserId = @userId THEN 0 ELSE 1 END, u.FirstName, u.LastName
                `);
            }
        } else {
            const request = pool.request();
            request.input('userId', sql.UniqueIdentifier, req.user.UserId);
            result = await request.query(`
            WITH Downline AS (
                SELECT a.AgentId FROM oe.Agents a WHERE a.UserId = @userId AND a.Status = 'Active'
                UNION ALL
                SELECT ah.AgentId FROM oe.AgentHierarchy ah
                INNER JOIN Downline d ON ah.ParentId = d.AgentId
                WHERE ah.Status = 'Active'
            )
            SELECT d.AgentId, u.FirstName, u.LastName, u.Email,
                COALESCE(cl.SortOrder, a.CommissionTierLevel, 0) AS CommissionTierLevel
            FROM Downline d
            JOIN oe.Agents a ON a.AgentId = d.AgentId AND a.Status = 'Active'
            JOIN oe.Users u ON u.UserId = a.UserId
            LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
            ORDER BY CASE WHEN d.AgentId = (SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = 'Active') THEN 0 ELSE 1 END, u.FirstName, u.LastName
        `);
        }

        const currentAgentIdResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, req.user.UserId)
            .query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = \'Active\'');
        const currentAgentId = currentAgentIdResult.recordset[0]?.AgentId || null;

        const agents = (result.recordset || []).map((row) => ({
            AgentId: row.AgentId,
            Name: [row.FirstName, row.LastName].filter(Boolean).join(' ').trim() || row.Email || 'Unknown',
            Email: row.Email || '',
            CommissionTierLevel: row.CommissionTierLevel != null ? Number(row.CommissionTierLevel) : 0
        }));

        return res.json({
            success: true,
            data: {
                currentAgentId,
                agents,
                /** True when viewer may use agency-wide filter (JWT AgencyOwner or oe.AgencyAdmins). */
                agencyWideFilterAvailable: !!isAgencyOwner
            }
        });
    } catch (error) {
        logger.error('[AGENT-DOWNLINE-AGENTS] Error fetching downline agents', { error: error.message });
        return res.status(500).json({ success: false, message: 'Failed to fetch downline agents' });
    }
});

/**
 * @route   GET /api/me/agent/agents/:id
 * @desc    Get details of a specific agent in the same agency
 * @access  Private (Agent only)
 */
router.get('/:id', authorize(['Agent']), async (req, res) => {
    logger.info(`[AGENT-AGENCY-DETAIL] >> Fetching agent details: ${req.params.id}`);
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-AGENCY-DETAIL] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const requestedAgentId = req.params.id;
        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get current agent's AgencyId
        const agentQuery = `
            SELECT AgentId, AgencyId 
            FROM oe.Agents 
            WHERE UserId = @userId AND Status = 'Active'
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const { AgentId: currentAgentId, AgencyId: currentAgencyId } = agentResult.recordset[0];

        // Get detailed agent information and verify same agency
        const detailQuery = `
            SELECT 
                a.AgentId,
                a.AgencyId,
                a.CommissionGroupId,
                a.BusinessName,
                a.CommissionRole,
                a.CommissionTierLevel,
                a.CommissionLevelId,
                a.CommissionGroupId,
                cg.Name as CommissionGroupName,
                a.NPN,
                a.Status,
                a.CreatedDate,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber,
                u.Status as UserStatus,
                ag.AgencyName,
                -- Statistics
                (SELECT COUNT(*) FROM oe.Members m WHERE m.AgentId = a.AgentId AND m.Status = 'Active') as TotalMembers,
                (SELECT COUNT(*) FROM oe.Groups g WHERE g.AgentId = a.AgentId AND g.Status = 'Active') as TotalGroups,
                (SELECT COUNT(DISTINCT e.EnrollmentId) 
                 FROM oe.Enrollments e 
                 JOIN oe.Members m ON e.MemberId = m.MemberId 
                 WHERE m.AgentId = a.AgentId AND e.Status = 'Active') as ActiveEnrollments,
                ${buildMonthlyRosterPremiumSubquery({
                  memberWhereClause: `m.AgentId = a.AgentId AND m.Status = 'Active'`,
                  joinsSql: '',
                })} as TotalMonthlyPremium
            FROM oe.Agents a
            JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
            LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
            WHERE a.AgentId = @requestedAgentId
                AND a.AgencyId = @currentAgencyId
                AND a.Status IN ('Active', 'Pending')
                AND u.Status IN ('Active', 'Pending')
        `;

        const result = await pool.request()
            .input('requestedAgentId', sql.UniqueIdentifier, requestedAgentId)
            .input('currentAgencyId', sql.UniqueIdentifier, currentAgencyId)
            .query(detailQuery);

        if (result.recordset.length === 0) {
            // Allow upline to view *limited* details for downline agents (not necessarily same agency)
            const isSelf = String(requestedAgentId).toLowerCase() === String(currentAgentId).toLowerCase();
            const isDownline = await isUplineAncestor(pool, requestedAgentId, currentAgentId);
            if (!isSelf && !isDownline) {
                return res.status(404).json({
                    success: false,
                    message: 'Agent not found or access denied'
                });
            }

            const downlineResult = await pool.request()
                .input('requestedAgentId', sql.UniqueIdentifier, requestedAgentId)
                .query(`
                    SELECT 
                        a.AgentId,
                        a.AgencyId,
                        a.CommissionGroupId,
                        a.CommissionRole,
                        a.CommissionTierLevel,
                        a.CommissionLevelId,
                        a.CommissionGroupId,
                        cg.Name as CommissionGroupName,
                        a.NPN,
                        a.Status,
                        u.FirstName,
                        u.LastName,
                        u.Email,
                        u.PhoneNumber,
                        u.Status as UserStatus,
                        ag.AgencyName
                    FROM oe.Agents a
                    JOIN oe.Users u ON a.UserId = u.UserId
                    LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
                    LEFT JOIN oe.CommissionGroups cg ON a.CommissionGroupId = cg.CommissionGroupId
                    WHERE a.AgentId = @requestedAgentId
                      AND a.Status IN ('Active', 'Pending')
                      AND u.Status IN ('Active', 'Pending')
                `);

            if (downlineResult.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Agent not found'
                });
            }

            const downlineAgent = downlineResult.recordset[0];
            const editContext = await getLimitedEditContext(
                pool,
                currentAgentId,
                requestedAgentId,
                downlineAgent.AgencyId
            );

            return res.json({
                success: true,
                data: {
                    ...downlineAgent,
                    editableFields: editContext.editableFields,
                    editableScopes: editContext.scopes
                }
            });
        }

        logger.info(`[AGENT-AGENCY-DETAIL] << Retrieved agent details`);

        const agentData = result.recordset[0];
        const editContext = await getLimitedEditContext(
            pool,
            currentAgentId,
            requestedAgentId,
            agentData.AgencyId
        );

        res.json({
            success: true,
            data: {
                ...agentData,
                editableFields: editContext.editableFields,
                editableScopes: editContext.scopes
            }
        });

    } catch (error) {
        logger.error('[AGENT-AGENCY-DETAIL] !! Error fetching agent details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch agent details',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   PUT /api/me/agent/agents/:agentId
 * @desc    Limited-edit endpoint for agency admins / upline ancestors.
 *          Sensitive fields (CommissionGroupId, AgencyId, UplineAgentId)
 *          are TenantAdmin-only — silently dropped here. Tier change must
 *          map to a CommissionLevels.SortOrder strictly less than the
 *          editor's own SortOrder.
 * @access  Agent (gated further by relationship to target)
 */
router.put('/:agentId', authorize(['Agent']), async (req, res) => {
    const { agentId: targetAgentId } = req.params;
    const body = req.body || {};

    try {
        const pool = await getPool();
        const callerUserId = req.user?.UserId;
        if (!callerUserId) {
            return res.status(401).json({ success: false, message: 'Authentication error.' });
        }

        // Resolve caller's AgentId + own SortOrder, target's AgencyId + SortOrder.
        const callerRes = await pool.request()
            .input('UserId', sql.UniqueIdentifier, callerUserId)
            .query(`
                SELECT TOP 1 a.AgentId, cl.SortOrder AS EditorSortOrder
                FROM oe.Agents a
                LEFT JOIN oe.CommissionLevels cl
                    ON cl.CommissionLevelId = a.CommissionLevelId AND cl.IsActive = 1
                WHERE a.UserId = @UserId
            `);
        const callerRow = callerRes.recordset[0];
        if (!callerRow?.AgentId) {
            return res.status(404).json({ success: false, message: 'Agent profile not found.' });
        }
        const callerAgentId = callerRow.AgentId;
        const editorSortOrder = callerRow.EditorSortOrder;

        const tx = new sql.Transaction(pool);
        await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
        try {
            const txReq = new sql.Request(tx);
            const targetRes = await txReq
                .input('targetAgentId', sql.UniqueIdentifier, targetAgentId)
                .query(`
                    SELECT a.AgencyId, a.CommissionLevelId, cl.SortOrder AS TargetSortOrder
                    FROM oe.Agents a WITH (UPDLOCK)
                    LEFT JOIN oe.CommissionLevels cl
                        ON cl.CommissionLevelId = a.CommissionLevelId AND cl.IsActive = 1
                    WHERE a.AgentId = @targetAgentId
                `);
            if (targetRes.recordset.length === 0) {
                await tx.rollback();
                return res.status(404).json({ success: false, message: 'Target agent not found.' });
            }
            const target = targetRes.recordset[0];
            const targetAgencyId = target.AgencyId;

            // Resolve cumulative edit permissions (upline + agency admin union).
            const editContext = await getLimitedEditContext(
                pool,
                callerAgentId,
                targetAgentId,
                targetAgencyId
            );
            const { scopes, allowedUserFields, allowedAgentFields } = editContext;
            if (scopes.length === 0) {
                await tx.rollback();
                return res.status(403).json({ success: false, message: 'Not authorized to edit this agent.' });
            }
            // Sensitive fields explicitly never allowed here — TenantAdmin uses
            // the existing tenant-admin route, not this one.

            // Tier-change validation.
            if ('commissionLevelId' in body && allowedAgentFields.has('commissionLevelId')) {
                const requestedLevelId = body.commissionLevelId
                    ? String(body.commissionLevelId).trim()
                    : null;
                if (!requestedLevelId) {
                    await tx.rollback();
                    return res.status(400).json({ success: false, message: 'commissionLevelId is required.' });
                }
                const levelRes = await new sql.Request(tx)
                    .input('CommissionLevelId', sql.UniqueIdentifier, requestedLevelId)
                    .query(`
                        SELECT cl.SortOrder, cl.TenantId
                        FROM oe.CommissionLevels cl
                        WHERE cl.CommissionLevelId = @CommissionLevelId AND cl.IsActive = 1
                    `);
                if (levelRes.recordset.length === 0) {
                    await tx.rollback();
                    return res.status(400).json({ success: false, message: 'Unknown commissionLevelId.' });
                }
                const requestedSortOrder = levelRes.recordset[0].SortOrder;
                if (requestedSortOrder === null) {
                    await tx.rollback();
                    return res.status(400).json({ success: false, message: 'Target tier has no SortOrder.' });
                }
                if (editorSortOrder === null || editorSortOrder === undefined) {
                    await tx.rollback();
                    return res.status(403).json({ success: false, message: 'Editor has no SortOrder; cannot assign tiers.' });
                }
                // Strict `<`. Blocks lateral peer assignment when tenants
                // (e.g. Kevo hybrid mode) have multiple DisplayNames at the
                // same SortOrder.
                if (Number(requestedSortOrder) >= Number(editorSortOrder)) {
                    await tx.rollback();
                    return res.status(400).json({
                        success: false,
                        message: `Cannot assign a tier (SortOrder ${requestedSortOrder}) at or above your own (SortOrder ${editorSortOrder}).`
                    });
                }
            }

            // Build UPDATE for oe.Agents.
            const agentUpdates = [];
            const agentInputs = [];
            if (allowedAgentFields.has('commissionLevelId') && 'commissionLevelId' in body) {
                agentUpdates.push('CommissionLevelId = @newCommissionLevelId');
                agentInputs.push(['newCommissionLevelId', sql.UniqueIdentifier, body.commissionLevelId]);
                // Sync legacy CommissionTierLevel if SortOrder is integer-ish.
                // Frontend reads CommissionTierLevel for hierarchy/auto-create.
                agentUpdates.push(`CommissionTierLevel = (
                    SELECT TOP 1 CAST(SortOrder AS DECIMAL(9,4))
                    FROM oe.CommissionLevels
                    WHERE CommissionLevelId = @newCommissionLevelId
                )`);
            }
            if (allowedAgentFields.has('status') && 'status' in body) {
                agentUpdates.push('Status = @newStatus');
                agentInputs.push(['newStatus', sql.NVarChar(50), String(body.status)]);
            }

            // Build UPDATE for oe.Users.
            const userUpdates = [];
            const userInputs = [];
            for (const [k, sqlType, parser] of [
                ['firstName', sql.NVarChar(100), (v) => String(v)],
                ['lastName', sql.NVarChar(100), (v) => String(v)],
                ['email', sql.NVarChar(256), (v) => String(v)],
                ['phoneNumber', sql.NVarChar(50), (v) => (v == null ? null : String(v))]
            ]) {
                if (allowedUserFields.has(k) && k in body) {
                    const dbCol = k === 'firstName'
                        ? 'FirstName'
                        : k === 'lastName'
                            ? 'LastName'
                            : k === 'email'
                                ? 'Email'
                                : 'PhoneNumber';
                    userUpdates.push(`${dbCol} = @${k}`);
                    userInputs.push([k, sqlType, parser(body[k])]);
                }
            }

            if (agentUpdates.length === 0 && userUpdates.length === 0) {
                await tx.rollback();
                return res.status(400).json({
                    success: false,
                    message: buildNoEditableFieldsMessage(allowedUserFields, allowedAgentFields)
                });
            }

            if (agentUpdates.length > 0) {
                const r = new sql.Request(tx);
                r.input('targetAgentId', sql.UniqueIdentifier, targetAgentId);
                for (const [name, type, value] of agentInputs) {
                    r.input(name, type, value);
                }
                await r.query(`
                    UPDATE oe.Agents
                    SET ${agentUpdates.join(', ')}, ModifiedDate = GETDATE()
                    WHERE AgentId = @targetAgentId
                `);
            }

            if (userUpdates.length > 0) {
                const r = new sql.Request(tx);
                r.input('targetAgentId', sql.UniqueIdentifier, targetAgentId);
                for (const [name, type, value] of userInputs) {
                    r.input(name, type, value);
                }
                await r.query(`
                    UPDATE u SET ${userUpdates.join(', ')}, u.ModifiedDate = GETDATE()
                    FROM oe.Users u
                    INNER JOIN oe.Agents a ON a.UserId = u.UserId
                    WHERE a.AgentId = @targetAgentId
                `);
            }

            await tx.commit();
            logger.info(`[AGENT-AGENTS] limited edit: callerAgent=${callerAgentId} target=${targetAgentId} scopes=${scopes.join(',')}`);
            return res.json({ success: true, message: 'Agent updated.' });
        } catch (e) {
            try { await tx.rollback(); } catch (_) { /* swallow */ }
            throw e;
        }
    } catch (error) {
        logger.error('[AGENT-AGENTS] !! Limited-edit failed:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update agent',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;

