// File: backend/routes/tenant-products.js

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const { authenticateProductUrls } = require('./uploads');
const { isValidGuid, resolveTenantProductSubscriptionId } = require('../utils/tenantProductSubscriptionEnsure');

/**
 * Fetch the product owner's current oe.TenantProductSubscriptions row for a product.
 * This row is treated as the "default tenant subscriber configuration" template and
 * its configurable fields are copied to new subscribers when they adopt the product
 * from the marketplace. Returns a neutral-default object when no owner row exists.
 */
async function fetchOwnerSubscriberDefaults(executor, productId, productOwnerId) {
    const neutralDefaults = {
        ProfitMargin: 0,
        ShowGroupIdOnIDCard: 0,
        SetupFee: null,
        IncludeProcessingFee: 0,
        RoundUpProcessingFee: 0,
        ZeroFeeForACH: 0,
        CustomSystemFeeEnabled: 0,
        CustomSystemFeeAmount: null,
        MustBeSoldWithProductIds: null
    };

    if (!productOwnerId) return neutralDefaults;

    try {
        const req = executor.request();
        req.input('ProductId', sql.UniqueIdentifier, productId);
        req.input('OwnerTenantId', sql.UniqueIdentifier, productOwnerId);
        const result = await req.query(`
            SELECT TOP 1
                ProfitMargin,
                ShowGroupIdOnIDCard,
                SetupFee,
                IncludeProcessingFee,
                RoundUpProcessingFee,
                ZeroFeeForACH,
                CustomSystemFeeEnabled,
                CustomSystemFeeAmount,
                MustBeSoldWithProductIds
            FROM oe.TenantProductSubscriptions
            WHERE ProductId = @ProductId
              AND TenantId = @OwnerTenantId
              AND SubscriptionStatus != 'Cancelled'
            ORDER BY
                CASE WHEN IsConfigured = 1 THEN 0 ELSE 1 END,
                ModifiedDate DESC
        `);

        const row = result.recordset[0];
        if (!row) return neutralDefaults;

        return {
            ProfitMargin: row.ProfitMargin != null ? Number(row.ProfitMargin) : 0,
            ShowGroupIdOnIDCard: row.ShowGroupIdOnIDCard === true || row.ShowGroupIdOnIDCard === 1 ? 1 : 0,
            SetupFee: row.SetupFee != null ? Number(row.SetupFee) : null,
            IncludeProcessingFee: row.IncludeProcessingFee === true || row.IncludeProcessingFee === 1 ? 1 : 0,
            RoundUpProcessingFee: row.RoundUpProcessingFee === true || row.RoundUpProcessingFee === 1 ? 1 : 0,
            ZeroFeeForACH: row.ZeroFeeForACH === true || row.ZeroFeeForACH === 1 ? 1 : 0,
            CustomSystemFeeEnabled: row.CustomSystemFeeEnabled === true || row.CustomSystemFeeEnabled === 1 ? 1 : 0,
            CustomSystemFeeAmount: row.CustomSystemFeeAmount != null ? Number(row.CustomSystemFeeAmount) : null,
            MustBeSoldWithProductIds: row.MustBeSoldWithProductIds || null
        };
    } catch (err) {
        console.warn('⚠️ Failed to load owner subscriber defaults, falling back to neutral defaults:', err.message);
        return neutralDefaults;
    }
}

/**
 * GET /api/tenant/products
 * Get all subscribed products for the tenant
 * Used for: Product selection when creating groups, agent product access, subscribed products display
 * Query params:
 *   - activeOnly=true: Only return Active/Approved subscriptions (for group creation)
 *   - activeOnly=false or omitted: Return all non-cancelled subscriptions (for subscribed products tab)
 */
router.get('/products', authenticate, authorize(['TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user.TenantId;
        const activeOnly = req.query.activeOnly === 'true';
        const includeHidden = req.query.includeHidden === 'true';
        const pool = await getPool();
        
        const request = pool.request();
        request.input('TenantId', sql.UniqueIdentifier, tenantId);
        
        // Build status filter based on activeOnly parameter
        const statusFilter = activeOnly 
            ? "AND tps.SubscriptionStatus IN ('Active', 'Approved')" 
            : "AND tps.SubscriptionStatus != 'Cancelled'";
        
        // Default behavior keeps hidden products excluded.
        // Commission rule edit mode can opt in via includeHidden=true.
        const hiddenFilter = includeHidden ? '' : "AND (p.IsHidden IS NULL OR p.IsHidden = 0)";
        
        const result = await request.query(`
            SELECT 
                tps.SubscriptionId,
                p.ProductId,
                p.Name as ProductName,
                p.ProductType,
                p.Description,
                p.IsBundle,
                p.IsHidden,
                p.SalesType,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.ProductOwnerId,
                p.VendorId,
                p.IDCardData,
                t.Name as ProductOwnerName,
                v.VendorName,
                v.MinimumEmployeesPerGroup as VendorMinimumEmployeesPerGroup,
                t.ContactEmail as ProductOwnerEmail,
                t.ContactPhone as ProductOwnerPhone,
                t.ContactPerson as ProductOwnerContact,
                -- Calculate BasicPrice from pricing
                ISNULL((
                    SELECT TOP 1 pp.NetRate + pp.OverrideRate
                    FROM oe.ProductPricing pp
                    WHERE pp.ProductId = p.ProductId
                    AND pp.Status = 'Active'
                    ORDER BY pp.CreatedDate DESC
                ), 0) as BasicPrice,
                ISNULL(psr.RequestedDiscount, 0) as RequestedDiscount,
                ISNULL(psr.ApprovedDiscount, 0) as ApprovedDiscount,
                psr.DiscountType,
                psr.TierDiscounts,
                tps.TenantRate,
                tps.ProfitMargin,
                tps.SystemFeesSnapshot,
                tps.SalePrice,
                tps.SetupFee,
                tps.SubscriptionStatus,
                tps.IncludeProcessingFee,
                p.IncludeProcessingFee AS ProductIncludeProcessingFee,
                tps.RoundUpProcessingFee,
                tps.ZeroFeeForACH,
                tps.CustomSystemFeeEnabled,
                tps.CustomSystemFeeAmount,
                tps.MustBeSoldWithProductIds,
                psr.Notes as RequestMessage,
                psr.ProcessingNotes as ResponseMessage,
                psr.RequestDate,
                psr.ProcessedDate as ResponseDate,
                tps.IsConfigured
            FROM oe.TenantProductSubscriptions tps
            INNER JOIN oe.Products p ON tps.ProductId = p.ProductId
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            LEFT JOIN oe.ProductSubscriptionRequests psr ON tps.RequestId = psr.RequestId
            WHERE tps.TenantId = @TenantId
            ${statusFilter}
            AND p.Status = 'Active'
            ${hiddenFilter}
            ORDER BY tps.SubscriptionDate DESC
        `);
        
        // Format the response and add bundle products
        const subscribedProducts = await Promise.all(result.recordset.map(async row => {
            console.log('🔍 Raw database row for product:', row.ProductName);
            console.log('  - ProductImageUrl:', row.ProductImageUrl);
            console.log('  - ProductLogoUrl:', row.ProductLogoUrl);
            console.log('  - ProductDocumentUrl:', row.ProductDocumentUrl);
            console.log('  - IsBundle:', row.IsBundle);
            
            // Parse IDCardData so the GroupsAddGroup network picker can detect
            // NetworkVariations without re-parsing client-side.
            let idCardData = null;
            if (row.IDCardData) {
                try {
                    idCardData = typeof row.IDCardData === 'string'
                        ? JSON.parse(row.IDCardData)
                        : row.IDCardData;
                } catch (e) {
                    console.warn('Error parsing IDCardData for product', row.ProductId, e.message);
                }
            }

            const baseProduct = {
                subscriptionId: row.SubscriptionId,
                ProductId: row.ProductId,
                Name: row.ProductName,
                ProductType: row.ProductType,
                description: row.Description,
                IsBundle: row.IsBundle,
                IsHidden: row.IsHidden || 0,
                SalesType: row.SalesType,
                productImageUrl: row.ProductImageUrl,
                productLogoUrl: row.ProductLogoUrl,
                productDocumentUrl: row.ProductDocumentUrl,
                vendorId: row.VendorId || null,
                idCardData,
                vendorName: row.VendorName || null,
                vendorMinimumEmployeesPerGroup: row.VendorMinimumEmployeesPerGroup != null ? Number(row.VendorMinimumEmployeesPerGroup) : null,
                basicPrice: row.BasicPrice,
                productOwnerId: row.ProductOwnerId,
                productOwner: {
                    tenantName: row.ProductOwnerName,
                    contactEmail: row.ProductOwnerEmail,
                    contactPhone: row.ProductOwnerPhone,
                    contactPerson: row.ProductOwnerContact
                },
                subscriptionStatus: row.SubscriptionStatus,
                requestedDiscount: row.RequestedDiscount,
                approvedDiscount: row.ApprovedDiscount,
                discountType: row.DiscountType,
                tierDiscounts: row.TierDiscounts ? JSON.parse(row.TierDiscounts) : null,
                tenantRate: row.TenantRate,
                profitMargin: row.ProfitMargin,
                systemFees: row.SystemFeesSnapshot ? JSON.parse(row.SystemFeesSnapshot) : null,
                salePrice: row.SalePrice,
                requestMessage: row.RequestMessage,
                responseMessage: row.ResponseMessage,
                requestDate: row.RequestDate,
                responseDate: row.ResponseDate,
                isConfigured: row.IsConfigured,
                includeProcessingFee: row.IncludeProcessingFee === true || row.IncludeProcessingFee === 1,
                includeProcessingFeeFromProduct:
                    row.ProductIncludeProcessingFee === true || row.ProductIncludeProcessingFee === 1,
                roundUpProcessingFee: row.RoundUpProcessingFee === true || row.RoundUpProcessingFee === 1,
                zeroFeeForACH: row.ZeroFeeForACH === true || row.ZeroFeeForACH === 1,
                customSystemFeeEnabled: row.CustomSystemFeeEnabled === true || row.CustomSystemFeeEnabled === 1,
                customSystemFeeAmount: row.CustomSystemFeeAmount != null ? Number(row.CustomSystemFeeAmount) : null,
                mustBeSoldWithProductIds: row.MustBeSoldWithProductIds ? (() => { try { return JSON.parse(row.MustBeSoldWithProductIds); } catch { return []; } })() : [],
                status: 'Active',
                IsActive: true,
                bundleProducts: []
            };

            // If this is a bundle, get included products
            if (row.IsBundle) {
                console.log(`🔍 Processing bundle product: ${row.ProductName}`);

                try {
                    const bundleRequest = pool.request();
                    bundleRequest.input('BundleProductId', sql.UniqueIdentifier, row.ProductId);

                    const bundleResult = await bundleRequest.query(`
                        SELECT
                            pb.IncludedProductId,
                            pb.SortOrder,
                            pb.IsRequired,
                            pb.HidePricing,
                            pb.LinkedToProductId,
                            p.Name AS ProductName,
                            p.Description,
                            p.ProductType,
                            p.Status,
                            p.VendorId,
                            p.IDCardData,
                            v.VendorName,
                            v.MinimumEmployeesPerGroup AS VendorMinimumEmployeesPerGroup
                        FROM oe.ProductBundles pb
                        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                        LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
                        WHERE pb.BundleProductId = @BundleProductId
                          AND p.Status = 'Active'
                        ORDER BY pb.SortOrder
                    `);

                    baseProduct.bundleProducts = bundleResult.recordset.map(bundleProduct => {
                        let bIdCard = null;
                        if (bundleProduct.IDCardData) {
                            try {
                                bIdCard = typeof bundleProduct.IDCardData === 'string'
                                    ? JSON.parse(bundleProduct.IDCardData)
                                    : bundleProduct.IDCardData;
                            } catch (_) { /* ignore */ }
                        }
                        return {
                            productId: bundleProduct.IncludedProductId,
                            name: bundleProduct.ProductName,
                            productName: bundleProduct.ProductName, // alias for downstream consumers
                            description: bundleProduct.Description,
                            productType: bundleProduct.ProductType,
                            sortOrder: bundleProduct.SortOrder,
                            isRequired: bundleProduct.IsRequired,
                            hidePricing: bundleProduct.HidePricing ?? false,
                            linkedToProductId: bundleProduct.HidePricing ? bundleProduct.LinkedToProductId || null : null,
                            vendorId: bundleProduct.VendorId || null,
                            vendorName: bundleProduct.VendorName || null,
                            idCardData: bIdCard,
                            vendorMinimumEmployeesPerGroup: bundleProduct.VendorMinimumEmployeesPerGroup != null ? Number(bundleProduct.VendorMinimumEmployeesPerGroup) : null
                        };
                    });

                    // Bundle's effective vendor minimum is the strictest constraint
                    // across the bundle's own vendor and the vendors of its included
                    // products. Without this, an Agent selecting a bundle whose own
                    // vendor has no minimum would never see a child vendor's minimum.
                    const childMinimums = bundleResult.recordset
                        .map(b => (b.VendorMinimumEmployeesPerGroup != null ? Number(b.VendorMinimumEmployeesPerGroup) : null))
                        .filter(n => n != null);
                    const rollupCandidates = [baseProduct.vendorMinimumEmployeesPerGroup, ...childMinimums].filter(n => n != null);
                    baseProduct.vendorMinimumEmployeesPerGroup = rollupCandidates.length ? Math.max(...rollupCandidates) : null;

                    // Alias for the network picker — same data, different key, so the
                    // shared NetworkPickerForProduct helper finds it.
                    baseProduct.includedProducts = baseProduct.bundleProducts;

                    console.log(`🔍 Bundle ${row.ProductName} has ${baseProduct.bundleProducts.length} included products`);
                    
                } catch (bundleError) {
                    console.error('Error fetching bundle products:', bundleError);
                    baseProduct.bundleProducts = [];
                }
            }
            
            return baseProduct;
        }));
        
        // Authenticate blob URLs for all products
        console.log('🔐 Authenticating URLs for', subscribedProducts.length, 'subscribed products');
        const authenticatedProducts = await Promise.all(
            subscribedProducts.map(product => authenticateProductUrls(product))
        );
        console.log('✅ Authentication complete for subscribed products');
        
        res.json({
            success: true,
            data: authenticatedProducts
        });
        
    } catch (error) {
        console.error('Error fetching subscribed products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch subscribed products'
        });
    }
});

/**
 * GET /api/tenant/products/catalog
 * Get all available products in the marketplace
 */
router.get('/products/catalog', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!tenantId) {
            console.error('❌ GET /api/tenant/products/catalog - No tenantId found');
            return res.status(400).json({
                success: false,
                message: 'Tenant ID is required'
            });
        }
        
        console.log(`🔍 GET /api/tenant/products/catalog - Fetching catalog for tenant: ${tenantId} (req.tenantId: ${req.tenantId}, user.TenantId: ${req.user?.TenantId})`);
        
        const pool = await getPool();
        const request = pool.request();
        request.input('TenantId', sql.UniqueIdentifier, tenantId);
        
        const result = await request.query(`
            SELECT 
                p.ProductId,
                p.Name as ProductName,
                p.ProductType,
                p.Description,
                p.IsBundle,
                p.SalesType,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                v.VendorName,
                t.Name as ProductOwnerName,
                t.ContactEmail as ProductOwnerEmail,
                t.ContactPhone as ProductOwnerPhone,
                t.ContactPerson as ProductOwnerContact,
                -- Calculate BasicPrice from pricing (minimum rate)
                ISNULL((
                    SELECT MIN(pp.NetRate + pp.OverrideRate)
                    FROM oe.ProductPricing pp
                    WHERE pp.ProductId = p.ProductId 
                    AND pp.Status = 'Active'
                ), 0) as BasicPrice,
                p.AllowedStates,
                p.MinAge,
                p.MaxAge
            FROM oe.Products p
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            WHERE p.Status = 'Active'
            AND p.IsMarketplaceProduct = 1
            -- Other tenants' marketplace products: visible if not explicitly private (IsPublic = 0).
            -- NULL/legacy rows default to public so global marketplace listings match /api/marketplace/products.
            AND (p.ProductOwnerId = @TenantId OR ISNULL(p.IsPublic, 1) = 1)
            -- Exclude already subscribed products
            AND p.ProductId NOT IN (
                SELECT ProductId 
                FROM oe.TenantProductSubscriptions 
                WHERE TenantId = @TenantId 
                AND SubscriptionStatus != 'Cancelled'
            )
            ORDER BY p.Name
        `);
        
        console.log(`Found ${result.recordset.length} marketplace products`);
        
        // For each product, get its pricing tiers
        const productsWithPricing = await Promise.all(result.recordset.map(async (product) => {
            const pricingRequest = pool.request();
            pricingRequest.input('ProductId', sql.UniqueIdentifier, product.ProductId);
            
            const pricingQuery = `
                SELECT 
                    ProductPricingId,
                    MinAge,
                    MaxAge,
                    NetRate,
                    OverrideRate,
                    TierType,
                    TobaccoStatus,
                    Status
                FROM oe.ProductPricing
                WHERE ProductId = @ProductId
                AND Status = 'Active'
                ORDER BY TierType, TobaccoStatus, MinAge
            `;
            
            console.log(`Fetching pricing for product ${product.ProductName} (${product.ProductId})`);
            const pricingResult = await pricingRequest.query(pricingQuery);
            console.log(`Found ${pricingResult.recordset.length} pricing records`);
            
            // Process pricing tiers with proper structure
            const pricingTiers = pricingResult.recordset.map(pricing => ({
                id: pricing.ProductPricingId,
                minAge: pricing.MinAge || 0,
                maxAge: pricing.MaxAge || 0,
                tierType: pricing.TierType || 'Standard',
                tobaccoStatus: pricing.TobaccoStatus || 'N/A',
                netRate: parseFloat(pricing.NetRate) || 0,
                overrideRate: parseFloat(pricing.OverrideRate) || 0,
                rate: (parseFloat(pricing.NetRate) || 0) + (parseFloat(pricing.OverrideRate) || 0)
            }));
            
            // Sort by tier type, tobacco status, and age
            pricingTiers.sort((a, b) => {
                if (a.tierType !== b.tierType) return a.tierType.localeCompare(b.tierType);
                if (a.tobaccoStatus !== b.tobaccoStatus) return a.tobaccoStatus.localeCompare(b.tobaccoStatus);
                return a.minAge - b.minAge;
            });
            
            console.log(`Processed ${pricingTiers.length} pricing tiers for ${product.ProductName}:`, 
                JSON.stringify(pricingTiers, null, 2));
            
            return {
                ...product,
                pricingTiers: pricingTiers.length > 0 ? pricingTiers : null
            };
        }));
        
        // Format the response and add bundle products
        const marketplaceProducts = await Promise.all(productsWithPricing.map(async row => {
            console.log('🔍 Raw marketplace product row:', row.ProductName);
            console.log('  - ProductImageUrl:', row.ProductImageUrl);
            console.log('  - ProductLogoUrl:', row.ProductLogoUrl);
            console.log('  - ProductDocumentUrl:', row.ProductDocumentUrl);
            console.log('  - IsBundle:', row.IsBundle);
            
            let allowedStates = [];
            try {
                if (row.AllowedStates) {
                    allowedStates = typeof row.AllowedStates === 'string' 
                        ? JSON.parse(row.AllowedStates) 
                        : row.AllowedStates;
                }
            } catch (e) {
                console.error('Error parsing allowed states:', e);
                allowedStates = [];
            }
            
            const baseProduct = {
                productId: row.ProductId,
                Name: row.ProductName, // Match subscribed products format
                productType: row.ProductType,
                description: row.Description,
                IsBundle: row.IsBundle,
                SalesType: row.SalesType,
                productImageUrl: row.ProductImageUrl,
                productLogoUrl: row.ProductLogoUrl,
                productDocumentUrl: row.ProductDocumentUrl,
                basicPrice: row.BasicPrice,
                vendorName: row.VendorName || null,
                productOwner: {
                    tenantName: row.ProductOwnerName,
                    contactEmail: row.ProductOwnerEmail,
                    contactPhone: row.ProductOwnerPhone,
                    contactPerson: row.ProductOwnerContact
                },
                status: 'Active',
                allowedStates,
                minAge: row.MinAge,
                maxAge: row.MaxAge,
                pricingTiers: row.pricingTiers,
                bundleProducts: []
            };

            // If this is a bundle, get included products
            if (row.IsBundle) {
                console.log(`🔍 Processing marketplace bundle product: ${row.ProductName}`);
                
                try {
                    const bundleRequest = pool.request();
                    bundleRequest.input('BundleProductId', sql.UniqueIdentifier, row.ProductId);
                    
                    const bundleResult = await bundleRequest.query(`
                        SELECT 
                            pb.IncludedProductId,
                            pb.SortOrder,
                            pb.IsRequired,
                            pb.HidePricing,
                            pb.LinkedToProductId,
                            p.Name AS ProductName,
                            p.Description,
                            p.ProductType,
                            p.Status,
                            v.VendorName
                        FROM oe.ProductBundles pb
                        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                        LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
                        WHERE pb.BundleProductId = @BundleProductId
                          AND p.Status = 'Active'
                        ORDER BY pb.SortOrder
                    `);
                    
                    baseProduct.bundleProducts = bundleResult.recordset.map(bundleProduct => ({
                        productId: bundleProduct.IncludedProductId,
                        name: bundleProduct.ProductName,
                        description: bundleProduct.Description,
                        productType: bundleProduct.ProductType,
                        sortOrder: bundleProduct.SortOrder,
                        isRequired: bundleProduct.IsRequired,
                        hidePricing: bundleProduct.HidePricing ?? false,
                        linkedToProductId: bundleProduct.HidePricing ? bundleProduct.LinkedToProductId || null : null,
                        vendorName: bundleProduct.VendorName || null
                    }));
                    
                    console.log(`🔍 Marketplace Bundle ${row.ProductName} has ${baseProduct.bundleProducts.length} included products`);
                    
                } catch (bundleError) {
                    console.error('Error fetching marketplace bundle products:', bundleError);
                    baseProduct.bundleProducts = [];
                }
            }
            
            return baseProduct;
        }));
        
        // Authenticate blob URLs for all products
        console.log('🔐 Authenticating URLs for', marketplaceProducts.length, 'marketplace products');
        const authenticatedProducts = await Promise.all(
            marketplaceProducts.map(product => authenticateProductUrls(product))
        );
        console.log('✅ Authentication complete for marketplace products');
        
        res.json({
            success: true,
            data: authenticatedProducts
        });
        
    } catch (error) {
        console.error('Error fetching marketplace products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch marketplace products'
        });
    }
});

/**
 * POST /api/tenant/products/request
 * Request subscription to a product
 */
router.post('/products/request', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user.TenantId;
        const userId = req.user.UserId || req.user.userId;
        const { 
            productId, 
            discountType, 
            requestedDiscount, 
            tierDiscounts, 
            message, 
            discountJustification
            // Note: setupFee is NOT set during initial subscription request
            // It's set later via PUT /products/:subscriptionId/setup-fee
        } = req.body;
        
        if (!productId) {
            return res.status(400).json({
                success: false,
                message: 'Product ID is required'
            });
        }
        
        if (!discountType || !['percent', 'flatRate', 'tierBased'].includes(discountType)) {
            return res.status(400).json({
                success: false,
                message: 'Valid discount type is required (percent, flatRate, or tierBased)'
            });
        }
        
        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
            // Check if product exists and is available
            const productCheck = transaction.request();
            productCheck.input('ProductId', sql.UniqueIdentifier, productId);
            
            const productResult = await productCheck.query(`
                SELECT 
                    p.ProductId,
                    p.Name,
                    p.IsBundle,
                    p.ProductOwnerId,
                    ISNULL((
                        SELECT MIN(pp.NetRate + pp.OverrideRate)
                        FROM oe.ProductPricing pp
                        WHERE pp.ProductId = p.ProductId 
                        AND pp.Status = 'Active'
                    ), 0) as BasicPrice
                FROM oe.Products p
                WHERE p.ProductId = @ProductId
                AND p.Status = 'Active'
                AND p.IsMarketplaceProduct = 1
            `);
            
            if (productResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Product not found or not available'
                });
            }
            
            const product = productResult.recordset[0];
            
            // Check if already subscribed
            const subscriptionCheck = transaction.request();
            subscriptionCheck.input('TenantId', sql.UniqueIdentifier, tenantId);
            subscriptionCheck.input('ProductId', sql.UniqueIdentifier, productId);
            
            const existingSubscription = await subscriptionCheck.query(`
                SELECT SubscriptionId 
                FROM oe.TenantProductSubscriptions
                WHERE TenantId = @TenantId 
                AND ProductId = @ProductId
                AND SubscriptionStatus != 'Cancelled'
            `);
            
            if (existingSubscription.recordset.length > 0) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Already subscribed to this product'
                });
            }
            
            // Create subscription request
            const requestId = require('crypto').randomUUID();
            const requestInsert = transaction.request();
            requestInsert.input('RequestId', sql.UniqueIdentifier, requestId);
            requestInsert.input('TenantId', sql.UniqueIdentifier, tenantId);
            requestInsert.input('ProductId', sql.UniqueIdentifier, productId);
            requestInsert.input('DiscountType', sql.NVarChar(20), discountType);
            requestInsert.input('RequestedDiscount', sql.Decimal(5, 2), requestedDiscount || 0);
            requestInsert.input('TierDiscounts', sql.NVarChar, tierDiscounts ? JSON.stringify(tierDiscounts) : null);
            requestInsert.input('Notes', sql.NVarChar, message || null);
            requestInsert.input('DiscountJustification', sql.NVarChar, discountJustification || null);
            requestInsert.input('RequestedBy', sql.UniqueIdentifier, userId);
            requestInsert.input('RequestDate', sql.DateTime2, new Date());
            requestInsert.input('Status', sql.NVarChar(20), 'Pending');
            
            await requestInsert.query(`
                INSERT INTO oe.ProductSubscriptionRequests (
                    RequestId, TenantId, ProductId, DiscountType, RequestedDiscount,
                    TierDiscounts, Notes, DiscountJustification,
                    RequestedBy, RequestDate, Status
                ) VALUES (
                    @RequestId, @TenantId, @ProductId, @DiscountType, @RequestedDiscount,
                    @TierDiscounts, @Notes, @DiscountJustification,
                    @RequestedBy, @RequestDate, @Status
                )
            `);
            
            // Calculate initial tenant rate (without discount, pending approval)
            const tenantRate = product.BasicPrice;
            
            // Get current system fees
            const tenantRequest = transaction.request();
            tenantRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
            
            const tenantResult = await tenantRequest.query(`
                SELECT SystemFees FROM oe.Tenants WHERE TenantId = @TenantId
            `);
            
            const systemFees = tenantResult.recordset[0]?.SystemFees || JSON.stringify({
                platformFee: { name: "Platform Fee", amount: 2.5, type: "fixed" },
                transactionFee: { name: "Transaction Fee", amount: 0.5, type: "fixed" },
                processingFee: { name: "Processing Fee", amount: 1.0, type: "fixed" }
            });

            // Carry over the product owner's default subscriber configuration as defaults
            // for this new subscriber. The owner's own oe.TenantProductSubscriptions row for
            // their product acts as the "default subscriber configuration" template.
            const ownerDefaults = await fetchOwnerSubscriberDefaults(
                transaction,
                productId,
                product.ProductOwnerId
            );

            // Create subscription in pending state (SetupFee is NULL initially, set later)
            const subscriptionId = require('crypto').randomUUID();
            const subscriptionInsert = transaction.request();
            subscriptionInsert.input('SubscriptionId', sql.UniqueIdentifier, subscriptionId);
            subscriptionInsert.input('TenantId', sql.UniqueIdentifier, tenantId);
            subscriptionInsert.input('ProductId', sql.UniqueIdentifier, productId);
            subscriptionInsert.input('RequestId', sql.UniqueIdentifier, requestId);
            subscriptionInsert.input('SubscriptionStatus', sql.NVarChar(50), 'Pending');
            subscriptionInsert.input('TenantRate', sql.Decimal(19, 4), tenantRate);
            subscriptionInsert.input('SystemFeesSnapshot', sql.NVarChar, systemFees);
            subscriptionInsert.input('CreatedBy', sql.UniqueIdentifier, userId);
            subscriptionInsert.input('ModifiedBy', sql.UniqueIdentifier, userId);
            subscriptionInsert.input('SubscriptionDate', sql.DateTime2, new Date());
            subscriptionInsert.input('ModifiedDate', sql.DateTime2, new Date());
            subscriptionInsert.input('IsConfigured', sql.Bit, 0);
            subscriptionInsert.input('ProfitMargin', sql.Decimal(19, 4), ownerDefaults.ProfitMargin);
            subscriptionInsert.input('ShowGroupIdOnIDCard', sql.Bit, ownerDefaults.ShowGroupIdOnIDCard);
            subscriptionInsert.input('SetupFee', sql.Decimal(19, 4), ownerDefaults.SetupFee);
            subscriptionInsert.input('IncludeProcessingFee', sql.Bit, ownerDefaults.IncludeProcessingFee);
            subscriptionInsert.input('RoundUpProcessingFee', sql.Bit, ownerDefaults.RoundUpProcessingFee);
            subscriptionInsert.input('ZeroFeeForACH', sql.Bit, ownerDefaults.ZeroFeeForACH);
            subscriptionInsert.input('CustomSystemFeeEnabled', sql.Bit, ownerDefaults.CustomSystemFeeEnabled);
            subscriptionInsert.input('CustomSystemFeeAmount', sql.Decimal(19, 4), ownerDefaults.CustomSystemFeeAmount);
            subscriptionInsert.input('MustBeSoldWithProductIds', sql.NVarChar(sql.MAX), ownerDefaults.MustBeSoldWithProductIds);

            await subscriptionInsert.query(`
                INSERT INTO oe.TenantProductSubscriptions (
                    SubscriptionId, TenantId, ProductId, RequestId,
                    SubscriptionStatus, TenantRate, SystemFeesSnapshot,
                    CreatedBy, ModifiedBy, SubscriptionDate, ModifiedDate,
                    IsConfigured,
                    ProfitMargin, ShowGroupIdOnIDCard, SetupFee,
                    IncludeProcessingFee, RoundUpProcessingFee, ZeroFeeForACH,
                    CustomSystemFeeEnabled, CustomSystemFeeAmount,
                    MustBeSoldWithProductIds
                ) VALUES (
                    @SubscriptionId, @TenantId, @ProductId, @RequestId,
                    @SubscriptionStatus, @TenantRate, @SystemFeesSnapshot,
                    @CreatedBy, @ModifiedBy, @SubscriptionDate, @ModifiedDate,
                    @IsConfigured,
                    @ProfitMargin, @ShowGroupIdOnIDCard, @SetupFee,
                    @IncludeProcessingFee, @RoundUpProcessingFee, @ZeroFeeForACH,
                    @CustomSystemFeeEnabled, @CustomSystemFeeAmount,
                    @MustBeSoldWithProductIds
                )
            `);

            // If this is a bundle, create per-included-product subscription records for configuration purposes
            // (e.g., ID card settings like StaticGroupId / ShowGroupIdOnIDCard are per product subscription)
            if (product.IsBundle) {
                console.log('📦 Bundle subscription requested - creating included product subscriptions:', productId);

                const includedProductsRequest = transaction.request();
                includedProductsRequest.input('BundleProductId', sql.UniqueIdentifier, productId);

                const includedProducts = await includedProductsRequest.query(`
                    SELECT 
                        pb.IncludedProductId,
                        p.ProductOwnerId,
                        ISNULL((
                            SELECT MIN(pp.NetRate + pp.OverrideRate)
                            FROM oe.ProductPricing pp
                            WHERE pp.ProductId = pb.IncludedProductId
                              AND pp.Status = 'Active'
                        ), 0) as BasicPrice
                    FROM oe.ProductBundles pb
                    INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                    WHERE pb.BundleProductId = @BundleProductId
                      AND p.Status = 'Active'
                `);

                for (const included of includedProducts.recordset) {
                    const childSubscriptionId = require('crypto').randomUUID();

                    // Carry over each included product owner's default subscriber configuration
                    const childOwnerDefaults = await fetchOwnerSubscriberDefaults(
                        transaction,
                        included.IncludedProductId,
                        included.ProductOwnerId
                    );

                    const childInsert = transaction.request();
                    childInsert.input('SubscriptionId', sql.UniqueIdentifier, childSubscriptionId);
                    childInsert.input('TenantId', sql.UniqueIdentifier, tenantId);
                    childInsert.input('ProductId', sql.UniqueIdentifier, included.IncludedProductId);
                    // Reuse the same requestId so we can identify these as part of the bundle subscription workflow
                    childInsert.input('RequestId', sql.UniqueIdentifier, requestId);
                    childInsert.input('SubscriptionStatus', sql.NVarChar(50), 'Pending');
                    childInsert.input('TenantRate', sql.Decimal(19, 4), included.BasicPrice || 0);
                    childInsert.input('SystemFeesSnapshot', sql.NVarChar, systemFees);
                    childInsert.input('CreatedBy', sql.UniqueIdentifier, userId);
                    childInsert.input('ModifiedBy', sql.UniqueIdentifier, userId);
                    childInsert.input('SubscriptionDate', sql.DateTime2, new Date());
                    childInsert.input('ModifiedDate', sql.DateTime2, new Date());
                    childInsert.input('IsConfigured', sql.Bit, 0);
                    childInsert.input('ProfitMargin', sql.Decimal(19, 4), childOwnerDefaults.ProfitMargin);
                    childInsert.input('ShowGroupIdOnIDCard', sql.Bit, childOwnerDefaults.ShowGroupIdOnIDCard);
                    childInsert.input('SetupFee', sql.Decimal(19, 4), childOwnerDefaults.SetupFee);
                    childInsert.input('IncludeProcessingFee', sql.Bit, childOwnerDefaults.IncludeProcessingFee);
                    childInsert.input('RoundUpProcessingFee', sql.Bit, childOwnerDefaults.RoundUpProcessingFee);
                    childInsert.input('ZeroFeeForACH', sql.Bit, childOwnerDefaults.ZeroFeeForACH);
                    childInsert.input('CustomSystemFeeEnabled', sql.Bit, childOwnerDefaults.CustomSystemFeeEnabled);
                    childInsert.input('CustomSystemFeeAmount', sql.Decimal(19, 4), childOwnerDefaults.CustomSystemFeeAmount);
                    childInsert.input('MustBeSoldWithProductIds', sql.NVarChar(sql.MAX), childOwnerDefaults.MustBeSoldWithProductIds);

                    await childInsert.query(`
                        INSERT INTO oe.TenantProductSubscriptions (
                            SubscriptionId, TenantId, ProductId, RequestId,
                            SubscriptionStatus, TenantRate, SystemFeesSnapshot,
                            CreatedBy, ModifiedBy, SubscriptionDate, ModifiedDate,
                            IsConfigured,
                            ProfitMargin, ShowGroupIdOnIDCard, SetupFee,
                            IncludeProcessingFee, RoundUpProcessingFee, ZeroFeeForACH,
                            CustomSystemFeeEnabled, CustomSystemFeeAmount,
                            MustBeSoldWithProductIds
                        ) VALUES (
                            @SubscriptionId, @TenantId, @ProductId, @RequestId,
                            @SubscriptionStatus, @TenantRate, @SystemFeesSnapshot,
                            @CreatedBy, @ModifiedBy, @SubscriptionDate, @ModifiedDate,
                            @IsConfigured,
                            @ProfitMargin, @ShowGroupIdOnIDCard, @SetupFee,
                            @IncludeProcessingFee, @RoundUpProcessingFee, @ZeroFeeForACH,
                            @CustomSystemFeeEnabled, @CustomSystemFeeAmount,
                            @MustBeSoldWithProductIds
                        )
                    `);
                }

                console.log(`✅ Created ${includedProducts.recordset.length} included-product subscription records for bundle`, productId);
            }
            
            await transaction.commit();
            
            res.status(201).json({
                success: true,
                message: 'Subscription request submitted successfully',
                data: {
                    requestId,
                    subscriptionId
                }
            });
            
        } catch (transactionError) {
            await transaction.rollback();
            throw transactionError;
        }
        
    } catch (error) {
        console.error('Error requesting product subscription:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit subscription request'
        });
    }
});

/**
 * PUT /api/tenant/products/:subscriptionId/setup-fee
 * Update setup fee for a subscribed product (stored in oe.TenantProductSubscriptions)
 */
router.put('/products/:subscriptionId/setup-fee', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user.TenantId;
        const userId = req.user.UserId || req.user.userId;
        const pool = await getPool();

        const resolved = await resolveTenantProductSubscriptionId(
            pool,
            sql,
            tenantId,
            userId,
            req.params.subscriptionId
        );
        if (!resolved.ok) {
            return res.status(resolved.status).json({ success: false, message: resolved.message });
        }
        const subscriptionId = resolved.subscriptionId;
        const { setupFee } = req.body;
        
        // Validate setupFee
        if (setupFee !== undefined && setupFee !== null) {
            if (typeof setupFee !== 'number' || setupFee < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'SetupFee must be a non-negative number'
                });
            }
        }
        
        // Get tenant's minimum setup fee for validation
        const tenantRequest = pool.request();
        tenantRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
        const tenantResult = await tenantRequest.query(`
            SELECT MinimumSetupFee FROM oe.Tenants WHERE TenantId = @TenantId
        `);
        
        const tenantMinimumSetupFee = tenantResult.recordset[0]?.MinimumSetupFee;
        if (setupFee !== null && tenantMinimumSetupFee !== null && setupFee < tenantMinimumSetupFee) {
            return res.status(400).json({
                success: false,
                message: `Setup fee must be at least $${tenantMinimumSetupFee.toFixed(2)} (tenant minimum)`
            });
        }
        
        // Verify subscription exists and belongs to tenant
        const verifyRequest = pool.request();
        verifyRequest.input('SubscriptionId', sql.UniqueIdentifier, subscriptionId);
        verifyRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
        
        const verifyResult = await verifyRequest.query(`
            SELECT SubscriptionId FROM oe.TenantProductSubscriptions
            WHERE SubscriptionId = @SubscriptionId
            AND TenantId = @TenantId
            AND SubscriptionStatus IN ('Active', 'Approved')
        `);
        
        if (verifyResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Subscription not found or not active'
            });
        }
        
        // Update setup fee in TenantProductSubscriptions
        const updateRequest = pool.request();
        updateRequest.input('SubscriptionId', sql.UniqueIdentifier, subscriptionId);
        updateRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
        updateRequest.input('SetupFee', sql.Decimal(18, 2), setupFee !== null && setupFee !== undefined ? setupFee : null);
        updateRequest.input('ModifiedBy', sql.UniqueIdentifier, userId);
        updateRequest.input('ModifiedDate', sql.DateTime2, new Date());
        
        const result = await updateRequest.query(`
            UPDATE oe.TenantProductSubscriptions
            SET 
                SetupFee = @SetupFee,
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE SubscriptionId = @SubscriptionId
            AND TenantId = @TenantId
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Subscription not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Setup fee updated successfully',
            data: {
                subscriptionId,
                setupFee: setupFee !== null && setupFee !== undefined ? setupFee : null
            }
        });
        
    } catch (error) {
        console.error('Error updating setup fee:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update setup fee'
        });
    }
});

/**
 * PUT /api/tenant/products/:subscriptionId/configure
 * Configure profit margin for a subscribed product
 */
router.put('/products/:subscriptionId/configure', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user.TenantId;
        const userId = req.user.UserId || req.user.userId;
        const pool = await getPool();

        const resolved = await resolveTenantProductSubscriptionId(
            pool,
            sql,
            tenantId,
            userId,
            req.params.subscriptionId
        );
        if (!resolved.ok) {
            return res.status(resolved.status).json({ success: false, message: resolved.message });
        }
        const subscriptionId = resolved.subscriptionId;
        const { profitMargin } = req.body;
        
        if (profitMargin == null || profitMargin < 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid profit margin is required'
            });
        }

        // Must be sold with: validate and resolve (exclude self ProductId)
        let mustBeSoldWithJson = null;
        const rawMustBeSoldWith = req.body.mustBeSoldWithProductIds;
        if (rawMustBeSoldWith != null && !Array.isArray(rawMustBeSoldWith)) {
            return res.status(400).json({
                success: false,
                message: 'mustBeSoldWithProductIds must be an array'
            });
        }
        if (Array.isArray(rawMustBeSoldWith) && rawMustBeSoldWith.length > 0) {
            const validIds = rawMustBeSoldWith.filter(id => typeof id === 'string' && id.trim() && isValidGuid(id.trim()));
            const subReq = pool.request();
            subReq.input('SubscriptionId', sql.UniqueIdentifier, subscriptionId);
            subReq.input('TenantId', sql.UniqueIdentifier, tenantId);
            const subRow = await subReq.query(`
                SELECT ProductId FROM oe.TenantProductSubscriptions
                WHERE SubscriptionId = @SubscriptionId AND TenantId = @TenantId
            `);
            const selfProductId = subRow.recordset[0]?.ProductId?.toString?.();
            const filtered = selfProductId
                ? validIds.filter(id => id.trim().toLowerCase() !== selfProductId.toLowerCase())
                : validIds;
            mustBeSoldWithJson = JSON.stringify(filtered);
        }
        
        const request = pool.request();
        // Validate setupFee if provided
        const setupFee = req.body.setupFee !== undefined ? req.body.setupFee : null;
        if (setupFee !== null && setupFee !== undefined) {
            if (typeof setupFee !== 'number' || setupFee < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'SetupFee must be a non-negative number'
                });
            }
        }
        
        request.input('SubscriptionId', sql.UniqueIdentifier, subscriptionId);
        request.input('TenantId', sql.UniqueIdentifier, tenantId);
        request.input('ProfitMargin', sql.Decimal(19, 4), profitMargin);
        request.input('StaticGroupId', sql.NVarChar(50), req.body.staticGroupId || null);
        const showGroupIdValue = req.body.showGroupIdOnIDCard === true || 
                                 req.body.showGroupIdOnIDCard === 'true' || 
                                 req.body.showGroupIdOnIDCard === 1 || 
                                 req.body.showGroupIdOnIDCard === '1' ? 1 : 0;
        console.log('💾 Saving ShowGroupIdOnIDCard:', {
            raw: req.body.showGroupIdOnIDCard,
            converted: showGroupIdValue,
            type: typeof req.body.showGroupIdOnIDCard
        });
        request.input('ShowGroupIdOnIDCard', sql.Bit, showGroupIdValue);
        request.input('SetupFee', sql.Decimal(19, 4), setupFee);

        /**
         * @deprecated Subscription IncludeProcessingFee — ignored by pricing authority.
         * Configure oe.Products.IncludeProcessingFee + tier MSRPRate instead (includedFeeDeprecation.js).
         */
        const includeProcessingFeeValue = req.body.includeProcessingFee === true ||
                                          req.body.includeProcessingFee === 'true' ||
                                          req.body.includeProcessingFee === 1 ||
                                          req.body.includeProcessingFee === '1' ? 1 : 0;
        const roundUpProcessingFeeValue = req.body.roundUpProcessingFee === true ||
                                          req.body.roundUpProcessingFee === 'true' ||
                                          req.body.roundUpProcessingFee === 1 ||
                                          req.body.roundUpProcessingFee === '1' ? 1 : 0;
        request.input('IncludeProcessingFee', sql.Bit, includeProcessingFeeValue);
        request.input('RoundUpProcessingFee', sql.Bit, roundUpProcessingFeeValue);

        // Zero processing fee for ACH payments (CC fee still applies to card payments)
        const zeroFeeForACHValue = req.body.zeroFeeForACH === true ||
                                   req.body.zeroFeeForACH === 'true' ||
                                   req.body.zeroFeeForACH === 1 ||
                                   req.body.zeroFeeForACH === '1' ? 1 : 0;
        request.input('ZeroFeeForACH', sql.Bit, zeroFeeForACHValue);

        // Custom system fee (overrides tenant member-charged system fee when enabled)
        const customSystemFeeEnabledValue = req.body.customSystemFeeEnabled === true ||
                                            req.body.customSystemFeeEnabled === 'true' ||
                                            req.body.customSystemFeeEnabled === 1 ||
                                            req.body.customSystemFeeEnabled === '1' ? 1 : 0;
        const customSystemFeeAmountRaw = req.body.customSystemFeeAmount;
        const customSystemFeeAmountValue = (customSystemFeeEnabledValue === 1 && customSystemFeeAmountRaw != null && customSystemFeeAmountRaw !== '')
          ? Math.max(0, parseFloat(customSystemFeeAmountRaw)) : null;
        request.input('CustomSystemFeeEnabled', sql.Bit, customSystemFeeEnabledValue);
        request.input('CustomSystemFeeAmount', sql.Decimal(19, 4), customSystemFeeAmountValue);
        request.input('MustBeSoldWithProductIds', sql.NVarChar(sql.MAX), mustBeSoldWithJson);

        request.input('ConfiguredBy', sql.UniqueIdentifier, userId);
        request.input('ConfiguredDate', sql.DateTime2, new Date());
        request.input('ModifiedBy', sql.UniqueIdentifier, userId);
        request.input('ModifiedDate', sql.DateTime2, new Date());
        
        const result = await request.query(`
            UPDATE oe.TenantProductSubscriptions
            SET 
                ProfitMargin = @ProfitMargin,
                StaticGroupId = @StaticGroupId,
                ShowGroupIdOnIDCard = @ShowGroupIdOnIDCard,
                SetupFee = @SetupFee,
                IncludeProcessingFee = @IncludeProcessingFee,
                RoundUpProcessingFee = @RoundUpProcessingFee,
                ZeroFeeForACH = @ZeroFeeForACH,
                CustomSystemFeeEnabled = @CustomSystemFeeEnabled,
                CustomSystemFeeAmount = @CustomSystemFeeAmount,
                MustBeSoldWithProductIds = @MustBeSoldWithProductIds,
                IsConfigured = 1,
                ConfiguredBy = @ConfiguredBy,
                ConfiguredDate = @ConfiguredDate,
                SubscriptionStatus = CASE 
                    WHEN SubscriptionStatus = 'Approved' THEN 'Active'
                    ELSE SubscriptionStatus
                END,
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE SubscriptionId = @SubscriptionId
            AND TenantId = @TenantId
            AND SubscriptionStatus IN ('Approved', 'Active')
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Subscription not found or not approved'
            });
        }
        
        // Fetch the updated subscription to return current values
        const getRequest = pool.request();
        getRequest.input('SubscriptionId', sql.UniqueIdentifier, subscriptionId);
        getRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
        
        const updatedResult = await getRequest.query(`
            SELECT 
                StaticGroupId,
                ShowGroupIdOnIDCard,
                SetupFee,
                ProfitMargin,
                IncludeProcessingFee,
                RoundUpProcessingFee,
                ZeroFeeForACH,
                CustomSystemFeeEnabled,
                CustomSystemFeeAmount,
                MustBeSoldWithProductIds
            FROM oe.TenantProductSubscriptions
            WHERE SubscriptionId = @SubscriptionId
            AND TenantId = @TenantId
        `);
        
        const updated = updatedResult.recordset[0];
        
        console.log('✅ Configuration saved:', {
            subscriptionId,
            StaticGroupId: updated?.StaticGroupId,
            ShowGroupIdOnIDCard: updated?.ShowGroupIdOnIDCard,
            SetupFee: updated?.SetupFee,
            ProfitMargin: updated?.ProfitMargin,
            IncludeProcessingFee: updated?.IncludeProcessingFee,
            RoundUpProcessingFee: updated?.RoundUpProcessingFee,
            ZeroFeeForACH: updated?.ZeroFeeForACH,
            CustomSystemFeeEnabled: updated?.CustomSystemFeeEnabled,
            CustomSystemFeeAmount: updated?.CustomSystemFeeAmount
        });
        
        res.json({
            success: true,
            message: 'Configuration saved successfully',
            data: {
                staticGroupId: updated?.StaticGroupId || null,
                showGroupIdOnIDCard: updated?.ShowGroupIdOnIDCard === true || updated?.ShowGroupIdOnIDCard === 1,
                setupFee: updated?.SetupFee || null,
                profitMargin: updated?.ProfitMargin || 0,
                includeProcessingFee: updated?.IncludeProcessingFee === true || updated?.IncludeProcessingFee === 1,
                roundUpProcessingFee: updated?.RoundUpProcessingFee === true || updated?.RoundUpProcessingFee === 1,
                zeroFeeForACH: updated?.ZeroFeeForACH === true || updated?.ZeroFeeForACH === 1,
                customSystemFeeEnabled: updated?.CustomSystemFeeEnabled === true || updated?.CustomSystemFeeEnabled === 1,
                customSystemFeeAmount: updated?.CustomSystemFeeAmount != null ? Number(updated.CustomSystemFeeAmount) : null
            }
        });
        
    } catch (error) {
        console.error('Error configuring product pricing:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to configure pricing'
        });
    }
});

/**
 * DELETE /api/tenant/products/:subscriptionId
 * Remove product subscription (unsubscribe tenant from product).
 * Blocked when the tenant owns the product.
 */
router.delete('/products/:subscriptionId', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user.TenantId;
        const userId = req.user.UserId || req.user.userId;
        const subscriptionId = req.params.subscriptionId;
        const pool = await getPool();
        const { cancelTenantProductSubscription } = require('../services/tenantProductSubscriptionCancel.service');

        const result = await cancelTenantProductSubscription(pool, sql, {
            tenantId,
            subscriptionId,
            modifiedBy: userId
        });

        if (!result.ok) {
            return res.status(result.status).json({
                success: false,
                message: result.message
            });
        }

        res.json({
            success: true,
            message: 'Subscription removed successfully'
        });
    } catch (error) {
        console.error('Error removing subscription:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove subscription'
        });
    }
});

/**
 * GET /api/tenant/configuration
 * Get tenant configuration including system fees
 */
router.get('/configuration', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user.TenantId;
        const pool = await getPool();
        
        const request = pool.request();
        request.input('TenantId', sql.UniqueIdentifier, tenantId);
        
        const result = await request.query(`
            SELECT 
                TenantId,
                Name,
                SystemFees,
                ContactEmail,
                ContactPhone,
                ContactPerson
            FROM oe.Tenants
            WHERE TenantId = @TenantId
        `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tenant configuration not found'
            });
        }
        
        const config = result.recordset[0];
        
        res.json({
            success: true,
            data: {
                tenantId: config.TenantId,
                name: config.Name,
                systemFees: config.SystemFees ? JSON.parse(config.SystemFees) : {},
                contactEmail: config.ContactEmail,
                contactPhone: config.ContactPhone,
                contactPerson: config.ContactPerson
            }
        });
        
    } catch (error) {
        console.error('Error fetching tenant configuration:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch configuration'
        });
    }
});

module.exports = router;