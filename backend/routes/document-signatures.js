// backend/routes/document-signatures.js
// Routes for managing PDF signature templates and applying signatures

const express = require('express');
const router = express.Router();
const { authorize } = require('../middleware/auth');
const DocumentSignatureService = require('../services/documentSignature.service');

/**
 * GET /api/document-signatures/templates/:documentId
 * Get signature template for a document
 * Authorization: SysAdmin, VendorAdmin, or public (for group onboarding)
 */
router.get('/templates/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    
    if (!documentId) {
      return res.status(400).json({
        success: false,
        message: 'Document ID is required'
      });
    }
    
    const template = await DocumentSignatureService.getSignatureTemplate(documentId);
    
    // Get document info to authenticate URL if needed
    try {
      const document = await DocumentSignatureService.getDocument(documentId);
      // Document URL authentication is handled by the vendor documents endpoint
      // This endpoint just returns template data
    } catch (docError) {
      // Document not found is not critical for template endpoint
      console.warn('⚠️ Could not fetch document for authentication:', docError.message);
    }
    
    res.json({
      success: true,
      data: template
    });
  } catch (error) {
    console.error('❌ Error getting signature template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get signature template',
      error: {
        message: error.message,
        code: 'TEMPLATE_FETCH_ERROR'
      }
    });
  }
});

/**
 * POST /api/document-signatures/templates
 * Create or update signature template
 * Authorization: SysAdmin, VendorAdmin
 */
router.post('/templates', authorize(['SysAdmin', 'VendorAdmin']), async (req, res) => {
  try {
    const { documentId, fields } = req.body;
    const userId = req.user?.UserId || null;
    
    if (!documentId) {
      return res.status(400).json({
        success: false,
        message: 'Document ID is required'
      });
    }
    
    if (!fields || !Array.isArray(fields)) {
      return res.status(400).json({
        success: false,
        message: 'Fields array is required'
      });
    }
    
    // Validate fields
    for (const field of fields) {
      if (!field.fieldType || !['signature', 'initial', 'date', 'text'].includes(field.fieldType)) {
        return res.status(400).json({
          success: false,
          message: `Invalid field type: ${field.fieldType}. Must be one of: signature, initial, date, text`
        });
      }
      
      if (typeof field.xPosition !== 'number' || field.xPosition < 0 || field.xPosition > 1) {
        return res.status(400).json({
          success: false,
          message: 'XPosition must be a number between 0 and 1'
        });
      }
      
      if (typeof field.yPosition !== 'number' || field.yPosition < 0 || field.yPosition > 1) {
        return res.status(400).json({
          success: false,
          message: 'YPosition must be a number between 0 and 1'
        });
      }
      
      if (typeof field.width !== 'number' || field.width <= 0 || field.width > 1) {
        return res.status(400).json({
          success: false,
          message: 'Width must be a number between 0 and 1'
        });
      }
      
      if (typeof field.height !== 'number' || field.height <= 0 || field.height > 1) {
        return res.status(400).json({
          success: false,
          message: 'Height must be a number between 0 and 1'
        });
      }
    }
    
    const savedTemplate = await DocumentSignatureService.saveSignatureTemplate(documentId, fields, userId);
    
    res.json({
      success: true,
      data: savedTemplate,
      message: 'Signature template saved successfully'
    });
  } catch (error) {
    console.error('❌ Error saving signature template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save signature template',
      error: {
        message: error.message,
        code: 'TEMPLATE_SAVE_ERROR'
      }
    });
  }
});

/**
 * PUT /api/document-signatures/templates/:templateId
 * Update a single template field
 * Authorization: SysAdmin, VendorAdmin
 */
router.put('/templates/:templateId', authorize(['SysAdmin', 'VendorAdmin']), async (req, res) => {
  try {
    const { templateId } = req.params;
    const { fieldType, fieldName, xPosition, yPosition, width, height, pageNumber, isRequired, autoFillType } = req.body;
    
    // Get existing template to get documentId
    const pool = await require('../config/database').getPool();
    const request = pool.request();
    request.input('templateId', require('mssql').UniqueIdentifier, templateId);
    
    const existingResult = await request.query(`
      SELECT DocumentId FROM oe.DocumentSignatureTemplates WHERE TemplateId = @templateId
    `);
    
    if (existingResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template field not found'
      });
    }
    
    const documentId = existingResult.recordset[0].DocumentId;
    
    // Get all fields for this document
    const template = await DocumentSignatureService.getSignatureTemplate(documentId);
    
    // Find and update the specific field
    const fieldIndex = template.findIndex(f => f.TemplateId === templateId);
    if (fieldIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Template field not found'
      });
    }
    
    // Update the field
    template[fieldIndex] = {
      ...template[fieldIndex],
      FieldType: fieldType || template[fieldIndex].FieldType,
      FieldName: fieldName !== undefined ? fieldName : template[fieldIndex].FieldName,
      XPosition: xPosition !== undefined ? xPosition : template[fieldIndex].XPosition,
      YPosition: yPosition !== undefined ? yPosition : template[fieldIndex].YPosition,
      Width: width !== undefined ? width : template[fieldIndex].Width,
      Height: height !== undefined ? height : template[fieldIndex].Height,
      PageNumber: pageNumber !== undefined ? pageNumber : template[fieldIndex].PageNumber,
      IsRequired: isRequired !== undefined ? isRequired : template[fieldIndex].IsRequired,
      AutoFillType: autoFillType !== undefined ? autoFillType : template[fieldIndex].AutoFillType
    };
    
    // Save all fields
    const userId = req.user?.UserId || null;
    const savedTemplate = await DocumentSignatureService.saveSignatureTemplate(documentId, template, userId);
    
    res.json({
      success: true,
      data: savedTemplate.find(f => f.TemplateId === templateId),
      message: 'Template field updated successfully'
    });
  } catch (error) {
    console.error('❌ Error updating template field:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update template field',
      error: {
        message: error.message,
        code: 'TEMPLATE_UPDATE_ERROR'
      }
    });
  }
});

/**
 * DELETE /api/document-signatures/templates/:templateId
 * Delete a signature template field
 * Authorization: SysAdmin, VendorAdmin
 */
router.delete('/templates/:templateId', authorize(['SysAdmin', 'VendorAdmin']), async (req, res) => {
  try {
    const { templateId } = req.params;
    
    const deleted = await DocumentSignatureService.deleteTemplateField(templateId);
    
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Template field not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Template field deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting template field:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete template field',
      error: {
        message: error.message,
        code: 'TEMPLATE_DELETE_ERROR'
      }
    });
  }
});

/**
 * GET /api/document-signatures/documents/:documentId/url
 * Get authenticated document URL for PDF viewing
 * Authorization: SysAdmin, VendorAdmin, or public (for group onboarding)
 */
router.get('/documents/:documentId/url', async (req, res) => {
  try {
    const { documentId } = req.params;
    
    if (!documentId) {
      return res.status(400).json({
        success: false,
        message: 'Document ID is required'
      });
    }
    
    const document = await DocumentSignatureService.getDocument(documentId);
    
    // Return proxy URL instead of direct blob URL to avoid CORS issues
    res.json({
      success: true,
      data: {
        documentUrl: `/api/document-signatures/documents/${documentId}/proxy`,
        fileName: document.FileName
      }
    });
  } catch (error) {
    console.error('❌ Error getting authenticated document URL:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get document URL',
      error: {
        message: error.message,
        code: 'DOCUMENT_URL_ERROR'
      }
    });
  }
});

/**
 * GET /api/document-signatures/documents/:documentId/proxy
 * Proxy PDF document from Azure Blob Storage to avoid CORS issues
 * Authorization: Public (for group onboarding) or authenticated users
 */
router.get('/documents/:documentId/proxy', async (req, res) => {
  try {
    const { documentId } = req.params;
    
    console.log('📥 ========== PROXY ENDPOINT CALLED ==========');
    console.log('📥 Document ID:', documentId);
    console.log('📥 Full request URL:', req.url);
    console.log('📥 Full request originalUrl:', req.originalUrl);
    console.log('📥 Raw query string:', req.url.split('?')[1]?.substring(0, 200) || 'none');
    console.log('📥 Query object keys:', Object.keys(req.query));
    console.log('📥 Query object values:', Object.keys(req.query).map(key => ({
      key,
      hasValue: !!req.query[key],
      valueLength: req.query[key] ? String(req.query[key]).length : 0,
      valuePreview: req.query[key] ? String(req.query[key]).substring(0, 100) : null
    })));
    
    // Try multiple methods to get signedUrl
    let signedUrl = req.query.signedUrl;
    
    // If not found in req.query, try parsing from raw URL
    if (!signedUrl) {
      const queryString = req.url.split('?')[1] || req.originalUrl.split('?')[1];
      if (queryString) {
        try {
          const params = new URLSearchParams(queryString);
          signedUrl = params.get('signedUrl');
          console.log('📥 Attempted URLSearchParams parse, found:', !!signedUrl);
        } catch (parseErr) {
          console.error('❌ Error parsing query string:', parseErr);
        }
      }
    }
    
    // If still not found, try from req.body (in case it's POST)
    if (!signedUrl && req.body && req.body.signedUrl) {
      signedUrl = req.body.signedUrl;
      console.log('📥 Found signedUrl in req.body');
    }
    
    console.log('📥 ========== SIGNED URL CHECK ==========');
    console.log('📥 Has signedUrl parameter:', !!signedUrl);
    console.log('📥 signedUrl value length:', signedUrl ? String(signedUrl).length : 0);
    if (signedUrl) {
      console.log('📥 signedUrl preview:', String(signedUrl).substring(0, 150) + '...');
      console.log('📥 signedUrl full value:', String(signedUrl));
    } else {
      console.error('❌ CRITICAL: signedUrl parameter is MISSING!');
      console.error('❌ This means the original PDF will be returned (WRONG!)');
    }
    
    let pdfBuffer;
    
    if (signedUrl) {
      // Download signed PDF directly from the signed URL
      try {
        const { BlobServiceClient } = require('@azure/storage-blob');
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
          throw new Error('Azure Storage connection string not configured');
        }
        
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        
        // Parse the blob URL to extract container and blob name
        // Handle both full URLs and URLs with query parameters
        const decodedUrl = decodeURIComponent(signedUrl);
        console.log('📥 Downloading signed PDF from:', decodedUrl.substring(0, 150) + '...');
        console.log('📥 Original signedUrl query param length:', signedUrl.length);
        
        const urlObj = new URL(decodedUrl);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        const containerName = pathParts[0];
        const blobName = pathParts.slice(1).join('/');
        
        console.log(`📥 Parsed - Container: ${containerName}, Blob: ${blobName}`);
        console.log(`📥 Full blob path: ${containerName}/${blobName}`);
        
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        // Check if blob exists
        const exists = await blockBlobClient.exists();
        if (!exists) {
          console.error(`❌ Signed PDF not found at ${containerName}/${blobName}`);
          throw new Error(`Signed PDF not found at ${containerName}/${blobName}`);
        }
        
        pdfBuffer = await blockBlobClient.downloadToBuffer();
        console.log(`✅ Downloaded signed PDF from ${containerName}/${blobName}, size: ${pdfBuffer.length} bytes`);
        
        // Verify the PDF has content (basic check)
        if (pdfBuffer.length < 1000) {
          console.warn('⚠️ Downloaded PDF seems too small, might be corrupted');
        }
        
        // Verify it's a valid PDF by checking the header
        const pdfHeader = pdfBuffer.slice(0, 4);
        const isValidPDF = pdfHeader[0] === 0x25 && pdfHeader[1] === 0x50 && pdfHeader[2] === 0x44 && pdfHeader[3] === 0x46; // %PDF
        if (!isValidPDF) {
          console.error('❌ Downloaded PDF does not have valid PDF header!');
          throw new Error('Downloaded PDF is corrupted - invalid header');
        }
        console.log('✅ Downloaded PDF header validated - document is valid');
      } catch (signedErr) {
        console.error('❌ Error downloading signed PDF:', signedErr);
        console.error('❌ Error details:', {
          message: signedErr.message,
          stack: signedErr.stack
        });
        // Don't fallback - throw error so user knows something is wrong
        return res.status(404).json({
          success: false,
          message: 'Signed PDF not found or could not be downloaded',
          error: {
            message: signedErr.message,
            code: 'SIGNED_PDF_NOT_FOUND'
          }
        });
      }
    } else {
      // signedUrl is REQUIRED - do not fallback to original document
      console.error('❌ Proxy endpoint called without signedUrl parameter. Cannot retrieve signed document.');
      return res.status(400).json({
        success: false,
        message: 'Signed document URL is required for proxy download.',
        error: {
          message: 'Missing signedUrl parameter',
          code: 'MISSING_SIGNED_URL'
        }
      });
    }
    
    // Set appropriate headers for PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
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
 * POST /api/document-signatures/apply
 * Apply signatures to PDF and return signed PDF URL
 * Authorization: Public (for group onboarding) or authenticated users
 */
router.post('/apply', async (req, res) => {
  try {
    console.log('🚀 ========== APPLY SIGNATURES ENDPOINT CALLED ==========');
    console.log('📥 Request body keys:', Object.keys(req.body));
    const { documentId, signatureData, autoFillData } = req.body;
    
    console.log('📋 Document ID:', documentId);
    console.log('📋 Signature data keys:', signatureData ? Object.keys(signatureData) : 'none');
    console.log('📋 Auto-fill data:', autoFillData);
    console.log('📋 Signature data sample:', signatureData ? Object.keys(signatureData).slice(0, 3).map(k => `${k}: ${typeof signatureData[k] === 'string' ? signatureData[k].substring(0, 50) : 'object'}`) : 'none');
    
    if (!documentId) {
      console.error('❌ Document ID is missing');
      return res.status(400).json({
        success: false,
        message: 'Document ID is required'
      });
    }
    
    if (!signatureData || typeof signatureData !== 'object') {
      console.error('❌ Signature data is missing or invalid');
      return res.status(400).json({
        success: false,
        message: 'Signature data is required'
      });
    }
    
    // Validate ESIGN compliance
    const compliance = DocumentSignatureService.validateESIGNCompliance({
      consentToElectronicSignature: req.body.consentToElectronicSignature,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'] || 'Unknown',
      signedDate: new Date().toISOString()
    });
    
    if (!compliance.isValid) {
      return res.status(400).json({
        success: false,
        message: 'ESIGN Act compliance validation failed',
        errors: compliance.errors
      });
    }
    
    // Get document to get file name
    console.log('📄 Fetching document from database...');
    const document = await DocumentSignatureService.getDocument(documentId);
    console.log('✅ Document found:', document.FileName);
    
    // Apply signatures to PDF
    console.log('🖊️ Starting to apply signatures to PDF...');
    console.log(`📊 Template fields to process: Will fetch template for document ${documentId}`);
    const signedPdfBuffer = await DocumentSignatureService.applySignaturesToPDF(
      documentId,
      signatureData,
      autoFillData || {}
    );
    console.log(`✅ PDF processing complete, buffer size: ${signedPdfBuffer.length} bytes`);
    
    // Upload signed PDF
    console.log('📤 Uploading signed PDF to Azure...');
    const signedPdfUrl = await DocumentSignatureService.uploadSignedPDF(
      signedPdfBuffer,
      document.FileName || 'signed-document.pdf',
      'agreements',
      `signed-documents/${documentId}/${Date.now()}_signed.pdf`
    );
    console.log('✅ Signed PDF uploaded, URL:', signedPdfUrl);
    
    // Generate authenticated URL for the signed document
    const { generateAuthenticatedUrl } = require('./uploads');
    let authenticatedSignedUrl = signedPdfUrl;
    try {
      authenticatedSignedUrl = await generateAuthenticatedUrl(signedPdfUrl);
    } catch (authError) {
      console.warn('⚠️ Failed to authenticate signed PDF URL, using original:', authError.message);
    }
    
    console.log('✅ ========== SIGNATURES APPLIED SUCCESSFULLY ==========');
    console.log('📤 Returning signed document URL:', authenticatedSignedUrl);
    
    res.json({
      success: true,
      data: {
        signedDocumentUrl: authenticatedSignedUrl,
        documentId: documentId
      },
      message: 'Signatures applied successfully'
    });
  } catch (error) {
    console.error('❌ ========== ERROR APPLYING SIGNATURES ==========');
    console.error('❌ Error applying signatures:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to apply signatures',
      error: {
        message: error.message,
        code: 'SIGNATURE_APPLY_ERROR'
      }
    });
  }
});

module.exports = router;

