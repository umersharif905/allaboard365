// backend/routes/marketplace.js
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const { getPool, sql } = require('../config/database');
const { authenticateProductUrls } = require('./uploads');

/**
 * Full tenant switching (x-current-tenant-id) when a real user id exists.
 * API key auth has no UserId — use TenantId on the key only (no switch).
 */
async function resolveTenantForMarketplace(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (!req.user.UserId) {
      if (req.user.TenantId) {
        req.tenantId = req.user.TenantId;
      }
      return next();
    }
    await requireTenantAccess(req, res, next);
  } catch (err) {
    next(err);
  }
}

// ===================================================================================================
// GET /api/marketplace/tenants - Get tenants for Product Owner dropdown
// ===================================================================================================
router.get('/tenants', async (req, res) => { 
  try {
    console.log('📋 GET /api/marketplace/tenants - Fetching tenants for dropdown');
    
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT 
        TenantId,
        Name,
        ContactEmail,
        Status,
        CustomLogoUrl AS LogoUrl
      FROM oe.Tenants 
      WHERE Status IN ('Active', 'Pending')
      ORDER BY Name
    `);

    console.log(`✅ Found ${result.recordset.length} tenants`);
    
    res.json({
      success: true,
      tenants: result.recordset
    });

  } catch (error) {
    console.error('❌ Error fetching tenants:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tenants',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// ===================================================================================================
// GET /api/marketplace/products - UPDATED TO INCLUDE ALL FIELDS AND PRICING TIERS
// ===================================================================================================
router.get('/products', authenticate, resolveTenantForMarketplace, async (req, res) => {
  try {
    console.log('📦 GET /api/marketplace/products - Fetching marketplace products');
    
    const { 
      search, 
      productType, 
      salesType, 
      minPrice, 
      maxPrice, 
      productOwner 
    } = req.query;

    const pool = await getPool();
    const request = pool.request();
    
    // Check if user is an Agent - only agents should have hidden products filtered
    const isAgent = req.user?.currentRole === 'Agent';
    
    // UPDATED: Now includes all fields needed for editing
    let query = `
      SELECT 
        p.ProductId,
        p.Name,
        p.Description,
        p.ProductType,
        p.Status,
        p.IsMarketplaceProduct,
        p.IsPublic,
        p.IsHidden,
        p.IsBundle,
        p.ProductImageUrl,
        p.ProductLogoUrl,
        p.ProductDocumentUrl,
        p.MinAge,
        p.MaxAge,
        p.AllowedStates,
        p.SalesType,
        p.RequiresTobaccoInfo,
        p.EffectiveDateLogic,
        p.MaxEffectiveDateDays,
        p.TerminationLogic,
        p.RequiredLicenses,
        p.ProductOwnerId,
        owner.Name AS ProductOwnerName,
        owner.CustomLogoUrl AS ProductOwnerLogo,
        p.VendorId,
        v.VendorName,
        p.IsVendorPrice,
        p.VendorCommission,
        p.RequiredDataFields,
        p.AcknowledgementQuestions,
        p.IDCardData,
        p.PlanDetailsData,
        p.RequiredASA,
        p.CreatedDate,
        p.ModifiedDate,
        ISNULL((SELECT MIN(MSRPRate) 
                FROM oe.ProductPricing pp 
                WHERE pp.ProductId = p.ProductId AND pp.Status = 'Active'), 0) AS BasePrice,
        (SELECT COUNT(*) 
         FROM oe.ProductSubscriptions ps 
         WHERE ps.ProductId = p.ProductId AND ps.Status = 'Approved') AS ActiveSubscribers,
        CASE 
          WHEN EXISTS (SELECT 1 FROM oe.ProductSubscriptions ps2 
                      WHERE ps2.ProductId = p.ProductId 
                      AND ps2.TenantId = @tenantId 
                      AND ps2.Status IN ('Approved', 'Pending'))
          THEN 1 
          ELSE 0 
        END AS IsSubscribed,
        (SELECT TOP 1 ps3.Status 
         FROM oe.ProductSubscriptions ps3 
         WHERE ps3.ProductId = p.ProductId 
         AND ps3.TenantId = @tenantId 
         ORDER BY ps3.RequestDate DESC) AS SubscriptionStatus,
        -- Bundle products for bundles
        CASE 
          WHEN p.IsBundle = 1 THEN (
            SELECT STRING_AGG(ip.Name, ', ') 
            FROM oe.ProductBundles pb
            INNER JOIN oe.Products ip ON pb.IncludedProductId = ip.ProductId
            WHERE pb.BundleProductId = p.ProductId
          )
          ELSE NULL
        END AS BundleProducts
      FROM oe.Products p
      LEFT JOIN oe.Tenants owner ON p.ProductOwnerId = owner.TenantId
      LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
      WHERE p.Status = 'Active' 
        AND p.IsMarketplaceProduct = 1
    `;
    
    // Only filter hidden products for Agents - SysAdmin and TenantAdmin should see all products
    if (isAgent) {
      query += ` AND (p.IsHidden IS NULL OR p.IsHidden = 0)`;
    }

    // req.tenantId set by requireTenantAccess (respects x-current-tenant-id / tenant switching)
    const tenantId = req.tenantId || req.user?.TenantId || req.user?.tenantId || '00000000-0000-0000-0000-000000000000';
    request.input('tenantId', sql.UniqueIdentifier, tenantId);

    // Apply search filter
    if (search) {
      query += ` AND (p.Name LIKE @search OR p.Description LIKE @search)`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }

    // Apply product type filter
    if (productType) {
      if (productType === 'Bundles') {
        // Special handling for bundles filter
        query += ` AND p.IsBundle = 1`;
      } else {
        query += ` AND p.ProductType = @productType`;
        request.input('productType', sql.NVarChar, productType);
      }
    }

    // Apply sales type filter
    if (salesType) {
      query += ` AND p.SalesType = @salesType`;
      request.input('salesType', sql.NVarChar, salesType);
    }

    // Apply product owner filter
    if (productOwner) {
      const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (guidRegex.test(productOwner)) {
        query += ` AND p.ProductOwnerId = @productOwner`;
        request.input('productOwner', sql.UniqueIdentifier, productOwner);
      } else {
        query += ` AND EXISTS (
          SELECT 1 
          FROM oe.Tenants pot
          WHERE pot.TenantId = p.ProductOwnerId
            AND pot.Name = @productOwnerName
        )`;
        request.input('productOwnerName', sql.NVarChar, productOwner);
      }
    }

    query += ` ORDER BY p.Name`;

    const result = await request.query(query);
    let products = result.recordset;

    // Process each product to parse JSON fields and fetch pricing tiers
    for (let product of products) {
      // Parse JSON fields
      if (product.AllowedStates && typeof product.AllowedStates === 'string') {
        try {
          product.AllowedStates = JSON.parse(product.AllowedStates);
        } catch (e) {
          product.AllowedStates = [];
        }
      }
      
      if (product.RequiredLicenses && typeof product.RequiredLicenses === 'string') {
        try {
          product.RequiredLicenses = JSON.parse(product.RequiredLicenses);
        } catch (e) {
          product.RequiredLicenses = [];
        }
      }
      
      // Parse RequiredDataFields and map to ConfigurationFields
      if (product.RequiredDataFields && typeof product.RequiredDataFields === 'string') {
        try {
          product.ConfigurationFields = JSON.parse(product.RequiredDataFields);
        } catch (e) {
          product.ConfigurationFields = [];
        }
      } else {
        product.ConfigurationFields = [];
      }
      
      if (product.AcknowledgementQuestions && typeof product.AcknowledgementQuestions === 'string') {
        try {
          product.AcknowledgementQuestions = JSON.parse(product.AcknowledgementQuestions);
        } catch (e) {
          product.AcknowledgementQuestions = [];
        }
      }

      if (product.IDCardData && typeof product.IDCardData === 'string') {
        try {
          product.IDCardData = JSON.parse(product.IDCardData);
        } catch (e) {
          product.IDCardData = null;
        }
      }

      if (product.PlanDetailsData && typeof product.PlanDetailsData === 'string') {
        try {
          product.PlanDetailsData = JSON.parse(product.PlanDetailsData);
        } catch (e) {
          product.PlanDetailsData = {};
        }
      }

      // Fetch pricing tiers for this product
      const pricingRequest = pool.request();
      pricingRequest.input('ProductId', sql.UniqueIdentifier, product.ProductId);
      
      const pricingResult = await pricingRequest.query(`
        SELECT 
          ProductPricingId,
          PricingName,
          Label,
          NetRate,
          OverrideRate,
          VendorCommission,
          MSRPRate,
          MinAge,
          MaxAge,
          TierType,
          TobaccoStatus,
          ConfigValue1,
          ConfigValue2,
          ConfigValue3,
          ConfigValue4,
          ConfigValue5
        FROM oe.ProductPricing
        WHERE ProductId = @ProductId
        AND Status = 'Active'
        ORDER BY TierType, Label, TobaccoStatus, MinAge
      `);
      
      // Group pricing by tier type and label
      const pricingTiers = [];
      const tierMap = new Map();
      
      pricingResult.recordset.forEach(pricing => {
        const key = `${pricing.TierType}_${pricing.Label || 'default'}`;
        
        if (!tierMap.has(key)) {
          tierMap.set(key, {
            id: require('crypto').randomUUID(),
            tierType: pricing.TierType,
            label: pricing.Label || '',
            ageBands: []
          });
          pricingTiers.push(tierMap.get(key));
        }
        
        tierMap.get(key).ageBands.push({
          id: pricing.ProductPricingId,
          tobaccoStatus: pricing.TobaccoStatus,
          minAge: pricing.MinAge,
          maxAge: pricing.MaxAge,
          netRate: pricing.NetRate,
          overrideRate: pricing.OverrideRate,
          commission: pricing.VendorCommission,
          msrpRate: pricing.MSRPRate,
          affiliateRate: pricing.NetRate + pricing.OverrideRate,
          configValue1: pricing.ConfigValue1,
          configValue2: pricing.ConfigValue2,
          configValue3: pricing.ConfigValue3,
          configValue4: pricing.ConfigValue4,
          configValue5: pricing.ConfigValue5
        });
      });
      
      product.PricingTiers = pricingTiers;
    }

    // Apply price filter (post-query since BasePrice is calculated)
    if (minPrice || maxPrice) {
      products = products.filter(product => {
        const price = product.BasePrice || 0;
        if (minPrice && price < parseFloat(minPrice)) return false;
        if (maxPrice && price > parseFloat(maxPrice)) return false;
        return true;
      });
    }

    console.log(`✅ Found ${products.length} marketplace products with full details`);
    
    // Authenticate blob URLs for all products
    const authenticatedProducts = await Promise.all(
      products.map(product => authenticateProductUrls(product))
    );
    
    res.json({
      success: true,
      products: authenticatedProducts
    });

  } catch (error) {
    console.error('❌ Error fetching marketplace products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch marketplace products',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// ===================================================================================================
// GET /api/marketplace/product-owners - Get product owners for filtering
// ===================================================================================================
router.get('/product-owners', authenticate, async (req, res) => {
  try {
    console.log('🏢 GET /api/marketplace/product-owners - Fetching product owners');
    
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT DISTINCT 
        t.TenantId as ProductOwnerId,
        t.Name,
        COUNT(p.ProductId) as ProductCount
      FROM oe.Tenants t
      LEFT JOIN oe.Products p ON t.TenantId = p.ProductOwnerId 
        AND p.IsMarketplaceProduct = 1 
        AND p.Status = 'Active'
      WHERE t.Status = 'Active'
        AND EXISTS (SELECT 1 FROM oe.Products p2 
                   WHERE p2.ProductOwnerId = t.TenantId 
                   AND p2.IsMarketplaceProduct = 1 
                   AND p2.Status = 'Active')
      GROUP BY t.TenantId, t.Name
      ORDER BY t.Name
    `);

    console.log(`✅ Found ${result.recordset.length} product owners`);
    
    res.json({
      success: true,
      productOwners: result.recordset
    });

  } catch (error) {
    console.error('❌ Error fetching product owners:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product owners',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// ===================================================================================================
// GET /api/marketplace/product-types - Get product types for filtering
// ===================================================================================================
router.get('/product-types', authenticate, async (req, res) => {
  try {
    console.log('📋 GET /api/marketplace/product-types - Fetching product types');
    
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT DISTINCT 
        ProductType,
        COUNT(*) as ProductCount
      FROM oe.Products 
      WHERE IsMarketplaceProduct = 1 
        AND Status = 'Active'
      GROUP BY ProductType
      ORDER BY ProductType
    `);

    console.log(`✅ Found ${result.recordset.length} product types`);
    
    res.json({
      success: true,
      productTypes: result.recordset
    });

  } catch (error) {
    console.error('❌ Error fetching product types:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product types',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// ===================================================================================================
// POST /api/marketplace/subscribe - Subscribe to a product
// ===================================================================================================
router.post('/subscribe', authenticate, resolveTenantForMarketplace, async (req, res) => {
  try {
    console.log('🔔 POST /api/marketplace/subscribe - Processing subscription request');
    
    const { productId, notes } = req.body;
    const tenantId = req.tenantId || req.user?.TenantId || req.user?.tenantId;
    
    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'Product ID is required'
      });
    }
    
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Tenant context required'
      });
    }

    const pool = await getPool();
    const request = pool.request();
    
    // Check if already subscribed or pending
    request.input('ProductId', sql.UniqueIdentifier, productId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    
    const existingResult = await request.query(`
      SELECT TOP 1 Status 
      FROM oe.ProductSubscriptions 
      WHERE ProductId = @ProductId AND TenantId = @TenantId
      ORDER BY RequestDate DESC
    `);
    
    if (existingResult.recordset.length > 0) {
      const existingStatus = existingResult.recordset[0].Status;
      if (existingStatus === 'Approved') {
        return res.status(400).json({
          success: false,
          message: 'Already subscribed to this product'
        });
      }
      if (existingStatus === 'Pending') {
        return res.status(400).json({
          success: false,
          message: 'Subscription request already pending'
        });
      }
    }
    
    // Create new subscription request
    const subscriptionId = require('crypto').randomUUID();
    const insertRequest = pool.request();
    
    insertRequest.input('SubscriptionId', sql.UniqueIdentifier, subscriptionId);
    insertRequest.input('ProductId', sql.UniqueIdentifier, productId);
    insertRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    insertRequest.input('Status', sql.NVarChar, 'Pending');
    insertRequest.input('RequestDate', sql.DateTime2, new Date());
    insertRequest.input('RequestedBy', sql.UniqueIdentifier, req.user.UserId);
    insertRequest.input('Notes', sql.NVarChar, notes || null);
    
    await insertRequest.query(`
      INSERT INTO oe.ProductSubscriptions (
        SubscriptionId, ProductId, TenantId, Status, RequestDate, RequestedBy, Notes
      ) VALUES (
        @SubscriptionId, @ProductId, @TenantId, @Status, @RequestDate, @RequestedBy, @Notes
      )
    `);
    
    console.log(`✅ Subscription request created: ${subscriptionId}`);
    
    res.status(201).json({
      success: true,
      subscriptionId: subscriptionId,
      message: 'Subscription request submitted successfully'
    });

  } catch (error) {
    console.error('❌ Error creating subscription:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create subscription request',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// ===================================================================================================
// GET /api/marketplace/stats - Basic stats endpoint
// ===================================================================================================
router.get('/stats', authenticate, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT 
        (SELECT COUNT(*) FROM oe.Products WHERE Status = 'Active' AND IsMarketplaceProduct = 1) as totalProducts,
        (SELECT COUNT(*) FROM oe.Tenants WHERE Status = 'Active') as totalTenants,
        (SELECT COUNT(*) FROM oe.ProductSubscriptions WHERE Status = 'Approved') as totalSubscriptions
    `);

    res.json({
      success: true,
      stats: result.recordset[0]
    });

  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch stats',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;