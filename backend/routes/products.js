//@ts-check
// backend/routes/products.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authenticate, getUserRoles, authorize } = require('../middleware/auth');
const sharedRequireTenantAccess = require('../middleware/requireTenantAccess');
const { BlobServiceClient } = require('@azure/storage-blob');
const { authenticateProductUrls, processNestedImageUrls } = require('./uploads');
const { v4: uuidv4 } = require('uuid');
const { MAX_UPLOAD_FILE_BYTES } = require('../constants/uploadLimits');
const { enqueueExtraction } = require('../services/extractionQueue');
const { ensureTenantProductSubscription } = require('../utils/tenantProductSubscriptionEnsure');

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

// Initialize Azure Blob Service Client for file operations
let blobServiceClient;
try {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (connectionString) {
        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    }
} catch (error) {
    console.error('❌ Failed to initialize Azure Blob Storage client:', error.message);
}

const includedProcessingFeeUtil = require('../utils/includedProcessingFee');
const { resolveMsrpAndIncludedFromWizardBand } = require('../utils/productMsrpBandSave');
const { isBundleProductFlag, resolveProductVendorId } = require('../utils/productBundleVendor');

const toBoolProductFlag = (v) =>
    v === true || v === 'true' || v === 1 || v === '1' || v === 'yes';

async function computeIncludedProcessingFeeForBandSave(
    poolOrTransaction,
    productOwnerId,
    msrpValue,
    includeProcessingFee,
    roundUpProcessingFee,
    processingFeePercentage
) {
    if (!toBoolProductFlag(includeProcessingFee) || !productOwnerId) return 0;
    const req = poolOrTransaction.request();
    req.input('tenantId', sql.UniqueIdentifier, productOwnerId);
    const tenantRes = await req.query(`
        SELECT TOP 1 PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId
    `);
    let paymentProcessorSettings = null;
    const raw = tenantRes.recordset?.[0]?.PaymentProcessorSettings;
    if (raw) {
        try {
            paymentProcessorSettings = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (_) {}
    }
    const pct =
        processingFeePercentage != null && String(processingFeePercentage).trim() !== ''
            ? parseFloat(processingFeePercentage)
            : null;
    return includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay(
        Number(msrpValue || 0),
        paymentProcessorSettings,
        roundUpProcessingFee !== false,
        {
            paymentMethod: 'Highest',
            processingFeePercentage: pct != null && !Number.isNaN(pct) ? pct : null,
            // Catalog IncludeProcessingFee is independent of tenant chargeFeeToMember at checkout.
            ignoreChargeFeeToMember: true
        }
    );
}

/** Component sum (net+override+commission+systemFees) + optional included fee → persisted MSRPRate. */
async function resolveMsrpAndIncludedForBandSave(
    poolOrTransaction,
    productOwnerId,
    componentSum,
    includeProcessingFee,
    roundUpProcessingFee,
    processingFeePercentage,
    band = null
) {
    const fromWizard = resolveMsrpAndIncludedFromWizardBand(componentSum, includeProcessingFee, band);
    if (fromWizard) return fromWizard;

    const includedFee = await computeIncludedProcessingFeeForBandSave(
        poolOrTransaction,
        productOwnerId,
        componentSum,
        includeProcessingFee,
        roundUpProcessingFee,
        processingFeePercentage
    );
    const base = Number(componentSum || 0);
    const msrpRate =
        toBoolProductFlag(includeProcessingFee) && includedFee > 0
            ? Math.round((base + includedFee) * 100) / 100
            : base;
    return { msrpRate, includedFee };
}

const DEFAULT_SYSTEM_FEES = {
    platformFee: { name: "Platform Fee", amount: 2.5, type: "fixed" },
    transactionFee: { name: "Transaction Fee", amount: 0.5, type: "fixed" },
    processingFee: { name: "Processing Fee", amount: 1.0, type: "fixed" }
};

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize EligibilityVendorGroupFallbackProductId: null/empty clears; must be same vendor as product, not self.
 * @returns {{ value: string | null } | { error: string }}
 */
async function normalizeEligibilityVendorGroupFallbackProductId(pool, vendorId, productId, raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { value: null };
    }
    const s = String(raw).trim();
    if (!GUID_REGEX.test(s)) {
        return { error: 'Invalid eligibility vendor group fallback product id' };
    }
    if (productId && s.toLowerCase() === String(productId).toLowerCase()) {
        return { error: 'Fallback product cannot be the same as this product' };
    }
    const req = pool.request();
    req.input('Fid', sql.UniqueIdentifier, s);
    const r = await req.query(`SELECT VendorId FROM oe.Products WHERE ProductId = @Fid`);
    if (!r.recordset || r.recordset.length === 0) {
        return { error: 'Fallback product not found' };
    }
    if (String(r.recordset[0].VendorId).toLowerCase() !== String(vendorId).toLowerCase()) {
        return { error: 'Fallback product must belong to the same vendor' };
    }
    return { value: s };
}

// Helper function to check user permissions
const requireTenantAccess = (allowedRoles = []) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        // Check if user has one of the allowed roles
        const userRoles = getUserRoles(req.user);
        if (allowedRoles.length > 0 && !allowedRoles.some(r => userRoles.includes(r))) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions',
                required: allowedRoles,
                current: userRoles
            });
        }

        next();
    };
};

// Helper function to delete files from blob storage
const deleteFileFromBlob = async (fileUrl) => {
    if (!blobServiceClient || !fileUrl) return;

    try {
        // Extract container and blob name from URL
        // Remove query parameters (SAS tokens) if present
        const urlWithoutQuery = fileUrl.split('?')[0];
        const urlParts = urlWithoutQuery.split('/');
        const containerName = urlParts[urlParts.length - 2];
        const blobName = urlParts[urlParts.length - 1];

        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.deleteIfExists();
        console.log(`✅ Deleted file from blob storage: ${blobName}`);
    } catch (error) {
        console.error('❌ Error deleting file from blob storage:', error);
    }
};

// Helper function to generate SAS URL for authenticated blob access
const generateSASUrl = (containerName, blobName, permissions = 'r', expiresInMinutes = 60) => {
    if (!blobServiceClient) {
        throw new Error('Azure Blob Storage client not initialized');
    }

    const { generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    // Set expiration time
    const expiresOn = new Date();
    expiresOn.setMinutes(expiresOn.getMinutes() + expiresInMinutes);
    
    // Generate SAS token
    const sasToken = generateBlobSASQueryParameters({
        containerName: containerName,
        blobName: blobName,
        permissions: BlobSASPermissions.parse(permissions),
        expiresOn: expiresOn,
        startsOn: new Date()
    }, blobServiceClient.credential).toString();
    
    return `${blockBlobClient.url}?${sasToken}`;
};

// Helper function to get document metadata from Azure Blob Storage
const getDocumentMetadata = async (documentUrl) => {
    if (!blobServiceClient || !documentUrl) {
        return null;
    }

    try {
        // Extract container and blob name from URL
        const urlParts = documentUrl.split('/');
        const containerName = urlParts[urlParts.length - 2];
        const blobName = urlParts[urlParts.length - 1].split('?')[0]; // Remove SAS token if present
        
        // Validate that we have valid container and blob names
        if (!containerName || !blobName) {
            return null;
        }
        
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        // Get blob properties and metadata
        const properties = await blockBlobClient.getProperties();
        
        return {
            originalName: properties.metadata?.originalName || properties.metadata?.originalname || null,
            uploadedBy: properties.metadata?.uploadedBy || properties.metadata?.uploadedby || null,
            contentType: properties.contentType || null,
            contentLength: properties.contentLength || null,
            lastModified: properties.lastModified || null
        };
    } catch (error) {
        console.error('❌ Error fetching document metadata:', error);
        return null;
    }
};

/**
 * Queue a document for AI extraction after insert/update.
 * Sets ExtractionStatus='queued', calls enqueueExtraction, and on failure marks as 'failed' with error message.
 * @param {object} pool - Database connection pool
 * @param {object} sql - MSSQL sql module
 * @param {object} options - Options object
 * @param {string} options.productDocumentId - ID of the document
 * @param {string} options.productId - ID of the product
 * @param {string} options.tenantId - ID of the tenant
 * @param {string} options.blobUrl - URL of the document in blob storage
 * @param {string} options.fileName - Display name of the document
 */
async function queueDocumentExtraction(pool, sql, { productDocumentId, productId, tenantId, blobUrl, fileName }) {
    // Fire-and-forget — must never block the HTTP hot path. The INSERT that created
    // this ProductDocuments row already set ExtractionStatus='queued', so the UI shows
    // the right state immediately. On send failure we flip the row to 'failed' in the
    // background; the user can re-trigger from the chunks UI.
    try {
        await enqueueExtraction({
            productDocumentId,
            productId,
            tenantId,
            blobUrl,
            fileName,
        });
    } catch (queueErr) {
        console.warn('[products] enqueue extraction failed:', queueErr.message);
        try {
            await pool.request()
                .input('ProductDocumentId', sql.UniqueIdentifier, productDocumentId)
                .input('Err', sql.NVarChar, String(queueErr).slice(0, 2000))
                .query(`UPDATE oe.ProductDocuments
                        SET ExtractionStatus='failed', ExtractionError=@Err
                        WHERE ProductDocumentId=@ProductDocumentId`);
        } catch (markErr) {
            console.warn('[products] also failed to mark failed:', markErr.message);
        }
    }
}

/**
 * GET /api/products
 * Get all products (with optional filtering)
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const pool = await getPool();
        
        const query = `
            SELECT 
                p.ProductId, 
                p.Name, 
                p.Description, 
                p.ProductType, 
                p.SalesType, 
                p.IsBundle, 
                p.Status, 
                p.MinAge, 
                p.MaxAge, 
                p.CreatedDate,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.AllowedStates,
                p.RequiresTobaccoInfo,
                p.EffectiveDateLogic,
                p.RequiredLicenses,
                p.VendorId,
                p.IsVendorPrice,
                p.VendorCommission,
                p.VendorGroupIdProductType,
                p.EligibilityIndividualVendorGroupId,
                p.PlanId,
                t.Name as ProductOwnerName, 
                t.TenantId as ProductOwnerId,
                v.VendorName as VendorName
            FROM oe.Products p
            JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            WHERE p.Status = 'Active'
            ORDER BY p.CreatedDate DESC
        `;
        
        const result = await pool.request().query(query);
        
        // Authenticate blob URLs for all products
        const authenticatedProducts = await Promise.all(
            result.recordset.map(product => authenticateProductUrls(product))
        );
        
        res.json({ 
            success: true, 
            products: authenticatedProducts 
        });
        
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch products' 
        });
    }
});

/**
 * POST /api/products/batch
 * Get multiple products by IDs (batch request)
 * Accepts: { productIds: string[] }
 * Returns: { success: boolean, products: Array<{ ProductId, Name, ProductOwnerId, ... }> }
 */
router.post('/batch', authenticate, async (req, res) => {
    try {
        const { productIds } = req.body;
        
        if (!Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'productIds must be a non-empty array'
            });
        }
        
        // Limit batch size to prevent abuse
        if (productIds.length > 100) {
            return res.status(400).json({
                success: false,
                message: 'Maximum 100 productIds allowed per batch request'
            });
        }
        
        const pool = await getPool();
        const request = pool.request();
        
        // Convert productIds to unique identifiers and filter out invalid ones
        const validProductIds = productIds.filter(id => id && typeof id === 'string');
        
        if (validProductIds.length === 0) {
            return res.json({
                success: true,
                products: []
            });
        }
        
        // Build IN clause with parameterized values
        let inClause = '';
        validProductIds.forEach((productId, index) => {
            const paramName = `ProductId${index}`;
            request.input(paramName, sql.UniqueIdentifier, productId);
            inClause += (index > 0 ? ', ' : '') + `@${paramName}`;
        });
        
        const query = `
            SELECT 
                p.ProductId,
                p.Name,
                p.ProductOwnerId,
                p.VendorId,
                p.Status,
                p.ProductType,
                p.IsBundle,
                t.Name as ProductOwnerName,
                v.VendorName
            FROM oe.Products p
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            WHERE p.ProductId IN (${inClause})
        `;
        
        const result = await request.query(query);
        
        // Authenticate blob URLs for all products
        const authenticatedProducts = await Promise.all(
            result.recordset.map(product => authenticateProductUrls(product))
        );
        
        res.json({
            success: true,
            products: authenticatedProducts
        });
    } catch (error) {
        console.error('Error fetching products batch:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch products batch',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * POST /api/products/:id/duplicate
 * SysAdmin: deep-copy a product into another tenant (new ProductId, pricing tiers, documents, bundles, AI chunks).
 * Reuses blob URLs for images and documents. Does not copy tenant-specific ProductOverrides.
 */
router.post('/:id/duplicate', authenticate, requireTenantAccess(['SysAdmin']), async (req, res) => {
    const sourceProductId = req.params.id;
    const { targetTenantId, name: requestedName } = req.body || {};

    if (!GUID_REGEX.test(sourceProductId)) {
        return res.status(400).json({ success: false, message: 'Invalid source product id' });
    }
    if (!targetTenantId || !GUID_REGEX.test(String(targetTenantId))) {
        return res.status(400).json({ success: false, message: 'targetTenantId is required and must be a valid GUID' });
    }

    const pool = await getPool();

    const srcReq = pool.request();
    srcReq.input('ProductId', sql.UniqueIdentifier, sourceProductId);
    const srcResult = await srcReq.query(`SELECT * FROM oe.Products WHERE ProductId = @ProductId`);
    if (!srcResult.recordset || srcResult.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Source product not found' });
    }
    const s = srcResult.recordset[0];

    const tenantCheck = pool.request();
    tenantCheck.input('TenantId', sql.UniqueIdentifier, targetTenantId);
    const tenantResult = await tenantCheck.query(`SELECT TenantId FROM oe.Tenants WHERE TenantId = @TenantId AND Status IN ('Active', 'Pending')`);
    if (!tenantResult.recordset || tenantResult.recordset.length === 0) {
        return res.status(400).json({ success: false, message: 'Target tenant not found or inactive' });
    }

    const newProductId = uuidv4();
    const sameTenant =
        String(s.ProductOwnerId).toLowerCase() === String(targetTenantId).toLowerCase();
    const defaultName = sameTenant ? `${s.Name} (Copy)` : s.Name;
    const trimmedName = typeof requestedName === 'string' ? requestedName.trim() : '';
    const newName = trimmedName || defaultName;
    if (!newName) {
        return res.status(400).json({ success: false, message: 'Product name is required' });
    }

    const srcIsBundle = s.IsBundle === true || s.IsBundle === 1;
    const fbNorm = srcIsBundle
        ? { value: null, error: null }
        : await normalizeEligibilityVendorGroupFallbackProductId(
            pool,
            s.VendorId,
            newProductId,
            s.EligibilityVendorGroupFallbackProductId
        );
    if (fbNorm.error) {
        return res.status(400).json({ success: false, message: fbNorm.error });
    }

    const transaction = pool.transaction();
    try {
        await transaction.begin();

        const ins = transaction.request();
        ins.input('ProductId', sql.UniqueIdentifier, newProductId);
        ins.input('VendorId', sql.UniqueIdentifier, resolveProductVendorId(s.IsBundle, s.VendorId));
        ins.input('IsVendorPrice', sql.Bit, s.IsVendorPrice === true || s.IsVendorPrice === 1);
        ins.input('VendorCommission', sql.Decimal(19, 4), s.VendorCommission != null ? parseFloat(s.VendorCommission) : 0);
        ins.input('ProductOwnerId', sql.UniqueIdentifier, targetTenantId);
        ins.input('Name', sql.NVarChar, newName);
        ins.input('Description', sql.NVarChar, s.Description || '');
        ins.input('ProductType', sql.NVarChar, s.ProductType);
        ins.input('Status', sql.NVarChar, s.Status || 'Active');
        ins.input('IsMarketplaceProduct', sql.Bit, s.IsMarketplaceProduct === true || s.IsMarketplaceProduct === 1);
        ins.input('IsPublic', sql.Bit, s.IsPublic === true || s.IsPublic === 1);
        ins.input('IsHidden', sql.Bit, s.IsHidden === true || s.IsHidden === 1);
        ins.input('IsSSNRequired', sql.Bit, s.IsSSNRequired === true || s.IsSSNRequired === 1);
        ins.input('IsBundle', sql.Bit, s.IsBundle === true || s.IsBundle === 1);
        ins.input('ProductImageUrl', sql.NVarChar(sql.MAX), s.ProductImageUrl || null);
        ins.input('ProductLogoUrl', sql.NVarChar(sql.MAX), s.ProductLogoUrl || null);
        ins.input('ProductDocumentUrl', sql.NVarChar(sql.MAX), s.ProductDocumentUrl || null);
        ins.input('MinAge', sql.Int, s.MinAge != null ? parseInt(s.MinAge, 10) : null);
        ins.input('MaxAge', sql.Int, s.MaxAge != null ? parseInt(s.MaxAge, 10) : null);
        ins.input('AllowedStates', sql.NVarChar(sql.MAX), s.AllowedStates || null);
        ins.input('SalesType', sql.NVarChar, s.SalesType || 'Both');
        ins.input('RequiresTobaccoInfo', sql.Bit, s.RequiresTobaccoInfo === true || s.RequiresTobaccoInfo === 1);
        ins.input('EffectiveDateLogic', sql.NVarChar, s.EffectiveDateLogic || 'FirstOfMonth');
        ins.input('MaxEffectiveDateDays', sql.Int, s.MaxEffectiveDateDays != null ? parseInt(s.MaxEffectiveDateDays, 10) : 60);
        ins.input('TerminationLogic', sql.NVarChar(sql.MAX), s.TerminationLogic || null);
        ins.input('RequiredLicenses', sql.NVarChar(sql.MAX), s.RequiredLicenses || null);
        ins.input('RequiredDataFields', sql.NVarChar(sql.MAX), s.RequiredDataFields || null);
        ins.input('AcknowledgementQuestions', sql.NVarChar(sql.MAX), s.AcknowledgementQuestions || null);
        ins.input('ProductQuestionnaires', sql.NVarChar(sql.MAX), s.ProductQuestionnaires || null);
        ins.input('IDCardData', sql.NVarChar(sql.MAX), s.IDCardData || null);
        ins.input('PlanDetailsData', sql.NVarChar(sql.MAX), s.PlanDetailsData || null);
        ins.input('RequiredASA', sql.NVarChar(sql.MAX), s.RequiredASA || null);
        ins.input('TrainingConfig', sql.NVarChar(sql.MAX), s.TrainingConfig || null);
        ins.input('MedicalNeedsLinksConfig', sql.NVarChar(sql.MAX), s.MedicalNeedsLinksConfig || null);
        ins.input('VendorGroupIdProductType', sql.NVarChar(50), s.VendorGroupIdProductType != null ? String(s.VendorGroupIdProductType) : null);
        ins.input('EligibilityIndividualVendorGroupId', sql.NVarChar(50), s.EligibilityIndividualVendorGroupId?.trim?.() || s.EligibilityIndividualVendorGroupId || null);
        ins.input('EligibilityVendorGroupFallbackProductId', sql.UniqueIdentifier, fbNorm.value || null);
        ins.input('PremiumReportingCategory', sql.NVarChar(20), s.PremiumReportingCategory === 'NonProfit' ? 'NonProfit' : 'ForProfit');
        ins.input('IDCardMemberIdPrefixMask', sql.NVarChar(10), s.IDCardMemberIdPrefixMask != null && String(s.IDCardMemberIdPrefixMask).trim() !== ''
            ? String(s.IDCardMemberIdPrefixMask).trim().slice(0, 10)
            : null);
        ins.input('PlanId', sql.NVarChar(100), s.PlanId != null && String(s.PlanId).trim() !== '' ? String(s.PlanId).trim() : null);
        ins.input('SourceProductId', sql.UniqueIdentifier, sourceProductId);
        ins.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
        ins.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
        const now = new Date();
        ins.input('CreatedDate', sql.DateTime2, now);
        ins.input('ModifiedDate', sql.DateTime2, now);
        ins.input('EffectiveDate', sql.Date, now);

        await ins.query(`
            INSERT INTO oe.Products (
                ProductId, VendorId, IsVendorPrice, VendorCommission, ProductOwnerId,
                Name, Description, ProductType, Status,
                IsMarketplaceProduct, IsPublic, IsHidden, IsSSNRequired, IsBundle, ProductImageUrl, ProductLogoUrl,
                ProductDocumentUrl, MinAge, MaxAge, AllowedStates, SalesType,
                RequiresTobaccoInfo, EffectiveDateLogic, MaxEffectiveDateDays, TerminationLogic,
                RequiredLicenses, RequiredDataFields, AcknowledgementQuestions, ProductQuestionnaires,
                IDCardData, PlanDetailsData, RequiredASA, TrainingConfig, MedicalNeedsLinksConfig, VendorGroupIdProductType, EligibilityIndividualVendorGroupId, EligibilityVendorGroupFallbackProductId,
                PremiumReportingCategory, IDCardMemberIdPrefixMask, PlanId, SourceProductId,
                CreatedBy, ModifiedBy, CreatedDate, ModifiedDate, EffectiveDate
            ) VALUES (
                @ProductId, @VendorId, @IsVendorPrice, @VendorCommission, @ProductOwnerId,
                @Name, @Description, @ProductType, @Status,
                @IsMarketplaceProduct, @IsPublic, @IsHidden, @IsSSNRequired, @IsBundle, @ProductImageUrl, @ProductLogoUrl,
                @ProductDocumentUrl, @MinAge, @MaxAge, @AllowedStates, @SalesType,
                @RequiresTobaccoInfo, @EffectiveDateLogic, @MaxEffectiveDateDays, @TerminationLogic,
                @RequiredLicenses, @RequiredDataFields, @AcknowledgementQuestions, @ProductQuestionnaires,
                @IDCardData, @PlanDetailsData, @RequiredASA, @TrainingConfig, @MedicalNeedsLinksConfig, @VendorGroupIdProductType, @EligibilityIndividualVendorGroupId, @EligibilityVendorGroupFallbackProductId,
                @PremiumReportingCategory, @IDCardMemberIdPrefixMask, @PlanId, @SourceProductId,
                @CreatedBy, @ModifiedBy, @CreatedDate, @ModifiedDate, @EffectiveDate
            )
        `);

        // ProductDocuments — same URLs, new row ids
        try {
            const docsList = await pool.request()
                .input('ProductId', sql.UniqueIdentifier, sourceProductId)
                .query(`
                    SELECT ProductDocumentId, DocumentUrl, DisplayName, SortOrder
                    FROM oe.ProductDocuments
                    WHERE ProductId = @ProductId
                    ORDER BY SortOrder ASC, CreatedDate ASC
                `);
            for (const doc of docsList.recordset || []) {
                if (!doc.DocumentUrl) continue;
                const docReq = transaction.request();
                const docId = uuidv4();
                docReq.input('ProductDocumentId', sql.UniqueIdentifier, docId);
                docReq.input('ProductId', sql.UniqueIdentifier, newProductId);
                docReq.input('DocumentUrl', sql.NVarChar(500), doc.DocumentUrl);
                docReq.input('DisplayName', sql.NVarChar(255), doc.DisplayName || null);
                docReq.input('SortOrder', sql.Int, doc.SortOrder ?? 0);
                docReq.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
                docReq.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
                await docReq.query(`
                    INSERT INTO oe.ProductDocuments (ProductDocumentId, ProductId, DocumentUrl, DisplayName, SortOrder, CreatedBy, ModifiedBy)
                    VALUES (@ProductDocumentId, @ProductId, @DocumentUrl, @DisplayName, @SortOrder, @CreatedBy, @ModifiedBy)
                `);
            }
        } catch (docErr) {
            console.warn('⚠️ ProductDocuments duplicate skipped:', docErr.message);
        }

        // ProductPricing — new ids, same rates
        const prReq = pool.request();
        prReq.input('ProductId', sql.UniqueIdentifier, sourceProductId);
        const prRows = await prReq.query(`SELECT * FROM oe.ProductPricing WHERE ProductId = @ProductId`);
        for (const pr of prRows.recordset || []) {
            const pIns = transaction.request();
            const newPricingId = uuidv4();
            pIns.input('ProductPricingId', sql.UniqueIdentifier, newPricingId);
            pIns.input('ProductId', sql.UniqueIdentifier, newProductId);
            pIns.input('PricingName', sql.NVarChar, pr.PricingName || '');
            pIns.input('Label', sql.NVarChar, pr.Label || null);
            pIns.input('NetRate', sql.Decimal(19, 4), pr.NetRate != null ? parseFloat(pr.NetRate) : 0);
            pIns.input('OverrideRate', sql.Decimal(19, 4), pr.OverrideRate != null ? parseFloat(pr.OverrideRate) : 0);
            pIns.input('VendorCommission', sql.Decimal(19, 4), pr.VendorCommission != null ? parseFloat(pr.VendorCommission) : 0);
            pIns.input('SystemFees', sql.Decimal(19, 4), pr.SystemFees != null ? parseFloat(pr.SystemFees) : 0);
            pIns.input('MSRPRate', sql.Decimal(19, 4), pr.MSRPRate != null ? parseFloat(pr.MSRPRate) : 0);
            pIns.input('MinAge', sql.Int, pr.MinAge != null ? parseInt(pr.MinAge, 10) : null);
            pIns.input('MaxAge', sql.Int, pr.MaxAge != null ? parseInt(pr.MaxAge, 10) : null);
            pIns.input('TierType', sql.NVarChar, pr.TierType || '');
            pIns.input('TobaccoStatus', sql.NVarChar, pr.TobaccoStatus || 'No');
            pIns.input('ConfigValue1', sql.NVarChar, pr.ConfigValue1 || null);
            pIns.input('ConfigValue2', sql.NVarChar, pr.ConfigValue2 || null);
            pIns.input('ConfigValue3', sql.NVarChar, pr.ConfigValue3 || null);
            pIns.input('ConfigValue4', sql.NVarChar, pr.ConfigValue4 || null);
            pIns.input('ConfigValue5', sql.NVarChar, pr.ConfigValue5 || null);
            pIns.input('Locked', sql.Bit, pr.Locked === true || pr.Locked === 1);
            pIns.input('EffectiveDate', sql.Date, pr.EffectiveDate ? new Date(pr.EffectiveDate) : now);
            pIns.input('TerminationDate', sql.Date, pr.TerminationDate ? new Date(pr.TerminationDate) : null);
            pIns.input('Status', sql.NVarChar, pr.Status || 'Active');
            pIns.input('CreatedDate', sql.DateTime2, now);
            pIns.input('ModifiedDate', sql.DateTime2, now);
            pIns.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
            pIns.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
            await pIns.query(`
                INSERT INTO oe.ProductPricing (
                    ProductPricingId, ProductId, PricingName, Label, NetRate, OverrideRate, VendorCommission, SystemFees, MSRPRate,
                    MinAge, MaxAge, TierType, TobaccoStatus,
                    ConfigValue1, ConfigValue2, ConfigValue3, ConfigValue4, ConfigValue5,
                    Locked, EffectiveDate, TerminationDate, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                ) VALUES (
                    @ProductPricingId, @ProductId, @PricingName, @Label, @NetRate, @OverrideRate, @VendorCommission, @SystemFees, @MSRPRate,
                    @MinAge, @MaxAge, @TierType, @TobaccoStatus,
                    @ConfigValue1, @ConfigValue2, @ConfigValue3, @ConfigValue4, @ConfigValue5,
                    @Locked, @EffectiveDate, @TerminationDate, @Status, @CreatedDate, @ModifiedDate, @CreatedBy, @ModifiedBy
                )
            `);
        }

        // AIChunks
        const chRows = await pool.request()
            .input('ProductId', sql.UniqueIdentifier, sourceProductId)
            .query(`SELECT ChunkText, ChunkType, Source, Question, Title, SystemArea, IsActive, Status FROM oe.AIChunks WHERE ProductId = @ProductId`);
        for (const ch of chRows.recordset || []) {
            const cIns = transaction.request();
            cIns.input('AIChunkId', sql.UniqueIdentifier, uuidv4());
            cIns.input('ProductId', sql.UniqueIdentifier, newProductId);
            cIns.input('TenantId', sql.UniqueIdentifier, targetTenantId);
            cIns.input('SystemArea', sql.NVarChar, ch.SystemArea || 'Product');
            cIns.input('ChunkText', sql.NVarChar(sql.MAX), ch.ChunkText || '');
            cIns.input('ChunkType', sql.NVarChar, ch.ChunkType || 'prose');
            cIns.input('Source', sql.NVarChar, ch.Source || 'manual');
            cIns.input('Question', sql.NVarChar, ch.Question || null);
            cIns.input('Title', sql.NVarChar, ch.Title || null);
            cIns.input('IsActive', sql.Bit, ch.IsActive === true || ch.IsActive === 1);
            cIns.input('Status', sql.NVarChar, ch.Status || 'Active');
            cIns.input('CreatedDate', sql.DateTime2, now);
            cIns.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
            await cIns.query(`
                INSERT INTO oe.AIChunks (
                    AIChunkId, ProductId, TenantId, SystemArea, ChunkText, ChunkType, Source, Question, Title,
                    IsActive, Status, CreatedDate, CreatedBy
                ) VALUES (
                    @AIChunkId, @ProductId, @TenantId, @SystemArea, @ChunkText, @ChunkType, @Source, @Question, @Title,
                    @IsActive, @Status, @CreatedDate, @CreatedBy
                )
            `);
        }

        // ProductBundles (same included product ids)
        if (s.IsBundle === true || s.IsBundle === 1) {
            const bRows = await pool.request()
                .input('BundleProductId', sql.UniqueIdentifier, sourceProductId)
                .query(`
                    SELECT IncludedProductId, SortOrder, IsRequired, HidePricing, LinkedToProductId, AllowedConfigOptions
                    FROM oe.ProductBundles
                    WHERE BundleProductId = @BundleProductId
                    ORDER BY SortOrder
                `);
            for (const b of bRows.recordset || []) {
                const bIns = transaction.request();
                bIns.input('ProductBundleId', sql.UniqueIdentifier, uuidv4());
                bIns.input('BundleProductId', sql.UniqueIdentifier, newProductId);
                bIns.input('IncludedProductId', sql.UniqueIdentifier, b.IncludedProductId);
                bIns.input('SortOrder', sql.Int, b.SortOrder ?? 0);
                bIns.input('IsRequired', sql.Bit, b.IsRequired === true || b.IsRequired === 1);
                bIns.input('HidePricing', sql.Bit, b.HidePricing === true || b.HidePricing === 1);
                bIns.input('LinkedToProductId', sql.UniqueIdentifier, b.LinkedToProductId || null);
                bIns.input('AllowedConfigOptions', sql.NVarChar(sql.MAX),
                    typeof b.AllowedConfigOptions === 'string' ? b.AllowedConfigOptions : (b.AllowedConfigOptions ? JSON.stringify(b.AllowedConfigOptions) : null));
                bIns.input('CreatedDate', sql.DateTime2, now);
                await bIns.query(`
                    INSERT INTO oe.ProductBundles (
                        ProductBundleId, BundleProductId, IncludedProductId,
                        SortOrder, IsRequired, HidePricing, LinkedToProductId, AllowedConfigOptions, CreatedDate
                    ) VALUES (
                        @ProductBundleId, @BundleProductId, @IncludedProductId,
                        @SortOrder, @IsRequired, @HidePricing, @LinkedToProductId, @AllowedConfigOptions, @CreatedDate
                    )
                `);
            }
        }

        // Owner subscriptions (same as product create)
        const ownerSystemFeesRequest = transaction.request();
        ownerSystemFeesRequest.input('tenantId', sql.UniqueIdentifier, targetTenantId);
        const ownerSystemFeesResult = await ownerSystemFeesRequest.query(`
            SELECT SystemFees FROM oe.Tenants WHERE TenantId = @tenantId
        `);
        const rawOwnerSystemFees = ownerSystemFeesResult.recordset[0]?.SystemFees;
        const ownerSystemFees = typeof rawOwnerSystemFees === 'string'
            ? rawOwnerSystemFees
            : JSON.stringify(rawOwnerSystemFees || DEFAULT_SYSTEM_FEES);

        const tenantSubscriptionCheck = transaction.request();
        tenantSubscriptionCheck.input('tenantId', sql.UniqueIdentifier, targetTenantId);
        tenantSubscriptionCheck.input('productId', sql.UniqueIdentifier, newProductId);
        const existingTenantSubscription = await tenantSubscriptionCheck.query(`
            SELECT SubscriptionId FROM oe.TenantProductSubscriptions
            WHERE TenantId = @tenantId AND ProductId = @productId
        `);
        if (existingTenantSubscription.recordset.length === 0) {
            const tenantSubscriptionId = uuidv4();
            const createTenantSubscription = transaction.request();
            createTenantSubscription.input('subscriptionId', sql.UniqueIdentifier, tenantSubscriptionId);
            createTenantSubscription.input('tenantId', sql.UniqueIdentifier, targetTenantId);
            createTenantSubscription.input('productId', sql.UniqueIdentifier, newProductId);
            createTenantSubscription.input('subscriptionStatus', sql.NVarChar(50), 'Active');
            createTenantSubscription.input('tenantRate', sql.Decimal(19, 4), 0);
            createTenantSubscription.input('systemFeesSnapshot', sql.NVarChar, ownerSystemFees);
            createTenantSubscription.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
            createTenantSubscription.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
            createTenantSubscription.input('subscriptionDate', sql.DateTime2, now);
            createTenantSubscription.input('modifiedDate', sql.DateTime2, now);
            createTenantSubscription.input('isConfigured', sql.Bit, 0);
            await createTenantSubscription.query(`
                INSERT INTO oe.TenantProductSubscriptions (
                    SubscriptionId, TenantId, ProductId, SubscriptionStatus, TenantRate, SystemFeesSnapshot,
                    CreatedBy, ModifiedBy, SubscriptionDate, ModifiedDate, IsConfigured
                ) VALUES (
                    @subscriptionId, @tenantId, @productId, @subscriptionStatus, @tenantRate, @systemFeesSnapshot,
                    @createdBy, @modifiedBy, @subscriptionDate, @modifiedDate, @isConfigured
                )
            `);
        }

        const existingProductSubscription = await transaction.request()
            .input('tenantId', sql.UniqueIdentifier, targetTenantId)
            .input('productId', sql.UniqueIdentifier, newProductId)
            .query(`
                SELECT ProductSubscriptionId FROM oe.ProductSubscriptions
                WHERE TenantId = @tenantId AND ProductId = @productId
            `);
        if (existingProductSubscription.recordset.length === 0) {
            const productSubscriptionId = uuidv4();
            const createProductSubscription = transaction.request();
            createProductSubscription.input('productSubscriptionId', sql.UniqueIdentifier, productSubscriptionId);
            createProductSubscription.input('productId', sql.UniqueIdentifier, newProductId);
            createProductSubscription.input('tenantId', sql.UniqueIdentifier, targetTenantId);
            createProductSubscription.input('status', sql.NVarChar(20), 'Approved');
            createProductSubscription.input('requestDate', sql.DateTime2, now);
            createProductSubscription.input('approvalDate', sql.DateTime2, now);
            createProductSubscription.input('discountAmount', sql.Decimal(19, 4), 0);
            createProductSubscription.input('serviceFeePerMember', sql.Decimal(19, 4), 0);
            createProductSubscription.input('notes', sql.NVarChar(sql.MAX), 'Duplicated from product ' + sourceProductId);
            createProductSubscription.input('approvedBy', sql.UniqueIdentifier, req.user.UserId);
            createProductSubscription.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
            createProductSubscription.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
            await createProductSubscription.query(`
                INSERT INTO oe.ProductSubscriptions (
                    ProductSubscriptionId, ProductId, TenantId, Status, RequestDate, ApprovalDate,
                    DiscountAmount, DiscountEffectiveDate, DiscountEndDate, ServiceFeePerMember, Notes, ApprovedBy,
                    CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                ) VALUES (
                    @productSubscriptionId, @productId, @tenantId, @status, @requestDate, @approvalDate,
                    @discountAmount, NULL, NULL, @serviceFeePerMember, @notes, @approvedBy,
                    GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
                )
            `);
        }

        await transaction.commit();

        return res.status(201).json({
            success: true,
            productId: newProductId,
            sourceProductId,
            message: 'Product duplicated successfully'
        });
    } catch (err) {
        try {
            await transaction.rollback();
        } catch (rbErr) {
            console.error('Rollback error:', rbErr);
        }
        console.error('❌ Duplicate product error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to duplicate product',
            error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
        });
    }
});

/**
 * GET /api/products/:id/pricing-export
 * SysAdmin: export pricing tiers for any product as XLSX.
 */
router.get('/:id/pricing-export', authenticate, requireTenantAccess(['SysAdmin']), async (req, res) => {
    try {
        const { id: productId } = req.params;
        const { buildPricingWorkbook } = require('../services/pricing/pricingExport.service');
        const result = await buildPricingWorkbook(productId, null, { sysAdmin: true });

        if (result.error === 'not_found') {
            return res.status(404).json({ success: false, message: 'Product not found' });
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
        console.error('❌ SysAdmin pricing export error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to export pricing',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * GET /api/products/:id/subscribers
 * List tenant subscribers for a product (SysAdmin or product owner).
 */
router.get('/:id/subscribers', authenticate, authorize(['SysAdmin', 'TenantAdmin']), sharedRequireTenantAccess, async (req, res) => {
    try {
        const productId = req.params.id;
        const pool = await getPool();
        const {
            listProductSubscribers,
            assertProductSubscriberManagementAccess
        } = require('../services/tenantProductSubscriptionCancel.service');

        const access = await assertProductSubscriberManagementAccess(pool, sql, req, productId);
        if (!access.ok) {
            return res.status(access.status).json({ success: false, message: access.message });
        }

        const result = await listProductSubscribers(pool, sql, productId);
        if (!result.ok) {
            return res.status(result.status).json({ success: false, message: result.message });
        }

        return res.json({ success: true, data: result.subscribers });
    } catch (error) {
        console.error('Error listing product subscribers:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to list product subscribers'
        });
    }
});

/**
 * DELETE /api/products/:id/subscribers/:tenantId
 * Remove a tenant from a product's subscriber list (SysAdmin or product owner).
 * Blocked when the tenant is the product owner.
 */
router.delete('/:id/subscribers/:tenantId', authenticate, authorize(['SysAdmin', 'TenantAdmin']), sharedRequireTenantAccess, async (req, res) => {
    try {
        const productId = req.params.id;
        const tenantId = req.params.tenantId;
        const userId = req.user.UserId || req.user.userId;
        const pool = await getPool();
        const {
            cancelTenantProductSubscription,
            assertProductSubscriberManagementAccess
        } = require('../services/tenantProductSubscriptionCancel.service');

        const access = await assertProductSubscriberManagementAccess(pool, sql, req, productId);
        if (!access.ok) {
            return res.status(access.status).json({ success: false, message: access.message });
        }

        const result = await cancelTenantProductSubscription(pool, sql, {
            tenantId,
            productId,
            modifiedBy: userId
        });

        if (!result.ok) {
            return res.status(result.status).json({ success: false, message: result.message });
        }

        return res.json({
            success: true,
            message: 'Subscriber removed successfully'
        });
    } catch (error) {
        console.error('Error removing product subscriber:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to remove product subscriber'
        });
    }
});

/**
 * GET /api/products/:id
 * Get single product with full details
 */
router.get('/:id', authenticate, async (req, res) => {
    try {
        const productId = req.params.id;
        const pool = await getPool();
        
        // Get product details
        const productRequest = pool.request();
        productRequest.input('ProductId', sql.UniqueIdentifier, productId);
        
        const productResult = await productRequest.query(`
            SELECT 
                p.*,
                t.Name as ProductOwnerName,
                v.VendorName as VendorName
            FROM oe.Products p
            JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            WHERE p.ProductId = @ProductId
        `);
        
        if (productResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        let product = productResult.recordset[0];
        
        // Fetch ProductDocuments (multiple documents per product)
        try {
            const docsRequest = pool.request();
            docsRequest.input('ProductId', sql.UniqueIdentifier, productId);
            const docsResult = await docsRequest.query(`
                SELECT ProductDocumentId, ProductId, DocumentUrl, DisplayName, SortOrder,
                       ExtractionStatus, ExtractionStartedAt, ExtractionCompletedAt,
                       ExtractionError, ExtractionChunkCount
                FROM oe.ProductDocuments
                WHERE ProductId = @ProductId
                ORDER BY SortOrder ASC, CreatedDate ASC
            `);
            if (docsResult.recordset && docsResult.recordset.length > 0) {
                product.productDocuments = docsResult.recordset.map((row) => ({
                    productDocumentId: row.ProductDocumentId,
                    documentUrl: row.DocumentUrl,
                    displayName: row.DisplayName,
                    sortOrder: row.SortOrder ?? 0,
                    extractionStatus: row.ExtractionStatus,
                    extractionStartedAt: row.ExtractionStartedAt,
                    extractionCompletedAt: row.ExtractionCompletedAt,
                    extractionError: row.ExtractionError,
                    extractionChunkCount: row.ExtractionChunkCount
                }));
            } else {
                product.productDocuments = [];
            }
        } catch (err) {
            // Table may not exist yet before migration
            console.warn('⚠️ ProductDocuments fetch failed (table may not exist):', err.message);
            product.productDocuments = [];
        }
        // Migration fallback: when no rows in ProductDocuments, use legacy single document field
        const singleUrl = product.ProductDocumentUrl || product.productDocumentUrl;
        if (Array.isArray(product.productDocuments) && product.productDocuments.length === 0 && singleUrl && typeof singleUrl === 'string' && singleUrl.trim()) {
            product.productDocuments = [{ documentUrl: singleUrl.trim(), displayName: 'Document', sortOrder: 0 }];
        }
        
        // Authenticate blob URLs and get document metadata
        product = await authenticateProductUrls(product);
        
        // Get document metadata if document URL exists
        if (product.ProductDocumentUrl) {
            try {
                const documentMetadata = await getDocumentMetadata(product.ProductDocumentUrl);
                if (documentMetadata) {
                    product.DocumentMetadata = documentMetadata;
                }
            } catch (error) {
                console.warn('⚠️ Could not fetch document metadata:', error.message);
            }
        }
        
        // Parse JSON fields
        if (product.AllowedStates) {
            try {
                product.AllowedStates = JSON.parse(product.AllowedStates);
            } catch (e) {
                product.AllowedStates = [];
            }
        }
        
        if (product.RequiredLicenses) {
            try {
                product.RequiredLicenses = JSON.parse(product.RequiredLicenses);
            } catch (e) {
                product.RequiredLicenses = [];
            }
        }
        
        if (product.RequiredDataFields) {
            try {
                product.ConfigurationFields = JSON.parse(product.RequiredDataFields);
            } catch (e) {
                product.ConfigurationFields = [];
            }
        }
        
        if (product.AcknowledgementQuestions) {
            try {
                product.AcknowledgementQuestions = JSON.parse(product.AcknowledgementQuestions);
            } catch (e) {
                product.AcknowledgementQuestions = [];
            }
        }

        if (product.ProductQuestionnaires) {
            try {
                product.ProductQuestionnaires = JSON.parse(product.ProductQuestionnaires);
            } catch (e) {
                product.ProductQuestionnaires = null;
            }
        }

        // Parse ID Card Data
        if (product.IDCardData) {
            try {
                product.IDCardData = JSON.parse(product.IDCardData);
                // Process image URLs in IDCardData (strip expired SAS tokens from public container URLs)
                if (product.IDCardData) {
                    product.IDCardData = await processNestedImageUrls(product.IDCardData);
                }
            } catch (e) {
                console.error('❌ Error parsing IDCardData:', e.message);
                product.IDCardData = null;
            }
        }

        // Parse Plan Details Data
        if (product.PlanDetailsData) {
            try {
                product.PlanDetailsData = JSON.parse(product.PlanDetailsData);
                // Process image URLs in PlanDetailsData (strip expired SAS tokens from public container URLs)
                if (product.PlanDetailsData) {
                    product.PlanDetailsData = await processNestedImageUrls(product.PlanDetailsData);
                }
            } catch (e) {
                console.error('❌ Error parsing PlanDetailsData:', e.message);
                product.PlanDetailsData = null;
            }
        }

        // Parse Required ASA Data
        console.log('🔍 Parsing RequiredASA:', {
            hasRequiredASA: !!product.RequiredASA,
            requiredASAType: typeof product.RequiredASA,
            requiredASAValue: product.RequiredASA
        });
        if (product.RequiredASA) {
            try {
                product.RequiredASA = JSON.parse(product.RequiredASA);
                console.log('✅ RequiredASA parsed successfully:', product.RequiredASA);
            } catch (e) {
                console.error('❌ Error parsing RequiredASA:', e.message);
                product.RequiredASA = null;
            }
        }

        // Get AI Chunks
        const chunksRequest = pool.request();
        chunksRequest.input('ProductId', sql.UniqueIdentifier, productId);

        const chunksResult = await chunksRequest.query(`
            SELECT
                AIChunkId as id,
                ChunkText as chunk_text,
                CreatedDate as created_at
            FROM oe.AIChunks
            WHERE ProductId = @ProductId
            AND Status = 'Active'
            ORDER BY CreatedDate
        `);

        product.AIChunks = chunksResult.recordset || [];

        // Get pricing tiers with Label support
        const pricingRequest = pool.request();
        pricingRequest.input('ProductId', sql.UniqueIdentifier, productId);
        
        const pricingResult = await pricingRequest.query(`
            SELECT 
                ProductPricingId,
                PricingName,
                Label,
                NetRate,
                OverrideRate,
                VendorCommission,
                SystemFees,
                MSRPRate,
                IncludedProcessingFee,
                MinAge,
                MaxAge,
                TierType,
                TobaccoStatus,
                ConfigValue1,
                ConfigValue2,
                ConfigValue3,
                ConfigValue4,
                ConfigValue5,
                Locked,
                EffectiveDate,
                TerminationDate
            FROM oe.ProductPricing
            WHERE ProductId = @ProductId
            AND Status = 'Active'
            ORDER BY TierType, Label, TobaccoStatus, MinAge
        `);
        
        const overrideRequest = pool.request();
        overrideRequest.input('ProductId', sql.UniqueIdentifier, productId);

        const overridesResult = await overrideRequest.query(`
            SELECT 
                po.OverrideId,
                po.ProductId,
                po.ProductPricingId,
                po.TenantId,
                po.OverrideACHId,
                po.OverrideName,
                po.OverrideAmount,
                po.Priority,
                po.IsActive,
                po.EffectiveDate,
                po.ExpirationDate,
                po.CreatedDate,
                po.ModifiedDate,
                t.Name AS TenantName,
                ach.AccountName AS ACHAccountName,
                ach.AccountHolderName AS ACHAccountHolderName,
                ach.BankName AS ACHBankName,
                ach.BankAccountType AS ACHAccountType
            FROM oe.ProductOverrides po
            LEFT JOIN oe.Tenants t ON po.TenantId = t.TenantId
            LEFT JOIN oe.ProductOverrideACH ach ON po.OverrideACHId = ach.OverrideACHId
            WHERE po.ProductId = @ProductId
        `);

        const overridesByPricingId = overridesResult.recordset.reduce((acc, override) => {
            if (!override.ProductPricingId) {
                return acc;
            }
            const key = String(override.ProductPricingId).toLowerCase();
            if (!acc[key]) {
                acc[key] = [];
            }
            acc[key].push({
                OverrideId: override.OverrideId,
                ProductId: override.ProductId,
                ProductPricingId: override.ProductPricingId,
                TenantId: override.TenantId,
                OverrideACHId: override.OverrideACHId,
                OverrideName: override.OverrideName,
                OverrideAmount: parseFloat(override.OverrideAmount) || 0,
                Priority: override.Priority,
                IsActive: Boolean(override.IsActive),
                EffectiveDate: override.EffectiveDate,
                ExpirationDate: override.ExpirationDate,
                CreatedDate: override.CreatedDate,
                ModifiedDate: override.ModifiedDate,
                TenantName: override.TenantName,
                ACHAccountName: override.ACHAccountName,
                ACHAccountHolderName: override.ACHAccountHolderName,
                ACHBankName: override.ACHBankName,
                ACHAccountType: override.ACHAccountType
            });
            return acc;
        }, {});
        
        // Group pricing by tier type and label only (not tobacco status)
        const pricingTiers = [];
        const tierMap = new Map();
        
        pricingResult.recordset.forEach(pricing => {
            const key = `${pricing.TierType}_${pricing.Label || 'default'}`;
            
            if (!tierMap.has(key)) {
                tierMap.set(key, {
                    id: uuidv4(),
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
                netRate: parseFloat(pricing.NetRate) || 0,
                overrideRate: parseFloat(pricing.OverrideRate) || 0,
                commission: parseFloat(pricing.VendorCommission) || 0,
                systemFees: parseFloat(pricing.SystemFees) || 0,
                msrpRate: parseFloat(pricing.MSRPRate) || 0,
                includedProcessingFee: parseFloat(pricing.IncludedProcessingFee) || 0,
                affiliateRate: (parseFloat(pricing.NetRate) || 0) + (parseFloat(pricing.OverrideRate) || 0),
                locked: Boolean(pricing.Locked),
                effectiveDate: pricing.EffectiveDate ? new Date(pricing.EffectiveDate).toISOString().split('T')[0] : '',
                terminationDate: pricing.TerminationDate ? new Date(pricing.TerminationDate).toISOString().split('T')[0] : '',
                configValue1: pricing.ConfigValue1,
                configValue2: pricing.ConfigValue2,
                configValue3: pricing.ConfigValue3,
                configValue4: pricing.ConfigValue4,
                configValue5: pricing.ConfigValue5,
                overrides: overridesByPricingId[String(pricing.ProductPricingId || '').toLowerCase()] || []
            });
        });
        
        product.PricingTiers = pricingTiers;
        product.includeProcessingFee = toBoolProductFlag(product.IncludeProcessingFee);
        product.roundUpProcessingFee =
            product.RoundUpProcessingFee === false || product.RoundUpProcessingFee === 0
                ? false
                : product.RoundUpProcessingFee === undefined || product.RoundUpProcessingFee === null
                  ? true
                  : toBoolProductFlag(product.RoundUpProcessingFee);
        product.processingFeePercentage =
            product.ProcessingFeePercentage != null ? Number(product.ProcessingFeePercentage) : null;
        product.manualIncludedProcessingFee = toBoolProductFlag(product.ManualIncludedProcessingFee);
        
        // Get bundle products if this is a bundle
        if (product.IsBundle) {
            const bundleRequest = pool.request();
            bundleRequest.input('BundleProductId', sql.UniqueIdentifier, productId);
            
            const bundleResult = await bundleRequest.query(`
                SELECT IncludedProductId
                FROM oe.ProductBundles
                WHERE BundleProductId = @BundleProductId
                ORDER BY SortOrder
            `);
            
            product.BundleProducts = bundleResult.recordset.map(b => b.IncludedProductId);
        }
        
        res.json({
            success: true,
            product: product
        });
        
    } catch (error) {
        console.error('Error fetching product details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch product details'
        });
    }
});

/**
 * GET /api/products/:id/bundle-products
 * Get included products for a bundle
 */
router.get('/:id/bundle-products', authenticate, async (req, res) => {
    try {
        const bundleProductId = req.params.id;
        const pool = await getPool();
        
        const request = pool.request();
        request.input('BundleProductId', sql.UniqueIdentifier, bundleProductId);
        
        const result = await request.query(`
            SELECT 
                pb.IncludedProductId,
                pb.SortOrder,
                pb.IsRequired,
                pb.HidePricing,
                pb.LinkedToProductId,
                pb.AllowedConfigOptions,
                p.Name AS ProductName,
                p.Description,
                p.ProductType,
                p.Status,
                p.RequiredDataFields
            FROM oe.ProductBundles pb
            INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
            WHERE pb.BundleProductId = @BundleProductId
              AND p.Status = 'Active'
            ORDER BY pb.SortOrder
        `);
        
        const data = (result.recordset || []).map(row => {
            const { AllowedConfigOptions, RequiredDataFields, ...rest } = row;
            let allowedConfigOptions = null;
            if (AllowedConfigOptions) {
                try {
                    allowedConfigOptions = typeof AllowedConfigOptions === 'string' ? JSON.parse(AllowedConfigOptions) : AllowedConfigOptions;
                } catch (e) {
                    console.warn('Failed to parse AllowedConfigOptions for bundle product:', row.IncludedProductId, e);
                }
            }
            let requiredDataFields = null;
            if (RequiredDataFields) {
                try {
                    requiredDataFields = typeof RequiredDataFields === 'string' ? JSON.parse(RequiredDataFields) : RequiredDataFields;
                } catch (e) {
                    console.warn('Failed to parse RequiredDataFields for bundle product:', row.IncludedProductId, e);
                }
            }
            return { ...rest, AllowedConfigOptions: allowedConfigOptions, RequiredDataFields: requiredDataFields };
        });
        
        res.json({
            success: true,
            data
        });
        
    } catch (error) {
        console.error('Error fetching bundle products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch bundle products'
        });
    }
});

/**
 * GET /api/products/:id/details
 * Get complete product details for editing
 */
router.get('/:id/details', async (req, res) => { 
    try {
        const productId = req.params.id;
        const pool = await getPool();
        
        // Get product with all details
        const request = pool.request();
        request.input('ProductId', sql.UniqueIdentifier, productId);
        
        const productResult = await request.query(`
            SELECT 
                p.*,
                t.Name as ProductOwnerName,
                v.VendorName as VendorName
            FROM oe.Products p
            JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            WHERE p.ProductId = @ProductId
        `);
        
        if (productResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        const product = productResult.recordset[0];
        
        // Parse all JSON fields
        const jsonFields = ['AllowedStates', 'RequiredLicenses', 'RequiredDataFields', 'AcknowledgementQuestions'];
        jsonFields.forEach(field => {
            if (product[field]) {
                try {
                    product[field] = JSON.parse(product[field]);
                } catch (e) {
                    product[field] = field === 'AllowedStates' || field === 'RequiredLicenses' ? [] : null;
                }
            }
        });

        // Parse ProductQuestionnaires JSON
        if (product.ProductQuestionnaires) {
            try {
                product.ProductQuestionnaires = JSON.parse(product.ProductQuestionnaires);
            } catch (e) {
                product.ProductQuestionnaires = null;
            }
        }

        // Parse ID Card Data
        if (product.IDCardData) {
            try {
                product.IDCardData = JSON.parse(product.IDCardData);
            } catch (e) {
                product.IDCardData = null;
            }
        }

        // Parse Plan Details Data
        if (product.PlanDetailsData) {
            try {
                product.PlanDetailsData = JSON.parse(product.PlanDetailsData);
            } catch (e) {
                product.PlanDetailsData = null;
            }
        }

        // Parse Required ASA Data
        console.log('🔍 Parsing RequiredASA:', {
            hasRequiredASA: !!product.RequiredASA,
            requiredASAType: typeof product.RequiredASA,
            requiredASAValue: product.RequiredASA
        });
        if (product.RequiredASA) {
            try {
                product.RequiredASA = JSON.parse(product.RequiredASA);
                console.log('✅ RequiredASA parsed successfully:', product.RequiredASA);
            } catch (e) {
                console.error('❌ Error parsing RequiredASA:', e.message);
                product.RequiredASA = null;
            }
        }

        // Get AI Chunks
        const chunksRequest = pool.request();
        chunksRequest.input('ProductId', sql.UniqueIdentifier, productId);

        const chunksResult = await chunksRequest.query(`
            SELECT
                AIChunkId as id,
                ChunkText as chunk_text,
                CreatedDate as created_at
            FROM oe.AIChunks
            WHERE ProductId = @ProductId
            AND Status = 'Active'
            ORDER BY CreatedDate
        `);

        product.AIChunks = chunksResult.recordset || [];
        
        // Rename fields to match frontend expectations
        product.ConfigurationFields = product.RequiredDataFields || [];
        delete product.RequiredDataFields;
        
        // Get all pricing information with Label
        const pricingResult = await request.query(`
            SELECT * FROM oe.ProductPricing
            WHERE ProductId = @ProductId
            ORDER BY TierType, Label, TobaccoStatus, MinAge
        `);
        
        // Get product overrides for pricing tiers
        let overridesByPricingId = {};
        try {
            const overrideRequest = pool.request();
            overrideRequest.input('ProductId', sql.UniqueIdentifier, productId);
            const overridesResult = await overrideRequest.query(`
                SELECT
                    po.OverrideId,
                    po.ProductId,
                    po.ProductPricingId,
                    po.TenantId,
                    po.OverrideACHId,
                    po.OverrideName,
                    po.OverrideAmount,
                    po.Priority,
                    po.IsActive,
                    po.EffectiveDate,
                    po.ExpirationDate,
                    po.CreatedDate,
                    po.ModifiedDate,
                    t.Name AS TenantName,
                    ach.AccountName AS ACHAccountName,
                    ach.AccountHolderName AS ACHAccountHolderName,
                    ach.BankName AS ACHBankName,
                    ach.BankAccountType AS ACHAccountType
                FROM oe.ProductOverrides po
                LEFT JOIN oe.Tenants t ON po.TenantId = t.TenantId
                LEFT JOIN oe.ProductOverrideACH ach ON po.OverrideACHId = ach.OverrideACHId
                WHERE po.ProductId = @ProductId
            `);
            overridesByPricingId = (overridesResult.recordset || []).reduce((acc, override) => {
                if (!override.ProductPricingId) return acc;
                const key = String(override.ProductPricingId).toLowerCase();
                if (!acc[key]) acc[key] = [];
                acc[key].push({
                    OverrideId: override.OverrideId,
                    ProductId: override.ProductId,
                    ProductPricingId: override.ProductPricingId,
                    TenantId: override.TenantId,
                    OverrideACHId: override.OverrideACHId,
                    OverrideName: override.OverrideName,
                    OverrideAmount: parseFloat(override.OverrideAmount) || 0,
                    Priority: override.Priority,
                    IsActive: Boolean(override.IsActive),
                    EffectiveDate: override.EffectiveDate,
                    ExpirationDate: override.ExpirationDate,
                    CreatedDate: override.CreatedDate,
                    ModifiedDate: override.ModifiedDate,
                    TenantName: override.TenantName,
                    ACHAccountName: override.ACHAccountName,
                    ACHAccountHolderName: override.ACHAccountHolderName,
                    ACHBankName: override.ACHBankName,
                    ACHAccountType: override.ACHAccountType
                });
                return acc;
            }, {});
        } catch (err) {
            console.warn('Product details: could not load overrides:', err.message);
        }
        
        // Get bundle products if applicable
        if (product.IsBundle) {
            const bundleResult = await request.query(`
                SELECT IncludedProductId
                FROM oe.ProductBundles
                WHERE BundleProductId = @ProductId
                ORDER BY SortOrder
            `);
            
            product.BundleProducts = bundleResult.recordset.map(b => b.IncludedProductId);
        }
        
        // Format pricing tiers for frontend
        const pricingTiers = [];
        const tierMap = new Map();
        
        pricingResult.recordset.forEach(pricing => {
            const key = `${pricing.TierType}_${pricing.Label || 'default'}`;
            
            if (!tierMap.has(key)) {
                tierMap.set(key, {
                    id: uuidv4(),
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
                netRate: parseFloat(pricing.NetRate) || 0,
                overrideRate: parseFloat(pricing.OverrideRate) || 0,
                commission: parseFloat(pricing.VendorCommission) || 0,
                systemFees: parseFloat(pricing.SystemFees) || 0,
                msrpRate: parseFloat(pricing.MSRPRate) || 0,
                includedProcessingFee: parseFloat(pricing.IncludedProcessingFee) || 0,
                affiliateRate: (parseFloat(pricing.NetRate) || 0) + (parseFloat(pricing.OverrideRate) || 0),
                Locked: Boolean(pricing.Locked),
                EffectiveDate: pricing.EffectiveDate ? new Date(pricing.EffectiveDate).toISOString().split('T')[0] : '',
                TerminationDate: pricing.TerminationDate ? new Date(pricing.TerminationDate).toISOString().split('T')[0] : '',
                ConfigValue1: pricing.ConfigValue1,
                ConfigValue2: pricing.ConfigValue2,
                ConfigValue3: pricing.ConfigValue3,
                ConfigValue4: pricing.ConfigValue4,
                ConfigValue5: pricing.ConfigValue5,
                overrides: overridesByPricingId[String(pricing.ProductPricingId || '').toLowerCase()] || []
            });
        });
        
        product.PricingTiers = pricingTiers;
        product.includeProcessingFee = toBoolProductFlag(product.IncludeProcessingFee);
        product.roundUpProcessingFee =
            product.RoundUpProcessingFee === false || product.RoundUpProcessingFee === 0
                ? false
                : product.RoundUpProcessingFee === undefined || product.RoundUpProcessingFee === null
                  ? true
                  : toBoolProductFlag(product.RoundUpProcessingFee);
        product.processingFeePercentage =
            product.ProcessingFeePercentage != null ? Number(product.ProcessingFeePercentage) : null;
        product.manualIncludedProcessingFee = toBoolProductFlag(product.ManualIncludedProcessingFee);
        
        res.json({
            success: true,
            product: product
        });
        
    } catch (error) {
        console.error('Error fetching product details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch product details'
        });
    }
});

/**
 * POST /api/products
 * Create new product
 */
router.post('/', authenticate, requireTenantAccess(['Admin', 'SysAdmin', 'TenantAdmin']), upload.fields([
  { name: 'productImageFile', maxCount: 1 },
  { name: 'productLogoFile', maxCount: 1 },
  { name: 'productDocumentFile', maxCount: 1 },
  { name: 'idCardLogoFile', maxCount: 1 },
  { name: 'planDetailsHeaderLogoFile', maxCount: 1 }
]), async (req, res) => {
    try {
        console.log('🆕 Creating new product');
        console.log('📦 Request body:', req.body);
        console.log('📁 Request files:', req.files);
        
        const {
            vendorId,
            isVendorPricing,
            vendorCommission,
            name,
            description,
            productType,
            salesType,
            productOwnerId,
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
            productDocuments,
            acknowledgementQuestions,
            productQuestionnaires,  // Product questionnaire JSON
            idCardData,        // NEW
            planDetailsData,   // NEW
            aiChunks,        // NEW
            requiredASA,       // NEW
            trainingConfig,    // Training (agent/member) JSON
            medicalNeedsLinksConfig, // Member portal medical needs request links JSON
            isPublic,         // NEW
            isHidden,         // NEW - Hide products from agents (typically for bundle components)
            isSSNRequired,    // NEW - Require SSN for enrollment in this product
            vendorGroupIdProductType,  // Master/CoPay/HSA for vendor group ID generation
            eligibilityIndividualVendorGroupId,  // Default vendor group ID for individual (no-group) enrollments
            eligibilityVendorGroupFallbackProductId, // Use other product's VGI chain before Master (eligibility export)
            showGroupIdOnIDCard, // Show vendor group ID on member ID cards
            premiumReportingCategory,
            idCardMemberIdPrefixMask, // optional: replace tenant group prefix on ID cards / eligibility for this product
            includeProcessingFee,
            roundUpProcessingFee,
            processingFeePercentage,
            manualIncludedProcessingFee,
            planId,  // Vendor-assigned plan identifier (e.g. for eligibility export "Plan ID" column)
        } = req.body;

        const manualIncludedProcessingFeeBool = toBoolProductFlag(manualIncludedProcessingFee);
        const includeProcessingFeeBool = manualIncludedProcessingFeeBool
            ? true
            : toBoolProductFlag(includeProcessingFee);
        const roundUpProcessingFeeBool = manualIncludedProcessingFeeBool
            ? false
            : roundUpProcessingFee === false || roundUpProcessingFee === 'false'
                ? false
                : roundUpProcessingFee === undefined || roundUpProcessingFee === null
                  ? true
                  : toBoolProductFlag(roundUpProcessingFee);
        const processingFeePctValue = manualIncludedProcessingFeeBool
            ? null
            : processingFeePercentage != null && String(processingFeePercentage).trim() !== ''
                ? parseFloat(processingFeePercentage)
                : null;

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

        let parsedProductDocuments = [];
        if (productDocuments) {
            try {
                parsedProductDocuments = typeof productDocuments === 'string' ? JSON.parse(productDocuments) : (Array.isArray(productDocuments) ? productDocuments : []);
            } catch (error) {
                console.error('❌ Error parsing productDocuments:', error);
                parsedProductDocuments = [];
            }
        }

        // Validation
        if (!name || !productType || !productOwnerId) {
            return res.status(400).json({
                success: false,
                message: 'Product name, type, and owner are required'
            });
        }

        const isBundleBool = isBundleProductFlag(isBundle);
        const createVendorId = resolveProductVendorId(isBundle, vendorId);

        // Vendor validation — bundles are tenant-owned, not vendor products
        if (!isBundleBool) {
            if (!vendorId) {
                return res.status(400).json({
                    success: false,
                    message: 'Vendor selection is required'
                });
            }

            const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!guidRegex.test(vendorId)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid GUID format for vendorId: ${vendorId}`
                });
            }
        }

        // Log warning if productId was sent (should be ignored for new products)
        if (req.body.productId) {
            console.warn('⚠️ productId was sent in request body for POST (new product). Ignoring and generating new one. Received:', req.body.productId);
        }

        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // Validate productOwnerId is a valid GUID
        if (!guidRegex.test(productOwnerId)) {
            return res.status(400).json({
                success: false,
                message: `Invalid GUID format for productOwnerId: ${productOwnerId}`
            });
        }

        const pool = await getPool();
        // Always generate a new productId for new products - ignore any productId from request body
        // Use uuidv4() which is already imported at the top of the file (same as other endpoints)
        const productId = uuidv4();
        console.log('🆔 Generated new productId:', productId);

        const fbNormCreate = isBundleBool
            ? { value: null, error: null }
            : await normalizeEligibilityVendorGroupFallbackProductId(
                pool,
                vendorId,
                productId,
                eligibilityVendorGroupFallbackProductId
            );
        if (fbNormCreate.error) {
            return res.status(400).json({ success: false, message: fbNormCreate.error });
        }
        
        // Start transaction
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Insert main product record with vendor fields
            const productRequest = transaction.request();
            productRequest.input('ProductId', sql.UniqueIdentifier, productId);
            productRequest.input('VendorId', sql.UniqueIdentifier, createVendorId);
            productRequest.input('IsVendorPrice', sql.Bit, isVendorPricing || false);
            productRequest.input('VendorCommission', sql.Decimal(19, 4), parseFloat(vendorCommission) || 0);
            productRequest.input('ProductOwnerId', sql.UniqueIdentifier, productOwnerId);
            productRequest.input('Name', sql.NVarChar, name);
            productRequest.input('Description', sql.NVarChar, description || '');
            productRequest.input('ProductType', sql.NVarChar, productType);
            productRequest.input('Status', sql.NVarChar, 'Active');
            productRequest.input('IsMarketplaceProduct', sql.Bit, true);
            // Ensure boolean conversion for bit fields
            const isPublicBool = isPublic === true || isPublic === 'true' || isPublic === 1;
            const isHiddenBool = isHidden === true || isHidden === 'true' || isHidden === 1;
            const isSSNRequiredBool = isSSNRequired === true || isSSNRequired === 'true' || isSSNRequired === 1;
            console.log('🔳 Creating with visibility flags:', { isPublicBool, isHiddenBool, isSSNRequiredBool, originalIsPublic: isPublic, originalIsHidden: isHidden, originalIsSSNRequired: isSSNRequired });
            productRequest.input('IsPublic', sql.Bit, isPublicBool);
            productRequest.input('IsHidden', sql.Bit, isHiddenBool);
            productRequest.input('IsSSNRequired', sql.Bit, isSSNRequiredBool);
            productRequest.input('IsBundle', sql.Bit, isBundle || false);
            productRequest.input('ProductImageUrl', sql.NVarChar, productImageUrl || null);
            productRequest.input('ProductLogoUrl', sql.NVarChar, productLogoUrl || null);
            productRequest.input('ProductDocumentUrl', sql.NVarChar, productDocumentUrl || null);
            productRequest.input('MinAge', sql.Int, minAge || null);
            productRequest.input('MaxAge', sql.Int, maxAge || null);
            productRequest.input('AllowedStates', sql.NVarChar, allowedStates ? JSON.stringify(allowedStates) : null);
            productRequest.input('SalesType', sql.NVarChar, salesType || 'Both');
            productRequest.input('RequiresTobaccoInfo', sql.Bit, requiresTobaccoInfo || false);
            productRequest.input('EffectiveDateLogic', sql.NVarChar, effectiveDateLogic || 'FirstOfMonth');
            productRequest.input('MaxEffectiveDateDays', sql.Int, maxEffectiveDateDays || 60);
            productRequest.input('TerminationLogic', sql.NVarChar, terminationLogic || null);
            productRequest.input('RequiredLicenses', sql.NVarChar, requiredLicenses ? JSON.stringify(requiredLicenses) : null);
            productRequest.input('RequiredDataFields', sql.NVarChar, configurationFields ? JSON.stringify(configurationFields) : null);
            productRequest.input('AcknowledgementQuestions', sql.NVarChar, acknowledgementQuestions ? JSON.stringify(acknowledgementQuestions) : null);
            productRequest.input('ProductQuestionnaires', sql.NVarChar, productQuestionnaires ? (typeof productQuestionnaires === 'string' ? productQuestionnaires : JSON.stringify(productQuestionnaires)) : null);
            productRequest.input('IDCardData', sql.NVarChar(sql.MAX), idCardData ? JSON.stringify(idCardData) : null);
            productRequest.input('PlanDetailsData', sql.NVarChar(sql.MAX), planDetailsData ? JSON.stringify(planDetailsData) : null);
            console.log('🔍 CREATE RequiredASA data:', requiredASA, 'Type:', typeof requiredASA);
            productRequest.input('RequiredASA', sql.NVarChar(sql.MAX), requiredASA ? JSON.stringify(requiredASA) : null);
            productRequest.input('TrainingConfig', sql.NVarChar(sql.MAX), trainingConfig ? (typeof trainingConfig === 'string' ? trainingConfig : JSON.stringify(trainingConfig)) : null);
            productRequest.input('MedicalNeedsLinksConfig', sql.NVarChar(sql.MAX), medicalNeedsLinksConfig != null ? (typeof medicalNeedsLinksConfig === 'string' ? medicalNeedsLinksConfig : JSON.stringify(medicalNeedsLinksConfig)) : null);
            const normalizedVendorGroupIdProductTypeCreate = (() => { const v = vendorGroupIdProductType; if (!v || v === '') return null; const n = parseInt(String(v), 10); if (!Number.isNaN(n) && n >= 0 && n <= 9) return String(n); if (['Master', 'CoPay', 'HSA', 'None'].includes(v)) return v; return null; })();
            productRequest.input('VendorGroupIdProductType', sql.NVarChar, normalizedVendorGroupIdProductTypeCreate);
            productRequest.input('EligibilityIndividualVendorGroupId', sql.NVarChar(50), eligibilityIndividualVendorGroupId?.trim() || null);
            productRequest.input('EligibilityVendorGroupFallbackProductId', sql.UniqueIdentifier, fbNormCreate.value || null);
            const { resolveShowGroupIdOnIDCardBit } = require('../utils/productVendorGroupId');
            productRequest.input('ShowGroupIdOnIDCard', sql.Bit, resolveShowGroupIdOnIDCardBit(normalizedVendorGroupIdProductTypeCreate, showGroupIdOnIDCard));
            productRequest.input('PlanId', sql.NVarChar(100), planId != null && String(planId).trim() !== '' ? String(planId).trim() : null);
            const premiumCat = premiumReportingCategory === 'NonProfit' ? 'NonProfit' : 'ForProfit';
            productRequest.input('PremiumReportingCategory', sql.NVarChar(20), premiumCat);
            const idMaskCreate =
                idCardMemberIdPrefixMask != null && String(idCardMemberIdPrefixMask).trim() !== ''
                    ? String(idCardMemberIdPrefixMask).trim().slice(0, 10)
                    : null;
            productRequest.input('IDCardMemberIdPrefixMask', sql.NVarChar(10), idMaskCreate);
            productRequest.input('IncludeProcessingFee', sql.Bit, includeProcessingFeeBool ? 1 : 0);
            productRequest.input('RoundUpProcessingFee', sql.Bit, roundUpProcessingFeeBool ? 1 : 0);
            productRequest.input('ProcessingFeePercentage', sql.Decimal(9, 4), processingFeePctValue);
            productRequest.input('ManualIncludedProcessingFee', sql.Bit, manualIncludedProcessingFeeBool ? 1 : 0);
            productRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
            productRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
            productRequest.input('CreatedDate', sql.DateTime2, new Date());
            productRequest.input('ModifiedDate', sql.DateTime2, new Date());
            productRequest.input('EffectiveDate', sql.Date, new Date());

            await productRequest.query(`
                INSERT INTO oe.Products (
                    ProductId, VendorId, IsVendorPrice, VendorCommission, ProductOwnerId, 
                    Name, Description, ProductType, Status,
                    IsMarketplaceProduct, IsPublic, IsHidden, IsSSNRequired, IsBundle, ProductImageUrl, ProductLogoUrl,
                    ProductDocumentUrl, MinAge, MaxAge, AllowedStates, SalesType,
                    RequiresTobaccoInfo, EffectiveDateLogic, MaxEffectiveDateDays, TerminationLogic,
                    RequiredLicenses, RequiredDataFields, AcknowledgementQuestions, ProductQuestionnaires,
                    IDCardData, PlanDetailsData, RequiredASA, TrainingConfig, MedicalNeedsLinksConfig, VendorGroupIdProductType, EligibilityIndividualVendorGroupId, EligibilityVendorGroupFallbackProductId,
                    ShowGroupIdOnIDCard,
                    PremiumReportingCategory, IDCardMemberIdPrefixMask, PlanId,
                    IncludeProcessingFee, RoundUpProcessingFee, ProcessingFeePercentage, ManualIncludedProcessingFee,
                    CreatedBy, ModifiedBy, CreatedDate, ModifiedDate, EffectiveDate
                ) VALUES (
                    @ProductId, @VendorId, @IsVendorPrice, @VendorCommission, @ProductOwnerId,
                    @Name, @Description, @ProductType, @Status,
                    @IsMarketplaceProduct, @IsPublic, @IsHidden, @IsSSNRequired, @IsBundle, @ProductImageUrl, @ProductLogoUrl,
                    @ProductDocumentUrl, @MinAge, @MaxAge, @AllowedStates, @SalesType,
                    @RequiresTobaccoInfo, @EffectiveDateLogic, @MaxEffectiveDateDays, @TerminationLogic,
                    @RequiredLicenses, @RequiredDataFields, @AcknowledgementQuestions, @ProductQuestionnaires,
                    @IDCardData, @PlanDetailsData, @RequiredASA, @TrainingConfig, @MedicalNeedsLinksConfig, @VendorGroupIdProductType, @EligibilityIndividualVendorGroupId, @EligibilityVendorGroupFallbackProductId,
                    @ShowGroupIdOnIDCard,
                    @PremiumReportingCategory, @IDCardMemberIdPrefixMask, @PlanId,
                    @IncludeProcessingFee, @RoundUpProcessingFee, @ProcessingFeePercentage, @ManualIncludedProcessingFee,
                    @CreatedBy, @ModifiedBy, @CreatedDate, @ModifiedDate, @EffectiveDate
                )
            `);

            // Insert ProductDocuments (multiple documents per product).
            // Collect docs that need AI extraction; the Service Bus enqueue happens
            // AFTER transaction.commit() so we don't block the response on it.
            const docsToEnqueueAfterCommit = [];
            if (parsedProductDocuments.length === 0 && productDocumentUrl) {
                parsedProductDocuments = [{ documentUrl: productDocumentUrl, displayName: 'Document', sortOrder: 0 }];
            }
            if (parsedProductDocuments.length > 0) {
                for (let sortOrder = 0; sortOrder < parsedProductDocuments.length; sortOrder++) {
                    const doc = parsedProductDocuments[sortOrder];
                    const docUrl = doc.documentUrl || doc.DocumentUrl;
                    if (!docUrl) continue;
                    const docRequest = transaction.request();
                    const docId = uuidv4();
                    docRequest.input('ProductDocumentId', sql.UniqueIdentifier, docId);
                    docRequest.input('ProductId', sql.UniqueIdentifier, productId);
                    docRequest.input('DocumentUrl', sql.NVarChar, docUrl);
                    docRequest.input('DisplayName', sql.NVarChar, doc.displayName || doc.DisplayName || null);
                    docRequest.input('SortOrder', sql.Int, doc.sortOrder ?? doc.SortOrder ?? sortOrder);
                    docRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
                    docRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
                    await docRequest.query(`
                        INSERT INTO oe.ProductDocuments (ProductDocumentId, ProductId, DocumentUrl, DisplayName, SortOrder, CreatedBy, ModifiedBy, ExtractionStatus)
                        VALUES (@ProductDocumentId, @ProductId, @DocumentUrl, @DisplayName, @SortOrder, @CreatedBy, @ModifiedBy, 'queued')
                    `);
                    docsToEnqueueAfterCommit.push({
                        productDocumentId: docId,
                        productId,
                        tenantId: (req.user && req.user.TenantId) || productOwnerId,
                        blobUrl: docUrl,
                        fileName: doc.displayName || doc.DisplayName || 'document',
                    });
                }
            }
            // Stash on req so the post-commit hook can run them
            req._docsToEnqueueAfterCommit = (req._docsToEnqueueAfterCommit || []).concat(docsToEnqueueAfterCommit);

            // Insert pricing tiers with Label support
            if (pricingTiers && pricingTiers.length > 0) {
                console.log('🔍 POST: Processing pricing tiers:', pricingTiers.length);
                for (const tier of pricingTiers) {
                    console.log('🎯 POST: Processing tier:', tier.tierType, 'with', tier.ageBands?.length, 'age bands');
                    if (tier.ageBands && tier.ageBands.length > 0) {
                        for (const band of tier.ageBands) {
                            console.log('🔍 POST: Processing age band:', {
                                bandId: band.id,
                                netRate: band.netRate,
                                overrideRate: band.overrideRate,
                                commission: band.commission,
                                tobaccoStatus: band.tobaccoStatus,
                                tierType: tier.tierType
                            });
                            
                            const pricingRequest = transaction.request();
                            pricingRequest.input('ProductPricingId', sql.UniqueIdentifier, uuidv4());
                            pricingRequest.input('ProductId', sql.UniqueIdentifier, productId);
                            pricingRequest.input('PricingName', sql.NVarChar, `${tier.tierType}_${band.tobaccoStatus}`);
                            pricingRequest.input('Label', sql.NVarChar, tier.label || null);
                            pricingRequest.input('NetRate', sql.Decimal(19, 4), parseFloat(band.netRate) || 0);
                            pricingRequest.input('OverrideRate', sql.Decimal(19, 4), parseFloat(band.overrideRate) || 0);
                            const commissionValue = parseFloat(band.commission) || 0;
                            console.log('💰 Commission value for database:', commissionValue, 'Original:', band.commission, 'Type:', typeof band.commission);
                            pricingRequest.input('VendorCommission', sql.Decimal(19, 4), commissionValue);
                            const systemFeesValue = parseFloat(band.systemFees) || 0;
                            console.log('💰 System Fees value for database:', systemFeesValue, 'Original:', band.systemFees, 'Type:', typeof band.systemFees);
                            pricingRequest.input('SystemFees', sql.Decimal(19, 4), systemFeesValue);
                            const overrideValue = parseFloat(band.overrideRate) || 0;
                            const componentSum = (parseFloat(band.netRate) || 0) + overrideValue + commissionValue + systemFeesValue;
                            console.log('📊 MSRP component sum:', `${band.netRate} + ${overrideValue} + ${commissionValue} + ${systemFeesValue} = ${componentSum}`);
                            const { msrpRate: msrpValue, includedFee: includedFeeValue } =
                                await resolveMsrpAndIncludedForBandSave(
                                    transaction,
                                    productOwnerId,
                                    componentSum,
                                    includeProcessingFeeBool,
                                    roundUpProcessingFeeBool,
                                    processingFeePctValue,
                                    band
                                );
                            pricingRequest.input('MSRPRate', sql.Decimal(19, 4), msrpValue);
                            pricingRequest.input('IncludedProcessingFee', sql.Decimal(19, 4), includedFeeValue);
                            pricingRequest.input('MinAge', sql.Int, band.minAge || null);
                            pricingRequest.input('MaxAge', sql.Int, band.maxAge || null);
                            pricingRequest.input('TierType', sql.NVarChar, tier.tierType);
                            pricingRequest.input('TobaccoStatus', sql.NVarChar, band.tobaccoStatus || 'No');
                            pricingRequest.input('ConfigValue1', sql.NVarChar, band.configValue1 || null);
                            pricingRequest.input('ConfigValue2', sql.NVarChar, band.configValue2 || null);
                            pricingRequest.input('ConfigValue3', sql.NVarChar, band.configValue3 || null);
                            pricingRequest.input('ConfigValue4', sql.NVarChar, band.configValue4 || null);
                            pricingRequest.input('ConfigValue5', sql.NVarChar, band.configValue5 || null);
                            pricingRequest.input('Locked', sql.Bit, band.locked ? 1 : 0);
                            const effectiveDateValue = band.effectiveDate ? new Date(band.effectiveDate) : new Date();
                            const terminationDateValue = band.terminationDate ? new Date(band.terminationDate) : null;
                            pricingRequest.input('EffectiveDate', sql.Date, effectiveDateValue);
                            pricingRequest.input('TerminationDate', sql.Date, terminationDateValue);
                            pricingRequest.input('Status', sql.NVarChar, 'Active');
                            pricingRequest.input('CreatedDate', sql.DateTime2, new Date());
                            pricingRequest.input('ModifiedDate', sql.DateTime2, new Date());
                            pricingRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
                            pricingRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);

                            await pricingRequest.query(`
                                INSERT INTO oe.ProductPricing (
                                    ProductPricingId, ProductId, PricingName, Label, NetRate, OverrideRate, VendorCommission, SystemFees, MSRPRate, IncludedProcessingFee,
                                    MinAge, MaxAge, TierType, TobaccoStatus, 
                                    ConfigValue1, ConfigValue2, ConfigValue3, ConfigValue4, ConfigValue5,
                                    Locked, EffectiveDate, TerminationDate, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                                ) VALUES (
                                    @ProductPricingId, @ProductId, @PricingName, @Label, @NetRate, @OverrideRate, @VendorCommission, @SystemFees, @MSRPRate, @IncludedProcessingFee,
                                    @MinAge, @MaxAge, @TierType, @TobaccoStatus,
                                    @ConfigValue1, @ConfigValue2, @ConfigValue3, @ConfigValue4, @ConfigValue5,
                                    @Locked, @EffectiveDate, @TerminationDate, @Status, @CreatedDate, @ModifiedDate, @CreatedBy, @ModifiedBy
                                )
                            `);
                        }
                    }
                }
            }

            // Insert AI Chunks - NEW
            if (parsedAiChunks && parsedAiChunks.length > 0) {
                for (const chunk of parsedAiChunks) {
                    const chunkRequest = transaction.request();
                    const chunkId = uuidv4();
                    chunkRequest.input('AIChunkId', sql.UniqueIdentifier, chunkId);
                    chunkRequest.input('ProductId', sql.UniqueIdentifier, productId);
                    chunkRequest.input('TenantId', sql.UniqueIdentifier, productOwnerId);
                    chunkRequest.input('SystemArea', sql.NVarChar, 'Product');
                    chunkRequest.input('ChunkText', sql.NVarChar, chunk.chunk_text);
                    chunkRequest.input('ChunkType', sql.NVarChar, 'prose');
                    chunkRequest.input('Source', sql.NVarChar, 'manual');
                    chunkRequest.input('IsActive', sql.Bit, true);
                    chunkRequest.input('Status', sql.NVarChar, 'Active');
                    chunkRequest.input('CreatedDate', sql.DateTime2, new Date());
                    chunkRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);

                    await chunkRequest.query(`
                        INSERT INTO oe.AIChunks (
                            AIChunkId, ProductId, TenantId, SystemArea, ChunkText, ChunkType, Source,
                            IsActive, Status, CreatedDate, CreatedBy
                        ) VALUES (
                            @AIChunkId, @ProductId, @TenantId, @SystemArea, @ChunkText, @ChunkType, @Source,
                            @IsActive, @Status, @CreatedDate, @CreatedBy
                        )
                    `);
                }
            }

            // Handle bundle products
            if (isBundle && parsedBundleProducts && parsedBundleProducts.length > 0) {
                console.log('🔍 Bundle products received:', parsedBundleProducts);
                let sortOrder = 1;
                for (const bundleProduct of parsedBundleProducts) {
                    const bundleProductId = bundleProduct.productId;
                    console.log('🔍 Processing bundle product ID:', bundleProductId, 'Type:', typeof bundleProductId);
                    
                    // Validate GUID format
                    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (!guidRegex.test(bundleProductId)) {
                        throw new Error(`Invalid GUID format for bundle product ID: ${bundleProductId}`);
                    }
                    
                    // Validate LinkedToProductId if provided
                    let linkedToProductId = null;
                    if (bundleProduct.linkedToProductId) {
                        if (guidRegex.test(bundleProduct.linkedToProductId)) {
                            linkedToProductId = bundleProduct.linkedToProductId;
                        } else {
                            console.warn(`⚠️ Invalid GUID format for linkedToProductId: ${bundleProduct.linkedToProductId}, ignoring`);
                        }
                    }
                    
                    const allowedConfigOptionsJson = (bundleProduct.allowedConfigOptions && typeof bundleProduct.allowedConfigOptions === 'object')
                        ? JSON.stringify(bundleProduct.allowedConfigOptions)
                        : null;

                    const bundleRequest = transaction.request();
                    bundleRequest.input('ProductBundleId', sql.UniqueIdentifier, uuidv4());
                    bundleRequest.input('BundleProductId', sql.UniqueIdentifier, productId);
                    bundleRequest.input('IncludedProductId', sql.UniqueIdentifier, bundleProductId);
                    bundleRequest.input('SortOrder', sql.Int, bundleProduct.sortOrder || sortOrder++);
                    bundleRequest.input('IsRequired', sql.Bit, bundleProduct.isRequired || true);
                    bundleRequest.input('HidePricing', sql.Bit, bundleProduct.hidePricing || false);
                    bundleRequest.input('LinkedToProductId', sql.UniqueIdentifier, linkedToProductId);
                    bundleRequest.input('AllowedConfigOptions', sql.NVarChar, allowedConfigOptionsJson);
                    bundleRequest.input('CreatedDate', sql.DateTime2, new Date());

                    await bundleRequest.query(`
                        INSERT INTO oe.ProductBundles (
                            ProductBundleId, BundleProductId, IncludedProductId,
                            SortOrder, IsRequired, HidePricing, LinkedToProductId, AllowedConfigOptions, CreatedDate
                        ) VALUES (
                            @ProductBundleId, @BundleProductId, @IncludedProductId,
                            @SortOrder, @IsRequired, @HidePricing, @LinkedToProductId, @AllowedConfigOptions, @CreatedDate
                        )
                    `);
                }
            }

            // Bundle state inheritance: compute AllowedStates from included products' intersection
            if (isBundle && bundleProducts && bundleProducts.length > 0) {
                const bundleStatesReq = transaction.request();
                bundleStatesReq.input('BundleProductId', sql.UniqueIdentifier, productId);
                const bundleStatesResult = await bundleStatesReq.query(`
                    SELECT p.AllowedStates
                    FROM oe.ProductBundles pb
                    JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                    WHERE pb.BundleProductId = @BundleProductId
                `);
                const includedStatesArrays = bundleStatesResult.recordset
                    .map(r => { try { return JSON.parse(r.AllowedStates || '[]'); } catch { return []; } })
                    .filter(arr => Array.isArray(arr) && arr.length > 0);
                if (includedStatesArrays.length > 0) {
                    const intersection = includedStatesArrays.reduce((acc, states) =>
                        acc.filter(s => states.includes(s)), [...includedStatesArrays[0]]);
                    const updateStatesReq = transaction.request();
                    updateStatesReq.input('ProductId', sql.UniqueIdentifier, productId);
                    updateStatesReq.input('AllowedStates', sql.NVarChar, JSON.stringify(intersection));
                    await updateStatesReq.query(`UPDATE oe.Products SET AllowedStates = @AllowedStates WHERE ProductId = @ProductId`);
                    console.log(`✅ Bundle ${productId}: inherited AllowedStates from included products (${intersection.length} states)`);
                }
            }

            // Ensure product owner has active subscription records
            const ownerSystemFeesRequest = transaction.request();
            ownerSystemFeesRequest.input('tenantId', sql.UniqueIdentifier, productOwnerId);
            const ownerSystemFeesResult = await ownerSystemFeesRequest.query(`
                SELECT SystemFees FROM oe.Tenants WHERE TenantId = @tenantId
            `);

            const rawOwnerSystemFees = ownerSystemFeesResult.recordset[0]?.SystemFees;
            const ownerSystemFees = typeof rawOwnerSystemFees === 'string'
                ? rawOwnerSystemFees
                : JSON.stringify(rawOwnerSystemFees || DEFAULT_SYSTEM_FEES);

            const tenantSubscriptionCheck = transaction.request();
            tenantSubscriptionCheck.input('tenantId', sql.UniqueIdentifier, productOwnerId);
            tenantSubscriptionCheck.input('productId', sql.UniqueIdentifier, productId);
            const existingTenantSubscription = await tenantSubscriptionCheck.query(`
                SELECT SubscriptionId, SubscriptionStatus
                FROM oe.TenantProductSubscriptions
                WHERE TenantId = @tenantId AND ProductId = @productId
            `);

            if (existingTenantSubscription.recordset.length === 0) {
                const tenantSubscriptionId = uuidv4();
                const createTenantSubscription = transaction.request();
                createTenantSubscription.input('subscriptionId', sql.UniqueIdentifier, tenantSubscriptionId);
                createTenantSubscription.input('tenantId', sql.UniqueIdentifier, productOwnerId);
                createTenantSubscription.input('productId', sql.UniqueIdentifier, productId);
                createTenantSubscription.input('subscriptionStatus', sql.NVarChar(50), 'Active');
                createTenantSubscription.input('tenantRate', sql.Decimal(19, 4), 0);
                createTenantSubscription.input('systemFeesSnapshot', sql.NVarChar, ownerSystemFees);
                createTenantSubscription.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
                createTenantSubscription.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
                const now = new Date();
                createTenantSubscription.input('subscriptionDate', sql.DateTime2, now);
                createTenantSubscription.input('modifiedDate', sql.DateTime2, now);
                createTenantSubscription.input('isConfigured', sql.Bit, 0);

                await createTenantSubscription.query(`
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

                console.log(`✅ Inserted tenant-owned subscription into oe.TenantProductSubscriptions (SubscriptionId=${tenantSubscriptionId})`);
            } else {
                const existingTenantSub = existingTenantSubscription.recordset[0];
                console.log(`ℹ️ TenantProductSubscriptions already exists (SubscriptionId=${existingTenantSub.SubscriptionId}, Status=${existingTenantSub.SubscriptionStatus})`);
            }

            const ownerProductSubscriptionCheck = transaction.request();
            ownerProductSubscriptionCheck.input('tenantId', sql.UniqueIdentifier, productOwnerId);
            ownerProductSubscriptionCheck.input('productId', sql.UniqueIdentifier, productId);
            const existingProductSubscription = await ownerProductSubscriptionCheck.query(`
                SELECT ProductSubscriptionId, Status
                FROM oe.ProductSubscriptions
                WHERE TenantId = @tenantId AND ProductId = @productId
            `);

            if (existingProductSubscription.recordset.length === 0) {
                const productSubscriptionId = uuidv4();
                const createProductSubscription = transaction.request();
                createProductSubscription.input('productSubscriptionId', sql.UniqueIdentifier, productSubscriptionId);
                createProductSubscription.input('productId', sql.UniqueIdentifier, productId);
                createProductSubscription.input('tenantId', sql.UniqueIdentifier, productOwnerId);
                createProductSubscription.input('status', sql.NVarChar(20), 'Approved');
                const now = new Date();
                createProductSubscription.input('requestDate', sql.DateTime2, now);
                createProductSubscription.input('approvalDate', sql.DateTime2, now);
                createProductSubscription.input('discountAmount', sql.Decimal(19, 4), 0);
                createProductSubscription.input('serviceFeePerMember', sql.Decimal(19, 4), 0);
                createProductSubscription.input('notes', sql.NVarChar(sql.MAX), 'Auto-approved for product owner');
                createProductSubscription.input('approvedBy', sql.UniqueIdentifier, req.user.UserId);
                createProductSubscription.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
                createProductSubscription.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

                await createProductSubscription.query(`
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
                const existingProductSub = existingProductSubscription.recordset[0];
                console.log(`ℹ️ ProductSubscriptions already exists (ProductSubscriptionId=${existingProductSub.ProductSubscriptionId}, Status=${existingProductSub.Status})`);
            }

            await transaction.commit();

            // Fire-and-forget AI extraction enqueue for any new docs. Do NOT await — the
            // Service Bus send must never block the HTTP response. Errors are caught
            // inside queueDocumentExtraction and surfaced as ExtractionStatus='failed'
            // on the document row, which the chunks UI can re-trigger.
            if (req._docsToEnqueueAfterCommit && req._docsToEnqueueAfterCommit.length > 0) {
                const docs = req._docsToEnqueueAfterCommit;
                req._docsToEnqueueAfterCommit = [];
                setImmediate(() => {
                    docs.forEach((d) => {
                        queueDocumentExtraction(pool, sql, d).catch((err) => {
                            console.warn('[products] background extraction enqueue failed:', err && err.message);
                        });
                    });
                });
            }

            res.status(201).json({
                success: true,
                productId: productId,
                message: 'Product created successfully'
            });

        } catch (transactionError) {
            await transaction.rollback();
            console.error('Transaction error:', transactionError);
            throw transactionError;
        }

    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create product',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * PUT /api/products/:id
 * Update existing product
 */
router.put('/:id', authenticate, requireTenantAccess(['Admin', 'SysAdmin', 'TenantAdmin']), upload.fields([
  { name: 'productImageFile', maxCount: 1 },
  { name: 'productLogoFile', maxCount: 1 },
  { name: 'productDocumentFile', maxCount: 1 },
  { name: 'idCardLogoFile', maxCount: 1 },
  { name: 'planDetailsHeaderLogoFile', maxCount: 1 }
]), async (req, res) => {
    try {
        const productId = req.params.id;
        console.log('📝 Updating product:', productId);
        console.log('🔍 UPDATE ENDPOINT HIT - RequiredASA in body:', req.body.requiredASA);
        
        // Validate productId is a valid GUID
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRegex.test(productId)) {
            return res.status(400).json({
                success: false,
                message: `Invalid GUID format for productId: ${productId}`
            });
        }
        
        const {
            vendorId,
            isVendorPricing,
            vendorCommission,
            name,
            description,
            productType,
            salesType,
            productOwnerId,
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
            productDocuments,
            deleteProductImage,
            deleteProductLogo,
            deleteProductDocument,
            acknowledgementQuestions,
            productQuestionnaires,  // Product questionnaire JSON
            idCardData,        // NEW
            planDetailsData,   // NEW
            aiChunks,        // NEW
            requiredASA,       // NEW
            trainingConfig,    // Training (agent/member) JSON
            medicalNeedsLinksConfig, // Member portal medical needs request links JSON
            isPublic,         // NEW
            isHidden,         // NEW - Hide products from agents (typically for bundle components)
            isSSNRequired,    // NEW - Require SSN for enrollment in this product
            vendorGroupIdProductType,  // Master/CoPay/HSA/None for vendor group ID generation
            eligibilityIndividualVendorGroupId,  // Default vendor group ID for individual (no-group) enrollments
            eligibilityVendorGroupFallbackProductId,
            showGroupIdOnIDCard,
            premiumReportingCategory,
            idCardMemberIdPrefixMask,
            includeProcessingFee,
            roundUpProcessingFee,
            processingFeePercentage,
            manualIncludedProcessingFee,
            planId,  // Vendor-assigned plan identifier
        } = req.body;

        const manualIncludedProcessingFeeBoolUpdate =
            manualIncludedProcessingFee !== undefined ? toBoolProductFlag(manualIncludedProcessingFee) : null;
        const includeProcessingFeeBoolUpdate =
            manualIncludedProcessingFeeBoolUpdate === true
                ? true
                : includeProcessingFee !== undefined
                  ? toBoolProductFlag(includeProcessingFee)
                  : null;
        const roundUpProcessingFeeBoolUpdate =
            manualIncludedProcessingFeeBoolUpdate === true
                ? false
                : includeProcessingFee !== undefined
                  ? roundUpProcessingFee === false || roundUpProcessingFee === 'false'
                      ? false
                      : roundUpProcessingFee === undefined || roundUpProcessingFee === null
                        ? true
                        : toBoolProductFlag(roundUpProcessingFee)
                  : null;
        const processingFeePctValueUpdate =
            manualIncludedProcessingFeeBoolUpdate === true
                ? null
                : includeProcessingFee !== undefined
                  ? processingFeePercentage != null && String(processingFeePercentage).trim() !== ''
                      ? parseFloat(processingFeePercentage)
                      : null
                  : undefined;

        console.log('📝 Backend received vendorCommission:', vendorCommission, 'Type:', typeof vendorCommission);
        console.log('🔍 Vendor pricing data:', {
            vendorId,
            isVendorPricing,
            vendorCommission
        });
        console.log('🤖 AI Chunks data:', aiChunks, 'Type:', typeof aiChunks);
        console.log('🗑️ Deletion flags:', {
            deleteProductImage,
            deleteProductLogo,
            deleteProductDocument
        });
        console.log('🖼️ Logo URL data:', {
            productLogoUrl,
            hasProductLogoUrl: !!productLogoUrl,
            logoUrlType: typeof productLogoUrl
        });

        // Debug isPublic and isHidden values
        console.log('🔳 Visibility flags received:', {
            isPublic,
            isPublicType: typeof isPublic,
            isPublicFinal: isPublic || false,
            isHidden,
            isHiddenType: typeof isHidden,
            isHiddenFinal: isHidden || false
        });

        // Validate vendorId if provided
        console.log('🔍 Validating vendorId:', { vendorId, type: typeof vendorId, isEmpty: vendorId === '' });
        if (vendorId !== undefined && vendorId !== null && vendorId !== '') {
            const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!guidRegex.test(vendorId)) {
                console.error('❌ Invalid vendorId format:', vendorId);
                return res.status(400).json({
                    success: false,
                    message: `Invalid GUID format for vendorId: ${vendorId}`
                });
            }
            console.log('✅ vendorId is valid GUID');
        } else {
            console.log('ℹ️ vendorId not provided or empty, will preserve existing value');
        }

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

        let parsedProductDocuments = [];
        if (productDocuments !== undefined) {
            try {
                parsedProductDocuments = typeof productDocuments === 'string' ? JSON.parse(productDocuments) : (Array.isArray(productDocuments) ? productDocuments : []);
            } catch (error) {
                console.error('❌ Error parsing productDocuments:', error);
                parsedProductDocuments = [];
            }
        }

        const pool = await getPool();
        
        // Get current product to check for file changes
        const currentProductRequest = pool.request();
        currentProductRequest.input('ProductId', sql.UniqueIdentifier, productId);
        
        const currentProductResult = await currentProductRequest.query(`
            SELECT ProductImageUrl, ProductLogoUrl, ProductDocumentUrl, VendorId, IsBundle, EligibilityVendorGroupFallbackProductId,
                   IncludeProcessingFee, RoundUpProcessingFee, ProcessingFeePercentage, ProductOwnerId
            FROM oe.Products
            WHERE ProductId = @ProductId
        `);
        
        const currentProduct = currentProductResult.recordset[0];
        if (!currentProduct) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        const effectiveIncludeProcessingFeeBool =
            includeProcessingFeeBoolUpdate !== null
                ? includeProcessingFeeBoolUpdate
                : toBoolProductFlag(currentProduct.IncludeProcessingFee);
        const effectiveRoundUpProcessingFeeBool =
            roundUpProcessingFeeBoolUpdate !== null
                ? roundUpProcessingFeeBoolUpdate
                : !(currentProduct.RoundUpProcessingFee === false || currentProduct.RoundUpProcessingFee === 0);
        const effectiveProcessingFeePct =
            processingFeePctValueUpdate !== undefined
                ? processingFeePctValueUpdate
                : currentProduct.ProcessingFeePercentage != null
                  ? Number(currentProduct.ProcessingFeePercentage)
                  : null;

        const isBundleBool = isBundleProductFlag(isBundle) || isBundleProductFlag(currentProduct.IsBundle);

        const effectiveVendorId = isBundleBool
            ? null
            : vendorId !== undefined && vendorId !== null && vendorId !== ''
                ? vendorId
                : currentProduct.VendorId;

        let fbValueForUpdate;
        if (eligibilityVendorGroupFallbackProductId !== undefined) {
            const fbNormUpdate = isBundleBool
                ? { value: null, error: null }
                : await normalizeEligibilityVendorGroupFallbackProductId(
                    pool,
                    effectiveVendorId,
                    productId,
                    eligibilityVendorGroupFallbackProductId
                );
            if (fbNormUpdate.error) {
                return res.status(400).json({ success: false, message: fbNormUpdate.error });
            }
            fbValueForUpdate = fbNormUpdate.value;
        } else {
            fbValueForUpdate = currentProduct.EligibilityVendorGroupFallbackProductId ?? null;
        }

        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Update main product record with vendor fields
            const updateRequest = transaction.request();
            updateRequest.input('ProductId', sql.UniqueIdentifier, productId);
            
            // Bundles never keep a VendorId; non-bundles update when provided
            if (isBundleBool) {
                updateRequest.input('VendorId', sql.UniqueIdentifier, null);
            } else if (vendorId !== undefined && vendorId !== null && vendorId !== '') {
                updateRequest.input('VendorId', sql.UniqueIdentifier, vendorId);
            }
            
            updateRequest.input('IsVendorPrice', sql.Bit, isVendorPricing || false);
            
            const commissionValue = parseFloat(vendorCommission) || 0;
            console.log('💰 Setting VendorCommission SQL param:', commissionValue);
            
            updateRequest.input('VendorCommission', sql.Decimal(19, 4), commissionValue);
            updateRequest.input('ProductOwnerId', sql.UniqueIdentifier, productOwnerId);
            updateRequest.input('Name', sql.NVarChar, name);
            updateRequest.input('Description', sql.NVarChar, description || '');
            updateRequest.input('ProductType', sql.NVarChar, productType);
            updateRequest.input('SalesType', sql.NVarChar, salesType || 'Both');
            updateRequest.input('MinAge', sql.Int, minAge || null);
            updateRequest.input('MaxAge', sql.Int, maxAge || null);
            updateRequest.input('AllowedStates', sql.NVarChar, allowedStates ? JSON.stringify(allowedStates) : null);
            updateRequest.input('RequiresTobaccoInfo', sql.Bit, requiresTobaccoInfo || false);
            updateRequest.input('EffectiveDateLogic', sql.NVarChar, effectiveDateLogic || 'FirstOfMonth');
            updateRequest.input('MaxEffectiveDateDays', sql.Int, maxEffectiveDateDays || 60);
            updateRequest.input('TerminationLogic', sql.NVarChar, terminationLogic || null);
            updateRequest.input('RequiredLicenses', sql.NVarChar, requiredLicenses ? JSON.stringify(requiredLicenses) : null);
            updateRequest.input('RequiredDataFields', sql.NVarChar, configurationFields ? JSON.stringify(configurationFields) : null);
            updateRequest.input('AcknowledgementQuestions', sql.NVarChar, acknowledgementQuestions ? JSON.stringify(acknowledgementQuestions) : null);
            updateRequest.input('ProductQuestionnaires', sql.NVarChar, productQuestionnaires ? (typeof productQuestionnaires === 'string' ? productQuestionnaires : JSON.stringify(productQuestionnaires)) : null);
            updateRequest.input('IDCardData', sql.NVarChar(sql.MAX), idCardData ? JSON.stringify(idCardData) : null);
            updateRequest.input('PlanDetailsData', sql.NVarChar(sql.MAX), planDetailsData ? JSON.stringify(planDetailsData) : null);
            console.log('🔍 RequiredASA data:', requiredASA, 'Type:', typeof requiredASA);
            updateRequest.input('RequiredASA', sql.NVarChar(sql.MAX), requiredASA ? JSON.stringify(requiredASA) : null);
            updateRequest.input('TrainingConfig', sql.NVarChar(sql.MAX), trainingConfig != null ? (typeof trainingConfig === 'string' ? trainingConfig : JSON.stringify(trainingConfig)) : null);
            updateRequest.input('MedicalNeedsLinksConfig', sql.NVarChar(sql.MAX), medicalNeedsLinksConfig != null ? (typeof medicalNeedsLinksConfig === 'string' ? medicalNeedsLinksConfig : JSON.stringify(medicalNeedsLinksConfig)) : null);
            const normalizedVendorGroupIdProductTypeUpdate = (() => { const v = vendorGroupIdProductType; if (!v || v === '') return null; const n = parseInt(String(v), 10); if (!Number.isNaN(n) && n >= 0 && n <= 9) return String(n); if (['Master', 'CoPay', 'HSA', 'None'].includes(v)) return v; return null; })();
            updateRequest.input('VendorGroupIdProductType', sql.NVarChar, normalizedVendorGroupIdProductTypeUpdate);
            updateRequest.input('EligibilityIndividualVendorGroupId', sql.NVarChar(50), eligibilityIndividualVendorGroupId?.trim() || null);
            updateRequest.input('EligibilityVendorGroupFallbackProductId', sql.UniqueIdentifier, fbValueForUpdate || null);
            const { resolveShowGroupIdOnIDCardBit: resolveShowGroupIdOnIDCardBitUpdate } = require('../utils/productVendorGroupId');
            updateRequest.input('ShowGroupIdOnIDCard', sql.Bit, resolveShowGroupIdOnIDCardBitUpdate(normalizedVendorGroupIdProductTypeUpdate, showGroupIdOnIDCard));
            const premiumCatUpdate = premiumReportingCategory === 'NonProfit' ? 'NonProfit' : 'ForProfit';
            updateRequest.input('PremiumReportingCategory', sql.NVarChar(20), premiumCatUpdate);
            const idMaskUpdate =
                idCardMemberIdPrefixMask != null && String(idCardMemberIdPrefixMask).trim() !== ''
                    ? String(idCardMemberIdPrefixMask).trim().slice(0, 10)
                    : null;
            updateRequest.input('IDCardMemberIdPrefixMask', sql.NVarChar(10), idMaskUpdate);
            updateRequest.input('PlanId', sql.NVarChar(100), planId != null && String(planId).trim() !== '' ? String(planId).trim() : null);
            // Ensure boolean conversion for bit fields
            const isPublicBool = isPublic === true || isPublic === 'true' || isPublic === 1;
            const isHiddenBool = isHidden === true || isHidden === 'true' || isHidden === 1;
            const isSSNRequiredBool = isSSNRequired === true || isSSNRequired === 'true' || isSSNRequired === 1;
            console.log('🔳 Saving visibility flags:', { isPublicBool, isHiddenBool, isSSNRequiredBool, originalIsPublic: isPublic, originalIsHidden: isHidden, originalIsSSNRequired: isSSNRequired });
            updateRequest.input('IsPublic', sql.Bit, isPublicBool);
            updateRequest.input('IsHidden', sql.Bit, isHiddenBool);
            updateRequest.input('IsSSNRequired', sql.Bit, isSSNRequiredBool);
            if (includeProcessingFeeBoolUpdate !== null || manualIncludedProcessingFeeBoolUpdate !== null) {
                const effectiveIncludeProcessingFee =
                    includeProcessingFeeBoolUpdate != null
                        ? includeProcessingFeeBoolUpdate
                        : manualIncludedProcessingFeeBoolUpdate === true
                          ? true
                          : toBoolProductFlag(currentProduct.IncludeProcessingFee);
                const effectiveRoundUp =
                    roundUpProcessingFeeBoolUpdate != null
                        ? roundUpProcessingFeeBoolUpdate
                        : manualIncludedProcessingFeeBoolUpdate === true
                          ? false
                          : !(currentProduct.RoundUpProcessingFee === false || currentProduct.RoundUpProcessingFee === 0);
                const effectivePct =
                    processingFeePctValueUpdate !== undefined
                        ? processingFeePctValueUpdate
                        : manualIncludedProcessingFeeBoolUpdate === true
                          ? null
                          : currentProduct.ProcessingFeePercentage != null
                            ? Number(currentProduct.ProcessingFeePercentage)
                            : null;
                updateRequest.input('IncludeProcessingFee', sql.Bit, effectiveIncludeProcessingFee ? 1 : 0);
                updateRequest.input('RoundUpProcessingFee', sql.Bit, effectiveRoundUp ? 1 : 0);
                updateRequest.input('ProcessingFeePercentage', sql.Decimal(9, 4), effectivePct);
                updateRequest.input(
                    'ManualIncludedProcessingFee',
                    sql.Bit,
                    manualIncludedProcessingFeeBoolUpdate != null
                        ? manualIncludedProcessingFeeBoolUpdate
                            ? 1
                            : 0
                        : toBoolProductFlag(currentProduct.ManualIncludedProcessingFee)
                            ? 1
                            : 0
                );
            }
            updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
            updateRequest.input('ModifiedDate', sql.DateTime2, new Date());

            // Handle media deletions and updates
            if (deleteProductImage === 'true' || deleteProductImage === true) {
                updateRequest.input('ProductImageUrl', sql.NVarChar, null);
                console.log('🗑️ Deleting ProductImageUrl');
            } else if (productImageUrl !== undefined) {
                updateRequest.input('ProductImageUrl', sql.NVarChar, productImageUrl);
                console.log('🖼️ Updating ProductImageUrl:', productImageUrl);
            }
            
            if (deleteProductLogo === 'true' || deleteProductLogo === true) {
                updateRequest.input('ProductLogoUrl', sql.NVarChar, null);
                console.log('🗑️ Deleting ProductLogoUrl');
            } else if (productLogoUrl !== undefined) {
                updateRequest.input('ProductLogoUrl', sql.NVarChar, productLogoUrl);
                console.log('🖼️ Updating ProductLogoUrl:', productLogoUrl);
            }
            
            if (deleteProductDocument === 'true' || deleteProductDocument === true) {
                updateRequest.input('ProductDocumentUrl', sql.NVarChar, null);
                console.log('🗑️ Deleting ProductDocumentUrl');
            } else if (productDocumentUrl !== undefined) {
                updateRequest.input('ProductDocumentUrl', sql.NVarChar, productDocumentUrl);
                console.log('📄 Updating ProductDocumentUrl:', productDocumentUrl);
            }

            // Build update query conditionally based on what fields are provided
            let updateQuery = `
                UPDATE oe.Products 
                SET 
                    ${isBundleBool || (vendorId !== undefined && vendorId !== null && vendorId !== '') ? 'VendorId = @VendorId,' : ''}
                    IsVendorPrice = @IsVendorPrice,
                    VendorCommission = @VendorCommission,
                    ProductOwnerId = @ProductOwnerId,
                    Name = @Name,
                    Description = @Description,
                    ProductType = @ProductType,
                    SalesType = @SalesType,
                    MinAge = @MinAge,
                    MaxAge = @MaxAge,
                    AllowedStates = @AllowedStates,
                    RequiresTobaccoInfo = @RequiresTobaccoInfo,
                    EffectiveDateLogic = @EffectiveDateLogic,
                    MaxEffectiveDateDays = @MaxEffectiveDateDays,
                    TerminationLogic = @TerminationLogic,
                    RequiredLicenses = @RequiredLicenses,
                    RequiredDataFields = @RequiredDataFields,
                    AcknowledgementQuestions = @AcknowledgementQuestions,
                    ProductQuestionnaires = @ProductQuestionnaires,
                    IDCardData = @IDCardData,
                    PlanDetailsData = @PlanDetailsData,
                    RequiredASA = @RequiredASA,
                    TrainingConfig = @TrainingConfig,
                    MedicalNeedsLinksConfig = @MedicalNeedsLinksConfig,
                    VendorGroupIdProductType = @VendorGroupIdProductType,
                    EligibilityIndividualVendorGroupId = @EligibilityIndividualVendorGroupId,
                    EligibilityVendorGroupFallbackProductId = @EligibilityVendorGroupFallbackProductId,
                    ShowGroupIdOnIDCard = @ShowGroupIdOnIDCard,
                    PremiumReportingCategory = @PremiumReportingCategory,
                    IDCardMemberIdPrefixMask = @IDCardMemberIdPrefixMask,
                    PlanId = @PlanId,
                    IsPublic = @IsPublic,
                    IsHidden = @IsHidden,
                    IsSSNRequired = @IsSSNRequired,
                    ${includeProcessingFeeBoolUpdate !== null || manualIncludedProcessingFeeBoolUpdate !== null ? `
                    IncludeProcessingFee = @IncludeProcessingFee,
                    RoundUpProcessingFee = @RoundUpProcessingFee,
                    ProcessingFeePercentage = @ProcessingFeePercentage,
                    ManualIncludedProcessingFee = @ManualIncludedProcessingFee,` : ''}
                    ModifiedBy = @ModifiedBy,
                    ModifiedDate = @ModifiedDate
            `;

            // Helper function to compare URLs without query parameters (SAS tokens)
            const getBaseUrl = (url) => url ? url.split('?')[0] : null;

            // Add media URL updates/deletions
            if (deleteProductImage === 'true' || deleteProductImage === true || productImageUrl !== undefined) {
                updateQuery += ', ProductImageUrl = @ProductImageUrl';
                // Delete old file if it exists and is different, or if we're deleting
                const currentBaseUrl = getBaseUrl(currentProduct.ProductImageUrl);
                const newBaseUrl = getBaseUrl(productImageUrl);
                if (currentProduct.ProductImageUrl && (currentBaseUrl !== newBaseUrl || deleteProductImage === 'true' || deleteProductImage === true)) {
                    await deleteFileFromBlob(currentProduct.ProductImageUrl);
                }
            }
            if (deleteProductLogo === 'true' || deleteProductLogo === true || productLogoUrl !== undefined) {
                updateQuery += ', ProductLogoUrl = @ProductLogoUrl';
                // Delete old file if it exists and is different, or if we're deleting
                const currentBaseUrl = getBaseUrl(currentProduct.ProductLogoUrl);
                const newBaseUrl = getBaseUrl(productLogoUrl);
                if (currentProduct.ProductLogoUrl && (currentBaseUrl !== newBaseUrl || deleteProductLogo === 'true' || deleteProductLogo === true)) {
                    await deleteFileFromBlob(currentProduct.ProductLogoUrl);
                }
            }
            if (deleteProductDocument === 'true' || deleteProductDocument === true || productDocumentUrl !== undefined) {
                updateQuery += ', ProductDocumentUrl = @ProductDocumentUrl';
                // Delete old file if it exists and is different, or if we're deleting
                const currentBaseUrl = getBaseUrl(currentProduct.ProductDocumentUrl);
                const newBaseUrl = getBaseUrl(productDocumentUrl);
                if (currentProduct.ProductDocumentUrl && (currentBaseUrl !== newBaseUrl || deleteProductDocument === 'true' || deleteProductDocument === true)) {
                    await deleteFileFromBlob(currentProduct.ProductDocumentUrl);
                }
            }

            updateQuery += ' WHERE ProductId = @ProductId';

            const updateResult = await updateRequest.query(updateQuery);

            if (updateResult.rowsAffected[0] === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Product not found'
                });
            }

            const previousProductOwnerId = currentProduct.ProductOwnerId
                ? currentProduct.ProductOwnerId.toString()
                : null;
            const nextProductOwnerId = productOwnerId ? String(productOwnerId).trim() : null;
            const ownerChanged = Boolean(
                nextProductOwnerId
                && previousProductOwnerId
                && nextProductOwnerId.toLowerCase() !== previousProductOwnerId.toLowerCase()
            );

            if (ownerChanged) {
                const formerOwnerResult = await ensureTenantProductSubscription(transaction, sql, {
                    tenantId: previousProductOwnerId,
                    productId,
                    userId: req.user.UserId,
                    productSubscriptionNotes: 'Retained as subscriber after product owner transfer'
                });
                if (!formerOwnerResult.ok) {
                    throw new Error(formerOwnerResult.message || 'Failed to retain former product owner as subscriber');
                }

                const newOwnerResult = await ensureTenantProductSubscription(transaction, sql, {
                    tenantId: nextProductOwnerId,
                    productId,
                    userId: req.user.UserId,
                    productSubscriptionNotes: 'Auto-approved for product owner'
                });
                if (!newOwnerResult.ok) {
                    throw new Error(newOwnerResult.message || 'Failed to subscribe new product owner');
                }

                console.log('✅ Product owner transfer subscriptions ensured', {
                    productId,
                    previousProductOwnerId,
                    nextProductOwnerId,
                    formerOwner: formerOwnerResult,
                    newOwner: newOwnerResult
                });
            }

            // Sync ProductDocuments — diff against existing rows so we PRESERVE
            // ProductDocumentIds for docs that haven't changed. This is critical because
            // oe.AIChunks.SourceDocumentId has an FK to oe.ProductDocuments; a blanket
            // DELETE-then-INSERT would orphan the chunks and trip the FK constraint.
            const shouldSyncDocs = productDocuments !== undefined || (productDocumentUrl !== undefined && parsedProductDocuments.length === 0);
            if (shouldSyncDocs) {
                const docsToSync = parsedProductDocuments.length > 0
                    ? parsedProductDocuments
                    : (productDocumentUrl ? [{ documentUrl: productDocumentUrl, displayName: 'Document', sortOrder: 0 }] : []);

                // Load current docs for this product
                const existingDocsReq = transaction.request();
                existingDocsReq.input('ProductId', sql.UniqueIdentifier, productId);
                const existingDocsResult = await existingDocsReq.query(`
                    SELECT ProductDocumentId, DocumentUrl, DisplayName, SortOrder
                    FROM oe.ProductDocuments
                    WHERE ProductId = @ProductId
                `);
                const existingDocs = existingDocsResult.recordset || [];
                const existingById = new Map(existingDocs.map(d => [String(d.ProductDocumentId).toLowerCase(), d]));
                const existingByUrl = new Map(existingDocs.map(d => [d.DocumentUrl, d]));

                const keepIds = new Set();
                const docsToEnqueueAfterCommit = [];

                for (let sortOrder = 0; sortOrder < docsToSync.length; sortOrder++) {
                    const doc = docsToSync[sortOrder];
                    const docUrl = doc.documentUrl || doc.DocumentUrl;
                    if (!docUrl) continue;
                    const displayName = doc.displayName || doc.DisplayName || null;
                    const order = doc.sortOrder ?? doc.SortOrder ?? sortOrder;
                    const explicitId = doc.productDocumentId || doc.ProductDocumentId;

                    // Match by explicit id first (most reliable), then by URL
                    let match = (explicitId && existingById.get(String(explicitId).toLowerCase())) || existingByUrl.get(docUrl);

                    if (match) {
                        // Preserve existing ProductDocumentId; just update label / sortOrder
                        keepIds.add(String(match.ProductDocumentId).toLowerCase());
                        const updReq = transaction.request();
                        updReq.input('Id', sql.UniqueIdentifier, match.ProductDocumentId);
                        updReq.input('DisplayName', sql.NVarChar, displayName);
                        updReq.input('SortOrder', sql.Int, order);
                        updReq.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
                        await updReq.query(`
                            UPDATE oe.ProductDocuments
                            SET DisplayName = @DisplayName, SortOrder = @SortOrder, ModifiedBy = @ModifiedBy
                            WHERE ProductDocumentId = @Id
                        `);
                    } else {
                        // Genuinely new — INSERT with ExtractionStatus='queued' and enqueue
                        const docId = uuidv4();
                        const insReq = transaction.request();
                        insReq.input('ProductDocumentId', sql.UniqueIdentifier, docId);
                        insReq.input('ProductId', sql.UniqueIdentifier, productId);
                        insReq.input('DocumentUrl', sql.NVarChar, docUrl);
                        insReq.input('DisplayName', sql.NVarChar, displayName);
                        insReq.input('SortOrder', sql.Int, order);
                        insReq.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
                        insReq.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
                        await insReq.query(`
                            INSERT INTO oe.ProductDocuments (ProductDocumentId, ProductId, DocumentUrl, DisplayName, SortOrder, CreatedBy, ModifiedBy, ExtractionStatus)
                            VALUES (@ProductDocumentId, @ProductId, @DocumentUrl, @DisplayName, @SortOrder, @CreatedBy, @ModifiedBy, 'queued')
                        `);
                        keepIds.add(String(docId).toLowerCase());
                        docsToEnqueueAfterCommit.push({
                            productDocumentId: docId,
                            productId,
                            tenantId: (req.user && req.user.TenantId) || productOwnerId,
                            blobUrl: docUrl,
                            fileName: displayName || 'document',
                        });
                    }
                }

                // Delete docs the client removed. We must drop their AIChunks first
                // (FK_AIChunks_SourceDocument) before deleting the document row itself.
                for (const existing of existingDocs) {
                    if (!keepIds.has(String(existing.ProductDocumentId).toLowerCase())) {
                        const delChunksReq = transaction.request();
                        delChunksReq.input('DocId', sql.UniqueIdentifier, existing.ProductDocumentId);
                        await delChunksReq.query(`DELETE FROM oe.AIChunks WHERE SourceDocumentId = @DocId`);
                        const delDocReq = transaction.request();
                        delDocReq.input('DocId', sql.UniqueIdentifier, existing.ProductDocumentId);
                        await delDocReq.query(`DELETE FROM oe.ProductDocuments WHERE ProductDocumentId = @DocId`);
                    }
                }

                req._docsToEnqueueAfterCommit = (req._docsToEnqueueAfterCommit || []).concat(docsToEnqueueAfterCommit);
            }

            // Synchronize pricing tiers without recreating locked entries
            const existingPricingRequest = transaction.request();
            existingPricingRequest.input('ProductId', sql.UniqueIdentifier, productId);
            const existingPricingResult = await existingPricingRequest.query(`
                SELECT ProductPricingId, NetRate, OverrideRate, VendorCommission, SystemFees,
                       MinAge, MaxAge, TierType, TobaccoStatus, Label,
                       ConfigValue1, ConfigValue2, ConfigValue3, ConfigValue4, ConfigValue5,
                       Locked, EffectiveDate, TerminationDate
                FROM oe.ProductPricing
                WHERE ProductId = @ProductId AND Status = 'Active'
            `);

            const existingPricingMap = new Map();
            existingPricingResult.recordset.forEach((row) => {
                existingPricingMap.set(row.ProductPricingId, row);
            });

            const normalizeDate = (value) => {
                if (!value) return null;
                const date = new Date(value);
                if (isNaN(date.getTime())) return null;
                return date.toISOString().split('T')[0];
            };

            if (pricingTiers && pricingTiers.length > 0) {
                console.log('🔍 PUT: Processing pricing tiers:', pricingTiers.length);
                for (const tier of pricingTiers) {
                    console.log('🎯 PUT: Processing tier:', tier.tierType, 'with', tier.ageBands?.length, 'age bands');
                    if (!tier.ageBands || tier.ageBands.length === 0) {
                        continue;
                    }

                    for (const band of tier.ageBands) {
                        console.log('🔍 PUT: Processing age band:', {
                            bandId: band.id,
                            netRate: band.netRate,
                            overrideRate: band.overrideRate,
                            commission: band.commission,
                            systemFees: band.systemFees,
                            tobaccoStatus: band.tobaccoStatus,
                            tierType: tier.tierType
                        });

                        const netRateValue = parseFloat(band.netRate) || 0;
                        const overrideRateValue = parseFloat(band.overrideRate) || 0;
                        const commissionValue = parseFloat(band.commission) || 0;
                        const systemFeesValue = parseFloat(band.systemFees) || 0;
                        const componentSum = netRateValue + overrideRateValue + commissionValue + systemFeesValue;
                        const minAgeValue = band.minAge || null;
                        const maxAgeValue = band.maxAge || null;
                        const tobaccoStatusValue = band.tobaccoStatus || 'No';
                        const configValue1 = band.configValue1 || null;
                        const configValue2 = band.configValue2 || null;
                        const configValue3 = band.configValue3 || null;
                        const configValue4 = band.configValue4 || null;
                        const configValue5 = band.configValue5 || null;
                        const effectiveDateValue = band.effectiveDate ? new Date(band.effectiveDate) : new Date();
                        const terminationDateValue = band.terminationDate ? new Date(band.terminationDate) : null;
                        const lockedValue = band.locked ? 1 : 0;
                        const pricingName = `${tier.tierType}_${tobaccoStatusValue}`;

                        if (band.id && existingPricingMap.has(band.id)) {
                            const existingBand = existingPricingMap.get(band.id);
                            const existingLocked = existingBand.Locked === true || existingBand.Locked === 1;

                            if (existingLocked) {
                                const hasChanges =
                                    parseFloat(existingBand.NetRate) !== netRateValue ||
                                    parseFloat(existingBand.OverrideRate) !== overrideRateValue ||
                                    parseFloat(existingBand.VendorCommission) !== commissionValue ||
                                    parseFloat(existingBand.SystemFees) !== systemFeesValue ||
                                    (existingBand.MinAge ?? null) !== minAgeValue ||
                                    (existingBand.MaxAge ?? null) !== maxAgeValue ||
                                    (existingBand.TierType || '') !== (tier.tierType || '') ||
                                    (existingBand.TobaccoStatus || '') !== tobaccoStatusValue ||
                                    (existingBand.Label || null) !== (tier.label || null) ||
                                    (existingBand.ConfigValue1 || null) !== configValue1 ||
                                    (existingBand.ConfigValue2 || null) !== configValue2 ||
                                    (existingBand.ConfigValue3 || null) !== configValue3 ||
                                    (existingBand.ConfigValue4 || null) !== configValue4 ||
                                    (existingBand.ConfigValue5 || null) !== configValue5 ||
                                    normalizeDate(existingBand.EffectiveDate) !== normalizeDate(band.effectiveDate) ||
                                    normalizeDate(existingBand.TerminationDate) !== normalizeDate(band.terminationDate) ||
                                    band.locked === false;

                                if (hasChanges) {
                                    await transaction.rollback();
                                    return res.status(400).json({
                                        success: false,
                                        message: 'Locked pricing bands cannot be edited'
                                    });
                                }
                            }

                            const updatePricingRequest = transaction.request();
                            updatePricingRequest.input('ProductPricingId', sql.UniqueIdentifier, band.id);
                            updatePricingRequest.input('PricingName', sql.NVarChar, pricingName);
                            updatePricingRequest.input('Label', sql.NVarChar, tier.label || null);
                            updatePricingRequest.input('NetRate', sql.Decimal(19, 4), netRateValue);
                            updatePricingRequest.input('OverrideRate', sql.Decimal(19, 4), overrideRateValue);
                            updatePricingRequest.input('VendorCommission', sql.Decimal(19, 4), commissionValue);
                            updatePricingRequest.input('SystemFees', sql.Decimal(19, 4), systemFeesValue);
                            const { msrpRate: msrpValue, includedFee: includedFeeValueUpdate } =
                                await resolveMsrpAndIncludedForBandSave(
                                    transaction,
                                    productOwnerId,
                                    componentSum,
                                    effectiveIncludeProcessingFeeBool,
                                    effectiveRoundUpProcessingFeeBool,
                                    effectiveProcessingFeePct,
                                    band
                                );
                            updatePricingRequest.input('MSRPRate', sql.Decimal(19, 4), msrpValue);
                            updatePricingRequest.input('IncludedProcessingFee', sql.Decimal(19, 4), includedFeeValueUpdate);
                            updatePricingRequest.input('MinAge', sql.Int, minAgeValue);
                            updatePricingRequest.input('MaxAge', sql.Int, maxAgeValue);
                            updatePricingRequest.input('TierType', sql.NVarChar, tier.tierType);
                            updatePricingRequest.input('TobaccoStatus', sql.NVarChar, tobaccoStatusValue);
                            updatePricingRequest.input('ConfigValue1', sql.NVarChar, configValue1);
                            updatePricingRequest.input('ConfigValue2', sql.NVarChar, configValue2);
                            updatePricingRequest.input('ConfigValue3', sql.NVarChar, configValue3);
                            updatePricingRequest.input('ConfigValue4', sql.NVarChar, configValue4);
                            updatePricingRequest.input('ConfigValue5', sql.NVarChar, configValue5);
                            updatePricingRequest.input('Locked', sql.Bit, lockedValue);
                            updatePricingRequest.input('EffectiveDate', sql.Date, effectiveDateValue);
                            updatePricingRequest.input('TerminationDate', sql.Date, terminationDateValue);
                            updatePricingRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);

                            await updatePricingRequest.query(`
                                UPDATE oe.ProductPricing
                                SET PricingName = @PricingName,
                                    Label = @Label,
                                    NetRate = @NetRate,
                                    OverrideRate = @OverrideRate,
                                    VendorCommission = @VendorCommission,
                                    SystemFees = @SystemFees,
                                    MSRPRate = @MSRPRate,
                                    IncludedProcessingFee = @IncludedProcessingFee,
                                    MinAge = @MinAge,
                                    MaxAge = @MaxAge,
                                    TierType = @TierType,
                                    TobaccoStatus = @TobaccoStatus,
                                    ConfigValue1 = @ConfigValue1,
                                    ConfigValue2 = @ConfigValue2,
                                    ConfigValue3 = @ConfigValue3,
                                    ConfigValue4 = @ConfigValue4,
                                    ConfigValue5 = @ConfigValue5,
                                    Locked = @Locked,
                                    EffectiveDate = @EffectiveDate,
                                    TerminationDate = @TerminationDate,
                                    Status = 'Active',
                                    ModifiedDate = GETUTCDATE(),
                                    ModifiedBy = @ModifiedBy
                                WHERE ProductPricingId = @ProductPricingId
                            `);

                            existingPricingMap.delete(band.id);
                        } else {
                            const pricingRequest = transaction.request();
                            const newPricingId = uuidv4();

                            pricingRequest.input('ProductPricingId', sql.UniqueIdentifier, newPricingId);
                            pricingRequest.input('ProductId', sql.UniqueIdentifier, productId);
                            pricingRequest.input('PricingName', sql.NVarChar, pricingName);
                            pricingRequest.input('Label', sql.NVarChar, tier.label || null);
                            pricingRequest.input('NetRate', sql.Decimal(19, 4), netRateValue);
                            pricingRequest.input('OverrideRate', sql.Decimal(19, 4), overrideRateValue);
                            pricingRequest.input('VendorCommission', sql.Decimal(19, 4), commissionValue);
                            pricingRequest.input('SystemFees', sql.Decimal(19, 4), systemFeesValue);
                            const { msrpRate: msrpValueInsert, includedFee: includedFeeValueInsert } =
                                await resolveMsrpAndIncludedForBandSave(
                                    transaction,
                                    productOwnerId,
                                    componentSum,
                                    effectiveIncludeProcessingFeeBool,
                                    effectiveRoundUpProcessingFeeBool,
                                    effectiveProcessingFeePct,
                                    band
                                );
                            pricingRequest.input('MSRPRate', sql.Decimal(19, 4), msrpValueInsert);
                            pricingRequest.input('IncludedProcessingFee', sql.Decimal(19, 4), includedFeeValueInsert);
                            pricingRequest.input('MinAge', sql.Int, minAgeValue);
                            pricingRequest.input('MaxAge', sql.Int, maxAgeValue);
                            pricingRequest.input('TierType', sql.NVarChar, tier.tierType);
                            pricingRequest.input('TobaccoStatus', sql.NVarChar, tobaccoStatusValue);
                            pricingRequest.input('ConfigValue1', sql.NVarChar, configValue1);
                            pricingRequest.input('ConfigValue2', sql.NVarChar, configValue2);
                            pricingRequest.input('ConfigValue3', sql.NVarChar, configValue3);
                            pricingRequest.input('ConfigValue4', sql.NVarChar, configValue4);
                            pricingRequest.input('ConfigValue5', sql.NVarChar, configValue5);
                            pricingRequest.input('Locked', sql.Bit, lockedValue);
                            pricingRequest.input('EffectiveDate', sql.Date, effectiveDateValue);
                            pricingRequest.input('TerminationDate', sql.Date, terminationDateValue);
                            pricingRequest.input('Status', sql.NVarChar, 'Active');
                            pricingRequest.input('CreatedDate', sql.DateTime2, new Date());
                            pricingRequest.input('ModifiedDate', sql.DateTime2, new Date());
                            pricingRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
                            pricingRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);

                            await pricingRequest.query(`
                                INSERT INTO oe.ProductPricing (
                                    ProductPricingId, ProductId, PricingName, Label, NetRate, OverrideRate, VendorCommission, SystemFees, MSRPRate, IncludedProcessingFee,
                                    MinAge, MaxAge, TierType, TobaccoStatus,
                                    ConfigValue1, ConfigValue2, ConfigValue3, ConfigValue4, ConfigValue5,
                                    Locked, EffectiveDate, TerminationDate, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                                ) VALUES (
                                    @ProductPricingId, @ProductId, @PricingName, @Label, @NetRate, @OverrideRate, @VendorCommission, @SystemFees, @MSRPRate, @IncludedProcessingFee,
                                    @MinAge, @MaxAge, @TierType, @TobaccoStatus,
                                    @ConfigValue1, @ConfigValue2, @ConfigValue3, @ConfigValue4, @ConfigValue5,
                                    @Locked, @EffectiveDate, @TerminationDate, @Status, @CreatedDate, @ModifiedDate, @CreatedBy, @ModifiedBy
                                )
                            `);
                        }
                    }
                }
            }

            for (const [existingPricingId, existingBand] of existingPricingMap) {
                if (existingBand.Locked === true || existingBand.Locked === 1) {
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Locked pricing bands cannot be removed'
                    });
                }
                const deactivateRequest = transaction.request();
                deactivateRequest.input('ProductPricingId', sql.UniqueIdentifier, existingPricingId);
                deactivateRequest.input('UserId', sql.UniqueIdentifier, req.user.UserId);
                await deactivateRequest.query(`
                    UPDATE oe.ProductPricing
                    SET Status = 'Inactive',
                        ModifiedDate = GETUTCDATE(),
                        ModifiedBy = @UserId
                    WHERE ProductPricingId = @ProductPricingId
                `);
            }

            // Delete and recreate AI Chunks only when the client sends manual wizard chunks.
            // Empty array = leave document-extracted / API-managed chunks unchanged.
            if (parsedAiChunks && parsedAiChunks.length > 0) {
                const deleteChunksRequest = transaction.request();
                deleteChunksRequest.input('ProductId', sql.UniqueIdentifier, productId);
                await deleteChunksRequest.query('DELETE FROM oe.AIChunks WHERE ProductId = @ProductId');

                for (const chunk of parsedAiChunks) {
                    const chunkRequest = transaction.request();
                    const chunkId = uuidv4();
                    chunkRequest.input('AIChunkId', sql.UniqueIdentifier, chunkId);
                    chunkRequest.input('ProductId', sql.UniqueIdentifier, productId);
                    chunkRequest.input('TenantId', sql.UniqueIdentifier, productOwnerId || req.user.TenantId);
                    chunkRequest.input('SystemArea', sql.NVarChar, 'Product');
                    chunkRequest.input('ChunkText', sql.NVarChar, chunk.chunk_text);
                    chunkRequest.input('ChunkType', sql.NVarChar, 'prose');
                    chunkRequest.input('Source', sql.NVarChar, 'manual');
                    chunkRequest.input('IsActive', sql.Bit, true);
                    chunkRequest.input('Status', sql.NVarChar, 'Active');
                    chunkRequest.input('CreatedDate', sql.DateTime2, new Date());
                    chunkRequest.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);

                    await chunkRequest.query(`
                        INSERT INTO oe.AIChunks (
                            AIChunkId, ProductId, TenantId, SystemArea, ChunkText, ChunkType, Source,
                            IsActive, Status, CreatedDate, CreatedBy
                        ) VALUES (
                            @AIChunkId, @ProductId, @TenantId, @SystemArea, @ChunkText, @ChunkType, @Source,
                            @IsActive, @Status, @CreatedDate, @CreatedBy
                        )
                    `);
                }
            }

            // Update bundle products if applicable
            if (isBundle) {
                // Delete existing bundle relationships
                const deleteBundleRequest = transaction.request();
                deleteBundleRequest.input('BundleProductId', sql.UniqueIdentifier, productId);
                await deleteBundleRequest.query('DELETE FROM oe.ProductBundles WHERE BundleProductId = @BundleProductId');

                // Insert new bundle relationships
                if (parsedBundleProducts && parsedBundleProducts.length > 0) {
                    console.log('🔍 Bundle products received (PUT):', parsedBundleProducts);
                    let sortOrder = 1;
                    for (const bundleProduct of parsedBundleProducts) {
                        const bundleProductId = bundleProduct.productId;
                        console.log('🔍 Processing bundle product ID (PUT):', bundleProductId, 'Type:', typeof bundleProductId);
                        
                        // Validate GUID format
                        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                        if (!guidRegex.test(bundleProductId)) {
                            throw new Error(`Invalid GUID format for bundle product ID: ${bundleProductId}`);
                        }
                        
                        const allowedConfigOptionsJson = (bundleProduct.allowedConfigOptions && typeof bundleProduct.allowedConfigOptions === 'object')
                            ? JSON.stringify(bundleProduct.allowedConfigOptions)
                            : null;

                        const bundleRequest = transaction.request();
                        bundleRequest.input('ProductBundleId', sql.UniqueIdentifier, uuidv4());
                        bundleRequest.input('BundleProductId', sql.UniqueIdentifier, productId);
                        bundleRequest.input('IncludedProductId', sql.UniqueIdentifier, bundleProductId);
                        bundleRequest.input('SortOrder', sql.Int, bundleProduct.sortOrder || sortOrder++);
                        bundleRequest.input('IsRequired', sql.Bit, bundleProduct.isRequired || true);
                        bundleRequest.input('HidePricing', sql.Bit, bundleProduct.hidePricing || false);
                        bundleRequest.input('LinkedToProductId', sql.UniqueIdentifier, bundleProduct.linkedToProductId || null);
                        bundleRequest.input('AllowedConfigOptions', sql.NVarChar, allowedConfigOptionsJson);
                        bundleRequest.input('CreatedDate', sql.DateTime2, new Date());

                        await bundleRequest.query(`
                            INSERT INTO oe.ProductBundles (
                                ProductBundleId, BundleProductId, IncludedProductId,
                                SortOrder, IsRequired, HidePricing, LinkedToProductId, AllowedConfigOptions, CreatedDate
                            ) VALUES (
                                @ProductBundleId, @BundleProductId, @IncludedProductId,
                                @SortOrder, @IsRequired, @HidePricing, @LinkedToProductId, @AllowedConfigOptions, @CreatedDate
                            )
                        `);
                    }
                }
            }

            // Bundle state inheritance on update: recompute AllowedStates from included products
            if (isBundle) {
                const bundleStatesReq = transaction.request();
                bundleStatesReq.input('BundleProductId', sql.UniqueIdentifier, productId);
                const bundleStatesResult = await bundleStatesReq.query(`
                    SELECT p.AllowedStates
                    FROM oe.ProductBundles pb
                    JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                    WHERE pb.BundleProductId = @BundleProductId
                `);
                const includedStatesArrays = bundleStatesResult.recordset
                    .map(r => { try { return JSON.parse(r.AllowedStates || '[]'); } catch { return []; } })
                    .filter(arr => Array.isArray(arr) && arr.length > 0);
                if (includedStatesArrays.length > 0) {
                    const intersection = includedStatesArrays.reduce((acc, states) =>
                        acc.filter(s => states.includes(s)), [...includedStatesArrays[0]]);
                    const updateStatesReq = transaction.request();
                    updateStatesReq.input('ProductId', sql.UniqueIdentifier, productId);
                    updateStatesReq.input('AllowedStates', sql.NVarChar, JSON.stringify(intersection));
                    await updateStatesReq.query(`UPDATE oe.Products SET AllowedStates = @AllowedStates WHERE ProductId = @ProductId`);
                    console.log(`✅ Bundle ${productId}: updated AllowedStates from included products (${intersection.length} states)`);
                }
            }

            // Cascade: if this product's AllowedStates changed, recompute any parent bundles that include it
            if (allowedStates !== undefined) {
                const parentBundlesReq = transaction.request();
                parentBundlesReq.input('IncludedProductId', sql.UniqueIdentifier, productId);
                const parentBundles = await parentBundlesReq.query(`
                    SELECT DISTINCT pb.BundleProductId
                    FROM oe.ProductBundles pb
                    WHERE pb.IncludedProductId = @IncludedProductId
                `);

                for (const bundle of parentBundles.recordset) {
                    const bundleStatesReq = transaction.request();
                    bundleStatesReq.input('BundleProductId', sql.UniqueIdentifier, bundle.BundleProductId);
                    const bundleStatesResult = await bundleStatesReq.query(`
                        SELECT p.AllowedStates
                        FROM oe.ProductBundles pb
                        JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                        WHERE pb.BundleProductId = @BundleProductId
                    `);
                    const includedStatesArrays = bundleStatesResult.recordset
                        .map(r => { try { return JSON.parse(r.AllowedStates || '[]'); } catch { return []; } })
                        .filter(arr => Array.isArray(arr) && arr.length > 0);
                    if (includedStatesArrays.length > 0) {
                        const intersection = includedStatesArrays.reduce((acc, states) =>
                            acc.filter(s => states.includes(s)), [...includedStatesArrays[0]]);
                        const updateBundleReq = transaction.request();
                        updateBundleReq.input('BundleProductId', sql.UniqueIdentifier, bundle.BundleProductId);
                        updateBundleReq.input('AllowedStates', sql.NVarChar, JSON.stringify(intersection));
                        await updateBundleReq.query(`UPDATE oe.Products SET AllowedStates = @AllowedStates WHERE ProductId = @BundleProductId`);
                        console.log(`✅ Cascaded AllowedStates to parent bundle ${bundle.BundleProductId} (${intersection.length} states)`);
                    }
                }
            }

            await transaction.commit();

            // Fire-and-forget AI extraction enqueue for any newly uploaded docs.
            // Never await — Service Bus must not block the HTTP response.
            if (req._docsToEnqueueAfterCommit && req._docsToEnqueueAfterCommit.length > 0) {
                const docs = req._docsToEnqueueAfterCommit;
                req._docsToEnqueueAfterCommit = [];
                setImmediate(() => {
                    docs.forEach((d) => {
                        queueDocumentExtraction(pool, sql, d).catch((err) => {
                            console.warn('[products] background extraction enqueue failed:', err && err.message);
                        });
                    });
                });
            }

            // Verify the update worked
            console.log('✅ Transaction committed. Verifying VendorCommission was saved...');
            const verifyRequest = pool.request();
            verifyRequest.input('ProductId', sql.UniqueIdentifier, productId);
            const verifyResult = await verifyRequest.query(`
                SELECT VendorCommission, IsVendorPrice 
                FROM oe.Products 
                WHERE ProductId = @ProductId
            `);
            console.log('🔍 Database verification - VendorCommission:', verifyResult.recordset[0]);

            res.json({
                success: true,
                message: 'Product updated successfully',
                productId: productId
            });

        } catch (transactionError) {
            await transaction.rollback();
            console.error('Transaction error:', transactionError);
            throw transactionError;
        }

    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update product',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * DELETE /api/products/:id
 * Soft delete product (set status to Inactive)
 */
router.delete('/:id', authenticate, requireTenantAccess(['Admin', 'SysAdmin']), async (req, res) => {
    try {
        const productId = req.params.id;
        const pool = await getPool();
        
        // Get current product to handle file cleanup
        const currentProductRequest = pool.request();
        currentProductRequest.input('ProductId', sql.UniqueIdentifier, productId);
        
        const currentProductResult = await currentProductRequest.query(`
            SELECT ProductImageUrl, ProductLogoUrl, ProductDocumentUrl
            FROM oe.Products
            WHERE ProductId = @ProductId
        `);
        
        const currentProduct = currentProductResult.recordset[0];
        if (!currentProduct) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        const request = pool.request();
        request.input('ProductId', sql.UniqueIdentifier, productId);
        request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
        request.input('ModifiedDate', sql.DateTime2, new Date());
        
        const result = await request.query(`
            UPDATE oe.Products 
            SET 
                Status = 'Inactive',
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE ProductId = @ProductId
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        // Optional: Clean up associated files when product is deleted
        // (You might want to keep files for audit purposes)
        /*
        if (currentProduct.ProductImageUrl) {
            await deleteFileFromBlob(currentProduct.ProductImageUrl);
        }
        if (currentProduct.ProductLogoUrl) {
            await deleteFileFromBlob(currentProduct.ProductLogoUrl);
        }
        if (currentProduct.ProductDocumentUrl) {
            await deleteFileFromBlob(currentProduct.ProductDocumentUrl);
        }
        */
        
        res.json({
            success: true,
            message: 'Product deleted successfully'
        });
        
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete product'
        });
    }
});

/**
 * POST /api/products/:id/upload-image
 * Upload product image via existing upload service
 */
router.post('/:id/upload-image', authenticate, requireTenantAccess(['Admin', 'SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const productId = req.params.id;
        const { imageUrl } = req.body;
        
        if (!imageUrl) {
            return res.status(400).json({
                success: false,
                message: 'Image URL is required'
            });
        }

        const pool = await getPool();
        
        // Get current product to handle old image cleanup
        const currentProductRequest = pool.request();
        currentProductRequest.input('ProductId', sql.UniqueIdentifier, productId);
        
        const currentProductResult = await currentProductRequest.query(`
            SELECT ProductImageUrl FROM oe.Products WHERE ProductId = @ProductId
        `);
        
        const currentProduct = currentProductResult.recordset[0];
        if (!currentProduct) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        // Update product image URL
        const updateRequest = pool.request();
        updateRequest.input('ProductId', sql.UniqueIdentifier, productId);
        updateRequest.input('ProductImageUrl', sql.NVarChar, imageUrl);
        updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
        updateRequest.input('ModifiedDate', sql.DateTime2, new Date());
        
        const result = await updateRequest.query(`
            UPDATE oe.Products 
            SET 
                ProductImageUrl = @ProductImageUrl,
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE ProductId = @ProductId
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        // Clean up old image if it exists and is different
        if (currentProduct.ProductImageUrl && currentProduct.ProductImageUrl !== imageUrl) {
            await deleteFileFromBlob(currentProduct.ProductImageUrl);
        }
        
        res.json({
            success: true,
            message: 'Product image updated successfully',
            imageUrl: imageUrl
        });
        
    } catch (error) {
        console.error('Error updating product image:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update product image'
        });
    }
});

/**
 * POST /api/products/:id/upload-logo
 * Upload product logo via existing upload service
 */
router.post('/:id/upload-logo', authenticate, requireTenantAccess(['Admin', 'SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const productId = req.params.id;
        const { logoUrl } = req.body;
        
        if (!logoUrl) {
            return res.status(400).json({
                success: false,
                message: 'Logo URL is required'
            });
        }

        const pool = await getPool();
        
        // Get current product to handle old logo cleanup
        const currentProductRequest = pool.request();
        currentProductRequest.input('ProductId', sql.UniqueIdentifier, productId);
        
        const currentProductResult = await currentProductRequest.query(`
            SELECT ProductLogoUrl FROM oe.Products WHERE ProductId = @ProductId
        `);
        
        const currentProduct = currentProductResult.recordset[0];
        if (!currentProduct) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        // Update product logo URL
        const updateRequest = pool.request();
        updateRequest.input('ProductId', sql.UniqueIdentifier, productId);
        updateRequest.input('ProductLogoUrl', sql.NVarChar, logoUrl);
        updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
        updateRequest.input('ModifiedDate', sql.DateTime2, new Date());
        
        const result = await updateRequest.query(`
            UPDATE oe.Products 
            SET 
                ProductLogoUrl = @ProductLogoUrl,
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE ProductId = @ProductId
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        // Clean up old logo if it exists and is different
        if (currentProduct.ProductLogoUrl && currentProduct.ProductLogoUrl !== logoUrl) {
            await deleteFileFromBlob(currentProduct.ProductLogoUrl);
        }
        
        res.json({
            success: true,
            message: 'Product logo updated successfully',
            logoUrl: logoUrl
        });
        
    } catch (error) {
        console.error('Error updating product logo:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update product logo'
        });
    }
});

/**
 * POST /api/products/:id/upload-document
 * Upload product document via existing upload service
 */
router.post('/:id/upload-document', authenticate, requireTenantAccess(['Admin', 'SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const productId = req.params.id;
        const { documentUrl } = req.body;
        
        if (!documentUrl) {
            return res.status(400).json({
                success: false,
                message: 'Document URL is required'
            });
        }

        const pool = await getPool();
        
        // Get current product to handle old document cleanup
        const currentProductRequest = pool.request();
        currentProductRequest.input('ProductId', sql.UniqueIdentifier, productId);
        
        const currentProductResult = await currentProductRequest.query(`
            SELECT ProductDocumentUrl FROM oe.Products WHERE ProductId = @ProductId
        `);
        
        const currentProduct = currentProductResult.recordset[0];
        if (!currentProduct) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        // Update product document URL
        const updateRequest = pool.request();
        updateRequest.input('ProductId', sql.UniqueIdentifier, productId);
        updateRequest.input('ProductDocumentUrl', sql.NVarChar, documentUrl);
        updateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
        updateRequest.input('ModifiedDate', sql.DateTime2, new Date());
        
        const result = await updateRequest.query(`
            UPDATE oe.Products 
            SET 
                ProductDocumentUrl = @ProductDocumentUrl,
                ModifiedBy = @ModifiedBy,
                ModifiedDate = @ModifiedDate
            WHERE ProductId = @ProductId
        `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }
        
        // Clean up old document if it exists and is different
        if (currentProduct.ProductDocumentUrl && currentProduct.ProductDocumentUrl !== documentUrl) {
            await deleteFileFromBlob(currentProduct.ProductDocumentUrl);
        }
        
        res.json({
            success: true,
            message: 'Product document updated successfully',
            documentUrl: documentUrl
        });
        
    } catch (error) {
        console.error('Error updating product document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update product document'
        });
    }
});

/**
 * GET /api/products/:id/document
 * Get authenticated download URL for product document
 */
router.get('/:id/document', authenticate, async (req, res) => {
    try {
        const productId = req.params.id;
        const pool = await getPool();
        
        // Get product document URL
        const request = pool.request();
        request.input('ProductId', sql.UniqueIdentifier, productId);
        
        const result = await request.query(`
            SELECT ProductDocumentUrl 
            FROM oe.Products 
            WHERE ProductId = @ProductId AND ProductDocumentUrl IS NOT NULL
        `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Product document not found'
            });
        }
        
        const documentUrl = result.recordset[0].ProductDocumentUrl;
        
        // Parse the blob URL to extract container and blob name
        const urlParts = documentUrl.split('/');
        const containerName = urlParts[urlParts.length - 2];
        const blobName = urlParts[urlParts.length - 1].split('?')[0]; // Remove any existing query params
        
        // Generate fresh SAS URL
        const authenticatedUrl = generateSASUrl(containerName, blobName, 'r', 60);
        
        res.json({
            success: true,
            data: {
                downloadUrl: authenticatedUrl,
                fileName: blobName,
                mimeType: 'application/pdf' // Assuming PDF for product documents
            }
        });
        
    } catch (error) {
        console.error('Error generating product document URL:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate document URL'
        });
    }
});

module.exports = router;