// backend/src/routes/adminCommissions.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../config/database');
const logger = require('../config/logger');
const { authenticate, authorize } = require('../middleware/auth');

// Apply authentication to all routes
router.use(authenticate);

/**
 * @route GET /api/admin/commissions/system-metrics
 * @desc Get system-wide commission metrics
 * @access SysAdmin
 */
router.get('/system-metrics', authorize(['SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    // Get total system commissions
    const commissionsQuery = await pool.request().query(`
      SELECT 
        ISNULL(SUM(CommissionAmount), 0) as totalSystemCommissions,
        COUNT(DISTINCT TenantId) as totalTenants,
        COUNT(DISTINCT AgentId) as totalAgents,
        COUNT(DISTINCT RuleId) as totalRules,
        ISNULL(SUM(CASE WHEN Status = 'Pending' THEN 1 ELSE 0 END), 0) as pendingBatches
      FROM oe.CommissionLogs
      WHERE Status IN ('Paid', 'Pending', 'Approved')
    `);
    
    // Get YTD commissions
    const ytdQuery = await pool.request()
      .input('yearStart', sql.DateTime2, new Date(new Date().getFullYear(), 0, 1))
      .query(`
        SELECT 
          ISNULL(SUM(CommissionAmount), 0) as ytdCommissions
        FROM oe.CommissionLogs
        WHERE CreatedDate >= @yearStart
          AND Status IN ('Paid', 'Approved')
      `);
    
    // Get monthly growth
    const growthQuery = await pool.request()
      .input('currentMonthStart', sql.DateTime2, new Date(new Date().getFullYear(), new Date().getMonth(), 1))
      .input('lastMonthStart', sql.DateTime2, new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1))
      .input('lastMonthEnd', sql.DateTime2, new Date(new Date().getFullYear(), new Date().getMonth(), 0))
      .query(`
        WITH MonthlyData AS (
          SELECT 
            ISNULL(SUM(CASE WHEN CreatedDate >= @currentMonthStart THEN CommissionAmount ELSE 0 END), 0) as currentMonth,
            ISNULL(SUM(CASE WHEN CreatedDate >= @lastMonthStart AND CreatedDate < @lastMonthEnd THEN CommissionAmount ELSE 0 END), 0) as lastMonth
          FROM oe.CommissionLogs
          WHERE Status IN ('Paid', 'Approved')
        )
        SELECT 
          currentMonth,
          lastMonth,
          CASE 
            WHEN lastMonth = 0 THEN 0
            ELSE ((currentMonth - lastMonth) / lastMonth) * 100
          END as monthlyGrowth
        FROM MonthlyData
      `);
    
    const metrics = {
      totalSystemCommissions: commissionsQuery.recordset[0].totalSystemCommissions,
      totalTenants: commissionsQuery.recordset[0].totalTenants,
      totalAgents: commissionsQuery.recordset[0].totalAgents,
      totalRules: commissionsQuery.recordset[0].totalRules,
      pendingBatches: commissionsQuery.recordset[0].pendingBatches,
      monthlyGrowth: growthQuery.recordset[0].monthlyGrowth,
      ytdCommissions: ytdQuery.recordset[0].ytdCommissions,
      avgCommissionPerTenant: commissionsQuery.recordset[0].totalTenants > 0 
        ? commissionsQuery.recordset[0].totalSystemCommissions / commissionsQuery.recordset[0].totalTenants 
        : 0
    };
    
    res.json({
      success: true,
      metrics
    });
    
  } catch (error) {
    logger.error('Error fetching system commission metrics', { error: error.message }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch system metrics' 
    });
  }
});

/**
 * @route GET /api/admin/commissions/tenant-summaries
 * @desc Get commission summaries for all tenants
 * @access SysAdmin
 */
router.get('/tenant-summaries', authorize(['SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    const summariesQuery = await pool.request().query(`
      SELECT 
        t.TenantId as tenantId,
        t.Name as tenantName,
        ISNULL(SUM(cl.CommissionAmount), 0) as totalCommissions,
        COUNT(DISTINCT a.AgentId) as activeAgents,
        ISNULL(SUM(CASE WHEN cl.Status = 'Pending' THEN cl.CommissionAmount ELSE 0 END), 0) as pendingAmount,
        CASE 
          WHEN EXISTS (SELECT 1 FROM oe.CommissionLogs WHERE TenantId = t.TenantId AND Status = 'Processing') THEN 'Processing'
          WHEN EXISTS (SELECT 1 FROM oe.CommissionLogs WHERE TenantId = t.TenantId AND Status = 'Pending') THEN 'Active'
          ELSE 'Inactive'
        END as status,
        ISNULL(MAX(cl.CreatedDate), t.CreatedDate) as lastProcessed
      FROM oe.Tenants t
      LEFT JOIN oe.CommissionLogs cl ON t.TenantId = cl.TenantId
      LEFT JOIN oe.Agents a ON t.TenantId = a.TenantId AND a.Status = 'Active'
      WHERE t.Status = 'Active'
      GROUP BY t.TenantId, t.Name, t.CreatedDate
      ORDER BY totalCommissions DESC
    `);
    
    res.json({
      success: true,
      data: summariesQuery.recordset
    });
    
  } catch (error) {
    logger.error('Error fetching tenant summaries', { error: error.message }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch tenant summaries' 
    });
  }
});

/**
 * @route GET /api/admin/commissions/system-rules
 * @desc Get all commission rules across the system
 * @access SysAdmin
 */
router.get('/system-rules', authorize(['SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    const rulesQuery = await pool.request().query(`
      SELECT 
        cr.RuleId as ruleId,
        cr.RuleName as ruleName,
        t.Name as tenantName,
        p.Name as productName,
        cr.CommissionType as commissionType,
        cr.Rate as rate,
        cr.Amount as amount,
        cr.Status as status,
        cr.EffectiveDate as effectiveDate,
        u.FirstName + ' ' + u.LastName as createdBy
      FROM oe.CommissionRules cr
      INNER JOIN oe.Tenants t ON cr.TenantId = t.TenantId
      INNER JOIN oe.Products p ON cr.ProductId = p.ProductId
      LEFT JOIN oe.Users u ON cr.CreatedBy = u.UserId
      WHERE cr.Status IN ('Active', 'Pending')
      ORDER BY cr.CreatedDate DESC
    `);
    
    res.json({
      success: true,
      rules: rulesQuery.recordset
    });
    
  } catch (error) {
    logger.error('Error fetching system rules', { error: error.message }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch system rules' 
    });
  }
});

/**
 * @route POST /api/admin/commissions/process-batches
 * @desc Process all pending commission batches
 * @access SysAdmin
 */
router.post('/process-batches', authorize(['SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    // Update all pending batches to processing
    await pool.request()
      .input('processingBy', sql.UniqueIdentifier, req.user.UserId)
      .input('processingDate', sql.DateTime2, new Date())
      .query(`
        UPDATE oe.CommissionBatches
        SET Status = 'Processing',
            ProcessedBy = @processingBy,
            ProcessedDate = @processingDate
        WHERE Status = 'Pending'
      `);
    
    logger.info('Commission batches processing initiated', { 
      initiatedBy: req.user.UserId,
      timestamp: new Date()
    }, 'Commission');
    
    res.json({
      success: true,
      message: 'Commission batch processing initiated'
    });
    
  } catch (error) {
    logger.error('Error processing batches', { error: error.message }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to process batches' 
    });
  }
});

/**
 * @route GET /api/admin/commissions/tenant/:tenantId
 * @desc Get detailed commission data for a specific tenant
 * @access SysAdmin
 */
router.get('/tenant/:tenantId', authorize(['SysAdmin']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const pool = await getPool();
    
    // Get tenant details with commission data
    const tenantQuery = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT 
          t.TenantId,
          t.Name,
          t.Status,
          COUNT(DISTINCT a.AgentId) as totalAgents,
          COUNT(DISTINCT cl.LogId) as totalTransactions,
          ISNULL(SUM(cl.CommissionAmount), 0) as totalCommissions,
          ISNULL(AVG(cl.CommissionAmount), 0) as avgCommission
        FROM oe.Tenants t
        LEFT JOIN oe.Agents a ON t.TenantId = a.TenantId
        LEFT JOIN oe.CommissionLogs cl ON t.TenantId = cl.TenantId
        WHERE t.TenantId = @tenantId
        GROUP BY t.TenantId, t.Name, t.Status
      `);
    
    if (tenantQuery.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }
    
    res.json({
      success: true,
      data: tenantQuery.recordset[0]
    });
    
  } catch (error) {
    logger.error('Error fetching tenant commission details', { error: error.message, tenantId: req.params.tenantId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch tenant details' 
    });
  }
});

module.exports = router;