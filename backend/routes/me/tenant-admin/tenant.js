// backend/routes/me/tenant-admin/tenant.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');

/**
 * @route   GET /api/me/tenant-admin/tenant
 * @desc    Get the current tenant admin's own tenant details
 * @access  Private (TenantAdmin only)
 */
router.get('/', authorize(['TenantAdmin']), async (req, res) => {
    logger.info(`[TENANT-ME-ROUTE] >> Request received for TenantAdmin's own tenant.`);
    logger.info(`[TENANT-ME-ROUTE] >> User object:`, JSON.stringify(req.user, null, 2));
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error("[TENANT-ME-ROUTE] !! TenantAdmin user or TenantId is missing from request object.");
            logger.error("[TENANT-ME-ROUTE] !! User object keys:", req.user ? Object.keys(req.user) : 'No user object');
            return res.status(401).json({ success: false, message: 'Authentication error: User or tenant information is missing.' });
        }
        logger.info(`[TENANT-ME-ROUTE] Fetching tenant for TenantAdmin. TenantId: ${tenantId}`);

        const pool = await getPool();
        const result = await pool.request()
            .input('TenantId', sql.UniqueIdentifier, tenantId)
            .query('SELECT * FROM oe.Tenants WHERE TenantId = @TenantId');

        if (result.recordset.length === 0) {
            logger.error(`[TENANT-ME-ROUTE] Tenant with ID ${tenantId} not found for user ${req.user.userId}`);
            return res.status(404).json({ success: false, message: 'Tenant details not found.' });
        }

        logger.info(`[TENANT-ME-ROUTE] << Successfully fetched tenant details. Responding with 200.`);
        res.json({ success: true, data: result.recordset[0] });

    } catch (error) {
        logger.error(`[TENANT-ME-ROUTE] !! Server error: ${error.message}`);
        logger.error(`[TENANT-ME-ROUTE] Stacktrace: ${error.stack}`);
        res.status(500).json({ success: false, message: 'Server error while fetching tenant details.' });
    }
});

module.exports = router; 