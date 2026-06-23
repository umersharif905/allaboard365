# ===================================================================================================
# BACKEND API ROUTES FOR ADMIN MARKETPLACE ENHANCEMENT
# ===================================================================================================
# These routes need to be added to your Node.js backend to support the new admin features
# Add these to your existing marketplace routes file

Write-Host "📋 Backend API Routes for Admin Marketplace Enhancement:" -ForegroundColor Cyan
Write-Host ""
Write-Host "Add these routes to your backend/routes/marketplace.js file:" -ForegroundColor Yellow
Write-Host ""

$routesCode = @"
// =======================================================================================
// ADMIN MARKETPLACE ENHANCEMENT ROUTES
// =======================================================================================

// Subscription Request Management
router.get('/subscription-requests', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const query = `
      SELECT 
        sr.RequestId,
        sr.ProductId,
        p.Name as ProductName,
        t.Name as TenantName,
        t.ContactEmail as TenantEmail,
        sr.RequestDate,
        sr.Status,
        sr.Notes,
        sr.RequestedBy,
        owner.Name as ProductOwner
      FROM oe.ProductSubscriptionRequests sr
      JOIN oe.Products p ON sr.ProductId = p.ProductId
      JOIN oe.Tenants t ON sr.TenantId = t.TenantId
      JOIN oe.Tenants owner ON p.ProductOwnerId = owner.TenantId
      ORDER BY sr.RequestDate DESC
    `;
    
    const result = await pool.request().query(query);
    res.json({ success: true, requests: result.recordset });
  } catch (error) {
    console.error('Error fetching subscription requests:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Approve/Deny Subscription Request
router.post('/subscription-requests/approve', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const { requestId, approved, notes } = req.body;
    const newStatus = approved ? 'Approved' : 'Denied';
    
    await pool.request()
      .input('requestId', requestId)
      .input('status', newStatus)
      .input('notes', notes || '')
      .input('processedBy', req.user.UserId)
      .query(`
        UPDATE oe.ProductSubscriptionRequests 
        SET Status = @status, 
            ProcessedDate = GETDATE(),
            ProcessedBy = @processedBy,
            ProcessingNotes = @notes
        WHERE RequestId = @requestId
      `);
    
    // If approved, create the actual subscription
    if (approved) {
      await pool.request()
        .input('requestId', requestId)
        .query(`
          INSERT INTO oe.ProductSubscriptions (ProductId, TenantId, SubscriptionDate, Status)
          SELECT ProductId, TenantId, GETDATE(), 'Active'
          FROM oe.ProductSubscriptionRequests
          WHERE RequestId = @requestId
        `);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error processing subscription request:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Bulk Approve/Deny Subscription Requests
router.post('/subscription-requests/bulk-approve', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const { requestIds, approved } = req.body;
    const newStatus = approved ? 'Approved' : 'Denied';
    
    const transaction = pool.transaction();
    await transaction.begin();
    
    try {
      for (const requestId of requestIds) {
        await transaction.request()
          .input('requestId', requestId)
          .input('status', newStatus)
          .input('processedBy', req.user.UserId)
          .query(`
            UPDATE oe.ProductSubscriptionRequests 
            SET Status = @status, 
                ProcessedDate = GETDATE(),
                ProcessedBy = @processedBy
            WHERE RequestId = @requestId
          `);
        
        if (approved) {
          await transaction.request()
            .input('requestId', requestId)
            .query(`
              INSERT INTO oe.ProductSubscriptions (ProductId, TenantId, SubscriptionDate, Status)
              SELECT ProductId, TenantId, GETDATE(), 'Active'
              FROM oe.ProductSubscriptionRequests
              WHERE RequestId = @requestId
            `);
        }
      }
      
      await transaction.commit();
      res.json({ success: true });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error bulk processing subscription requests:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Product Analytics
router.get('/analytics', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const { timeRange = '30d' } = req.query;
    let dateFilter = '';
    
    switch (timeRange) {
      case '30d':
        dateFilter = "AND ps.SubscriptionDate >= DATEADD(day, -30, GETDATE())";
        break;
      case '90d':
        dateFilter = "AND ps.SubscriptionDate >= DATEADD(day, -90, GETDATE())";
        break;
      case '1y':
        dateFilter = "AND ps.SubscriptionDate >= DATEADD(year, -1, GETDATE())";
        break;
    }
    
    // Get basic metrics
    const metricsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM oe.Products WHERE IsMarketplaceProduct = 1) as totalProducts,
        (SELECT COUNT(*) FROM oe.ProductSubscriptions WHERE Status = 'Active') as totalSubscriptions,
        (SELECT COUNT(*) FROM oe.ProductSubscriptionRequests WHERE Status = 'Pending') as pendingRequests,
        (SELECT AVG(CAST(Rating as FLOAT)) FROM oe.ProductReviews WHERE Rating IS NOT NULL) as averageRating
    `;
    
    const metrics = await pool.request().query(metricsQuery);
    
    // Get top products
    const topProductsQuery = `
      SELECT TOP 10
        p.ProductId,
        p.Name,
        p.ProductType,
        COUNT(ps.SubscriptionId) as SubscriberCount,
        ISNULL(SUM(pay.Amount), 0) as Revenue,
        0 as GrowthRate
      FROM oe.Products p
      LEFT JOIN oe.ProductSubscriptions ps ON p.ProductId = ps.ProductId ${dateFilter.replace('ps.SubscriptionDate', 'ps.SubscriptionDate')}
      LEFT JOIN oe.Payments pay ON ps.SubscriptionId = pay.SubscriptionId ${dateFilter.replace('ps.SubscriptionDate', 'pay.PaymentDate')}
      WHERE p.IsMarketplaceProduct = 1
      GROUP BY p.ProductId, p.Name, p.ProductType
      ORDER BY SubscriberCount DESC
    `;
    
    const topProducts = await pool.request().query(topProductsQuery);
    
    // Get product type distribution
    const distributionQuery = `
      SELECT 
        ProductType as type,
        COUNT(*) as count,
        (COUNT(*) * 100.0 / (SELECT COUNT(*) FROM oe.Products WHERE IsMarketplaceProduct = 1)) as percentage
      FROM oe.Products 
      WHERE IsMarketplaceProduct = 1
      GROUP BY ProductType
      ORDER BY count DESC
    `;
    
    const distribution = await pool.request().query(distributionQuery);
    
    // Get subscription trends (last 6 months)
    const trendsQuery = `
      SELECT 
        FORMAT(ps.SubscriptionDate, 'yyyy-MM') as month,
        COUNT(*) as subscriptions,
        ISNULL(SUM(pay.Amount), 0) as revenue
      FROM oe.ProductSubscriptions ps
      LEFT JOIN oe.Payments pay ON ps.SubscriptionId = pay.SubscriptionId
      WHERE ps.SubscriptionDate >= DATEADD(month, -6, GETDATE())
      GROUP BY FORMAT(ps.SubscriptionDate, 'yyyy-MM')
      ORDER BY month DESC
    `;
    
    const trends = await pool.request().query(trendsQuery);
    
    res.json({
      success: true,
      analytics: {
        totalProducts: metrics.recordset[0].totalProducts || 0,
        totalSubscriptions: metrics.recordset[0].totalSubscriptions || 0,
        pendingRequests: metrics.recordset[0].pendingRequests || 0,
        averageRating: metrics.recordset[0].averageRating || 0,
        topProducts: topProducts.recordset || [],
        productTypeDistribution: distribution.recordset || [],
        subscriptionTrends: trends.recordset || []
      }
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Product Status Management
router.put('/products/:productId/status', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const { productId } = req.params;
    const { status } = req.body;
    
    await pool.request()
      .input('productId', productId)
      .input('status', status)
      .input('updatedBy', req.user.UserId)
      .query(`
        UPDATE oe.Products 
        SET Status = @status, 
            UpdatedDate = GETDATE(),
            UpdatedBy = @updatedBy
        WHERE ProductId = @productId
      `);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating product status:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Bulk Product Status Update
router.post('/products/bulk-status', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const { productIds, status } = req.body;
    
    const transaction = pool.transaction();
    await transaction.begin();
    
    try {
      for (const productId of productIds) {
        await transaction.request()
          .input('productId', productId)
          .input('status', status)
          .input('updatedBy', req.user.UserId)
          .query(`
            UPDATE oe.Products 
            SET Status = @status, 
                UpdatedDate = GETDATE(),
                UpdatedBy = @updatedBy
            WHERE ProductId = @productId
          `);
      }
      
      await transaction.commit();
      res.json({ success: true });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error bulk updating product status:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Bulk Product Delete
router.delete('/products/bulk-delete', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const { productIds } = req.body;
    
    const transaction = pool.transaction();
    await transaction.begin();
    
    try {
      for (const productId of productIds) {
        // Soft delete - mark as deleted instead of removing
        await transaction.request()
          .input('productId', productId)
          .input('deletedBy', req.user.UserId)
          .query(`
            UPDATE oe.Products 
            SET Status = 'Deleted', 
                DeletedDate = GETDATE(),
                DeletedBy = @deletedBy
            WHERE ProductId = @productId
          `);
      }
      
      await transaction.commit();
      res.json({ success: true });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error bulk deleting products:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Email Notification for Subscription Request
router.post('/subscription-requests/notify', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const { requestId } = req.body;
    
    // Get request details
    const request = await pool.request()
      .input('requestId', requestId)
      .query(`
        SELECT 
          sr.RequestId,
          sr.Status,
          p.Name as ProductName,
          t.Name as TenantName,
          t.ContactEmail
        FROM oe.ProductSubscriptionRequests sr
        JOIN oe.Products p ON sr.ProductId = p.ProductId
        JOIN oe.Tenants t ON sr.TenantId = t.TenantId
        WHERE sr.RequestId = @requestId
      `);
    
    if (request.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    
    // TODO: Integrate with your email service
    // For now, just log that we would send an email
    console.log('Would send email notification for:', request.recordset[0]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Analytics Export
router.get('/analytics/export', authenticate, authorize(['Admin']), async (req, res) => {
  try {
    const { format, timeRange } = req.query;
    
    // Get analytics data (reuse logic from analytics endpoint)
    // TODO: Implement CSV/PDF export logic
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=marketplace-analytics.csv');
      res.json({ success: true, data: 'CSV data would go here' });
    } else if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=marketplace-analytics.pdf');
      res.json({ success: true, data: 'PDF data would go here' });
    } else {
      res.status(400).json({ success: false, message: 'Invalid format' });
    }
  } catch (error) {
    console.error('Error exporting analytics:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
"@

Write-Host $routesCode
Write-Host ""
Write-Host "✅ Copy the above routes to your backend/routes/marketplace.js file" -ForegroundColor Green
Write-Host ""
