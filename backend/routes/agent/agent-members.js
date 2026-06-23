const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authorize } = require('../../middleware/auth');
const requireTenantAccess = require('../../middleware/requireTenantAccess');

// The helper function was incorrect, the logic will be handled in the route.

/**
 * @route   GET /api/agents/members
 * @desc    Get all members assigned to the authenticated agent
 * @access  Private (Agent, Admin, SysAdmin)
 */
router.get('/members', authorize(['Agent', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const userId = req.user?.UserId || req.user?.userId;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID not found in token' });
        }
        
        const pool = await getPool();

        // First, get the AgentId from the UserId
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Agent not found for this user' });
        }
        const agentId = agentResult.recordset[0].AgentId;
        console.log('agentId', agentId);

        // Now, fetch members for that AgentId
        const result = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`
                SELECT 
                    m.MemberId, m.UserId, u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                    m.Status, m.RelationshipType, FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                    g.Name as GroupName, g.GroupId,
                    (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') as ActivePolicies,
                    -- Calculate totalPremium: sum of Product enrollments only (excludes fees)
                    ISNULL((
                        SELECT SUM(e.PremiumAmount)
                        FROM oe.Enrollments e
                        WHERE e.MemberId = m.MemberId
                            AND e.Status = 'Active'
                            AND e.EnrollmentType = 'Product'
                            AND e.ProductId != '00000000-0000-0000-0000-000000000000'
                    ), 0) as TotalPremium,
                    -- Calculate dependentCount: count of dependents in household (excluding primary member)
                    ISNULL((
                        SELECT COUNT(*)
                        FROM oe.Members hm
                        WHERE hm.HouseholdId = m.HouseholdId
                            AND hm.Status = 'Active'
                            AND hm.RelationshipType != 'P'
                    ), 0) as DependentCount
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE m.AgentId = @agentId
                ORDER BY u.LastName, u.FirstName
            `);
        console.log('result length', result.recordset.length);
        res.json({ success: true, data: result.recordset });

    } catch (error) {
        console.error('Error fetching agent members:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_MEMBERS_ERROR' });
    }
});

module.exports = router;