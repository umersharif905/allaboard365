// backend/routes/group-admin/group-agent.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authenticate, authorize } = require('../../middleware/auth');

/**
 * @api {get} /group-admin/my-agent/:agentId Get agent details by ID
 * @apiName GetAgentDetails
 * @apiGroup GroupAdmin
 * @apiDescription Get details about an agent assigned to the group admin's group
 * 
 * @apiHeader {String} Authorization Bearer token
 * 
 * @apiParam {String} agentId Agent's ID to retrieve
 * 
 * @apiSuccess {Boolean} success Indicates if the operation was successful
 * @apiSuccess {Object} data Agent details
 * @apiSuccess {String} data.AgentId The agent's ID
 * @apiSuccess {String} data.UserId The user ID associated with the agent
 * @apiSuccess {String} data.FirstName The agent's first name
 * @apiSuccess {String} data.LastName The agent's last name
 * @apiSuccess {String} data.Email The agent's email
 */
router.get('/my-agent/:agentId', authorize(['GroupAdmin']), async (req, res) => {
    try {
        const agentId = req.params.agentId;
        const groupAdminUserId = req.user.UserId;

        if (!agentId) {
            return res.status(400).json({
                success: false,
                message: 'Agent ID is required',
                code: 'MISSING_AGENT_ID'
            });
        }

        const pool = await getPool();

        // First, verify the agent belongs to the group admin's group
        const verifyRequest = pool.request();
        verifyRequest.input('groupAdminUserId', sql.UniqueIdentifier, groupAdminUserId);
        verifyRequest.input('agentId', sql.UniqueIdentifier, agentId);

        const verifyResult = await verifyRequest.query(`
            SELECT g.GroupId 
            FROM oe.GroupAdmins ga
            JOIN oe.Groups g ON ga.GroupId = g.GroupId
            WHERE ga.UserId = @groupAdminUserId 
            AND g.AgentId = @agentId
            AND ga.Status = 'Active'
        `);

        if (verifyResult.recordset.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'This agent is not assigned to your group or you do not have permission to access this agent',
                code: 'AGENT_ACCESS_DENIED'
            });
        }

        // Get agent details with user information
        const request = pool.request();
        request.input('agentId', sql.UniqueIdentifier, agentId);

        const result = await request.query(`
            SELECT 
                a.AgentId,
                u.UserId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.Status as UserStatus
            FROM oe.Agents a
            JOIN oe.Users u ON a.UserId = u.UserId
            WHERE a.AgentId = @agentId
        `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent not found',
                code: 'AGENT_NOT_FOUND'
            });
        }

        res.json({
            success: true,
            data: result.recordset[0]
        });

    } catch (error) {
        console.error('❌ Error getting agent details:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving agent details',
            code: 'AGENT_DETAILS_ERROR',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router; 