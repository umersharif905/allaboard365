// backend/routes/me/agent/tenant.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');

/**
 * @route   GET /api/me/agent/tenant
 * @desc    Get the current agent's own tenant details
 * @access  Private (Agent only)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
    logger.info(`[AGENT-ME-TENANT-ROUTE] >> Request received for Agent's own tenant.`);
    logger.info(`[AGENT-ME-TENANT-ROUTE] >> User object:`, JSON.stringify(req.user, null, 2));
    try {
        if (!req.user) {
            logger.error("[AGENT-ME-TENANT-ROUTE] !! Agent user is missing from request object.");
            return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
        }

        let tenantId = req.user.TenantId;
        
        // If TenantId is not in user record, try to get it from Agents table
        if (!tenantId) {
            logger.info("[AGENT-ME-TENANT-ROUTE] >> TenantId not in user record, checking Agents table...");
            const pool = await getPool();
            const agentRequest = pool.request();
            agentRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
            
            const agentResult = await agentRequest.query(`
                SELECT a.TenantId 
                FROM oe.Agents a 
                WHERE a.UserId = @userId
            `);
            
            if (agentResult.recordset.length > 0) {
                tenantId = agentResult.recordset[0].TenantId;
                logger.info(`[AGENT-ME-TENANT-ROUTE] >> Found TenantId from Agents table: ${tenantId}`);
            } else {
                logger.error("[AGENT-ME-TENANT-ROUTE] !! Agent not found in Agents table.");
                return res.status(401).json({ success: false, message: 'Authentication error: Agent information not found.' });
            }
        }
        
        logger.info(`[AGENT-ME-TENANT-ROUTE] Fetching tenant for Agent. TenantId: ${tenantId}`);

        const pool = await getPool();
        const result = await pool.request()
            .input('TenantId', sql.UniqueIdentifier, tenantId)
            .query('SELECT * FROM oe.Tenants WHERE TenantId = @TenantId');

        if (result.recordset.length === 0) {
            logger.error(`[AGENT-ME-TENANT-ROUTE] Tenant with ID ${tenantId} not found for user ${req.user.userId}`);
            return res.status(404).json({ success: false, message: 'Tenant details not found.' });
        }

        logger.info(`[AGENT-ME-TENANT-ROUTE] << Successfully fetched tenant details. Responding with 200.`);
        res.json({ success: true, data: result.recordset[0] });

    } catch (error) {
        logger.error(`[AGENT-ME-TENANT-ROUTE] !! Server error: ${error.message}`);
        logger.error(`[AGENT-ME-TENANT-ROUTE] Stacktrace: ${error.stack}`);
        res.status(500).json({ success: false, message: 'Server error while fetching tenant details.' });
    }
});

module.exports = router; 