// backend/routes/me/agent/licenses.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { v4: uuidv4 } = require('uuid');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');

const VALIDATION_LOG_CATEGORY = 'LicenseValidation';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** SQL fragment: oe.AgentLicenses row counts as valid for product validation (ignores Status). */
const AGENT_LICENSE_DATE_VALID_WHERE = `
  (EffectiveDate IS NULL OR CAST(EffectiveDate AS DATE) <= CAST(GETUTCDATE() AS DATE))
  AND (
    ExpirationDate IS NULL OR CAST(ExpirationDate AS DATE) >= CAST(GETUTCDATE() AS DATE)
  )
`;

function normalizeLicenseType(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isUuid(value) {
    return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

function previewValue(value, maxLength = 240) {
    if (value === null || value === undefined) return null;
    let text;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch (_) {
            text = String(value);
        }
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function limitArray(values, max = 100) {
    if (!Array.isArray(values)) return [];
    return values.slice(0, max);
}

function resolveValidationTrace(req) {
    const headerTraceRaw = req.headers?.['x-trace-id'] || req.headers?.['x-correlation-id'];
    const headerTrace = Array.isArray(headerTraceRaw) ? headerTraceRaw[0] : headerTraceRaw;
    const bodyTrace = req.body?.traceId;

    if (isUuid(headerTrace)) {
        return {
            traceId: String(headerTrace).trim(),
            correlationId: String(headerTrace).trim(),
            source: 'header'
        };
    }

    if (isUuid(bodyTrace)) {
        return {
            traceId: String(bodyTrace).trim(),
            correlationId: String(bodyTrace).trim(),
            source: 'body'
        };
    }

    const generated = uuidv4();
    return {
        traceId: generated,
        correlationId: generated,
        source: 'generated'
    };
}

function logValidation(level, message, details, correlationId) {
    const prefix = `[AGENT-LICENSE-VALIDATION] ${message}`;
    if (level === 'error') {
        console.error(prefix, details || {});
        logger.error(message, details || null, VALIDATION_LOG_CATEGORY, correlationId);
        return;
    }
    if (level === 'warn') {
        console.warn(prefix, details || {});
        logger.warn(message, details || null, VALIDATION_LOG_CATEGORY, correlationId);
        return;
    }
    if (level === 'debug') {
        console.log(prefix, details || {});
        logger.debug(message, details || null, VALIDATION_LOG_CATEGORY, correlationId);
        return;
    }
    console.log(prefix, details || {});
    logger.info(message, details || null, VALIDATION_LOG_CATEGORY, correlationId);
}

function parseRequiredLicensesDetailed(raw) {
    if (!raw) {
        return {
            requiredLicenses: [],
            parseStatus: 'empty',
            parseError: null,
            rawType: typeof raw,
            rawPreview: previewValue(raw),
            parsedLength: 0
        };
    }

    let parsed = raw;
    let parseStatus = 'array';
    let parseError = null;

    if (typeof raw === 'string') {
        parseStatus = 'string-json';
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            parseStatus = 'parse-error';
            parseError = error?.message || 'Invalid JSON';
            parsed = null;
        }
    }

    if (!Array.isArray(parsed)) {
        return {
            requiredLicenses: [],
            parseStatus: parseStatus === 'parse-error' ? 'parse-error' : 'non-array',
            parseError,
            rawType: typeof raw,
            rawPreview: previewValue(raw),
            parsedLength: 0
        };
    }

    const out = [];
    const seen = new Set();
    for (const item of parsed) {
        const text = String(item || '').trim();
        if (!text || text.toLowerCase() === 'none') continue;
        const key = normalizeLicenseType(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }

    return {
        requiredLicenses: out,
        parseStatus: 'parsed-array',
        parseError: null,
        rawType: typeof raw,
        rawPreview: previewValue(raw),
        parsedLength: parsed.length
    };
}

function parseLinkMetaData(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }
    if (typeof raw === 'object') return raw;
    return null;
}

function isSalesTypeCompatible(productSalesType, templateType) {
    if (!templateType) return true;
    const salesType = String(productSalesType || '').trim();
    if (!salesType) return true;
    if (salesType === 'Both') return true;
    return salesType === templateType;
}

/**
 * @route   GET /api/me/agent/licenses
 * @desc    Get the current agent's own license information
 * @access  Private (Agent only)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ME-LICENSES] >> Getting agent licenses');
    
    try {
        if (!req.user) {
            logger.error('[AGENT-ME-LICENSES] !! User is missing from request');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const userId = req.user.UserId;
        const pool = await getPool();

        // First get the agent's AgentId
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT AgentId 
                FROM oe.Agents 
                WHERE UserId = @userId
            `);

        if (agentResult.recordset.length === 0) {
            logger.error(`[AGENT-ME-LICENSES] Agent not found for UserId: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                message: 'Agent not found' 
            });
        }

        const agentId = agentResult.recordset[0].AgentId;

        // Get license information
        const licenseResult = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`
                SELECT 
                    LicenseId,
                    StateCode,
                    LicenseNumber,
                    LicenseType,
                    IssueDate,
                    EffectiveDate,
                    ExpirationDate,
                    Status,
                    CreatedDate,
                    ModifiedDate
                FROM oe.AgentLicenses 
                WHERE AgentId = @agentId 
                AND ${AGENT_LICENSE_DATE_VALID_WHERE}
                ORDER BY CreatedDate DESC
            `);

        logger.info(`[AGENT-ME-LICENSES] << Found ${licenseResult.recordset.length} license records`);
        
        res.json({
            success: true,
            data: licenseResult.recordset
        });

    } catch (error) {
        logger.error('[AGENT-ME-LICENSES] !! Error getting licenses:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get license information',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/me/agent/licenses
 * @desc    Upload and save new license documents with metadata for the current agent
 * @access  Private (Agent only)
 */
router.post('/', authorize(['Agent']), async (req, res) => {
    console.log('📝 POST /api/me/agent/licenses - Request received');
    logger.info('[AGENT-ME-LICENSES-POST] >> Uploading agent licenses');
    
    try {
        if (!req.user) {
            console.log('❌ User missing from request');
            logger.error('[AGENT-ME-LICENSES-POST] !! User is missing from request');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const userId = req.user.UserId;
        const { documentsWithLicenseMetadata, documentUrls } = req.body;
        
        console.log('📝 Request body:', {
            hasMetadata: !!documentsWithLicenseMetadata,
            isArray: Array.isArray(documentsWithLicenseMetadata),
            count: documentsWithLicenseMetadata?.length,
            userId
        });
        
        if (!documentsWithLicenseMetadata || !Array.isArray(documentsWithLicenseMetadata)) {
            console.log('❌ Invalid request: documentsWithLicenseMetadata is missing or not an array');
            logger.error('[AGENT-ME-LICENSES-POST] !! Invalid request: documentsWithLicenseMetadata is required');
            return res.status(400).json({ 
                success: false, 
                message: 'documentsWithLicenseMetadata array is required' 
            });
        }

        const pool = await getPool();

        // First get the agent's AgentId
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT AgentId 
                FROM oe.Agents 
                WHERE UserId = @userId
            `);

        if (agentResult.recordset.length === 0) {
            logger.error(`[AGENT-ME-LICENSES-POST] Agent not found for UserId: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                message: 'Agent not found' 
            });
        }

        const agentId = agentResult.recordset[0].AgentId;
        
        console.log(`✅ Agent found: ${agentId}`);
        console.log(`📝 Processing ${documentsWithLicenseMetadata.length} license documents`);
        logger.info(`[AGENT-ME-LICENSES-POST] Processing ${documentsWithLicenseMetadata.length} license documents for agent ${agentId}`);
        
        const createdLicenses = [];
        const createdDocuments = [];
        
        // Process each document with license metadata
        for (let i = 0; i < documentsWithLicenseMetadata.length; i++) {
            const docMeta = documentsWithLicenseMetadata[i];
            
            // Validate required fields
            if (!docMeta.state || !docMeta.licenseType) {
                logger.warn('[AGENT-ME-LICENSES-POST] Skipping document without state or license type:', docMeta.fileName);
                continue;
            }
            
            const licenseId = uuidv4();
            const documentId = uuidv4();
            
            logger.info(`[AGENT-ME-LICENSES-POST] Creating license ${i + 1}:`, {
                licenseId,
                state: docMeta.state,
                licenseType: docMeta.licenseType,
                licenseNumber: docMeta.licenseNumber || null,
                status: docMeta.status || 'Active',
                residencyType: docMeta.residencyType || 'Resident'
            });
            
            // Insert into AgentLicenses table
            await pool.request()
                .input('licenseId', sql.UniqueIdentifier, licenseId)
                .input('agentId', sql.UniqueIdentifier, agentId)
                .input('stateCode', sql.NVarChar, docMeta.state)
                .input('licenseNumber', sql.NVarChar, docMeta.licenseNumber || null)
                .input('licenseType', sql.NVarChar, docMeta.licenseType)
                .input('effectiveDate', sql.Date, docMeta.issueDate || null)
                .input('expirationDate', sql.Date, docMeta.expirationDate || null)
                .input('issueDate', sql.Date, docMeta.issueDate || null)
                .input('status', sql.NVarChar, docMeta.status || 'Active')
                .input('residencyType', sql.NVarChar, docMeta.residencyType || 'Resident')
                .input('loaIssueDate', sql.Date, docMeta.loaIssueDate || null)
                .input('companyAppointmentDate', sql.Date, docMeta.companyAppointmentDate || null)
                .input('renewalDate', sql.Date, docMeta.renewalDate || null)
                .input('uploadedDocumentUrl', sql.NVarChar, docMeta.url)
                .input('createdDate', sql.DateTime2, new Date())
                .input('modifiedDate', sql.DateTime2, new Date())
                .input('createdBy', sql.UniqueIdentifier, userId)
                .input('modifiedBy', sql.UniqueIdentifier, userId)
                .query(`
                    INSERT INTO oe.AgentLicenses (
                        LicenseId, AgentId, StateCode, LicenseNumber, LicenseType,
                        EffectiveDate, ExpirationDate, IssueDate, Status, ResidencyType,
                        LOAIssueDate, CompanyAppointmentDate, RenewalDate,
                        UploadedDocumentUrl, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                    ) VALUES (
                        @licenseId, @agentId, @stateCode, @licenseNumber, @licenseType,
                        @effectiveDate, @expirationDate, @issueDate, @status, @residencyType,
                        @loaIssueDate, @companyAppointmentDate, @renewalDate,
                        @uploadedDocumentUrl, @createdDate, @modifiedDate, @createdBy, @modifiedBy
                    )
                `);
            
            createdLicenses.push(licenseId);
            
            // Determine file type from URL or fileName
            let fileType = 'application/pdf'; // Default
            const fileIdentifier = docMeta.fileName || docMeta.url || '';
            if (fileIdentifier.toLowerCase().includes('.jpg') || fileIdentifier.toLowerCase().includes('.jpeg')) {
                fileType = 'image/jpeg';
            } else if (fileIdentifier.toLowerCase().includes('.png')) {
                fileType = 'image/png';
            }
            
            // Extract filename from URL if fileName is not provided
            const fileName = docMeta.fileName || `license_${docMeta.state}_${Date.now()}.pdf`;
            
            console.log(`📄 Document ${i + 1}:`, {
                fileName,
                fileType,
                url: docMeta.url?.substring(0, 50) + '...',
                size: docMeta.fileSize
            });
            
            // Also insert into AgentDocuments table for document tracking
            await pool.request()
                .input('documentId', sql.UniqueIdentifier, documentId)
                .input('agentId', sql.UniqueIdentifier, agentId)
                .input('documentType', sql.NVarChar, 'License')
                .input('fileName', sql.NVarChar, fileName)
                .input('fileUrl', sql.NVarChar, docMeta.url)
                .input('fileSize', sql.Int, docMeta.fileSize || 0)
                .input('fileType', sql.NVarChar, fileType)
                .input('description', sql.NVarChar, `${docMeta.licenseType} license for ${docMeta.state}`)
                .input('status', sql.NVarChar, 'Active')
                .input('createdDate', sql.DateTime2, new Date())
                .input('modifiedDate', sql.DateTime2, new Date())
                .input('createdBy', sql.UniqueIdentifier, userId)
                .input('modifiedBy', sql.UniqueIdentifier, userId)
                .query(`
                    INSERT INTO oe.AgentDocuments (
                        DocumentId, AgentId, DocumentType, FileName, FileUrl,
                        FileSize, FileType, Description, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                    ) VALUES (
                        @documentId, @agentId, @documentType, @fileName, @fileUrl,
                        @fileSize, @fileType, @description, @status, @createdDate, @modifiedDate, @createdBy, @modifiedBy
                    )
                `);
            
            createdDocuments.push(documentId);
            
            logger.info(`[AGENT-ME-LICENSES-POST] License and document created successfully for ${docMeta.state} - ${docMeta.licenseType}`);
        }
        
        console.log(`✅ Successfully created ${createdLicenses.length} licenses`);
        logger.info(`[AGENT-ME-LICENSES-POST] << Successfully created ${createdLicenses.length} licenses`);
        
        const response = {
            success: true,
            message: `Successfully uploaded ${createdLicenses.length} license(s)`,
            data: {
                licensesCreated: createdLicenses.length,
                licenseIds: createdLicenses,
                documentIds: createdDocuments
            }
        };
        
        console.log('📤 Sending success response:', response);
        res.json(response);

    } catch (error) {
        console.error('❌ Error uploading licenses:', error);
        console.error('❌ Error stack:', error.stack);
        console.error('❌ SQL error details:', error.originalError?.info?.message);
        logger.error('[AGENT-ME-LICENSES-POST] !! Error uploading licenses:', error);
        
        const errorResponse = {
            success: false,
            message: 'Failed to upload license information',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
            sqlError: error.originalError?.info?.message
        };
        
        console.log('📤 Sending error response:', errorResponse);
        res.status(500).json(errorResponse);
    }
});

/**
 * @route   POST /api/me/agent/licenses/validate-products
 * @desc    Validate agent license coverage for all products in a template payload
 * @access  Private (Agent only)
 */
router.post('/validate-products', authorize(['Agent']), async (req, res) => {
    const trace = resolveValidationTrace(req);
    const traceId = trace.traceId;
    const correlationId = trace.correlationId;
    const requestStartMs = Date.now();

    try {
        if (!req.user?.UserId) {
            logValidation('error', '[AGENT-ME-LICENSES-VALIDATE] missing user context', { traceId }, correlationId);
            return res.status(401).json({
                success: false,
                traceId,
                message: 'Authentication error: User information is missing.'
            });
        }

        const { linkMetaData, templateType } = req.body || {};
        const parsedMeta = parseLinkMetaData(linkMetaData);
        const sections = Array.isArray(parsedMeta?.products) ? parsedMeta.products : null;
        const userId = req.user.UserId;

        logValidation('info', '[AGENT-ME-LICENSES-VALIDATE] request received', {
            traceId,
            traceSource: trace.source,
            userId,
            templateType: templateType || null,
            sectionCount: Array.isArray(sections) ? sections.length : 0
        }, correlationId);

        if (!sections) {
            logValidation('warn', '[AGENT-ME-LICENSES-VALIDATE] missing linkMetaData.products', {
                traceId,
                payloadKeys: Object.keys(req.body || {})
            }, correlationId);
            return res.status(400).json({
                success: false,
                traceId,
                message: 'linkMetaData.products array is required for validation.'
            });
        }

        const sectionsSummary = sections.map((section, index) => ({
            index,
            sectionType: String(section?.sectionType || 'products'),
            productType: String(section?.productType || ''),
            includeAllProducts: section?.includeAllProducts === true,
            includeAllBundles: section?.includeAllBundles === true,
            specificProductsCount: Array.isArray(section?.specificProducts) ? section.specificProducts.length : 0,
            specificBundlesCount: Array.isArray(section?.specificBundles) ? section.specificBundles.length : 0
        }));

        const pool = await getPool();

        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT AgentId, TenantId
                FROM oe.Agents
                WHERE UserId = @userId
                  AND Status = 'Active'
            `);

        if (agentResult.recordset.length === 0) {
            logValidation('warn', '[AGENT-ME-LICENSES-VALIDATE] agent not found', {
                traceId,
                userId
            }, correlationId);
            return res.status(404).json({
                success: false,
                traceId,
                message: 'Agent not found'
            });
        }

        const { AgentId: agentId, TenantId: tenantId } = agentResult.recordset[0];

        const availableProductsResult = await pool.request()
            .input('TenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT DISTINCT
                    p.ProductId,
                    p.Name,
                    p.ProductType,
                    p.RequiredLicenses,
                    p.SalesType,
                    p.IsBundle
                FROM oe.Products p
                LEFT JOIN oe.TenantProductSubscriptions tps
                    ON p.ProductId = tps.ProductId
                   AND tps.TenantId = @TenantId
                   AND tps.SubscriptionStatus != 'Cancelled'
                WHERE p.Status = 'Active'
                  AND (p.IsHidden IS NULL OR p.IsHidden = 0)
                  AND (p.ProductOwnerId = @TenantId OR tps.TenantId = @TenantId)
            `);

        const availableProducts = availableProductsResult.recordset || [];
        const availableById = new Map(availableProducts.map((p) => [String(p.ProductId), p]));
        const selectedProductIds = new Set();
        const selectionDiagnostics = [];

        const pushSelectionDiagnostic = (entry) => {
            if (selectionDiagnostics.length < 200) {
                selectionDiagnostics.push(entry);
            }
        };

        for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
            const section = sections[sectionIndex];
            if (!section || typeof section !== 'object') continue;

            const sectionType = String(section.sectionType || 'products');
            const productType = String(section.productType || '');

            if (sectionType === 'bundles') {
                if (section.includeAllBundles === true) {
                    for (const product of availableProducts) {
                        const isBundle = product.IsBundle === true || product.IsBundle === 1;
                        if (!isBundle) continue;
                        if (!isSalesTypeCompatible(product.SalesType, templateType)) continue;
                        if (productType && String(product.ProductType || '') !== productType) continue;
                        const selectedId = String(product.ProductId);
                        selectedProductIds.add(selectedId);
                        pushSelectionDiagnostic({
                            sectionIndex,
                            source: 'includeAllBundles',
                            productType,
                            productId: selectedId
                        });
                    }
                } else if (Array.isArray(section.specificBundles)) {
                    section.specificBundles.forEach((id) => {
                        if (!id) return;
                        const selectedId = String(id);
                        selectedProductIds.add(selectedId);
                        pushSelectionDiagnostic({
                            sectionIndex,
                            source: 'specificBundles',
                            productType,
                            productId: selectedId
                        });
                    });
                }
            } else if (section.includeAllProducts === true) {
                for (const product of availableProducts) {
                    if (productType && String(product.ProductType || '') !== productType) continue;
                    if (!isSalesTypeCompatible(product.SalesType, templateType)) continue;
                    const selectedId = String(product.ProductId);
                    selectedProductIds.add(selectedId);
                    pushSelectionDiagnostic({
                        sectionIndex,
                        source: 'includeAllProducts',
                        productType,
                        productId: selectedId
                    });
                }
            } else if (Array.isArray(section.specificProducts)) {
                section.specificProducts.forEach((id) => {
                    if (!id) return;
                    const selectedId = String(id);
                    selectedProductIds.add(selectedId);
                    pushSelectionDiagnostic({
                        sectionIndex,
                        source: 'specificProducts',
                        productType,
                        productId: selectedId
                    });
                });
            }
        }

        const selectedBundleIds = Array.from(selectedProductIds).filter((id) => {
            const product = availableById.get(String(id));
            return !!product && (product.IsBundle === true || product.IsBundle === 1);
        });

        const bundleIncludedProductsByBundleId = new Map();
        if (selectedBundleIds.length > 0) {
            const bundleRequest = pool.request();
            const bundleParamTokens = [];
            selectedBundleIds.forEach((bundleId, index) => {
                const paramName = `bundleId${index}`;
                bundleRequest.input(paramName, sql.UniqueIdentifier, bundleId);
                bundleParamTokens.push(`@${paramName}`);
            });

            const bundleResult = await bundleRequest.query(`
                SELECT
                    pb.BundleProductId,
                    pb.IncludedProductId,
                    p.Name AS IncludedProductName,
                    p.ProductType AS IncludedProductType,
                    p.RequiredLicenses AS IncludedRequiredLicenses
                FROM oe.ProductBundles pb
                INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                WHERE pb.BundleProductId IN (${bundleParamTokens.join(', ')})
                  AND p.Status = 'Active'
            `);

            for (const row of bundleResult.recordset || []) {
                const bundleId = String(row.BundleProductId);
                const existing = bundleIncludedProductsByBundleId.get(bundleId) || [];
                existing.push({
                    productId: String(row.IncludedProductId),
                    productName: row.IncludedProductName,
                    productType: row.IncludedProductType || '',
                    requiredLicensesRaw: row.IncludedRequiredLicenses
                });
                bundleIncludedProductsByBundleId.set(bundleId, existing);
            }
        }

        const allActiveLicensesResult = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`
                SELECT LicenseType, StateCode, EffectiveDate, ExpirationDate
                FROM oe.AgentLicenses
                WHERE AgentId = @agentId
            `);

        const activeLicensesResult = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`
                SELECT LicenseType, StateCode, ExpirationDate
                FROM oe.AgentLicenses
                WHERE AgentId = @agentId
                  AND ${AGENT_LICENSE_DATE_VALID_WHERE}
            `);

        const allActiveLicenses = allActiveLicensesResult.recordset || [];
        const activeLicenses = activeLicensesResult.recordset || [];
        const selfHeldLicenseKeys = new Set(
            activeLicenses
                .map((l) => normalizeLicenseType(l.LicenseType))
                .filter(Boolean)
        );

        const directUplineResult = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`
                SELECT TOP 1 ParentId AS DirectUplineAgentId
                FROM oe.AgentHierarchy
                WHERE AgentId = @agentId
                  AND Status = 'Active'
                  AND ParentId IS NOT NULL
            `);

        const directUplineAgentId = directUplineResult.recordset[0]?.DirectUplineAgentId || null;

        let uplineActiveLicenses = [];
        if (directUplineAgentId) {
            const uplineLicensesResult = await pool.request()
                .input('uplineAgentId', sql.UniqueIdentifier, directUplineAgentId)
                .query(`
                    SELECT LicenseType, StateCode, ExpirationDate
                    FROM oe.AgentLicenses
                    WHERE AgentId = @uplineAgentId
                      AND ${AGENT_LICENSE_DATE_VALID_WHERE}
                `);
            uplineActiveLicenses = uplineLicensesResult.recordset || [];
        }

        const uplineHeldLicenseKeys = new Set(
            uplineActiveLicenses
                .map((l) => normalizeLicenseType(l.LicenseType))
                .filter(Boolean)
        );

        const products = [];
        const productDiagnostics = [];
        const parseAnomalies = [];
        const unknownSelectedProductIds = [];
        const knownSelectedProductIds = new Set();

        for (const productId of selectedProductIds) {
            const product = availableById.get(productId);
            if (!product) {
                unknownSelectedProductIds.push(productId);
                products.push({
                    productId,
                    productName: 'Unknown Product',
                    productType: '',
                    isBundle: false,
                    requiredLicenses: [],
                    matchedLicenses: [],
                    missingLicenses: [],
                    licensesSatisfiedByUpline: [],
                    validationError: 'Product is not available for this agent and could not be validated.',
                    isValid: false
                });
                continue;
            }

            knownSelectedProductIds.add(String(product.ProductId));
            const isBundle = product.IsBundle === true || product.IsBundle === 1;
            const bundleIncludedProducts = isBundle
                ? (bundleIncludedProductsByBundleId.get(String(product.ProductId)) || [])
                : [];

            const requiredSources = [];
            const parseDetailSources = [];

            const ownRequiredDetails = parseRequiredLicensesDetailed(product.RequiredLicenses);
            parseDetailSources.push({
                source: 'selected-product',
                sourceProductId: String(product.ProductId),
                sourceProductName: product.Name,
                sourceProductType: product.ProductType || '',
                details: ownRequiredDetails
            });
            requiredSources.push(...ownRequiredDetails.requiredLicenses);

            for (const included of bundleIncludedProducts) {
                const includedDetails = parseRequiredLicensesDetailed(included.requiredLicensesRaw);
                parseDetailSources.push({
                    source: 'bundle-included-product',
                    sourceProductId: included.productId,
                    sourceProductName: included.productName,
                    sourceProductType: included.productType || '',
                    details: includedDetails
                });
                requiredSources.push(...includedDetails.requiredLicenses);
            }

            const requiredLicenses = [];
            const requiredLicenseKeys = new Set();
            for (const required of requiredSources) {
                const requiredKey = normalizeLicenseType(required);
                if (!requiredKey || requiredLicenseKeys.has(requiredKey)) continue;
                requiredLicenseKeys.add(requiredKey);
                requiredLicenses.push(required);
            }

            const matchedLicenses = [];
            const missingLicenses = [];
            const licensesSatisfiedByUpline = [];

            for (const required of requiredLicenses) {
                const requiredKey = normalizeLicenseType(required);
                if (selfHeldLicenseKeys.has(requiredKey)) {
                    matchedLicenses.push(required);
                } else if (uplineHeldLicenseKeys.has(requiredKey)) {
                    matchedLicenses.push(required);
                    licensesSatisfiedByUpline.push(required);
                } else {
                    missingLicenses.push(required);
                }
            }

            for (const sourceInfo of parseDetailSources) {
                const sourceRaw = sourceInfo.details.rawPreview;
                const hasRawConfig = sourceRaw !== null && String(sourceRaw).trim().length > 0;
                if (!hasRawConfig) continue;
                if (
                    sourceInfo.details.parseStatus !== 'parsed-array' ||
                    sourceInfo.details.requiredLicenses.length === 0
                ) {
                    parseAnomalies.push({
                        selectedProductId: String(product.ProductId),
                        selectedProductName: product.Name,
                        source: sourceInfo.source,
                        sourceProductId: sourceInfo.sourceProductId,
                        sourceProductName: sourceInfo.sourceProductName,
                        sourceProductType: sourceInfo.sourceProductType,
                        parseStatus: sourceInfo.details.parseStatus,
                        parseError: sourceInfo.details.parseError,
                        rawPreview: sourceInfo.details.rawPreview
                    });
                }
            }

            const isValid = missingLicenses.length === 0;
            products.push({
                productId: String(product.ProductId),
                productName: product.Name,
                productType: product.ProductType || '',
                isBundle,
                requiredLicenses,
                matchedLicenses,
                missingLicenses,
                licensesSatisfiedByUpline,
                validationError: null,
                isValid
            });

            if (productDiagnostics.length < 200) {
                productDiagnostics.push({
                    productId: String(product.ProductId),
                    productName: product.Name,
                    productType: product.ProductType || '',
                    isBundle,
                    salesType: product.SalesType || null,
                    requiredParseStatus: ownRequiredDetails.parseStatus,
                    requiredRawPreview: ownRequiredDetails.rawPreview,
                    bundleIncludedProducts: isBundle
                        ? bundleIncludedProducts.map((included) => {
                            const includedDetail = parseRequiredLicensesDetailed(included.requiredLicensesRaw);
                            return {
                                productId: included.productId,
                                productName: included.productName,
                                productType: included.productType,
                                requiredParseStatus: includedDetail.parseStatus,
                                requiredRawPreview: includedDetail.rawPreview,
                                requiredLicenses: includedDetail.requiredLicenses
                            };
                        })
                        : [],
                    requiredLicenses,
                    matchedLicenses,
                    missingLicenses,
                    licensesSatisfiedByUpline,
                    isValid
                });
            }
        }

        const unresolvedCount = products.filter((p) => !p.isValid).length;
        const productsWithRequiredLicenses = products.filter((p) => (p.requiredLicenses || []).length > 0).length;
        const selectedProductCount = selectedProductIds.size;
        const totalDeclaredSelections = sectionsSummary.reduce((acc, section) => {
            return acc + section.specificProductsCount + section.specificBundlesCount;
        }, 0);
        const expiredActiveLicenses = allActiveLicenses.filter((license) => {
            if (!license.ExpirationDate) return false;
            const expirationDate = new Date(license.ExpirationDate);
            if (Number.isNaN(expirationDate.getTime())) return false;
            const now = new Date();
            return expirationDate < now;
        });

        const hypothesisDiagnostics = [
            {
                id: 'H1_REQUIRED_LICENSE_PARSE',
                hypothesis: 'RequiredLicenses metadata is missing or not parseable for selected products.',
                test: 'Any selected product OR included bundle product has raw RequiredLicenses but parse status is not parsed-array or parsed list is empty.',
                result: parseAnomalies.length > 0 ? 'SUPPORTED' : 'NOT_SUPPORTED',
                outcome: parseAnomalies.length > 0
                    ? 'At least one selected product may be treated as requiring zero licenses.'
                    : 'Selected products did not show required license parse anomalies.',
                evidence: limitArray(parseAnomalies, 20)
            },
            {
                id: 'H2_SELECTION_MISMATCH',
                hypothesis: 'Selected IDs sent from UI do not line up with tenant-available products.',
                test: 'Unknown selected product IDs exist, or no selected products were resolved despite section selections.',
                result: (unknownSelectedProductIds.length > 0 || (selectedProductCount === 0 && totalDeclaredSelections > 0)) ? 'SUPPORTED' : 'NOT_SUPPORTED',
                outcome: (unknownSelectedProductIds.length > 0 || (selectedProductCount === 0 && totalDeclaredSelections > 0))
                    ? 'Selection mismatch can cause misleading tab-level validation signals.'
                    : 'Selection IDs map cleanly to available products.',
                evidence: {
                    unknownSelectedProductIds: limitArray(unknownSelectedProductIds, 25),
                    selectedProductCount,
                    totalDeclaredSelections
                }
            },
            {
                id: 'H3_PRODUCTS_TRULY_REQUIRE_NO_LICENSE',
                hypothesis: 'Selected products legitimately have no required licenses configured.',
                test: 'Count selected products where requiredLicenses array is empty.',
                result: (products.length > 0 && productsWithRequiredLicenses === 0) ? 'SUPPORTED' : 'NOT_SUPPORTED',
                outcome: (products.length > 0 && productsWithRequiredLicenses === 0)
                    ? 'Validation passes because configuration says no license is required.'
                    : 'At least one selected product requires a license.',
                evidence: {
                    selectedProducts: products.length,
                    productsWithRequiredLicenses
                }
            },
            {
                id: 'H4_AGENT_HAS_MORE_ACTIVE_LICENSES_THAN_EXPECTED',
                hypothesis: 'Agent has additional date-valid license rows that make products pass.',
                test: 'Distinct normalized date-valid license keys count and all license rows count.',
                result: (allActiveLicenses.length > 1 || selfHeldLicenseKeys.size > 1) ? 'SUPPORTED' : 'NOT_SUPPORTED',
                outcome: (allActiveLicenses.length > 1 || selfHeldLicenseKeys.size > 1)
                    ? 'Database may contain historical/extra license rows beyond the latest upload.'
                    : 'Agent appears to have one date-valid license type in scope.',
                evidence: {
                    allLicenseRowCount: allActiveLicenses.length,
                    dateValidLicenseCount: activeLicenses.length,
                    distinctHeldLicenseKeys: Array.from(selfHeldLicenseKeys),
                    expiredLicenseRowCount: expiredActiveLicenses.length
                }
            },
            {
                id: 'H5_TAB_HAS_NO_VALIDATION_SCOPE',
                hypothesis: 'A tab appears valid because no products from that tab were actually in validation scope.',
                test: 'Section summary versus selected product IDs that successfully resolved in validation scope.',
                result: sectionsSummary.some((section) => {
                    const declaredScope = section.includeAllProducts || section.includeAllBundles || section.specificProductsCount > 0 || section.specificBundlesCount > 0;
                    if (!declaredScope) return false;
                    const resolvedCount = new Set(
                        selectionDiagnostics
                            .filter((entry) => entry.sectionIndex === section.index && knownSelectedProductIds.has(String(entry.productId)))
                            .map((entry) => String(entry.productId))
                    ).size;
                    return resolvedCount === 0;
                }) ? 'SUPPORTED' : 'NOT_SUPPORTED',
                outcome: sectionsSummary.some((section) => {
                    const declaredScope = section.includeAllProducts || section.includeAllBundles || section.specificProductsCount > 0 || section.specificBundlesCount > 0;
                    if (!declaredScope) return false;
                    const resolvedCount = new Set(
                        selectionDiagnostics
                            .filter((entry) => entry.sectionIndex === section.index && knownSelectedProductIds.has(String(entry.productId)))
                            .map((entry) => String(entry.productId))
                    ).size;
                    return resolvedCount === 0;
                })
                    ? 'One or more tabs declare scope but resolved zero products for that type.'
                    : 'Each scoped tab resolved products in validation results.',
                evidence: sectionsSummary.map((section) => ({
                    productType: section.productType,
                    declaredScope: section.includeAllProducts || section.includeAllBundles || section.specificProductsCount > 0 || section.specificBundlesCount > 0,
                    resolvedSelectedProductsInSection: new Set(
                        selectionDiagnostics
                            .filter((entry) => entry.sectionIndex === section.index && knownSelectedProductIds.has(String(entry.productId)))
                            .map((entry) => String(entry.productId))
                    ).size
                }))
            }
        ];

        logValidation('info', '[AGENT-ME-LICENSES-VALIDATE] hypothesis evaluation', {
            traceId,
            hypotheses: hypothesisDiagnostics
        }, correlationId);

        logValidation('info', '[AGENT-ME-LICENSES-VALIDATE] validation complete', {
            traceId,
            elapsedMs: Date.now() - requestStartMs,
            userId,
            agentId,
            tenantId,
            templateType: templateType || null,
            sectionCount: sections.length,
            sectionsSummary,
            selectedProductCount,
            selectedProductIds: Array.from(selectedProductIds),
            selectionDiagnostics: limitArray(selectionDiagnostics, 120),
            activeLicenseCount: activeLicenses.length,
            directUplineAgentId: directUplineAgentId ? String(directUplineAgentId) : null,
            uplineActiveLicenseCount: uplineActiveLicenses.length,
            selfHeldLicenseKeys: Array.from(selfHeldLicenseKeys),
            uplineHeldLicenseKeys: Array.from(uplineHeldLicenseKeys),
            productDiagnostics: limitArray(productDiagnostics, 120),
            unresolvedCount
        }, correlationId);

        return res.json({
            success: true,
            data: {
                traceId,
                validatedAt: new Date().toISOString(),
                totalProducts: products.length,
                unresolvedCount,
                allProductsValid: unresolvedCount === 0,
                products
            }
        });
    } catch (error) {
        logValidation('error', '[AGENT-ME-LICENSES-VALIDATE] unexpected failure', {
            traceId,
            message: error?.message,
            stack: process.env.NODE_ENV === 'development' ? previewValue(error?.stack, 4000) : undefined
        }, correlationId);
        return res.status(500).json({
            success: false,
            traceId,
            message: 'Failed to validate licenses for selected products',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   DELETE /api/me/agent/licenses/:licenseId
 * @desc    Soft-delete an active license for the current agent
 * @access  Private (Agent only)
 */
router.delete('/:licenseId', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ME-LICENSES-DELETE] >> Deleting agent license');

    try {
        if (!req.user) {
            logger.error('[AGENT-ME-LICENSES-DELETE] !! User is missing from request');
            return res.status(401).json({
                success: false,
                message: 'Authentication error: User information is missing.'
            });
        }

        const { licenseId } = req.params;
        if (!licenseId) {
            return res.status(400).json({
                success: false,
                message: 'licenseId is required'
            });
        }

        const userId = req.user.UserId;
        const pool = await getPool();

        // Resolve current agent
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT AgentId
                FROM oe.Agents
                WHERE UserId = @userId
            `);

        if (agentResult.recordset.length === 0) {
            logger.error(`[AGENT-ME-LICENSES-DELETE] Agent not found for UserId: ${userId}`);
            return res.status(404).json({
                success: false,
                message: 'Agent not found'
            });
        }

        const agentId = agentResult.recordset[0].AgentId;

        // Soft-delete active license owned by this agent
        const deleteResult = await pool.request()
            .input('licenseId', sql.UniqueIdentifier, licenseId)
            .input('agentId', sql.UniqueIdentifier, agentId)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.AgentLicenses
                SET Status = 'Inactive',
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @modifiedBy
                WHERE LicenseId = @licenseId
                  AND AgentId = @agentId
                  AND Status = 'Active'
            `);

        if (!deleteResult.rowsAffected || deleteResult.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Active license not found'
            });
        }

        logger.info('[AGENT-ME-LICENSES-DELETE] << License deleted', { licenseId, agentId });
        return res.json({
            success: true,
            message: 'License deleted successfully'
        });
    } catch (error) {
        logger.error('[AGENT-ME-LICENSES-DELETE] !! Error deleting license:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete license',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;
