const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const { authenticateUrls } = require('./uploads');
const { updateSetupStatus, getSetupSteps } = require('../services/setupStatus.service');
const { appendGroupScopeForTenantUsers, GROUP_DETAIL_READ_STATUS_SQL } = require('../utils/groupRouteAccess');
const { v4: uuidv4 } = require('uuid');

/** Normalize RequiredASA JSON so documentId is always camelCase for clients and FileUploads lookups. */
function normalizeAsaAgreementShape(ag) {
    if (!ag || typeof ag !== 'object') return;
    if (!ag.documentId && ag.DocumentId) {
        ag.documentId = ag.DocumentId;
    }
}

/**
 * GET /api/groups/:groupId/asa-status - Get ASA signature status for all products in a group
 */
router.get('/:groupId/asa-status', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();

        // Verify group exists and user has access
        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId, g.Name, g.Status, g.GroupType
            FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;

        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);

        // Add tenant filtering for non-SysAdmin users
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            groupCheckQuery += ' AND g.TenantId = @userTenantId';
            groupCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }

        const groupResult = await groupCheckRequest.query(groupCheckQuery);

        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        const group = groupResult.recordset[0];

        // ListBill groups bypass the ASA flow entirely — members enroll on individual
        // policies, so the carrier never receives a group-level ASA.
        if (group.GroupType === 'ListBill') {
            return res.json({
                success: true,
                data: {
                    groupId: group.GroupId,
                    groupName: group.Name,
                    notApplicable: true,
                    reason: 'List-Bill groups do not require ASA signing.',
                    products: [],
                    summary: {
                        productsRequiringASA: 0,
                        signedASAAgreements: 0,
                        asaCompletionPercentage: 100
                    }
                }
            });
        }
        
        // Get all products for this group with ASA requirements and signature status
        // NOTE: ASA signing is treated as "per document" (GroupId + DocumentId), not strictly per ProductId.
        // If multiple products reference the same RequiredASA.documentId, signing once covers them all.
        const asaStatusQuery = `
            SELECT 
                gp.ProductId,
                p.Name as ProductName,
                p.ProductType,
                p.RequiredASA,
                p.VendorId,
                v.VendorName,
                p.IsBundle,
                asa.AsaDocumentId,
                sasa.SignedAgreementId,
                sasa.SignedByEmail,
                sasa.SignedByName,
                sasa.SignedDate,
                sasa.Status as SignatureStatus,
                sasa.SignedDocumentUrl,
                CASE 
                    WHEN p.RequiredASA IS NOT NULL AND p.RequiredASA != '' THEN 1
                    ELSE 0
                END as RequiresASA,
                CASE 
                    WHEN sasa.SignedAgreementId IS NOT NULL THEN 1
                    ELSE 0
                END as IsSigned
            FROM oe.GroupProducts gp
            INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
            CROSS APPLY (
                SELECT
                    CASE
                        WHEN p.RequiredASA IS NOT NULL AND p.RequiredASA != '' AND ISJSON(p.RequiredASA) = 1
                            THEN TRY_CONVERT(uniqueidentifier, COALESCE(
                                JSON_VALUE(p.RequiredASA, '$.documentId'),
                                JSON_VALUE(p.RequiredASA, '$.DocumentId')
                            ))
                        ELSE NULL
                    END AS AsaDocumentId
            ) asa
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            LEFT JOIN (
                SELECT 
                    GroupId, 
                    DocumentId,
                    SignedAgreementId,
                    SignedByEmail,
                    SignedByName,
                    SignedDate,
                    Status,
                    SignedDocumentUrl,
                    ROW_NUMBER() OVER (PARTITION BY GroupId, DocumentId ORDER BY SignedDate DESC) as rn
                FROM oe.SignedASAAgreements 
                WHERE Status = 'Completed'
            ) sasa ON gp.GroupId = sasa.GroupId 
                AND asa.AsaDocumentId = sasa.DocumentId
                AND sasa.rn = 1
            WHERE gp.GroupId = @groupId 
                AND gp.IsActive = 1
                AND p.Status = 'Active'
            ORDER BY p.Name
        `;
        
        const asaStatusRequest = pool.request();
        asaStatusRequest.input('groupId', sql.UniqueIdentifier, groupId);
        const asaStatusResult = await asaStatusRequest.query(asaStatusQuery);
        
        // Process results to create a clean response
        const productsWithASAStatus = await Promise.all(asaStatusResult.recordset.map(async (product) => {
            let asaAgreement = null;
            if (product.RequiredASA) {
                try {
                    asaAgreement = typeof product.RequiredASA === 'string' 
                        ? JSON.parse(product.RequiredASA) 
                        : product.RequiredASA;
                    normalizeAsaAgreementShape(asaAgreement);
                    
                    // Reconstruct document URL from FileUploads to ensure we get the latest document
                    // This prevents issues where RequiredASA has an old documentUrl pointing to a different blob
                    if (asaAgreement && asaAgreement.documentId) {
                        try {
                            const fileQuery = `
                                SELECT StoredFileName, TenantId, FilePath, FileName
                                FROM oe.FileUploads
                                WHERE FileId = @documentId AND Status = 'Active'
                            `;
                            const fileRequest = pool.request();
                            fileRequest.input('documentId', sql.UniqueIdentifier, asaAgreement.documentId);
                            const fileResult = await fileRequest.query(fileQuery);
                            
                            if (fileResult.recordset.length > 0) {
                                const fileData = fileResult.recordset[0];
                                // Reconstruct the blob URL from StoredFileName
                                const { generateAuthenticatedUrl } = require('./uploads');
                                const blobPath = `agreements/${fileData.StoredFileName}`;
                                const reconstructedUrl = `https://oestorage.blob.core.windows.net/${blobPath}`;
                                
                                try {
                                    const authenticatedUrl = await generateAuthenticatedUrl(reconstructedUrl);
                                    asaAgreement.documentUrl = authenticatedUrl;
                                    // Update documentName if it changed
                                    if (fileData.FileName) {
                                        asaAgreement.documentName = fileData.FileName;
                                    }
                                    console.log(`✅ Reconstructed ASA document URL for product ${product.ProductId}: ${fileData.FileName}`);
                                } catch (authError) {
                                    console.warn('⚠️ Failed to authenticate reconstructed ASA document URL for product:', product.ProductId, authError.message);
                                    // Fall back to original URL if authentication fails
                                }
                            } else {
                                console.warn(`⚠️ Document ${asaAgreement.documentId} not found in FileUploads for product ${product.ProductId}`);
                                // Try to authenticate the existing URL as fallback
                                if (asaAgreement.documentUrl) {
                                    try {
                                        const authenticatedAsaAgreement = await authenticateUrls(asaAgreement, ['documentUrl']);
                                        asaAgreement.documentUrl = authenticatedAsaAgreement.documentUrl;
                                    } catch (authError) {
                                        console.warn('⚠️ Failed to authenticate fallback ASA document URL for product:', product.ProductId, authError.message);
                                    }
                                }
                            }
                        } catch (fileError) {
                            console.error('❌ Error reconstructing document URL from FileUploads for product:', product.ProductId, fileError.message);
                            // Fall back to authenticating the existing URL
                            if (asaAgreement && asaAgreement.documentUrl) {
                                try {
                                    const authenticatedAsaAgreement = await authenticateUrls(asaAgreement, ['documentUrl']);
                                    asaAgreement.documentUrl = authenticatedAsaAgreement.documentUrl;
                                } catch (authError) {
                                    console.warn('⚠️ Failed to authenticate fallback ASA document URL for product:', product.ProductId, authError.message);
                                }
                            }
                        }
                    } else if (asaAgreement && asaAgreement.documentUrl) {
                        // If no documentId, just authenticate the existing URL
                        try {
                            const authenticatedAsaAgreement = await authenticateUrls(asaAgreement, ['documentUrl']);
                            asaAgreement.documentUrl = authenticatedAsaAgreement.documentUrl;
                        } catch (authError) {
                            console.warn('⚠️ Failed to authenticate ASA document URL for product:', product.ProductId, authError.message);
                        }
                    }
                } catch (error) {
                    console.error('Error parsing RequiredASA for product:', product.ProductId, error);
                    asaAgreement = null;
                }
            }
            
            const baseProduct = {
                productId: product.ProductId,
                productName: product.ProductName,
                productType: product.ProductType,
                vendorId: product.VendorId,
                vendorName: product.VendorName,
                isBundle: product.IsBundle === 1 || product.IsBundle === true,
                requiresASA: product.RequiresASA === 1,
                asaAgreement: asaAgreement,
                isSigned: product.IsSigned === 1,
                signatureInfo: product.IsSigned === 1 ? {
                    signedAgreementId: product.SignedAgreementId,
                    signedByEmail: product.SignedByEmail,
                    signedByName: product.SignedByName,
                    signedDate: product.SignedDate,
                    status: product.SignatureStatus,
                    signedDocumentUrl: product.SignedDocumentUrl
                } : null,
                bundleProducts: []
            };
            
            // If this is a bundle, get included products and their ASA status
            if (baseProduct.isBundle) {
                try {
                    const bundleQuery = `
                        SELECT 
                            pb.IncludedProductId,
                            pb.SortOrder,
                            pb.IsRequired,
                            p.Name as ProductName,
                            p.ProductType,
                            p.RequiredASA,
                            p.VendorId,
                            v.VendorName,
                            asa.AsaDocumentId,
                            sasa.SignedAgreementId,
                            sasa.SignedByEmail,
                            sasa.SignedByName,
                            sasa.SignedDate,
                            sasa.Status as SignatureStatus,
                            sasa.SignedDocumentUrl,
                            CASE 
                                WHEN p.RequiredASA IS NOT NULL AND p.RequiredASA != '' THEN 1
                                ELSE 0
                            END as RequiresASA,
                            CASE 
                                WHEN sasa.SignedAgreementId IS NOT NULL THEN 1
                                ELSE 0
                            END as IsSigned
                        FROM oe.ProductBundles pb
                        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                        CROSS APPLY (
                            SELECT
                                CASE
                                    WHEN p.RequiredASA IS NOT NULL AND p.RequiredASA != '' AND ISJSON(p.RequiredASA) = 1
                                        THEN TRY_CONVERT(uniqueidentifier, COALESCE(
                                            JSON_VALUE(p.RequiredASA, '$.documentId'),
                                            JSON_VALUE(p.RequiredASA, '$.DocumentId')
                                        ))
                                    ELSE NULL
                                END AS AsaDocumentId
                        ) asa
                        LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
                        LEFT JOIN (
                            SELECT 
                                GroupId, 
                                DocumentId,
                                SignedAgreementId,
                                SignedByEmail,
                                SignedByName,
                                SignedDate,
                                Status,
                                SignedDocumentUrl,
                                ROW_NUMBER() OVER (PARTITION BY GroupId, DocumentId ORDER BY SignedDate DESC) as rn
                            FROM oe.SignedASAAgreements 
                            WHERE Status = 'Completed'
                        ) sasa ON @groupId = sasa.GroupId 
                            AND asa.AsaDocumentId = sasa.DocumentId
                            AND sasa.rn = 1
                        WHERE pb.BundleProductId = @bundleProductId
                            AND p.Status = 'Active'
                        ORDER BY pb.SortOrder
                    `;
                    
                    const bundleRequest = pool.request();
                    bundleRequest.input('groupId', sql.UniqueIdentifier, groupId);
                    bundleRequest.input('bundleProductId', sql.UniqueIdentifier, product.ProductId);
                    const bundleResult = await bundleRequest.query(bundleQuery);
                    
                    baseProduct.bundleProducts = await Promise.all(bundleResult.recordset.map(async (bundleProduct) => {
                        let bundleAsaAgreement = null;
                        if (bundleProduct.RequiredASA) {
                            try {
                                bundleAsaAgreement = typeof bundleProduct.RequiredASA === 'string' 
                                    ? JSON.parse(bundleProduct.RequiredASA) 
                                    : bundleProduct.RequiredASA;
                                normalizeAsaAgreementShape(bundleAsaAgreement);
                                
                                // Reconstruct document URL from FileUploads to ensure we get the latest document
                                if (bundleAsaAgreement && bundleAsaAgreement.documentId) {
                                    try {
                                        const fileQuery = `
                                            SELECT StoredFileName, TenantId, FilePath, FileName
                                            FROM oe.FileUploads
                                            WHERE FileId = @documentId AND Status = 'Active'
                                        `;
                                        const fileRequest = pool.request();
                                        fileRequest.input('documentId', sql.UniqueIdentifier, bundleAsaAgreement.documentId);
                                        const fileResult = await fileRequest.query(fileQuery);
                                        
                                        if (fileResult.recordset.length > 0) {
                                            const fileData = fileResult.recordset[0];
                                            const { generateAuthenticatedUrl } = require('./uploads');
                                            const blobPath = `agreements/${fileData.StoredFileName}`;
                                            const reconstructedUrl = `https://oestorage.blob.core.windows.net/${blobPath}`;
                                            
                                            try {
                                                const authenticatedUrl = await generateAuthenticatedUrl(reconstructedUrl);
                                                bundleAsaAgreement.documentUrl = authenticatedUrl;
                                                if (fileData.FileName) {
                                                    bundleAsaAgreement.documentName = fileData.FileName;
                                                }
                                            } catch (authError) {
                                                console.warn('⚠️ Failed to authenticate reconstructed bundle ASA document URL for product:', bundleProduct.IncludedProductId, authError.message);
                                            }
                                        } else {
                                            // Fall back to authenticating existing URL
                                            if (bundleAsaAgreement.documentUrl) {
                                                try {
                                                    const authenticatedBundleAsaAgreement = await authenticateUrls(bundleAsaAgreement, ['documentUrl']);
                                                    bundleAsaAgreement.documentUrl = authenticatedBundleAsaAgreement.documentUrl;
                                                } catch (authError) {
                                                    console.warn('⚠️ Failed to authenticate fallback bundle ASA document URL for product:', bundleProduct.IncludedProductId, authError.message);
                                                }
                                            }
                                        }
                                    } catch (fileError) {
                                        console.error('❌ Error reconstructing bundle document URL from FileUploads for product:', bundleProduct.IncludedProductId, fileError.message);
                                        // Fall back to authenticating existing URL
                                        if (bundleAsaAgreement && bundleAsaAgreement.documentUrl) {
                                            try {
                                                const authenticatedBundleAsaAgreement = await authenticateUrls(bundleAsaAgreement, ['documentUrl']);
                                                bundleAsaAgreement.documentUrl = authenticatedBundleAsaAgreement.documentUrl;
                                            } catch (authError) {
                                                console.warn('⚠️ Failed to authenticate fallback bundle ASA document URL for product:', bundleProduct.IncludedProductId, authError.message);
                                            }
                                        }
                                    }
                                } else if (bundleAsaAgreement && bundleAsaAgreement.documentUrl) {
                                    // If no documentId, just authenticate the existing URL
                                    try {
                                        const authenticatedBundleAsaAgreement = await authenticateUrls(bundleAsaAgreement, ['documentUrl']);
                                        bundleAsaAgreement.documentUrl = authenticatedBundleAsaAgreement.documentUrl;
                                    } catch (authError) {
                                        console.warn('⚠️ Failed to authenticate bundle ASA document URL for product:', bundleProduct.IncludedProductId, authError.message);
                                    }
                                }
                            } catch (error) {
                                console.error('Error parsing RequiredASA for bundle product:', bundleProduct.IncludedProductId, error);
                                bundleAsaAgreement = null;
                            }
                        }
                        
                        return {
                            productId: bundleProduct.IncludedProductId,
                            productName: bundleProduct.ProductName,
                            productType: bundleProduct.ProductType,
                            vendorId: bundleProduct.VendorId,
                            vendorName: bundleProduct.VendorName,
                            sortOrder: bundleProduct.SortOrder,
                            isRequired: bundleProduct.IsRequired,
                            requiresASA: bundleProduct.RequiresASA === 1,
                            asaAgreement: bundleAsaAgreement,
                            isSigned: bundleProduct.IsSigned === 1,
                            signatureInfo: bundleProduct.IsSigned === 1 ? {
                                signedAgreementId: bundleProduct.SignedAgreementId,
                                signedByEmail: bundleProduct.SignedByEmail,
                                signedByName: bundleProduct.SignedByName,
                                signedDate: bundleProduct.SignedDate,
                                status: bundleProduct.SignatureStatus,
                                signedDocumentUrl: bundleProduct.SignedDocumentUrl
                            } : null
                        };
                    }));
                    
                } catch (error) {
                    console.error('Error fetching bundle products for:', product.ProductId, error);
                    baseProduct.bundleProducts = [];
                }
            }
            
            return baseProduct;
        }));
        
        // Calculate summary statistics
        // IMPORTANT: ASA completion is tracked per unique ASA document (GroupId + documentId),
        // so if multiple products share the same RequiredASA.documentId, signing once covers all.
        const totalProducts = productsWithASAStatus.length;

        const requiredDocumentIds = new Set();
        const signedDocumentIds = new Set();

        const collectDoc = (item) => {
            if (!item?.requiresASA) return;
            const ag = item.asaAgreement;
            const docId = ag && (ag.documentId || ag.DocumentId);
            if (!docId) return;
            const key = String(docId).toLowerCase();
            requiredDocumentIds.add(key);
            if (item?.isSigned) {
                signedDocumentIds.add(key);
            }
        };

        productsWithASAStatus.forEach(product => {
            collectDoc(product);
            if (product?.isBundle && Array.isArray(product.bundleProducts)) {
                product.bundleProducts.forEach(bp => collectDoc(bp));
            }
        });

        const productsRequiringASA = requiredDocumentIds.size;
        const signedASAAgreements = signedDocumentIds.size;
        const pendingASAAgreements = Math.max(0, productsRequiringASA - signedASAAgreements);
        
        res.json({
            success: true,
            data: {
                groupId: group.GroupId,
                groupName: group.Name,
                summary: {
                    totalProducts,
                    productsRequiringASA,
                    signedASAAgreements,
                    pendingASAAgreements,
                    asaCompletionPercentage: productsRequiringASA > 0 
                        ? Math.round((signedASAAgreements / productsRequiringASA) * 100) 
                        : 100
                },
                products: productsWithASAStatus
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching ASA status:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching ASA status',
            error: {
                message: error.message,
                code: 'ASA_STATUS_ERROR'
            }
        });
    }
});

/**
 * GET /api/groups/:groupId/asa-status/:productId - Get ASA signature status for a specific product
 */
router.get('/:groupId/asa-status/:productId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId, productId } = req.params;
        const pool = await getPool();
        
        // Verify group and product exist and user has access
        let groupProductCheckQuery = `
            SELECT
                g.GroupId,
                g.TenantId,
                g.Name as GroupName,
                g.GroupType,
                p.ProductId,
                p.Name as ProductName,
                p.ProductType,
                p.RequiredASA,
                p.VendorId,
                v.VendorName
            FROM oe.Groups g
            INNER JOIN oe.Products p ON p.ProductId = @productId
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            WHERE g.GroupId = @groupId
                AND ${GROUP_DETAIL_READ_STATUS_SQL}
                AND p.Status = 'Active'
                AND (
                    EXISTS (
                        SELECT 1
                        FROM oe.GroupProducts gp
                        WHERE gp.GroupId = g.GroupId
                          AND gp.ProductId = p.ProductId
                          AND gp.IsActive = 1
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM oe.GroupProducts gpBundle
                        INNER JOIN oe.ProductBundles pb
                          ON pb.BundleProductId = gpBundle.ProductId
                        WHERE gpBundle.GroupId = g.GroupId
                          AND gpBundle.IsActive = 1
                          AND pb.IncludedProductId = p.ProductId
                    )
                )
        `;
        
        const groupProductCheckRequest = pool.request();
        groupProductCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupProductCheckRequest.input('productId', sql.UniqueIdentifier, productId);
        
        // Add tenant filtering for non-SysAdmin users
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            groupProductCheckQuery += ' AND g.TenantId = @userTenantId';
            groupProductCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const groupProductResult = await groupProductCheckRequest.query(groupProductCheckQuery);
        
        if (groupProductResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group or product not found or access denied'
            });
        }
        
        const groupProduct = groupProductResult.recordset[0];

        // ListBill groups bypass ASA — short-circuit per-product check too.
        if (groupProduct.GroupType === 'ListBill') {
            return res.json({
                success: true,
                data: {
                    groupId: groupProduct.GroupId,
                    groupName: groupProduct.GroupName,
                    productId: groupProduct.ProductId,
                    productName: groupProduct.ProductName,
                    notApplicable: true,
                    reason: 'List-Bill groups do not require ASA signing.',
                    requiresASA: false,
                    isSigned: true
                }
            });
        }

        // Check if this product requires ASA
        const requiresASA = groupProduct.RequiredASA && groupProduct.RequiredASA !== '';
        let asaAgreement = null;
        
        if (requiresASA) {
            try {
                asaAgreement = typeof groupProduct.RequiredASA === 'string' 
                    ? JSON.parse(groupProduct.RequiredASA) 
                    : groupProduct.RequiredASA;
            } catch (error) {
                console.error('Error parsing RequiredASA for product:', productId, error);
                asaAgreement = null;
            }
        }
        
        // Get signature status if ASA is required
        let signatureInfo = null;
        if (requiresASA) {
            const asaDocumentId = asaAgreement?.documentId;
            if (asaDocumentId) {
            const signatureQuery = `
                SELECT TOP 1
                    SignedAgreementId,
                    SignedByEmail,
                    SignedByName,
                    SignedDate,
                    Status,
                    SignedDocumentUrl
                FROM oe.SignedASAAgreements
                WHERE GroupId = @groupId 
                    AND DocumentId = @documentId
                    AND Status = 'Completed'
                ORDER BY SignedDate DESC
            `;
            
            const signatureRequest = pool.request();
            signatureRequest.input('groupId', sql.UniqueIdentifier, groupId);
            signatureRequest.input('documentId', sql.UniqueIdentifier, asaDocumentId);
            const signatureResult = await signatureRequest.query(signatureQuery);
            
            if (signatureResult.recordset.length > 0) {
                const signature = signatureResult.recordset[0];
                signatureInfo = {
                    signedAgreementId: signature.SignedAgreementId,
                    signedByEmail: signature.SignedByEmail,
                    signedByName: signature.SignedByName,
                    signedDate: signature.SignedDate,
                    status: signature.Status,
                    signedDocumentUrl: signature.SignedDocumentUrl
                };
            }
            }
        }
        
        res.json({
            success: true,
            data: {
                groupId: groupProduct.GroupId,
                groupName: groupProduct.GroupName,
                productId: groupProduct.ProductId,
                productName: groupProduct.ProductName,
                productType: groupProduct.ProductType,
                vendorId: groupProduct.VendorId,
                vendorName: groupProduct.VendorName,
                requiresASA,
                asaAgreement,
                isSigned: signatureInfo !== null,
                signatureInfo
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching ASA status for product:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching ASA status for product',
            error: {
                message: error.message,
                code: 'ASA_PRODUCT_STATUS_ERROR'
            }
        });
    }
});

// POST /api/groups/:groupId/asa-sign - Sign an ASA agreement for a specific product
router.post('/:groupId/asa-sign', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { productId, signatureData, signerName, signerEmail, signedDocumentUrl } = req.body;

        console.log('📝 ASA Signature submission for group product:', {
            groupId,
            productId,
            signerName,
            signerEmail,
            hasSignature: !!signatureData,
            isTemplateBased: signatureData === 'template-based',
            hasSignedDocumentUrl: !!signedDocumentUrl
        });

        // Validate required fields
        if (!productId || !signerName || !signerEmail) {
            return res.status(400).json({
                success: false,
                message: 'Product ID, signer name, and email are required'
            });
        }

        // For template-based signing, signedDocumentUrl is required
        if (signatureData === 'template-based' && !signedDocumentUrl) {
            return res.status(400).json({
                success: false,
                message: 'Signed document URL is required for template-based signing'
            });
        }

        // For basic signing, signatureData is required
        if (signatureData !== 'template-based' && !signatureData) {
            return res.status(400).json({
                success: false,
                message: 'Signature data is required'
            });
        }

        const pool = await getPool();

        // Reject ASA signing attempts on List-Bill groups outright.
        const groupTypeRow = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`SELECT GroupType FROM oe.Groups WHERE GroupId = @groupId`);
        if (groupTypeRow.recordset[0]?.GroupType === 'ListBill') {
            return res.status(400).json({
                success: false,
                message: 'List-Bill groups do not require ASA signing. Convert the group to Standard first if you intend to sign an ASA.',
                code: 'ASA_NOT_APPLICABLE_LISTBILL'
            });
        }

        // Get group and product info to validate access and get vendor info.
        // IMPORTANT: support BOTH:
        // - products assigned directly to the group (oe.GroupProducts)
        // - products included inside an assigned bundle (oe.ProductBundles)
        let groupProductQuery = `
            SELECT
                g.GroupId,
                g.TenantId,
                g.Name as GroupName,
                p.ProductId,
                p.Name as ProductName,
                p.RequiredASA,
                p.VendorId,
                v.VendorName
            FROM oe.Groups g
            INNER JOIN oe.Products p ON p.ProductId = @productId
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            WHERE g.GroupId = @groupId
                AND g.Status = 'Active'
                AND p.Status = 'Active'
                AND p.RequiredASA IS NOT NULL
                AND p.RequiredASA != ''
                AND (
                    EXISTS (
                        SELECT 1
                        FROM oe.GroupProducts gp
                        WHERE gp.GroupId = g.GroupId
                          AND gp.ProductId = p.ProductId
                          AND gp.IsActive = 1
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM oe.GroupProducts gpBundle
                        INNER JOIN oe.ProductBundles pb
                          ON pb.BundleProductId = gpBundle.ProductId
                        WHERE gpBundle.GroupId = g.GroupId
                          AND gpBundle.IsActive = 1
                          AND pb.IncludedProductId = p.ProductId
                    )
                )
        `;
        
        const groupProductRequest = pool.request();
        groupProductRequest.input('groupId', sql.UniqueIdentifier, groupId);
        groupProductRequest.input('productId', sql.UniqueIdentifier, productId);
        
        // Add tenant filtering for non-SysAdmin users
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            groupProductQuery += ' AND g.TenantId = @userTenantId';
            groupProductRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const groupProductResult = await groupProductRequest.query(groupProductQuery);
        
        if (groupProductResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group, product not found, or product does not require ASA'
            });
        }
        
        const groupProduct = groupProductResult.recordset[0];
        
        // Parse the RequiredASA JSON to get document info
        let asaAgreement = null;
        try {
            asaAgreement = typeof groupProduct.RequiredASA === 'string' 
                ? JSON.parse(groupProduct.RequiredASA) 
                : groupProduct.RequiredASA;
        } catch (error) {
            console.error('Error parsing RequiredASA for product:', productId, error);
            return res.status(400).json({
                success: false,
                message: 'Invalid ASA agreement configuration for this product'
            });
        }

        if (!asaAgreement || !asaAgreement.documentId || !asaAgreement.documentUrl) {
            return res.status(400).json({
                success: false,
                message: 'ASA agreement document not properly configured for this product'
            });
        }

        // Get document metadata from FileUploads table for PDF generation
        let vendorDocument = {
            FileId: asaAgreement.documentId,
            FileName: asaAgreement.documentName,
            FilePath: asaAgreement.documentUrl,
            MimeType: 'application/pdf'
        };

        // Try to get the actual blob path from FileUploads table
        if (asaAgreement.documentId) {
            try {
                const fileQuery = `
                    SELECT StoredFileName, FilePath, TenantId, UploadType, FileName
                    FROM oe.FileUploads
                    WHERE FileId = @documentId AND Status = 'Active'
                `;
                const fileRequest = pool.request();
                fileRequest.input('documentId', sql.UniqueIdentifier, asaAgreement.documentId);
                const fileResult = await fileRequest.query(fileQuery);
                
                if (fileResult.recordset.length > 0) {
                    const fileData = fileResult.recordset[0];
                    if (fileData.StoredFileName && fileData.TenantId) {
                        let blobPath;
                        if (fileData.UploadType === 'agentAgreement' || fileData.UploadType === 'agreements') {
                            blobPath = `agent-agreements/${fileData.TenantId}/${fileData.StoredFileName}`;
                        } else {
                            blobPath = `agent-agreements/${fileData.TenantId}/${fileData.StoredFileName}`;
                        }
                        
                        vendorDocument = {
                            ...vendorDocument,
                            StoredFileName: fileData.StoredFileName,
                            TenantId: fileData.TenantId,
                            BlobPath: blobPath,
                            UploadType: fileData.UploadType
                        };
                    }
                }
            } catch (fileError) {
                console.warn('⚠️ Could not fetch document from FileUploads, using URL directly:', fileError.message);
            }
        }

        // Handle template-based signing vs basic signing
        let uploadedUrl;
        let fileName;
        let fileSize = 0;

        if (signatureData === 'template-based' && signedDocumentUrl) {
            // Template-based signing: use the provided signed document URL
            console.log('📝 Using template-based signed document URL');
            uploadedUrl = signedDocumentUrl.split('?')[0]; // Remove query params for storage
            fileName = `asa-agreement-${groupId}-${productId}-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.pdf`;
            
            // Download the signed PDF to get its actual size
            try {
                const { BlobServiceClient } = require('@azure/storage-blob');
                const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
                if (connectionString) {
                    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
                    const urlObj = new URL(signedDocumentUrl.split('?')[0]); // Use base URL without SAS token
                    const pathParts = urlObj.pathname.split('/').filter(p => p);
                    const containerName = pathParts[0];
                    const blobName = pathParts.slice(1).join('/');
                    
                    const containerClient = blobServiceClient.getContainerClient(containerName);
                    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
                    
                    // Get blob properties to get size
                    const properties = await blockBlobClient.getProperties();
                    fileSize = properties.contentLength || 0;
                    console.log(`📏 Signed PDF size: ${fileSize} bytes`);
                }
            } catch (sizeError) {
                console.warn('⚠️ Could not get signed PDF size, using default:', sizeError.message);
                // Keep default fileSize of 0
            }
        } else {
            // Basic signing: generate PDF and upload
            console.log('📝 Generating signed PDF using basic signature');
            const { generateASAAgreementPDF } = require('./group-onboarding');
            
            const signedPdfBase64 = await generateASAAgreementPDF(
                vendorDocument,
                signatureData,
                signerName,
                signerEmail,
                groupProduct.GroupName
            );

            // Upload signed document to blob storage
            const { uploadToAzureBlob } = require('./uploads');
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
            fileName = `asa-agreement-${groupId}-${productId}-${timestamp}.pdf`;
            
            const fileObject = {
                buffer: Buffer.from(signedPdfBase64, 'base64'),
                originalname: fileName,
                mimetype: 'application/pdf',
                size: Buffer.from(signedPdfBase64, 'base64').length
            };

            fileSize = fileObject.size;
            uploadedUrl = await uploadToAzureBlob(fileObject, 'asa-signatures', fileName);
        }

        // Capture IP address and user agent from request headers (more secure than client-provided)
        const ipAddress = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || '127.0.0.1';
        const userAgent = req.headers['user-agent'] || 'Unknown';
        
        // Insert the signed agreement record (SignedAgreementId is auto-generated)
        const insertSignatureQuery = `
            INSERT INTO oe.SignedASAAgreements (
                GroupId,
                ProductId,
                VendorId,
                DocumentId,
                SignedByEmail,
                SignedByName,
                SignedDate,
                Status,
                SignatureData,
                SignedDocumentUrl,
                CreatedDate,
                IpAddress,
                UserAgent
            )
            OUTPUT INSERTED.SignedAgreementId
            VALUES (
                @groupId,
                @productId,
                @vendorId,
                @documentId,
                @signedByEmail,
                @signedByName,
                @signedDate,
                @status,
                @signatureData,
                @signedDocumentUrl,
                @createdDate,
                @ipAddress,
                @userAgent
            )
        `;
        
        // Remove query parameters (SAS token) from uploadedUrl to store base URL only
        // We'll generate fresh SAS tokens on-demand when retrieving/downloading
        const { isBlobUrl } = require('./uploads');
        let baseBlobUrl = uploadedUrl;
        if (uploadedUrl && isBlobUrl(uploadedUrl)) {
            // Remove query parameters to get base URL (SAS tokens expire, so we store base URL)
            baseBlobUrl = uploadedUrl.split('?')[0];
            console.log('📄 Storing base blob URL (without SAS token) for signed ASA document');
        }
        
        // Authenticate the signed document URL for SignedASAAgreements table (for immediate download)
        const { generateAuthenticatedUrl } = require('./uploads');
        let authenticatedSignedDocumentUrl = uploadedUrl;
        if (uploadedUrl && isBlobUrl(uploadedUrl)) {
            try {
                authenticatedSignedDocumentUrl = await generateAuthenticatedUrl(uploadedUrl);
                console.log('🔐 Authenticated signed document URL for SignedASAAgreements table');
            } catch (error) {
                console.warn('❌ Failed to authenticate signed document URL:', error.message);
            }
        }
        
        const insertRequest = pool.request();
        insertRequest.input('groupId', sql.UniqueIdentifier, groupId);
        insertRequest.input('productId', sql.UniqueIdentifier, productId);
        insertRequest.input('vendorId', sql.UniqueIdentifier, groupProduct.VendorId);
        insertRequest.input('documentId', sql.UniqueIdentifier, asaAgreement.documentId);
        insertRequest.input('signedByEmail', sql.NVarChar, signerEmail);
        insertRequest.input('signedByName', sql.NVarChar, signerName);
        insertRequest.input('signedDate', sql.DateTime2, new Date());
        insertRequest.input('status', sql.NVarChar, 'Completed');
        insertRequest.input('signatureData', sql.NVarChar(sql.MAX), signatureData);
        insertRequest.input('signedDocumentUrl', sql.NVarChar(500), authenticatedSignedDocumentUrl);
        
        insertRequest.input('createdDate', sql.DateTime2, new Date());
        insertRequest.input('ipAddress', sql.NVarChar(45), ipAddress);
        insertRequest.input('userAgent', sql.NVarChar(500), userAgent);
        
        const insertResult = await insertRequest.query(insertSignatureQuery);
        const signedAgreementId = insertResult.recordset[0]?.SignedAgreementId || null;
        
        // Create FileUploads entry for the signed ASA document (store base URL without SAS token)
        const fileUploadId = uuidv4();
        const storedFileName = `${fileUploadId}_${fileName}`;
        const insertFileUploadQuery = `
            INSERT INTO oe.FileUploads (
                FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
                UploadType, EntityId, Category, Description, UploadedBy, TenantId, Status, CreatedDate
            ) VALUES (
                @fileUploadId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
                @uploadType, @entityId, @category, @description, @uploadedBy, @tenantId, @status, @createdDate
            )
        `;
        
        const fileUploadRequest = pool.request();
        fileUploadRequest.input('fileUploadId', sql.UniqueIdentifier, fileUploadId);
        fileUploadRequest.input('fileName', sql.NVarChar, fileName);
        fileUploadRequest.input('storedFileName', sql.NVarChar, storedFileName);
        fileUploadRequest.input('filePath', sql.NVarChar, baseBlobUrl); // Store base URL without SAS token
        fileUploadRequest.input('fileSize', sql.Int, fileSize);
        fileUploadRequest.input('mimeType', sql.NVarChar, 'application/pdf');
        fileUploadRequest.input('uploadType', sql.NVarChar, 'documents');
        fileUploadRequest.input('entityId', sql.NVarChar, groupId);
        fileUploadRequest.input('category', sql.NVarChar, 'ASASigned');
        fileUploadRequest.input('description', sql.NVarChar, `Signed ASA Agreement for ${groupProduct.ProductName}`);
        fileUploadRequest.input('uploadedBy', sql.UniqueIdentifier, req.user.UserId);
        fileUploadRequest.input('tenantId', sql.UniqueIdentifier, groupProduct.TenantId);
        fileUploadRequest.input('status', sql.NVarChar, 'Active');
        fileUploadRequest.input('createdDate', sql.DateTime2, new Date());
        
        await fileUploadRequest.query(insertFileUploadQuery);
        
        console.log('✅ Signed ASA document saved to FileUploads:', {
            fileUploadId,
            fileName,
            groupId,
            productId
        });
        
        console.log('✅ ASA signature saved successfully:', {
            signedAgreementId,
            groupId,
            productId,
            signerName,
            signerEmail,
            ipAddress: ipAddress
        });

        // Fire asa_signed vendor scheduled job(s) async so admin/portal signing also emails
        // the configured recipients with the signed PDF. Safe no-op if no jobs configured.
        if (signedAgreementId) {
            setImmediate(() => {
                try {
                    const { runAsaSignedTrigger } = require('../services/asaSignedTriggerService');
                    runAsaSignedTrigger(signedAgreementId).then((r) => {
                        if (r && r.triggered > 0) {
                            console.log('📧 asa_signed trigger finished:', { signedAgreementId, triggered: r.triggered });
                        }
                        if (r && r.errors && r.errors.length > 0) {
                            console.warn('⚠️ asa_signed trigger had errors:', { signedAgreementId, errors: r.errors });
                        }
                    }).catch((err) => {
                        console.warn('⚠️ asa_signed trigger failed:', { signedAgreementId, error: err.message });
                    });
                } catch (reqErr) {
                    console.warn('⚠️ Could not start asa_signed trigger:', reqErr.message);
                }
            });
        }

        res.json({
            success: true,
            data: {
                signedAgreementId,
                signedDocumentUrl: authenticatedSignedDocumentUrl,
                signedDate: new Date().toISOString(),
                signerName,
                signerEmail
            },
            message: 'ASA agreement signed successfully'
        });

    } catch (error) {
        console.error('❌ Error signing ASA agreement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while signing ASA agreement'
        });
    }
});

// GET /api/groups/:id/setup-steps - Fast verification of setup step status (single query)
router.get('/:id/setup-steps', authorize(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const pool = await getPool();

        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        const userRoles = getUserRoles(req.user);
        groupCheckQuery = appendGroupScopeForTenantUsers(groupCheckQuery, groupCheckRequest, req, userRoles);
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }

        const steps = await getSetupSteps(groupId);
        if (!steps) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }

        res.json({ success: true, data: steps });
    } catch (error) {
        console.error('Error fetching setup steps:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching setup steps' });
    }
});

// GET /api/groups/:id/enrollment-links - Get enrollment links for a group
router.get('/:id/enrollment-links', authorize(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), async (req, res) => {
    try {
        const { id: groupId } = req.params;
        const pool = await getPool();
        
        // Get enrollment links for this group
        const enrollmentLinksRequest = pool.request();
        enrollmentLinksRequest.input('groupId', sql.UniqueIdentifier, groupId);
        
        const enrollmentLinksResult = await enrollmentLinksRequest.query(`
            SELECT 
                el.LinkId,
                el.LinkToken,
                el.LinkUrl,
                el.Description,
                el.ExpiresAt,
                el.IsActive,
                el.UsageCount,
                el.MaxUsage,
                el.CreatedDate,
                el.ModifiedDate,
                el.CreatedBy,
                el.ModifiedBy,
                el.MemberId,
                el.EarliestEffectiveDate,
                u.FirstName,
                u.LastName,
                u.Email
            FROM oe.EnrollmentLinks el
            LEFT JOIN oe.Members m ON el.MemberId = m.MemberId
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            WHERE el.GroupId = @groupId
            ORDER BY el.CreatedDate DESC
        `);
        
        const enrollmentLinks = enrollmentLinksResult.recordset.map(link => ({
            linkId: link.LinkId,
            linkToken: link.LinkToken,
            linkUrl: link.LinkUrl,
            description: link.Description,
            expiresAt: link.ExpiresAt,
            isActive: link.IsActive,
            usageCount: link.UsageCount,
            maxUsage: link.MaxUsage,
            createdDate: link.CreatedDate,
            modifiedDate: link.ModifiedDate,
            createdBy: link.CreatedBy,
            modifiedBy: link.ModifiedBy,
            memberId: link.MemberId,
            earliestEffectiveDate: link.EarliestEffectiveDate,
            memberName: link.FirstName && link.LastName ? `${link.FirstName} ${link.LastName}` : null,
            memberEmail: link.Email,
            status: link.UsageCount >= link.MaxUsage ? 'Used' : 
                   !link.IsActive ? 'Inactive' : 
                   new Date(link.ExpiresAt) < new Date() ? 'Expired' : 'Active'
        }));
        
        // Update setup status if enrollment links exist
        if (enrollmentLinks.length > 0) {
            try {
                await updateSetupStatus(groupId);
                console.log(`✅ Updated setup status for group ${groupId} after finding ${enrollmentLinks.length} enrollment links`);
            } catch (error) {
                console.warn('⚠️ Failed to update setup status:', error.message);
            }
        }
        
        res.json({
            success: true,
            data: enrollmentLinks
        });
        
    } catch (error) {
        console.error('Error fetching enrollment links for group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrollment links'
        });
    }
});

module.exports = router;
