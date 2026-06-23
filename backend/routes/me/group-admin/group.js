// backend/routes/me/group-admin/group.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const logger = require('../../../config/logger');
const { getPool } = require('../../../config/database');
const {
  ENROLLMENT_ROSTER_LINE_AMOUNT_SQL,
  MEMBER_LIST_PREMIUM_ENROLLMENT_WHERE_SQL,
} = require('../../../utils/memberEnrollmentStatusSql');

logger.info('✅ MODULE LOADED: backend/routes/me/group-admin/group.js');

/**
 * @route   GET /api/me/group-admin/group
 * @desc    Get the current group admin's assigned group details
 * @access  Private (GroupAdmin only)
 */
router.get('/', authorize(['GroupAdmin']), async (req, res) => {
    logger.info(`[GROUP-ADMIN-ROUTE] >> Request received for ${req.path}`);
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[GROUP-ADMIN-ROUTE] !! User or UserId is missing from request object.');
            return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
        }

        const userId = req.user.UserId;
        logger.info(`[GROUP-ADMIN-ROUTE] UserID: ${userId}`);

        const pool = await getPool();

        // Step 1: Get the GroupId using the unified method (supports both Members table and email matching)
        const UserManagementService = require('../../../services/shared/user-management.service');
        const groupId = await UserManagementService.getGroupIdForUser(userId, pool);
        
        if (!groupId) {
            logger.warn(`[GROUP-ADMIN-ROUTE] No group found for user ${userId}`);
            return res.status(404).json({ success: false, message: 'No group found for user.' });
        }
        logger.info(`[GROUP-ADMIN-ROUTE] Found GroupId: ${groupId}`);

        // Step 2: Get the main group details
        const groupPromise = pool.request()
            .input('GroupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT g.*, t.Name AS TenantName, t.CustomDomain AS TenantCustomDomain, a.FirstName AS AgentFirstName, a.LastName AS AgentLastName
                FROM oe.Groups g
                LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
                LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
                WHERE g.GroupId = @GroupId
            `);

        // Step 3: Get the aggregate metrics and plan start dates (Product enrollments only = when benefits start)
        const metricsPromise = pool.request()
            .input('GroupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT
                    (SELECT COUNT(*) FROM oe.Members WHERE GroupId = @GroupId) AS TotalMembers,
                    (SELECT COUNT(*) FROM oe.Enrollments e JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = @GroupId AND e.Status = 'Active') AS ActiveEnrollments,
                    -- MonthlyPremium: product display + Active fee rows (matches member roster / invoice due)
                    (SELECT ISNULL(SUM(${ENROLLMENT_ROSTER_LINE_AMOUNT_SQL}), 0) 
                        FROM oe.Enrollments e 
                        JOIN oe.Members m ON e.MemberId = m.MemberId 
                        WHERE m.GroupId = @GroupId 
                          AND ${MEMBER_LIST_PREMIUM_ENROLLMENT_WHERE_SQL}
                    ) AS MonthlyPremium,
                    -- Plan start dates: Product only, not terminated (same logic as billing / invoiceCalculationService)
                    (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = @GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) >= CAST(GETUTCDATE() AS DATE)) AS EarliestFutureEffectiveDate,
                    (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = @GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) < CAST(GETUTCDATE() AS DATE)) AS EarliestActiveEffectiveDate,
                    (SELECT COUNT(DISTINCT CAST(e.EffectiveDate AS DATE)) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = @GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) > CAST(GETUTCDATE() AS DATE)) AS FutureEffectiveDateCount
            `);

        // Run queries in parallel for efficiency
        const [groupResult, metricsResult] = await Promise.all([groupPromise, metricsPromise]);

        if (groupResult.recordset.length === 0) {
            logger.error(`[GROUP-ADMIN-ROUTE] Group with ID ${groupId} not found.`);
            return res.status(404).json({ success: false, message: 'Group details not found.' });
        }

        // Step 4: Combine the results
        const groupData = groupResult.recordset[0];
        const metricsData = metricsResult.recordset[0];

        const combinedData = {
            ...groupData,
            ...metricsData,
            AgentName: `${groupData.AgentFirstName || ''} ${groupData.AgentLastName || ''}`.trim(),
        };
        // Clean up temporary fields
        delete combinedData.AgentFirstName;
        delete combinedData.AgentLastName;

        logger.info(`[GROUP-ADMIN-ROUTE] << Successfully fetched and combined group data. Responding with 200.`);
        res.json({ success: true, data: combinedData });

    } catch (error) {
        logger.error(`[GROUP-ADMIN-ROUTE] !! Server error: ${error.message}`);
        logger.error(`[GROUP-ADMIN-ROUTE] Stacktrace: ${error.stack}`);
        res.status(500).json({ success: false, message: 'Server error while fetching group details.' });
    }
});

module.exports = router; 