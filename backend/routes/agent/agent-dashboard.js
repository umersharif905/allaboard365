const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authorize } = require('../../middleware/auth');
const requireTenantAccess = require('../../middleware/requireTenantAccess');

// Helper function to get Agent ID from user object
const getAgentId = (req) => req.user?.UserId || req.user?.userId;

/**
 * @route   GET /api/agents/dashboard
 * @desc    Get dashboard metrics for the authenticated agent
 * @access  Private (Agent, Admin, SysAdmin)
 */
router.get('/', authorize(['Agent', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const agentId = getAgentId(req);
        if (!agentId) {
            return res.status(400).json({ success: false, message: 'Agent ID not found in token' });
        }

        const pool = await getPool();
        const request = pool.request(); // Create a new request for this transaction
        const errors = [];
        
        // Helper function to safely run queries, return a default, and log errors
        const safeQuery = async (query, defaultValue, queryName, params = []) => {
            try {
                const newRequest = pool.request(); // Use a fresh request for each query
                params.forEach(p => newRequest.input(p.name, p.type, p.value));
                const result = await newRequest.query(query);
                return result.recordset;
            } catch (error) {
                const errorMessage = `Dashboard query '${queryName}' failed: ${error.message}`;
                console.warn(errorMessage);
                errors.push(errorMessage);
                return defaultValue;
            }
        };

        const agentIdParam = { name: 'agentId', type: sql.UniqueIdentifier, value: agentId };

        // 1. Total Active Members
        const membersResult = await safeQuery(`SELECT COUNT(DISTINCT MemberId) as totalActiveMembers FROM oe.Members WHERE AgentId = @agentId AND Status = 'Active'`, [{ totalActiveMembers: 0 }], 'totalActiveMembers', [agentIdParam]);

        // 2. Commissions (Month-to-date)
        const commissionsMTDResult = await safeQuery(`SELECT ISNULL(SUM(Amount), 0) as commissionsMTD FROM oe.Commissions WHERE AgentId = @agentId AND Status = 'Paid' AND MONTH(ISNULL(PaidDate, CreatedDate)) = MONTH(GETDATE()) AND YEAR(ISNULL(PaidDate, CreatedDate)) = YEAR(GETDATE())`, [{ commissionsMTD: 0 }], 'commissionsMTD', [agentIdParam]);

        // 3. Commissions (YTD)
        const commissionsYTDResult = await safeQuery(`SELECT ISNULL(SUM(Amount), 0) as commissionsYTD FROM oe.Commissions WHERE AgentId = @agentId AND Status = 'Paid' AND YEAR(ISNULL(PaidDate, CreatedDate)) = YEAR(GETDATE())`, [{ commissionsYTD: 0 }], 'commissionsYTD', [agentIdParam]);

        // 4. Upcoming Payments (Pending Commissions)
        const upcomingPaymentsResult = await safeQuery(`SELECT COUNT(DISTINCT CommissionId) as upcomingPayments FROM oe.Commissions WHERE AgentId = @agentId AND Status = 'Pending'`, [{ upcomingPayments: 0 }], 'upcomingPayments', [agentIdParam]);

        // 5. Pending Applications
        const pendingApplicationsResult = await safeQuery(`SELECT COUNT(p.PaymentId) as pendingApplications FROM oe.Payments p JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId WHERE e.AgentId = @agentId AND p.Status = 'Pending'`, [{ pendingApplications: 0 }], 'pendingApplications', [agentIdParam]);

        // 6. Failed Payments
        const failedPaymentsResult = await safeQuery(`SELECT COUNT(p.PaymentId) as failedPayments FROM oe.Payments p JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId WHERE e.AgentId = @agentId AND p.Status = 'Failed'`, [{ failedPayments: 0 }], 'failedPayments', [agentIdParam]);

        // 7. Recent Commissions (Top 5 Pending)
        const recentCommissionsResult = await safeQuery(`SELECT TOP 5 c.CommissionId as commissionId, c.Amount as commissionAmount, p.Name as productName, u.FirstName + ' ' + u.LastName as memberName FROM oe.Commissions c JOIN oe.Enrollments e ON c.EnrollmentId = e.EnrollmentId JOIN oe.Products p ON e.ProductId = p.ProductId JOIN oe.Members m ON e.MemberId = m.MemberId JOIN oe.Users u ON m.UserId = u.UserId WHERE c.AgentId = @agentId AND c.Status = 'Pending' ORDER BY ISNULL(c.CalculationDate, c.CreatedDate) DESC`, [], 'recentCommissions', [agentIdParam]);

        // New Members This Month (last 30 days)
        const newMembersResult = await safeQuery(
          `SELECT COUNT(*) as newMembersThisMonth FROM oe.Members WHERE AgentId = @agentId AND Status = 'Active' AND CreatedDate >= DATEADD(day, -30, GETDATE())`,
          [{ newMembersThisMonth: 0 }],
          'newMembersThisMonth',
          [agentIdParam]
        );

        const dashboardData = {
            totalActiveMembers: membersResult[0]?.totalActiveMembers,
            newMembersThisMonth: newMembersResult[0]?.newMembersThisMonth,
            commissionsMTD: commissionsMTDResult[0]?.commissionsMTD,
            commissionsYTD: commissionsYTDResult[0]?.commissionsYTD,
            upcomingPayments: upcomingPaymentsResult[0]?.upcomingPayments,
            pendingApplications: pendingApplicationsResult[0]?.pendingApplications,
            failedPayments: failedPaymentsResult[0]?.failedPayments,
            recentCommissions: recentCommissionsResult,
        };

        res.json({ success: true, data: dashboardData });

    } catch (error) {
        console.error('Critical error fetching agent dashboard data:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_DASHBOARD_CRITICAL_ERROR' });
    }
});

module.exports = router;