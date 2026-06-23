// File: backend/routes/groups.js
// Updated Groups Router with Document Management
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getPool, sql } = require('../config/database');
const { authorize: authMiddleware, requireTenantAccess , getUserRoles } = require('../middleware/auth');
const { authenticateUrls } = require('./uploads');
const { EnrollmentLinkService } = require('../services/shared');
const { DEFAULT_LINK_EXPIRATION_HOURS } = require('../constants/linkExpiration');
const PaymentMethodService = require('../services/PaymentMethodService');
const aiCensusParser = require('../services/aiCensusParser.service');
const logger = require('../config/logger');
const DimeService = require('../services/dimeService');
const { getAccessibleAgentIdsForUser, buildAgentScopeClause } = require('../utils/agentGroupAccess');
const { isValidEarliestEffectiveDate } = require('./_groups-validation');
const householdMemberIdService = require('../services/householdMemberIdService');
const {
    swapHouseholdMemberIdPrefix,
    computePrefixSwapForGroupChange
} = require('../utils/householdMemberIdPrefix');
const groupMasterIdService = require('../services/groupMasterIdService');
const groupAccessService = require('../services/groupAccessService');
const { GROUP_MIGRATION_STATUS_SELECT_SQL } = require('../utils/groupMigrationStatusSql');

// Optional imports - don't fail if files don't exist
let groupContributionsRouter;
try {
    groupContributionsRouter = require('./groupContributions');
} catch (e) {
    console.log('⚠️ groupContributions router not found - skipping');
}

let groupProductsRouter;
try {
    groupProductsRouter = require('./groupProducts');
} catch (e) {
    console.log('⚠️ groupProducts router not found - skipping');
}

// Audit logging function
const auditLog = async (userId, action, description, details = {}) => {
    try {
        const pool = await getPool();
        await pool.request()
            .input('UserId', sql.UniqueIdentifier, userId)
            .input('Action', sql.NVarChar, action)
            .input('Description', sql.NVarChar, description)
            .input('Details', sql.NVarChar, JSON.stringify(details))
            .input('CreatedDate', sql.DateTime2, new Date())
            .query(`
                INSERT INTO oe.AuditLogs (UserId, Action, Description, Details, CreatedDate)
                VALUES (@UserId, @Action, @Description, @Details, @CreatedDate)
            `);
    } catch (error) {
        console.error('❌ Audit logging failed:', error);
    }
};

/**
 * @route   GET /api/groups/:groupId/agent
 * @desc    Get the assigned agent's details for a specific group
 * @access  Private
 */
router.get('/:groupId/agent', authMiddleware(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    const { groupId } = req.params;
    logger.info(`[GROUPS-ROUTE] Request to get agent for group ID: ${groupId}`);

    try {
        const pool = await getPool();
        // Safely queries the agent assigned to the group, joining Agents, Groups, and Members tables.
        const result = await pool.request()
            .input('GroupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT 
                    a.AgentId,
                    a.UserId,
                    a.TenantId,
                    a.Status,
                    u.FirstName,
                    u.LastName
                FROM oe.Agents a
                JOIN oe.Groups g ON a.AgentId = g.AgentId
                JOIN oe.Users u ON a.UserId = u.UserId
                WHERE g.GroupId = @GroupId
            `);

        if (result.recordset.length === 0) {
            logger.warn(`[GROUPS-ROUTE] No agent found for group ID: ${groupId}`);
            return res.status(404).json({ success: false, message: 'No agent found for this group.' });
        }
        
        logger.info(`[GROUPS-ROUTE] Successfully fetched agent for group ID: ${groupId}`);
        res.json({ success: true, data: result.recordset[0] });
    } catch (error) {
        logger.error(`[GROUPS-ROUTE] Error fetching agent for group ${groupId}: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error while fetching group agent.' });
    }
});

// Mount sub-routes if they exist
if (groupContributionsRouter) {
    router.use('/', groupContributionsRouter);
}

if (groupProductsRouter) {
    router.use('/', groupProductsRouter);
}

// Mount group members routes
let groupMembersRoutes;
try {
    groupMembersRoutes = require('./groupMembers');
    console.log('✅ Group Members routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Members routes not found:', e.message);
}

if (groupMembersRoutes) {
    router.use('/', groupMembersRoutes);
}


// Mount group locations routes
let groupLocationsRoutes;
try {
    groupLocationsRoutes = require('./groupLocations');
    console.log('✅ Group Locations routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Locations routes not found:', e.message);
}

if (groupLocationsRoutes) {
    router.use('/', groupLocationsRoutes);
}

// Document management routes have been moved to groupFiles.js
// See groupFiles.js for all document-related endpoints

// Group-scoped user management (GroupAdmin users for a specific group)
router.use('/:groupId/user-management', require('./group-user-management'));

// =============================================================================
// EXISTING GROUP ROUTES (keeping the original functionality)
// =============================================================================

// GET Groups - Enhanced with all new fields
router.get('/', async (req, res) => {
    try {
        // Debug: Verify middleware has run
        if (!req.user) {
            console.error('❌ [GROUPS] req.user is missing - authentication middleware may not have run');
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        if (!req.tenantId && !req.user?.TenantId) {
            console.error('❌ [GROUPS] Both req.tenantId and req.user.TenantId are missing - requireTenantAccess middleware may not have run');
            return res.status(500).json({
                success: false,
                message: 'Tenant context not available'
            });
        }
        
        const pool = await getPool();
        
        let query = `
            SELECT
                g.GroupId,
                g.Name,
                g.Status,
                g.GroupType,
                g.PrimaryContact,
                g.ContactEmail,
                g.ContactPhone,
                g.Address,
                g.Address2,
                g.City,
                g.State, 
                g.Zip,
                g.ContactTitle,
                g.ContactPhone2,
                g.FaxNumber,
                g.Website,
                g.TaxIdNumber,
                g.BusinessType,
                g.CreditCardNumber,
                g.CreditCardType,
                g.CreditCardExpiry,
                g.CreditCardName,
                g.ACHBankName,
                g.ACHAccountType,
                g.ACHRoutingNumber,
                g.ACHAccountNumber,
                g.ACHAccountName,
                g.LogoUrl,
                g.DocumentsFolder,
                g.CreatedDate, 
                g.AgentId,
                t.Name as TenantName, 
                t.TenantId,
                -- Simple counts without complex joins
                0 as TotalMembers,
                0 as ActiveEnrollments,
                0 as MonthlyPremium,
                -- Enrollment effective date info (earliest active, earliest future) – Product enrollments only (when benefits start)
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND e.Status = 'Active' AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) >= CAST(GETUTCDATE() AS DATE)) as EarliestFutureEffectiveDate,
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND e.Status = 'Active' AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) < CAST(GETUTCDATE() AS DATE)) as EarliestActiveEffectiveDate,
                (SELECT COUNT(DISTINCT CAST(e.EffectiveDate AS DATE)) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND e.Status = 'Active' AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) > CAST(GETUTCDATE() AS DATE)) as FutureEffectiveDateCount,
                -- Agent information
                CASE
                    WHEN a.AgentId IS NOT NULL THEN CONCAT(agent_user.FirstName, ' ', agent_user.LastName)
                    ELSE NULL
                END as AgentName,
                a.AgentCode,
                -- Onboarding status
                CASE 
                    WHEN gol.LinkId IS NOT NULL AND gol.Status = 'Active' AND gol.ExpiresAt > GETUTCDATE() THEN 'Pending Onboarding'
                    WHEN gol.LinkId IS NOT NULL AND gol.UsedDate IS NOT NULL THEN 'Onboarding Complete'
                    WHEN gol.LinkId IS NOT NULL AND gol.Status = 'Expired' THEN 'Onboarding Expired'
                    ELSE 'No Onboarding Link'
                END as OnboardingStatus,
                gol.CreatedDate as OnboardingLinkCreated,
                gol.ExpiresAt as OnboardingLinkExpires,
                gol.UsedDate as OnboardingCompleted,
                ${GROUP_MIGRATION_STATUS_SELECT_SQL}
            FROM oe.Groups g
            JOIN oe.Tenants t ON g.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
            LEFT JOIN oe.Users agent_user ON a.UserId = agent_user.UserId
            LEFT JOIN (
                SELECT 
                    GroupId,
                    LinkId,
                    Status,
                    ExpiresAt,
                    CreatedDate,
                    UsedDate,
                    ROW_NUMBER() OVER (PARTITION BY GroupId ORDER BY CreatedDate DESC) as rn
                FROM oe.GroupOnboardingLinks
            ) gol ON g.GroupId = gol.GroupId AND gol.rn = 1
            WHERE g.Status = 'Active'
        `;
        
        const request = pool.request();
        
        // Support tenantId query parameter for SysAdmin
        const requestedTenantId = req.query.tenantId;
        // Support agentId query parameter (for commission simulator to get groups for selected agent)
        const requestedAgentId = req.query.agentId;

        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');

        // Use req.tenantId (set by requireTenantAccess middleware) for consistency
        // This handles tenant switching - req.tenantId is the active tenant (may differ from user's primary tenant)
        const activeTenantId = req.tenantId || req.user?.TenantId;

        console.log('🔍 GET /api/groups - Query params:', { requestedTenantId, requestedAgentId, hasUser: !!req.user });
        console.log('🔍 [GROUPS] Fetching groups:', {
            isSysAdmin,
            requestedTenantId: requestedTenantId || 'none',
            requestedAgentId: requestedAgentId || 'none',
            activeTenantId: activeTenantId || 'MISSING',
            reqTenantId: req.tenantId || 'NOT SET',
            userTenantId: req.user?.TenantId || 'NOT SET',
            userRoles: userRoles.join(', '),
            userId: req.user?.UserId || 'NOT SET',
            tenantSwitching: req.tenantId !== req.user?.TenantId ? 'YES (switched)' : 'NO (primary)'
        });

        // Filter by agentId if provided (for commission simulator)
        // This should work regardless of user role
        if (requestedAgentId) {
            request.input('agentId', sql.UniqueIdentifier, requestedAgentId);
            query += ' AND g.AgentId = @agentId';
            console.log('🔍 Filtering groups by agentId:', requestedAgentId);
        }

        // Apply tenant filtering for non-SysAdmin users
        // Note: If agentId is provided, we still apply tenant filter if user is not SysAdmin
        // This ensures TenantAdmin users only see groups from their tenant
        if (!isSysAdmin) {
            if (!activeTenantId) {
                console.error('❌ [GROUPS] No tenantId available for non-SysAdmin user');
                return res.status(400).json({
                    success: false,
                    message: 'Tenant ID is required'
                });
            }

            request.input('tenantId', sql.UniqueIdentifier, activeTenantId);
            query += ' AND g.TenantId = @tenantId';

            // Only filter by Agent assignment if user is CURRENTLY acting as Agent
            // TenantAdmin should see ALL groups in their tenant, regardless of Agent assignments
            const currentRole = req.user?.currentRole || userRoles[0];
            console.log(`🔍 [GROUPS] Current role check: ${currentRole}, has Agent role: ${userRoles.includes('Agent')}`);

            // Only add Agent filter if user is currently acting as Agent (not TenantAdmin)
            // If agentId param is provided, do NOT additionally constrain by the current user's agent assignment
            if (currentRole === 'Agent' && !requestedAgentId) {
                request.input('userId', sql.UniqueIdentifier, req.user.UserId);
                query += ' AND a.UserId = @userId';
                console.log('🔍 [GROUPS] Filtering by Agent assignment (currentRole is Agent)');
            } else {
                console.log(`✅ [GROUPS] Showing all groups for tenant (currentRole: ${currentRole}${requestedAgentId ? ', filtered by requestedAgentId' : ''})`);
            }
        } else if (requestedTenantId) {
            // SysAdmin can filter by tenantId if provided
            request.input('tenantId', sql.UniqueIdentifier, requestedTenantId);
            query += ' AND g.TenantId = @tenantId';
        }

        query += ' ORDER BY g.Name';

        console.log('🔍 [GROUPS] Full SQL query:', query);
        console.log('🔍 [GROUPS] Query parameters being bound:', {
            tenantId: activeTenantId || requestedTenantId || 'none',
            userId: req.user?.UserId || 'none',
            requestedAgentId: requestedAgentId || 'none'
        });

        console.log('🔍 Executing groups query with filters');
        const result = await request.query(query);

        console.log(`✅ [GROUPS] Query executed. Found ${result.recordset.length} groups`);
        console.log(`✅ Returning ${result.recordset.length} groups (requestedAgentId: ${requestedAgentId || 'none'})`);

        if (result.recordset.length > 0) {
            console.log('📋 [GROUPS] First group sample:', {
                GroupId: result.recordset[0].GroupId,
                Name: result.recordset[0].Name,
                Status: result.recordset[0].Status,
                TenantId: result.recordset[0].TenantId
            });
        } else {
            console.warn('⚠️ [GROUPS] No groups found. Running debug query...');
            // Debug: Check if groups exist for this tenant (without the JOIN)
            if (activeTenantId || requestedTenantId) {
                const debugRequest = pool.request();
                debugRequest.input('tenantId', sql.UniqueIdentifier, activeTenantId || requestedTenantId);
                const debugQuery = await debugRequest.query(`
                    SELECT COUNT(*) as count 
                    FROM oe.Groups 
                    WHERE TenantId = @tenantId AND Status = 'Active'
                `);
                const count = debugQuery.recordset[0]?.count || 0;
                console.log(`🔍 [GROUPS] Debug: Found ${count} active groups for tenant ${activeTenantId || requestedTenantId} in DB`);

                // Also check what tenantId format is in the database
                const sampleRequest = pool.request();
                sampleRequest.input('tenantId', sql.UniqueIdentifier, activeTenantId || requestedTenantId);
                const sampleQuery = await sampleRequest.query(`
                    SELECT TOP 1 GroupId, Name, TenantId, Status
                    FROM oe.Groups 
                    WHERE TenantId = @tenantId
                `);
                if (sampleQuery.recordset.length > 0) {
                    console.log('🔍 [GROUPS] Sample group from DB:', sampleQuery.recordset[0]);
                }
            }
        }
        
        res.json({ success: true, data: result.recordset });
        
    } catch (error) {
        console.error('❌ Error fetching groups:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch groups' 
        });
    }
});

// =============================================================================
// ALLABOARD MASTER GROUP ID ROUTES
// NOTE: These literal-path routes MUST remain above GET /:id to avoid
//       being swallowed by the generic single-group handler.
// =============================================================================

/**
 * @route   GET /api/groups/resolve/:identifier
 * @desc    Resolve a group by AllAboardMasterGroupId within the caller's tenant
 * @access  SysAdmin, TenantAdmin, Agent
 */
router.get('/resolve/:identifier', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { identifier } = req.params;
        const pool = await getPool();
        const tenantId = req.tenantId || req.user?.TenantId;

        const group = await groupAccessService.resolveGroupIdentifierForUser(
            pool,
            identifier,
            req.user,
            { tenantId }
        );
        if (!group) {
            return res.status(404).json({ success: false, message: 'No active group found with that identifier.' });
        }

        return res.json({
            success: true,
            data: {
                ...group,
                groupId: group.GroupId,
            },
        });
    } catch (error) {
        logger.error(`[GROUPS] resolve error: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Server error resolving group.' });
    }
});

/**
 * @route   GET /api/groups/validate-master-group-id
 * @desc    Check format + uniqueness of an AllAboardMasterGroupId candidate
 * @query   value (required), groupId (optional, exclude from uniqueness check when updating)
 * @access  SysAdmin, TenantAdmin
 */
router.get('/validate-master-group-id', authMiddleware(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { value, groupId, excludeGroupId } = req.query;
        if (!value) {
            return res.status(400).json({ success: false, message: 'Query param "value" is required.' });
        }
        const tenantId = req.tenantId || req.user?.TenantId;
        const pool = await getPool();
        const excludeId = groupId || excludeGroupId || null;
        const { valid, errors } = await groupMasterIdService.validateMasterGroupId(pool, tenantId, value, excludeId);
        return res.json({ success: true, data: { valid, available: valid, errors } });
    } catch (error) {
        logger.error(`[GROUPS] validate-master-group-id error: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Server error validating group ID.' });
    }
});

/**
 * @route   GET /api/groups/validate-location-group-id
 * @desc    Check format + uniqueness of an AllAboardGroupId candidate for a location
 * @query   value (required), groupId (required), locationId (optional)
 * @access  SysAdmin, TenantAdmin
 */
router.get('/validate-location-group-id', authMiddleware(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { value, groupId, locationId } = req.query;
        if (!value || !groupId) {
            return res.status(400).json({ success: false, message: 'Query params "value" and "groupId" are required.' });
        }
        const pool = await getPool();
        const { valid, errors } = await groupMasterIdService.validateLocationGroupId(pool, groupId, value, locationId || null);
        return res.json({ success: true, data: { valid, available: valid, errors } });
    } catch (error) {
        logger.error(`[GROUPS] validate-location-group-id error: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Server error validating location group ID.' });
    }
});

/**
 * @route   PATCH /api/groups/:groupId/master-group-id
 * @desc    Set or update AllAboardMasterGroupId for a group, then recompute location IDs
 * @access  SysAdmin, TenantAdmin
 */
router.patch('/:groupId/master-group-id', authMiddleware(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { value } = req.body;
        if (!value) {
            return res.status(400).json({ success: false, message: 'Body field "value" is required.' });
        }
        const tenantId = req.tenantId || req.user?.TenantId;
        const pool = await getPool();

        // Validate format + uniqueness
        const { valid, errors } = await groupMasterIdService.validateMasterGroupId(pool, tenantId, value, groupId);
        if (!valid) {
            return res.status(400).json({ success: false, message: errors.join(' ') });
        }

        // Verify group belongs to caller's tenant
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const groupReq = pool.request().input('GroupId', sql.UniqueIdentifier, groupId);
        let checkQuery = `SELECT GroupId, TenantId FROM oe.Groups WHERE GroupId = @GroupId AND Status = 'Active'`;
        if (!isSysAdmin) {
            groupReq.input('TenantId', sql.UniqueIdentifier, tenantId);
            checkQuery += ' AND TenantId = @TenantId';
        }
        const groupCheck = await groupReq.query(checkQuery);
        if (!groupCheck.recordset.length) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied.' });
        }

        // Update master group ID (tenant-scoped for non-SysAdmin)
        const updateReq = pool.request()
            .input('GroupId', sql.UniqueIdentifier, groupId)
            .input('Value', sql.NVarChar(100), value);
        let updateQuery = `
            UPDATE oe.Groups
            SET AllAboardMasterGroupId = @Value, ModifiedDate = GETDATE()
            WHERE GroupId = @GroupId
        `;
        if (!isSysAdmin) {
            updateReq.input('TenantId', sql.UniqueIdentifier, tenantId);
            updateQuery += ' AND TenantId = @TenantId';
        }
        await updateReq.query(updateQuery);

        // Recompute location IDs asynchronously (fire-and-forget log on error)
        groupMasterIdService.recomputeLocationGroupIds(groupId)
            .catch(e => logger.warn(`[GROUPS] recompute after master-group-id set failed: ${e.message}`));

        return res.json({ success: true, data: { groupId, allAboardMasterGroupId: value } });
    } catch (error) {
        logger.error(`[GROUPS] PATCH master-group-id error: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Server error updating master group ID.' });
    }
});

/**
 * @route   PATCH /api/groups/:groupId/locations/:locationId/group-id
 * @desc    Manually override AllAboardGroupId for a single location (sets IsGroupIdOverride=1)
 * @access  SysAdmin, TenantAdmin
 */
router.patch('/:groupId/locations/:locationId/group-id', authMiddleware(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId, locationId } = req.params;
        const { value } = req.body;
        const tenantId = req.tenantId || req.user?.TenantId;
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');

        // Verify location belongs to group (and tenant for non-SysAdmin)
        const locReq = pool.request()
            .input('LocationId', sql.UniqueIdentifier, locationId)
            .input('GroupId', sql.UniqueIdentifier, groupId);
        let locCheckQuery = `
            SELECT gl.LocationId
            FROM oe.GroupLocations gl
            INNER JOIN oe.Groups g ON g.GroupId = gl.GroupId
            WHERE gl.LocationId = @LocationId AND gl.GroupId = @GroupId
        `;
        if (!isSysAdmin) {
            locReq.input('TenantId', sql.UniqueIdentifier, tenantId);
            locCheckQuery += ' AND g.TenantId = @TenantId';
        }
        const locCheck = await locReq.query(locCheckQuery);
        if (!locCheck.recordset.length) {
            return res.status(404).json({ success: false, message: 'Location not found for this group.' });
        }

        // Clear override — revert to auto-computed value
        if (value === null || value === undefined || value === '') {
            await pool.request()
                .input('LocationId', sql.UniqueIdentifier, locationId)
                .query(`
                    UPDATE oe.GroupLocations
                    SET IsGroupIdOverride = 0, ModifiedDate = GETDATE()
                    WHERE LocationId = @LocationId
                `);
            await groupMasterIdService.recomputeLocationGroupIds(groupId);
            const refreshed = await pool.request()
                .input('LocationId', sql.UniqueIdentifier, locationId)
                .query(`SELECT AllAboardGroupId FROM oe.GroupLocations WHERE LocationId = @LocationId`);
            const allAboardGroupId = refreshed.recordset[0]?.AllAboardGroupId || null;
            return res.json({ success: true, data: { locationId, allAboardGroupId, isGroupIdOverride: false } });
        }

        // Validate format + uniqueness within group
        const { valid, errors } = await groupMasterIdService.validateLocationGroupId(pool, groupId, value, locationId);
        if (!valid) {
            return res.status(400).json({ success: false, message: errors.join(' ') });
        }

        await pool.request()
            .input('LocationId', sql.UniqueIdentifier, locationId)
            .input('Value', sql.NVarChar(100), value)
            .query(`
                UPDATE oe.GroupLocations
                SET AllAboardGroupId = @Value, IsGroupIdOverride = 1, ModifiedDate = GETDATE()
                WHERE LocationId = @LocationId
            `);

        return res.json({ success: true, data: { locationId, allAboardGroupId: value, isGroupIdOverride: true } });
    } catch (error) {
        logger.error(`[GROUPS] PATCH location group-id error: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Server error updating location group ID.' });
    }
});

// GET /api/groups/:id - Get single group details
router.get('/:id', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        console.log('🔍 GET /api/groups/:id - Fetching group details for ID:', id);
        const pool = await getPool();
        const tenantId = req.tenantId || req.user?.TenantId;

        const accessCheck = await groupAccessService.verifyGroupAccess(pool, id, req.user, { tenantId });
        if (!accessCheck.hasAccess) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        let query = `
            SELECT
                g.GroupId,
                g.Name,
                g.Status,
                g.GroupType,
                g.PrimaryContact,
                g.ContactEmail,
                g.ContactPhone,
                g.Address,
                g.Address2,
                g.City,
                g.State, 
                g.Zip,
                g.ContactTitle,
                g.ContactPhone2,
                g.FaxNumber,
                g.Website,
                g.TaxIdNumber,
                g.BusinessType,
                g.CreditCardNumber,
                g.CreditCardType,
                g.CreditCardExpiry,
                g.CreditCardName,
                g.ACHBankName,
                g.ACHAccountType,
                g.ACHRoutingNumber,
                g.ACHAccountNumber,
                g.ACHAccountName,
                g.LogoUrl,
                g.DocumentsFolder,
                g.CreatedDate,
                g.ModifiedDate,
                g.AgentId,
                g.AllAboardMasterGroupId,
                g.MinimumHirePeriod,
                g.AllowPlanModifications,
                g.AllowMidMonthEffective,
                g.ShowEmployeePricingOnTiles,
                g.ShowContributionStrategy,
                g.PayrollPeriod,
                g.SetupStatus,
                t.Name as TenantName, 
                t.TenantId,
                t.CustomDomain as TenantCustomDomain,
                ISNULL((SELECT COUNT(*) FROM oe.Members m WHERE m.GroupId = g.GroupId), 0) as TotalMembers,
                ISNULL((SELECT COUNT(DISTINCT e.MemberId) FROM oe.Enrollments e JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND e.Status = 'Active'), 0) as ActiveEnrollments,
                -- MonthlyPremium: Base premium + System fees + Payment processing fees (matches estimated invoice total)
                -- This includes Product enrollments, SystemFee enrollments, and PaymentProcessingFee enrollments
                -- Excludes Contribution enrollments (those are just for member reference)
                ISNULL((
                    SELECT SUM(e.PremiumAmount) 
                    FROM oe.Enrollments e 
                    JOIN oe.Members m ON e.MemberId = m.MemberId 
                    WHERE m.GroupId = g.GroupId 
                      AND e.Status = 'Active' 
                      AND (
                        e.EnrollmentType = 'Product' 
                        OR e.EnrollmentType IS NULL 
                        OR e.EnrollmentType = 'SystemFee'
                        OR e.EnrollmentType = 'PaymentProcessingFee'
                      )
                ), 0.00) as MonthlyPremium,
                -- Agent information
                CASE
                    WHEN a.AgentId IS NOT NULL THEN CONCAT(agent_user.FirstName, ' ', agent_user.LastName)
                    ELSE NULL
                END as AgentName,
                a.AgentCode,
                -- Get agent's UserId for form population
                agent_user.UserId as AgentUserId,
                -- Enrollment effective date info (earliest active, earliest future) – Product only, not terminated (same logic as billing)
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) >= CAST(GETUTCDATE() AS DATE)) as EarliestFutureEffectiveDate,
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) < CAST(GETUTCDATE() AS DATE)) as EarliestActiveEffectiveDate,
                (SELECT COUNT(DISTINCT CAST(e.EffectiveDate AS DATE)) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) > CAST(GETUTCDATE() AS DATE)) as FutureEffectiveDateCount,
                ${GROUP_MIGRATION_STATUS_SELECT_SQL}
            FROM oe.Groups g
            JOIN oe.Tenants t ON g.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
            LEFT JOIN oe.Users agent_user ON a.UserId = agent_user.UserId
            WHERE g.GroupId = @groupId AND (g.Status = 'Active' OR g.Status = 'Archived')
        `;
        
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, id);

        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        const groupData = result.recordset[0];
        
        // Ensure MinimumHirePeriod is properly handled - SQL Server might return 0 as null in some cases
        // Convert null to 0 if it was explicitly set to 0, or keep null if it was never set
        // For now, we'll preserve the value as-is from the database
        if (groupData.MinimumHirePeriod === null && groupData.MinimumHirePeriod !== undefined) {
            // This shouldn't happen, but handle it just in case
            console.log('⚠️ MinimumHirePeriod is null in database');
        }
        
        console.log('🔍 Group data returned:', groupData);
        console.log('🔍 MinimumHirePeriod value:', groupData.MinimumHirePeriod);
        console.log('🔍 MinimumHirePeriod type:', typeof groupData.MinimumHirePeriod);
        console.log('🔍 MinimumHirePeriod is null?:', groupData.MinimumHirePeriod === null);
        console.log('🔍 MinimumHirePeriod is undefined?:', groupData.MinimumHirePeriod === undefined);
        console.log('🔍 MinimumHirePeriod === 0?:', groupData.MinimumHirePeriod === 0);
        
        res.json({ 
            success: true, 
            data: groupData 
        });
        
    } catch (error) {
        console.error('❌ Error fetching group details:', error);
        console.error('❌ Error message:', error.message);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch group details',
            error: error.message
        });
    }
});

// POST /api/groups - Create new group
router.post('/', authMiddleware(['Admin', 'SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const {
            name,
            primaryContact,
            primaryContactFirstName,
            primaryContactLastName,
            contactEmail,
            contactPhone,
            address,
            address2,
            city,
            state,
            zip,
            contactTitle,
            contactPhone2,
            faxNumber,
            website,
            taxIdNumber,
            businessType,
            creditCardNumber,
            creditCardType,
            creditCardExpiry,
            creditCardName,
            achBankName,
            achAccountType,
            achRoutingNumber,
            achAccountNumber,
            achAccountName,
            agentId,  // This comes from frontend as UserId
            tenantId,  // For SysAdmin users
            selectedProducts,
            householdCollection,
            allAboardMasterGroupId  // Optional AllAboard Master Group ID
        } = req.body;

        // Validation
        if (!name || !contactEmail) {
            return res.status(400).json({
                success: false,
                message: 'Group name and contact email are required'
            });
        }

        // SysAdmin must provide tenantId
        if (getUserRoles(req.user).includes('SysAdmin') && !tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Tenant selection is required for SysAdmin'
            });
        }

        const pool = await getPool();
        
        // Use transaction for ACID compliance
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
        
        // Convert UserId to AgentId if provided
        let actualAgentId = null;
        if (agentId) {
            const agentLookup = transaction.request();
            agentLookup.input('userId', sql.UniqueIdentifier, agentId);
            
            if (getUserRoles(req.user).includes('SysAdmin') && tenantId) {
                agentLookup.input('tenantId', sql.UniqueIdentifier, tenantId);
                var agentQuery = `
                    SELECT AgentId 
                    FROM oe.Agents 
                    WHERE UserId = @userId 
                      AND TenantId = @tenantId 
                      AND Status = 'Active'
                `;
            } else {
                agentLookup.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
                var agentQuery = `
                    SELECT AgentId 
                    FROM oe.Agents 
                    WHERE UserId = @userId 
                      AND TenantId = @userTenantId 
                      AND Status = 'Active'
                `;
            }
            
            const agentResult = await agentLookup.query(agentQuery);
            
            if (agentResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Invalid agent selection'
                });
            }
            
            actualAgentId = agentResult.recordset[0].AgentId;
        }

        if (actualAgentId) {
            const cr = getUserRoles(req.user);
            const agentLike = cr.includes('Agent') || cr.includes('AgencyOwner');
            if (agentLike && !cr.includes('SysAdmin') && !cr.includes('TenantAdmin')) {
                const { assertAgentMayAssignToTargetAgent } = require('../utils/agentAssignable');
                const errAssign = await assertAgentMayAssignToTargetAgent(pool, req.user.UserId, actualAgentId, {});
                if (errAssign) {
                    await transaction.rollback();
                    return res.status(403).json({ success: false, message: errAssign });
                }
            }
        }

        // Determine final tenant ID
        const finalTenantId = getUserRoles(req.user).includes('SysAdmin') ? tenantId : req.user.TenantId;

        // Create the group
        const groupId = require('crypto').randomUUID();
        const request = transaction.request();
        
        // Basic fields
        request.input('groupId', sql.UniqueIdentifier, groupId);
        request.input('tenantId', sql.UniqueIdentifier, finalTenantId);
        request.input('name', sql.NVarChar, name);
        request.input('primaryContact', sql.NVarChar, primaryContact || null);
        request.input('contactEmail', sql.NVarChar, contactEmail);
        request.input('contactPhone', sql.NVarChar, contactPhone || null);
        request.input('address', sql.NVarChar, address || null);
        request.input('address2', sql.NVarChar, address2 || null);
        request.input('city', sql.NVarChar, city || null);
        request.input('state', sql.NVarChar, state || null);
        request.input('zip', sql.NVarChar, zip || null);
        
        // Extended contact fields
        request.input('contactTitle', sql.NVarChar, contactTitle || null);
        request.input('contactPhone2', sql.NVarChar, contactPhone2 || null);
        request.input('faxNumber', sql.NVarChar, faxNumber || null);
        request.input('website', sql.NVarChar, website || null);
        
        // Business fields
        request.input('taxIdNumber', sql.NVarChar, taxIdNumber || null);
        request.input('businessType', sql.NVarChar, businessType || null);
        
        // System fields
        request.input('agentId', sql.UniqueIdentifier, actualAgentId);
        request.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

        // AllAboard Master Group ID — validate if provided, otherwise auto-assign from group name
        const masterResult = await groupMasterIdService.resolveMasterGroupIdForCreate(
            pool,
            finalTenantId,
            name,
            allAboardMasterGroupId || null
        );
        if (!masterResult.ok) {
            await transaction.rollback();
            return res.status(masterResult.status).json({ success: false, message: masterResult.message });
        }
        const resolvedMasterGroupId = masterResult.value;
        request.input('allAboardMasterGroupId', sql.NVarChar(100), resolvedMasterGroupId);

        // ✅ SECURITY: Removed plain text payment fields from oe.Groups INSERT
        // Payment data is now encrypted and stored in oe.GroupPaymentMethods via DIME
        await request.query(`
            INSERT INTO oe.Groups 
            (GroupId, TenantId, Name, Status, PrimaryContact, ContactEmail, 
             ContactPhone, Address, Address2, City, State, Zip, 
             ContactTitle, ContactPhone2, FaxNumber, Website,
             TaxIdNumber, BusinessType, AgentId, AllAboardMasterGroupId, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
            VALUES 
            (@groupId, @tenantId, @name, 'Active', @primaryContact, @contactEmail,
             @contactPhone, @address, @address2, @city, @state, @zip,
             @contactTitle, @contactPhone2, @faxNumber, @website,
             @taxIdNumber, @businessType, @agentId, @allAboardMasterGroupId, GETDATE(), GETDATE(), @createdBy, @createdBy)
        `);

        // Create default "Primary Location" for the group
        const locationId = require('crypto').randomUUID();
        const locationRequest = transaction.request();
        locationRequest.input('locationId', sql.UniqueIdentifier, locationId);
        locationRequest.input('groupId', sql.UniqueIdentifier, groupId);
        locationRequest.input('name', sql.NVarChar, 'Primary Location');
        locationRequest.input('address', sql.NVarChar, address || '');
        locationRequest.input('address2', sql.NVarChar, address2 || null);
        locationRequest.input('city', sql.NVarChar, city || '');
        locationRequest.input('state', sql.NVarChar, state || '');
        locationRequest.input('zip', sql.NVarChar, zip || '');
        locationRequest.input('contactName', sql.NVarChar, primaryContact || null);
        locationRequest.input('contactPhone', sql.NVarChar, contactPhone || null);
        locationRequest.input('contactEmail', sql.NVarChar, contactEmail || null);
        locationRequest.input('useLocationACH', sql.Bit, 0); // Default to group account
        locationRequest.input('isPrimary', sql.Bit, 1); // Set as primary location
        locationRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
        
        await locationRequest.query(`
            INSERT INTO oe.GroupLocations 
            (LocationId, GroupId, Name, Address, Address2, City, State, Zip,
             ContactName, ContactPhone, ContactEmail, UseLocationACH, IsPrimary, Status,
             CreatedDate, ModifiedDate, CreatedBy)
            VALUES 
            (@locationId, @groupId, @name, @address, @address2, @city, @state, @zip,
             @contactName, @contactPhone, @contactEmail, @useLocationACH, @isPrimary, 'Active',
             GETDATE(), GETDATE(), @createdBy)
        `);
        console.log(`✅ Created primary location for group ${groupId}`);

        // Process payment information if provided
        const hasACHInfo = achBankName || achRoutingNumber || achAccountNumber;
        const hasCardInfo = creditCardNumber || creditCardName || creditCardType;
        
        if (hasACHInfo || hasCardInfo) {
            console.log('💳 Payment info provided, processing with DIME...');
            
            // Validate address is present for payment processing
            if (!address || !city || !state || !zip) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Address is required when payment information is provided. Please provide complete address details.'
                });
            }
            
            try {
                // Step 1: Ensure DIME customer exists
                const customerData = {
                    firstName: primaryContactFirstName || primaryContact?.split(' ')[0] || 'Group',
                    lastName: primaryContactLastName || primaryContact?.split(' ').slice(1).join(' ') || 'Admin',
                    email: contactEmail,
                    phone: contactPhone || '+17707892072',
                    billingAddress: address,
                    billingCity: city,
                    billingState: state,
                    billingZip: zip,
                    billingCountry: 'US'
                };
                
                const customerResult = await PaymentMethodService.ensureDimeCustomer(
                    customerData,
                    'group',
                    groupId,
                    finalTenantId,
                    transaction
                );
                
                if (!customerResult.success) {
                    console.error('❌ Failed to create DIME customer:', customerResult.error);
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Failed to create DIME customer: ' + (customerResult.error?.message || 'Unknown error')
                    });
                }
                
                const dimeCustomerId = customerResult.customerId;
                console.log('✅ DIME customer created:', dimeCustomerId);
                
                // Step 2: Determine payment type and prepare data
                const paymentType = hasACHInfo ? 'ACH' : 'CreditCard';
                const paymentMethodData = {
                    paymentMethodType: paymentType,
                    // ACH fields
                    bankName: achBankName,
                    accountType: achAccountType || 'Checking',
                    routingNumber: achRoutingNumber,
                    accountNumber: achAccountNumber,
                    accountHolderName: achAccountName || primaryContact,
                    // Credit Card fields
                    cardNumber: creditCardNumber,
                    expiryMonth: creditCardExpiry ? parseInt(creditCardExpiry.split('/')[0]) : undefined,
                    expiryYear: creditCardExpiry ? parseInt(creditCardExpiry.split('/')[1]) : undefined,
                    cvv: undefined, // Not stored during group creation
                    cardholderName: creditCardName,
                    // Billing address
                    billingAddress: address,
                    billingAddress2: address2 || '',
                    billingCity: city,
                    billingState: state,
                    billingZip: zip,
                    billingCountry: 'US'
                };
                
                // Step 3: Create payment method with DIME
                const dimeResult = await PaymentMethodService.createPaymentMethod(
                    paymentMethodData,
                    dimeCustomerId,
                    finalTenantId
                );
                
                if (!dimeResult.success) {
                    console.error('❌ Failed to create DIME payment method:', dimeResult.error);
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Failed to create DIME payment method: ' + (dimeResult.error?.message || 'Unknown error')
                    });
                }
                
                console.log('✅ DIME payment method created successfully');
                
                // Step 4: Insert encrypted payment method into oe.GroupPaymentMethods
                const insertResult = await PaymentMethodService.insertPaymentMethod(
                    paymentMethodData,
                    'group',
                    groupId,
                    dimeResult,
                    req.user.UserId,
                    finalTenantId,
                    transaction, // Pass transaction for ACID compliance
                    locationId // Link to primary location
                );
                
                if (!insertResult.success) {
                    console.error('❌ Failed to insert payment method:', insertResult.error);
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Failed to save payment method: ' + (insertResult.error?.message || 'Unknown error')
                    });
                }
                
                // Step 5: Set as default payment method
                await PaymentMethodService.updatePaymentMethodDefaults(
                    'group',
                    groupId,
                    insertResult.paymentMethodId,
                    req.user.UserId,
                    finalTenantId, // tenantId
                    transaction, // transaction (ACID compliance)
                    locationId
                );
                
                console.log('✅ Payment method created, encrypted, and linked to primary location successfully');
                
            } catch (paymentError) {
                console.error('❌ Error processing payment information:', paymentError);
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Payment processing failed: ' + (paymentError.message || 'Unknown error')
                });
            }
        }

        // Handle selected products if provided
        if (selectedProducts && Array.isArray(selectedProducts) && selectedProducts.length > 0) {
            console.log(`📦 Assigning ${selectedProducts.length} products to group ${groupId}`);
            
            for (const productId of selectedProducts) {
                const groupProductId = require('crypto').randomUUID();
                const productRequest = transaction.request();
                
                productRequest.input('groupProductId', sql.UniqueIdentifier, groupProductId);
                productRequest.input('groupId', sql.UniqueIdentifier, groupId);
                productRequest.input('productId', sql.UniqueIdentifier, productId);
                productRequest.input('isActive', sql.Bit, 1);
                productRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
                
                await productRequest.query(`
                    INSERT INTO oe.GroupProducts 
                    (GroupProductId, GroupId, ProductId, IsActive, CustomSettings,
                     CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES 
                    (@groupProductId, @groupId, @productId, @isActive, NULL,
                     GETDATE(), GETDATE(), @createdBy, @createdBy)
                `);
            }
            
            console.log(`✅ Successfully assigned ${selectedProducts.length} products to group ${groupId}`);
        }

        // Commit the entire transaction
        await transaction.commit();
        console.log(`✅ Transaction committed successfully for group ${groupId}`);

        // Auto-generate enrollment link template if products were assigned
        if (selectedProducts && selectedProducts.length > 0) {
          try {
            const templateId = require('crypto').randomUUID();
            const linkMetaData = JSON.stringify({
              household: householdCollection || {
                collectSSN: true, collectDOB: true, collectGender: true,
                collectAddress: true, collectPhone: true
              }
            });
            const tplReq = pool.request()
              .input('templateId', sql.UniqueIdentifier, templateId)
              .input('templateName', sql.NVarChar, `${name} Enrollment`)
              .input('tenantId', sql.UniqueIdentifier, finalTenantId)
              .input('groupId', sql.UniqueIdentifier, groupId)
              .input('linkMetaData', sql.NVarChar, linkMetaData)
              .input('createdBy', sql.UniqueIdentifier, req.user.UserId);
            if (actualAgentId) {
              tplReq.input('agentId', sql.UniqueIdentifier, actualAgentId);
            }
            await tplReq.query(`
              INSERT INTO oe.EnrollmentLinkTemplates
                (TemplateId, TemplateName, TemplateType, TenantId, GroupId, AgentId, LinkMetaData, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
              VALUES
                (@templateId, @templateName, 'Group', @tenantId, @groupId, ${actualAgentId ? '@agentId' : 'NULL'}, @linkMetaData, 1, GETDATE(), GETDATE(), @createdBy, @createdBy)
            `);
            console.log(`✅ Auto-generated enrollment link template for new group ${groupId}`);
          } catch (tplErr) {
            console.warn('⚠️ Failed to auto-generate enrollment link template:', tplErr.message);
          }
        }

        res.status(201).json({
            success: true,
            message: 'Group created successfully',
            data: {
                groupId,
                name,
                agentId: actualAgentId,
                tenantId: finalTenantId,
                allAboardMasterGroupId: resolvedMasterGroupId || null
            }
        });

        // Fire-and-forget: assign location group IDs from master
        groupMasterIdService.recomputeLocationGroupIds(groupId)
            .catch(e => logger.warn(`[GROUPS] recompute after group create failed: ${e.message}`));
        
        } catch (transactionError) {
            // Rollback transaction on any error
            await transaction.rollback();
            console.error('❌ Transaction rolled back due to error:', transactionError);
            throw transactionError;
        }

    } catch (error) {
        console.error('❌ Error creating group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create group',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// PUT /api/groups/:id - Update group
router.put('/:id', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;
        
        console.log('📋 Groups update request received:', {
            groupId: id,
            updateData: updateData,
            hasLogoUrl: !!updateData.logoUrl,
            logoUrl: updateData.logoUrl
        });

        const pool = await getPool();
        
        // Handle payment info masking
        let maskedCCNumber = updateData.creditCardNumber;
        let maskedACHNumber = updateData.achAccountNumber;
        
        if (updateData.creditCardNumber) {
            maskedCCNumber = updateData.creditCardNumber.replace(/\D/g, '').slice(-4);
        }
        
        if (updateData.achAccountNumber) {
            maskedACHNumber = updateData.achAccountNumber.replace(/\D/g, '').slice(-4);
        }
        
        // Handle AgentId conversion if provided
        let actualAgentId = updateData.agentId;
        if (updateData.agentId) {
            const agentLookup = pool.request();
            agentLookup.input('userId', sql.UniqueIdentifier, updateData.agentId);
            
            // SysAdmin can update agentId for any group
            // TenantAdmin and GroupAdmin can only update agentId for their own groups
            if (!getUserRoles(req.user).includes('SysAdmin')) {
                agentLookup.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
                var agentQuery = `
                    SELECT AgentId 
                    FROM oe.Agents 
                    WHERE UserId = @userId 
                      AND TenantId = @userTenantId 
                      AND Status = 'Active'
                `;
            } else {
                var agentQuery = `
                    SELECT AgentId 
                    FROM oe.Agents 
                    WHERE UserId = @userId 
                      AND Status = 'Active'
                `;
            }
            
            const agentResult = await agentLookup.query(agentQuery);
            
            if (agentResult.recordset.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid agent selection for update'
                });
            }
            
            actualAgentId = agentResult.recordset[0].AgentId;
        }

        if (actualAgentId !== undefined && updateData.agentId) {
            const ur = getUserRoles(req.user);
            const agentLike = ur.includes('Agent') || ur.includes('AgencyOwner');
            if (agentLike && !ur.includes('SysAdmin') && !ur.includes('TenantAdmin')) {
                const { assertAgentMayAssignToTargetAgent } = require('../utils/agentAssignable');
                const errAssign = await assertAgentMayAssignToTargetAgent(pool, req.user.UserId, actualAgentId, {
                    forGroupId: id
                });
                if (errAssign) {
                    return res.status(403).json({ success: false, message: errAssign });
                }
            }
        }

        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, id);
        request.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

        // Build dynamic update query
        const updateFields = [];
        const allowedFields = {
            'name': 'Name',
            'primaryContact': 'PrimaryContact', 
            'contactEmail': 'ContactEmail',
            'contactPhone': 'ContactPhone',
            'address': 'Address',
            'address2': 'Address2',
            'city': 'City',
            'state': 'State',
            'zip': 'Zip',
            'contactTitle': 'ContactTitle',
            'contactPhone2': 'ContactPhone2',
            'faxNumber': 'FaxNumber',
            'website': 'Website',
            'taxIdNumber': 'TaxIdNumber',
            'businessType': 'BusinessType',
            'creditCardNumber': 'CreditCardNumber',
            'creditCardType': 'CreditCardType',
            'creditCardExpiry': 'CreditCardExpiry',
            'creditCardName': 'CreditCardName',
            'achBankName': 'ACHBankName',
            'achAccountType': 'ACHAccountType',
            'achRoutingNumber': 'ACHRoutingNumber',
            'achAccountNumber': 'ACHAccountNumber',
            'achAccountName': 'ACHAccountName',
            'logoUrl': 'LogoUrl',
            'documentsFolder': 'DocumentsFolder',
            'status': 'Status'
        };
        
        Object.keys(allowedFields).forEach(fieldKey => {
            if (updateData[fieldKey] !== undefined) {
                const sqlField = allowedFields[fieldKey];
                updateFields.push(`${sqlField} = @${fieldKey}`);
                
                // Apply masking for sensitive fields
                let value = updateData[fieldKey];
                if (fieldKey === 'creditCardNumber' && value) {
                    value = maskedCCNumber;
                } else if (fieldKey === 'achAccountNumber' && value) {
                    value = maskedACHNumber;
                }
                
                request.input(fieldKey, sql.NVarChar, value);
            }
        });

        // Handle AgentId separately since it's a UNIQUEIDENTIFIER
        if (actualAgentId !== undefined) {
            updateFields.push('AgentId = @agentId');
            request.input('agentId', sql.UniqueIdentifier, actualAgentId);
        }

        // Handle MinimumHirePeriod separately since it's an INT
        // Explicitly check for number type to handle 0 correctly (0 !== undefined but we want to ensure it's a number)
        if (updateData.minimumHirePeriod !== undefined && typeof updateData.minimumHirePeriod === 'number') {
            updateFields.push('MinimumHirePeriod = @minimumHirePeriod');
            request.input('minimumHirePeriod', sql.Int, updateData.minimumHirePeriod);
            console.log('🔍 Setting MinimumHirePeriod to:', updateData.minimumHirePeriod, 'type:', typeof updateData.minimumHirePeriod);
        }

        // Handle AllowPlanModifications separately since it's a BIT
        if (updateData.allowPlanModifications !== undefined) {
            updateFields.push('AllowPlanModifications = @allowPlanModifications');
            request.input('allowPlanModifications', sql.Bit, updateData.allowPlanModifications ? 1 : 0);
        }

        // Handle AllowMidMonthEffective separately since it's a BIT
        if (updateData.allowMidMonthEffective !== undefined) {
            updateFields.push('AllowMidMonthEffective = @allowMidMonthEffective');
            request.input('allowMidMonthEffective', sql.Bit, updateData.allowMidMonthEffective ? 1 : 0);
        }

        // Handle ShowEmployeePricingOnTiles separately since it's a BIT
        if (updateData.showEmployeePricingOnTiles !== undefined) {
            updateFields.push('ShowEmployeePricingOnTiles = @showEmployeePricingOnTiles');
            request.input('showEmployeePricingOnTiles', sql.Bit, updateData.showEmployeePricingOnTiles ? 1 : 0);
        }

        // Handle ShowContributionStrategy separately since it's a BIT
        if (updateData.showContributionStrategy !== undefined) {
            updateFields.push('ShowContributionStrategy = @showContributionStrategy');
            request.input('showContributionStrategy', sql.Bit, updateData.showContributionStrategy ? 1 : 0);
        }

        // Handle PayrollPeriod separately since it's a VARCHAR
        if (updateData.payrollPeriod !== undefined) {
            const allowedPayrollPeriods = new Set(['Monthly', 'Bi-Monthly', 'Bi-Weekly', 'Weekly']);
            if (!allowedPayrollPeriods.has(updateData.payrollPeriod)) {
                return res.status(400).json({
                    success: false,
                    message: 'PayrollPeriod must be Monthly, Bi-Monthly, Bi-Weekly, or Weekly'
                });
            }
            updateFields.push('PayrollPeriod = @payrollPeriod');
            request.input('payrollPeriod', sql.NVarChar(20), updateData.payrollPeriod);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid fields to update'
            });
        }

        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @modifiedBy');

        console.log('📋 Update fields being processed:', updateFields);
        console.log('📋 LogoUrl field processing:', {
            hasLogoUrl: updateData.logoUrl !== undefined,
            logoUrlValue: updateData.logoUrl,
            isInUpdateFields: updateFields.some(field => field.includes('LogoUrl'))
        });

        let query = `
            UPDATE oe.Groups 
            SET ${updateFields.join(', ')}
            WHERE GroupId = @groupId
        `;

        // Non-admin users can only update their own tenant's groups
        // if (!getUserRoles(req.user).includes('SysAdmin')) {
        //     query += ' AND TenantId = @userTenantId';
        //     request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        // }

        const result = await request.query(query);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        // Cascade agent change to Members, Enrollments, Payments, and EnrollmentLinkTemplates
        // (Group members must match group's agent; downstream enrollment/payment records follow)
        if (actualAgentId !== undefined) {
            try {
                const cascadeRequest = pool.request();
                cascadeRequest.input('groupId', sql.UniqueIdentifier, id);
                cascadeRequest.input('newAgentId', sql.UniqueIdentifier, actualAgentId);
                cascadeRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

                // Update Members for this group
                await cascadeRequest.query(`
                    UPDATE oe.Members SET AgentId = @newAgentId, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
                    WHERE GroupId = @groupId
                `);

                // Update Enrollments for members of this group
                await cascadeRequest.query(`
                    UPDATE e SET e.AgentId = @newAgentId, e.ModifiedDate = GETUTCDATE(), e.ModifiedBy = @modifiedBy
                    FROM oe.Enrollments e
                    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                    WHERE m.GroupId = @groupId
                `);

                // Update Payments tied to enrollments for members of this group
                await cascadeRequest.query(`
                    UPDATE p
                    SET p.AgentId = @newAgentId, p.ModifiedDate = GETUTCDATE(), p.ModifiedBy = @modifiedBy
                    FROM oe.Payments p
                    INNER JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
                    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                    WHERE m.GroupId = @groupId
                `);

                // Update Payments tied directly to households in this group
                await cascadeRequest.query(`
                    UPDATE p
                    SET p.AgentId = @newAgentId, p.ModifiedDate = GETUTCDATE(), p.ModifiedBy = @modifiedBy
                    FROM oe.Payments p
                    WHERE p.HouseholdId IN (
                        SELECT DISTINCT m.HouseholdId
                        FROM oe.Members m
                        WHERE m.GroupId = @groupId
                          AND m.HouseholdId IS NOT NULL
                    )
                `);

                // Update Payments tied directly to the group
                await cascadeRequest.query(`
                    UPDATE oe.Payments
                    SET AgentId = @newAgentId, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
                    WHERE GroupId = @groupId
                `);

                // Update EnrollmentLinkTemplates for this group
                await cascadeRequest.query(`
                    UPDATE oe.EnrollmentLinkTemplates SET AgentId = @newAgentId, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
                    WHERE GroupId = @groupId
                `);

                console.log('✅ Cascaded agent update to Members, Enrollments, Payments, EnrollmentLinkTemplates');
            } catch (cascadeErr) {
                console.error('⚠️ Cascade agent update failed (group updated):', cascadeErr);
                // Don't fail the request - group was updated successfully
            }
        }

        res.json({
            success: true,
            message: 'Group updated successfully'
        });

    } catch (error) {
        console.error('❌ Error updating group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update group'
        });
    }
});

/**
 * Cancel active DIME recurring schedules for a group and mark oe.GroupRecurringPaymentPlans inactive.
 */
async function cancelGroupRecurringPaymentsInDimeAndDb(pool, groupId, tenantId) {
    const plansResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
            SELECT DimeScheduleId
            FROM oe.GroupRecurringPaymentPlans
            WHERE GroupId = @groupId AND IsActive = 1 AND DimeScheduleId IS NOT NULL
        `);
    const rows = plansResult.recordset || [];
    for (const row of rows) {
        const scheduleId = String(row.DimeScheduleId);
        const cancelResult = await DimeService.cancelRecurringPayment(scheduleId, tenantId);
        if (!cancelResult.success && !cancelResult.wasAlreadyCanceled) {
            return {
                success: false,
                error: cancelResult.error || 'Failed to cancel recurring payment in DIME',
                scheduleId
            };
        }
        await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('scheduleId', sql.NVarChar(255), scheduleId)
            .query(`
                UPDATE oe.GroupRecurringPaymentPlans
                SET IsActive = 0, ModifiedDate = GETUTCDATE()
                WHERE GroupId = @groupId AND DimeScheduleId = @scheduleId
            `);
    }
    return { success: true };
}

// GET /api/groups/:id/release-unenrolled-preview — list households in a group, classified by whether
// any member of the household has any blocking PRODUCT enrollment. The eligibility rule is intentionally
// kept in lockstep with the Edit-Member group-change validator (PUT /api/members/:id, see backend/routes/members.js
// "Cannot remove group membership while the member has active product enrollments..."), so a member who can be
// switched to "no group" via Edit Member is also eligible to be released here, and vice-versa.
//
// A household is "releasable" iff NO member in it has any oe.Enrollments row that is BOTH:
//   (a) a product enrollment: EnrollmentType = 'Product' OR (EnrollmentType IS NULL AND ProductId IS NOT NULL)
//   (b) Status IN ('Active','Pending','PaymentHold') AND (TerminationDate IS NULL OR TerminationDate > today)
// (Future-dated EffectiveDate enrollments still count as obligations, matching Edit-Member.)
//
// When a household is released, EVERY member in that household has GroupId cleared (primary + dependents).
// Members with no HouseholdId are treated as their own single-person household.
router.get('/:id/release-unenrolled-preview', authMiddleware(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();

        const accessCheck = pool.request();
        accessCheck.input('groupId', sql.UniqueIdentifier, id);
        let accessQuery;
        if (getUserRoles(req.user).includes('SysAdmin')) {
            accessQuery = 'SELECT GroupId, TenantId, Name FROM oe.Groups WHERE GroupId = @groupId';
        } else {
            accessCheck.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery = 'SELECT GroupId, TenantId, Name FROM oe.Groups WHERE GroupId = @groupId AND TenantId = @userTenantId';
        }
        const accessResult = await accessCheck.query(accessQuery);
        if (accessResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, id)
            .query(`
                SELECT
                    m.MemberId,
                    m.UserId,
                    m.HouseholdId,
                    m.RelationshipType,
                    m.Status AS MemberStatus,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e
                        WHERE e.MemberId = m.MemberId
                          AND e.Status IN ('Active','Pending','PaymentHold')
                          AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
                    ) AS TotalActiveStatusEnrollments,
                    -- "Blocking" = same rule the Edit-Member endpoint uses to refuse "Make Individual"
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e
                        WHERE e.MemberId = m.MemberId
                          AND e.Status IN ('Active','Pending','PaymentHold')
                          AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
                          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                    ) AS CurrentlyActiveEnrollments,
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e
                        WHERE e.MemberId = m.MemberId
                          AND e.Status IN ('Active','Pending','PaymentHold')
                          AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
                          AND e.TerminationDate IS NULL
                    ) AS EnrollmentsMissingTerminationDate,
                    (
                        SELECT MAX(e.TerminationDate) FROM oe.Enrollments e
                        WHERE e.MemberId = m.MemberId
                          AND e.Status IN ('Active','Pending','PaymentHold')
                          AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
                    ) AS LatestTerminationDate
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.GroupId = @groupId
                ORDER BY m.HouseholdId, CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END, u.LastName, u.FirstName
            `);

        const rows = result.recordset || [];

        // Group members by HouseholdId (NULL -> use the member's own MemberId as a synthetic key)
        const householdMap = new Map();
        for (const r of rows) {
            const memberId = String(r.MemberId);
            const householdKey = r.HouseholdId ? String(r.HouseholdId) : `member:${memberId}`;
            const member = {
                memberId,
                userId: r.UserId ? String(r.UserId) : null,
                firstName: r.FirstName || '',
                lastName: r.LastName || '',
                email: r.Email || '',
                relationshipType: r.RelationshipType || null,
                memberStatus: r.MemberStatus || null,
                householdId: r.HouseholdId ? String(r.HouseholdId) : null,
                activeEnrollmentCount: Number(r.CurrentlyActiveEnrollments || 0),
                totalActiveStatusEnrollments: Number(r.TotalActiveStatusEnrollments || 0),
                enrollmentsMissingTerminationDate: Number(r.EnrollmentsMissingTerminationDate || 0),
                latestTerminationDate: r.LatestTerminationDate ? new Date(r.LatestTerminationDate).toISOString() : null,
            };
            if (!householdMap.has(householdKey)) {
                householdMap.set(householdKey, { householdKey, householdId: member.householdId, primary: null, dependents: [], members: [] });
            }
            const hh = householdMap.get(householdKey);
            hh.members.push(member);
            if (member.relationshipType === 'P' && !hh.primary) {
                hh.primary = member;
            } else {
                hh.dependents.push(member);
            }
        }

        // For households where no explicit primary was found (data oddity), promote the first member to primary
        for (const hh of householdMap.values()) {
            if (!hh.primary && hh.members.length > 0) {
                hh.primary = hh.members[0];
                hh.dependents = hh.members.slice(1);
            }
        }

        const releasableHouseholds = [];
        const notReleasableHouseholds = [];

        for (const hh of householdMap.values()) {
            const blockers = hh.members.filter((mm) => mm.activeEnrollmentCount > 0);
            const totalMissingTerm = hh.members.reduce((s, mm) => s + mm.enrollmentsMissingTerminationDate, 0);
            const latestTermInHousehold = hh.members
                .map((mm) => mm.latestTerminationDate)
                .filter(Boolean)
                .sort()
                .slice(-1)[0] || null;

            const summary = {
                householdKey: hh.householdKey,
                householdId: hh.householdId,
                primary: hh.primary,
                dependents: hh.dependents,
                memberIds: hh.members.map((mm) => mm.memberId),
                memberCount: hh.members.length,
                latestTerminationDate: latestTermInHousehold,
            };

            if (blockers.length > 0) {
                let reason;
                if (totalMissingTerm > 0) {
                    reason = `${totalMissingTerm} active enrollment${totalMissingTerm === 1 ? '' : 's'} in this household ${totalMissingTerm === 1 ? 'is' : 'are'} missing a termination date`;
                } else {
                    const blockerNames = blockers.map((b) => `${b.firstName} ${b.lastName}`.trim() || b.email || b.memberId).join(', ');
                    reason = latestTermInHousehold
                        ? `Currently enrolled (coverage active through ${latestTermInHousehold.slice(0, 10)}) — ${blockerNames}`
                        : `Currently enrolled — ${blockerNames}`;
                }
                notReleasableHouseholds.push({ ...summary, reason });
            } else {
                releasableHouseholds.push(summary);
            }
        }

        res.json({
            success: true,
            data: {
                groupId: id,
                groupName: accessResult.recordset[0].Name,
                releasableHouseholds,
                notReleasableHouseholds,
                summary: {
                    totalMembers: rows.length,
                    totalHouseholds: householdMap.size,
                    releasableHouseholdCount: releasableHouseholds.length,
                    notReleasableHouseholdCount: notReleasableHouseholds.length,
                    releasableMemberCount: releasableHouseholds.reduce((s, hh) => s + hh.memberCount, 0),
                    notReleasableMemberCount: notReleasableHouseholds.reduce((s, hh) => s + hh.memberCount, 0),
                }
            }
        });
    } catch (error) {
        console.error('❌ Error building release-unenrolled preview:', error);
        res.status(500).json({ success: false, message: 'Failed to load release preview' });
    }
});

// POST /api/groups/:id/release-unenrolled — set GroupId = NULL for the selected households.
// Body: { memberIds: string[] } — any member id whose household is selected; the server expands to ALL
// members in those households (primary + dependents) and re-validates that no household member has a
// currently active enrollment before clearing GroupId.
router.post('/:id/release-unenrolled', authMiddleware(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const memberIds = Array.isArray(req.body?.memberIds)
            ? Array.from(new Set(req.body.memberIds.filter((v) => typeof v === 'string' && v.length > 0)))
            : [];
        if (memberIds.length === 0) {
            return res.status(400).json({ success: false, message: 'memberIds is required' });
        }

        const pool = await getPool();

        const accessCheck = pool.request();
        accessCheck.input('groupId', sql.UniqueIdentifier, id);
        let accessQuery;
        if (getUserRoles(req.user).includes('SysAdmin')) {
            accessQuery = 'SELECT GroupId, TenantId, Name FROM oe.Groups WHERE GroupId = @groupId';
        } else {
            accessCheck.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery = 'SELECT GroupId, TenantId, Name FROM oe.Groups WHERE GroupId = @groupId AND TenantId = @userTenantId';
        }
        const accessResult = await accessCheck.query(accessQuery);
        if (accessResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }
        const tenantId = accessResult.recordset[0].TenantId;
        const oldGroupName = accessResult.recordset[0].Name || null;

        // Step 1: expand the requested memberIds to the full set of household members in this group.
        // Members with NULL HouseholdId are released as themselves only.
        const expandRequest = pool.request().input('groupId', sql.UniqueIdentifier, id);
        memberIds.forEach((mid, i) => expandRequest.input(`m${i}`, sql.UniqueIdentifier, mid));
        const requestedParamList = memberIds.map((_, i) => `@m${i}`).join(',');
        const expandResult = await expandRequest.query(`
            ;WITH Requested AS (
                SELECT MemberId, HouseholdId
                FROM oe.Members
                WHERE GroupId = @groupId AND MemberId IN (${requestedParamList})
            )
            SELECT DISTINCT m.MemberId
            FROM oe.Members m
            WHERE m.GroupId = @groupId
              AND (
                  EXISTS (SELECT 1 FROM Requested r WHERE r.MemberId = m.MemberId)
                  OR EXISTS (
                      SELECT 1 FROM Requested r
                      WHERE r.HouseholdId IS NOT NULL AND r.HouseholdId = m.HouseholdId
                  )
              )
        `);
        const expandedIds = (expandResult.recordset || []).map((r) => String(r.MemberId));

        if (expandedIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No matching members found in this group for the provided ids.'
            });
        }

        // Step 2: re-validate eligibility at the household level. Any household where ANY member has a
        // currently-active enrollment is excluded entirely.
        const validateRequest = pool.request().input('groupId', sql.UniqueIdentifier, id);
        expandedIds.forEach((mid, i) => validateRequest.input(`x${i}`, sql.UniqueIdentifier, mid));
        const expandedParamList = expandedIds.map((_, i) => `@x${i}`).join(',');
        const eligibleResult = await validateRequest.query(`
            ;WITH Candidate AS (
                SELECT MemberId, HouseholdId
                FROM oe.Members
                WHERE GroupId = @groupId AND MemberId IN (${expandedParamList})
            ),
            HouseholdsWithActive AS (
                SELECT DISTINCT c.HouseholdId
                FROM Candidate c
                INNER JOIN oe.Members m2 ON (
                    (c.HouseholdId IS NOT NULL AND m2.HouseholdId = c.HouseholdId AND m2.GroupId = @groupId)
                    OR (c.HouseholdId IS NULL AND m2.MemberId = c.MemberId)
                )
                -- Same rule as PUT /api/members/:id GROUP_REMOVE_BLOCKED_ACTIVE_ENROLLMENTS
                WHERE EXISTS (
                    SELECT 1 FROM oe.Enrollments e
                    WHERE e.MemberId = m2.MemberId
                      AND e.Status IN ('Active','Pending','PaymentHold')
                      AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
                      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                )
            ),
            BlockedSoloMembers AS (
                SELECT c.MemberId
                FROM Candidate c
                WHERE c.HouseholdId IS NULL
                  AND EXISTS (
                      SELECT 1 FROM oe.Enrollments e
                      WHERE e.MemberId = c.MemberId
                        AND e.Status IN ('Active','Pending','PaymentHold')
                        AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
                        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                  )
            )
            SELECT c.MemberId
            FROM Candidate c
            WHERE NOT (c.HouseholdId IS NOT NULL AND c.HouseholdId IN (SELECT HouseholdId FROM HouseholdsWithActive WHERE HouseholdId IS NOT NULL))
              AND NOT (c.HouseholdId IS NULL AND c.MemberId IN (SELECT MemberId FROM BlockedSoloMembers))
        `);
        const eligibleIds = (eligibleResult.recordset || []).map((r) => String(r.MemberId));

        if (eligibleIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'None of the selected households are eligible to release. They all have currently active enrollments.'
            });
        }

        // Step 3: load the eligible members' identifying fields once. We need HouseholdId so we can
        // mirror Edit-Member's whole-household HouseholdMemberID prefix swap, and we need TenantId for
        // the prefix-swap utility. (TenantId is also already on every Members row, but we trust the
        // group's TenantId loaded above.)
        const detailsRequest = pool.request();
        eligibleIds.forEach((mid, i) => detailsRequest.input(`d${i}`, sql.UniqueIdentifier, mid));
        const detailsParamList = eligibleIds.map((_, i) => `@d${i}`).join(',');
        const detailsResult = await detailsRequest.query(`
            SELECT MemberId, HouseholdId, HouseholdMemberID
            FROM oe.Members
            WHERE MemberId IN (${detailsParamList})
        `);
        const eligibleDetails = detailsResult.recordset || [];
        const householdIds = Array.from(new Set(
            eligibleDetails.map((r) => (r.HouseholdId ? String(r.HouseholdId) : null)).filter(Boolean)
        ));

        // Step 4: load tenant prefixes once so we can decide whether HouseholdMemberID prefix-swap
        // applies (only when MemberIDPrefix and IndividualMemberIDPrefix differ). This matches
        // backend/routes/members.js line ~2404 (Edit Member group-change post-update block).
        const tenantPrefixRequest = pool.request();
        tenantPrefixRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const tenantPrefixResult = await tenantPrefixRequest.query(`
            SELECT MemberIDPrefix, IndividualMemberIDPrefix
            FROM oe.Tenants
            WHERE TenantId = @tenantId
        `);
        const tenantPrefixes = tenantPrefixResult.recordset[0] || null;
        const prefixSwap = tenantPrefixes
            ? computePrefixSwapForGroupChange({
                clearingGroup: true,
                memberIDPrefix: tenantPrefixes.MemberIDPrefix,
                individualMemberIDPrefix: tenantPrefixes.IndividualMemberIDPrefix,
            })
            : null;

        // Step 5: do the actual mutation in a single transaction so the GroupId clear, the employer-
        // field clears, the household-wide prefix swap, and the MemberEventLog inserts either ALL
        // succeed or ALL roll back.
        const transaction = pool.transaction();
        await transaction.begin();
        let releasedCount = 0;
        let prefixUpdates = 0;
        try {
            // 5a. Clear group + employer fields on every eligible member. This mirrors the Edit-Member
            //     PUT /api/members/:id "make individual" behavior:
            //       - GroupId        -> NULL  (no longer associated with the group)
            //       - LocationId     -> NULL  (location is a child of the group)
            //       - WorkLocation   -> NULL  (free-text employer location)
            //       - HireDate       -> NULL  (employer hire date no longer applies)
            //     AgentId is intentionally NOT touched: members keep the group's agent as a sensible
            //     default for a bulk operation. A TenantAdmin can override per-member via Edit Member.
            const updateRequest = transaction.request();
            updateRequest.input('groupId', sql.UniqueIdentifier, id);
            updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
            eligibleIds.forEach((mid, i) => updateRequest.input(`m${i}`, sql.UniqueIdentifier, mid));
            const updateParamList = eligibleIds.map((_, i) => `@m${i}`).join(',');
            const updateResult = await updateRequest.query(`
                UPDATE oe.Members
                SET GroupId = NULL,
                    LocationId = NULL,
                    WorkLocation = NULL,
                    HireDate = NULL,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE GroupId = @groupId AND MemberId IN (${updateParamList})
            `);
            releasedCount = updateResult.rowsAffected[0] || 0;

            // 5b. HouseholdMemberID prefix swap. Walks every member in each affected household
            //     (NOT just released members) and rewrites the leading prefix from the group prefix
            //     to the individual prefix while preserving the suffix — so "MW123" becomes "SW123"
            //     and the customer-facing number stays the same. Idempotent on rows that don't carry
            //     the from-prefix (e.g. dependents already individual). This is the same utility the
            //     Edit-Member endpoint uses at backend/routes/members.js ~line 2430.
            if (prefixSwap && householdIds.length > 0) {
                const hhRequest = transaction.request();
                hhRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
                householdIds.forEach((hid, i) => hhRequest.input(`h${i}`, sql.UniqueIdentifier, hid));
                const hhParamList = householdIds.map((_, i) => `@h${i}`).join(',');
                const hhResult = await hhRequest.query(`
                    SELECT MemberId, HouseholdMemberID
                    FROM oe.Members
                    WHERE TenantId = @tenantId AND HouseholdId IN (${hhParamList})
                `);
                for (const row of (hhResult.recordset || [])) {
                    const newHm = swapHouseholdMemberIdPrefix(
                        row.HouseholdMemberID,
                        prefixSwap.fromPrefix,
                        prefixSwap.toPrefix
                    );
                    if (newHm && newHm !== row.HouseholdMemberID) {
                        const swapReq = transaction.request();
                        swapReq.input('memberId', sql.UniqueIdentifier, row.MemberId);
                        swapReq.input('householdMemberID', sql.NVarChar(50), newHm);
                        swapReq.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
                        await swapReq.query(`
                            UPDATE oe.Members
                            SET HouseholdMemberID = @householdMemberID,
                                ModifiedDate = GETDATE(),
                                ModifiedBy = @modifiedBy
                            WHERE MemberId = @memberId
                        `);
                        prefixUpdates++;
                    }
                }
            }

            // 5c. Per-released-member MemberEventLog GROUP_CHANGED entries — same shape as Edit-Member.
            //     Wrapped in IF OBJECT_ID check so this is a no-op on environments that don't have
            //     the table yet.
            for (const mid of eligibleIds) {
                const logReq = transaction.request();
                logReq.input('memberId', sql.UniqueIdentifier, mid);
                logReq.input('eventType', sql.NVarChar, 'GROUP_CHANGED');
                logReq.input('oldGroupId', sql.UniqueIdentifier, id);
                logReq.input('newGroupId', sql.UniqueIdentifier, null);
                logReq.input('oldGroupName', sql.NVarChar, oldGroupName);
                logReq.input('newGroupName', sql.NVarChar, null);
                logReq.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
                await logReq.query(`
                    IF OBJECT_ID('oe.MemberEventLog', 'U') IS NOT NULL
                    BEGIN
                        INSERT INTO oe.MemberEventLog (MemberId, EventType, OldGroupId, NewGroupId, OldGroupName, NewGroupName, CreatedBy)
                        VALUES (@memberId, @eventType, @oldGroupId, @newGroupId, @oldGroupName, @newGroupName, @createdBy)
                    END
                `);
            }

            await transaction.commit();
        } catch (txErr) {
            try { await transaction.rollback(); } catch (_) { /* swallow */ }
            console.error('❌ Release-unenrolled transaction failed; rolled back:', txErr);
            return res.status(500).json({ success: false, message: 'Failed to release members; no changes were applied.' });
        }

        const skippedCount = expandedIds.length - releasedCount;

        await auditLog(
            req.user.UserId,
            'GROUP_RELEASE_UNENROLLED',
            `Released ${releasedCount} unenrolled member(s) from group ${id}`,
            {
                groupId: id,
                groupName: oldGroupName,
                requestedMemberIds: memberIds,
                expandedMemberIds: expandedIds,
                releasedMemberIds: eligibleIds,
                skippedCount,
                householdsAffected: householdIds.length,
                prefixSwapped: prefixUpdates,
                policy: 'unified-with-edit-member-group-change',
            }
        );

        res.json({
            success: true,
            message: `Released ${releasedCount} member${releasedCount === 1 ? '' : 's'} (including dependents) from the group${skippedCount > 0 ? ` (${skippedCount} skipped due to active enrollments)` : ''}.`,
            data: {
                releasedCount,
                skippedCount,
                releasedMemberIds: eligibleIds,
                householdsAffected: householdIds.length,
                prefixSwapped: prefixUpdates,
            }
        });
    } catch (error) {
        console.error('❌ Error releasing unenrolled members:', error);
        res.status(500).json({ success: false, message: 'Failed to release members' });
    }
});

// GET /api/groups/:id/termination-preview — checklist data before terminating (archiving) a group
router.get('/:id/termination-preview', authMiddleware(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, id);

        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const isAgent = userRoles.includes('Agent') && req.user?.currentRole === 'Agent';

        let accessQuery = `
            SELECT g.GroupId, g.TenantId, g.AgentId
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        if (isAgent) {
            const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
            if (accessibleAgentIds.length === 0) {
                return res.status(403).json({ success: false, message: 'Not a valid agent.' });
            }
            const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agTermPreview');
            accessQuery += ` AND ${agentScopeClause}`;
        } else if (!isSysAdmin) {
            request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery += ' AND g.TenantId = @userTenantId';
        }

        const groupResult = await request.query(accessQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        const missingResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, id)
            .query(`
                SELECT COUNT(*) AS MissingCount
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.GroupId = @groupId
                  AND e.TerminationDate IS NULL
            `);
        const enrollmentsMissingTerminationDate = missingResult.recordset[0]?.MissingCount ?? 0;

        const futureHh = await pool.request()
            .input('groupId', sql.UniqueIdentifier, id)
            .query(`
                SELECT
                    m.HouseholdId,
                    (
                        SELECT TOP 1 pu.FirstName + ' ' + pu.LastName
                        FROM oe.Members p
                        INNER JOIN oe.Users pu ON p.UserId = pu.UserId
                        WHERE p.HouseholdId = m.HouseholdId AND p.RelationshipType = 'P'
                    ) AS PrimaryMemberName,
                    MAX(e.TerminationDate) AS LatestTerminationDate
                FROM oe.Members m
                INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
                WHERE m.GroupId = @groupId
                  AND e.TerminationDate IS NOT NULL
                  AND e.TerminationDate > GETUTCDATE()
                GROUP BY m.HouseholdId
                ORDER BY MAX(e.TerminationDate) DESC
            `);

        const recurringResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, id)
            .query(`
                SELECT
                    grp.DimeScheduleId AS scheduleId,
                    ISNULL(gl.Name, 'Primary') AS locationName,
                    grp.MonthlyAmount,
                    grp.NextBillingDate
                FROM oe.GroupRecurringPaymentPlans grp
                LEFT JOIN oe.GroupLocations gl ON grp.LocationId = gl.LocationId
                WHERE grp.GroupId = @groupId
                  AND grp.IsActive = 1
                  AND grp.DimeScheduleId IS NOT NULL
                ORDER BY locationName
            `);

        const householdsWithFutureTermination = (futureHh.recordset || []).map((r) => ({
            householdId: String(r.HouseholdId),
            primaryMemberName: (r.PrimaryMemberName || 'Household').trim(),
            latestTerminationDate: r.LatestTerminationDate ? new Date(r.LatestTerminationDate).toISOString() : null
        }));

        const recurringPayments = (recurringResult.recordset || []).map((r) => ({
            scheduleId: String(r.scheduleId),
            locationName: r.locationName || 'Primary',
            monthlyAmount: parseFloat(r.MonthlyAmount || 0),
            nextBillingDate: r.NextBillingDate ? new Date(r.NextBillingDate).toISOString().slice(0, 10) : null,
            processor: 'DIME'
        }));

        const canTerminate = enrollmentsMissingTerminationDate === 0;

        res.json({
            success: true,
            data: {
                canTerminate,
                enrollmentsMissingTerminationDate,
                householdsWithFutureTermination,
                recurringPayments
            }
        });
    } catch (error) {
        console.error('❌ Error building termination preview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load termination preview'
        });
    }
});

// DELETE /api/groups/:id - Soft delete group (Agent, TenantAdmin, SysAdmin only)
router.delete('/:id', authMiddleware(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, id);

        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const isAgent = userRoles.includes('Agent') && req.user?.currentRole === 'Agent';

        // Resolve group and check access
        let accessQuery = `
            SELECT g.GroupId, g.TenantId, g.AgentId
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        if (isAgent) {
            const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
            if (accessibleAgentIds.length === 0) {
                return res.status(403).json({ success: false, message: 'Not a valid agent.' });
            }
            const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agDelete');
            accessQuery += ` AND ${agentScopeClause}`;
        } else if (!isSysAdmin) {
            request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery += ' AND g.TenantId = @userTenantId';
        }

        const groupResult = await request.query(accessQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        const tenantId = groupResult.recordset[0].TenantId;

        // Every enrollment must have a TerminationDate set (past or future) before the group can be terminated
        const enrollRequest = pool.request().input('groupId', sql.UniqueIdentifier, id);
        const enrollResult = await enrollRequest.query(`
            SELECT COUNT(*) AS MissingCount
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE m.GroupId = @groupId
              AND e.TerminationDate IS NULL
        `);
        const missingCount = enrollResult.recordset[0]?.MissingCount ?? 0;
        if (missingCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot terminate group: ${missingCount} enrollment(s) still have no TerminationDate. Set termination dates on all enrollments first.`
            });
        }

        const cancelOutcome = await cancelGroupRecurringPaymentsInDimeAndDb(pool, id, tenantId);
        if (!cancelOutcome.success) {
            return res.status(502).json({
                success: false,
                message: cancelOutcome.error || 'Failed to cancel recurring payment(s) in DIME',
                scheduleId: cancelOutcome.scheduleId
            });
        }

        request.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        const updateResult = await request.query(`
            UPDATE oe.Groups
            SET Status = 'Archived',
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE GroupId = @groupId
        `);

        if (updateResult.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        res.json({
            success: true,
            message: 'Group terminated successfully'
        });

    } catch (error) {
        console.error('❌ Error archiving group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to terminate group'
        });
    }
});

// POST /api/groups/:id/restore — set Status back to Active (undo soft-delete / unterminate)
router.post('/:id/restore', authMiddleware(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, id);

        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const isAgent = userRoles.includes('Agent') && req.user?.currentRole === 'Agent';

        let accessQuery = `
            SELECT g.GroupId, g.Status
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        if (isAgent) {
            const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
            if (accessibleAgentIds.length === 0) {
                return res.status(403).json({ success: false, message: 'Not a valid agent.' });
            }
            const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agRestore');
            accessQuery += ` AND ${agentScopeClause}`;
        } else if (!isSysAdmin) {
            request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery += ' AND g.TenantId = @userTenantId';
        }

        const groupResult = await request.query(accessQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        if (groupResult.recordset[0].Status !== 'Archived') {
            return res.status(400).json({
                success: false,
                message: 'Only archived (terminated) groups can be restored.'
            });
        }

        request.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        const updateResult = await request.query(`
            UPDATE oe.Groups
            SET Status = 'Active',
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE GroupId = @groupId AND Status = 'Archived'
        `);

        if (updateResult.rowsAffected[0] === 0) {
            return res.status(400).json({
                success: false,
                message: 'Group could not be restored'
            });
        }

        res.json({
            success: true,
            message: 'Group restored successfully'
        });
    } catch (error) {
        console.error('❌ Error restoring group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to restore group'
        });
    }
});

// =============================================================================
// ENROLLMENT TOKENS ROUTES
// =============================================================================

// GET /api/groups/:id/enrollment-tokens - Get enrollment tokens for a group
router.get('/:id/enrollment-tokens', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const pool = await getPool();
        
        // First verify the user has access to this group
        const accessCheck = pool.request();
        accessCheck.input('groupId', sql.UniqueIdentifier, groupId);
        
        let accessQuery;
        if (getUserRoles(req.user).includes('SysAdmin')) {
            accessQuery = 'SELECT GroupId FROM oe.Groups WHERE GroupId = @groupId';
        } else {
            accessCheck.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery = 'SELECT GroupId FROM oe.Groups WHERE GroupId = @groupId AND TenantId = @userTenantId';
        }
        
        const accessResult = await accessCheck.query(accessQuery);
        if (accessResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        // For now, return empty array since we don't have enrollment tokens table yet
        // TODO: Implement actual enrollment tokens table and query
        const mockTokens = [];
        
        res.json({
            success: true,
            data: mockTokens
        });

    } catch (error) {
        console.error('❌ Error fetching enrollment tokens:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrollment tokens'
        });
    }
});

// =============================================================================
// ENROLLMENT PERIOD ROUTES
// =============================================================================

// GET /api/groups/:id/enrollment-period/status
router.get('/:id/enrollment-period/status', authMiddleware(['GroupAdmin', 'Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const pool = await getPool();
        
        // Get group enrollment status
        const query = `
            SELECT 
                g.GroupId,
                g.Name as GroupName,
                g.IsInInitialEnrollmentPeriod,
                g.InitialEnrollmentPeriodStart,
                g.InitialEnrollmentPeriodEnd,
                g.EarliestEffectiveDate,
                g.InitialEnrollmentPeriodSetBy,
                g.InitialEnrollmentPeriodSetDate,
                (SELECT COUNT(DISTINCT e.MemberId) 
                 FROM oe.Enrollments e 
                 JOIN oe.Members m ON e.MemberId = m.MemberId 
                 WHERE m.GroupId = g.GroupId AND e.Status = 'Active') as EnrolledMembersCount,
                (SELECT COUNT(*) 
                 FROM oe.Members m 
                 WHERE m.GroupId = g.GroupId AND m.Status = 'Active') as TotalMembersCount
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        
        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        
        const group = result.recordset[0];
        
        // Determine if enrollment period is needed
        const needsEnrollmentPeriod = group.EnrolledMembersCount === 0 && 
            (!group.InitialEnrollmentPeriodStart || !group.InitialEnrollmentPeriodEnd);
        
        // Calculate benefit start date (1st of month after period ends)
        let benefitStartDate = null;
        let earliestEffectiveDate = null;
        if (group.InitialEnrollmentPeriodEnd) {
            const endDateStr = group.InitialEnrollmentPeriodEnd.toISOString ? 
                group.InitialEnrollmentPeriodEnd.toISOString().split('T')[0] : 
                group.InitialEnrollmentPeriodEnd;
            const [year, month, day] = endDateStr.split('-').map(Number);
            const periodEnd = new Date(year, month - 1, day);
            const benefitStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, 1);
            benefitStartDate = benefitStart.toISOString().split('T')[0];
            
            // Get earliest effective date if set, otherwise use default
            if (group.EarliestEffectiveDate) {
                earliestEffectiveDate = group.EarliestEffectiveDate.toISOString ? 
                    group.EarliestEffectiveDate.toISOString().split('T')[0] : 
                    group.EarliestEffectiveDate;
            } else {
                earliestEffectiveDate = benefitStartDate;
            }
        }
        
        // Determine period status: upcoming, active, or ended
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        
        let periodStatus = null;
        let isPeriodActive = false;
        let isPeriodUpcoming = false;
        let isPeriodEnded = false;
        
        if (group.IsInInitialEnrollmentPeriod && group.InitialEnrollmentPeriodStart && group.InitialEnrollmentPeriodEnd) {
            const startDateStr = group.InitialEnrollmentPeriodStart.toISOString ? 
                group.InitialEnrollmentPeriodStart.toISOString().split('T')[0] : 
                group.InitialEnrollmentPeriodStart;
            const endDateStr = group.InitialEnrollmentPeriodEnd.toISOString ? 
                group.InitialEnrollmentPeriodEnd.toISOString().split('T')[0] : 
                group.InitialEnrollmentPeriodEnd;
            
            const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
            const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
            
            const periodStart = new Date(startYear, startMonth - 1, startDay);
            const periodEnd = new Date(endYear, endMonth - 1, endDay);
            periodStart.setHours(0, 0, 0, 0);
            periodEnd.setHours(23, 59, 59, 999);
            
            if (now < periodStart) {
                periodStatus = 'upcoming';
                isPeriodUpcoming = true;
            } else if (now >= periodStart && now <= periodEnd) {
                periodStatus = 'active';
                isPeriodActive = true;
            } else {
                periodStatus = 'ended';
                isPeriodEnded = true;
            }
        }
        
        res.json({
            success: true,
            data: {
                needsEnrollmentPeriod,
                hasEnrolledMembers: group.EnrolledMembersCount > 0,
                totalMembers: group.TotalMembersCount,
                enrolledMembers: group.EnrolledMembersCount,
                currentPeriod: group.InitialEnrollmentPeriodStart && group.InitialEnrollmentPeriodEnd ? {
                    startDate: new Date(group.InitialEnrollmentPeriodStart).toISOString().split('T')[0],
                    endDate: new Date(group.InitialEnrollmentPeriodEnd).toISOString().split('T')[0],
                    isActive: isPeriodActive,
                    isUpcoming: isPeriodUpcoming,
                    isEnded: isPeriodEnded,
                    status: periodStatus,
                    benefitStartDate: benefitStartDate,
                    earliestEffectiveDate: earliestEffectiveDate,
                    setBy: group.InitialEnrollmentPeriodSetBy,
                    setDate: group.InitialEnrollmentPeriodSetDate
                } : null
            }
        });
        
    } catch (error) {
        logger.error('Error checking enrollment period status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check enrollment period status'
        });
    }
});

// POST /api/groups/:id/enrollment-period
router.post('/:id/enrollment-period', authMiddleware(['GroupAdmin', 'Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const { startDate, endDate, earliestEffectiveDate } = req.body;
        
        logger.info(`📝 Setting enrollment period for group ${groupId}: ${startDate} to ${endDate}, earliestEffectiveDate: ${earliestEffectiveDate}`);
        console.log('📝 Setting enrollment period:', { groupId, startDate, endDate, earliestEffectiveDate, body: req.body });
        
        const pool = await getPool();
        
        // Validate input
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: 'Start date and end date are required'
            });
        }
        
        // NOTE: earliestEffectiveDate validation (day-of-month + range) is
        // performed below, AFTER we've loaded the group's AllowMidMonthEffective
        // flag from the DB. Validation depends on that flag: if it's on, day 15
        // is also an acceptable choice.

        // Validation rules
        if (endDate <= startDate) {
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date',
                code: 'INVALID_END_DATE'
            });
        }
        
        // Parse dates for database insertion (use UTC to avoid timezone issues)
        const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
        const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
        const start = new Date(Date.UTC(startYear, startMonth - 1, startDay));
        const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));
        
        // Check if group already has enrolled members
        const enrollmentCheckQuery = `
            SELECT COUNT(DISTINCT e.MemberId) as EnrolledCount
            FROM oe.Enrollments e
            JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE m.GroupId = @groupId AND e.Status = 'Active'
        `;
        
        // Check if period is already set. Also fetch AllowMidMonthEffective so we
        // can validate earliestEffectiveDate against the group's cohort policy.
        const existingPeriodQuery = `
            SELECT InitialEnrollmentPeriodStart, InitialEnrollmentPeriodEnd, AllowMidMonthEffective
            FROM oe.Groups
            WHERE GroupId = @groupId
        `;

        const existingPeriodResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(existingPeriodQuery);

        if (existingPeriodResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }

        const existingPeriod = existingPeriodResult.recordset[0];
        // `existingPeriod` doubles as the group context for cohort-flag lookups.
        const group = existingPeriod;

        // Validate earliestEffectiveDate against the group's cohort flag now that
        // we've loaded it. Parse as UTC so getUTCDate() matches the calendar day
        // the user picked, regardless of server timezone.
        if (earliestEffectiveDate) {
            const [eyY, eyM, eyD] = earliestEffectiveDate.split('-').map(Number);
            const earliestDate = new Date(Date.UTC(eyY, eyM - 1, eyD));
            if (!isValidEarliestEffectiveDate(earliestDate, group)) {
                return res.status(400).json({
                    success: false,
                    message: group && (group.AllowMidMonthEffective === true || group.AllowMidMonthEffective === 1)
                        ? 'Earliest effective date must be the 1st or 15th of a month'
                        : 'Earliest effective date must be the 1st of a month',
                    code: 'INVALID_EARLIEST_EFFECTIVE_DATE'
                });
            }

            // Must be after enrollment period ends
            const [endYear2, endMonth2, endDay2] = endDate.split('-').map(Number);
            const periodEnd = new Date(Date.UTC(endYear2, endMonth2 - 1, endDay2));
            if (earliestDate < periodEnd) {
                return res.status(400).json({
                    success: false,
                    message: 'Earliest effective date must be after the enrollment period ends',
                    code: 'INVALID_EARLIEST_EFFECTIVE_DATE'
                });
            }
        }
        
        // Only allow modifying if no enrollment links have been sent yet (unless force is true)
        const force = req.body.force === true || req.query.force === 'true';
        if (existingPeriod.InitialEnrollmentPeriodStart && existingPeriod.InitialEnrollmentPeriodEnd && !force) {
            // Check if any enrollment links have been sent for this group
            const linksCheckQuery = `
                SELECT COUNT(*) as LinkCount
                FROM oe.EnrollmentLinks
                WHERE GroupId = @groupId
            `;
            const linksCheckResult = await pool.request()
                .input('groupId', sql.UniqueIdentifier, groupId)
                .query(linksCheckQuery);
            
            const linkCount = linksCheckResult.recordset[0].LinkCount;
            
            if (linkCount > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot modify enrollment period after enrollment links have been sent',
                    code: 'LINKS_ALREADY_SENT'
                });
            }
        }
        
        // Calculate benefit start date (1st of month after period ends)
        const benefitStart = new Date(Date.UTC(endYear, endMonth, 1));
        const benefitStartDate = benefitStart.toISOString().split('T')[0];
        
        // Parse earliestEffectiveDate if provided, otherwise use default (1st of month after period ends)
        let earliestEffective = null;
        if (earliestEffectiveDate) {
            const [earliestYear, earliestMonth, earliestDay] = earliestEffectiveDate.split('-').map(Number);
            earliestEffective = new Date(Date.UTC(earliestYear, earliestMonth - 1, earliestDay));
        } else {
            // Default to 1st of month after period ends
            earliestEffective = benefitStart;
        }
        
        // Verify req.user exists
        if (!req.user || !req.user.UserId) {
            console.error('❌ req.user or req.user.UserId is missing:', { user: req.user });
            return res.status(401).json({
                success: false,
                message: 'User authentication required'
            });
        }
        
        console.log('📝 User ID for enrollment period:', req.user.UserId);
        
        // Set enrollment period - include earliestEffectiveDate if column exists
        // Note: If EarliestEffectiveDate column doesn't exist yet, this will need a migration
        const updateQuery = `
            UPDATE oe.Groups
            SET 
                InitialEnrollmentPeriodStart = @startDate,
                InitialEnrollmentPeriodEnd = @endDate,
                ${earliestEffectiveDate ? 'EarliestEffectiveDate = @earliestEffectiveDate,' : ''}
                IsInInitialEnrollmentPeriod = 1,
                InitialEnrollmentPeriodSetBy = @userId,
                InitialEnrollmentPeriodSetDate = GETUTCDATE(),
                ModifiedDate = GETUTCDATE()
            WHERE GroupId = @groupId
        `;
        
        console.log('📝 Executing UPDATE query for enrollment period...');
        console.log('📝 Query parameters:', { groupId, start, end, earliestEffectiveDate, userId: req.user.UserId });
        
        const request = pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('startDate', sql.DateTime2, start)
            .input('endDate', sql.DateTime2, end)
            .input('userId', sql.UniqueIdentifier, req.user.UserId);
        
        if (earliestEffectiveDate) {
            request.input('earliestEffectiveDate', sql.Date, earliestEffective);
        }
        
        const updateResult = await request.query(updateQuery);
            
        console.log('✅ UPDATE query completed, rows affected:', updateResult.rowsAffected);
        logger.info(`✅ Initial enrollment period set for group ${groupId}: ${startDate} to ${endDate}`);
        
        // Get today's date in YYYY-MM-DD format for isActive check
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        
        res.json({
            success: true,
            message: 'Initial enrollment period set successfully',
            data: {
                groupId,
                startDate: startDate,
                endDate: endDate,
                earliestEffectiveDate: earliestEffectiveDate || benefitStartDate,
                benefitStartDate: benefitStartDate,
                isActive: startDate <= todayStr && endDate >= todayStr
            }
        });
        
    } catch (error) {
        console.error('❌ Error setting enrollment period:', error);
        logger.error('Error setting enrollment period:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to set enrollment period',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// PUT /api/groups/:id/enrollment-period
router.put('/:id/enrollment-period', authMiddleware(['GroupAdmin', 'Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const { startDate, endDate, earliestEffectiveDate } = req.body;
        const pool = await getPool();
        
        // Validate input
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: 'Start date and end date are required'
            });
        }
        
        // NOTE: earliestEffectiveDate validation is deferred until after we've
        // loaded the group's AllowMidMonthEffective flag below — the allowable
        // days-of-month depend on that flag.

        // Validation rules
        if (endDate <= startDate) {
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date',
                code: 'INVALID_END_DATE'
            });
        }

        // Parse dates for database insertion (use UTC to avoid timezone issues)
        const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
        const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
        const start = new Date(Date.UTC(startYear, startMonth - 1, startDay));
        const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));

        // Get existing period (and the AllowMidMonthEffective flag, used below
        // to validate earliestEffectiveDate against the group's cohort policy).
        const existingQuery = `
            SELECT InitialEnrollmentPeriodStart, InitialEnrollmentPeriodEnd, AllowMidMonthEffective
            FROM oe.Groups
            WHERE GroupId = @groupId
        `;
        
        const existingResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(existingQuery);
        
        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        
        const existing = existingResult.recordset[0];
        // `existing` doubles as the group context for cohort-flag lookups.
        const group = existing;

        if (!existing.InitialEnrollmentPeriodStart) {
            return res.status(400).json({
                success: false,
                message: 'No enrollment period has been set yet. Use POST to create one.',
                code: 'NO_PERIOD_SET'
            });
        }

        // Validate earliestEffectiveDate against the group's cohort flag now that
        // we've loaded it.
        if (earliestEffectiveDate) {
            const [eyY, eyM, eyD] = earliestEffectiveDate.split('-').map(Number);
            const earliestDateCheck = new Date(Date.UTC(eyY, eyM - 1, eyD));
            if (!isValidEarliestEffectiveDate(earliestDateCheck, group)) {
                return res.status(400).json({
                    success: false,
                    message: group && (group.AllowMidMonthEffective === true || group.AllowMidMonthEffective === 1)
                        ? 'Earliest effective date must be the 1st or 15th of a month'
                        : 'Earliest effective date must be the 1st of a month',
                    code: 'INVALID_EARLIEST_EFFECTIVE_DATE'
                });
            }
        }
        
        // Check if any enrollment links have been sent (unless force is true)
        const force = req.body.force === true || req.query.force === 'true';
        if (!force) {
            const linksCheckQuery = `
                SELECT COUNT(*) as LinkCount
                FROM oe.EnrollmentLinks
                WHERE GroupId = @groupId
            `;
            const linksCheckResult = await pool.request()
                .input('groupId', sql.UniqueIdentifier, groupId)
                .query(linksCheckQuery);
            
            const linkCount = linksCheckResult.recordset[0].LinkCount;
            
            if (linkCount > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot modify enrollment period after enrollment links have been sent',
                    code: 'LINKS_ALREADY_SENT'
                });
            }
        }
        
        // Calculate benefit start date (1st of month after period ends)
        const benefitStart = new Date(Date.UTC(endYear, endMonth, 1));
        const benefitStartDate = benefitStart.toISOString().split('T')[0];
        
        // Parse earliestEffectiveDate if provided, otherwise use default (1st of month after period ends)
        let earliestEffective = null;
        if (earliestEffectiveDate) {
            const [earliestYear, earliestMonth, earliestDay] = earliestEffectiveDate.split('-').map(Number);
            earliestEffective = new Date(Date.UTC(earliestYear, earliestMonth - 1, earliestDay));
        } else {
            // Default to 1st of month after period ends
            earliestEffective = benefitStart;
        }
        
        // Verify req.user exists
        if (!req.user || !req.user.UserId) {
            console.error('❌ req.user or req.user.UserId is missing:', { user: req.user });
            return res.status(401).json({
                success: false,
                message: 'User authentication required'
            });
        }
        
        // Update enrollment period - include earliestEffectiveDate if column exists
        const updateQuery = `
            UPDATE oe.Groups
            SET 
                InitialEnrollmentPeriodStart = @startDate,
                InitialEnrollmentPeriodEnd = @endDate,
                ${earliestEffectiveDate ? 'EarliestEffectiveDate = @earliestEffectiveDate,' : ''}
                IsInInitialEnrollmentPeriod = 1,
                InitialEnrollmentPeriodSetBy = @userId,
                InitialEnrollmentPeriodSetDate = GETUTCDATE(),
                ModifiedDate = GETUTCDATE()
            WHERE GroupId = @groupId
        `;
        
        const request = pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('startDate', sql.DateTime2, start)
            .input('endDate', sql.DateTime2, end)
            .input('userId', sql.UniqueIdentifier, req.user.UserId);
        
        if (earliestEffectiveDate) {
            request.input('earliestEffectiveDate', sql.Date, earliestEffective);
        }
        
        await request.query(updateQuery);
        
        logger.info(`✅ Enrollment period updated for group ${groupId}: ${startDate} to ${endDate}, earliestEffectiveDate: ${earliestEffectiveDate || benefitStartDate}`);
        
        // Calculate if period is currently active
        const today = new Date();
        const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        const todayStr = `${todayUTC.getUTCFullYear()}-${String(todayUTC.getUTCMonth() + 1).padStart(2, '0')}-${String(todayUTC.getUTCDate()).padStart(2, '0')}`;
        const isActive = startDate <= todayStr && endDate >= todayStr;
        
        res.json({
            success: true,
            message: 'Enrollment period updated successfully',
            data: {
                groupId,
                startDate: startDate,
                endDate: endDate,
                earliestEffectiveDate: earliestEffectiveDate || benefitStartDate,
                benefitStartDate: benefitStartDate,
                isActive: isActive
            }
        });
        
    } catch (error) {
        logger.error('Error updating enrollment period:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update enrollment period',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET /api/groups/:id/eligible-members - Get count and IDs of eligible members for enrollment links
router.get('/:id/eligible-members', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const pool = await getPool();
        
        // Get eligible members: Active, Primary members, Not enrolled, No active enrollment links
        const eligibleQuery = `
            SELECT 
                m.MemberId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.GroupId = @groupId
                AND m.Status = 'Active'
                AND m.RelationshipType = 'P'
                AND NOT EXISTS (
                    SELECT 1 
                    FROM oe.Enrollments e 
                    WHERE e.MemberId = m.MemberId 
                    AND e.Status IN ('Active', 'Pending')
                )
                AND NOT EXISTS (
                    SELECT 1 
                    FROM oe.EnrollmentLinks el 
                    WHERE el.MemberId = m.MemberId 
                    AND el.IsActive = 1
                    AND el.UsageCount = 0
                )
            ORDER BY u.LastName, u.FirstName
        `;
        
        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(eligibleQuery);
        
        res.json({
            success: true,
            data: {
                count: result.recordset.length,
                members: result.recordset
            }
        });
    } catch (error) {
        console.error('❌ Error getting eligible members:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get eligible members'
        });
    }
});

// POST /api/groups/:id/send-enrollment-links - Send enrollment links to members
router.post('/:id/send-enrollment-links', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const { memberIds, templateId, deliveryPreferences, phoneNumbers, linkBaseUrl, includeMembersScheduledForTermination } = req.body;
        
        // Default to email if not specified
        const sendEmail = deliveryPreferences?.sendEmail !== false; // Default true
        const sendSMS = deliveryPreferences?.sendSMS === true;
        
        // Validate that at least one delivery method is selected
        if (!sendEmail && !sendSMS) {
            return res.status(400).json({
                success: false,
                message: 'At least one delivery method (email or SMS) must be selected'
            });
        }
        const pool = await getPool();
        
        // Validate input
        if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Member IDs are required'
            });
        }
        
        if (!templateId) {
            return res.status(400).json({
                success: false,
                message: 'Template ID is required'
            });
        }
        
        // Fetch group info including name - don't rely on frontend to send it
        const groupInfoQuery = `
            SELECT Name, PrimaryContact, ContactEmail, ContactPhone
            FROM oe.Groups
            WHERE GroupId = @groupId
        `;
        const groupInfoResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(groupInfoQuery);
        
        if (groupInfoResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        
        const groupInfo = groupInfoResult.recordset[0];
        const groupName = groupInfo.Name; // Get groupName from database
        
        console.log(`📋 Sending enrollment links for group: ${groupName} (${groupId})`);
        
        if (!groupInfo.PrimaryContact || !groupInfo.ContactEmail) {
            return res.status(400).json({
                success: false,
                message: 'Group must have Primary Contact and Contact Email set up before sending enrollment links',
                details: {
                    missingPrimaryContact: !groupInfo.PrimaryContact,
                    missingContactEmail: !groupInfo.ContactEmail
                }
            });
        }
        
        // First verify the user has access to this group
        const accessCheck = pool.request();
        accessCheck.input('groupId', sql.UniqueIdentifier, groupId);
        
        let accessQuery;
        if (getUserRoles(req.user).includes('SysAdmin')) {
            accessQuery = 'SELECT GroupId FROM oe.Groups WHERE GroupId = @groupId';
        } else {
            accessCheck.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery = 'SELECT GroupId FROM oe.Groups WHERE GroupId = @groupId AND TenantId = @userTenantId';
        }
        
        const accessResult = await accessCheck.query(accessQuery);
        if (accessResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        // Verify the template exists and is a Group type
        const template = await EnrollmentLinkService.validateTemplate(
            templateId, 
            req.user.TenantId, 
            getUserRoles(req.user).join(', '), 
            pool
        );
        
        if (!template) {
            return res.status(400).json({
                success: false,
                message: 'Invalid template or template not found'
            });
        }
        
        // Fetch full template data to get AgentId/AgencyId
        const templateDataQuery = `
          SELECT AgentId, AgencyId
          FROM oe.EnrollmentLinkTemplates
          WHERE TemplateId = @templateId
        `;
        const templateDataRequest = pool.request();
        templateDataRequest.input('templateId', sql.UniqueIdentifier, templateId);
        const templateDataResult = await templateDataRequest.query(templateDataQuery);
        const templateData = templateDataResult.recordset[0] || {};
        
        console.log('🔍 DEBUG: Template agent/agency data:', {
            agentId: templateData.AgentId,
            agencyId: templateData.AgencyId
        });
        
        // Check if group needs initial enrollment period set
        const enrollmentCheckQuery = `
            SELECT 
                g.IsInInitialEnrollmentPeriod,
                g.InitialEnrollmentPeriodStart,
                g.InitialEnrollmentPeriodEnd,
                (SELECT COUNT(DISTINCT e.MemberId) 
                 FROM oe.Enrollments e 
                 JOIN oe.Members m ON e.MemberId = m.MemberId 
                 WHERE m.GroupId = @groupId AND e.Status = 'Active') as EnrolledMembersCount
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        const enrollmentCheckResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(enrollmentCheckQuery);
        
        if (enrollmentCheckResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        
        const groupEnrollmentStatus = enrollmentCheckResult.recordset[0];

        // Enrollment period is optional; when set it extends link expiration and can define benefit start. Do not block sending links.

        // Calculate expiration hours based on enrollment period
        let expirationHours = DEFAULT_LINK_EXPIRATION_HOURS;

        if (groupEnrollmentStatus.IsInInitialEnrollmentPeriod && groupEnrollmentStatus.InitialEnrollmentPeriodEnd) {
            const periodEnd = new Date(groupEnrollmentStatus.InitialEnrollmentPeriodEnd);
            const now = new Date();
            const hoursUntilPeriodEnd = Math.ceil((periodEnd - now) / (1000 * 60 * 60));

            // Use the greater of 7 days or time until period ends
            expirationHours = Math.max(DEFAULT_LINK_EXPIRATION_HOURS, hoursUntilPeriodEnd);
            
            console.log('🔍 Initial enrollment period active - extended link expiration:', {
                periodEnd: periodEnd.toISOString(),
                hoursUntilEnd: hoursUntilPeriodEnd,
                expirationHours: expirationHours
            });
        }
        
        // When copy or send link is used: if a member's existing enrollment link has expired, generate a new one.
        // Deactivate expired links for this group + template so we never reuse them.
        await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('templateId', sql.UniqueIdentifier, templateId)
            .query(`
                UPDATE oe.EnrollmentLinks
                SET IsActive = 0, ModifiedDate = GETUTCDATE()
                WHERE GroupId = @groupId AND EnrollmentLinkTemplateId = @templateId AND IsActive = 1
                  AND ExpiresAt IS NOT NULL AND ExpiresAt <= GETUTCDATE()
            `);
        
        // Check each member for existing non-expired links or eligibility for new links
        // We'll resend existing links if they exist and are valid, otherwise create new ones
        // Wizard flow: when a Standard→ListBill (or reverse) conversion has just
        // run, members who were Active on the old SKU now carry a TerminationDate
        // (set to the last day of the current month). They look "enrolled" by
        // status but the enrollment is scheduled to END and they need a fresh
        // link for the next period — so the wizard opts in to ignore any
        // enrollment that has *any* TerminationDate set (past OR future).
        // Without `> GETUTCDATE()`: future-dated terminations also get excluded
        // (the earlier version missed this case and skipped sending letFinish
        // links to members whose termination was a few days out).
        const scheduledTerminationClause = includeMembersScheduledForTermination
            ? 'AND e.TerminationDate IS NULL'
            : '';
        const memberLinksQuery = `
            SELECT
                m.MemberId,
                -- Check if member is enrolled (ineligible)
                CASE WHEN EXISTS (
                    SELECT 1
                    FROM oe.Enrollments e
                    WHERE e.MemberId = m.MemberId
                    AND e.Status IN ('Active', 'Pending')
                    ${scheduledTerminationClause}
                ) THEN 1 ELSE 0 END as IsEnrolled,
                -- Get existing non-expired link if available
                el.LinkId as ExistingLinkId,
                el.LinkToken as ExistingLinkToken,
                el.LinkUrl as ExistingLinkUrl,
                el.ExpiresAt as ExistingExpiresAt,
                el.UsageCount as ExistingUsageCount,
                el.MaxUsage as ExistingMaxUsage
            FROM oe.Members m
            LEFT JOIN oe.EnrollmentLinks el ON m.MemberId = el.MemberId 
                AND el.IsActive = 1 
                AND el.EnrollmentLinkTemplateId = @templateId
                AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE())
                AND (el.MaxUsage IS NULL OR el.UsageCount < el.MaxUsage)
            WHERE m.GroupId = @groupId
                AND m.Status = 'Active'
                AND m.RelationshipType = 'P'
                AND m.MemberId IN (${memberIds.map((_, i) => `@memberId${i}`).join(', ')})
        `;
        
        const memberLinksRequest = pool.request();
        memberLinksRequest.input('groupId', sql.UniqueIdentifier, groupId);
        memberLinksRequest.input('templateId', sql.UniqueIdentifier, templateId);
        memberIds.forEach((id, i) => {
            memberLinksRequest.input(`memberId${i}`, sql.UniqueIdentifier, id);
        });
        
        const memberLinksResult = await memberLinksRequest.query(memberLinksQuery);
        
        // Separate members into: enrolled (skip), with existing links (resend), need new links (create)
        const enrolledMemberIds = [];
        const membersWithExistingLinks = [];
        const membersNeedingNewLinks = [];
        
        memberLinksResult.recordset.forEach(row => {
            if (row.IsEnrolled) {
                enrolledMemberIds.push(row.MemberId.toString());
            } else if (row.ExistingLinkId && !linkBaseUrl) {
                // Member has existing valid link - use it (unless base URL changed; then create new links)
                membersWithExistingLinks.push({
                    memberId: row.MemberId.toString(),
                    linkId: row.ExistingLinkId.toString(),
                    linkToken: row.ExistingLinkToken,
                    enrollmentUrl: row.ExistingLinkUrl,
                    expiresAt: row.ExistingExpiresAt,
                    usageCount: row.ExistingUsageCount,
                    maxUsage: row.ExistingMaxUsage
                });
            } else {
                // Member needs a new link (or linkBaseUrl changed so we create new links for all)
                membersNeedingNewLinks.push(row.MemberId.toString());
            }
        });
        
        if (enrolledMemberIds.length === memberIds.length) {
            return res.status(400).json({
                success: false,
                message: 'All selected members are already enrolled.',
                data: {
                    enrolledCount: enrolledMemberIds.length
                }
            });
        }
        
        console.log(`📊 Member link status: ${membersWithExistingLinks.length} with existing links, ${membersNeedingNewLinks.length} need new links, ${enrolledMemberIds.length} already enrolled`);
        
        // When linkBaseUrl is provided, invalidate existing links for members we're creating new links for (so only the new-URL links are valid)
        if (membersNeedingNewLinks.length > 0 && linkBaseUrl && String(linkBaseUrl).trim()) {
            const placeholders = membersNeedingNewLinks.map((_, i) => `@memberId${i}`).join(', ');
            const invalidateQuery = `
                UPDATE oe.EnrollmentLinks SET IsActive = 0, ModifiedDate = GETUTCDATE()
                WHERE MemberId IN (${placeholders}) AND IsActive = 1
            `;
            const invalidateRequest = pool.request();
            membersNeedingNewLinks.forEach((id, i) => invalidateRequest.input(`memberId${i}`, sql.UniqueIdentifier, id));
            await invalidateRequest.query(invalidateQuery);
            console.log(`🔗 Invalidated existing enrollment links for ${membersNeedingNewLinks.length} members (new base URL requested)`);
        }
        
        // Create new links only for members who need them
        let createdLinks = [];
        if (membersNeedingNewLinks.length > 0) {
            // If expiration is based on enrollment period end, pass the actual date
            let expiresAtDate = null;
            if (groupEnrollmentStatus.IsInInitialEnrollmentPeriod && groupEnrollmentStatus.InitialEnrollmentPeriodEnd) {
                const periodEnd = new Date(groupEnrollmentStatus.InitialEnrollmentPeriodEnd);
                if (periodEnd > new Date()) {
                    expiresAtDate = periodEnd;
                }
                // If period end is in the past, leave null so we use expirationHours (7 days) and links are not already expired
            }
            
            createdLinks = await EnrollmentLinkService.createGroupEnrollmentLinks({
                memberIds: membersNeedingNewLinks,
                templateId,
                groupId,
                groupName,
                templateName: template.TemplateName,
                effectiveDate: null,
                createdBy: req.user.UserId,
                expirationHours: expirationHours,
                expiresAtDate: expiresAtDate,
                req,
                agentId: templateData.AgentId,
                agencyId: templateData.AgencyId,
                baseUrlOverride: linkBaseUrl && String(linkBaseUrl).trim() ? linkBaseUrl.trim() : undefined
            });
            
            console.log(`✅ Created ${createdLinks.length} new enrollment links for group ${groupName}`);
        }
        
        // Combine existing links and newly created links
        const allLinks = [
            ...membersWithExistingLinks.map(link => ({
                memberId: link.memberId,
                linkToken: link.linkToken,
                enrollmentUrl: link.enrollmentUrl,
                expiresAt: link.expiresAt,
                isExisting: true
            })),
            ...createdLinks.map(link => ({
                memberId: link.memberId,
                linkToken: link.linkToken,
                enrollmentUrl: link.enrollmentUrl,
                expiresAt: link.expiresAt,
                isExisting: false
            }))
        ];
        
        console.log(`✅ Total ${allLinks.length} enrollment links ready to send (${membersWithExistingLinks.length} existing, ${createdLinks.length} new)`);
        console.log('🔗 Enrollment Links:');
        allLinks.forEach((link, index) => {
            console.log(`  ${index + 1}. Member ID: ${link.memberId} (${link.isExisting ? 'existing' : 'new'})`);
            console.log(`     Link: ${link.enrollmentUrl}`);
            console.log(`     Token: ${link.linkToken}`);
            console.log('     ---');
        });
        
        // Note: Recurring payment plan setup is handled during enrollment completion, not here
        // This ensures we only create recurring payments when there are actual premiums to collect

        // Update setup status since enrollment links were created
        try {
            const { updateSetupStatus } = require('../services/setupStatus.service');
            await updateSetupStatus(groupId);
            console.log(`✅ Updated setup status for group ${groupId} after creating ${createdLinks.length} enrollment links`);
        } catch (error) {
            console.warn('⚠️ Failed to update setup status:', error.message);
        }
        
        // Send enrollment invitation emails and/or SMS for all links (existing and new)
        const MessageQueueService = require('../services/messageQueue.service');
        const emailResults = [];
        const smsResults = [];
        
        for (const link of allLinks) {
          try {
            // Get member info
            const memberQuery = `
              SELECT u.FirstName, u.Email, u.PhoneNumber, m.UserId, u.PhoneNumber as UserPhoneNumber
              FROM oe.Members m
              LEFT JOIN oe.Users u ON m.UserId = u.UserId
              WHERE m.MemberId = @memberId
            `;
            const memberRequest = pool.request();
            memberRequest.input('memberId', sql.UniqueIdentifier, link.memberId);
            const memberResult = await memberRequest.query(memberQuery);
            
            if (memberResult.recordset.length > 0) {
              const member = memberResult.recordset[0];
              
              // Update phone number if provided and different (phone number is in Users table)
              let phoneNumberToUse = member.PhoneNumber;
              if (phoneNumbers && phoneNumbers[link.memberId]) {
                const newPhoneNumber = phoneNumbers[link.memberId].trim();
                if (newPhoneNumber && newPhoneNumber !== phoneNumberToUse) {
                  // Update phone number in Users table (primary location for phone numbers)
                  if (member.UserId) {
                    const updatePhoneQuery = `
                      UPDATE oe.Users
                      SET PhoneNumber = @phoneNumber, ModifiedDate = GETUTCDATE()
                      WHERE UserId = @userId
                    `;
                    const updateRequest = pool.request();
                    updateRequest.input('phoneNumber', sql.NVarChar, newPhoneNumber);
                    updateRequest.input('userId', sql.UniqueIdentifier, member.UserId);
                    await updateRequest.query(updatePhoneQuery);
                    console.log(`✅ Updated phone number for user ${member.UserId}: ${newPhoneNumber}`);
                  }
                  
                  // Note: Phone numbers are only stored in Users table, not Members table
                  
                  phoneNumberToUse = newPhoneNumber;
                }
              }
              
              // Send email if requested
              if (sendEmail && member.Email) {
                try {
                  const messageId = await MessageQueueService.sendEnrollmentInvitation({
                    tenantId: req.user.TenantId,
                    memberId: link.memberId,
                    memberUserId: member.UserId, // Use UserId for foreign key constraint
                    memberFirstName: member.FirstName,
                    memberEmail: member.Email,
                    enrollmentUrl: link.enrollmentUrl,
                    groupId: groupId,
                    createdBy: req.user.UserId,
                    expiresAt: link.expiresAt,
                    expirationHours: expirationHours
                  });
                  
                  emailResults.push({
                    memberId: link.memberId,
                    email: member.Email,
                    messageId: messageId,
                    success: true
                  });
                  
                  console.log(`✅ Queued enrollment invitation email for ${member.Email}: ${messageId}`);
                } catch (emailError) {
                  console.error(`❌ Error sending email for member ${link.memberId}:`, emailError);
                  emailResults.push({
                    memberId: link.memberId,
                    email: member.Email,
                    messageId: null,
                    success: false,
                    error: emailError.message
                  });
                }
              } else if (sendEmail && !member.Email) {
                emailResults.push({
                  memberId: link.memberId,
                  email: null,
                  messageId: null,
                  success: false,
                  error: 'No email address'
                });
              }
              
              // Send SMS if requested
              if (sendSMS && phoneNumberToUse) {
                try {
                  // Generate SMS content with expiration date
                  // Use helper to format date without timezone conversion
                  const { formatDateWithoutTimezone } = require('../utils/enrollmentDateHelpers');
                  // Convert expiresAt to ISO string if it's a Date object
                  const expiresAtString = link.expiresAt instanceof Date 
                    ? link.expiresAt.toISOString() 
                    : (link.expiresAt || '');
                  const expirationDate = formatDateWithoutTimezone(expiresAtString, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                  });
                  const smsContent = `Hi ${member.FirstName}, complete your benefits enrollment here: ${link.enrollmentUrl}\n\nThis link expires on ${expirationDate}.`;
                  
                  const messageId = await MessageQueueService.queueMessage({
                    tenantId: req.user.TenantId,
                    messageType: 'SMS',
                    recipientAddress: phoneNumberToUse,
                    subject: null, // SMS doesn't have subject
                    messageBody: smsContent,
                    status: 'Pending',
                    createdBy: req.user.UserId,
                    recipientId: member.UserId
                  });
                  
                  smsResults.push({
                    memberId: link.memberId,
                    phoneNumber: phoneNumberToUse,
                    messageId: messageId,
                    success: true
                  });
                  
                  console.log(`✅ Queued enrollment invitation SMS for ${phoneNumberToUse}: ${messageId}`);
                } catch (smsError) {
                  console.error(`❌ Error sending SMS for member ${link.memberId}:`, smsError);
                  smsResults.push({
                    memberId: link.memberId,
                    phoneNumber: phoneNumberToUse,
                    messageId: null,
                    success: false,
                    error: smsError.message
                  });
                }
              } else if (sendSMS && !phoneNumberToUse) {
                smsResults.push({
                  memberId: link.memberId,
                  phoneNumber: null,
                  messageId: null,
                  success: false,
                  error: 'No phone number'
                });
              }
            }
          } catch (error) {
            console.error(`❌ Error processing member ${link.memberId}:`, error);
            if (sendEmail) {
              emailResults.push({
                memberId: link.memberId,
                email: null,
                messageId: null,
                success: false,
                error: error.message
              });
            }
            if (sendSMS) {
              smsResults.push({
                memberId: link.memberId,
                phoneNumber: null,
                messageId: null,
                success: false,
                error: error.message
              });
            }
          }
        }
        
        res.json({
            success: true,
            message: `Enrollment links sent to ${allLinks.length} members (${membersWithExistingLinks.length} existing, ${createdLinks.length} new)`,
            data: {
                sentCount: allLinks.length,
                memberIds: allLinks.map(link => link.memberId),
                createdLinks: allLinks.map(link => ({
                    memberId: link.memberId,
                    linkToken: link.linkToken,
                    linkUrl: link.enrollmentUrl,
                    isExisting: link.isExisting
                })),
                templateName: template.TemplateName,
                emailResults: emailResults,
                smsResults: smsResults
            }
        });

    } catch (error) {
        console.error('❌ Error sending enrollment links:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send enrollment links'
        });
    }
});

// GET /api/groups/:id/message-recipients - Get filtered message recipients
router.get('/:id/message-recipients', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const { enrollmentStatus, locationId, showTerminated, search } = req.query;
        
        const pool = await getPool();
        
        // Verify access to group
        const accessCheck = pool.request();
        accessCheck.input('groupId', sql.UniqueIdentifier, groupId);
        
        let accessQuery;
        if (getUserRoles(req.user).includes('SysAdmin')) {
            accessQuery = 'SELECT GroupId, TenantId FROM oe.Groups WHERE GroupId = @groupId';
        } else {
            accessCheck.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery = 'SELECT GroupId, TenantId FROM oe.Groups WHERE GroupId = @groupId AND TenantId = @userTenantId';
        }
        
        const accessResult = await accessCheck.query(accessQuery);
        if (accessResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        const tenantId = accessResult.recordset[0].TenantId;
        
        // Build query to get members
        let whereConditions = ['m.GroupId = @groupId', 'm.RelationshipType = \'P\''];
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, groupId);
        
        if (enrollmentStatus && enrollmentStatus !== 'all') {
            // Use same enrollment status logic as groupMembers route
            const statusConditions = {
                'Pending Login': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') AND u.PasswordHash IS NULL`,
                'Enrolled': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active')`, // Include both Enrolled and Pending Login
                'Enrolled (including Pending Login)': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active')`, // Same as Enrolled now
                'Pending Approval': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending')`,
                'Declined Coverage': `EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active')`,
                'Enrollment Link Sent': `EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE()))
                    AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active')`,
                'Enrollment Link Used': `EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount > 0 AND el.IsActive = 1)`,
                'Not Enrolled': `NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending'))
                    AND NOT EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active')
                    AND NOT EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.IsActive = 1)`
            };
            
            if (statusConditions[enrollmentStatus]) {
                whereConditions.push(`(${statusConditions[enrollmentStatus]})`);
            }
        }
        
        if (locationId && locationId !== 'all') {
            whereConditions.push('m.LocationId = @locationId');
            request.input('locationId', sql.UniqueIdentifier, locationId);
        }
        
        // Ignore member.Status; enrollment logic uses oe.Enrollments only.
        
        if (search && search.trim()) {
            whereConditions.push('(u.FirstName LIKE @search OR u.LastName LIKE @search OR u.Email LIKE @search OR u.PhoneNumber LIKE @search)');
            request.input('search', sql.NVarChar, `%${search.trim()}%`);
        }
        
        const whereClause = whereConditions.join(' AND ');
        
        const query = `
            SELECT 
                m.MemberId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber,
                u.UserId,
                m.Status,
                CASE 
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') AND u.PasswordHash IS NULL THEN 'Pending Login'
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') THEN 'Enrolled'
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending') THEN 'Pending Approval'
                    WHEN EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active') THEN 'Declined Coverage'
                    WHEN EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE()))
                        AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') THEN 'Enrollment Link Sent'
                    WHEN EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount > 0 AND el.IsActive = 1) THEN 'Enrollment Link Used'
                    ELSE 'Not Enrolled'
                END AS EnrollmentStatus,
                m.LocationId,
                loc.Name as LocationName
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.GroupLocations loc ON m.LocationId = loc.LocationId
            WHERE ${whereClause}
            ORDER BY u.LastName, u.FirstName
        `;
        
        const result = await request.query(query);
        
        res.json({
            success: true,
            data: {
                members: result.recordset,
                totalCount: result.recordset.length
            }
        });
    } catch (error) {
        console.error('❌ Error fetching message recipients:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch message recipients',
            error: error.message
        });
    }
});

// GET /api/groups/:id/message-sender-options - Get sender options (reply-to and from name)
router.get('/:id/message-sender-options', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const pool = await getPool();
        
        // Verify access to group
        const accessCheck = pool.request();
        accessCheck.input('groupId', sql.UniqueIdentifier, groupId);
        
        let accessQuery;
        if (getUserRoles(req.user).includes('SysAdmin')) {
            accessQuery = 'SELECT GroupId, TenantId, AgentId FROM oe.Groups WHERE GroupId = @groupId';
        } else {
            accessCheck.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery = 'SELECT GroupId, TenantId, AgentId FROM oe.Groups WHERE GroupId = @groupId AND TenantId = @userTenantId';
        }
        
        const accessResult = await accessCheck.query(accessQuery);
        if (accessResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        const groupData = accessResult.recordset[0];
        const options = [];
        
        // Current user option
        options.push({
            type: 'current_user',
            email: req.user.Email || '',
            name: `${req.user.FirstName || ''} ${req.user.LastName || ''}`.trim() || 'Current User'
        });
        
        // Agent option (if group has an agent)
        if (groupData.AgentId) {
            const agentQuery = `
                SELECT u.Email, u.FirstName, u.LastName
                FROM oe.Agents a
                INNER JOIN oe.Users u ON a.UserId = u.UserId
                WHERE a.AgentId = @agentId
            `;
            const agentResult = await pool.request()
                .input('agentId', sql.UniqueIdentifier, groupData.AgentId)
                .query(agentQuery);
            
            if (agentResult.recordset.length > 0) {
                const agent = agentResult.recordset[0];
                options.push({
                    type: 'agent',
                    email: agent.Email || '',
                    name: `${agent.FirstName || ''} ${agent.LastName || ''}`.trim() || 'Agent'
                });
            }
        }
        
        // Group admin option (find group admins for this group)
        const groupAdminQuery = `
            SELECT u.Email, u.FirstName, u.LastName
            FROM oe.GroupAdmins ga
            INNER JOIN oe.Users u ON ga.UserId = u.UserId
            WHERE ga.GroupId = @groupId
            AND ga.Status = 'Active'
        `;
        const groupAdminResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(groupAdminQuery);
        
        if (groupAdminResult.recordset.length > 0) {
            const groupAdmin = groupAdminResult.recordset[0];
            options.push({
                type: 'group_admin',
                email: groupAdmin.Email || '',
                name: `${groupAdmin.FirstName || ''} ${groupAdmin.LastName || ''}`.trim() || 'Group Admin'
            });
        }
        
        res.json({
            success: true,
            data: {
                options
            }
        });
    } catch (error) {
        console.error('❌ Error fetching sender options:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch sender options',
            error: error.message
        });
    }
});

/**
 * Convert HTML content to SMS-friendly plain text
 * - Converts HTML line breaks to newlines
 * - Extracts links from anchor tags and displays as (<url>)
 * - Strips all other HTML tags
 * - Preserves existing newlines
 */
function formatHtmlForSMS(htmlContent) {
    if (!htmlContent) return '';
    
    let text = htmlContent;
    
    // Convert HTML line breaks to newlines (before stripping tags)
    // Handle <br>, <br/>, <br />, and various whitespace combinations
    text = text.replace(/<br\s*\/?>/gi, '\n');
    
    // Convert block-level elements to newlines
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<\/li>/gi, '\n');
    text = text.replace(/<\/tr>/gi, '\n');
    
    // Extract links from anchor tags and convert to (<url>) format
    // Match <a href="url">text</a> or <a href='url'>text</a>
    // Handles both single and double quotes, and optional link text
    text = text.replace(/<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, (match, url, linkText) => {
        // If there's meaningful link text, show it with URL in parentheses
        // Otherwise just show the URL in parentheses
        const cleanLinkText = linkText ? linkText.trim() : '';
        return cleanLinkText ? `${cleanLinkText} (${url})` : `(${url})`;
    });
    
    // Strip all remaining HTML tags
    text = text.replace(/<[^>]*>/g, '');
    
    // Decode HTML entities (common ones)
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&apos;/g, "'");
    
    // Clean up excessive newlines (more than 2 consecutive)
    text = text.replace(/\n{3,}/g, '\n\n');
    
    // Trim each line and remove trailing whitespace
    text = text.split('\n').map(line => line.trim()).join('\n');
    
    return text.trim();
}

// POST /api/groups/:id/send-message - Send messages to group members
router.post('/:id/send-message', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const {
            memberIds, // Optional: specific member IDs (for backward compatibility)
            filters, // Optional: filter object (enrollmentStatus, locationId, showTerminated, search)
            templateId,
            subject,
            body,
            deliveryPreferences,
            phoneNumbers,
            replyToEmail,
            fromEmail,
            fromName
        } = req.body;
        
        const sendEmail = deliveryPreferences?.sendEmail !== false;
        const sendSMS = deliveryPreferences?.sendSMS === true;
        
        // Validate: either memberIds or filters must be provided
        if ((!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) && !filters) {
            return res.status(400).json({
                success: false,
                message: 'Either member IDs or filters are required'
            });
        }
        
        if (!sendEmail && !sendSMS) {
            return res.status(400).json({
                success: false,
                message: 'At least one delivery method must be selected'
            });
        }
        
        if (!replyToEmail || !fromEmail || !fromName) {
            return res.status(400).json({
                success: false,
                message: 'Reply-to email, from email, and from name are required'
            });
        }
        
        const pool = await getPool();
        
        // Verify access to group
        const accessCheck = pool.request();
        accessCheck.input('groupId', sql.UniqueIdentifier, groupId);
        
        let accessQuery;
        if (getUserRoles(req.user).includes('SysAdmin')) {
            accessQuery = 'SELECT GroupId, TenantId FROM oe.Groups WHERE GroupId = @groupId';
        } else {
            accessCheck.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            accessQuery = 'SELECT GroupId, TenantId FROM oe.Groups WHERE GroupId = @groupId AND TenantId = @userTenantId';
        }
        
        const accessResult = await accessCheck.query(accessQuery);
        if (accessResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        const tenantId = accessResult.recordset[0].TenantId;
        
        // Get group name for template variables
        const groupNameQuery = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query('SELECT Name FROM oe.Groups WHERE GroupId = @groupId');
        const groupName = groupNameQuery.recordset[0]?.Name || '';
        
        // Get template if provided
        let templateSubject = subject;
        let templateBody = body;
        
        if (templateId) {
            const templateQuery = `
                SELECT Subject, Body, MessageType
                FROM oe.MessageTemplates
                WHERE TemplateId = @templateId
                AND (TenantId = @tenantId OR TenantId IS NULL)
                AND IsActive = 1
            `;
            const templateResult = await pool.request()
                .input('templateId', sql.UniqueIdentifier, templateId)
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .query(templateQuery);
            
            if (templateResult.recordset.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Template not found or not accessible'
                });
            }
            
            const template = templateResult.recordset[0];
            templateSubject = template.Subject;
            templateBody = template.Body;
        }
        
        if (!templateSubject || !templateBody) {
            return res.status(400).json({
                success: false,
                message: 'Subject and body are required'
            });
        }
        
        // Get members - use filters if provided, otherwise use memberIds
        let memberRequest = pool.request();
        memberRequest.input('groupId', sql.UniqueIdentifier, groupId);
        let memberQuery;
        const { formatMemberDateForTemplate, SQL_MEMBER_EFFECTIVE_TERMINATION_DATE } = require('../services/shared/variableSubstitution');

        if (filters) {
            // Build query using filters (same logic as message-recipients endpoint)
            let whereConditions = ['m.GroupId = @groupId', 'm.RelationshipType = \'P\''];
            
            // Enrollment status filter (use same logic as groupMembers route)
            if (filters.enrollmentStatus && filters.enrollmentStatus !== 'all') {
                const statusConditions = {
                    'Pending Login': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') AND u.PasswordHash IS NULL`,
                    'Enrolled': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active')`, // Include both Enrolled and Pending Login
                    'Enrolled (including Pending Login)': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active')`, // Same as Enrolled now
                    'Pending Approval': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending')`,
                    'Declined Coverage': `EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active')`,
                    'Enrollment Link Sent': `EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE()))
                        AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active')`,
                    'Enrollment Link Used': `EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount > 0 AND el.IsActive = 1)`,
                    'Not Enrolled': `NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending'))
                        AND NOT EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active')
                        AND NOT EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.IsActive = 1)`
                };
                
                if (statusConditions[filters.enrollmentStatus]) {
                    whereConditions.push(`(${statusConditions[filters.enrollmentStatus]})`);
                }
            }
            
            // Location filter
            if (filters.locationId && filters.locationId !== 'all') {
                whereConditions.push('m.LocationId = @locationId');
                memberRequest.input('locationId', sql.UniqueIdentifier, filters.locationId);
            }
            
            // Ignore member.Status; enrollment logic uses oe.Enrollments only.
            
            // Search filter
            if (filters.search && filters.search.trim()) {
                whereConditions.push('(u.FirstName LIKE @search OR u.LastName LIKE @search OR u.Email LIKE @search OR u.PhoneNumber LIKE @search)');
                memberRequest.input('search', sql.NVarChar, `%${filters.search.trim()}%`);
            }
            
            const whereClause = whereConditions.join(' AND ');
            
            memberQuery = `
                SELECT 
                    m.MemberId,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber,
                    u.UserId,
                    ${SQL_MEMBER_EFFECTIVE_TERMINATION_DATE} AS TerminationDate
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE ${whereClause}
                ORDER BY u.LastName, u.FirstName
            `;
        } else {
            // Use memberIds (backward compatibility)
            memberQuery = `
                SELECT 
                    m.MemberId,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber,
                    u.UserId,
                    ${SQL_MEMBER_EFFECTIVE_TERMINATION_DATE} AS TerminationDate
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.MemberId IN (${memberIds.map((_, i) => `@memberId${i}`).join(', ')})
                AND m.GroupId = @groupId
            `;
            
            memberIds.forEach((id, i) => {
                memberRequest.input(`memberId${i}`, sql.UniqueIdentifier, id);
            });
        }
        
        const memberResult = await memberRequest.query(memberQuery);
        const members = memberResult.recordset;
        
        if (members.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid members found matching the filters'
            });
        }
        
        // Queue messages
        const MessageQueueService = require('../services/messageQueue.service');
        let emailsQueued = 0;
        let smsQueued = 0;
        
        for (const member of members) {
            const terminationStr = formatMemberDateForTemplate(member.TerminationDate);
            // Replace template variables
            const memberSubject = templateSubject
                .replace(/\{\[member\.FirstName\]\}/g, member.FirstName || '')
                .replace(/\{\[member\.LastName\]\}/g, member.LastName || '')
                .replace(/\{\[member\.Email\]\}/g, member.Email || '')
                .replace(/\{\[member\.Phone\]\}/g, member.PhoneNumber || '')
                .replace(/\{\[member\.FullName\]\}/g, `${member.FirstName || ''} ${member.LastName || ''}`.trim())
                .replace(/\{\[member\.TerminationDate\]\}/g, terminationStr)
                .replace(/\{\[group\.Name\]\}/g, groupName)
                .replace(/\{\[system\.CurrentDate\]\}/g, new Date().toLocaleDateString())
                .replace(/\{\[system\.CurrentYear\]\}/g, new Date().getFullYear().toString());
            
            const memberBody = templateBody
                .replace(/\{\[member\.FirstName\]\}/g, member.FirstName || '')
                .replace(/\{\[member\.LastName\]\}/g, member.LastName || '')
                .replace(/\{\[member\.Email\]\}/g, member.Email || '')
                .replace(/\{\[member\.Phone\]\}/g, member.PhoneNumber || '')
                .replace(/\{\[member\.FullName\]\}/g, `${member.FirstName || ''} ${member.LastName || ''}`.trim())
                .replace(/\{\[member\.TerminationDate\]\}/g, terminationStr)
                .replace(/\{\[group\.Name\]\}/g, groupName)
                .replace(/\{\[system\.CurrentDate\]\}/g, new Date().toLocaleDateString())
                .replace(/\{\[system\.CurrentYear\]\}/g, new Date().getFullYear().toString());
            
            // Queue email if requested
            if (sendEmail && member.Email) {
                try {
                    // For emails, only send HTML version - don't create text version to avoid duplication
                    // The message processor will auto-generate text version if needed
                    await MessageQueueService.queueEmail({
                        tenantId,
                        toEmail: member.Email,
                        toName: `${member.FirstName || ''} ${member.LastName || ''}`.trim(),
                        subject: memberSubject,
                        htmlContent: memberBody,
                        textContent: undefined, // Don't send text version - let HTML-only email
                        messageType: 'Email',
                        createdBy: req.user.UserId,
                        recipientId: member.UserId,
                        replyToEmail: replyToEmail,
                        fromEmail: fromEmail,
                        fromName: fromName
                    });
                    emailsQueued++;
                } catch (error) {
                    console.error(`❌ Error queuing email for member ${member.MemberId}:`, error);
                }
            }
            
            // Queue SMS if requested
            if (sendSMS) {
                const phoneNumber = phoneNumbers?.[member.MemberId] || member.PhoneNumber;
                if (phoneNumber) {
                    try {
                        // Format HTML content for SMS (preserves newlines, converts links)
                        const smsBody = formatHtmlForSMS(memberBody);
                        
                        await MessageQueueService.queueMessage({
                            tenantId,
                            messageType: 'SMS',
                            recipientAddress: phoneNumber,
                            subject: memberSubject,
                            messageBody: smsBody,
                            status: 'Pending',
                            createdBy: req.user.UserId,
                            recipientId: member.UserId
                        });
                        smsQueued++;
                    } catch (error) {
                        console.error(`❌ Error queuing SMS for member ${member.MemberId}:`, error);
                    }
                }
            }
        }
        
        res.json({
            success: true,
            message: `Messages queued successfully`,
            data: {
                messagesQueued: emailsQueued + smsQueued,
                emailsQueued,
                smsQueued,
                totalMembers: members.length
            }
        });
    } catch (error) {
        console.error('❌ Error sending group message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send group message',
            error: error.message
        });
    }
});

const { MAX_LARGE_UPLOAD_BYTES } = require('../constants/uploadLimits');

// Configure multer for file uploads (memory storage for census parsing)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_LARGE_UPLOAD_BYTES,
  },
  fileFilter: (req, file, cb) => {
    // Allowed file types for census import
    const allowedTypes = [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/csv'
    ];

    // Also check file extension as fallback
    const ext = file.originalname.split('.').pop().toLowerCase();
    const allowedExtensions = ['csv', 'xlsx', 'xls'];

    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not supported. Allowed types: CSV, XLSX, XLS`));
    }
  }
});

/**
 * @route   POST /api/groups/:groupId/parse-census
 * @desc    Parse member census file with AI (read-only, no creation)
 * @access  Private (SysAdmin, TenantAdmin, Agent, GroupAdmin)
 */
router.post('/:groupId/parse-census', 
  authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), 
  requireTenantAccess, 
  upload.single('file'),
  async (req, res) => {
    const { groupId } = req.params;
    logger.info(`[GROUPS-ROUTE] Request to parse census for group ID: ${groupId}`);

    try {
      // Check if file was uploaded
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded. Please upload a CSV or Excel file.'
        });
      }

      // File size validation (same cap as multer)
      const MAX_FILE_SIZE = MAX_LARGE_UPLOAD_BYTES;
      if (req.file.size > MAX_FILE_SIZE) {
        logger.warn(`[GROUPS-ROUTE] File too large: ${req.file.size} bytes (max: ${MAX_FILE_SIZE})`);
        return res.status(400).json({
          success: false,
          message: `File size (${(req.file.size / 1024 / 1024).toFixed(2)}MB) exceeds the maximum allowed size of ${MAX_FILE_SIZE / 1024 / 1024}MB. Please contact improve@allaboard365.com for assistance with large files.`
        });
      }

      const pool = await getPool();

      // Verify group access based on role
      const accessCheck = await groupAccessService.verifyGroupAccess(pool, groupId, req.user, {
        tenantId: req.tenantId || req.user?.TenantId,
      });
      if (!accessCheck.hasAccess) {
        return res.status(403).json({
          success: false,
          message: 'Access denied: You do not have permission to access this group'
        });
      }

      // Get group locations for matching
      const locationsRequest = pool.request();
      locationsRequest.input('groupId', sql.UniqueIdentifier, groupId);
      
      const locationsQuery = `
        SELECT 
          LocationId,
          Name,
          Address,
          City,
          State,
          IsPrimary
        FROM oe.GroupLocations
        WHERE GroupId = @groupId
        ORDER BY IsPrimary DESC, CreatedDate ASC
      `;
      
      const locationsResult = await locationsRequest.query(locationsQuery);
      const groupLocations = locationsResult.recordset || [];

      logger.info(`[GROUPS-ROUTE] Found ${groupLocations.length} locations for group ${groupId}`);

      // Extract file content
      logger.info(`[GROUPS-ROUTE] Extracting file content from ${req.file.originalname} (${req.file.size} bytes)`);
      const fileContent = await aiCensusParser.extractFileContent(req.file.buffer, req.file.originalname);
      logger.info(`[GROUPS-ROUTE] Extracted file content: ${fileContent.length} characters`);

      // Parse with AI (this may take 1-2 minutes for large files)
      logger.info(`[GROUPS-ROUTE] Starting AI parsing (this may take 1-2 minutes)...`);
      logger.info(`[GROUPS-ROUTE] OpenAI API key configured: ${process.env.OPENAI_API_KEY ? 'Yes' : 'No'}`);
      logger.info(`[GROUPS-ROUTE] OpenAI model: ${process.env.OPENAI_MODEL || 'gpt-4o'}`);
      
      const parseStartTime = Date.now();
      
      // Set a timeout for the entire parsing operation (12 minutes)
      const PARSE_TIMEOUT = 720000; // 12 minutes
      const parsePromise = aiCensusParser.parseCensusFile(fileContent, groupLocations);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Census parsing timed out after ${PARSE_TIMEOUT / 1000} seconds`));
        }, PARSE_TIMEOUT);
      });
      
      let parseResult;
      try {
        parseResult = await Promise.race([parsePromise, timeoutPromise]);
      } catch (raceError) {
        logger.error(`[GROUPS-ROUTE] Parse operation failed or timed out: ${raceError.message}`);
        throw raceError;
      }
      
      const parseDuration = Date.now() - parseStartTime;
      logger.info(`[GROUPS-ROUTE] AI parsing completed in ${parseDuration}ms (${(parseDuration / 1000).toFixed(2)}s)`);

      if (!parseResult.success) {
        logger.error(`[GROUPS-ROUTE] Failed to parse census file: ${parseResult.error}`);
        return res.status(400).json({
          success: false,
          message: `Failed to parse census file: ${parseResult.error}`
        });
      }

      logger.info(`[GROUPS-ROUTE] Successfully parsed census file for group ${groupId}`);
      res.json({
        success: true,
        data: parseResult.data
      });

    } catch (error) {
      logger.error(`[GROUPS-ROUTE] Error parsing census for group ${groupId}: ${error.message}`);
      res.status(500).json({
        success: false,
        message: `Server error while parsing census file: ${error.message}`
      });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/groups/:id/type-change/instant-approve
// ---------------------------------------------------------------------------
// TenantAdmin / SysAdmin shortcut: skips the request-and-review flow and
// inserts a pre-Approved GroupTypeChangeRequest in one call. The actual
// GroupType flip still happens in the conversion-wizard apply step so the
// group never sits in a half-state.
//
// Body: { requestedType: 'Standard' | 'ListBill' }
// Returns: { success: true, data: { requestId, groupId, wizardUrl } }
// ---------------------------------------------------------------------------
router.post(
  '/:id/type-change/instant-approve',
  authMiddleware(['SysAdmin', 'TenantAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const { id: groupId } = req.params;
      const { requestedType } = req.body || {};

      if (!['Standard', 'ListBill'].includes(requestedType)) {
        return res.status(400).json({
          success: false,
          message: "requestedType must be 'Standard' or 'ListBill'."
        });
      }

      const pool = await getPool();
      const userRoles = getUserRoles(req.user);
      const isSysAdmin = userRoles.includes('SysAdmin');

      // Load the group (scoped to tenant unless SysAdmin).
      const groupReq = pool.request().input('GroupId', sql.UniqueIdentifier, groupId);
      let groupSql = `SELECT GroupId, TenantId, GroupType FROM oe.Groups WHERE GroupId = @GroupId`;
      if (!isSysAdmin) {
        groupReq.input('TenantId', sql.UniqueIdentifier, req.tenantId);
        groupSql += ' AND TenantId = @TenantId';
      }
      const groupResult = await groupReq.query(groupSql);
      if (!groupResult.recordset.length) {
        return res.status(404).json({ success: false, message: 'Group not found.' });
      }
      const group = groupResult.recordset[0];
      const currentType = group.GroupType;

      if (currentType === requestedType) {
        return res.status(400).json({
          success: false,
          message: 'Requested type equals current type.'
        });
      }

      // Reject if a Pending request already exists for this group.
      const pending = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .query(`SELECT TOP 1 RequestId FROM oe.GroupTypeChangeRequests WHERE GroupId = @GroupId AND Status = 'Pending'`);
      if (pending.recordset.length) {
        return res.status(409).json({
          success: false,
          message: 'A pending type-change request already exists for this group.'
        });
      }

      // Insert the pre-Approved request. GroupType is NOT flipped yet — the
      // wizard's apply step does that once products / enrollments are rewired.
      const insertResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .input('TenantId', sql.UniqueIdentifier, group.TenantId)
        .input('RequestedBy', sql.UniqueIdentifier, req.user.UserId)
        .input('CurrentType', sql.NVarChar(50), currentType)
        .input('RequestedType', sql.NVarChar(50), requestedType)
        .input('ReviewedBy', sql.UniqueIdentifier, req.user.UserId)
        .query(`
          INSERT INTO oe.GroupTypeChangeRequests
            (GroupId, TenantId, RequestedBy, CurrentType, RequestedType, Status, Reason,
             ReviewedBy, ReviewedAt, ReviewNotes)
          OUTPUT INSERTED.RequestId
          VALUES
            (@GroupId, @TenantId, @RequestedBy, @CurrentType, @RequestedType, 'Approved',
             'Manual conversion by TenantAdmin', @ReviewedBy, SYSUTCDATETIME(),
             'TenantAdmin manual conversion')
        `);

      const requestId = insertResult.recordset[0].RequestId;
      const wizardUrl = `/tenant-admin/groups/${groupId}/type-change/wizard`;

      return res.json({
        success: true,
        data: { requestId, groupId, wizardUrl }
      });
    } catch (error) {
      logger.error(`[GROUPS-ROUTE] Error in instant-approve: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: 'Failed to instant-approve type change.'
      });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/groups/:id/type-change/preview
// ---------------------------------------------------------------------------
// Returns members affected by the most-recent Approved type-change request,
// bucketed into two action groups based purely on EffectiveDate:
//   - 'reEnroll'            — EffectiveDate > today (Pending future) → cancel
//                             the future enrollment; member needs new link
//   - 'letFinishThenCancel' — EffectiveDate <= today (Active past) → schedule
//                             TerminationDate; coverage runs to month end
//
// The "preserve" bucket is intentionally not produced here — the wizard now
// always re-enrolls members in the new product set rather than trying to
// auto-keep them on a SalesType-compatible product. `matchingIndividualProduct`
// is always null on the response (kept on the schema for back-compat).
//
// Access: TenantAdmin, SysAdmin, or the Agent who owns the group.
// ---------------------------------------------------------------------------
router.get(
  '/:id/type-change/preview',
  authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const { id: groupId } = req.params;
      const pool = await getPool();
      const userRoles = getUserRoles(req.user);
      const isSysAdmin = userRoles.includes('SysAdmin');
      const isAgent = userRoles.includes('Agent') && req.user?.currentRole === 'Agent';

      // ── 1. Load group and verify access ─────────────────────────────────
      const groupRequest = pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId);

      let accessQuery = `
        SELECT g.GroupId, g.TenantId, g.GroupType, g.AgentId
        FROM oe.Groups g
        WHERE g.GroupId = @GroupId
      `;

      if (isAgent) {
        const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
        if (accessibleAgentIds.length === 0) {
          return res.status(403).json({ success: false, message: 'Not a valid agent.' });
        }
        const agentScopeClause = buildAgentScopeClause(groupRequest, accessibleAgentIds, 'g.AgentId', 'agPreview');
        accessQuery += ` AND ${agentScopeClause}`;
      } else if (!isSysAdmin) {
        groupRequest.input('TenantId', sql.UniqueIdentifier, req.tenantId);
        accessQuery += ' AND g.TenantId = @TenantId';
      }

      const groupResult = await groupRequest.query(accessQuery);
      if (!groupResult.recordset.length) {
        return res.status(404).json({ success: false, message: 'Group not found or access denied.' });
      }

      const group = groupResult.recordset[0];

      // ── 2. Load most-recent Approved type-change request ─────────────────
      const reqResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .input('TenantId', sql.UniqueIdentifier, group.TenantId)
        .query(`
          SELECT TOP 1 RequestId, RequestedType
          FROM oe.GroupTypeChangeRequests
          WHERE GroupId = @GroupId
            AND TenantId = @TenantId
            AND Status = 'Approved'
          ORDER BY CreatedDate DESC
        `);

      if (!reqResult.recordset.length) {
        return res.status(400).json({
          success: false,
          message: 'No approved type change request for this group.'
        });
      }

      const { RequestedType: targetType } = reqResult.recordset[0];

      // ── 3. Load each enrollment for non-terminated members ───────────────
      // One row per (member × enrollment). We aggregate per-member below so
      // each member appears once in the response with an enrollments[] array.
      // Member-status filter matches the rest of the app's billing/effective-
      // date queries: include everyone except Terminated. This catches statuses
      // like 'Pending Payment' that have real active enrollments needing
      // preserve / re-enroll / let-finish handling.
      const enrollmentsResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT
            m.MemberId,
            u.FirstName,
            u.LastName,
            e.EnrollmentId,
            e.ProductId,
            p.Name AS ProductName,
            p.VendorId,
            p.ProductType,
            e.EffectiveDate,
            e.Status AS EnrollmentStatus
          FROM oe.Members m
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
          INNER JOIN oe.Products p ON e.ProductId = p.ProductId
          WHERE m.GroupId = @GroupId
            AND (m.Status IS NULL OR m.Status != 'Terminated')
            AND e.Status IN ('Active', 'Pending')
            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
            AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
        `);

      // Members in the group with NO active/pending enrollments. Surface them
      // so the agent doesn't think anyone's been silently dropped — their
      // enrollment links auto-pick up the new product set after the wizard
      // runs (oe.GroupProducts is the source of truth at link-render time).
      const membersWithoutEnrollmentsResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT m.MemberId, u.FirstName, u.LastName, u.Email, m.Status AS MemberStatus
          FROM oe.Members m
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          WHERE m.GroupId = @GroupId
            AND (m.Status IS NULL OR m.Status != 'Terminated')
            AND NOT EXISTS (
              SELECT 1 FROM oe.Enrollments e
              WHERE e.MemberId = m.MemberId
                AND e.Status IN ('Active', 'Pending')
                AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
            )
        `);

      const today = new Date();

      // ── 4. Bucket each enrollment by EffectiveDate, then aggregate per member.
      //
      // No more auto-preserve heuristic — every enrollment falls into one of
      // two buckets based purely on whether the period has started yet:
      //   future EffectiveDate → reEnroll (cancel, then send a new link)
      //   past   EffectiveDate → letFinishThenCancel (TerminationDate at
      //                                               month end, then re-link)
      // `matchingIndividualProduct` is always null on the response now;
      // kept on the schema for back-compat with the frontend types.
      const memberMap = new Map();

      for (const row of enrollmentsResult.recordset) {
        const effectiveDate = new Date(row.EffectiveDate);
        const enrollmentAction = effectiveDate > today ? 'reEnroll' : 'letFinishThenCancel';

        if (!memberMap.has(row.MemberId)) {
          memberMap.set(row.MemberId, {
            memberId: row.MemberId,
            displayName: `${row.FirstName} ${row.LastName}`.trim(),
            enrollments: []
          });
        }
        memberMap.get(row.MemberId).enrollments.push({
          enrollmentId: row.EnrollmentId,
          productId: row.ProductId,
          productName: row.ProductName,
          vendorId: row.VendorId,
          productType: row.ProductType,
          effectiveDate: row.EffectiveDate,
          status: row.EnrollmentStatus,
          // Always null: preserve bucket is gone but the field stays on the
          // response for back-compat with the frontend types.
          matchingIndividualProduct: null,
          action: enrollmentAction
        });
      }

      // Per-member primary action: surface the most action-requiring outcome
      // so the agent sees the highest-attention members first.
      //   reEnroll > letFinishThenCancel
      const ACTION_RANK = { letFinishThenCancel: 0, reEnroll: 1 };
      const members = Array.from(memberMap.values()).map((m) => ({
        ...m,
        action: m.enrollments.reduce(
          (acc, e) => (ACTION_RANK[e.action] > ACTION_RANK[acc] ? e.action : acc),
          'letFinishThenCancel'
        )
      }));

      const membersWithoutEnrollments = membersWithoutEnrollmentsResult.recordset.map((r) => ({
        memberId: r.MemberId,
        displayName: `${r.FirstName || ''} ${r.LastName || ''}`.trim(),
        email: r.Email || null,
        memberStatus: r.MemberStatus || null
      }));

      return res.json({
        success: true,
        data: {
          // Direction the wizard is converting toward — drives Step 2's
          // product-picker filter and copy. Without it, Step 2 was hardcoded
          // to "select Individual products" even on a ListBill→Standard
          // run, making the reverse direction unusable.
          targetType,
          members,
          membersWithoutEnrollments
        }
      });
    } catch (error) {
      logger.error(`[GROUPS-ROUTE] Error building type-change preview: ${error.message}`);
      return res.status(500).json({ success: false, message: 'Failed to build type-change preview.' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/groups/:id/type-change/apply
// ---------------------------------------------------------------------------
// Applies a previously-approved type-change request:
//   1. Hides old GroupProducts not in the new product list.
//   2. Inserts new GroupProducts rows for any productIds not already present.
//   3. For each preserve mapping, repoints the existing enrollment row's
//      ProductId to the matching individual-SKU product so downstream billing
//      / exports immediately read the new product.
//   4. For letFinishThenCancel members, schedules a TerminationDate on their
//      Active enrollment so coverage ends naturally at the cutover.
//   5. Clears HouseholdMemberId for members who need a new prefix on next
//      enrollment (re-enroll + let-finish buckets).
//   6. Cancels future Pending/Pending Payment enrollments for re-enroll members.
//   7. Flips oe.Groups.GroupType to the RequestedType (the group keeps its
//      original type until apply commits — no half-state).
//
// Body:
//   {
//     productIds: string[],
//     memberIdsToReEnroll: string[],
//     preserveMappings?: Array<{enrollmentId: string, newProductId: string}>,
//     memberIdsToLetFinish?: string[]
//   }
// Access: SysAdmin, TenantAdmin, or the Agent who owns the group.
// Requires a most-recent Approved request to exist.
// ---------------------------------------------------------------------------
router.post(
  '/:id/type-change/apply',
  authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const { id: groupId } = req.params;
      const {
        productIds = [],
        memberIdsToReEnroll = [],
        preserveMappings = [],
        memberIdsToLetFinish = []
      } = req.body;

      if (!Array.isArray(productIds)) {
        return res.status(400).json({ success: false, message: 'productIds must be an array.' });
      }
      if (!Array.isArray(memberIdsToReEnroll)) {
        return res.status(400).json({ success: false, message: 'memberIdsToReEnroll must be an array.' });
      }
      if (!Array.isArray(preserveMappings)) {
        return res.status(400).json({ success: false, message: 'preserveMappings must be an array.' });
      }
      if (!Array.isArray(memberIdsToLetFinish)) {
        return res.status(400).json({ success: false, message: 'memberIdsToLetFinish must be an array.' });
      }
      // Each mapping must be {enrollmentId, newProductId} and newProductId must be in productIds.
      for (const m of preserveMappings) {
        if (!m || typeof m.enrollmentId !== 'string' || typeof m.newProductId !== 'string') {
          return res.status(400).json({ success: false, message: 'preserveMappings entries must have enrollmentId and newProductId.' });
        }
        if (!productIds.includes(m.newProductId)) {
          return res.status(400).json({ success: false, message: `preserveMappings references productId ${m.newProductId} not in productIds.` });
        }
      }

      const pool = await getPool();
      const userRoles = getUserRoles(req.user);
      const isSysAdmin = userRoles.includes('SysAdmin');
      const isAgent = userRoles.includes('Agent') && req.user?.currentRole === 'Agent';

      // ── 1. Load group and verify access ────────────────────────────────────
      const groupRequest = pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId);

      let accessQuery = `
        SELECT g.GroupId, g.TenantId, g.GroupType, g.AgentId
        FROM oe.Groups g
        WHERE g.GroupId = @GroupId
      `;

      if (isAgent) {
        const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
        if (accessibleAgentIds.length === 0) {
          return res.status(403).json({ success: false, message: 'Not a valid agent.' });
        }
        const agentScopeClause = buildAgentScopeClause(groupRequest, accessibleAgentIds, 'g.AgentId', 'agApply');
        accessQuery += ` AND ${agentScopeClause}`;
      } else if (!isSysAdmin) {
        groupRequest.input('TenantId', sql.UniqueIdentifier, req.tenantId);
        accessQuery += ' AND g.TenantId = @TenantId';
      }

      const groupResult = await groupRequest.query(accessQuery);
      if (!groupResult.recordset.length) {
        return res.status(404).json({ success: false, message: 'Group not found or access denied.' });
      }

      const group = groupResult.recordset[0];
      const tenantId = group.TenantId;

      // ── 2. Require a most-recent Approved request ──────────────────────────
      const reqResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .input('TenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT TOP 1 RequestId, RequestedType
          FROM oe.GroupTypeChangeRequests
          WHERE GroupId = @GroupId
            AND TenantId = @TenantId
            AND Status = 'Approved'
          ORDER BY CreatedDate DESC
        `);

      if (!reqResult.recordset.length) {
        return res.status(400).json({
          success: false,
          message: 'No approved type change request for this group.'
        });
      }

      const newGroupType = reqResult.recordset[0].RequestedType;
      const appliedRequestId = reqResult.recordset[0].RequestId;

      // Compute the next-effective-date cutoff used for letFinishThenCancel
      // termination scheduling — first day of next month, minus one day.
      // (Matches the simple anchor used elsewhere in the feature; will adopt
      // the per-tenant cutoff util once PR #90 lands.)
      const _now = new Date();
      const nextEffective = new Date(Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth() + 1, 1));
      const letFinishTerminationDate = new Date(nextEffective.getTime() - 86400000);

      // ── 3. Begin transaction ───────────────────────────────────────────────
      const transaction = pool.transaction();
      await transaction.begin();

      let productsHidden = 0;
      let productsAdded = 0;
      let householdIdsCleared = 0;
      let enrollmentsCancelled = 0;
      let preservedEnrollmentsRepointed = 0;
      let enrollmentsTerminationScheduled = 0;
      let prefixUpdates = 0;

      try {
        // ── 3a. Hide old GroupProducts not in the new list ─────────────────
        if (productIds.length > 0) {
          const hideRequest = transaction.request()
            .input('GroupId', sql.UniqueIdentifier, groupId);
          const hideParams = productIds.map((id, i) => {
            hideRequest.input(`HideP${i}`, sql.UniqueIdentifier, id);
            return `@HideP${i}`;
          });
          const hideResult = await hideRequest.query(`
            UPDATE oe.GroupProducts
            SET IsHidden = 1, ModifiedDate = SYSUTCDATETIME()
            WHERE GroupId = @GroupId
              AND ProductId NOT IN (${hideParams.join(',')})
              AND (IsHidden IS NULL OR IsHidden = 0)
          `);
          productsHidden = hideResult.rowsAffected[0] || 0;
        } else {
          // If no products selected, hide all existing group products
          const hideAllResult = await transaction.request()
            .input('GroupId', sql.UniqueIdentifier, groupId)
            .query(`
              UPDATE oe.GroupProducts
              SET IsHidden = 1, ModifiedDate = SYSUTCDATETIME()
              WHERE GroupId = @GroupId
                AND (IsHidden IS NULL OR IsHidden = 0)
            `);
          productsHidden = hideAllResult.rowsAffected[0] || 0;
        }

        // ── 3b. Insert new GroupProducts rows for any productIds not present ─
        for (let i = 0; i < productIds.length; i++) {
          const productId = productIds[i];
          // Check if already exists (active or hidden) for this group
          const existsResult = await transaction.request()
            .input('GroupId', sql.UniqueIdentifier, groupId)
            .input('ProductId', sql.UniqueIdentifier, productId)
            .query(`
              SELECT GroupProductId
              FROM oe.GroupProducts
              WHERE GroupId = @GroupId AND ProductId = @ProductId
            `);

          if (existsResult.recordset.length > 0) {
            // Already exists — ensure it is visible and active
            await transaction.request()
              .input('GroupId', sql.UniqueIdentifier, groupId)
              .input('ProductId', sql.UniqueIdentifier, productId)
              .query(`
                UPDATE oe.GroupProducts
                SET IsHidden = 0, IsActive = 1, ModifiedDate = SYSUTCDATETIME()
                WHERE GroupId = @GroupId AND ProductId = @ProductId
              `);
          } else {
            // Insert new row
            const newGroupProductId = require('crypto').randomUUID();
            await transaction.request()
              .input('GroupProductId', sql.UniqueIdentifier, newGroupProductId)
              .input('GroupId', sql.UniqueIdentifier, groupId)
              .input('ProductId', sql.UniqueIdentifier, productId)
              .input('CreatedBy', sql.UniqueIdentifier, req.user.UserId)
              .query(`
                INSERT INTO oe.GroupProducts
                  (GroupProductId, GroupId, ProductId, IsActive, IsHidden,
                   CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES
                  (@GroupProductId, @GroupId, @ProductId, 1, 0,
                   SYSUTCDATETIME(), SYSUTCDATETIME(), @CreatedBy, @CreatedBy)
              `);
            productsAdded++;
          }
        }

        // ── 3c. Repoint preserve-bucket enrollments to the new individual product.
        //        These members keep their enrollment row, but the ProductId
        //        column is updated so any downstream code (billing exports,
        //        carrier feeds, etc.) reading Enrollments.ProductId picks up
        //        the new product immediately. Each mapping is validated to
        //        belong to this group and to point at one of the productIds
        //        we just attached.
        for (const m of preserveMappings) {
          const repointResult = await transaction.request()
            .input('EnrollmentId', sql.UniqueIdentifier, m.enrollmentId)
            .input('NewProductId', sql.UniqueIdentifier, m.newProductId)
            .input('GroupId', sql.UniqueIdentifier, groupId)
            .query(`
              UPDATE oe.Enrollments
              SET ProductId = @NewProductId, ModifiedDate = SYSUTCDATETIME()
              WHERE EnrollmentId = @EnrollmentId
                AND EXISTS (
                  SELECT 1 FROM oe.Members m
                  WHERE m.MemberId = oe.Enrollments.MemberId AND m.GroupId = @GroupId
                )
            `);
          preservedEnrollmentsRepointed += repointResult.rowsAffected[0] || 0;
        }

        // ── 3d. Schedule TerminationDate for letFinishThenCancel members.
        //        Their current Active enrollment runs to the end of its current
        //        period and then ends naturally. They will receive a fresh
        //        enrollment link in step 4 of the wizard for the new product.
        //
        //        IMPORTANT: a member with mixed enrollments (one preserve +
        //        one letFinish) is bucketed at the member level as letFinish,
        //        but we MUST NOT terminate their preserve enrollment row.
        //        The EnrollmentId NOT IN preserveMappings clause guards that.
        if (memberIdsToLetFinish.length > 0) {
          const termRequest = transaction.request()
            .input('TerminationDate', sql.Date, letFinishTerminationDate);
          const termParams = memberIdsToLetFinish.map((id, i) => {
            termRequest.input(`LF${i}`, sql.UniqueIdentifier, id);
            return `@LF${i}`;
          });
          let preserveExcludeClause = '';
          if (preserveMappings.length > 0) {
            const excludeParams = preserveMappings.map((m, i) => {
              termRequest.input(`LFExclude${i}`, sql.UniqueIdentifier, m.enrollmentId);
              return `@LFExclude${i}`;
            });
            preserveExcludeClause = `AND EnrollmentId NOT IN (${excludeParams.join(',')})`;
          }
          const termResult = await termRequest.query(`
            UPDATE oe.Enrollments
            SET TerminationDate = @TerminationDate, ModifiedDate = SYSUTCDATETIME()
            WHERE MemberId IN (${termParams.join(',')})
              AND Status = 'Active'
              AND (TerminationDate IS NULL OR TerminationDate > @TerminationDate)
              ${preserveExcludeClause}
          `);
          enrollmentsTerminationScheduled = termResult.rowsAffected[0] || 0;
        }

        // ── 3e. Clear HouseholdMemberIds for both re-enroll and let-finish
        //        members so the next enrollment regenerates with the correct
        //        prefix for the new group type. Preserve members keep their
        //        existing IDs (their enrollment row was repointed in 3c).
        const memberIdsForHHMClear = Array.from(new Set([
          ...memberIdsToReEnroll,
          ...memberIdsToLetFinish
        ]));
        if (memberIdsForHHMClear.length > 0) {
          const clearRequest = transaction.request()
            .input('TenantId', sql.UniqueIdentifier, tenantId);
          const clearParams = memberIdsForHHMClear.map((id, i) => {
            clearRequest.input(`ClearM${i}`, sql.UniqueIdentifier, id);
            return `@ClearM${i}`;
          });
          const clearResult = await clearRequest.query(`
            UPDATE oe.Members
            SET HouseholdMemberId = NULL,
                ModifiedDate = SYSUTCDATETIME()
            WHERE TenantId = @TenantId
              AND MemberId IN (${clearParams.join(',')})
          `);
          householdIdsCleared = clearResult.rowsAffected[0] || 0;
        }

        // ── 3e2. Household-wide HouseholdMemberID prefix swap.
        //        Re-enroll / let-finish primaries had their IDs NULLed in 3e,
        //        so the SP regenerates them later with the right prefix.
        //        Preserve primaries keep their enrollment AND their stored ID,
        //        and dependents in any affected household never had their IDs
        //        cleared either — both buckets need their existing prefix
        //        swapped so the customer-facing number stays stable but the
        //        leading prefix matches the new group type.
        //
        //        Direction is decided by the destination type:
        //          Standard → ListBill : clearingGroup=true  (MW → SW)
        //          ListBill → Standard : clearingGroup=false (SW → MW)
        //
        //        No-op when tenant has no individualMemberIDPrefix configured
        //        (single-prefix tenant). Idempotent on rows that don't carry
        //        the from-prefix (e.g. dependents already on the target prefix).
        //        Mirrors the release-unenrolled flow at groups.js ~line 1626.
        const preserveMemberIds = [];
        if (preserveMappings.length > 0) {
          const pmReq = transaction.request();
          const pmParams = preserveMappings.map((m, i) => {
            pmReq.input(`PM${i}`, sql.UniqueIdentifier, m.enrollmentId);
            return `@PM${i}`;
          });
          const pmResult = await pmReq.query(`
            SELECT DISTINCT MemberId
            FROM oe.Enrollments
            WHERE EnrollmentId IN (${pmParams.join(',')})
          `);
          for (const row of (pmResult.recordset || [])) {
            if (row.MemberId) preserveMemberIds.push(row.MemberId);
          }
        }

        const affectedPrimaryIds = Array.from(new Set([
          ...preserveMemberIds,
          ...memberIdsToReEnroll,
          ...memberIdsToLetFinish
        ]));

        if (affectedPrimaryIds.length > 0) {
          const tenantPrefixResult = await transaction.request()
            .input('TenantId', sql.UniqueIdentifier, tenantId)
            .query(`
              SELECT MemberIDPrefix, IndividualMemberIDPrefix
              FROM oe.Tenants
              WHERE TenantId = @TenantId
            `);
          const tenantPrefixes = tenantPrefixResult.recordset[0] || null;
          const prefixSwap = tenantPrefixes
            ? computePrefixSwapForGroupChange({
              clearingGroup: newGroupType === 'ListBill',
              memberIDPrefix: tenantPrefixes.MemberIDPrefix,
              individualMemberIDPrefix: tenantPrefixes.IndividualMemberIDPrefix,
            })
            : null;

          if (prefixSwap) {
            const hhReq = transaction.request();
            hhReq.input('TenantId', sql.UniqueIdentifier, tenantId);
            const apParams = affectedPrimaryIds.map((id, i) => {
              hhReq.input(`AP${i}`, sql.UniqueIdentifier, id);
              return `@AP${i}`;
            });
            // Pull every member that shares a household with one of the affected
            // primaries (including the primaries themselves).
            const hhResult = await hhReq.query(`
              SELECT MemberId, HouseholdMemberID
              FROM oe.Members
              WHERE TenantId = @TenantId
                AND HouseholdId IN (
                  SELECT HouseholdId
                  FROM oe.Members
                  WHERE TenantId = @TenantId
                    AND MemberId IN (${apParams.join(',')})
                    AND HouseholdId IS NOT NULL
                )
            `);
            for (const row of (hhResult.recordset || [])) {
              const newHm = swapHouseholdMemberIdPrefix(
                row.HouseholdMemberID,
                prefixSwap.fromPrefix,
                prefixSwap.toPrefix
              );
              if (newHm && newHm !== row.HouseholdMemberID) {
                const swapReq = transaction.request();
                swapReq.input('memberId', sql.UniqueIdentifier, row.MemberId);
                swapReq.input('householdMemberID', sql.NVarChar, newHm);
                await swapReq.query(`
                  UPDATE oe.Members
                  SET HouseholdMemberID = @householdMemberID,
                      ModifiedDate = SYSUTCDATETIME()
                  WHERE MemberId = @memberId
                `);
                prefixUpdates++;
              }
            }
          }
        }

        // ── 3f. Cancel future enrollments for re-enroll members (their existing
        //        future-dated enrollment is on the wrong product). Let-finish
        //        members keep their Active enrollment to run to term.
        //
        //        IMPORTANT: future-dated enrollments are sometimes inserted with
        //        Status='Active' (not 'Pending') by the link-completion flow, so
        //        we include 'Active' here. The EffectiveDate guard prevents this
        //        from touching anyone's currently-effective coverage — only rows
        //        whose period hasn't started yet are cancelled.
        if (memberIdsToReEnroll.length > 0) {
          const cancelRequest = transaction.request();
          const cancelParams = memberIdsToReEnroll.map((id, i) => {
            cancelRequest.input(`CancelM${i}`, sql.UniqueIdentifier, id);
            return `@CancelM${i}`;
          });
          // Same preserve guard as the letFinish UPDATE above: a mixed-bucket
          // member's preserve enrollment must survive the cancel sweep too.
          let preserveExcludeClause = '';
          if (preserveMappings.length > 0) {
            const excludeParams = preserveMappings.map((m, i) => {
              cancelRequest.input(`CancelExclude${i}`, sql.UniqueIdentifier, m.enrollmentId);
              return `@CancelExclude${i}`;
            });
            preserveExcludeClause = `AND EnrollmentId NOT IN (${excludeParams.join(',')})`;
          }
          const cancelResult = await cancelRequest.query(`
            UPDATE oe.Enrollments
            SET Status = 'Cancelled', ModifiedDate = SYSUTCDATETIME()
            WHERE MemberId IN (${cancelParams.join(',')})
              AND EffectiveDate > CAST(GETUTCDATE() AS DATE)
              AND Status IN ('Active', 'Pending', 'Pending Payment')
              ${preserveExcludeClause}
          `);
          enrollmentsCancelled = cancelResult.rowsAffected[0] || 0;
        }

        // ── 3g. Flip the GroupType last — only after everything else has
        //        committed, so the type and the underlying products /
        //        enrollments stay in sync.
        await transaction.request()
          .input('GroupId', sql.UniqueIdentifier, groupId)
          .input('NewType', sql.NVarChar, newGroupType)
          .query(`
            UPDATE oe.Groups
            SET GroupType = @NewType, ModifiedDate = SYSUTCDATETIME()
            WHERE GroupId = @GroupId
          `);

        // ── 3h. Mark the Approved request as applied so the agent's
        //        "Conversion approved — finish in the wizard" banner
        //        clears, and so a future double-flip doesn't accidentally
        //        re-surface this row as "pending action" by the heuristic.
        await transaction.request()
          .input('RequestId', sql.UniqueIdentifier, appliedRequestId)
          .query(`
            UPDATE oe.GroupTypeChangeRequests
            SET AppliedAt = SYSUTCDATETIME(),
                ModifiedDate = SYSUTCDATETIME()
            WHERE RequestId = @RequestId
          `);

        await transaction.commit();
      } catch (txError) {
        await transaction.rollback();
        logger.error(`[GROUPS-ROUTE] type-change/apply transaction error: ${txError.message}`);
        return res.status(500).json({ success: false, message: 'Apply failed — transaction rolled back.' });
      }

      return res.json({
        success: true,
        data: {
          productsHidden,
          productsAdded,
          preservedEnrollmentsRepointed,
          enrollmentsTerminationScheduled,
          householdIdsCleared,
          enrollmentsCancelled,
          prefixUpdates,
          groupType: newGroupType
        }
      });
    } catch (error) {
      logger.error(`[GROUPS-ROUTE] Error applying type-change: ${error.message}`);
      return res.status(500).json({ success: false, message: 'Failed to apply type change.' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/groups/:id/type-change/available-products
// ---------------------------------------------------------------------------
// Wizard Step 2 product picker. Same response shape as
// GET /api/groups/:groupId/products and same tenant-visibility rules:
//
//   - A product is available to the tenant if EITHER (a) it has an active
//     oe.ProductSubscriptions row for this tenant, OR (b) it's flagged
//     IsMarketplaceProduct = 1. The marketplace flag is the platform's
//     intentional cross-tenant visibility mechanism (e.g. Pinnacle Concierge
//     → MightyWELL Health). Mirrors production behavior; do NOT remove the
//     marketplace fall-through without aligning with the standard /products
//     endpoint and product owners.
//   - Pre-narrows by SalesType based on the most-recent Approved type-change
//     request's `RequestedType`:
//       - target = ListBill  → SalesType IN ('Individual', 'Both')
//       - target = Standard  → SalesType IN ('Group',      'Both')
//     This makes the endpoint usable for the reverse direction (ListBill →
//     Standard) — previously it was hardcoded for ListBill only.
//   - Excludes IsHidden products.
//
// `groupProducts` (already-assigned products) is unchanged — that's a real
// relationship the agent is allowed to see regardless of subscription state.
//
// Access: SysAdmin, TenantAdmin, or the Agent who owns the group.
// ---------------------------------------------------------------------------
router.get(
  '/:id/type-change/available-products',
  authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const { id: groupId } = req.params;
      const pool = await getPool();
      const userRoles = getUserRoles(req.user);
      const isSysAdmin = userRoles.includes('SysAdmin');
      const isAgent = userRoles.includes('Agent') && req.user?.currentRole === 'Agent';

      // Verify group exists + caller has access (mirror the preview/apply auth pattern).
      const groupRequest = pool.request().input('GroupId', sql.UniqueIdentifier, groupId);
      let accessQuery = `
        SELECT g.GroupId, g.TenantId, g.Name, g.Status
        FROM oe.Groups g
        WHERE g.GroupId = @GroupId AND g.Status = 'Active'
      `;
      if (isAgent) {
        const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
        if (accessibleAgentIds.length === 0) {
          return res.status(403).json({ success: false, message: 'Not a valid agent.' });
        }
        const scope = buildAgentScopeClause(groupRequest, accessibleAgentIds, 'g.AgentId', 'agAvail');
        accessQuery += ` AND ${scope}`;
      } else if (!isSysAdmin) {
        groupRequest.input('TenantId', sql.UniqueIdentifier, req.tenantId);
        accessQuery += ' AND g.TenantId = @TenantId';
      }
      const groupResult = await groupRequest.query(accessQuery);
      if (!groupResult.recordset.length) {
        return res.status(404).json({ success: false, message: 'Group not found or access denied.' });
      }
      const group = groupResult.recordset[0];

      // Resolve direction from the most-recent Approved type-change request.
      // Falls back to ListBill if no request exists (e.g. agent loads the
      // wizard URL directly without going through the request flow); the
      // wizard's preview step would 400 in that case anyway, so the fallback
      // is just a safety net.
      const reqResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .input('TenantId', sql.UniqueIdentifier, group.TenantId)
        .query(`
          SELECT TOP 1 RequestedType
          FROM oe.GroupTypeChangeRequests
          WHERE GroupId = @GroupId
            AND TenantId = @TenantId
            AND Status = 'Approved'
          ORDER BY CreatedDate DESC
        `);
      const targetType = reqResult.recordset[0]?.RequestedType || 'ListBill';
      const allowedSalesTypes = targetType === 'ListBill'
        ? ['Individual', 'Both']
        : ['Group', 'Both'];

      // Available products — strict subscription filter. INNER JOIN on
      // ProductSubscriptions ensures only products the tenant has actually
      // subscribed to appear; no marketplace wildcard. SalesType IN clause is
      // built dynamically from the resolved targetType.
      const availableRequest = pool.request()
        .input('TenantId', sql.UniqueIdentifier, group.TenantId);
      const salesTypeParams = allowedSalesTypes.map((st, i) => {
        const name = `SalesType${i}`;
        availableRequest.input(name, sql.NVarChar, st);
        return `@${name}`;
      });
      const availableResult = await availableRequest.query(`
        SELECT DISTINCT
          p.ProductId,
          p.Name,
          p.ProductType,
          p.Description,
          p.Status AS IsActive,
          p.MinAge, p.MaxAge,
          p.SalesType,
          p.IsHidden,
          p.IsBundle,
          p.AllowedStates,
          p.ProductImageUrl,
          p.ProductLogoUrl,
          p.ProductDocumentUrl,
          COALESCE(t.Name, 'Unknown') AS ProductOwner,
          ISNULL((
            SELECT MIN(pp.NetRate + ISNULL(pp.OverrideRate, 0))
            FROM oe.ProductPricing pp
            WHERE pp.ProductId = p.ProductId AND pp.Status = 'Active'
          ), 0) AS BasePrice
        FROM oe.Products p
        LEFT JOIN oe.ProductSubscriptions ps
          ON ps.ProductId = p.ProductId
          AND ps.TenantId = @TenantId
          AND ps.Status = 'Approved'
        LEFT JOIN oe.Tenants t ON t.TenantId = p.ProductOwnerId
        WHERE p.Status = 'Active'
          AND (p.IsHidden IS NULL OR p.IsHidden = 0)
          AND p.SalesType IN (${salesTypeParams.join(',')})
          -- Mirror production /api/groups/:id/products: a product is visible
          -- to a tenant if EITHER (a) it has an active ProductSubscription for
          -- that tenant, OR (b) IsMarketplaceProduct=1 (cross-tenant marketplace).
          -- The marketplace flag is the platform's intentional cross-tenant
          -- visibility mechanism (e.g. Pinnacle Concierge → MightyWELL).
          AND (ps.ProductId IS NOT NULL OR p.IsMarketplaceProduct = 1)
      `);

      // Already-assigned group products — visible regardless of subscription
      // state because the relationship is real and the agent needs context.
      const groupProductsResult = await pool.request()
        .input('GroupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT
            gp.GroupProductId, gp.GroupId, gp.ProductId,
            gp.IsActive, gp.CustomSettings, gp.CreatedDate, gp.ModifiedDate,
            gp.CreatedBy, gp.ModifiedBy, gp.IsHidden AS GroupProductIsHidden,
            p.Name, p.ProductType, p.Description,
            p.Status AS ProductStatus,
            p.MinAge, p.MaxAge, p.SalesType, p.IsHidden, p.IsBundle, p.AllowedStates,
            p.ProductImageUrl, p.ProductLogoUrl, p.ProductDocumentUrl,
            COALESCE(t.Name, 'Unknown') AS ProductOwner,
            ISNULL((
              SELECT MIN(pp.NetRate + ISNULL(pp.OverrideRate, 0))
              FROM oe.ProductPricing pp
              WHERE pp.ProductId = p.ProductId AND pp.Status = 'Active'
            ), 0) AS BasePrice
          FROM oe.GroupProducts gp
          INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
          LEFT JOIN oe.Tenants t ON t.TenantId = p.ProductOwnerId
          WHERE gp.GroupId = @GroupId
            AND gp.IsActive = 1
            AND p.Status = 'Active'
        `);

      const formatProduct = (p) => ({
        ProductId: p.ProductId,
        Name: p.Name,
        ProductType: p.ProductType,
        Description: p.Description,
        BasePrice: p.BasePrice || 0,
        ProductOwner: p.ProductOwner,
        AllowedStates: p.AllowedStates ? JSON.parse(p.AllowedStates) : [],
        MinAge: p.MinAge || 0,
        MaxAge: p.MaxAge || 65,
        SalesType: p.SalesType || 'Individual',
        IsHidden: p.IsHidden || 0,
        IsBundle: p.IsBundle || 0,
        IsActive: p.IsActive === 'Active' || p.ProductStatus === 'Active',
        ProductImageUrl: p.ProductImageUrl,
        ProductLogoUrl: p.ProductLogoUrl,
        ProductDocumentUrl: p.ProductDocumentUrl
      });

      return res.json({
        success: true,
        data: {
          group: { GroupId: group.GroupId, Name: group.Name, TenantId: group.TenantId, Status: group.Status },
          availableProducts: availableResult.recordset.map(formatProduct),
          groupProducts: groupProductsResult.recordset.map(formatProduct)
        }
      });
    } catch (error) {
      logger.error(`[GROUPS-ROUTE] Error loading wizard available-products: ${error.message}`);
      return res.status(500).json({ success: false, message: 'Failed to load products for wizard.' });
    }
  }
);

// Re-export the validation helper so tests / other callers can `require('./groups').isValidEarliestEffectiveDate`
// without knowing the extraction happened. The canonical definition lives in `_groups-validation.js`.
router.isValidEarliestEffectiveDate = isValidEarliestEffectiveDate;
module.exports = router;
module.exports.isValidEarliestEffectiveDate = isValidEarliestEffectiveDate;
