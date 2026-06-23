// backend/routes/me/group-admin/tenant.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');

/**
 * @route   GET /api/me/group-admin/tenant
 * @desc    Get the current group admin's tenant details by finding their group first
 * @access  Private (GroupAdmin only)
 */
router.get('/', authorize(['GroupAdmin']), async (req, res) => {
    logger.info(`[GROUP-ADMIN-ME-TENANT-ROUTE] >> Request received for GroupAdmin's tenant.`);
    try {
        if (!req.user || !req.user.userId) {
            logger.error("[GROUP-ADMIN-ME-TENANT-ROUTE] !! GroupAdmin user or userId is missing from request object.");
            return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
        }

        const userId = req.user.userId;
        const pool = await getPool();

        // First, find the user's group to get the tenantId
        const groupResult = await pool.request()
            .input('UserId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT g.TenantId 
                FROM oe.Groups g
                JOIN oe.Members m ON g.GroupId = m.GroupId
                WHERE m.UserId = @UserId
            `);

        if (groupResult.recordset.length === 0 || !groupResult.recordset[0].TenantId) {
            logger.error(`[GROUP-ADMIN-ME-TENANT-ROUTE] Could not find group or tenant for user ${userId}`);
            return res.status(404).json({ success: false, message: 'Could not determine the tenant for this group admin.' });
        }

        const tenantId = groupResult.recordset[0].TenantId;
        logger.info(`[GROUP-ADMIN-ME-TENANT-ROUTE] Found TenantId ${tenantId} for user ${userId}. Fetching tenant details.`);

        const tenantResult = await pool.request()
            .input('TenantId', sql.UniqueIdentifier, tenantId)
            .query('SELECT * FROM oe.Tenants WHERE TenantId = @TenantId');

        if (tenantResult.recordset.length === 0) {
            logger.error(`[GROUP-ADMIN-ME-TENANT-ROUTE] Tenant with ID ${tenantId} not found.`);
            return res.status(404).json({ success: false, message: 'Tenant details not found.' });
        }

        logger.info(`[GROUP-ADMIN-ME-TENANT-ROUTE] << Successfully fetched tenant details. Responding with 200.`);
        res.json({ success: true, data: tenantResult.recordset[0] });

    } catch (error) {
        logger.error(`[GROUP-ADMIN-ME-TENANT-ROUTE] !! Server error: ${error.message}`);
        logger.error(`[GROUP-ADMIN-ME-TENANT-ROUTE] Stacktrace: ${error.stack}`);
        res.status(500).json({ success: false, message: 'Server error while fetching tenant details.' });
    }
});

module.exports = router; 