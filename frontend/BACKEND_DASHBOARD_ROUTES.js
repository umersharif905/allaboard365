// backend/routes/admin/dashboard.js
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../middleware/auth');
const { getPool } = require('../../config/database');

// GET /api/admin/dashboard/metrics
router.get('/dashboard/metrics', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    const result = await pool.request().query(`
      SELECT 
        (SELECT COUNT(*) FROM oe.Members WHERE StatusId = 1) as totalMembers,
        (SELECT ISNULL(SUM(Amount), 0) FROM oe.Payments WHERE MONTH(PaymentDate) = MONTH(GETDATE()) AND YEAR(PaymentDate) = YEAR(GETDATE())) as monthlyRevenue,
        (SELECT COUNT(*) FROM oe.Tenants WHERE StatusId = 1) as totalTenants,
        (SELECT ISNULL(SUM(CommissionAmount), 0) FROM oe.Commissions WHERE MONTH(PaymentDate) = MONTH(GETDATE()) AND YEAR(PaymentDate) = YEAR(GETDATE())) as totalCommissions
    `);
    
    const metrics = result.recordset[0];
    
    // Calculate percentage changes (you'll need to implement month-over-month logic)
    metrics.membersChange = 12.5;
    metrics.revenueChange = 7.2;
    metrics.tenantsChange = 8.3;
    metrics.commissionsChange = 9.3;
    
    res.json(metrics);
  } catch (error) {
    console.error('Dashboard metrics error:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// GET /api/admin/dashboard/recent-enrollments
router.get('/dashboard/recent-enrollments', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    const result = await pool.request().query(`
      SELECT TOP 10 
        m.MemberId as memberId,
        CONCAT(m.FirstName, ' ', m.LastName) as memberName,
        p.ProductName as plan,
        e.EnrollmentDate as date,
        pp.MonthlyPremium as amount
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId  
      JOIN oe.Products p ON e.ProductId = p.ProductId
      LEFT JOIN oe.ProductPricing pp ON p.ProductId = pp.ProductId
      ORDER BY e.EnrollmentDate DESC
    `);
    
    res.json(result.recordset);
  } catch (error) {
    console.error('Recent enrollments error:', error);
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

// GET /api/admin/dashboard/top-tenants
router.get('/dashboard/top-tenants', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    const result = await pool.request().query(`
      SELECT TOP 4
        t.TenantName as tenantName,
        COUNT(DISTINCT m.MemberId) as totalMembers,
        ISNULL(SUM(p.Amount), 0) as monthlyRevenue
      FROM oe.Tenants t
      LEFT JOIN oe.Members m ON t.TenantId = m.TenantId
      LEFT JOIN oe.Payments p ON m.MemberId = p.MemberId 
        AND MONTH(p.PaymentDate) = MONTH(GETDATE()) 
        AND YEAR(p.PaymentDate) = YEAR(GETDATE())
      WHERE t.StatusId = 1
      GROUP BY t.TenantId, t.TenantName
      ORDER BY monthlyRevenue DESC
    `);
    
    res.json(result.recordset);
  } catch (error) {
    console.error('Top tenants error:', error);
    res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

// GET /api/admin/dashboard/revenue-by-product
router.get('/dashboard/revenue-by-product', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    const result = await pool.request().query(`
      SELECT 
        p.ProductType as productName,
        SUM(pay.Amount) as revenue,
        CAST(SUM(pay.Amount) * 100.0 / SUM(SUM(pay.Amount)) OVER() as DECIMAL(5,2)) as percentage
      FROM oe.Products p
      JOIN oe.Enrollments e ON p.ProductId = e.ProductId
      JOIN oe.Payments pay ON e.EnrollmentId = pay.EnrollmentId
      WHERE MONTH(pay.PaymentDate) = MONTH(GETDATE()) 
        AND YEAR(pay.PaymentDate) = YEAR(GETDATE())
      GROUP BY p.ProductType
      ORDER BY revenue DESC
    `);
    
    res.json(result.recordset);
  } catch (error) {
    console.error('Revenue by product error:', error);
    res.status(500).json({ error: 'Failed to fetch product revenue' });
  }
});

// GET /api/admin/dashboard/trending-enrollments
router.get('/dashboard/trending-enrollments', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const pool = await getPool();
    
    const result = await pool.request().query(`
      SELECT 
        'Week ' + CAST(DATEPART(WEEK, e.EnrollmentDate) - DATEPART(WEEK, DATEADD(MONTH, -1, GETDATE())) + 1 as VARCHAR) as week,
        COUNT(*) as enrollments
      FROM oe.Enrollments e
      WHERE e.EnrollmentDate >= DATEADD(MONTH, -1, GETDATE())
      GROUP BY DATEPART(WEEK, e.EnrollmentDate)
      ORDER BY DATEPART(WEEK, e.EnrollmentDate)
    `);
    
    res.json(result.recordset);
  } catch (error) {
    console.error('Trending enrollments error:', error);
    res.status(500).json({ error: 'Failed to fetch trending data' });
  }
});

// GET /api/admin/dashboard/monthly-revenue
router.get('/dashboard/monthly-revenue', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const pool = await getPool();
    const year = req.query.year || new Date().getFullYear();
    
    const result = await pool.request()
      .input('year', year)
      .query(`
        SELECT 
          LEFT(DATENAME(MONTH, DATEFROMPARTS(@year, MonthNum, 1)), 3) as name,
          ISNULL(revenue, 0) as revenue,
          ISNULL(profit, 0) as profit
        FROM (
          SELECT 1 as MonthNum UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 
          UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 
          UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12
        ) months
        LEFT JOIN (
          SELECT 
            MONTH(PaymentDate) as MonthNum,
            SUM(Amount) as revenue,
            SUM(Amount * 0.4) as profit -- Assuming 40% profit margin
          FROM oe.Payments
          WHERE YEAR(PaymentDate) = @year
          GROUP BY MONTH(PaymentDate)
        ) data ON months.MonthNum = data.MonthNum
        ORDER BY months.MonthNum
      `);
    
    res.json(result.recordset);
  } catch (error) {
    console.error('Monthly revenue error:', error);
    res.status(500).json({ error: 'Failed to fetch monthly revenue' });
  }
});

module.exports = router;
