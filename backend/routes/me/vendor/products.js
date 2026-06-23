// backend/routes/me/vendor/products.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const { authenticateUrls, authenticateProductDocumentsArray } = require('../../uploads');
const { getProductDocumentsForProductIds } = require('../../../services/shared/product-documents.service');

// Resolve human-readable config-field labels from a product's RequiredDataFields JSON.
function parseRequiredDataFieldLabels(raw) {
    if (!raw) return [];
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return [];
        const labels = [];
        for (const field of parsed) {
            const label = String(field?.fieldName || field?.label || field?.name || '').trim();
            if (label) labels.push(label);
            if (labels.length >= 5) break;
        }
        return labels;
    } catch (_) {
        return [];
    }
}

function withResolvedConfigFieldLabels(pricingRow, requiredDataFields) {
    const labels = parseRequiredDataFieldLabels(requiredDataFields);
    const row = { ...pricingRow };
    for (let i = 1; i <= 5; i += 1) {
        const fieldKey = `ConfigField${i}`;
        const valueKey = `ConfigValue${i}`;
        const hasLabel = String(row[fieldKey] ?? '').trim().length > 0;
        const hasValue = String(row[valueKey] ?? '').trim().length > 0;
        if (!hasLabel && hasValue && labels[i - 1]) {
            row[fieldKey] = labels[i - 1];
        }
    }
    return row;
}

// Returns the included products of a bundle, each with authenticated productDocuments.
async function loadAuthenticatedBundleProducts(pool, bundleProductId) {
    const req = pool.request();
    req.input('BundleProductId', sql.UniqueIdentifier, bundleProductId);
    const result = await req.query(`
        SELECT
            pb.IncludedProductId,
            pb.SortOrder,
            pb.IsRequired,
            p.Name AS ProductName,
            p.Description,
            p.ProductType,
            p.Status,
            p.ProductDocumentUrl,
            p.ProductLogoUrl,
            p.ProductImageUrl
        FROM oe.ProductBundles pb
        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
        WHERE pb.BundleProductId = @BundleProductId
          AND p.Status NOT IN ('Deleted')
        ORDER BY pb.SortOrder
    `);

    if (result.recordset.length === 0) return [];

    const includedIds = result.recordset.map((r) => r.IncludedProductId).filter(Boolean);
    const docsMap = includedIds.length > 0
        ? await getProductDocumentsForProductIds(pool, includedIds, sql)
        : new Map();

    return Promise.all(result.recordset.map(async (r) => {
        let docs = docsMap.get(r.IncludedProductId) || [];
        if (docs.length === 0 && r.ProductDocumentUrl && typeof r.ProductDocumentUrl === 'string' && r.ProductDocumentUrl.trim()) {
            docs = [{ documentUrl: r.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
        }
        if (docs.length > 0) {
            try { docs = await authenticateProductDocumentsArray(docs); }
            catch (e) { console.warn('⚠️ Failed to authenticate bundle product documents:', e.message); }
        }

        let logoUrl = r.ProductLogoUrl || r.ProductImageUrl || null;
        if (logoUrl) {
            try {
                const signed = await authenticateUrls({ url: logoUrl }, ['url']);
                logoUrl = signed.url;
            } catch (e) {
                console.warn('⚠️ Failed to authenticate bundle product logo:', e.message);
            }
        }

        return {
            productId: r.IncludedProductId,
            name: r.ProductName,
            productType: r.ProductType,
            description: r.Description,
            status: r.Status,
            isRequired: r.IsRequired === true,
            sortOrder: r.SortOrder ?? 0,
            productLogoUrl: logoUrl,
            productDocuments: docs,
        };
    }));
}

// GET vendor products (only products linked to this vendor)
router.get('/', authorize(['VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        // Get vendor ID from user
        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId
            FROM oe.Users
            WHERE UserId = @userId
        `);

        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found for this user'
            });
        }

        const vendorId = userResult.recordset[0].VendorId;
        const excludeBundles = ['1', 'true', 'yes'].includes(
            String(req.query.excludeBundles ?? req.query.nonBundleOnly ?? '').toLowerCase()
        );

        // Get products for this vendor
        const productsRequest = pool.request();
        productsRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const productsResult = await productsRequest.query(`
            SELECT
                p.ProductId,
                p.Name AS ProductName,
                p.Description,
                p.ProductType,
                p.SalesType,
                p.Status,
                p.IsBundle,
                p.IsVendorPrice,
                p.VendorCommission,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.MinAge,
                p.MaxAge,
                p.AllowedStates,
                p.RequiresTobaccoInfo,
                p.EffectiveDateLogic,
                p.MaxEffectiveDateDays,
                p.TerminationLogic,
                p.RequiredLicenses,
                p.CreatedDate,
                p.ModifiedDate,
                ISNULL(pricing.LatestMsrpRate, 0) AS Price
            FROM oe.Products p
            OUTER APPLY (
                SELECT TOP 1
                    pp.MSRPRate AS LatestMsrpRate
                FROM oe.ProductPricing pp
                WHERE pp.ProductId = p.ProductId
                  AND pp.Status = 'Active'
                ORDER BY
                    pp.EffectiveDate DESC,
                    pp.CreatedDate DESC
            ) pricing
            WHERE p.VendorId = @vendorId
              AND p.Status NOT IN ('Deleted')
              ${excludeBundles ? 'AND ISNULL(p.IsBundle, 0) = 0' : ''}
            ORDER BY p.Name
        `);

        const productIdsForDocs = productsResult.recordset.map((p) => p.ProductId).filter(Boolean);
        const documentsMap = productIdsForDocs.length > 0
            ? await getProductDocumentsForProductIds(pool, productIdsForDocs, sql)
            : new Map();

        const enriched = await Promise.all(productsResult.recordset.map(async (product) => {
            let row = { ...product };

            // Attach productDocuments (authenticated) — falls back to ProductDocumentUrl if no rows in oe.ProductDocuments
            let docs = documentsMap.get(product.ProductId) || [];
            if (docs.length === 0 && product.ProductDocumentUrl && typeof product.ProductDocumentUrl === 'string' && product.ProductDocumentUrl.trim()) {
                docs = [{ documentUrl: product.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
            }
            if (docs.length > 0) {
                try {
                    docs = await authenticateProductDocumentsArray(docs);
                } catch (e) {
                    console.warn('⚠️ Failed to authenticate vendor productDocuments:', e.message);
                }
            }
            row.productDocuments = docs;

            // Sign legacy single doc URL too
            if (row.ProductDocumentUrl) {
                try { row = await authenticateUrls(row, ['ProductDocumentUrl']); }
                catch (e) { console.warn('⚠️ Failed to authenticate ProductDocumentUrl:', e.message); }
            }
            // Sign image/logo URLs so blob loads succeed
            const imageFields = [];
            if (row.ProductImageUrl) imageFields.push('ProductImageUrl');
            if (row.ProductLogoUrl) imageFields.push('ProductLogoUrl');
            if (imageFields.length > 0) {
                try { row = await authenticateUrls(row, imageFields); }
                catch (e) { console.warn('⚠️ Failed to authenticate product image/logo URLs:', e.message); }
            }

            if (row.IsBundle === true) {
                try {
                    row.BundleProducts = await loadAuthenticatedBundleProducts(pool, row.ProductId);
                } catch (e) {
                    console.warn('⚠️ Failed to load bundle products for', row.ProductId, ':', e.message);
                    row.BundleProducts = [];
                }
            }

            return row;
        }));

        res.json({
            success: true,
            data: enriched
        });

    } catch (error) {
        console.error('Error fetching vendor products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor products',
            error: error.message
        });
    }
});

// GET single product
router.get('/:productId', authorize(['VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const { productId } = req.params;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        // Get vendor ID from user
        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId
            FROM oe.Users
            WHERE UserId = @userId
        `);

        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found for this user'
            });
        }

        const vendorId = userResult.recordset[0].VendorId;

        // Get product and verify it belongs to this vendor
        const productRequest = pool.request();
        productRequest.input('productId', sql.UniqueIdentifier, productId);
        productRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const productResult = await productRequest.query(`
            SELECT
                p.ProductId,
                p.Name AS ProductName,
                p.Description,
                p.ProductType,
                p.SalesType,
                p.Status,
                p.IsBundle,
                p.IsVendorPrice,
                p.VendorCommission,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.MinAge,
                p.MaxAge,
                p.AllowedStates,
                p.RequiresTobaccoInfo,
                p.EffectiveDateLogic,
                p.MaxEffectiveDateDays,
                p.TerminationLogic,
                p.RequiredLicenses,
                p.ProductQuestionnaires,
                p.CreatedDate,
                p.ModifiedDate
            FROM oe.Products p
            WHERE p.ProductId = @productId
              AND p.VendorId = @vendorId
              AND p.Status NOT IN ('Deleted')
        `);

        if (productResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found or access denied'
            });
        }

        let row = { ...productResult.recordset[0] };

        const docsMap = await getProductDocumentsForProductIds(pool, [row.ProductId], sql);
        let docs = docsMap.get(row.ProductId) || [];
        if (docs.length === 0 && row.ProductDocumentUrl && typeof row.ProductDocumentUrl === 'string' && row.ProductDocumentUrl.trim()) {
            docs = [{ documentUrl: row.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
        }
        if (docs.length > 0) {
            try { docs = await authenticateProductDocumentsArray(docs); }
            catch (e) { console.warn('⚠️ Failed to authenticate vendor productDocuments:', e.message); }
        }
        row.productDocuments = docs;

        if (row.ProductDocumentUrl) {
            try { row = await authenticateUrls(row, ['ProductDocumentUrl']); }
            catch (e) { console.warn('⚠️ Failed to authenticate ProductDocumentUrl:', e.message); }
        }
        const imageFields = [];
        if (row.ProductImageUrl) imageFields.push('ProductImageUrl');
        if (row.ProductLogoUrl) imageFields.push('ProductLogoUrl');
        if (imageFields.length > 0) {
            try { row = await authenticateUrls(row, imageFields); }
            catch (e) { console.warn('⚠️ Failed to authenticate product image/logo URLs:', e.message); }
        }

        if (row.IsBundle === true) {
            try {
                row.BundleProducts = await loadAuthenticatedBundleProducts(pool, row.ProductId);
            } catch (e) {
                console.warn('⚠️ Failed to load bundle products for', row.ProductId, ':', e.message);
                row.BundleProducts = [];
            }
        }

        res.json({
            success: true,
            data: row
        });

    } catch (error) {
        console.error('Error fetching vendor product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor product',
            error: error.message
        });
    }
});

// GET /api/me/vendor/products/:productId/pricing
// Returns active ProductPricing rows for a product the vendor owns. For a bundle,
// aggregates pricing from every IncludedProductId. Read-only — no tenant overrides
// or processing-fee enrichment, since the vendor portal does not need those.
router.get('/:productId/pricing', authorize(['VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const { productId } = req.params;

        if (!userId) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }

        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId
            FROM oe.Users
            WHERE UserId = @userId
        `);

        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        }

        const vendorId = userResult.recordset[0].VendorId;

        const ownerCheck = pool.request();
        ownerCheck.input('productId', sql.UniqueIdentifier, productId);
        ownerCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
        const ownerResult = await ownerCheck.query(`
            SELECT IsBundle
            FROM oe.Products
            WHERE ProductId = @productId
              AND VendorId = @vendorId
              AND Status NOT IN ('Deleted')
        `);

        if (ownerResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found or access denied' });
        }

        const isBundle = ownerResult.recordset[0].IsBundle === true;

        let pricingProductIds = [productId];
        if (isBundle) {
            const bundleReq = pool.request();
            bundleReq.input('bundleProductId', sql.UniqueIdentifier, productId);
            const bundleRes = await bundleReq.query(`
                SELECT IncludedProductId
                FROM oe.ProductBundles
                WHERE BundleProductId = @bundleProductId
            `);
            pricingProductIds = bundleRes.recordset.map((r) => r.IncludedProductId);
        }

        if (pricingProductIds.length === 0) {
            return res.json({ success: true, data: [] });
        }

        const rows = [];
        for (const pid of pricingProductIds) {
            const pricingReq = pool.request();
            pricingReq.input('pid', sql.UniqueIdentifier, pid);
            const pricingRes = await pricingReq.query(`
                SELECT
                    pp.ProductPricingId,
                    pp.ProductId,
                    pp.NetRate,
                    pp.OverrideRate,
                    pp.VendorCommission,
                    pp.SystemFees,
                    pp.MSRPRate,
                    pp.MinAge,
                    pp.MaxAge,
                    pp.TobaccoStatus,
                    pp.TierType,
                    pp.Label,
                    pp.ConfigField1, pp.ConfigField2, pp.ConfigField3, pp.ConfigField4, pp.ConfigField5,
                    pp.ConfigValue1, pp.ConfigValue2, pp.ConfigValue3, pp.ConfigValue4, pp.ConfigValue5,
                    pp.Status,
                    pp.EffectiveDate,
                    pp.TerminationDate,
                    p.Name AS ProductName,
                    p.RequiredDataFields
                FROM oe.ProductPricing pp
                INNER JOIN oe.Products p ON pp.ProductId = p.ProductId
                WHERE pp.ProductId = @pid
                  AND pp.Status = 'Active'
                ORDER BY pp.TierType, pp.Label, pp.TobaccoStatus, pp.MinAge
            `);
            for (const raw of pricingRes.recordset) {
                const resolved = withResolvedConfigFieldLabels(raw, raw.RequiredDataFields);
                rows.push({
                    ProductPricingId: resolved.ProductPricingId,
                    ProductId: resolved.ProductId,
                    ProductName: isBundle ? resolved.ProductName : null,
                    Label: resolved.Label || 'Standard',
                    TierType: resolved.TierType || null,
                    TobaccoStatus: resolved.TobaccoStatus || null,
                    MinAge: resolved.MinAge,
                    MaxAge: resolved.MaxAge,
                    NetRate: resolved.NetRate || 0,
                    MSRPRate: resolved.MSRPRate || 0,
                    VendorCommission: resolved.VendorCommission || 0,
                    SystemFees: resolved.SystemFees || 0,
                    ConfigField1: resolved.ConfigField1, ConfigValue1: resolved.ConfigValue1,
                    ConfigField2: resolved.ConfigField2, ConfigValue2: resolved.ConfigValue2,
                    ConfigField3: resolved.ConfigField3, ConfigValue3: resolved.ConfigValue3,
                    ConfigField4: resolved.ConfigField4, ConfigValue4: resolved.ConfigValue4,
                    ConfigField5: resolved.ConfigField5, ConfigValue5: resolved.ConfigValue5,
                    EffectiveDate: resolved.EffectiveDate,
                    TerminationDate: resolved.TerminationDate,
                    Status: resolved.Status,
                });
            }
        }

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching vendor product pricing:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch product pricing',
            error: error.message,
        });
    }
});

module.exports = router;
