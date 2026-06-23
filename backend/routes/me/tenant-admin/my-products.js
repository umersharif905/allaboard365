// File: backend/routes/me/tenant-admin/my-products.js

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const { v4: uuidv4 } = require('uuid');
const { authenticateProductUrls } = require('../../uploads');
const { MAX_UPLOAD_FILE_BYTES } = require('../../../constants/uploadLimits');
const { loadWizardPricingTiersForProduct } = require('../../../services/migration/productWizardTemplate.service');

const DEFAULT_SYSTEM_FEES = {
    platformFee: { name: "Platform Fee", amount: 2.5, type: "fixed" },
    transactionFee: { name: "Transaction Fee", amount: 0.5, type: "fixed" },
    processingFee: { name: "Processing Fee", amount: 1.0, type: "fixed" }
};

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_FILE_BYTES,
    files: 5 // Maximum 5 files
  },
  fileFilter: (req, file, cb) => {
    // Allow all file types for now
    cb(null, true);
  }
});

/**
 * GET /api/me/tenant-admin/my-products
 * Get all products for the current tenant (owned + subscribed)
 * Query params:
 *   - filter=all|owned|subscribed (default: all)
 */
router.get('/', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        // CRITICAL: Use req.tenantId directly (set by requireTenantAccess middleware)
        // This respects tenant switching and is the source of truth
        if (!req.tenantId) {
            console.error('❌ GET /api/me/tenant-admin/my-products - req.tenantId not set by middleware');
            return res.status(400).json({
                success: false,
                message: 'Tenant ID is required. Middleware should have set req.tenantId.'
            });
        }
        
        // CRITICAL: Use req.tenantId directly (set by requireTenantAccess middleware)
        // Check if tenantId was overwritten (compare with original)
        if (req._originalTenantId && req.tenantId !== req._originalTenantId) {
            console.error(`🚨 CRITICAL ERROR: req.tenantId was overwritten! Original: ${req._originalTenantId}, Current: ${req.tenantId}`);
            // Restore the correct tenant ID
            req.tenantId = req._originalTenantId;
            req.user.TenantId = req._originalTenantId;
        }
        
        // CRITICAL: Final check - if tenantName doesn't match tenantId, query the correct tenant ID
        // This is a workaround for the mismatch issue where req.tenantName is correct but req.tenantId is wrong
        if (req.tenantName && req.tenantId) {
            const pool = await getPool();
            const tenantCheckRequest = pool.request();
            tenantCheckRequest.input('tenantName', sql.NVarChar(200), req.tenantName);
            const tenantCheckResult = await tenantCheckRequest.query(`
                SELECT TenantId, Name
                FROM oe.Tenants
                WHERE Name = @tenantName AND Status = 'Active'
            `);
            
            if (tenantCheckResult.recordset.length > 0) {
                const correctTenantId = tenantCheckResult.recordset[0].TenantId;
                if (req.tenantId !== correctTenantId) {
                    console.error(`🚨 CRITICAL MISMATCH: tenantName "${req.tenantName}" maps to tenantId ${correctTenantId}, but req.tenantId is ${req.tenantId}`);
                    console.log(`🔧 FORCING tenantId to ${correctTenantId} based on tenantName lookup`);
                    req.tenantId = correctTenantId;
                    req.user.TenantId = correctTenantId;
                }
            }
        }
        
        const tenantId = req.tenantId; // Use the tenant ID set by middleware (no fallback)
        
        // CRITICAL: Log all tenant ID sources to debug tenant switching
        console.log('🔍 GET /api/me/tenant-admin/my-products - Fetching products for tenant:', {
            userId: req.user?.UserId,
            userRoles: req.user?.roles,
            currentRole: req.user?.currentRole,
            tenantId: tenantId,
            reqTenantId: req.tenantId,
            userTenantId: req.user?.TenantId,
            filter: req.query.filter,
            tenantName: req.tenantName,
            originalTenantId: req._originalTenantId,
            'ALL_HEADERS_WITH_TENANT': Object.keys(req.headers).filter(k => k.toLowerCase().includes('tenant')).map(k => ({ [k]: req.headers[k] })),
            'x-current-tenant-id_header': req.headers['x-current-tenant-id'] || req.headers['X-Current-Tenant-Id']
        });
        
        // CRITICAL: Verify we're using the correct tenant ID
        if (req.tenantId !== tenantId) {
            console.error(`🚨 CRITICAL: req.tenantId (${req.tenantId}) !== tenantId variable (${tenantId})`);
        }
        const filter = req.query.filter || 'all'; // 'all', 'owned', 'subscribed'
        const pool = await getPool();
        
        const allProducts = [];
        
        // Get owned products if filter is 'all' or 'owned'
        if (filter === 'all' || filter === 'owned') {
            console.log(`🔍 Querying owned products with tenantId: ${tenantId} (req.tenantId: ${req.tenantId}, req.user.TenantId: ${req.user?.TenantId})`);
            const ownedRequest = pool.request();
            ownedRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
            
            const ownedResult = await ownedRequest.query(`
                SELECT 
                    p.ProductId,
                    p.Name,
                    p.Description,
                    p.ProductType,
                    p.Status,
                    p.IsBundle,
                    p.IsHidden,
                    p.SalesType,
                    p.RequiredDataFields,
                    p.ProductImageUrl,
                    p.ProductLogoUrl,
                    p.ProductDocumentUrl,
                    p.ProductOwnerId,
                    v.VendorName,
                    p.CreatedDate,
                    p.ModifiedDate,
                    -- Get subscription count (excluding owner's own subscription)
                    ISNULL(COUNT(DISTINCT CASE WHEN tps.TenantId != @TenantId THEN tps.SubscriptionId END), 0) as SubscriptionCount,
                    -- Get owner's own subscription SetupFee
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN tps.SetupFee END) as SetupFee,
                    -- Get owner's own subscription Group ID settings (owners are auto-subscribed)
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN tps.StaticGroupId END) as StaticGroupId,
                    -- SQL Server doesn't allow MAX() over BIT; cast to INT first
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN CAST(tps.ShowGroupIdOnIDCard AS INT) END) as ShowGroupIdOnIDCard,
                    -- Processing fee inclusion settings (owners are auto-subscribed)
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN CAST(tps.IncludeProcessingFee AS INT) END) as IncludeProcessingFee,
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN CAST(tps.RoundUpProcessingFee AS INT) END) as RoundUpProcessingFee,
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN CAST(tps.ZeroFeeForACH AS INT) END) as ZeroFeeForACH,
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN CAST(tps.CustomSystemFeeEnabled AS INT) END) as CustomSystemFeeEnabled,
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN tps.CustomSystemFeeAmount END) as CustomSystemFeeAmount,
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN tps.MustBeSoldWithProductIds END) as MustBeSoldWithProductIds,
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN tps.SubscriptionId END) as SubscriptionId,
                    MAX(CASE WHEN tps.TenantId = @TenantId THEN tps.SubscriptionStatus END) as SubscriptionStatus,
                    (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.ProductId = p.ProductId) as EnrollmentCount,
                    'owner' as OwnershipType
                FROM oe.Products p
                LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
                LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId AND tps.SubscriptionStatus IN ('Active', 'Approved', 'Pending')
                WHERE p.ProductOwnerId = @TenantId
                GROUP BY 
                    p.ProductId, p.Name, p.Description, p.ProductType, p.Status, p.IsBundle, p.IsHidden, p.SalesType, p.RequiredDataFields,
                    p.ProductImageUrl, p.ProductLogoUrl, p.ProductDocumentUrl, p.ProductOwnerId,
                    p.CreatedDate, p.ModifiedDate, v.VendorName
                ORDER BY p.CreatedDate DESC
            `);
            
            // Get current tenant info for owned products
            const tenantInfoRequest = pool.request();
            tenantInfoRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
            const tenantInfo = await tenantInfoRequest.query(`
                SELECT Name, ContactEmail, ContactPhone, ContactPerson
                FROM oe.Tenants
                WHERE TenantId = @TenantId
            `);
            
            const currentTenant = tenantInfo.recordset[0] || {};
            
            // Process owned products with bundle data
            for (const product of ownedResult.recordset) {
                const baseProduct = {
                    ProductId: product.ProductId,
                    Name: product.Name,
                    Description: product.Description,
                    ProductType: product.ProductType,
                    Status: product.Status,
                    IsBundle: product.IsBundle,
                    IsHidden: product.IsHidden,
                    SalesType: product.SalesType,
                    RequiredDataFields: product.RequiredDataFields ? (() => { try { return typeof product.RequiredDataFields === 'string' ? JSON.parse(product.RequiredDataFields) : product.RequiredDataFields; } catch { return []; } })() : [],
                    ProductImageUrl: product.ProductImageUrl,
                    ProductLogoUrl: product.ProductLogoUrl,
                    ProductDocumentUrl: product.ProductDocumentUrl,
                    ProductOwnerId: product.ProductOwnerId,
                    vendorName: product.VendorName || null,
                    productOwner: {
                        tenantName: currentTenant.Name || 'Unknown',
                        contactEmail: currentTenant.ContactEmail,
                        contactPhone: currentTenant.ContactPhone,
                        contactPerson: currentTenant.ContactPerson
                    },
                    CreatedDate: product.CreatedDate,
                    ModifiedDate: product.ModifiedDate,
                    SubscriptionCount: product.SubscriptionCount,
                    enrollmentCount: product.EnrollmentCount || 0,
                    canDelete: (product.EnrollmentCount || 0) === 0,
                    // Include subscription data for owner's own subscription (owners are auto-subscribed)
                    subscriptionId: product.SubscriptionId || null,
                    subscriptionStatus: product.SubscriptionStatus || 'Active', // Default to Active for owners
                    setupFee: product.SetupFee !== null && product.SetupFee !== undefined ? parseFloat(product.SetupFee) : null,
                    staticGroupId: product.StaticGroupId || null,
                    showGroupIdOnIDCard: product.ShowGroupIdOnIDCard === true || product.ShowGroupIdOnIDCard === 1 || product.ShowGroupIdOnIDCard === 'true' || product.ShowGroupIdOnIDCard === '1',
                    /** @deprecated Subscription include — ignored by pricing; use product wizard + MSRPRate */
                    includeProcessingFee: product.IncludeProcessingFee === true || product.IncludeProcessingFee === 1,
                    roundUpProcessingFee: product.RoundUpProcessingFee === true || product.RoundUpProcessingFee === 1,
                    zeroFeeForACH: product.ZeroFeeForACH === true || product.ZeroFeeForACH === 1,
                    customSystemFeeEnabled: product.CustomSystemFeeEnabled === true || product.CustomSystemFeeEnabled === 1,
                    customSystemFeeAmount: product.CustomSystemFeeAmount != null ? parseFloat(product.CustomSystemFeeAmount) : null,
                    mustBeSoldWithProductIds: product.MustBeSoldWithProductIds ? (() => { try { return JSON.parse(product.MustBeSoldWithProductIds); } catch { return []; } })() : [],
                    mustBeSoldWithProductNames: [],
                    ownershipType: 'owner',
                    bundleProducts: []
                };
                
                // If bundle, get included products
                if (product.IsBundle) {
                    try {
                        const bundleRequest = pool.request();
                        bundleRequest.input('BundleProductId', sql.UniqueIdentifier, product.ProductId);
                        
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
                                p.RequiredDataFields,
                                v.VendorName
                            FROM oe.ProductBundles pb
                            INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
                            WHERE pb.BundleProductId = @BundleProductId
                              AND pb.IncludedProductId != pb.BundleProductId
                              AND p.Status = 'Active'
                            ORDER BY pb.SortOrder
                        `);
                        
                        baseProduct.bundleProducts = bundleResult.recordset.map(bp => ({
                            productId: bp.IncludedProductId,
                            name: bp.ProductName,
                            description: bp.Description,
                            productType: bp.ProductType,
                            sortOrder: bp.SortOrder,
                            isRequired: bp.IsRequired,
                            hidePricing: bp.HidePricing ?? false,
                            linkedToProductId: bp.HidePricing ? bp.LinkedToProductId || null : null,
                            vendorName: bp.VendorName || null,
                            requiredDataFields: bp.RequiredDataFields ? (() => { try { return typeof bp.RequiredDataFields === 'string' ? JSON.parse(bp.RequiredDataFields) : bp.RequiredDataFields; } catch { return []; } })() : []
                        }));
                    } catch (bundleError) {
                        console.error('Error fetching bundle products:', bundleError);
                        baseProduct.bundleProducts = [];
                    }
                }
                
                allProducts.push(baseProduct);
            }
            
            console.log(`✅ Found ${ownedResult.recordset.length} products owned by tenant ${tenantId} (req.tenantId: ${req.tenantId}, used tenantId: ${tenantId})`);
            // Debug: Show first product's owner if any found
            if (ownedResult.recordset.length > 0) {
                console.log(`🔍 First product owner check: ProductId=${ownedResult.recordset[0].ProductId}, ProductOwnerId=${ownedResult.recordset[0].ProductOwnerId}`);
            }
        }
        
        // Get subscribed products if filter is 'all' or 'subscribed'
        if (filter === 'all' || filter === 'subscribed') {
            console.log(`🔍 Querying subscribed products with tenantId: ${tenantId} (req.tenantId: ${req.tenantId}, req.user.TenantId: ${req.user?.TenantId})`);
            const subscribedRequest = pool.request();
            subscribedRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
            
            const subscribedResult = await subscribedRequest.query(`
                SELECT 
                    tps.SubscriptionId,
                    tps.RequestId,
                    p.ProductId,
                    p.Name,
                    p.Description,
                    p.ProductType,
                    p.Status,
                    p.IsBundle,
                    p.IsHidden,
                    p.SalesType,
                    p.RequiredDataFields,
                    p.ProductImageUrl,
                    p.ProductLogoUrl,
                    p.ProductDocumentUrl,
                    p.ProductOwnerId,
                    v.VendorName,
                    t.Name as ProductOwnerName,
                    t.ContactEmail as ProductOwnerEmail,
                    t.ContactPhone as ProductOwnerPhone,
                    t.ContactPerson as ProductOwnerContact,
                    tps.TenantRate,
                    tps.ProfitMargin,
                    tps.SystemFeesSnapshot,
                    tps.SalePrice,
                    tps.SetupFee,
                    tps.SubscriptionStatus,
                    tps.IsConfigured,
                    tps.SubscriptionDate,
                    tps.ModifiedDate,
                    tps.StaticGroupId,
                    tps.ShowGroupIdOnIDCard,
                    tps.IncludeProcessingFee,
                    tps.RoundUpProcessingFee,
                    tps.ZeroFeeForACH,
                    tps.CustomSystemFeeEnabled,
                    tps.CustomSystemFeeAmount,
                    tps.MustBeSoldWithProductIds,
                    psr.RequestedDiscount,
                    psr.ApprovedDiscount,
                    psr.DiscountType,
                    psr.TierDiscounts,
                    psr.Notes as RequestMessage,
                    psr.ProcessingNotes as ResponseMessage,
                    psr.RequestDate,
                    psr.ProcessedDate as ResponseDate,
                    'subscriber' as OwnershipType
                FROM oe.TenantProductSubscriptions tps
                INNER JOIN oe.Products p ON tps.ProductId = p.ProductId
                LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
                LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
                LEFT JOIN oe.ProductSubscriptionRequests psr ON tps.RequestId = psr.RequestId
                -- Exclude "bundle-included" subscription records from the main list (use NOT EXISTS to avoid row multiplication).
                -- If we LEFT JOIN ProductBundles on IncludedProductId, a product in multiple bundles would appear multiple times.
                WHERE tps.TenantId = @TenantId
                AND tps.SubscriptionStatus != 'Cancelled'
                AND p.Status = 'Active'
                -- Exclude products owned by this tenant (to avoid duplicates)
                AND p.ProductOwnerId != @TenantId
                -- If this subscription is an included product for a subscribed bundle (same RequestId), hide it from the list
                AND NOT EXISTS (
                    SELECT 1
                    FROM oe.ProductBundles pb2
                    INNER JOIN oe.TenantProductSubscriptions btps2
                      ON btps2.ProductId = pb2.BundleProductId
                     AND btps2.TenantId = @TenantId
                     AND btps2.SubscriptionStatus != 'Cancelled'
                     AND (tps.RequestId IS NULL OR btps2.RequestId = tps.RequestId)
                    WHERE pb2.IncludedProductId = tps.ProductId
                )
                ORDER BY tps.SubscriptionDate DESC
            `);
            
            // Process subscribed products with bundle data
            for (const product of subscribedResult.recordset) {
                const baseProduct = {
                    subscriptionId: product.SubscriptionId,
                    requestId: product.RequestId || null,
                    ProductId: product.ProductId,
                    Name: product.Name,
                    Description: product.Description,
                    ProductType: product.ProductType,
                    Status: product.Status,
                    IsBundle: product.IsBundle,
                    IsHidden: product.IsHidden,
                    SalesType: product.SalesType,
                    RequiredDataFields: product.RequiredDataFields ? (() => { try { return typeof product.RequiredDataFields === 'string' ? JSON.parse(product.RequiredDataFields) : product.RequiredDataFields; } catch { return []; } })() : [],
                    ProductImageUrl: product.ProductImageUrl,
                    ProductLogoUrl: product.ProductLogoUrl,
                    ProductDocumentUrl: product.ProductDocumentUrl,
                    ProductOwnerId: product.ProductOwnerId,
                    vendorName: product.VendorName || null,
                    productOwner: {
                        tenantName: product.ProductOwnerName,
                        contactEmail: product.ProductOwnerEmail,
                        contactPhone: product.ProductOwnerPhone,
                        contactPerson: product.ProductOwnerContact
                    },
                    subscriptionStatus: product.SubscriptionStatus,
                    requestedDiscount: product.RequestedDiscount,
                    approvedDiscount: product.ApprovedDiscount,
                    discountType: product.DiscountType,
                    tierDiscounts: product.TierDiscounts ? JSON.parse(product.TierDiscounts) : null,
                    tenantRate: product.TenantRate,
                    profitMargin: product.ProfitMargin,
                    systemFees: product.SystemFeesSnapshot ? JSON.parse(product.SystemFeesSnapshot) : null,
                    salePrice: product.SalePrice,
                    setupFee: product.SetupFee !== null && product.SetupFee !== undefined ? parseFloat(product.SetupFee) : null,
                    requestMessage: product.RequestMessage,
                    responseMessage: product.ResponseMessage,
                    requestDate: product.RequestDate,
                    responseDate: product.ResponseDate,
                    isConfigured: product.IsConfigured,
                    CreatedDate: product.SubscriptionDate,
                    ModifiedDate: product.ModifiedDate,
                    ownershipType: 'subscriber',
                    bundleProducts: [],
                    staticGroupId: product.StaticGroupId || null,
                    showGroupIdOnIDCard: product.ShowGroupIdOnIDCard === true || product.ShowGroupIdOnIDCard === 1 || product.ShowGroupIdOnIDCard === 'true' || product.ShowGroupIdOnIDCard === '1',
                    /** @deprecated Subscription include — ignored by pricing; use product wizard + MSRPRate */
                    includeProcessingFee: product.IncludeProcessingFee === true || product.IncludeProcessingFee === 1,
                    roundUpProcessingFee: product.RoundUpProcessingFee === true || product.RoundUpProcessingFee === 1,
                    zeroFeeForACH: product.ZeroFeeForACH === true || product.ZeroFeeForACH === 1,
                    customSystemFeeEnabled: product.CustomSystemFeeEnabled === true || product.CustomSystemFeeEnabled === 1,
                    customSystemFeeAmount: product.CustomSystemFeeAmount != null ? parseFloat(product.CustomSystemFeeAmount) : null,
                    mustBeSoldWithProductIds: product.MustBeSoldWithProductIds ? (() => { try { return JSON.parse(product.MustBeSoldWithProductIds); } catch { return []; } })() : [],
                    mustBeSoldWithProductNames: []
                };
                
                // If bundle, get included products
                if (product.IsBundle) {
                    try {
                        const bundleRequest = pool.request();
                        bundleRequest.input('BundleProductId', sql.UniqueIdentifier, product.ProductId);
                        bundleRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
                        bundleRequest.input('RequestId', sql.UniqueIdentifier, product.RequestId || null);
                        
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
                                p.RequiredDataFields,
                                v.VendorName,
                                tps.SubscriptionId as IncludedSubscriptionId,
                                tps.SubscriptionStatus as IncludedSubscriptionStatus,
                                tps.TenantRate as IncludedTenantRate,
                                tps.ProfitMargin as IncludedProfitMargin,
                                tps.SystemFeesSnapshot as IncludedSystemFeesSnapshot,
                                tps.SetupFee as IncludedSetupFee,
                                tps.IsConfigured as IncludedIsConfigured,
                                tps.StaticGroupId as IncludedStaticGroupId,
                                tps.ShowGroupIdOnIDCard as IncludedShowGroupIdOnIDCard,
                                tps.IncludeProcessingFee as IncludedIncludeProcessingFee,
                                tps.RoundUpProcessingFee as IncludedRoundUpProcessingFee,
                                tps.ZeroFeeForACH as IncludedZeroFeeForACH,
                                tps.CustomSystemFeeEnabled as IncludedCustomSystemFeeEnabled,
                                tps.CustomSystemFeeAmount as IncludedCustomSystemFeeAmount
                            FROM oe.ProductBundles pb
                            INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
                            LEFT JOIN oe.TenantProductSubscriptions tps 
                              ON tps.ProductId = pb.IncludedProductId
                             AND tps.TenantId = @TenantId
                             AND tps.SubscriptionStatus != 'Cancelled'
                             AND (
                               (@RequestId IS NOT NULL AND tps.RequestId = @RequestId)
                               OR @RequestId IS NULL
                             )
                            WHERE pb.BundleProductId = @BundleProductId
                              AND pb.IncludedProductId != pb.BundleProductId
                              AND p.Status = 'Active'
                            ORDER BY pb.SortOrder
                        `);
                        
                        baseProduct.bundleProducts = bundleResult.recordset.map(bp => ({
                            productId: bp.IncludedProductId,
                            name: bp.ProductName,
                            description: bp.Description,
                            productType: bp.ProductType,
                            sortOrder: bp.SortOrder,
                            isRequired: bp.IsRequired,
                            hidePricing: bp.HidePricing ?? false,
                            linkedToProductId: bp.HidePricing ? bp.LinkedToProductId || null : null,
                            vendorName: bp.VendorName || null,
                            requiredDataFields: bp.RequiredDataFields ? (() => { try { return typeof bp.RequiredDataFields === 'string' ? JSON.parse(bp.RequiredDataFields) : bp.RequiredDataFields; } catch { return []; } })() : [],
                            // Included product subscription config (for Configure Bundle modal)
                            subscriptionId: bp.IncludedSubscriptionId || null,
                            subscriptionStatus: bp.IncludedSubscriptionStatus || null,
                            tenantRate: bp.IncludedTenantRate !== null && bp.IncludedTenantRate !== undefined ? parseFloat(bp.IncludedTenantRate) : 0,
                            profitMargin: bp.IncludedProfitMargin !== null && bp.IncludedProfitMargin !== undefined ? parseFloat(bp.IncludedProfitMargin) : 0,
                            systemFees: bp.IncludedSystemFeesSnapshot ? JSON.parse(bp.IncludedSystemFeesSnapshot) : null,
                            setupFee: bp.IncludedSetupFee !== null && bp.IncludedSetupFee !== undefined ? parseFloat(bp.IncludedSetupFee) : null,
                            isConfigured: bp.IncludedIsConfigured === true || bp.IncludedIsConfigured === 1,
                            staticGroupId: bp.IncludedStaticGroupId || null,
                            showGroupIdOnIDCard: bp.IncludedShowGroupIdOnIDCard === true || bp.IncludedShowGroupIdOnIDCard === 1 || bp.IncludedShowGroupIdOnIDCard === 'true' || bp.IncludedShowGroupIdOnIDCard === '1',
                            includeProcessingFee: bp.IncludedIncludeProcessingFee === true || bp.IncludedIncludeProcessingFee === 1,
                            roundUpProcessingFee: bp.IncludedRoundUpProcessingFee === true || bp.IncludedRoundUpProcessingFee === 1,
                            zeroFeeForACH: bp.IncludedZeroFeeForACH === true || bp.IncludedZeroFeeForACH === 1,
                            customSystemFeeEnabled: bp.IncludedCustomSystemFeeEnabled === true || bp.IncludedCustomSystemFeeEnabled === 1,
                            customSystemFeeAmount: bp.IncludedCustomSystemFeeAmount != null ? parseFloat(bp.IncludedCustomSystemFeeAmount) : null
                        }));
                    } catch (bundleError) {
                        console.error('Error fetching bundle products:', bundleError);
                        baseProduct.bundleProducts = [];
                    }
                }
                
                allProducts.push(baseProduct);
            }
            
            // Resolve mustBeSoldWith product names (batch)
            const mustBeSoldWithIds = [...new Set(allProducts.filter(p => p.mustBeSoldWithProductIds?.length).flatMap(p => p.mustBeSoldWithProductIds))];
            let nameMap = new Map();
            if (mustBeSoldWithIds.length > 0) {
                try {
                    const placeholders = mustBeSoldWithIds.map((_, i) => `@id${i}`).join(',');
                    const nameReq = pool.request();
                    mustBeSoldWithIds.forEach((id, i) => nameReq.input(`id${i}`, sql.UniqueIdentifier, id));
                    const nameResult = await nameReq.query(`
                        SELECT ProductId, Name FROM oe.Products WHERE ProductId IN (${placeholders})
                    `);
                    nameResult.recordset.forEach(r => nameMap.set(r.ProductId?.toString?.(), r.Name));
                } catch (e) {
                    console.warn('Failed to resolve mustBeSoldWith product names:', e);
                }
                allProducts.filter(p => p.mustBeSoldWithProductIds?.length).forEach(p => {
                    p.mustBeSoldWithProductNames = p.mustBeSoldWithProductIds.map(id => nameMap.get(id) || id);
                });
            }
            
            console.log(`✅ Found ${subscribedResult.recordset.length} subscribed products for tenant ${tenantId} (req.tenantId: ${req.tenantId}, used tenantId: ${tenantId})`);
        }
        
        console.log(`✅ Total products: ${allProducts.length} (filter: ${filter})`);
        
        res.json({
            success: true,
            data: allProducts
        });

    } catch (error) {
        console.error('❌ Error fetching tenant products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch products',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * GET /api/me/tenant-admin/my-products/:productId/pricing-export
 * Export pricing tiers for a product owned by the current tenant as an XLSX file.
 * Must be registered BEFORE the /:productId route so Express doesn't swallow it.
 */
router.get('/:productId/pricing-export', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { productId } = req.params;
        const tenantId = req.tenantId || req.user?.TenantId;

        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'Tenant ID is required' });
        }

        const { buildPricingWorkbook } = require('../../../services/pricing/pricingExport.service');
        const result = await buildPricingWorkbook(productId, tenantId);

        if (result.error === 'not_found') {
            return res.status(404).json({ success: false, message: 'Product not found or access denied' });
        }
        if (result.error === 'no_tiers') {
            return res.status(400).json({ success: false, message: 'Product has no active pricing tiers' });
        }

        const safeName = (result.productName || 'product')
            .replace(/[^\w\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .toLowerCase();

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="pricing-${safeName}.xlsx"`);
        return res.send(result.buffer);
    } catch (error) {
        console.error('❌ Error exporting pricing:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to export pricing',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * GET /api/me/tenant-admin/my-products/:productId
 * Get full details for a single product owned by the current tenant
 */
router.get('/:productId', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { productId } = req.params;
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Tenant ID is required'
            });
        }
        
        const pool = await getPool();

        const productRequest = pool.request();
        productRequest.input('ProductId', sql.UniqueIdentifier, productId);
        productRequest.input('TenantId', sql.UniqueIdentifier, tenantId);

        const productResult = await productRequest.query(`
            SELECT *
            FROM oe.Products
            WHERE ProductId = @ProductId AND ProductOwnerId = @TenantId
        `);

        if (productResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        let product = productResult.recordset[0];
        product = await authenticateProductUrls(product, ['ProductImageUrl', 'ProductLogoUrl', 'ProductDocumentUrl']);

        // Wizard edit needs grouped pricing tiers (same shape as GET /api/products/:id)
        product.PricingTiers = await loadWizardPricingTiersForProduct(pool, productId);

        const chunksResult = await pool.request()
            .input('ProductId', sql.UniqueIdentifier, productId)
            .query(`
                SELECT
                    AIChunkId AS id,
                    ChunkText AS chunk_text,
                    CreatedDate AS created_at
                FROM oe.AIChunks
                WHERE ProductId = @ProductId
                  AND Status = 'Active'
                ORDER BY CreatedDate
            `);
        product.AIChunks = chunksResult.recordset || [];

        res.json({
            success: true,
            product
        });
    } catch (error) {
        console.error('❌ Error fetching tenant product details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch product details',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * POST /api/me/tenant-admin/my-products
 * Create a new product owned by the current tenant
 */
router.post('/', authenticate, authorize(['TenantAdmin']), requireTenantAccess, upload.fields([
    { name: 'productImageFile', maxCount: 1 },
    { name: 'productLogoFile', maxCount: 1 },
    { name: 'productDocumentFile', maxCount: 1 },
    { name: 'idCardLogoFile', maxCount: 1 },
    { name: 'planDetailsHeaderLogoFile', maxCount: 1 }
]), async (req, res) => {
    try {
        console.log('🆕 Creating new tenant product');
        console.log('📦 Request body:', req.body);
        console.log('📁 Request files:', req.files);
        
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Tenant ID is required'
            });
        }
        
        const pool = await getPool();
        
        const {
            name,
            description,
            productType,
            salesType,
            isBundle,
            bundleProducts,
            minAge,
            maxAge,
            allowedStates,
            requiresTobaccoInfo,
            effectiveDateLogic,
            maxEffectiveDateDays,
            terminationLogic,
            requiredLicenses,
            configurationFields,
            pricingTiers,
            productImageUrl,
            productLogoUrl,
            productDocumentUrl,
            acknowledgementQuestions,
            productQuestionnaires,
            idCardData,
            planDetailsData,
            aiChunks,
            requiredASA,
            isSSNRequired
        } = req.body;

        // Parse JSON fields that come as strings from FormData
        let parsedAiChunks = [];
        if (aiChunks) {
            try {
                parsedAiChunks = typeof aiChunks === 'string' ? JSON.parse(aiChunks) : aiChunks;
            } catch (error) {
                console.error('❌ Error parsing aiChunks:', error);
                parsedAiChunks = [];
            }
        }

        let parsedBundleProducts = [];
        if (bundleProducts) {
            try {
                parsedBundleProducts = typeof bundleProducts === 'string' ? JSON.parse(bundleProducts) : bundleProducts;
            } catch (error) {
                console.error('❌ Error parsing bundleProducts:', error);
                parsedBundleProducts = [];
            }
        }

        let parsedConfigurationFields = [];
        if (configurationFields) {
            try {
                parsedConfigurationFields = typeof configurationFields === 'string' ? JSON.parse(configurationFields) : configurationFields;
            } catch (error) {
                console.error('❌ Error parsing configurationFields:', error);
                parsedConfigurationFields = [];
            }
        }

        let parsedPricingTiers = [];
        if (pricingTiers) {
            try {
                parsedPricingTiers = typeof pricingTiers === 'string' ? JSON.parse(pricingTiers) : pricingTiers;
            } catch (error) {
                console.error('❌ Error parsing pricingTiers:', error);
                parsedPricingTiers = [];
            }
        }

        let parsedAcknowledgementQuestions = [];
        if (acknowledgementQuestions) {
            try {
                parsedAcknowledgementQuestions = typeof acknowledgementQuestions === 'string' ? JSON.parse(acknowledgementQuestions) : acknowledgementQuestions;
            } catch (error) {
                console.error('❌ Error parsing acknowledgementQuestions:', error);
                parsedAcknowledgementQuestions = [];
            }
        }

        let parsedProductQuestionnaires = null;
        if (productQuestionnaires) {
            try {
                parsedProductQuestionnaires = typeof productQuestionnaires === 'string' ? JSON.parse(productQuestionnaires) : productQuestionnaires;
            } catch (error) {
                console.error('❌ Error parsing productQuestionnaires:', error);
                parsedProductQuestionnaires = null;
            }
        }

        let parsedIdCardData = {};
        if (idCardData) {
            try {
                parsedIdCardData = typeof idCardData === 'string' ? JSON.parse(idCardData) : idCardData;
            } catch (error) {
                console.error('❌ Error parsing idCardData:', error);
                parsedIdCardData = {};
            }
        }

        let parsedPlanDetailsData = {};
        if (planDetailsData) {
            try {
                parsedPlanDetailsData = typeof planDetailsData === 'string' ? JSON.parse(planDetailsData) : planDetailsData;
            } catch (error) {
                console.error('❌ Error parsing planDetailsData:', error);
                parsedPlanDetailsData = {};
            }
        }

        let parsedAllowedStates = [];
        if (allowedStates) {
            try {
                parsedAllowedStates = typeof allowedStates === 'string' ? JSON.parse(allowedStates) : allowedStates;
            } catch (error) {
                console.error('❌ Error parsing allowedStates:', error);
                parsedAllowedStates = [];
            }
        }

        let parsedRequiredLicenses = [];
        if (requiredLicenses) {
            try {
                parsedRequiredLicenses = typeof requiredLicenses === 'string' ? JSON.parse(requiredLicenses) : requiredLicenses;
            } catch (error) {
                console.error('❌ Error parsing requiredLicenses:', error);
                parsedRequiredLicenses = [];
            }
        }

        // Validation
        if (!name || !description || !productType) {
            return res.status(400).json({
                success: false,
                message: 'Name, description, and product type are required'
            });
        }

        // Generate product ID
        const productId = uuidv4();

        // TODO: Handle file uploads to Azure Blob Storage
        // For now, we'll use the provided URLs or empty strings
        const finalProductImageUrl = productImageUrl || null;
        const finalProductLogoUrl = productLogoUrl || null;
        const finalProductDocumentUrl = productDocumentUrl || null;

        // Create the product
        const insertQuery = `
            INSERT INTO oe.Products (
                ProductId, Name, Description, ProductType, SalesType, ProductOwnerId,
                IsBundle, MinAge, MaxAge, AllowedStates, RequiresTobaccoInfo,
                EffectiveDateLogic, MaxEffectiveDateDays, TerminationLogic, RequiredLicenses,
                ConfigurationFields, PricingTiers, AcknowledgementQuestions, ProductQuestionnaires,
                ProductImageUrl, ProductLogoUrl, ProductDocumentUrl,
                IdCardData, PlanDetailsData, AIChunks, RequiredASA, IsSSNRequired,
                Status, IsMarketplaceProduct, IsPublic, CreatedBy, ModifiedBy
            ) VALUES (
                @productId, @name, @description, @productType, @salesType, @productOwnerId,
                @isBundle, @minAge, @maxAge, @allowedStates, @requiresTobaccoInfo,
                @effectiveDateLogic, @maxEffectiveDateDays, @terminationLogic, @requiredLicenses,
                @configurationFields, @pricingTiers, @acknowledgementQuestions, @productQuestionnaires,
                @productImageUrl, @productLogoUrl, @productDocumentUrl,
                @idCardData, @planDetailsData, @aiChunks, @requiredASA, @isSSNRequired,
                @status, @isMarketplaceProduct, @isPublic, @createdBy, @modifiedBy
            )
        `;

        await pool.request()
            .input('productId', sql.UniqueIdentifier, productId)
            .input('name', sql.NVarChar, name)
            .input('description', sql.NVarChar, description)
            .input('productType', sql.NVarChar, productType)
            .input('salesType', sql.NVarChar, salesType || 'Both')
            .input('productOwnerId', sql.UniqueIdentifier, tenantId)
            .input('isBundle', sql.Bit, isBundle === 'true' || isBundle === true)
            .input('minAge', sql.Int, parseInt(minAge) || 18)
            .input('maxAge', sql.Int, parseInt(maxAge) || 65)
            .input('allowedStates', sql.NVarChar, JSON.stringify(parsedAllowedStates))
            .input('requiresTobaccoInfo', sql.Bit, requiresTobaccoInfo === 'true' || requiresTobaccoInfo === true)
            .input('effectiveDateLogic', sql.NVarChar, effectiveDateLogic || 'FirstOfMonth')
            .input('maxEffectiveDateDays', sql.Int, parseInt(maxEffectiveDateDays) || 60)
            .input('terminationLogic', sql.NVarChar, terminationLogic || '')
            .input('requiredLicenses', sql.NVarChar, JSON.stringify(parsedRequiredLicenses))
            .input('configurationFields', sql.NVarChar, JSON.stringify(parsedConfigurationFields))
            .input('pricingTiers', sql.NVarChar, JSON.stringify(parsedPricingTiers))
            .input('acknowledgementQuestions', sql.NVarChar, JSON.stringify(parsedAcknowledgementQuestions))
            .input('productQuestionnaires', sql.NVarChar, parsedProductQuestionnaires ? JSON.stringify(parsedProductQuestionnaires) : null)
            .input('productImageUrl', sql.NVarChar, finalProductImageUrl)
            .input('productLogoUrl', sql.NVarChar, finalProductLogoUrl)
            .input('productDocumentUrl', sql.NVarChar, finalProductDocumentUrl)
            .input('idCardData', sql.NVarChar, JSON.stringify(parsedIdCardData))
            .input('planDetailsData', sql.NVarChar, JSON.stringify(parsedPlanDetailsData))
            .input('aiChunks', sql.NVarChar, JSON.stringify(parsedAiChunks))
            .input('requiredASA', sql.Bit, requiredASA === 'true' || requiredASA === true)
            .input('isSSNRequired', sql.Bit, isSSNRequired === 'true' || isSSNRequired === true || isSSNRequired === 1)
            .input('status', sql.NVarChar, 'Active')
            .input('isMarketplaceProduct', sql.Bit, 0) // Tenant products are not marketplace products
            .input('isPublic', sql.Bit, 1) // Tenant products are public to their organization
            .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
            .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
            .query(insertQuery);

        console.log(`✅ Created product: ${productId}`);

        // Auto-subscribe tenant to their own product
        const subscriptionId = uuidv4();
        
        // Get tenant's system fees
        const systemFeesRequest = pool.request();
        systemFeesRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const tenantResult = await systemFeesRequest.query(`
            SELECT SystemFees FROM oe.Tenants WHERE TenantId = @tenantId
        `);
        
        const rawSystemFees = tenantResult.recordset[0]?.SystemFees;
        const systemFees = typeof rawSystemFees === 'string'
            ? rawSystemFees
            : JSON.stringify(rawSystemFees || DEFAULT_SYSTEM_FEES);
        
        // Create subscription for tenant's own product (Active - no approval needed for own products)
        // Ensure tenant-level subscription exists
        const tenantSubscriptionCheck = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('productId', sql.UniqueIdentifier, productId)
            .query(`
                SELECT TOP 1 SubscriptionId, SubscriptionStatus
                FROM oe.TenantProductSubscriptions
                WHERE TenantId = @tenantId AND ProductId = @productId
            `);

        if (tenantSubscriptionCheck.recordset.length === 0) {
            await pool.request()
                .input('subscriptionId', sql.UniqueIdentifier, subscriptionId)
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .input('productId', sql.UniqueIdentifier, productId)
                .input('subscriptionStatus', sql.NVarChar(50), 'Active')
                .input('tenantRate', sql.Decimal(19, 4), 0)
                .input('systemFeesSnapshot', sql.NVarChar, systemFees)
                .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
                .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
                .input('subscriptionDate', sql.DateTime2, new Date())
                .input('modifiedDate', sql.DateTime2, new Date())
                .input('isConfigured', sql.Bit, 0)
                .query(`
                    INSERT INTO oe.TenantProductSubscriptions (
                        SubscriptionId,
                        TenantId,
                        ProductId,
                        SubscriptionStatus,
                        TenantRate,
                        SystemFeesSnapshot,
                        CreatedBy,
                        ModifiedBy,
                        SubscriptionDate,
                        ModifiedDate,
                        IsConfigured
                    ) VALUES (
                        @subscriptionId,
                        @tenantId,
                        @productId,
                        @subscriptionStatus,
                        @tenantRate,
                        @systemFeesSnapshot,
                        @createdBy,
                        @modifiedBy,
                        @subscriptionDate,
                        @modifiedDate,
                        @isConfigured
                    )
                `);

            console.log(`✅ Inserted tenant-owned subscription into oe.TenantProductSubscriptions (SubscriptionId=${subscriptionId})`);
        } else {
            const existingTenantSub = tenantSubscriptionCheck.recordset[0];
            console.log(`ℹ️ TenantProductSubscriptions already exists (SubscriptionId=${existingTenantSub.SubscriptionId}, Status=${existingTenantSub.SubscriptionStatus})`);
        }

        // Ensure ProductSubscriptions table also reflects ownership so owners don't need to subscribe
        const actingUserId = req.user?.UserId || req.user?.userId || req.user?.id || req.user?.Id;

        const productSubscriptionCheck = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('productId', sql.UniqueIdentifier, productId)
            .query(`
                SELECT TOP 1 ProductSubscriptionId, Status
                FROM oe.ProductSubscriptions
                WHERE TenantId = @tenantId AND ProductId = @productId
            `);

        if (productSubscriptionCheck.recordset.length === 0) {
            const productSubscriptionId = uuidv4();

            await pool.request()
                .input('productSubscriptionId', sql.UniqueIdentifier, productSubscriptionId)
                .input('productId', sql.UniqueIdentifier, productId)
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .input('status', sql.NVarChar(20), 'Approved')
                .input('requestDate', sql.DateTime2, new Date())
                .input('approvalDate', sql.DateTime2, new Date())
                .input('discountAmount', sql.Decimal(19, 4), 0)
                .input('serviceFeePerMember', sql.Decimal(19, 4), 0)
                .input('notes', sql.NVarChar(sql.MAX), 'Auto-approved for product owner')
                .input('approvedBy', sql.UniqueIdentifier, actingUserId)
                .input('createdBy', sql.UniqueIdentifier, actingUserId)
                .input('modifiedBy', sql.UniqueIdentifier, actingUserId)
                .query(`
                    INSERT INTO oe.ProductSubscriptions (
                        ProductSubscriptionId,
                        ProductId,
                        TenantId,
                        Status,
                        RequestDate,
                        ApprovalDate,
                        DiscountAmount,
                        DiscountEffectiveDate,
                        DiscountEndDate,
                        ServiceFeePerMember,
                        Notes,
                        ApprovedBy,
                        CreatedDate,
                        ModifiedDate,
                        CreatedBy,
                        ModifiedBy
                    ) VALUES (
                        @productSubscriptionId,
                        @productId,
                        @tenantId,
                        @status,
                        @requestDate,
                        @approvalDate,
                        @discountAmount,
                        NULL,
                        NULL,
                        @serviceFeePerMember,
                        @notes,
                        @approvedBy,
                        GETUTCDATE(),
                        GETUTCDATE(),
                        @createdBy,
                        @modifiedBy
                    )
                `);

            console.log(`✅ Inserted owner record into oe.ProductSubscriptions (ProductSubscriptionId=${productSubscriptionId})`);
        } else {
            const existingProductSub = productSubscriptionCheck.recordset[0];
            console.log(`ℹ️ ProductSubscriptions already exists (ProductSubscriptionId=${existingProductSub.ProductSubscriptionId}, Status=${existingProductSub.Status})`);
        }

        // TODO: Handle bundle products if this is a bundle
        if (isBundle === 'true' || isBundle === true) {
            // Create bundle product relationships
            for (const bundleProduct of parsedBundleProducts) {
                const bundleProductId = uuidv4();
                await pool.request()
                    .input('bundleProductId', sql.UniqueIdentifier, bundleProductId)
                    .input('bundleId', sql.UniqueIdentifier, productId)
                    .input('productId', sql.UniqueIdentifier, bundleProduct.productId)
                    .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
                    .query(`
                        INSERT INTO oe.ProductBundles (
                            BundleProductId, IncludedProductId, SortOrder, IsRequired, HidePricing, CreatedDate, ModifiedDate
                        ) VALUES (
                            @bundleId, @productId, 1, 1, 0, GETDATE(), GETDATE()
                        )
                    `);
            }
        }

        res.json({
            success: true,
            data: {
                productId,
                name,
                description,
                productType,
                status: 'Active'
            },
            message: 'Product created successfully'
        });

    } catch (error) {
        console.error('❌ Error creating tenant product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create product',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * PUT /api/me/tenant-admin/my-products/:productId
 * Update a product owned by the current tenant
 */
router.put('/:productId', authenticate, authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { productId } = req.params;
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Tenant ID is required'
            });
        }
        
        const pool = await getPool();

        // Verify the product is owned by this tenant
        const ownershipCheck = await pool.request()
            .input('productId', sql.UniqueIdentifier, productId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT ProductId, Name, Status
                FROM oe.Products
                WHERE ProductId = @productId AND ProductOwnerId = @tenantId
            `);

        if (ownershipCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found or you do not have permission to edit it'
            });
        }

        const {
            name,
            description,
            productType,
            salesType,
            status,
            minAge,
            maxAge,
            allowedStates,
            requiresTobaccoInfo,
            effectiveDateLogic,
            maxEffectiveDateDays,
            terminationLogic,
            requiredLicenses,
            configurationFields,
            pricingTiers,
            productImageUrl,
            productLogoUrl,
            productDocumentUrl,
            deleteProductImage,
            deleteProductLogo,
            deleteProductDocument,
            acknowledgementQuestions,
            productQuestionnaires,
            idCardData,
            idCardMemberIdPrefixMask,
            planDetailsData,
            aiChunks,
            requiredASA,
            trainingConfig,
            medicalNeedsLinksConfig,
            isSSNRequired,
            isPublic,
            isHidden,
            premiumReportingCategory,
            includeProcessingFee,
            roundUpProcessingFee,
            processingFeePercentage
        } = req.body;

        // Parse JSON-ish fields safely. `undefined` preserves the existing DB value
        // (we skip SET clauses for anything that's undefined); any other value is persisted.
        const safeParse = (val) => {
            if (val === undefined) return undefined;
            if (val === null || val === '') return null;
            if (typeof val !== 'string') return val;
            try { return JSON.parse(val); } catch { return val; }
        };
        const parsedProductQuestionnaires = safeParse(productQuestionnaires);
        const parsedIdCardData = safeParse(idCardData);
        const parsedPlanDetailsData = safeParse(planDetailsData);
        const parsedAllowedStates = safeParse(allowedStates);
        const parsedRequiredLicenses = safeParse(requiredLicenses);
        const parsedConfigurationFields = safeParse(configurationFields);
        const parsedPricingTiers = safeParse(pricingTiers);
        const parsedAcknowledgementQuestions = safeParse(acknowledgementQuestions);
        const parsedAiChunks = safeParse(aiChunks);
        const parsedRequiredASA = safeParse(requiredASA);
        const parsedTrainingConfig = safeParse(trainingConfig);
        const parsedMedicalNeedsLinksConfig = safeParse(medicalNeedsLinksConfig);

        const toDbJson = (val) => (val === null ? null : JSON.stringify(val));
        const toBool = (val) => val === true || val === 'true' || val === 1 || val === '1';

        // Build UPDATE dynamically so partial payloads don't clobber unrelated fields.
        // Previously this endpoint silently dropped idCardData, pricing, age limits, etc.
        // which is why back-of-card images appeared blank after save.
        const setClauses = [
            'ModifiedBy = @modifiedBy',
            'ModifiedDate = GETDATE()'
        ];
        const updateReq = pool.request()
            .input('productId', sql.UniqueIdentifier, productId)
            .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
            .input('tenantId', sql.UniqueIdentifier, tenantId);

        const addScalar = (bodyVal, column, param, type, transform) => {
            if (bodyVal === undefined) return;
            const value = transform ? transform(bodyVal) : bodyVal;
            setClauses.push(`${column} = @${param}`);
            updateReq.input(param, type, value);
        };
        const addJson = (parsedVal, column, param) => {
            if (parsedVal === undefined) return;
            setClauses.push(`${column} = @${param}`);
            updateReq.input(param, sql.NVarChar(sql.MAX), toDbJson(parsedVal));
        };

        addScalar(name, 'Name', 'name', sql.NVarChar);
        addScalar(description, 'Description', 'description', sql.NVarChar);
        addScalar(productType, 'ProductType', 'productType', sql.NVarChar);
        addScalar(salesType, 'SalesType', 'salesType', sql.NVarChar);
        addScalar(status, 'Status', 'status', sql.NVarChar);
        addScalar(isSSNRequired, 'IsSSNRequired', 'isSSNRequired', sql.Bit, toBool);
        addScalar(isPublic, 'IsPublic', 'isPublic', sql.Bit, toBool);
        addScalar(isHidden, 'IsHidden', 'isHidden', sql.Bit, toBool);
        addScalar(requiresTobaccoInfo, 'RequiresTobaccoInfo', 'requiresTobaccoInfo', sql.Bit, toBool);
        addScalar(minAge, 'MinAge', 'minAge', sql.Int, (v) => (v === null || v === '' ? null : parseInt(v, 10)));
        addScalar(maxAge, 'MaxAge', 'maxAge', sql.Int, (v) => (v === null || v === '' ? null : parseInt(v, 10)));
        addScalar(effectiveDateLogic, 'EffectiveDateLogic', 'effectiveDateLogic', sql.NVarChar);
        addScalar(maxEffectiveDateDays, 'MaxEffectiveDateDays', 'maxEffectiveDateDays', sql.Int,
            (v) => (v === null || v === '' ? 60 : parseInt(v, 10) || 60));
        addScalar(terminationLogic, 'TerminationLogic', 'terminationLogic', sql.NVarChar);
        addScalar(premiumReportingCategory, 'PremiumReportingCategory', 'premiumReportingCategory', sql.NVarChar(20),
            (v) => (v === 'NonProfit' ? 'NonProfit' : 'ForProfit'));
        addScalar(includeProcessingFee, 'IncludeProcessingFee', 'includeProcessingFee', sql.Bit, toBool);
        addScalar(roundUpProcessingFee, 'RoundUpProcessingFee', 'roundUpProcessingFee', sql.Bit, toBool);
        addScalar(processingFeePercentage, 'ProcessingFeePercentage', 'processingFeePercentage', sql.Decimal(9, 4),
            (v) => (v === null || v === '' ? null : parseFloat(v)));
        addScalar(idCardMemberIdPrefixMask, 'IDCardMemberIdPrefixMask', 'idCardMemberIdPrefixMask', sql.NVarChar(10),
            (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 10)));

        addJson(parsedProductQuestionnaires, 'ProductQuestionnaires', 'productQuestionnaires');
        addJson(parsedIdCardData, 'IDCardData', 'idCardData');
        addJson(parsedPlanDetailsData, 'PlanDetailsData', 'planDetailsData');
        addJson(parsedAllowedStates, 'AllowedStates', 'allowedStates');
        addJson(parsedRequiredLicenses, 'RequiredLicenses', 'requiredLicenses');
        addJson(parsedConfigurationFields, 'RequiredDataFields', 'requiredDataFields');
        addJson(parsedAcknowledgementQuestions, 'AcknowledgementQuestions', 'acknowledgementQuestions');
        addJson(parsedRequiredASA, 'RequiredASA', 'requiredASA');
        addJson(parsedTrainingConfig, 'TrainingConfig', 'trainingConfig');
        addJson(parsedMedicalNeedsLinksConfig, 'MedicalNeedsLinksConfig', 'medicalNeedsLinksConfig');

        // pricingTiers + aiChunks: stored in related tables by other flows today; we still
        // swallow them here to keep API compatible but don't write JSON columns that don't exist.
        void parsedPricingTiers;
        void parsedAiChunks;

        const updateQuery = `
            UPDATE oe.Products
            SET ${setClauses.join(',\n                ')}
            WHERE ProductId = @productId AND ProductOwnerId = @tenantId
        `;
        await updateReq.query(updateQuery);

        // Handle product media/document updates if provided
        const mediaUpdatePromises = [];

        const shouldRemoveImage = deleteProductImage === true || deleteProductImage === 'true';
        const shouldRemoveLogo = deleteProductLogo === true || deleteProductLogo === 'true';
        const shouldRemoveDocument = deleteProductDocument === true || deleteProductDocument === 'true';

        const hasImageUrl = typeof productImageUrl === 'string' && productImageUrl.trim().length > 0;
        const hasLogoUrl = typeof productLogoUrl === 'string' && productLogoUrl.trim().length > 0;
        const hasDocumentUrl = typeof productDocumentUrl === 'string' && productDocumentUrl.trim().length > 0;

        if (shouldRemoveImage || hasImageUrl) {
            const imageValue = shouldRemoveImage ? null : productImageUrl.trim();

            mediaUpdatePromises.push(
                pool.request()
                    .input('productId', sql.UniqueIdentifier, productId)
                    .input('tenantId', sql.UniqueIdentifier, tenantId)
                    .input('productImageUrl', sql.NVarChar, imageValue)
                    .query(`
                        UPDATE oe.Products
                        SET ProductImageUrl = @productImageUrl
                        WHERE ProductId = @productId AND ProductOwnerId = @tenantId
                    `)
            );
        }

        if (shouldRemoveLogo || hasLogoUrl) {
            const logoValue = shouldRemoveLogo ? null : productLogoUrl.trim();

            mediaUpdatePromises.push(
                pool.request()
                    .input('productId', sql.UniqueIdentifier, productId)
                    .input('tenantId', sql.UniqueIdentifier, tenantId)
                    .input('productLogoUrl', sql.NVarChar, logoValue)
                    .query(`
                        UPDATE oe.Products
                        SET ProductLogoUrl = @productLogoUrl
                        WHERE ProductId = @productId AND ProductOwnerId = @tenantId
                    `)
            );
        }

        if (shouldRemoveDocument || hasDocumentUrl) {
            const documentValue = shouldRemoveDocument ? null : productDocumentUrl.trim();

            mediaUpdatePromises.push(
                pool.request()
                    .input('productId', sql.UniqueIdentifier, productId)
                    .input('tenantId', sql.UniqueIdentifier, tenantId)
                    .input('productDocumentUrl', sql.NVarChar, documentValue)
                    .query(`
                        UPDATE oe.Products
                        SET ProductDocumentUrl = @productDocumentUrl
                        WHERE ProductId = @productId AND ProductOwnerId = @tenantId
                    `)
            );
        }

        if (mediaUpdatePromises.length > 0) {
            await Promise.all(mediaUpdatePromises);
            console.log('📄 Product media/documents updated for product:', productId, {
                imageUpdated: shouldRemoveImage || hasImageUrl,
                logoUpdated: shouldRemoveLogo || hasLogoUrl,
                documentUpdated: shouldRemoveDocument || hasDocumentUrl
            });
        }

        console.log(`✅ Updated product: ${productId}`);

        res.json({
            success: true,
            message: 'Product updated successfully'
        });

    } catch (error) {
        console.error('❌ Error updating tenant product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update product',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * DELETE /api/me/tenant-admin/my-products/:productId
 * Permanently delete a product owned by the current tenant (SysAdmin may delete any product).
 * Blocked when any enrollments reference the product.
 */
router.delete('/:productId', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { productId } = req.params;
        const tenantId = req.tenantId || req.user?.TenantId;
        const isSysAdmin = req.user?.currentRole === 'SysAdmin';

        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Tenant ID is required'
            });
        }

        const pool = await getPool();

        const ownershipRequest = pool.request()
            .input('productId', sql.UniqueIdentifier, productId);

        const ownershipQuery = isSysAdmin
            ? `SELECT ProductId, Name, Status, ProductOwnerId FROM oe.Products WHERE ProductId = @productId`
            : `SELECT ProductId, Name, Status, ProductOwnerId FROM oe.Products WHERE ProductId = @productId AND ProductOwnerId = @tenantId`;

        if (!isSysAdmin) {
            ownershipRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        }

        const ownershipCheck = await ownershipRequest.query(ownershipQuery);

        if (ownershipCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found or you do not have permission to delete it'
            });
        }

        const enrollmentCheck = await pool.request()
            .input('productId', sql.UniqueIdentifier, productId)
            .query(`
                SELECT COUNT(*) as EnrollmentCount
                FROM oe.Enrollments
                WHERE ProductId = @productId
            `);

        const enrollmentCount = enrollmentCheck.recordset[0].EnrollmentCount;
        if (enrollmentCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete this product because ${enrollmentCount} enrollment${enrollmentCount === 1 ? '' : 's'} are attached to it.`,
                enrollmentCount
            });
        }

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const run = (query) => {
                const request = transaction.request();
                request.input('productId', sql.UniqueIdentifier, productId);
                return request.query(query);
            };

            // Remove AI chunks tied to product documents, then the documents themselves
            await run(`
                DELETE ac FROM oe.AIChunks ac
                INNER JOIN oe.ProductDocuments pd ON ac.SourceDocumentId = pd.ProductDocumentId
                WHERE pd.ProductId = @productId
            `);
            await run(`DELETE FROM oe.AIChunks WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.ProductDocuments WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.ProductPricing WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.ProductOverrides WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.ProductBundles WHERE BundleProductId = @productId OR IncludedProductId = @productId`);
            await run(`DELETE FROM oe.ProspectProducts WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.TrainingCompletions WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.ProposalDocumentProducts WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.VendorImportProductMap WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.MigrationProductMap WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.TenantProductSubscriptions WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.ProductSubscriptions WHERE ProductId = @productId`);
            await run(`DELETE FROM oe.GroupProducts WHERE ProductId = @productId`);

            // Clear self-references on other products before deleting
            await run(`
                UPDATE oe.Products
                SET SourceProductId = NULL
                WHERE SourceProductId = @productId
            `);
            await run(`
                UPDATE oe.Products
                SET EligibilityVendorGroupFallbackProductId = NULL
                WHERE EligibilityVendorGroupFallbackProductId = @productId
            `);

            const deleteResult = await run(`DELETE FROM oe.Products WHERE ProductId = @productId`);

            if (deleteResult.rowsAffected[0] === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Product not found'
                });
            }

            await transaction.commit();
        } catch (txError) {
            await transaction.rollback();
            throw txError;
        }

        console.log(`✅ Permanently deleted product: ${productId}`);

        res.json({
            success: true,
            message: 'Product deleted successfully'
        });

    } catch (error) {
        console.error('❌ Error deleting tenant product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete product',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;
