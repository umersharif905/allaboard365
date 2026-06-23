// File: backend/routes/me/tenant-admin/products.js

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');

/**
 * GET /api/me/tenant-admin/products
 * Get all available products for the tenant (marketplace + subscribed)
 * @access TenantAdmin, Agent (if owner of any agency)
 *
 * Do not call authenticate or auth.requireTenantAccess here: /api/me already authenticated, and
 * tenant-admin/index applies async requireTenantAccess (X-Current-Tenant-Id / multi-tenant).
 * Re-running authenticate resets req.user.TenantId to primary; auth.requireTenantAccess then
 * overwrites req.tenantId with that primary — wrong products for switched tenants.
 */
router.get('/', authorize(['TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const userRoles = getUserRoles(req.user);
        
        // Check if agent is owner of any agency
        if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin')) {
            const pool = await getPool();
            
            // Get agent's AgentId
            const agentQuery = await pool.request()
                .input('UserId', sql.UniqueIdentifier, req.user.UserId)
                .query(`
                    SELECT AgentId
                    FROM oe.Agents
                    WHERE UserId = @UserId AND Status = 'Active'
                `);
            
            if (agentQuery.recordset.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'Agent profile not found'
                });
            }
            
            const agentId = agentQuery.recordset[0].AgentId;
            
            // Check if agent owns any agency
            const ownerCheck = await pool.request()
                .input('AgentId', sql.UniqueIdentifier, agentId)
                .input('TenantId', sql.UniqueIdentifier, req.tenantId || req.user.TenantId)
                .query(`
                    SELECT COUNT(*) as count
                    FROM oe.AgencyAdmins aa
                    INNER JOIN oe.Agencies a ON a.AgencyId = aa.AgencyId AND a.Status = 'Active'
                    WHERE aa.AgentId = @AgentId AND aa.Status = 'Active' AND a.TenantId = @TenantId
                `);
            
            if (ownerCheck.recordset[0].count === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'You must be an agency owner to access products'
                });
            }
        }
        
        console.log('🔍 TenantAdmin products endpoint hit:', {
            userId: req.user?.UserId,
            userRoles: req.user?.roles,
            currentRole: req.user?.currentRole,
            tenantId: req.tenantId || req.user.TenantId
        });
        
        const tenantId = req.tenantId || req.user.TenantId;
        const pool = await getPool();
        
        const request = pool.request();
        request.input('TenantId', sql.UniqueIdentifier, tenantId);
        
        // Get only products owned by this tenant or subscribed by this tenant
        const result = await request.query(`
            SELECT 
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
                p.AllowedStates,
                p.MinAge,
                p.MaxAge,
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
                -- Check if tenant is already subscribed
                CASE 
                    WHEN tps.SubscriptionId IS NOT NULL THEN 'Subscribed'
                    ELSE 'Available'
                END as SubscriptionStatus,
                tps.SubscriptionId,
                tps.TenantRate,
                tps.ProfitMargin,
                tps.SystemFeesSnapshot,
                tps.SalePrice,
                tps.IsConfigured
            FROM oe.Products p
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId 
                AND tps.TenantId = @TenantId 
                AND tps.SubscriptionStatus != 'Cancelled'
            WHERE p.Status = 'Active'
            AND (p.ProductOwnerId = @TenantId OR tps.TenantId = @TenantId)
            AND (p.IsHidden IS NULL OR p.IsHidden = 0) -- Exclude hidden products
            ORDER BY p.Name
        `);
        
        console.log(`Found ${result.recordset.length} products for tenant ${tenantId}`);
        
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
                    VendorCommission,
                    MSRPRate,
                    TierType,
                    TobaccoStatus,
                    Status
                FROM oe.ProductPricing
                WHERE ProductId = @ProductId
                AND Status = 'Active'
                ORDER BY TierType, TobaccoStatus, MinAge
            `;
            
            const pricingResult = await pricingRequest.query(pricingQuery);
            
            // Process pricing tiers with proper structure
            const pricingTiers = pricingResult.recordset.map(pricing => ({
                id: pricing.ProductPricingId,
                minAge: pricing.MinAge || 0,
                maxAge: pricing.MaxAge || 0,
                tierType: pricing.TierType || 'Standard',
                tobaccoStatus: pricing.TobaccoStatus || 'N/A',
                netRate: parseFloat(pricing.NetRate) || 0,
                overrideRate: parseFloat(pricing.OverrideRate) || 0,
                vendorCommission: parseFloat(pricing.VendorCommission) || 0,
                msrpRate: parseFloat(pricing.MSRPRate) || 0,
                rate: (parseFloat(pricing.NetRate) || 0) + (parseFloat(pricing.OverrideRate) || 0)
            }));
            
            // Sort by tier type, tobacco status, and age
            pricingTiers.sort((a, b) => {
                if (a.tierType !== b.tierType) return a.tierType.localeCompare(b.tierType);
                if (a.tobaccoStatus !== b.tobaccoStatus) return a.tobaccoStatus.localeCompare(b.tobaccoStatus);
                return a.minAge - b.minAge;
            });
            
            return {
                ProductId: product.ProductId,
                Name: product.ProductName,
                ProductType: product.ProductType,
                Description: product.Description,
                IsBundle: product.IsBundle || 0,
                IsHidden: product.IsHidden || 0,
                SalesType: product.SalesType,
                Status: 'Active', // Add Status field for frontend filtering
                ProductImageUrl: product.ProductImageUrl,
                ProductLogoUrl: product.ProductLogoUrl,
                ProductDocumentUrl: product.ProductDocumentUrl,
                AllowedStates: product.AllowedStates,
                MinAge: product.MinAge,
                MaxAge: product.MaxAge,
                BasicPrice: product.BasicPrice,
                SubscriptionStatus: product.SubscriptionStatus,
                SubscriptionId: product.SubscriptionId,
                TenantRate: product.TenantRate,
                ProfitMargin: product.ProfitMargin,
                SystemFeesSnapshot: product.SystemFeesSnapshot,
                SalePrice: product.SalePrice,
                IsConfigured: product.IsConfigured,
                ProductOwner: {
                    tenantName: product.ProductOwnerName,
                    contactEmail: product.ProductOwnerEmail,
                    contactPhone: product.ProductOwnerPhone,
                    contactPerson: product.ProductOwnerContact
                },
                PricingTiers: pricingTiers
            };
        }));
        
        console.log('🔍 TenantAdmin products query result:', productsWithPricing.length, 'products found');
        res.json({
            success: true,
            data: productsWithPricing,
            message: `Found ${productsWithPricing.length} products`
        });
        
    } catch (error) {
        console.error('❌ Error fetching tenant-admin products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch products',
            error: {
                message: error.message,
                code: 'PRODUCTS_FETCH_ERROR'
            }
        });
    }
});

module.exports = router;
