const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');

/**
 * Active tenant from requireTenantAccess on tenant-admin/index (supports tenant switching).
 * Do not use req.user.TenantId alone — per-route authenticate resets it to the user's primary tenant.
 */
const activeTenantId = (req) => req.tenantId || req.user?.TenantId;

/**
 * GET /api/me/tenant-admin/products/:productId/overrides
 * Get all overrides for a specific product
 */
router.get('/:productId/overrides', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { productId } = req.params;
    const tenantId = activeTenantId(req);
    const pool = await getPool();

    console.log('🔍 Fetching overrides for product:', productId);
    console.log('🔍 Active tenantId:', tenantId);
    console.log('🔍 User details:', {
      UserId: req.user.UserId,
      email: req.user.email,
      currentRole: req.user.currentRole
    });

    // Verify product ownership
    const productRequest = pool.request();
    productRequest.input('productId', sql.UniqueIdentifier, productId);
    productRequest.input('tenantId', sql.UniqueIdentifier, tenantId);

    const productCheck = await productRequest.query(`
      SELECT ProductId, Name, ProductOwnerId, Status 
      FROM oe.Products 
      WHERE ProductId = @productId
    `);

    console.log('🔍 Product check result:', productCheck.recordset);

    if (productCheck.recordset.length === 0) {
      console.log('❌ Product not found at all');
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const product = productCheck.recordset[0];
    console.log('🔍 Product found:', {
      ProductId: product.ProductId,
      Name: product.Name,
      ProductOwnerId: product.ProductOwnerId,
      Status: product.Status,
      UserTenantId: tenantId,
      OwnershipMatch: product.ProductOwnerId === tenantId
    });

    // Check ownership and status (SysAdmin can access any product)
    if (req.user.currentRole !== 'SysAdmin' && product.ProductOwnerId !== tenantId) {
      console.log('❌ Ownership mismatch - Product belongs to different tenant');
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not own this product'
      });
    }

    if (product.Status !== 'Active') {
      console.log('❌ Product is not active');
      return res.status(404).json({
        success: false,
        message: 'Product is not active'
      });
    }

    console.log('✅ Product ownership verified');

    // Get overrides for this product
    const overridesRequest = pool.request();
    overridesRequest.input('productId', sql.UniqueIdentifier, productId);

    try {
      const result = await overridesRequest.query(`
        SELECT 
          po.OverrideId,
          po.ProductId,
          po.TenantId,
          po.OverrideACHId,
          po.OverrideName,
          po.OverrideAmount,
          po.OverrideType,
          po.Priority,
          po.IsActive,
          po.EffectiveDate,
          po.ExpirationDate,
          po.Notes,
          po.CreatedDate,
          po.ModifiedDate,
          po.ProductPricingId,
          t.Name as TenantName,
          ach.AccountName as ACHAccountName,
          ach.AccountHolderName as ACHAccountHolderName,
          ach.BankName as ACHBankName,
          ach.BankAccountType as ACHAccountType,
          pp.PricingName as PricingName,
          pp.Label as PricingLabel,
          pp.TierType as PricingTierType,
          pp.TobaccoStatus as PricingTobaccoStatus,
          pp.MinAge as PricingMinAge,
          pp.MaxAge as PricingMaxAge
        FROM oe.ProductOverrides po
        LEFT JOIN oe.Tenants t ON po.TenantId = t.TenantId
        LEFT JOIN oe.ProductOverrideACH ach ON po.OverrideACHId = ach.OverrideACHId
        LEFT JOIN oe.ProductPricing pp ON po.ProductPricingId = pp.ProductPricingId
        WHERE po.ProductId = @productId
        ORDER BY po.CreatedDate DESC
      `);

      console.log('✅ Found', result.recordset.length, 'overrides');

      res.json({
        success: true,
        data: result.recordset
      });
    } catch (queryError) {
      // Check if tables don't exist
      if (queryError.message && queryError.message.includes('Invalid object name')) {
        console.error('❌ ProductOverrides tables do not exist. Please run the SQL script: backend/scripts/create-product-overrides-tables.sql');
        return res.status(500).json({
          success: false,
          message: 'Product overrides tables not found. Please contact your system administrator to run the database migration script.',
          error: {
            code: 'TABLES_NOT_FOUND',
            hint: 'Run backend/scripts/create-product-overrides-tables.sql'
          }
        });
      }
      throw queryError;
    }

  } catch (error) {
    console.error('❌ Error fetching product overrides:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product overrides'
    });
  }
});

/**
 * POST /api/me/tenant-admin/products/:productId/overrides
 * Create a new override for a product
 */
router.post('/:productId/overrides', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { productId } = req.params;
    const ownerTenantId = activeTenantId(req);
    const {
      tenantId,
      overrideACHId,
      overrideName,
      overrideAmount,
      priority,
      effectiveDate,
      productPricingId
    } = req.body;
    
    // Always set to 'Flat' and active
    const overrideType = 'Flat';
    const isActive = true;

    const pool = await getPool();

    console.log('🆕 Creating new override for product:', productId);

    // Verify product ownership (SysAdmin can access any product)
    const productRequest = pool.request();
    productRequest.input('productId', sql.UniqueIdentifier, productId);
    
    let productCheck;
    if (req.user.currentRole === 'SysAdmin') {
      // SysAdmin can access any active product
      productCheck = await productRequest.query(`
        SELECT ProductId FROM oe.Products 
        WHERE ProductId = @productId 
        AND Status = 'Active'
      `);
    } else {
      // TenantAdmin can only access their own products
      productRequest.input('ownerTenantId', sql.UniqueIdentifier, ownerTenantId);
      productCheck = await productRequest.query(`
        SELECT ProductId FROM oe.Products 
        WHERE ProductId = @productId 
        AND ProductOwnerId = @ownerTenantId 
        AND Status = 'Active'
      `);
    }

    if (productCheck.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or access denied'
      });
    }

    // Validate required fields
    if (!overrideAmount || !tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Override amount and tenant ID are required'
      });
    }

    // SECURITY: TenantAdmin can only create overrides for their own tenant
    if (req.user.currentRole === 'TenantAdmin' && tenantId !== ownerTenantId) {
      console.log('🚨 SECURITY: TenantAdmin attempted to create override for different tenant');
      console.log('   Active tenantId:', ownerTenantId);
      console.log('   Requested TenantId:', tenantId);
      return res.status(403).json({
        success: false,
        message: 'Access denied: Cannot create overrides for other tenants'
      });
    }

    if (productPricingId && overrideACHId) {
      const dupRequest = pool.request();
      dupRequest.input('productId', sql.UniqueIdentifier, productId);
      dupRequest.input('productPricingId', sql.UniqueIdentifier, productPricingId);
      dupRequest.input('overrideACHId', sql.UniqueIdentifier, overrideACHId);
      const dupResult = await dupRequest.query(`
        SELECT TOP 1 OverrideId
        FROM oe.ProductOverrides
        WHERE ProductId = @productId
          AND ProductPricingId = @productPricingId
          AND OverrideACHId = @overrideACHId
      `);
      if (dupResult.recordset.length > 0) {
        return res.status(409).json({
          success: false,
          message:
            'This bank account already has an override on this pricing tier. Update the existing override instead.'
        });
      }
    }

    // Create override
    const overrideId = require('crypto').randomUUID();
    const insertRequest = pool.request();

    insertRequest.input('overrideId', sql.UniqueIdentifier, overrideId);
    insertRequest.input('productId', sql.UniqueIdentifier, productId);
    insertRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    insertRequest.input('overrideACHId', sql.UniqueIdentifier, overrideACHId || null);
    insertRequest.input('overrideName', sql.NVarChar, overrideName || null);
    insertRequest.input('overrideAmount', sql.Decimal(10, 2), parseFloat(overrideAmount));
    insertRequest.input('overrideType', sql.NVarChar, overrideType);
    insertRequest.input('priority', sql.Int, priority || null);
    insertRequest.input('isActive', sql.Bit, isActive);
    insertRequest.input('effectiveDate', sql.DateTime2, effectiveDate || null);
    insertRequest.input('expirationDate', sql.DateTime2, null);
    insertRequest.input('notes', sql.NVarChar, null);
    insertRequest.input('createdBy', sql.UniqueIdentifier, req.user.userId);
    insertRequest.input('productPricingId', sql.UniqueIdentifier, productPricingId || null);

    await insertRequest.query(`
      INSERT INTO oe.ProductOverrides (
        OverrideId, ProductId, TenantId, OverrideACHId, OverrideName,
        OverrideAmount, OverrideType, Priority, IsActive,
        EffectiveDate, ExpirationDate, Notes, ProductPricingId,
        CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @overrideId, @productId, @tenantId, @overrideACHId, @overrideName,
        @overrideAmount, @overrideType, @priority, @isActive,
        @effectiveDate, @expirationDate, @notes, @productPricingId,
        GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy
      )
    `);

    console.log('✅ Override created successfully:', overrideId);

    // Return the created override
    const selectRequest = pool.request();
    selectRequest.input('overrideId', sql.UniqueIdentifier, overrideId);

    const result = await selectRequest.query(`
      SELECT 
        po.OverrideId,
        po.ProductId,
        po.TenantId,
        po.OverrideACHId,
        po.OverrideName,
        po.OverrideAmount,
        po.OverrideType,
        po.Priority,
        po.IsActive,
        po.EffectiveDate,
        po.ExpirationDate,
        po.Notes,
        po.CreatedDate,
        po.ModifiedDate,
        po.ProductPricingId,
        t.Name as TenantName,
        pp.PricingName as PricingName,
        pp.Label as PricingLabel,
        pp.TierType as PricingTierType,
        pp.TobaccoStatus as PricingTobaccoStatus,
        pp.MinAge as PricingMinAge,
        pp.MaxAge as PricingMaxAge
      FROM oe.ProductOverrides po
      LEFT JOIN oe.Tenants t ON po.TenantId = t.TenantId
      LEFT JOIN oe.ProductPricing pp ON po.ProductPricingId = pp.ProductPricingId
      WHERE po.OverrideId = @overrideId
    `);

    res.json({
      success: true,
      data: result.recordset[0],
      message: 'Override created successfully'
    });

  } catch (error) {
    console.error('❌ Error creating product override:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create product override'
    });
  }
});

/**
 * PUT /api/me/tenant-admin/products/:productId/overrides/:overrideId
 * Update an existing override
 */
router.put('/:productId/overrides/:overrideId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { productId, overrideId } = req.params;
    const ownerTenantId = activeTenantId(req);
    const {
      tenantId,
      overrideACHId,
      overrideName,
      overrideAmount,
      priority,
      effectiveDate,
      expirationDate, // Only used when scheduling expiration via delete modal
      productPricingId
    } = req.body;
    
    // Always set to 'Flat' and active (unless expiring)
    const overrideType = 'Flat';
    const isActive = expirationDate ? true : true; // Keep active, expiration date controls lifecycle

    const pool = await getPool();

    console.log('📝 Updating override:', overrideId, 'for product:', productId);

    // Verify product ownership and override exists (SysAdmin can access any product)
    const checkRequest = pool.request();
    checkRequest.input('productId', sql.UniqueIdentifier, productId);
    checkRequest.input('overrideId', sql.UniqueIdentifier, overrideId);
    
    let checkResult;
    if (req.user.currentRole === 'SysAdmin') {
      // SysAdmin can access any active product
      checkResult = await checkRequest.query(`
        SELECT po.OverrideId
        FROM oe.ProductOverrides po
        INNER JOIN oe.Products p ON po.ProductId = p.ProductId
        WHERE po.OverrideId = @overrideId
        AND po.ProductId = @productId
        AND p.Status = 'Active'
      `);
    } else {
      // TenantAdmin can only access their own products
      checkRequest.input('ownerTenantId', sql.UniqueIdentifier, ownerTenantId);
      checkResult = await checkRequest.query(`
        SELECT po.OverrideId
        FROM oe.ProductOverrides po
        INNER JOIN oe.Products p ON po.ProductId = p.ProductId
        WHERE po.OverrideId = @overrideId
        AND po.ProductId = @productId
        AND p.ProductOwnerId = @ownerTenantId
        AND p.Status = 'Active'
      `);
    }

    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Override not found or access denied'
      });
    }

    // SECURITY: TenantAdmin can only update overrides for their own tenant
    if (req.user.currentRole === 'TenantAdmin' && tenantId !== ownerTenantId) {
      console.log('🚨 SECURITY: TenantAdmin attempted to update override for different tenant');
      console.log('   Active tenantId:', ownerTenantId);
      console.log('   Requested TenantId:', tenantId);
      return res.status(403).json({
        success: false,
        message: 'Access denied: Cannot modify overrides for other tenants'
      });
    }

    if (productPricingId && overrideACHId) {
      const dupUpdateRequest = pool.request();
      dupUpdateRequest.input('productId', sql.UniqueIdentifier, productId);
      dupUpdateRequest.input('productPricingId', sql.UniqueIdentifier, productPricingId);
      dupUpdateRequest.input('overrideACHId', sql.UniqueIdentifier, overrideACHId);
      dupUpdateRequest.input('overrideId', sql.UniqueIdentifier, overrideId);
      const dupUpdateResult = await dupUpdateRequest.query(`
        SELECT TOP 1 OverrideId
        FROM oe.ProductOverrides
        WHERE ProductId = @productId
          AND ProductPricingId = @productPricingId
          AND OverrideACHId = @overrideACHId
          AND OverrideId <> @overrideId
      `);
      if (dupUpdateResult.recordset.length > 0) {
        return res.status(409).json({
          success: false,
          message:
            'This bank account already has an override on this pricing tier. Update the existing override instead.'
        });
      }
    }

    // Update override
    const updateRequest = pool.request();
    updateRequest.input('overrideId', sql.UniqueIdentifier, overrideId);
    updateRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    updateRequest.input('overrideACHId', sql.UniqueIdentifier, overrideACHId || null);
    updateRequest.input('overrideName', sql.NVarChar, overrideName || null);
    updateRequest.input('overrideAmount', sql.Decimal(10, 2), parseFloat(overrideAmount));
    updateRequest.input('overrideType', sql.NVarChar, overrideType);
    updateRequest.input('priority', sql.Int, priority || null);
    updateRequest.input('isActive', sql.Bit, isActive);
    updateRequest.input('effectiveDate', sql.DateTime2, effectiveDate || null);
    updateRequest.input('expirationDate', sql.DateTime2, expirationDate || null);
    updateRequest.input('notes', sql.NVarChar, null);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.userId);
    updateRequest.input('productPricingId', sql.UniqueIdentifier, productPricingId || null);

    await updateRequest.query(`
      UPDATE oe.ProductOverrides
      SET 
        TenantId = @tenantId,
        OverrideACHId = @overrideACHId,
        OverrideName = @overrideName,
        OverrideAmount = @overrideAmount,
        OverrideType = @overrideType,
        Priority = @priority,
        IsActive = @isActive,
        EffectiveDate = @effectiveDate,
        ExpirationDate = @expirationDate,
        Notes = @notes,
        ProductPricingId = @productPricingId,
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
      WHERE OverrideId = @overrideId
    `);

    console.log('✅ Override updated successfully');

    // Return updated override
    const selectRequest = pool.request();
    selectRequest.input('overrideId', sql.UniqueIdentifier, overrideId);

    const result = await selectRequest.query(`
      SELECT 
        po.OverrideId,
        po.ProductId,
        po.TenantId,
        po.OverrideACHId,
        po.OverrideName,
        po.OverrideAmount,
        po.OverrideType,
        po.Priority,
        po.IsActive,
        po.EffectiveDate,
        po.ExpirationDate,
        po.Notes,
        po.CreatedDate,
        po.ModifiedDate,
        po.ProductPricingId,
        t.Name as TenantName,
        pp.PricingName as PricingName,
        pp.Label as PricingLabel,
        pp.TierType as PricingTierType,
        pp.TobaccoStatus as PricingTobaccoStatus,
        pp.MinAge as PricingMinAge,
        pp.MaxAge as PricingMaxAge
      FROM oe.ProductOverrides po
      LEFT JOIN oe.Tenants t ON po.TenantId = t.TenantId
      LEFT JOIN oe.ProductPricing pp ON po.ProductPricingId = pp.ProductPricingId
      WHERE po.OverrideId = @overrideId
    `);

    res.json({
      success: true,
      data: result.recordset[0],
      message: 'Override updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating product override:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product override'
    });
  }
});

/**
 * DELETE /api/me/tenant-admin/products/:productId/overrides/:overrideId
 * Delete an override
 */
router.delete('/:productId/overrides/:overrideId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { productId, overrideId } = req.params;
    const ownerTenantId = activeTenantId(req);
    const pool = await getPool();

    console.log('🗑️ Deleting override:', overrideId, 'for product:', productId);

    // Verify product ownership and override exists (SysAdmin can access any product)
    const checkRequest = pool.request();
    checkRequest.input('productId', sql.UniqueIdentifier, productId);
    checkRequest.input('overrideId', sql.UniqueIdentifier, overrideId);
    
    let checkResult;
    if (req.user.currentRole === 'SysAdmin') {
      // SysAdmin can access any active product
      checkResult = await checkRequest.query(`
        SELECT po.OverrideId
        FROM oe.ProductOverrides po
        INNER JOIN oe.Products p ON po.ProductId = p.ProductId
        WHERE po.OverrideId = @overrideId
        AND po.ProductId = @productId
        AND p.Status = 'Active'
      `);
    } else {
      // TenantAdmin can only access their own products
      checkRequest.input('ownerTenantId', sql.UniqueIdentifier, ownerTenantId);
      checkResult = await checkRequest.query(`
        SELECT po.OverrideId
        FROM oe.ProductOverrides po
        INNER JOIN oe.Products p ON po.ProductId = p.ProductId
        WHERE po.OverrideId = @overrideId
        AND po.ProductId = @productId
        AND p.ProductOwnerId = @ownerTenantId
        AND p.Status = 'Active'
      `);
    }

    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Override not found or access denied'
      });
    }

    // Delete override
    const deleteRequest = pool.request();
    deleteRequest.input('overrideId', sql.UniqueIdentifier, overrideId);

    await deleteRequest.query(`
      DELETE FROM oe.ProductOverrides
      WHERE OverrideId = @overrideId
    `);

    console.log('✅ Override deleted successfully');

    res.json({
      success: true,
      message: 'Override deleted successfully'
    });

  } catch (error) {
    console.error('❌ Error deleting product override:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product override'
    });
  }
});

/**
 * GET /api/me/tenant-admin/products/:productId/override-ach-accounts
 * Get available ACH accounts for overrides (tenant's accounts)
 */
router.get('/:productId/override-ach-accounts', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = activeTenantId(req);

    console.log('🏦 Fetching override ACH accounts for tenant:', tenantId);

    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, tenantId);

    const result = await request.query(`
      SELECT 
        OverrideACHId,
        Label,
        BankName,
        BankAccountType,
        AccountHolderName,
        IsActive,
        IsDefault,
        VerificationStatus,
        CreatedDate
      FROM oe.ProductOverrideACH
      WHERE TenantId = @tenantId
      AND IsActive = 1
      ORDER BY IsDefault DESC, Label ASC
    `);

    res.json({
      success: true,
      data: result.recordset
    });

  } catch (error) {
    console.error('❌ Error fetching override ACH accounts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch override ACH accounts'
    });
  }
});

module.exports = router;

