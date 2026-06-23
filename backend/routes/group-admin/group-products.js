// backend/routes/group-admin/group-products.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authorize, getUserRoles } = require('../../middleware/auth');
const { authenticateUrls } = require('../uploads');

/**
 * @api {get} /group-admin/products Get products for GroupAdmin
 * @apiName GetGroupAdminProducts
 * @apiGroup GroupAdmin
 * @apiDescription Get all products available to the GroupAdmin's group
 * 
 * @apiHeader {String} Authorization Bearer token
 * 
 * @apiSuccess {Boolean} success Indicates if the operation was successful
 * @apiSuccess {Array} data List of products
 */
router.get('/products', authorize(['GroupAdmin']), async (req, res) => {
    try {
        const groupAdminUserId = req.user.UserId;
        console.log(`Fetching products for GroupAdmin user: ${groupAdminUserId}`);
        
        const pool = await getPool();

        // First, try to get the group using different methods
        const groupRequest = pool.request();
        groupRequest.input('userId', sql.UniqueIdentifier, groupAdminUserId);
        
        // Method 1: Direct relationship in GroupAdmins table
        let groupResult = await groupRequest.query(`
            SELECT g.GroupId, g.TenantId, g.Name as GroupName
            FROM oe.GroupAdmins ga
            JOIN oe.Groups g ON ga.GroupId = g.GroupId
            WHERE ga.UserId = @userId AND ga.Status = 'Active'
            AND g.Status = 'Active'
        `);

        // Method 2: Check the Members table for the user's group
        if (groupResult.recordset.length === 0) {
            console.log('No group found in GroupAdmins table, checking Members table...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Members m
                JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE m.UserId = @userId AND m.Status = 'Active'
                AND g.Status = 'Active'
            `);
        }
        
        // Method 3: Check if the user is directly associated with a group
        if (groupResult.recordset.length === 0) {
            console.log('No group found in Members table, checking User data...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.TenantId = g.TenantId
                WHERE u.UserId = @userId AND u.Status = 'Active'
                AND g.Status = 'Active'
                ORDER BY g.CreatedDate DESC
            `);
        }

        // Method 4: Find the first active group in the user's tenant
        if (groupResult.recordset.length === 0) {
            console.log('No direct group association found, checking tenant groups...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.TenantId = g.TenantId
                WHERE u.UserId = @userId AND u.Status = 'Active'
                AND g.Status = 'Active'
                ORDER BY g.CreatedDate DESC
            `);
        }

        if (groupResult.recordset.length === 0) {
            console.error('Failed to find any active group for GroupAdmin', {
                userId: groupAdminUserId,
                roles: getUserRoles(req.user),
                tenantId: req.user.TenantId
            });
            
            return res.status(404).json({
                success: false,
                message: 'No active group found for this admin',
                code: 'GROUP_NOT_FOUND'
            });
        }

        const group = groupResult.recordset[0];
        const groupId = group.GroupId;
        const tenantId = group.TenantId;
        
        console.log(`Found group for GroupAdmin: ${group.GroupName} (ID: ${groupId}), TenantId: ${tenantId}`);
        
        // Get products for this group's tenant
        const productsRequest = pool.request();
        productsRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        // First, check if IsGlobal column exists in Products table
        let hasIsGlobalColumn = false;
        try {
            const columnCheckResult = await productsRequest.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_schema = 'oe' AND table_name = 'Products' AND column_name = 'IsGlobal'
            `);
            hasIsGlobalColumn = columnCheckResult.recordset.length > 0;
            console.log(`IsGlobal column ${hasIsGlobalColumn ? 'exists' : 'does not exist'} in Products table`);
        } catch (err) {
            console.warn('Error checking for IsGlobal column:', err.message);
            // Continue with default assumption
        }

        let productsQuery;
        if (hasIsGlobalColumn) {
            productsQuery = `
                SELECT 
                    p.ProductId, 
                    p.Name, 
                    p.ProductType,
                    p.Status,
                    p.Description,
                    p.ProductImageUrl,
                    p.ProductLogoUrl,
                    p.ProductDocumentUrl,
                    p.MinAge,
                    p.MaxAge,
                    p.SalesType,
                    p.AllowedStates,
                    COALESCE(t.Name, 'Unknown') as ProductOwner,
                    ISNULL((
                        SELECT MIN(pp.NetRate + ISNULL(pp.OverrideRate, 0))
                        FROM oe.ProductPricing pp
                        WHERE pp.ProductId = p.ProductId 
                        AND pp.Status = 'Active'
                    ), 0) as BasePrice
                FROM oe.Products p
                LEFT JOIN oe.TenantProducts tp ON p.ProductId = tp.ProductId AND tp.TenantId = @tenantId
                LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
                WHERE (tp.TenantId = @tenantId OR p.IsGlobal = 1)
                AND p.Status = 'Active'
                AND (tp.Status IS NULL OR tp.Status = 'Active')
                ORDER BY p.Name
            `;
        } else {
            productsQuery = `
                SELECT 
                    p.ProductId, 
                    p.Name,
                    p.ProductType,
                    p.Status,
                    p.Description,
                    p.ProductImageUrl,
                    p.ProductLogoUrl,
                    p.ProductDocumentUrl,
                    p.MinAge,
                    p.MaxAge,
                    p.SalesType,
                    p.AllowedStates,
                    COALESCE(t.Name, 'Unknown') as ProductOwner,
                    ISNULL((
                        SELECT MIN(pp.NetRate + ISNULL(pp.OverrideRate, 0))
                        FROM oe.ProductPricing pp
                        WHERE pp.ProductId = p.ProductId 
                        AND pp.Status = 'Active'
                    ), 0) as BasePrice
                FROM oe.Products p
                JOIN oe.TenantProducts tp ON p.ProductId = tp.ProductId
                LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
                WHERE tp.TenantId = @tenantId
                AND p.Status = 'Active'
                AND tp.Status = 'Active'
                ORDER BY p.Name
            `;
        }

        const productsResult = await productsRequest.query(productsQuery);

        console.log(`Found ${productsResult.recordset.length} products for GroupAdmin's tenant`);
        
        // If no products were found, return all active products as a fallback
        if (productsResult.recordset.length === 0) {
            console.log("No tenant-specific products found, returning all active products");
            
            const allProductsResult = await productsRequest.query(`
                SELECT 
                    p.ProductId, 
                    p.Name,
                    p.ProductType,
                    p.Status,
                    p.Description,
                    p.ProductImageUrl,
                    p.ProductLogoUrl,
                    p.ProductDocumentUrl,
                    p.MinAge,
                    p.MaxAge,
                    p.SalesType,
                    p.AllowedStates,
                    COALESCE(t.Name, 'Unknown') as ProductOwner,
                    ISNULL((
                        SELECT MIN(pp.NetRate + ISNULL(pp.OverrideRate, 0))
                        FROM oe.ProductPricing pp
                        WHERE pp.ProductId = p.ProductId 
                        AND pp.Status = 'Active'
                    ), 0) as BasePrice
                FROM oe.Products p
                LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
                WHERE p.Status = 'Active'
                ORDER BY p.Name
            `);
            
            console.log(`Returning ${allProductsResult.recordset.length} active products as fallback`);
            
            // Format products for fallback
            const fallbackProducts = allProductsResult.recordset.map(product => ({
                ProductId: product.ProductId,
                Name: product.Name,
                ProductType: product.ProductType,
                Description: product.Description,
                BasePrice: product.BasePrice || 0,
                ProductOwner: product.ProductOwner,
                AllowedStates: product.AllowedStates ? JSON.parse(product.AllowedStates) : [],
                MinAge: product.MinAge || 0,
                MaxAge: product.MaxAge || 65,
                SalesType: product.SalesType || 'Individual',
                IsActive: product.Status === 'Active',
                ProductImageUrl: product.ProductImageUrl,
                ProductLogoUrl: product.ProductLogoUrl,
                ProductDocumentUrl: product.ProductDocumentUrl
            }));
            
            // Authenticate only document URLs for fallback products (images/logos are public)
            console.log('🔐 Authenticating document URLs for', fallbackProducts.length, 'fallback products');
            const authenticatedFallbackProducts = await Promise.all(
                fallbackProducts.map(product => authenticateUrls(product, ['ProductDocumentUrl']))
            );
            console.log('✅ Authentication complete for fallback products (documents only)');
            
            res.json({
                success: true,
                data: {
                    groupProducts: [], // Group admins don't have assigned products, they see all available
                    availableProducts: authenticatedFallbackProducts,
                    group: {
                        GroupId: groupId,
                        Name: group.GroupName,
                        TenantId: tenantId,
                        Status: 'Active'
                    }
                }
            });
            return;
        }

        // Format products for main query
        const formattedProducts = productsResult.recordset.map(product => ({
            ProductId: product.ProductId,
            Name: product.Name,
            ProductType: product.ProductType,
            Description: product.Description,
            BasePrice: product.BasePrice || 0,
            ProductOwner: product.ProductOwner,
            AllowedStates: product.AllowedStates ? JSON.parse(product.AllowedStates) : [],
            MinAge: product.MinAge || 0,
            MaxAge: product.MaxAge || 65,
            SalesType: product.SalesType || 'Individual',
            IsActive: product.Status === 'Active',
            ProductImageUrl: product.ProductImageUrl,
            ProductLogoUrl: product.ProductLogoUrl,
            ProductDocumentUrl: product.ProductDocumentUrl
        }));

        // Authenticate only document URLs for main products (images/logos are public)
        console.log('🔐 Authenticating document URLs for', formattedProducts.length, 'main products');
        const authenticatedProducts = await Promise.all(
            formattedProducts.map(product => authenticateUrls(product, ['ProductDocumentUrl']))
        );
        console.log('✅ Authentication complete for main products (documents only)');

        res.json({
            success: true,
            data: {
                groupProducts: [], // Group admins don't have assigned products, they see all available
                availableProducts: authenticatedProducts,
                group: {
                    GroupId: groupId,
                    Name: group.GroupName,
                    TenantId: tenantId,
                    Status: 'Active'
                }
            }
        });

    } catch (error) {
        console.error('❌ Error getting products for GroupAdmin:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving products',
            code: 'PRODUCTS_ERROR',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router; 