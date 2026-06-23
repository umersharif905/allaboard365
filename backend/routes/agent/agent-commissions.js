// routes/commissions.js - Complete Commission Management Routes with Tenant Support
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../../config/database');
const { authenticate, authorize, getUserRoles } = require('../../middleware/auth');
const logger = require('../../config/logger');
// const commissionService = require('../services/commissionService');
const requireTenantAccess = require('../../middleware/requireTenantAccess');
const { buildCommissionOwnerFilter } = require('../../utils/commissionOwnerFilter');

async function resolveAgentIdForCommissions(req) {
    if (req.user?.AgentId) return req.user.AgentId;
    if (req.user?.agentId) return req.user.agentId;
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) return null;
    const pool = await getPool();
    const result = await pool.request()
        .input('userId', sql.UniqueIdentifier, userId)
        .query(`
            SELECT AgentId FROM oe.Agents
            WHERE UserId = @userId AND Status = 'Active'
        `);
    return result.recordset?.[0]?.AgentId || null;
}

// Apply authentication to all routes
router.use(authenticate);

/**
 * @route   GET /api/agents/commissions/summary
 * @desc    Get commission summary for the authenticated agent
 * @access  Private (Agent, Admin, SysAdmin)
 */
router.get('/commissions/summary', authorize(['Agent', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const agentId = await resolveAgentIdForCommissions(req);
        if (!agentId) {
            return res.status(400).json({ success: false, message: 'Agent ID not found in token' });
        }

        const { perspective, commissionOwnerFilter } = req.query;
        const userId = req.user?.UserId || req.user?.userId;

        const pool = await getPool();

        // Resolve agency for the agent so the owner filter can authorize agency-wide scope.
        let agencyId = null;
        const agencyRow = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`SELECT AgencyId FROM oe.Agents WHERE AgentId = @agentId AND Status = 'Active'`);
        agencyId = agencyRow.recordset?.[0]?.AgencyId || null;

        const ownerFilter = await buildCommissionOwnerFilter(req, pool, agentId, userId, agencyId, perspective, commissionOwnerFilter);
        if (ownerFilter.error) {
            return res.status(ownerFilter.error).json({ success: false, message: ownerFilter.message });
        }

        const ownerClause = ownerFilter.buildInClause('AgentId', 'AgencyId');

        const reqDb = pool.request();
        ownerFilter.bind(reqDb);
        const result = await reqDb.query(`
            SELECT
                ISNULL(SUM(CASE WHEN Status = 'Paid' THEN Amount ELSE 0 END), 0) as totalPaid,
                ISNULL(SUM(CASE WHEN Status = 'Pending' THEN Amount ELSE 0 END), 0) as totalPending,
                ISNULL(SUM(Amount), 0) as totalEarned
            FROM oe.Commissions
            WHERE ${ownerClause}
              AND Status <> N'Deleted'
        `);

        res.json({ success: true, data: result.recordset[0] });

    } catch (error) {
        console.error('Error fetching commission summary:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_COMMISSION_SUMMARY_ERROR' });
    }
});

/**
 * @route GET /api/commissions/agent-rules
 * @desc Get commission rules applicable to the authenticated agent
 * @access Agent, TenantAdmin, SysAdmin
 */
router.get('/agent-rules', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      // Always start with active rules
      let whereClause = 'WHERE cr.Status = \'Active\'';
      
      // Add tenant filtering for both agents and tenant admins
      const userRoles = getUserRoles(req.user);
      if (userRoles.includes('Agent') || userRoles.includes('TenantAdmin')) {
        request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
        whereClause += ' AND (cr.TenantId = @TenantId OR cr.TenantId IS NULL)';
      }
      
      // Add product filtering if specified in query params
      if (req.query.productId) {
        request.input('ProductId', sql.UniqueIdentifier, req.query.productId);
        whereClause += ' AND cr.ProductId = @ProductId';
      }
      
      console.log('Agent rules query - whereClause:', whereClause); // Debug logging
      
      const result = await request.query(`
        SELECT 
          cr.RuleId,
          cr.RuleName,
          cr.ProductId,
          p.Name as ProductName,
          cr.EntityType,
          cr.EntityId,
          cr.TierLevel,
          cr.CommissionType,
          cr.CommissionRate,
          cr.FlatAmount,
          cr.TieredRates,
          cr.CommissionJson,
          cr.PaymentTiming,
          cr.YearlySchedule,
          cr.MinimumPremium,
          cr.MaximumPremium,
          cr.EffectiveDate,
          cr.TerminationDate,
          cr.Priority,
          cr.Status,
          cr.TenantId,
          CASE 
            WHEN cr.TenantId IS NULL THEN 'Global'
            ELSE t.Name
          END as TenantName,
          CASE 
            WHEN cr.TenantId IS NULL THEN 1
            ELSE 0
          END as IsGlobal,
          cr.CreatedDate,
          cr.ModifiedDate
        FROM oe.CommissionRules cr
        LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
        LEFT JOIN oe.Tenants t ON cr.TenantId = t.TenantId
        ${whereClause}
        ORDER BY cr.Priority, cr.EffectiveDate DESC
      `);
      
      console.log(`Found ${result.recordset.length} rules for agent/tenant ${req.user.TenantId}`); // Debug logging
      
      res.json({
        success: true,
        rules: result.recordset
      });
      
    } catch (error) {
      logger.error('Error fetching agent commission rules', { error: error.message, user: req.user.UserId }, 'Commission');
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch commission rules' 
      });
    }
  });

  /**
 * @route   GET /api/agents/commissions/statement
 * @desc    Get detailed commission statement for the authenticated agent
 * @access  Private (Agent, Admin, SysAdmin)
 */
router.get('/commissions/statement', authorize(['Agent', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const agentId = await resolveAgentIdForCommissions(req);
        if (!agentId) {
            return res.status(400).json({ success: false, message: 'Agent ID not found in token' });
        }
        const { period = 'mtd' } = req.query; // 'mtd', 'ytd', 'all'
        
        let dateFilter = '';
        if (period === 'mtd') {
            dateFilter = 'AND MONTH(c.PaidDate) = MONTH(GETDATE()) AND YEAR(c.PaidDate) = YEAR(GETDATE())';
        } else if (period === 'ytd') {
            dateFilter = 'AND YEAR(c.PaidDate) = YEAR(GETDATE())';
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`
                SELECT
                    c.CommissionId, c.Amount, c.Status, c.PaidDate,
                    p.Name as ProductName,
                    CONCAT(u.FirstName, ' ', u.LastName) as MemberName,
                    g.Name as GroupName
                FROM oe.Commissions c
                JOIN oe.Enrollments e ON c.EnrollmentId = e.EnrollmentId
                JOIN oe.Products p ON e.ProductId = p.ProductId
                JOIN oe.Members m ON e.MemberId = m.MemberId
                JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE c.AgentId = @agentId ${dateFilter}
                ORDER BY c.PaidDate DESC
            `);

        res.json({ success: true, data: result.recordset });

    } catch (error) {
        console.error('Error fetching commission statement:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_COMMISSION_STATEMENT_ERROR' });
    }
});

module.exports = router;