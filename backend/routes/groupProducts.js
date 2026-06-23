const express = require('express');
const router = express.Router();
const { getPool, sql, rawSql } = require('../config/database');
const { authorize, requireTenantAccess , getUserRoles } = require('../middleware/auth');
const { authenticateUrls, authenticateProductDocumentsArray } = require('./uploads');
const { getProductDocumentsForProductIds } = require('../services/shared/product-documents.service');
const { vendorUserServesGroup } = require('../services/vendorGroupAccessService');
const { appendGroupScopeForTenantUsers, GROUP_DETAIL_READ_STATUS_SQL } = require('../utils/groupRouteAccess');
const { getOrCreateGroupEnrollmentLink } = require('../services/employeeFacingDoc.service');

// ============================================================================
// Group Vendor Networks (group's chosen network per vendor; drives ID card variation)
// ============================================================================

// GET /api/groups/:groupId/vendor-networks - List the group's network selections
router.get('/:groupId/vendor-networks', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);

        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT
                    gvn.GroupVendorNetworkId,
                    gvn.GroupId,
                    gvn.VendorId,
                    gvn.VendorNetworkId,
                    vn.Title AS NetworkTitle,
                    vn.IsDefault AS NetworkIsDefault,
                    v.VendorName
                FROM oe.GroupVendorNetworks gvn
                INNER JOIN oe.VendorNetworks vn ON gvn.VendorNetworkId = vn.VendorNetworkId
                INNER JOIN oe.Vendors v ON gvn.VendorId = v.VendorId
                WHERE gvn.GroupId = @groupId AND gvn.IsActive = 1 AND vn.IsActive = 1
            `);

        const selections = result.recordset.map((r) => ({
            groupVendorNetworkId: r.GroupVendorNetworkId,
            groupId: r.GroupId,
            vendorId: r.VendorId,
            vendorName: r.VendorName,
            vendorNetworkId: r.VendorNetworkId,
            networkTitle: r.NetworkTitle,
            networkIsDefault: r.NetworkIsDefault === true || r.NetworkIsDefault === 1
        }));

        res.json({ success: true, data: selections });
    } catch (error) {
        console.error('Error listing group vendor networks:', error);
        res.status(500).json({ success: false, message: 'Failed to list group vendor networks' });
    }
});

// PUT /api/groups/:groupId/vendor-networks - Upsert/clear network selections for a group
// Body: { selections: { [vendorId]: vendorNetworkId | null } }
router.put('/:groupId/vendor-networks', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const selections = req.body?.selections;
        if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
            return res.status(400).json({ success: false, message: 'selections object is required' });
        }

        const pool = await getPool();
        const userRoles = getUserRoles(req.user);

        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }

        const transaction = new rawSql.Transaction(pool);
        await transaction.begin();
        try {
            for (const [vendorId, vendorNetworkId] of Object.entries(selections)) {
                if (!vendorId) continue;
                if (!vendorNetworkId) {
                    // Clear selection -> default ID card. Soft-delete (IsActive=0) so the
                    // row's ModifiedDate is preserved, which lets eligibility export
                    // change-detection see the change on the next run.
                    await new rawSql.Request(transaction)
                        .input('groupId', sql.UniqueIdentifier, groupId)
                        .input('vendorId', sql.UniqueIdentifier, vendorId)
                        .query(`
                            UPDATE oe.GroupVendorNetworks
                            SET IsActive = 0, ModifiedDate = GETUTCDATE()
                            WHERE GroupId = @groupId AND VendorId = @vendorId AND IsActive = 1
                        `);
                } else {
                    // Validate the network belongs to this vendor
                    const validNetwork = await new rawSql.Request(transaction)
                        .input('vendorId', sql.UniqueIdentifier, vendorId)
                        .input('networkId', sql.UniqueIdentifier, vendorNetworkId)
                        .query(`
                            SELECT VendorNetworkId
                            FROM oe.VendorNetworks
                            WHERE VendorNetworkId = @networkId AND VendorId = @vendorId AND IsActive = 1
                        `);
                    if (validNetwork.recordset.length === 0) {
                        const err = new Error(`Network ${vendorNetworkId} not found for vendor ${vendorId}`);
                        err.statusCode = 400;
                        throw err;
                    }

                    // Upsert
                    await new rawSql.Request(transaction)
                        .input('groupId', sql.UniqueIdentifier, groupId)
                        .input('vendorId', sql.UniqueIdentifier, vendorId)
                        .input('networkId', sql.UniqueIdentifier, vendorNetworkId)
                        .query(`
                            MERGE oe.GroupVendorNetworks AS target
                            USING (SELECT @groupId AS GroupId, @vendorId AS VendorId) AS source
                            ON target.GroupId = source.GroupId AND target.VendorId = source.VendorId
                            WHEN MATCHED THEN
                                UPDATE SET VendorNetworkId = @networkId, IsActive = 1, ModifiedDate = GETUTCDATE()
                            WHEN NOT MATCHED THEN
                                INSERT (GroupId, VendorId, VendorNetworkId, IsActive)
                                VALUES (@groupId, @vendorId, @networkId, 1);
                        `);
                }
            }

            await transaction.commit();
        } catch (innerError) {
            try { await transaction.rollback(); } catch (_) { /* noop */ }
            throw innerError;
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error upserting group vendor networks:', error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to update group vendor networks' });
    }
});

// GET /api/groups/:groupId/vendors - Get vendors that have at least one product in this group (for Vendor Group IDs tab)
router.get('/:groupId/vendors', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const isVendorPortal = ['VendorAdmin', 'VendorAgent'].some((r) => userRoles.includes(r));

        if (isVendorPortal && !isSysAdmin) {
            const ok = await vendorUserServesGroup(pool, req.user.UserId, groupId);
            if (!ok) {
                return res.status(404).json({ success: false, message: 'Group not found or access denied' });
            }
        } else {
        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }
        }

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT DISTINCT v.VendorId, v.VendorName,
                    CASE WHEN v.NewGroupFormConfig IS NOT NULL AND LEN(RTRIM(v.NewGroupFormConfig)) > 0 THEN 1 ELSE 0 END AS HasNewGroupFormConfig
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                INNER JOIN oe.Vendors v ON p.VendorId = v.VendorId
                WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.VendorId IS NOT NULL
                ORDER BY v.VendorName
            `);
        const vendors = result.recordset.map((r) => ({
            VendorId: r.VendorId,
            Id: r.VendorId,
            VendorName: r.VendorName,
            HasNewGroupFormConfig: !!(r.HasNewGroupFormConfig)
        }));
        res.json({ success: true, data: vendors });
    } catch (error) {
        console.error('Error fetching group vendors:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch vendors' });
    }
});

// GET /api/groups/:groupId/products-with-enrollments - Product IDs that have at least one enrollment in this group (oe.enrollments for members in group)
router.get('/:groupId/products-with-enrollments', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);

        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }

        // Get directly enrolled product IDs AND bundle IDs that members enrolled through
        const enrollmentsResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT DISTINCT e.ProductId, e.ProductBundleID
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.GroupId = @groupId
                  AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            `);
        const productIds = new Set();
        for (const row of enrollmentsResult.recordset) {
            if (row.ProductId) productIds.add(String(row.ProductId));
            if (row.ProductBundleID) productIds.add(String(row.ProductBundleID));
        }
        res.json({ success: true, data: { productIds: [...productIds] } });
    } catch (error) {
        console.error('Error fetching group products-with-enrollments:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch products with enrollments' });
    }
});

// GET /api/groups/:groupId/products - Get all products for a group (both assigned and available)
router.get('/:groupId/products', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        
        // Verify group exists and user has access
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        
        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId, g.Name, g.Status
            FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        const group = groupResult.recordset[0];
        const tenantId = group.TenantId;

        // TenantAdmin/SysAdmin can request hidden products (Hide from Groups) for group edit UIs
        const includeHiddenRequested = req.query.includeHidden === 'true';
        const isTenantAdminRole = userRoles.includes('TenantAdmin');
        const includeHidden =
            includeHiddenRequested && (isTenantAdminRole || isSysAdmin);
        const hiddenProductsFilter = includeHidden
            ? ''
            : 'AND (p.IsHidden IS NULL OR p.IsHidden = 0) -- Exclude hidden products';
        
        // Get all available products for the tenant (products they can subscribe to)
        const availableProductsQuery = `
            SELECT DISTINCT
                p.ProductId,
                p.Name,
                p.ProductType,
                p.Description,
                p.Status as IsActive,
                p.MinAge,
                p.MaxAge,
                p.SalesType,
                p.IsHidden,
                p.IsBundle,
                p.AllowedStates,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                COALESCE(t.Name, 'Unknown') as ProductOwner,
                -- Get base price from ProductPricing if available
                ISNULL((
                    SELECT MIN(pp.NetRate + ISNULL(pp.OverrideRate, 0))
                    FROM oe.ProductPricing pp
                    WHERE pp.ProductId = p.ProductId 
                    AND pp.Status = 'Active'
                ), 0) as BasePrice
            FROM oe.Products p
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.ProductSubscriptions ps ON p.ProductId = ps.ProductId
            WHERE p.Status = 'Active'
              AND (ps.TenantId = @tenantId OR p.IsMarketplaceProduct = 1)
              AND (ps.Status = 'Active' OR p.IsMarketplaceProduct = 1)
              ${hiddenProductsFilter}
        `;
        
        const availableRequest = pool.request();
        availableRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const availableResult = await availableRequest.query(availableProductsQuery);
        
        // Get products already assigned to this group from oe.GroupProducts table
        const groupProductsQuery = `
            SELECT 
                gp.GroupProductId,
                gp.GroupId,
                gp.ProductId,
                gp.IsActive,
                gp.CustomSettings,
                gp.CreatedDate,
                gp.ModifiedDate,
                gp.CreatedBy,
                gp.ModifiedBy,
                gp.IsHidden as GroupProductIsHidden,
                p.Name,
                p.ProductType,
                p.Description,
                p.Status as ProductStatus,
                p.MinAge,
                p.MaxAge,
                p.SalesType,
                p.IsHidden,
                p.IsBundle,
                p.AllowedStates,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.RequiredDataFields,
                COALESCE(t.Name, 'Unknown') as ProductOwner,
                -- Get base price from ProductPricing if available
                ISNULL((
                    SELECT MIN(pp.NetRate + ISNULL(pp.OverrideRate, 0))
                    FROM oe.ProductPricing pp
                    WHERE pp.ProductId = p.ProductId 
                    AND pp.Status = 'Active'
                ), 0) as BasePrice
            FROM oe.GroupProducts gp
            JOIN oe.Products p ON gp.ProductId = p.ProductId
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            WHERE gp.GroupId = @groupId
              AND gp.IsActive = 1
              AND p.Status = 'Active'
              -- Always return assigned products (including hidden); catalog list uses hiddenProductsFilter separately
        `;
        
        const groupProductsRequest = pool.request();
        groupProductsRequest.input('groupId', sql.UniqueIdentifier, groupId);
        const groupProductsResult = await groupProductsRequest.query(groupProductsQuery);
        
        // Parse JSON fields and format products
        const availableProducts = availableResult.recordset.map(product => ({
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
            IsHidden: product.IsHidden || 0,
            IsBundle: product.IsBundle || 0,
            IsActive: product.IsActive === 'Active',
            ProductImageUrl: product.ProductImageUrl,
            ProductLogoUrl: product.ProductLogoUrl,
            ProductDocumentUrl: product.ProductDocumentUrl
        }));
        
        const groupProducts = await Promise.all(groupProductsResult.recordset.map(async (gp) => {
            // Parse RequiredDataFields to identify deductible fields
            let requiredDataFields = [];
            let deductibleFields = [];
            try {
                if (gp.RequiredDataFields) {
                    requiredDataFields = typeof gp.RequiredDataFields === 'string' 
                        ? JSON.parse(gp.RequiredDataFields) 
                        : gp.RequiredDataFields;
                    
                    // Identify fields marked as deductible
                    deductibleFields = requiredDataFields.filter((field) => 
                        field.isDeductible === true || 
                        field.markAsDeductible === true ||
                        (field.fieldName && (
                            field.fieldName.toLowerCase().includes('deductible') ||
                            field.fieldName.toLowerCase().includes('unshared amount')
                        ))
                    );
                }
            } catch (error) {
                console.warn('Failed to parse RequiredDataFields for product:', gp.ProductId, error);
            }
            
            // If this is a bundle, check included products for deductible fields
            if (gp.IsBundle) {
                try {
                    const bundleRequest = pool.request();
                    bundleRequest.input('bundleProductId', sql.UniqueIdentifier, gp.ProductId);
                    const bundleResult = await bundleRequest.query(`
                        SELECT 
                            p.ProductId,
                            p.Name,
                            p.RequiredDataFields,
                            pb.AllowedConfigOptions
                        FROM oe.ProductBundles pb
                        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                        WHERE pb.BundleProductId = @bundleProductId
                          AND p.Status = 'Active'
                    `);
                    
                    let groupCustomSettings = {};
                    try {
                        groupCustomSettings = gp.CustomSettings ? (typeof gp.CustomSettings === 'string' ? JSON.parse(gp.CustomSettings) : gp.CustomSettings) : {};
                    } catch (e) { /* ignore */ }
                    const groupAllowedByProduct = groupCustomSettings.allowedDeductibleOptionsByProduct || null;
                    const groupAllowedOptions = groupCustomSettings.allowedDeductibleOptions || null;
                    
                    // Per-product list so same field name in different products don't conflict; each field is scoped to sourceProductId
                    bundleResult.recordset.forEach((includedProduct) => {
                        try {
                            let bundleAllowedOptions = null;
                            if (includedProduct.AllowedConfigOptions) {
                                try {
                                    bundleAllowedOptions = typeof includedProduct.AllowedConfigOptions === 'string'
                                        ? JSON.parse(includedProduct.AllowedConfigOptions)
                                        : includedProduct.AllowedConfigOptions;
                                } catch (e) {
                                    console.warn(`Failed to parse AllowedConfigOptions for included product ${includedProduct.ProductId}:`, e);
                                }
                            }
                            const groupAllowedForThis = groupAllowedByProduct && groupAllowedByProduct[includedProduct.ProductId]
                                ? groupAllowedByProduct[includedProduct.ProductId]
                                : groupAllowedOptions;
                            if (includedProduct.RequiredDataFields) {
                                const includedFields = typeof includedProduct.RequiredDataFields === 'string'
                                    ? JSON.parse(includedProduct.RequiredDataFields)
                                    : includedProduct.RequiredDataFields;
                                
                                if (Array.isArray(includedFields)) {
                                    const includedDeductibleFields = includedFields.filter((field) => 
                                        field.isDeductible === true || 
                                        field.markAsDeductible === true ||
                                        (field.fieldName && (
                                            field.fieldName.toLowerCase().includes('deductible') ||
                                            field.fieldName.toLowerCase().includes('unshared amount')
                                        ))
                                    );
                                    includedDeductibleFields.forEach((field) => {
                                        const fullOptions = field.fieldOptions || [];
                                        if (fullOptions.length > 0) {
                                            // Product-level allowed options (from bundle AllowedConfigOptions): options the product has enabled.
                                            // When set, options not in this list should be shown but disabled in the group config modal.
                                            let productAllowedOptions = fullOptions;
                                            if (bundleAllowedOptions && field.fieldName && Array.isArray(bundleAllowedOptions[field.fieldName]) && bundleAllowedOptions[field.fieldName].length > 0) {
                                                productAllowedOptions = bundleAllowedOptions[field.fieldName];
                                            }
                                            // Always return full option list so the config modal can show all options
                                            // (selected state comes from CustomSettings.allowedDeductibleOptionsByProduct).
                                            // productAllowedOptions tells the UI which options the product has enabled (others greyed out).
                                            deductibleFields.push({
                                                ...field,
                                                fieldOptions: fullOptions,
                                                productAllowedOptions,
                                                sourceProductId: includedProduct.ProductId,
                                                sourceProductName: includedProduct.Name || 'Unknown'
                                            });
                                        }
                                    });
                                }
                            }
                        } catch (error) {
                            console.warn(`Failed to parse RequiredDataFields for included product ${includedProduct.ProductId}:`, error);
                        }
                    });
                } catch (error) {
                    console.warn(`Failed to fetch included products for bundle ${gp.ProductId}:`, error);
                }
            }
            
            return {
                GroupProductId: gp.GroupProductId,
                GroupId: gp.GroupId,
                ProductId: gp.ProductId,
                IsAssigned: true,
                IsActive: gp.IsActive,
                CustomSettings: gp.CustomSettings ? JSON.parse(gp.CustomSettings) : {},
                CreatedDate: gp.CreatedDate,
                ModifiedDate: gp.ModifiedDate,
                CreatedBy: gp.CreatedBy,
                ModifiedBy: gp.ModifiedBy,
                Name: gp.Name,
                ProductType: gp.ProductType,
                Description: gp.Description,
                ProductStatus: gp.ProductStatus,
                MinAge: gp.MinAge || 0,
                MaxAge: gp.MaxAge || 65,
                SalesType: gp.SalesType || 'Individual',
                IsHidden: gp.GroupProductIsHidden ? 1 : 0,
                IsCatalogHidden: gp.IsHidden ? 1 : 0,
                AllowedStates: gp.AllowedStates ? JSON.parse(gp.AllowedStates) : [],
                BasePrice: gp.BasePrice || 0,
                ProductOwner: gp.ProductOwner,
                ProductImageUrl: gp.ProductImageUrl,
                ProductLogoUrl: gp.ProductLogoUrl,
                ProductDocumentUrl: gp.ProductDocumentUrl,
                productDocuments: [],
                RequiredDataFields: requiredDataFields,
                DeductibleFields: deductibleFields,
                IsBundle: gp.IsBundle || false
            };
        }));
        
        const allProductIds = [
            ...availableProducts.map((p) => p.ProductId),
            ...groupProducts.map((gp) => gp.ProductId)
        ].filter(Boolean);
        const productDocumentsMap = allProductIds.length > 0 ? await getProductDocumentsForProductIds(pool, allProductIds, sql) : new Map();
        
        for (const p of availableProducts) {
            p.productDocuments = productDocumentsMap.get(p.ProductId) || [];
            if (p.productDocuments.length === 0 && p.ProductDocumentUrl && typeof p.ProductDocumentUrl === 'string' && p.ProductDocumentUrl.trim()) {
                p.productDocuments = [{ documentUrl: p.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
            }
            if (p.productDocuments.length > 0) {
                p.productDocuments = await authenticateProductDocumentsArray(p.productDocuments);
            }
        }
        for (const gp of groupProducts) {
            gp.productDocuments = productDocumentsMap.get(gp.ProductId) || [];
            if (gp.productDocuments.length === 0 && gp.ProductDocumentUrl && typeof gp.ProductDocumentUrl === 'string' && gp.ProductDocumentUrl.trim()) {
                gp.productDocuments = [{ documentUrl: gp.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
            }
            if (gp.productDocuments.length > 0) {
                gp.productDocuments = await authenticateProductDocumentsArray(gp.productDocuments);
            }
        }
        
        // Authenticate only document URLs for products (images/logos are public)
        console.log('🔐 Authenticating document URLs for', availableProducts.length, 'available products and', groupProducts.length, 'group products');
        const authenticatedAvailableProducts = await Promise.all(
            availableProducts.map(product => authenticateUrls(product, ['ProductDocumentUrl']))
        );
        const authenticatedGroupProducts = await Promise.all(
            groupProducts.map(product => authenticateUrls(product, ['ProductDocumentUrl']))
        );
        console.log('✅ Authentication complete for group products (documents only)');
        
        res.json({
            success: true,
            data: {
                groupProducts: authenticatedGroupProducts,
                availableProducts: authenticatedAvailableProducts,
                group: {
                    GroupId: group.GroupId,
                    Name: group.Name,
                    TenantId: group.TenantId,
                    Status: group.Status
                }
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching group products:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching group products'
        });
    }
});

// PUT /api/groups/:groupId/products - Update product assignments for a group
router.put('/:groupId/products', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { updates, householdCollection } = req.body;

        if (!updates || !Array.isArray(updates)) {
            return res.status(400).json({
                success: false,
                message: 'Updates array is required'
            });
        }

        const pool = await getPool();

        // Verify group exists and user has access
        const userRoles = getUserRoles(req.user);

        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId, g.AgentId AS GroupAgentId, g.Name AS GroupName
            FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        // Product IDs that have enrollments in this group cannot be removed.
        // Also check bundle sub-products: if a member enrolled via a bundle, the enrollment
        // records reference the included products, not the bundle itself.
        // Get product IDs and bundle IDs that members are enrolled in/through
        const enrollmentsResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT DISTINCT e.ProductId, e.ProductBundleID
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.GroupId = @groupId
                  AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            `);
        const lockedProductIds = new Set();
        for (const row of enrollmentsResult.recordset) {
            if (row.ProductId) lockedProductIds.add(String(row.ProductId));
            if (row.ProductBundleID) lockedProductIds.add(String(row.ProductBundleID));
        }

        for (const update of updates) {
            const { productId, IsAssigned } = update;
            if (IsAssigned === false && productId && lockedProductIds.has(String(productId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot remove a product that members are enrolled in. Use the hide option to prevent new enrollments while keeping existing ones active.'
                });
            }
        }
        
        // Implement actual product assignment functionality using oe.GroupProducts table
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
            let updatedCount = 0;
            
            for (const update of updates) {
                const { productId, IsAssigned, CustomSettings } = update;
                
                if (!productId) continue;
                
                // Check if product assignment already exists
                const checkRequest = transaction.request();
                checkRequest.input('groupId', sql.UniqueIdentifier, groupId);
                checkRequest.input('productId', sql.UniqueIdentifier, productId);
                
                const existingResult = await checkRequest.query(`
                    SELECT GroupProductId 
                    FROM oe.GroupProducts 
                    WHERE GroupId = @groupId AND ProductId = @productId
                `);
                
                if (existingResult.recordset.length > 0) {
                    if (IsAssigned === false) {
                        // Deactivate assignment by setting IsActive to false
                        const updateRequest = transaction.request();
                        updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
                        updateRequest.input('productId', sql.UniqueIdentifier, productId);
                        updateRequest.input('isActive', sql.Bit, 0);
                        updateRequest.input('customSettings', sql.NVarChar, CustomSettings ? JSON.stringify(CustomSettings) : null);
                        updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
                        
                        await updateRequest.query(`
                            UPDATE oe.GroupProducts 
                            SET IsActive = @isActive,
                                CustomSettings = @customSettings,
                                ModifiedDate = GETDATE(),
                                ModifiedBy = @modifiedBy
                            WHERE GroupId = @groupId AND ProductId = @productId
                        `);
                    } else {
                        // Update existing assignment — also flip IsHidden = 0 so re-adding a
                        // previously deleted product un-hides it automatically. The agent
                        // experiences "delete then re-add" as a single un-hide round-trip.
                        const updateRequest = transaction.request();
                        updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
                        updateRequest.input('productId', sql.UniqueIdentifier, productId);
                        updateRequest.input('isActive', sql.Bit, 1);
                        updateRequest.input('customSettings', sql.NVarChar, CustomSettings ? JSON.stringify(CustomSettings) : null);
                        updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

                        await updateRequest.query(`
                            UPDATE oe.GroupProducts
                            SET IsActive = @isActive,
                                IsHidden = 0,
                                CustomSettings = @customSettings,
                                ModifiedDate = GETDATE(),
                                ModifiedBy = @modifiedBy
                            WHERE GroupId = @groupId AND ProductId = @productId
                        `);
                    }
                } else if (IsAssigned === true) {
                    // Insert new assignment
                    const insertRequest = transaction.request();
                    const groupProductId = require('crypto').randomUUID();
                    
                    insertRequest.input('groupProductId', sql.UniqueIdentifier, groupProductId);
                    insertRequest.input('groupId', sql.UniqueIdentifier, groupId);
                    insertRequest.input('productId', sql.UniqueIdentifier, productId);
                    insertRequest.input('isActive', sql.Bit, 1);
                    insertRequest.input('customSettings', sql.NVarChar, CustomSettings ? JSON.stringify(CustomSettings) : null);
                    insertRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
                    
                    await insertRequest.query(`
                        INSERT INTO oe.GroupProducts 
                        (GroupProductId, GroupId, ProductId, IsActive, CustomSettings,
                         CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                        VALUES 
                        (@groupProductId, @groupId, @productId, @isActive, @customSettings,
                         GETDATE(), GETDATE(), @createdBy, @createdBy)
                    `);
                }
                
                updatedCount++;
            }
            
            await transaction.commit();

            // Auto-generate a Group enrollment link template if none exists and products were assigned
            const hasActiveProducts = updates.some(u => u.IsAssigned !== false);
            if (hasActiveProducts) {
              try {
                const existingTemplate = await pool.request()
                  .input('groupId', sql.UniqueIdentifier, groupId)
                  .query(`SELECT TemplateId, LinkMetaData FROM oe.EnrollmentLinkTemplates WHERE GroupId = @groupId AND TemplateType = 'Group'`);

                if (existingTemplate.recordset.length === 0) {
                  const templateId = require('crypto').randomUUID();
                  const groupRow = groupResult.recordset[0];
                  const linkMetaData = JSON.stringify({
                    household: householdCollection || {
                      collectSSN: true, collectDOB: true, collectGender: true,
                      collectAddress: true, collectPhone: true
                    }
                  });
                  const insertReq = pool.request()
                    .input('templateId', sql.UniqueIdentifier, templateId)
                    .input('templateName', sql.NVarChar, `${groupRow.GroupName || 'Group'} Enrollment`)
                    .input('tenantId', sql.UniqueIdentifier, groupRow.TenantId)
                    .input('groupId', sql.UniqueIdentifier, groupId)
                    .input('linkMetaData', sql.NVarChar, linkMetaData)
                    .input('createdBy', sql.UniqueIdentifier, req.user.UserId);
                  if (groupRow.GroupAgentId) {
                    insertReq.input('agentId', sql.UniqueIdentifier, groupRow.GroupAgentId);
                  }
                  await insertReq.query(`
                    INSERT INTO oe.EnrollmentLinkTemplates
                      (TemplateId, TemplateName, TemplateType, TenantId, GroupId, AgentId, LinkMetaData, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES
                      (@templateId, @templateName, 'Group', @tenantId, @groupId, ${groupRow.GroupAgentId ? '@agentId' : 'NULL'}, @linkMetaData, 1, GETDATE(), GETDATE(), @createdBy, @createdBy)
                  `);
                  console.log(`✅ Auto-generated Group enrollment link template for group ${groupId}`);
                } else if (householdCollection) {
                  // Update existing template's household settings if provided
                  const tpl = existingTemplate.recordset[0];
                  const existingMeta = tpl.LinkMetaData ? JSON.parse(tpl.LinkMetaData) : {};
                  existingMeta.household = householdCollection;
                  await pool.request()
                    .input('templateId', sql.UniqueIdentifier, tpl.TemplateId)
                    .input('linkMetaData', sql.NVarChar, JSON.stringify(existingMeta))
                    .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
                    .query(`UPDATE oe.EnrollmentLinkTemplates SET LinkMetaData = @linkMetaData, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy WHERE TemplateId = @templateId`);
                  console.log(`✅ Updated household settings on enrollment link template for group ${groupId}`);
                }
              } catch (autoGenErr) {
                console.warn('⚠️ Failed to auto-generate/update enrollment link template:', autoGenErr.message);
              }
            }

            res.json({
                success: true,
                message: `Successfully updated ${updatedCount} product assignments`,
                data: { updatedCount }
            });

            console.log(`✅ Updated ${updatedCount} product assignments for group ${groupId}`);
            
        } catch (transactionError) {
            await transaction.rollback();
            throw transactionError;
        }
        
    } catch (error) {
        console.error('❌ Error updating group products:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating group products'
        });
    }
});

// POST /api/groups/:groupId/products/:productId/assign - Assign a single product to a group
router.post('/:groupId/products/:productId/assign', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId, productId } = req.params;
        const { isAutoEnroll, enrollmentStartDate, enrollmentEndDate } = req.body;
        
        const pool = await getPool();
        
        // Verify group exists and user has access
        const userRoles = getUserRoles(req.user);
        
        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId 
            FROM oe.Groups g 
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        // Since oe.GroupProducts table doesn't exist, return a message
        res.json({
            success: false,
            message: 'GroupProducts table does not exist. Product assignment functionality requires database schema update.',
            data: { 
                groupId, 
                productId,
                note: 'To implement this feature, create the oe.GroupProducts table'
            }
        });
        
        /*
        // Here's the implementation code for when the table exists:
        
        // Check if already assigned
        const checkRequest = pool.request();
        checkRequest.input('groupId', sql.UniqueIdentifier, groupId);
        checkRequest.input('productId', sql.UniqueIdentifier, productId);
        
        const existingResult = await checkRequest.query(`
            SELECT GroupProductId, IsAssigned 
            FROM oe.GroupProducts 
            WHERE GroupId = @groupId AND ProductId = @productId
        `);
        
        if (existingResult.recordset.length > 0 && existingResult.recordset[0].IsAssigned) {
            return res.status(400).json({
                success: false,
                message: 'Product is already assigned to this group'
            });
        }
        
        const groupProductId = require('crypto').randomUUID();
        const insertRequest = pool.request();
        
        insertRequest.input('groupProductId', sql.UniqueIdentifier, groupProductId);
        insertRequest.input('groupId', sql.UniqueIdentifier, groupId);
        insertRequest.input('productId', sql.UniqueIdentifier, productId);
        insertRequest.input('isAutoEnroll', sql.Bit, isAutoEnroll === true ? 1 : 0);
        insertRequest.input('enrollmentStartDate', sql.Date, enrollmentStartDate || null);
        insertRequest.input('enrollmentEndDate', sql.Date, enrollmentEndDate || null);
        insertRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
        
        if (existingResult.recordset.length > 0) {
            // Update existing inactive record
            await insertRequest.query(`
                UPDATE oe.GroupProducts 
                SET IsAssigned = 1,
                    IsAutoEnroll = @isAutoEnroll,
                    EnrollmentStartDate = @enrollmentStartDate,
                    EnrollmentEndDate = @enrollmentEndDate,
                    AssignedDate = GETDATE(),
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @createdBy
                WHERE GroupId = @groupId AND ProductId = @productId
            `);
        } else {
            // Insert new record
            await insertRequest.query(`
                INSERT INTO oe.GroupProducts 
                (GroupProductId, GroupId, ProductId, IsAssigned, IsAutoEnroll,
                 EnrollmentStartDate, EnrollmentEndDate, AssignedDate,
                 CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES 
                (@groupProductId, @groupId, @productId, 1, @isAutoEnroll,
                 @enrollmentStartDate, @enrollmentEndDate, GETDATE(),
                 GETDATE(), GETDATE(), @createdBy, @createdBy)
            `);
        }
        
        res.json({
            success: true,
            message: 'Product assigned successfully',
            data: { groupProductId, groupId, productId }
        });
        
        console.log(`✅ Product ${productId} assigned to group ${groupId}`);
        */
        
    } catch (error) {
        console.error('❌ Error assigning product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to assign product',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// DELETE /api/groups/:groupId/products/:productId - Remove product assignment from a group
router.delete('/:groupId/products/:productId', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId, productId } = req.params;
        const pool = await getPool();
        
        // Verify group exists and user has access
        const userRoles = getUserRoles(req.user);
        
        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId 
            FROM oe.Groups g 
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        // Since oe.GroupProducts table doesn't exist, return a message
        res.json({
            success: false,
            message: 'GroupProducts table does not exist. Product removal functionality requires database schema update.',
            data: { 
                groupId, 
                productId,
                note: 'To implement this feature, create the oe.GroupProducts table'
            }
        });
        
        /*
        // Here's the implementation code for when the table exists:
        
        // Soft delete by setting IsAssigned to false
        const deleteRequest = pool.request();
        deleteRequest.input('groupId', sql.UniqueIdentifier, groupId);
        deleteRequest.input('productId', sql.UniqueIdentifier, productId);
        deleteRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        
        const result = await deleteRequest.query(`
            UPDATE oe.GroupProducts 
            SET IsAssigned = 0,
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE GroupId = @groupId AND ProductId = @productId AND IsAssigned = 1
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product assignment not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Product assignment removed successfully'
        });
        
        console.log(`✅ Product ${productId} unassigned from group ${groupId}`);
        */
        
    } catch (error) {
        console.error('❌ Error removing product assignment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove product assignment',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Toggle IsHidden on a group product.
//
// Constraint: un-hiding a product must respect the group's GroupType.
//   - GroupType='ListBill' + product.SalesType='Group'      → 409
//   - GroupType='Standard' + product.SalesType='Individual' → 409
//   - SalesType='Both'                                      → always allowed
//   - Hiding (isHidden=true) is always allowed regardless of type.
//
// Why: once a group has been converted, surfacing the wrong product class
// would let agents bypass the wizard and re-attach plans that don't match
// the new billing model.
//
// GroupAdmin is intentionally excluded from this endpoint (see master:
// "fix(groups): block GroupAdmins from editing products").
router.patch('/:groupId/products/:productId/visibility', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId, productId } = req.params;
        const { isHidden } = req.body;
        const pool = await getPool();

        if (typeof isHidden !== 'boolean') {
            return res.status(400).json({ success: false, message: 'isHidden (boolean) is required' });
        }

        // Look up the group's current type and the product's SalesType up front.
        // We do this for hide AND un-hide so the response can include current
        // values for debugging if anything goes wrong.
        const lookupResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('productId', sql.UniqueIdentifier, productId)
            .query(`
                SELECT g.GroupType, p.SalesType, p.Name AS ProductName
                FROM oe.GroupProducts gp
                INNER JOIN oe.Groups   g ON g.GroupId   = gp.GroupId
                INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
                WHERE gp.GroupId = @groupId
                  AND gp.ProductId = @productId
                  AND gp.IsActive = 1
            `);

        if (!lookupResult.recordset.length) {
            return res.status(404).json({ success: false, message: 'Group product not found' });
        }

        const { GroupType, SalesType, ProductName } = lookupResult.recordset[0];

        // Enforce the un-hide constraint.
        if (isHidden === false) {
            if (GroupType === 'ListBill' && SalesType === 'Group') {
                return res.status(409).json({
                    success: false,
                    code: 'GROUPTYPE_PRODUCT_MISMATCH',
                    message: `Cannot add "${ProductName}" back — it is a Group-only product, and this group has been converted to List Bill. Convert the group's type first or pick an Individual / Both product.`
                });
            }
            if (GroupType === 'Standard' && SalesType === 'Individual') {
                return res.status(409).json({
                    success: false,
                    code: 'GROUPTYPE_PRODUCT_MISMATCH',
                    message: `Cannot add "${ProductName}" back — it is an Individual-only product, and this group is set up as Standard. Convert the group's type to List Bill first or pick a Group / Both product.`
                });
            }
        }

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('productId', sql.UniqueIdentifier, productId)
            .input('isHidden', sql.Bit, isHidden ? 1 : 0)
            .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
            .query(`
                UPDATE oe.GroupProducts
                SET IsHidden = @isHidden,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE GroupId = @groupId AND ProductId = @productId AND IsActive = 1
            `);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ success: false, message: 'Group product not found' });
        }

        res.json({ success: true, message: isHidden ? 'Product hidden from new enrollments' : 'Product visible for new enrollments' });
    } catch (error) {
        console.error('Error toggling product visibility:', error);
        res.status(500).json({ success: false, message: 'Failed to update product visibility' });
    }
});

// GET /:groupId/products/:productId/enrollment-count
// Returns the count of active enrollments for the given product within the group.
// Used by the Delete confirmation modal to show "N members are currently enrolled".
// Auth: SysAdmin, TenantAdmin, Agent (Group Admin denied).
router.get('/:groupId/products/:productId/enrollment-count', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId, productId } = req.params;
        const pool = await getPool();

        // Bundle products have no enrollment row for the bundle ProductId itself —
        // the bundle's identity only appears as ProductBundleID on each component's
        // row. So count distinct members via component rows for bundles, and via
        // standalone rows otherwise.
        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('productId', sql.UniqueIdentifier, productId)
            .query(`
                SELECT COUNT(DISTINCT e.MemberId) AS count
                FROM oe.Products p
                INNER JOIN oe.Enrollments e
                  ON e.Status = 'Active'
                  AND e.HouseholdId IS NOT NULL
                  AND (
                    (p.IsBundle = 0 AND e.ProductId = p.ProductId AND e.ProductBundleID IS NULL)
                    OR (p.IsBundle = 1 AND e.ProductBundleID = p.ProductId)
                  )
                INNER JOIN oe.Members m ON m.MemberId = e.MemberId
                WHERE p.ProductId = @productId
                  AND m.GroupId = @groupId
            `);

        const count = result.recordset?.[0]?.count ?? 0;
        res.json({ success: true, data: { count } });
    } catch (error) {
        console.error('Error fetching enrollment count:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch enrollment count' });
    }
});

// GET /:groupId/products/hidden-with-enrollments
// Returns every removed product (GroupProducts.IsHidden = 1) for the group,
// with the active-enrollment member list (possibly empty). Powers the
// "Removed Products" section on the Group Products tab — the agent-facing
// place to see what's been deleted and restore it.
// Auth: SysAdmin, TenantAdmin, Agent (Group Admin denied).
router.get('/:groupId/products/hidden-with-enrollments', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                -- Bundle products store their identity as ProductBundleID on each
                -- component's enrollment row; there's no row with ProductId = bundle.
                -- So match component rows for bundles and standalone rows otherwise,
                -- then collapse duplicates per (ProductId, MemberId) — a member with
                -- N components in a bundle should count once.
                SELECT
                    p.ProductId,
                    p.Name AS ProductName,
                    m.MemberId,
                    LTRIM(RTRIM(CONCAT(u.FirstName, ' ', u.LastName))) AS FullName,
                    MIN(e.CreatedDate) AS EnrolledDate
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
                LEFT JOIN oe.Enrollments e
                    ON e.Status = 'Active'
                    AND e.HouseholdId IS NOT NULL
                    AND (
                      (p.IsBundle = 0 AND e.ProductId = p.ProductId AND e.ProductBundleID IS NULL)
                      OR (p.IsBundle = 1 AND e.ProductBundleID = p.ProductId)
                    )
                LEFT JOIN oe.Members m
                    ON m.MemberId = e.MemberId AND m.GroupId = @groupId
                LEFT JOIN oe.Users u ON u.UserId = m.UserId
                WHERE gp.GroupId = @groupId
                  AND gp.IsHidden = 1
                GROUP BY p.ProductId, p.Name, m.MemberId, u.FirstName, u.LastName
                ORDER BY p.Name, MIN(e.CreatedDate) DESC
            `);

        // Group rows by product. Only surface products that still have at least
        // one real enrollment — per the spec, this section is "deleted products
        // with active enrollments." Hidden products with zero enrollments are
        // re-added through the normal Add Product flow, not from here.
        const byProduct = new Map();
        for (const row of result.recordset || []) {
            if (!row.MemberId) continue;
            if (!byProduct.has(row.ProductId)) {
                byProduct.set(row.ProductId, {
                    productId: row.ProductId,
                    productName: row.ProductName,
                    members: []
                });
            }
            byProduct.get(row.ProductId).members.push({
                memberId: row.MemberId,
                fullName: row.FullName,
                enrolledDate: row.EnrolledDate
            });
        }
        const data = Array.from(byProduct.values()).map(p => ({
            ...p,
            enrollmentCount: p.members.length
        }));

        res.json({ success: true, data });
    } catch (error) {
        console.error('Error fetching hidden products with enrollments:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch hidden products with enrollments' });
    }
});

// PUT /api/groups/:groupId/products/:productId/deductible-config - Update deductible configuration for a group product
// For bundles: send allowedOptionsByProduct = { [includedProductId]: { fieldName: [options] } } so config is scoped per product.
// For single products: send allowedOptions = { fieldName: [options] }.
router.put('/:groupId/products/:productId/deductible-config', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId, productId } = req.params;
        const { allowedOptions, allowedOptionsByProduct } = req.body;
        
        const pool = await getPool();
        
        // Verify group exists and user has access
        const userRoles = getUserRoles(req.user);
        
        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId 
            FROM oe.Groups g 
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        // Check if GroupProduct exists
        const checkRequest = pool.request();
        checkRequest.input('groupId', sql.UniqueIdentifier, groupId);
        checkRequest.input('productId', sql.UniqueIdentifier, productId);
        
        const existingResult = await checkRequest.query(`
            SELECT GroupProductId, CustomSettings
            FROM oe.GroupProducts 
            WHERE GroupId = @groupId AND ProductId = @productId AND IsActive = 1
        `);
        
        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product is not assigned to this group'
            });
        }
        
        const existingSettings = existingResult.recordset[0].CustomSettings 
            ? JSON.parse(existingResult.recordset[0].CustomSettings) 
            : {};
        
        if (allowedOptionsByProduct != null && typeof allowedOptionsByProduct === 'object') {
            existingSettings.allowedDeductibleOptionsByProduct = allowedOptionsByProduct;
        } else if (allowedOptions != null && typeof allowedOptions === 'object') {
            existingSettings.allowedDeductibleOptions = allowedOptions;
        } else {
            return res.status(400).json({
                success: false,
                message: 'allowedOptions or allowedOptionsByProduct object is required'
            });
        }
        
        // Update the GroupProduct record
        const updateRequest = pool.request();
        updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
        updateRequest.input('productId', sql.UniqueIdentifier, productId);
        updateRequest.input('customSettings', sql.NVarChar, JSON.stringify(existingSettings));
        updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        
        await updateRequest.query(`
            UPDATE oe.GroupProducts 
            SET CustomSettings = @customSettings,
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE GroupId = @groupId AND ProductId = @productId AND IsActive = 1
        `);
        
        res.json({
            success: true,
            message: 'Deductible configuration updated successfully',
            data: {
                allowedOptions: allowedOptions
            }
        });
        
        console.log(`✅ Updated deductible configuration for product ${productId} in group ${groupId}`);
        
    } catch (error) {
        console.error('❌ Error updating deductible configuration:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update deductible configuration',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /:groupId/enrollment-link
// Returns the canonical reusable Group enrollment URL — same get-or-create logic
// the employee-facing PDFs use, so the agent's Copy/Open buttons hand out the
// exact link members will follow (LinkType=Agent-Static, GroupId set, no MemberId).
// Auth: SysAdmin, TenantAdmin, Agent (the roles that can already view the Products tab).
router.get('/:groupId/enrollment-link', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);

        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId, g.Name AS GroupName, g.AgentId
            FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }
        const group = groupResult.recordset[0];

        // Resolve base URL from the request so dev (localhost:5173) and prod
        // get the right origin, mirroring the employee-doc PDF flow.
        const baseUrlOverride = req.get('origin') || `${req.protocol}://${req.get('host')}`;
        const linkRes = await getOrCreateGroupEnrollmentLink(pool, group, req.user.UserId, baseUrlOverride);
        const linkRow = linkRes?.recordset?.[0];
        if (!linkRow) {
            return res.status(409).json({
                success: false,
                message: 'No active enrollment link template for this group. Assign at least one product to auto-create one.'
            });
        }

        // Prefer the short-code URL when present (members get a friendlier URL),
        // falling back to the linkToken URL the helper just inserted.
        const publicAppUrl = baseUrlOverride.replace(/\/+$/, '');
        let enrollmentUrl = '';
        if (linkRow.ShortCode) enrollmentUrl = `${publicAppUrl}/enroll-now/${linkRow.ShortCode}`;
        else if (linkRow.LinkUrl) enrollmentUrl = linkRow.LinkUrl;
        else if (linkRow.LinkToken) enrollmentUrl = `${publicAppUrl}/enroll/${linkRow.LinkToken}`;

        if (!enrollmentUrl) {
            return res.status(500).json({ success: false, message: 'Could not resolve enrollment URL.' });
        }

        return res.json({ success: true, data: { enrollmentUrl } });
    } catch (error) {
        console.error('❌ Error in /:groupId/enrollment-link:', error);
        res.status(500).json({ success: false, message: 'Failed to resolve group enrollment link' });
    }
});

module.exports = router;