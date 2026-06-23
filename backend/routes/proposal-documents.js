// backend/routes/proposal-documents.js
// Routes for managing proposal document templates

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const ProposalDocumentService = require('../services/proposalDocument.service');
const { authenticateUrls } = require('./uploads');

// Respect x-current-tenant-id (tenant switch); sets req.tenantId and aligns req.user.TenantId
router.use(requireTenantAccess);

/**
 * GET /api/proposal-documents
 * Get proposal documents filtered by tenant(s), category, and search
 * @access TenantAdmin, VendorAdmin, Agent, SysAdmin
 */
router.get('/', authorize(['TenantAdmin', 'VendorAdmin', 'Agent', 'SysAdmin']), async (req, res) => {
  try {
    const { tenantIds, category, search, includeInactive } = req.query;
    const userRoles = getUserRoles(req.user);
    const allTenants = userRoles.includes('SysAdmin') && (req.query.allTenants === 'true' || req.query.allTenants === '1');
    
    // Determine which tenant IDs to filter by
    let filterTenantIds = null;
    
    if (userRoles.includes('SysAdmin')) {
      if (allTenants) {
        filterTenantIds = null;
      } else if (tenantIds) {
        filterTenantIds = Array.isArray(tenantIds)
          ? tenantIds
          : tenantIds.split(',').filter(id => id && id.trim());
      } else {
        filterTenantIds = req.tenantId ? [req.tenantId] : null;
      }
    } else {
      filterTenantIds = req.tenantId ? [req.tenantId] : [req.user.TenantId];
    }
    
    console.log('📋 Getting proposal documents with filters:', {
      tenantIds: filterTenantIds,
      category: category || null,
      search: search || null,
      userRole: userRoles[0] || 'Unknown'
    });
    
    const documents = await ProposalDocumentService.getProposalDocuments(
      filterTenantIds,
      category || null,
      search || null,
      includeInactive === 'true' || includeInactive === true
    );
    
    console.log(`✅ Found ${documents.length} proposal documents`);
    
    // Authenticate document URLs before sending to frontend
    const authenticatedDocuments = await Promise.all(
      documents.map(async (doc) => {
        const authenticated = await authenticateUrls(doc, ['DocumentUrl']);
        // Parse TenantIds string back to array for frontend
        if (authenticated.TenantIds) {
          authenticated.TenantIds = authenticated.TenantIds.split(',').filter(id => id);
        }
        return authenticated;
      })
    );
    
    res.json({
      success: true,
      data: authenticatedDocuments
    });
  } catch (error) {
    console.error('❌ Error getting proposal documents:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get proposal documents',
      error: {
        message: error.message,
        code: 'GET_PROPOSAL_DOCUMENTS_ERROR'
      }
    });
  }
});

/**
 * GET /api/proposal-documents/products
 * Get products with RequiredDataFields for proposal document editor
 * @access TenantAdmin, VendorAdmin, Agent, SysAdmin
 */
router.get('/products', authorize(['TenantAdmin', 'VendorAdmin', 'Agent', 'SysAdmin']), async (req, res) => {
  try {
    const userRoles = getUserRoles(req.user);
    const tenantId = req.user.TenantId;
    const pool = await getPool();
    const request = pool.request();
    
    let query;
    
    if (userRoles.includes('SysAdmin')) {
      // SysAdmin can see all products
      query = `
        SELECT DISTINCT
          p.ProductId,
          p.Name,
          p.Description,
          p.IsBundle,
          p.SalesType,
          p.RequiredDataFields,
          p.ProductOwnerId
        FROM oe.Products p
        WHERE p.Status = 'Active'
        ORDER BY p.Name
      `;
    } else {
      // Non-SysAdmin: filter by tenant
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
      query = `
        SELECT DISTINCT
          p.ProductId,
          p.Name,
          p.Description,
          p.IsBundle,
          p.SalesType,
          p.RequiredDataFields,
          p.ProductOwnerId
        FROM oe.Products p
        LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId AND tps.TenantId = @TenantId
        WHERE p.Status = 'Active'
          AND (
            p.ProductOwnerId = @TenantId
            OR (tps.TenantId = @TenantId AND tps.SubscriptionStatus = 'Active')
          )
        ORDER BY p.Name
      `;
    }
    
    const result = await request.query(query);
    
    // Process products to parse RequiredDataFields and extract config options
    // Query ProductPricing for distinct ConfigValue1 as fallback for products without RequiredDataFields
    // Also query bundle included products' configs for bundle products
    const productIds = result.recordset.map(p => p.ProductId);
    let pricingConfigs = {};
    let bundleIncludedConfigs = {};
    if (productIds.length > 0) {
      try {
        // Get direct product configs from ProductPricing
        const pricingReq = pool.request();
        const pricingResult = await pricingReq.query(`
          SELECT DISTINCT ProductId, ConfigValue1
          FROM oe.ProductPricing
          WHERE ProductId IN (${productIds.map(id => `'${id}'`).join(',')})
            AND ConfigValue1 IS NOT NULL AND ConfigValue1 != ''
          ORDER BY ProductId, ConfigValue1
        `);
        for (const row of pricingResult.recordset) {
          if (!pricingConfigs[row.ProductId]) pricingConfigs[row.ProductId] = [];
          pricingConfigs[row.ProductId].push(row.ConfigValue1);
        }

        // For bundles: get config values from their included products' pricing
        const bundleIds = result.recordset.filter(p => p.IsBundle).map(p => p.ProductId);
        if (bundleIds.length > 0) {
          const bundleReq = pool.request();
          const bundleResult = await bundleReq.query(`
            SELECT DISTINCT pb.BundleProductId, pp.ConfigValue1
            FROM oe.ProductBundles pb
            JOIN oe.ProductPricing pp ON pb.IncludedProductId = pp.ProductId
            WHERE pb.BundleProductId IN (${bundleIds.map(id => `'${id}'`).join(',')})
              AND pp.ConfigValue1 IS NOT NULL AND pp.ConfigValue1 != ''
            ORDER BY pb.BundleProductId, pp.ConfigValue1
          `);
          for (const row of bundleResult.recordset) {
            if (!bundleIncludedConfigs[row.BundleProductId]) bundleIncludedConfigs[row.BundleProductId] = [];
            if (!bundleIncludedConfigs[row.BundleProductId].includes(row.ConfigValue1)) {
              bundleIncludedConfigs[row.BundleProductId].push(row.ConfigValue1);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to load pricing configs for products:', err.message);
      }
    }

    const products = result.recordset.map(product => {
      let requiredDataFields = [];
      let availableConfigs = [];

      // Parse RequiredDataFields
      if (product.RequiredDataFields) {
        try {
          const parsed = typeof product.RequiredDataFields === 'string'
            ? JSON.parse(product.RequiredDataFields)
            : product.RequiredDataFields;

          if (Array.isArray(parsed)) {
            requiredDataFields = parsed;
            // Extract all fieldOptions from all fields
            parsed.forEach(field => {
              if (field.fieldOptions && Array.isArray(field.fieldOptions)) {
                availableConfigs.push(...field.fieldOptions);
              }
            });
            // Remove duplicates and sort
            availableConfigs = [...new Set(availableConfigs)].sort();
          }
        } catch (error) {
          console.warn(`Failed to parse RequiredDataFields for product ${product.ProductId}:`, error);
        }
      }

      // Fallback: if no config options from RequiredDataFields, use distinct ConfigValue1 from ProductPricing
      if (availableConfigs.length === 0) {
        if (product.IsBundle && bundleIncludedConfigs[product.ProductId]) {
          // For bundles: use configs from included products' pricing
          availableConfigs = bundleIncludedConfigs[product.ProductId];
        } else if (pricingConfigs[product.ProductId]) {
          // For non-bundles: use direct pricing configs
          availableConfigs = pricingConfigs[product.ProductId];
        }
      }

      return {
        ProductId: product.ProductId,
        Name: product.Name,
        Description: product.Description,
        IsBundle: product.IsBundle,
        SalesType: product.SalesType,
        RequiredDataFields: requiredDataFields,
        AvailableConfigs: availableConfigs,
        // Also include camelCase versions for frontend compatibility
        productId: product.ProductId,
        name: product.Name,
        description: product.Description,
        isBundle: product.IsBundle,
        salesType: product.SalesType,
        requiredDataFields: requiredDataFields,
        availableConfigs: availableConfigs
      };
    });
    
    // If bundleProductId is provided, get the bundle itself and its included products
    const { bundleProductId } = req.query;
    if (bundleProductId) {
      const bundleRequest = pool.request();
      bundleRequest.input('BundleProductId', sql.UniqueIdentifier, bundleProductId);
      
      // First, get the bundle product itself
      const bundleSelfResult = await bundleRequest.query(`
        SELECT 
          p.ProductId,
          p.Name,
          p.Description,
          p.IsBundle,
          p.RequiredDataFields
        FROM oe.Products p
        WHERE p.ProductId = @BundleProductId
          AND p.Status = 'Active'
      `);
      
      // Then get included products
      const bundleResult = await bundleRequest.query(`
        SELECT 
          p.ProductId,
          p.Name,
          p.Description,
          p.IsBundle,
          p.RequiredDataFields,
          pb.SortOrder
        FROM oe.ProductBundles pb
        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
        WHERE pb.BundleProductId = @BundleProductId
          AND p.Status = 'Active'
        ORDER BY pb.SortOrder
      `);
      
      // Process bundle itself
      const bundleProducts = [];
      if (bundleSelfResult.recordset.length > 0) {
        const bundleProduct = bundleSelfResult.recordset[0];
        let requiredDataFields = [];
        let availableConfigs = [];
        
        if (bundleProduct.RequiredDataFields) {
          try {
            const parsed = typeof bundleProduct.RequiredDataFields === 'string'
              ? JSON.parse(bundleProduct.RequiredDataFields)
              : bundleProduct.RequiredDataFields;
            
            if (Array.isArray(parsed)) {
              requiredDataFields = parsed;
              parsed.forEach(field => {
                if (field.fieldOptions && Array.isArray(field.fieldOptions)) {
                  availableConfigs.push(...field.fieldOptions);
                }
              });
              availableConfigs = [...new Set(availableConfigs)].sort();
            }
          } catch (error) {
            console.warn(`Failed to parse RequiredDataFields for bundle ${bundleProduct.ProductId}:`, error);
          }
        }
        
        bundleProducts.push({
          ProductId: bundleProduct.ProductId,
          Name: bundleProduct.Name,
          Description: bundleProduct.Description,
          IsBundle: bundleProduct.IsBundle,
          RequiredDataFields: requiredDataFields,
          AvailableConfigs: availableConfigs,
          productId: bundleProduct.ProductId,
          name: bundleProduct.Name,
          description: bundleProduct.Description,
          isBundle: bundleProduct.IsBundle,
          requiredDataFields: requiredDataFields,
          availableConfigs: availableConfigs
        });
      }
      
      // Process included products
      const includedProducts = bundleResult.recordset.map(product => {
        let requiredDataFields = [];
        let availableConfigs = [];
        
        if (product.RequiredDataFields) {
          try {
            const parsed = typeof product.RequiredDataFields === 'string'
              ? JSON.parse(product.RequiredDataFields)
              : product.RequiredDataFields;
            
            if (Array.isArray(parsed)) {
              requiredDataFields = parsed;
              parsed.forEach(field => {
                if (field.fieldOptions && Array.isArray(field.fieldOptions)) {
                  availableConfigs.push(...field.fieldOptions);
                }
              });
              availableConfigs = [...new Set(availableConfigs)].sort();
            }
          } catch (error) {
            console.warn(`Failed to parse RequiredDataFields for included product ${product.ProductId}:`, error);
          }
        }
        
        return {
          ProductId: product.ProductId,
          Name: product.Name,
          Description: product.Description,
          IsBundle: product.IsBundle,
          RequiredDataFields: requiredDataFields,
          AvailableConfigs: availableConfigs,
          productId: product.ProductId,
          name: product.Name,
          description: product.Description,
          isBundle: product.IsBundle,
          requiredDataFields: requiredDataFields,
          availableConfigs: availableConfigs
        };
      });
      
      // Return bundle itself first, then included products
      return res.json({
        success: true,
        data: [...bundleProducts, ...includedProducts]
      });
    }
    
    res.json({
      success: true,
      data: products
    });
  } catch (error) {
    console.error('❌ Error getting products for proposal documents:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get products',
      error: {
        message: error.message,
        code: 'GET_PROPOSAL_PRODUCTS_ERROR'
      }
    });
  }
});

/**
 * GET /api/proposal-documents/documents/:documentId/proxy
 * Proxy PDF document from Azure Blob Storage to avoid CORS issues
 * Authorization: TenantAdmin, VendorAdmin, Agent, SysAdmin
 */
router.get('/documents/:documentId/proxy', authorize(['TenantAdmin', 'VendorAdmin', 'Agent', 'SysAdmin']), async (req, res) => {
  try {
    const { documentId } = req.params;
    
    if (!documentId) {
      return res.status(400).json({
        success: false,
        message: 'Document ID is required'
      });
    }
    
    // Get document from FileUploads
    const pool = await getPool();
    const request = pool.request();
    request.input('fileId', sql.UniqueIdentifier, documentId);
    
    const result = await request.query(`
      SELECT FilePath, StoredFileName
      FROM oe.FileUploads
      WHERE FileId = @fileId AND Status = 'Active'
    `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }
    
    const fileInfo = result.recordset[0];
    const filePath = fileInfo.FilePath;
    
    // Download PDF from Azure Blob Storage
    const { BlobServiceClient } = require('@azure/storage-blob');
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    
    if (!connectionString) {
      throw new Error('Azure Storage connection string not configured');
    }
    
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    
    // Parse the blob URL to extract container and blob name
    const urlObj = new URL(filePath);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    const containerName = pathParts[0] || 'documents';
    const blobName = pathParts.slice(1).join('/');
    
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    // Check if blob exists
    const exists = await blockBlobClient.exists();
    if (!exists) {
      return res.status(404).json({
        success: false,
        message: 'PDF file not found in storage'
      });
    }
    
    // Download PDF buffer
    const pdfBuffer = await blockBlobClient.downloadToBuffer();
    
    // Set appropriate headers for PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileInfo.StoredFileName || 'document.pdf'}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'private, max-age=3600'); // Cache for 1 hour
    
    // Send the PDF buffer
    res.send(pdfBuffer);
  } catch (error) {
    console.error('❌ Error proxying PDF document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load PDF document',
      error: {
        message: error.message,
        code: 'PDF_PROXY_ERROR'
      }
    });
  }
});

/**
 * GET /api/proposal-documents/:id
 * Get a single proposal document with its fields
 * @access TenantAdmin, VendorAdmin, Agent, SysAdmin
 */
router.get('/:id', authorize(['TenantAdmin', 'VendorAdmin', 'Agent', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const userRoles = getUserRoles(req.user);
    
    const document = await ProposalDocumentService.getProposalDocument(id);
    
    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Proposal document not found'
      });
    }
    
    // Check access: user must have access via tenant association (unless SysAdmin)
    if (!userRoles.includes('SysAdmin')) {
      const tenantIds = document.TenantIds ? document.TenantIds.split(',').filter(id => id) : [];
      if (!tenantIds.includes(req.user.TenantId)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have access to this proposal document'
        });
      }
    }
    
    // Parse TenantIds string back to array for frontend
    if (document.TenantIds) {
      document.TenantIds = document.TenantIds.split(',').filter(id => id);
    }
    
    // Authenticate document URL before sending to frontend
    const authenticatedDocument = await authenticateUrls(document, ['DocumentUrl']);
    
    res.json({
      success: true,
      data: authenticatedDocument
    });
  } catch (error) {
    console.error('❌ Error getting proposal document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get proposal document',
      error: {
        message: error.message,
        code: 'GET_PROPOSAL_DOCUMENT_ERROR'
      }
    });
  }
});

/**
 * POST /api/proposal-documents
 * Create a new proposal document
 * @access TenantAdmin, VendorAdmin, SysAdmin
 */
router.post('/', authorize(['TenantAdmin', 'VendorAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { name, description, category, documentId, documentUrl, fileName, fileSize, fields, isActive, tenantIds, productSlots } = req.body;
    const userRoles = getUserRoles(req.user);
    
    if (!name || !documentId) {
      return res.status(400).json({
        success: false,
        message: 'Name and documentId are required'
      });
    }
    
    // Check if file exists in FileUploads, if not, save it
    const pool = await getPool();
    const checkRequest = pool.request();
    checkRequest.input('fileId', sql.UniqueIdentifier, documentId);
    
    const checkResult = await checkRequest.query(`
      SELECT FileId FROM oe.FileUploads WHERE FileId = @fileId
    `);
    
    if (checkResult.recordset.length === 0 && documentUrl && fileName) {
      // File doesn't exist in FileUploads, save it
      const insertRequest = pool.request();
      insertRequest.input('fileId', sql.UniqueIdentifier, documentId);
      insertRequest.input('fileName', sql.NVarChar, fileName);
      insertRequest.input('storedFileName', sql.NVarChar, fileName);
      insertRequest.input('filePath', sql.NVarChar, documentUrl);
      insertRequest.input('fileSize', sql.Int, fileSize || 0);
      insertRequest.input('mimeType', sql.NVarChar, 'application/pdf');
      insertRequest.input('uploadType', sql.NVarChar, 'documents');
      insertRequest.input('entityId', sql.NVarChar, 'proposal');
      insertRequest.input('category', sql.NVarChar, 'proposal');
      insertRequest.input('uploadedBy', sql.UniqueIdentifier, req.user.UserId);
      insertRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
      insertRequest.input('status', sql.NVarChar, 'Active');
      insertRequest.input('createdDate', sql.DateTime2, new Date());
      insertRequest.input('modifiedDate', sql.DateTime2, new Date());
      
      await insertRequest.query(`
        INSERT INTO oe.FileUploads 
        (FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
         UploadType, EntityId, Category, UploadedBy, TenantId, Status, CreatedDate, ModifiedDate)
        VALUES 
        (@fileId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
         @uploadType, @entityId, @category, @uploadedBy, @tenantId, @status, @createdDate, @modifiedDate)
      `);
      
      console.log(`✅ File saved to FileUploads: ${documentId}`);
    }
    
    // Determine tenant IDs: use provided tenantIds or default to user's tenant
    let finalTenantIds = [];
    if (userRoles.includes('SysAdmin')) {
      // SysAdmin can select multiple tenants
      finalTenantIds = tenantIds && Array.isArray(tenantIds) && tenantIds.length > 0
        ? tenantIds
        : (req.user.TenantId ? [req.user.TenantId] : []);
    } else {
      // Non-SysAdmin users: use their tenant (can't select others)
      finalTenantIds = [req.user.TenantId];
    }
    
    if (finalTenantIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one tenant must be associated with the proposal'
      });
    }
    
    const documentData = {
      name,
      description,
      category: category || null,
      documentId,
      tenantIds: finalTenantIds,
      isActive: isActive !== false,
      productSlots: Array.isArray(productSlots) ? productSlots : undefined
    };
    
    const createdDocument = await ProposalDocumentService.saveProposalDocument(
      documentData,
      fields || [],
      req.user.UserId
    );
    
    // Parse TenantIds for response
    if (createdDocument.TenantIds) {
      createdDocument.TenantIds = createdDocument.TenantIds.split(',').filter(id => id);
    }
    
    res.json({
      success: true,
      data: createdDocument,
      message: 'Proposal document created successfully'
    });
  } catch (error) {
    console.error('❌ Error creating proposal document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create proposal document',
      error: {
        message: error.message,
        code: 'CREATE_PROPOSAL_DOCUMENT_ERROR'
      }
    });
  }
});

/**
 * PUT /api/proposal-documents/:id
 * Update a proposal document
 * @access TenantAdmin, VendorAdmin, SysAdmin
 */
router.put('/:id', authorize(['TenantAdmin', 'VendorAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, category, documentId, fields, isActive, tenantIds, productSlots } = req.body;
    
    // Debug: log what we received
    console.log(`📥 Received PUT request for proposal ${id}`);
    console.log(`📥 Request body keys:`, Object.keys(req.body));
    console.log(`📥 Request body values:`, {
      name: req.body.name,
      description: req.body.description,
      category: req.body.category,
      isActive: req.body.isActive,
      tenantIds: req.body.tenantIds,
      documentId: req.body.documentId,
      fields: req.body.fields
    });
    console.log(`📥 Full request body:`, JSON.stringify(req.body, null, 2));
    
    const userRoles = getUserRoles(req.user);
    
    // Verify access via tenant association
    const existingDoc = await ProposalDocumentService.getProposalDocument(id);
    if (!existingDoc) {
      return res.status(404).json({
        success: false,
        message: 'Proposal document not found'
      });
    }
    
    // Check if user has access (unless SysAdmin)
    if (!userRoles.includes('SysAdmin')) {
      const existingTenantIds = existingDoc.TenantIds ? existingDoc.TenantIds.split(',').filter(tid => tid) : [];
      if (!existingTenantIds.includes(req.user.TenantId)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to update this proposal document'
        });
      }
    }

    // When replacing document: ensure new file exists in FileUploads (same as POST create)
    const newDocumentId = req.body.documentId;
    const newDocumentUrl = req.body.documentUrl;
    const newFileName = req.body.fileName;
    const newFileSize = req.body.fileSize;
    if (newDocumentId && newDocumentUrl && newFileName) {
      const pool = await getPool();
      const checkRequest = pool.request();
      checkRequest.input('fileId', sql.UniqueIdentifier, newDocumentId);
      const checkResult = await checkRequest.query(`
        SELECT FileId FROM oe.FileUploads WHERE FileId = @fileId
      `);
      if (checkResult.recordset.length === 0) {
        const insertRequest = pool.request();
        insertRequest.input('fileId', sql.UniqueIdentifier, newDocumentId);
        insertRequest.input('fileName', sql.NVarChar, newFileName);
        insertRequest.input('storedFileName', sql.NVarChar, newFileName);
        insertRequest.input('filePath', sql.NVarChar, newDocumentUrl);
        insertRequest.input('fileSize', sql.Int, newFileSize || 0);
        insertRequest.input('mimeType', sql.NVarChar, 'application/pdf');
        insertRequest.input('uploadType', sql.NVarChar, 'documents');
        insertRequest.input('entityId', sql.NVarChar, 'proposal');
        insertRequest.input('category', sql.NVarChar, 'proposal');
        insertRequest.input('uploadedBy', sql.UniqueIdentifier, req.user.UserId);
        insertRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        insertRequest.input('status', sql.NVarChar, 'Active');
        insertRequest.input('createdDate', sql.DateTime2, new Date());
        insertRequest.input('modifiedDate', sql.DateTime2, new Date());
        await insertRequest.query(`
          INSERT INTO oe.FileUploads 
          (FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
           UploadType, EntityId, Category, UploadedBy, TenantId, Status, CreatedDate, ModifiedDate)
          VALUES 
          (@fileId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
           @uploadType, @entityId, @category, @uploadedBy, @tenantId, @status, @createdDate, @modifiedDate)
        `);
        console.log(`✅ File saved to FileUploads (replace document): ${newDocumentId}`);
      }
    }

    // Determine tenant IDs for update
    let finalTenantIds = null; // null means don't update tenant associations
    if (tenantIds !== undefined) {
      if (userRoles.includes('SysAdmin')) {
        // SysAdmin can update to any tenant(s)
        finalTenantIds = Array.isArray(tenantIds) && tenantIds.length > 0 ? tenantIds : [];
      } else {
        // Non-SysAdmin: can only keep their tenant or add their tenant
        const existingTenantIds = existingDoc.TenantIds ? existingDoc.TenantIds.split(',').filter(tid => tid) : [];
        if (Array.isArray(tenantIds) && tenantIds.length > 0) {
          // Ensure user's tenant is included
          if (!tenantIds.includes(req.user.TenantId)) {
            finalTenantIds = [...tenantIds, req.user.TenantId];
          } else {
            finalTenantIds = tenantIds;
          }
        } else {
          // Default to user's tenant if empty array provided
          finalTenantIds = [req.user.TenantId];
        }
      }
      
      if (finalTenantIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one tenant must be associated with the proposal'
        });
      }
    }
    
    // Build documentData - include fields that are explicitly provided in the request body
    // Note: undefined values are stripped from JSON, so we can't check for them
    // We'll include all fields that are present in req.body, even if null
    const documentData = {
      proposalDocumentId: id
    };
    
    // Check if fields exist in request body (they might be null or empty string, but not undefined after JSON parsing)
    if (req.body.hasOwnProperty('name')) documentData.name = name;
    if (req.body.hasOwnProperty('description')) documentData.description = description;
    if (req.body.hasOwnProperty('category')) documentData.category = category;
    if (req.body.hasOwnProperty('documentId')) documentData.documentId = documentId;
    if (req.body.hasOwnProperty('isActive')) documentData.isActive = isActive;
    if (req.body.hasOwnProperty('tenantIds') && finalTenantIds !== null && finalTenantIds !== undefined) documentData.tenantIds = finalTenantIds;
    if (req.body.hasOwnProperty('productSlots') && Array.isArray(productSlots)) documentData.productSlots = productSlots;
    
    console.log(`📝 Updating proposal document ${id} with data:`, JSON.stringify(documentData, null, 2));
    console.log(`📝 Request body keys:`, Object.keys(req.body));
    console.log(`📝 Request body values:`, JSON.stringify({ name, description, category, isActive, tenantIds, documentId }, null, 2));
    
    // Handle fields: if provided as an array, use it (even if empty - to clear all fields)
    // When updating metadata only, fields should be undefined (not provided)
    // This prevents accidentally processing fields when only updating metadata
    // Also handle case where fields might be an object (from frontend) - convert to array or ignore
    let fieldsToSave = undefined;
    if (fields !== undefined && fields !== null) {
      if (Array.isArray(fields)) {
        // Array provided - use it (even if empty, to clear all fields)
        fieldsToSave = fields;
      } else if (typeof fields === 'object' && !Array.isArray(fields)) {
        // If fields is an object (not array), it might be the proposal document itself
        // Try to extract fields array if it exists, otherwise ignore
        if (fields.fields && Array.isArray(fields.fields)) {
          fieldsToSave = fields.fields;
        } else {
          // Fields is an object but not a valid fields array - ignore it
          fieldsToSave = undefined;
        }
      }
    }
    
    // Log what we're passing for debugging
    console.log(`📝 Updating proposal document ${id} - fields provided: ${fields !== undefined}, fields type: ${typeof fields}, fields length: ${Array.isArray(fields) ? fields.length : typeof fields === 'object' ? Object.keys(fields).length : 'N/A'}, fieldsToSave: ${fieldsToSave !== undefined ? `${fieldsToSave.length} items` : 'undefined'}`);
    
    // Pass fieldsToSave (will be undefined if no fields, array if fields provided)
    // The service will only save fields if they're provided as an array with length > 0
    const updatedDocument = await ProposalDocumentService.saveProposalDocument(
      documentData,
      fieldsToSave, // undefined = don't update fields, array = save these fields
      req.user.UserId
    );
    
    // Parse TenantIds for response
    if (updatedDocument.TenantIds) {
      updatedDocument.TenantIds = updatedDocument.TenantIds.split(',').filter(id => id);
    }
    
    res.json({
      success: true,
      data: updatedDocument,
      message: 'Proposal document updated successfully'
    });
  } catch (error) {
    console.error('❌ Error updating proposal document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update proposal document',
      error: {
        message: error.message,
        code: 'UPDATE_PROPOSAL_DOCUMENT_ERROR'
      }
    });
  }
});

/**
 * DELETE /api/proposal-documents/:id
 * Permanently delete a proposal document and its associated fields/products/tenants.
 * ProposalSends history is preserved (FK reference set to NULL).
 * @access TenantAdmin, VendorAdmin, SysAdmin
 */
router.delete('/:id', authorize(['TenantAdmin', 'VendorAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const userRoles = getUserRoles(req.user);
    
    // Verify access via tenant association
    const existingDoc = await ProposalDocumentService.getProposalDocument(id);
    if (!existingDoc) {
      return res.status(404).json({
        success: false,
        message: 'Proposal document not found'
      });
    }
    
    // Check if user has access (unless SysAdmin)
    if (!userRoles.includes('SysAdmin')) {
      const existingTenantIds = existingDoc.TenantIds ? existingDoc.TenantIds.split(',').filter(tid => tid) : [];
      if (!existingTenantIds.includes(req.user.TenantId)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to delete this proposal document'
        });
      }
    }
    
    const deleted = await ProposalDocumentService.deleteProposalDocument(id);
    
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Proposal document not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Proposal document deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting proposal document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete proposal document',
      error: {
        message: error.message,
        code: 'DELETE_PROPOSAL_DOCUMENT_ERROR'
      }
    });
  }
});

/**
 * GET /api/proposal-documents/:id/fields
 * Get fields for a proposal document
 * @access TenantAdmin, VendorAdmin, Agent
 */
router.get('/:id/fields', authorize(['TenantAdmin', 'VendorAdmin', 'Agent']), async (req, res) => {
  try {
    const { id } = req.params;
    
    const fields = await ProposalDocumentService.getProposalFields(id);
    
    res.json({
      success: true,
      data: fields
    });
  } catch (error) {
    console.error('❌ Error getting proposal fields:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get proposal fields',
      error: {
        message: error.message,
        code: 'GET_PROPOSAL_FIELDS_ERROR'
      }
    });
  }
});

/**
 * POST /api/proposal-documents/:id/fields
 * Save fields for a proposal document
 * @access TenantAdmin, VendorAdmin, SysAdmin
 */
router.post('/:id/fields', authorize(['TenantAdmin', 'VendorAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { fields } = req.body;
    const userRoles = getUserRoles(req.user);
    
    if (!Array.isArray(fields)) {
      return res.status(400).json({
        success: false,
        message: 'Fields must be an array'
      });
    }
    
    // Verify access via tenant association
    const existingDoc = await ProposalDocumentService.getProposalDocument(id);
    if (!existingDoc) {
      return res.status(404).json({
        success: false,
        message: 'Proposal document not found'
      });
    }
    
    // Check if user has access (unless SysAdmin)
    if (!userRoles.includes('SysAdmin')) {
      const existingTenantIds = existingDoc.TenantIds ? existingDoc.TenantIds.split(',').filter(tid => tid) : [];
      if (!existingTenantIds.includes(req.user.TenantId)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to update fields for this proposal document'
        });
      }
    }
    
    const savedFields = await ProposalDocumentService.saveProposalFields(
      id,
      fields,
      req.user.UserId
    );
    
    res.json({
      success: true,
      data: savedFields,
      message: 'Proposal fields saved successfully'
    });
  } catch (error) {
    console.error('❌ Error saving proposal fields:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save proposal fields',
      error: {
        message: error.message,
        code: 'SAVE_PROPOSAL_FIELDS_ERROR'
      }
    });
  }
});

/**
 * GET /api/proposal-documents/documents/:documentId/proxy
 * Proxy PDF document from Azure Blob Storage to avoid CORS issues
 * Authorization: TenantAdmin, VendorAdmin, Agent, SysAdmin
 */
router.get('/documents/:documentId/proxy', authorize(['TenantAdmin', 'VendorAdmin', 'Agent', 'SysAdmin']), async (req, res) => {
  try {
    const { documentId } = req.params;
    
    if (!documentId) {
      return res.status(400).json({
        success: false,
        message: 'Document ID is required'
      });
    }
    
    // Get document from FileUploads
    const pool = await getPool();
    const request = pool.request();
    request.input('fileId', sql.UniqueIdentifier, documentId);
    
    const result = await request.query(`
      SELECT FilePath, StoredFileName
      FROM oe.FileUploads
      WHERE FileId = @fileId AND Status = 'Active'
    `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }
    
    const fileInfo = result.recordset[0];
    const filePath = fileInfo.FilePath;
    
    // Download PDF from Azure Blob Storage
    const { BlobServiceClient } = require('@azure/storage-blob');
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    
    if (!connectionString) {
      throw new Error('Azure Storage connection string not configured');
    }
    
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    
    // Parse the blob URL to extract container and blob name
    const urlObj = new URL(filePath);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    const containerName = pathParts[0] || 'documents';
    const blobName = pathParts.slice(1).join('/');
    
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    // Check if blob exists
    const exists = await blockBlobClient.exists();
    if (!exists) {
      return res.status(404).json({
        success: false,
        message: 'PDF file not found in storage'
      });
    }
    
    // Download PDF buffer
    const pdfBuffer = await blockBlobClient.downloadToBuffer();
    
    // Set appropriate headers for PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileInfo.StoredFileName || 'document.pdf'}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'private, max-age=3600'); // Cache for 1 hour
    
    // Send the PDF buffer
    res.send(pdfBuffer);
  } catch (error) {
    console.error('❌ Error proxying PDF document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load PDF document',
      error: {
        message: error.message,
        code: 'PDF_PROXY_ERROR'
      }
    });
  }
});

module.exports = router;

