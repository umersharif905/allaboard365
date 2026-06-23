// File: backend/routes/public/sign-acknowledgements.js
// Public route for signing acknowledgements via email/SMS link

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');

/**
 * @route   GET /public/sign-acknowledgements/:token
 * @desc    Get acknowledgement data for signing (public access)
 * @access  Public
 */
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token is required'
      });
    }

    const pool = await getPool();
    
    // Get acknowledgement token data
    const tokenQuery = `
      SELECT 
        at.AcknowledgementTokenId,
        at.LinkToken,
        at.MemberId,
        at.Token,
        at.Email,
        at.Phone,
        at.DeliveryMethod,
        at.Status,
        at.SelectedProducts,
        at.SignedData,
        at.SignedDate,
        at.FirstName,
        at.LastName,
        at.DateOfBirth,
        at.ExpiresAt,
        at.CreatedDate
      FROM oe.AcknowledgementTokens at
      WHERE at.Token = @token
    `;
    
    const tokenRequest = pool.request();
    tokenRequest.input('token', sql.NVarChar, token);
    const tokenResult = await tokenRequest.query(tokenQuery);
    
    if (tokenResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired acknowledgement link'
      });
    }
    
    const acknowledgementToken = tokenResult.recordset[0];
    
    // Check if token has expired
    if (new Date(acknowledgementToken.ExpiresAt) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'This acknowledgement link has expired. Please request a new one.'
      });
    }
    
    // Check if already signed - return success with PDF URL for download
    if (acknowledgementToken.Status === 'Signed' && acknowledgementToken.SignedData) {
      let pdfUrl = null;
      try {
        const signedData = JSON.parse(acknowledgementToken.SignedData);
        pdfUrl = signedData.pdfUrl || null;
      } catch (error) {
        console.error('Error parsing SignedData:', error);
      }
      
      return res.json({
        success: true,
        alreadySigned: true,
        message: 'These acknowledgements have already been signed.',
        data: {
          signedAt: acknowledgementToken.SignedDate,
          pdfUrl: pdfUrl,
          email: acknowledgementToken.Email
        }
      });
    }
    
    // Get selected products from token
    let selectedProducts = [];
    try {
      selectedProducts = JSON.parse(acknowledgementToken.SelectedProducts || '[]');
    } catch (error) {
      console.error('Error parsing SelectedProducts:', error);
    }
    
    // If no products selected, return empty acknowledgements list
    if (!selectedProducts || selectedProducts.length === 0) {
      return res.json({
        success: true,
        data: {
          token: acknowledgementToken.Token,
          linkToken: acknowledgementToken.LinkToken,
          email: acknowledgementToken.Email,
          phone: acknowledgementToken.Phone,
          status: acknowledgementToken.Status,
          expiresAt: acknowledgementToken.ExpiresAt,
          productAcknowledgements: []
        }
      });
    }
    
    // Fetch acknowledgements for selected products AND products included in bundles
    const acknowledgementsQuery = `
      -- Get acknowledgements from directly selected products
      SELECT 
        p.ProductId,
        p.Name AS ProductName,
        p.ProductType,
        p.AcknowledgementQuestions,
        'direct' as SelectionType
      FROM oe.Products p
      WHERE p.ProductId IN (${selectedProducts.map((_, index) => `@product${index}`).join(',')})
        AND p.Status = 'Active'
      
      UNION ALL
      
      -- Get acknowledgements from products included in selected bundles
      SELECT 
        p.ProductId,
        p.Name AS ProductName,
        p.ProductType,
        p.AcknowledgementQuestions,
        'bundle' as SelectionType
      FROM oe.Products p
      INNER JOIN oe.ProductBundles pb ON p.ProductId = pb.IncludedProductId
      WHERE pb.BundleProductId IN (${selectedProducts.map((_, index) => `@product${index}`).join(',')})
        AND p.Status = 'Active'
    `;
    
    const acknowledgementsRequest = pool.request();
    selectedProducts.forEach((id, index) => {
      acknowledgementsRequest.input(`product${index}`, sql.UniqueIdentifier, id);
    });
    
    const acknowledgementsResult = await acknowledgementsRequest.query(acknowledgementsQuery);
    
    // Parse acknowledgements from JSON and group by product
    const productAcknowledgements = [];
    
    acknowledgementsResult.recordset.forEach(row => {
      let acknowledgements = [];
      
      // Parse AcknowledgementQuestions JSON
      if (row.AcknowledgementQuestions) {
        try {
          const questions = JSON.parse(row.AcknowledgementQuestions);
          if (Array.isArray(questions) && questions.length > 0) {
            // Get ALL acknowledgements, not just required ones
            acknowledgements = questions.map(q => ({
              id: q.id || q.questionId,
              question: q.question || q.questionText,
              fieldType: q.fieldType || 'checkbox',
              required: q.required === true || q.required === 'true',
              options: q.options || []
            }));
          }
        } catch (error) {
          console.error('Error parsing AcknowledgementQuestions for product:', row.ProductId, error);
        }
      }
      
      // Only add products that have acknowledgements
      if (acknowledgements.length > 0) {
        productAcknowledgements.push({
          productId: row.ProductId,
          productName: row.ProductName,
          productType: row.ProductType,
          acknowledgements: acknowledgements
        });
      }
    });
    
    console.log('📋 Product acknowledgements found:', {
      selectedProducts,
      totalProducts: acknowledgementsResult.recordset.length,
      productsWithAcknowledgements: productAcknowledgements.length,
      acknowledgements: productAcknowledgements.map(p => ({
        productName: p.productName,
        count: p.acknowledgements.length
      }))
    });
    
    res.json({
      success: true,
      data: {
        token: acknowledgementToken.Token,
        linkToken: acknowledgementToken.LinkToken,
        email: acknowledgementToken.Email,
        phone: acknowledgementToken.Phone,
        status: acknowledgementToken.Status,
        expiresAt: acknowledgementToken.ExpiresAt,
        productAcknowledgements: productAcknowledgements
      }
    });
    
  } catch (error) {
    console.error('Error fetching acknowledgement data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load acknowledgement data',
      error: error.message
    });
  }
});

/**
 * @route   POST /public/sign-acknowledgements/:token
 * @desc    Submit signed acknowledgements (public access)
 * @access  Public
 */
router.post('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { acknowledgementResponses, digitalSignature } = req.body;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token is required'
      });
    }
    
    if (!acknowledgementResponses || !digitalSignature) {
      return res.status(400).json({
        success: false,
        message: 'Acknowledgement responses and digital signature are required'
      });
    }

    const pool = await getPool();
    
    // Get acknowledgement token with SelectedProducts
    const tokenQuery = `
      SELECT 
        at.AcknowledgementTokenId,
        at.LinkToken,
        at.Email,
        at.Phone,
        at.FirstName,
        at.LastName,
        at.DateOfBirth,
        at.Status,
        at.SelectedProducts,
        at.ExpiresAt
      FROM oe.AcknowledgementTokens at
      WHERE at.Token = @token
    `;
    
    const tokenRequest = pool.request();
    tokenRequest.input('token', sql.NVarChar, token);
    const tokenResult = await tokenRequest.query(tokenQuery);
    
    if (tokenResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid acknowledgement link'
      });
    }
    
    const acknowledgementToken = tokenResult.recordset[0];
    
    // Check if token has expired
    if (new Date(acknowledgementToken.ExpiresAt) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'This acknowledgement link has expired'
      });
    }
    
    // Check if already signed
    if (acknowledgementToken.Status === 'Signed') {
      return res.status(400).json({
        success: false,
        message: 'These acknowledgements have already been signed'
      });
    }
    
    // Parse selected products from token
    const selectedProducts = acknowledgementToken.SelectedProducts ? JSON.parse(acknowledgementToken.SelectedProducts) : [];
    
    // Fetch acknowledgements for selected products AND products included in bundles FROM DATABASE
    const acknowledgementsQuery = `
      -- Get acknowledgements from directly selected products
      SELECT 
        p.ProductId,
        p.Name AS ProductName,
        p.ProductType,
        p.AcknowledgementQuestions
      FROM oe.Products p
      WHERE p.ProductId IN (${selectedProducts.map((_, index) => `@product${index}`).join(',')})
        AND p.Status = 'Active'
      
      UNION ALL
      
      -- Get acknowledgements from products included in selected bundles
      SELECT 
        p.ProductId,
        p.Name AS ProductName,
        p.ProductType,
        p.AcknowledgementQuestions
      FROM oe.ProductBundles pb
      INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
      WHERE pb.BundleProductId IN (${selectedProducts.map((_, index) => `@product${index}`).join(',')})
        AND p.Status = 'Active'
    `;
    
    const acknowledgementsRequest = pool.request();
    selectedProducts.forEach((id, index) => {
      acknowledgementsRequest.input(`product${index}`, sql.UniqueIdentifier, id);
    });
    
    const acknowledgementsResult = await acknowledgementsRequest.query(acknowledgementsQuery);
    
    console.log('📋 Fetched acknowledgements from database:', {
      selectedProducts,
      totalProducts: acknowledgementsResult.recordset.length
    });
    
    // Parse acknowledgements and build productAcknowledgements structure
    const productAcknowledgementsMap = new Map();
    
    for (const row of acknowledgementsResult.recordset) {
      let acknowledgements = [];
      
      // Parse AcknowledgementQuestions JSON
      if (row.AcknowledgementQuestions) {
        try {
          const questions = JSON.parse(row.AcknowledgementQuestions);
          if (Array.isArray(questions)) {
            acknowledgements = questions.map(q => ({
              id: q.id || q.questionId,
              question: q.question || q.questionText,
              fieldType: q.fieldType || 'checkbox',
              required: q.required || false,
              options: q.options || []
            }));
          }
        } catch (error) {
          console.error('Error parsing AcknowledgementQuestions for product:', row.ProductId, error);
        }
      }
      
      if (acknowledgements.length > 0) {
        productAcknowledgementsMap.set(row.ProductId, {
          productId: row.ProductId,
          productName: row.ProductName,
          productType: row.ProductType,
          acknowledgements: acknowledgements
        });
      }
    }
    
    const productAcknowledgements = Array.from(productAcknowledgementsMap.values());
    
    console.log('📋 Built productAcknowledgements from database:', {
      totalProducts: productAcknowledgements.length,
      products: productAcknowledgements.map(p => ({ name: p.productName, ackCount: p.acknowledgements.length }))
    });
    
    // Capture IP address from request headers (more secure than client-provided)
    const ipAddress = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    
    // Generate PDF for signed acknowledgements (for compliance)
    const { generateAgreementsPDF } = require('../../utils/pdfGenerator');
    
    // Convert acknowledgementResponses to format expected by PDF generator
    // Enrich with question text from database
    const acknowledgementsForPDF = acknowledgementResponses.map(resp => {
      // Find the corresponding question text from database
      let questionText = 'Unknown question';
      const product = productAcknowledgements.find(p => p.productId === resp.productId);
      if (product && product.acknowledgements) {
        const ack = product.acknowledgements.find(a => a.id === resp.questionId);
        if (ack) {
          questionText = ack.question;
        }
      }
      
      return {
        questionId: resp.questionId,
        productId: resp.productId,
        response: resp.response,
        fieldType: resp.fieldType,
        question: questionText // Add question text for PDF
      };
    });
    
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]; // Safe filename timestamp
    
    // Get ALL products (not just ones with acknowledgements) for the product list
    // This includes bundle sub-products
    const allProductsQuery = `
      -- Get directly selected products
      SELECT 
        p.ProductId,
        p.Name AS ProductName,
        p.ProductType
      FROM oe.Products p
      WHERE p.ProductId IN (${selectedProducts.map((_, index) => `@allprod${index}`).join(',')})
        AND p.Status = 'Active'
      
      UNION
      
      -- Get products included in selected bundles
      SELECT 
        p.ProductId,
        p.Name AS ProductName,
        p.ProductType
      FROM oe.ProductBundles pb
      INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
      WHERE pb.BundleProductId IN (${selectedProducts.map((_, index) => `@allprod${index}`).join(',')})
        AND p.Status = 'Active'
    `;
    
    const allProductsRequest = pool.request();
    selectedProducts.forEach((id, index) => {
      allProductsRequest.input(`allprod${index}`, sql.UniqueIdentifier, id);
    });
    
    const allProductsResult = await allProductsRequest.query(allProductsQuery);
    
    // Build product selections from ALL products
    const productSelections = allProductsResult.recordset.map(p => ({
      productId: p.ProductId,
      productName: p.ProductName,
      productType: p.ProductType
    }));
    
    // Build member info from token
    const memberInfo = {
      email: acknowledgementToken.Email,
      phone: acknowledgementToken.Phone,
      firstName: acknowledgementToken.FirstName || 'Not provided',
      lastName: acknowledgementToken.LastName || 'Not provided',
      dateOfBirth: acknowledgementToken.DateOfBirth ? new Date(acknowledgementToken.DateOfBirth).toLocaleDateString() : 'Not provided'
    };
    
    console.log('📄 Generating acknowledgements PDF...');
    console.log('📋 Data for PDF:', {
      acknowledgementsCount: acknowledgementsForPDF.length,
      acknowledgements: acknowledgementsForPDF.map(a => ({ question: a.question, response: a.response })),
      productSelections
    });
    
    // Pass the flat array of acknowledgements directly (not wrapped)
    const pdfBase64 = await generateAgreementsPDF(
      acknowledgementsForPDF,
      digitalSignature,
      memberInfo,
      productSelections
    );
    
    // Convert base64 to Buffer for Azure upload
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    
    // Create a file object for Azure upload
    const fileObject = {
      buffer: pdfBuffer,
      originalname: `acknowledgements-${timestamp}.pdf`,
      mimetype: 'application/pdf',
      size: pdfBuffer.length
    };
    
    console.log('📤 Uploading PDF to Azure...');
    const { uploadToAzureBlob, generateAuthenticatedUrl } = require('../uploads');
    const fileName = `acknowledgements-${acknowledgementToken.AcknowledgementTokenId}-${timestamp}.pdf`;
    const containerName = 'agreements';
    
    let pdfUrl = await uploadToAzureBlob(fileObject, containerName, fileName);
    
    // Authenticate the PDF URL
    try {
      pdfUrl = await generateAuthenticatedUrl(pdfUrl);
      console.log('✅ PDF URL authenticated successfully!');
    } catch (authError) {
      console.error('❌ Failed to authenticate PDF URL:', authError);
    }
    
    console.log('✅ PDF generated and uploaded:', pdfUrl);
    
    // Get tenant ID from enrollment link
    const tenantQuery = `
      SELECT elt.TenantId
      FROM oe.EnrollmentLinks el
      INNER JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      WHERE el.LinkToken = @linkToken
    `;
    const tenantRequest = pool.request();
    tenantRequest.input('linkToken', sql.NVarChar, acknowledgementToken.LinkToken);
    const tenantResult = await tenantRequest.query(tenantQuery);
    const tenantId = tenantResult.recordset[0]?.TenantId || '00000000-0000-0000-0000-000000000000';
    
    // Save PDF to FileUploads table
    const fileUploadId = require('crypto').randomUUID();
    const systemUserId = '25E60878-F294-47D5-8C0F-D1674E4893AE'; // System admin user for public uploads
    
    const fileUploadQuery = `
      INSERT INTO oe.FileUploads (
        FileId, EntityId, FileName, StoredFileName, FilePath, FileSize, MimeType,
        UploadType, UploadedBy, TenantId, Status, CreatedDate
      ) VALUES (
        @fileId, @entityId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
        @uploadType, @uploadedBy, @tenantId, @status, @createdDate
      )
    `;
    
    const fileUploadRequest = pool.request();
    fileUploadRequest.input('fileId', sql.UniqueIdentifier, fileUploadId);
    fileUploadRequest.input('entityId', sql.NVarChar, acknowledgementToken.AcknowledgementTokenId); // EntityId is nvarchar!
    fileUploadRequest.input('fileName', sql.NVarChar, fileName);
    fileUploadRequest.input('storedFileName', sql.NVarChar, fileName);
    fileUploadRequest.input('filePath', sql.NVarChar, pdfUrl);
    fileUploadRequest.input('fileSize', sql.Int, pdfBuffer.length);
    fileUploadRequest.input('mimeType', sql.NVarChar, 'application/pdf');
    fileUploadRequest.input('uploadType', sql.NVarChar, 'Agreement');
    fileUploadRequest.input('uploadedBy', sql.UniqueIdentifier, systemUserId);
    fileUploadRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    fileUploadRequest.input('status', sql.NVarChar, 'Active');
    fileUploadRequest.input('createdDate', sql.DateTime2, new Date());
    
    await fileUploadRequest.query(fileUploadQuery);
    console.log('✅ PDF saved to FileUploads table with ID:', fileUploadId);
    
    // Update acknowledgement token with signed data AND PDF URL
    const updateRequest = pool.request();
    updateRequest.input('acknowledgementTokenId', sql.UniqueIdentifier, acknowledgementToken.AcknowledgementTokenId);
    updateRequest.input('signedData', sql.NVarChar, JSON.stringify({
      responses: acknowledgementResponses,
      digitalSignature,
      signedAt: new Date().toISOString(),
      pdfUrl: pdfUrl, // Store PDF URL in signed data
      fileUploadId: fileUploadId
    }));
    updateRequest.input('signedDate', sql.DateTime2, new Date());
    updateRequest.input('ipAddress', sql.NVarChar, ipAddress);
    updateRequest.input('userAgent', sql.NVarChar, userAgent);
    updateRequest.input('status', sql.NVarChar, 'Signed');
    updateRequest.input('modifiedDate', sql.DateTime2, new Date());
    
    await updateRequest.query(`
      UPDATE oe.AcknowledgementTokens
      SET SignedData = @signedData,
          SignedDate = @signedDate,
          IpAddress = @ipAddress,
          UserAgent = @userAgent,
          Status = @status,
          ModifiedDate = @modifiedDate
      WHERE AcknowledgementTokenId = @acknowledgementTokenId
    `);
    
    console.log(`✅ Acknowledgements signed via token: ${token} from IP: ${ipAddress}`);
    
    res.json({
      success: true,
      message: 'Acknowledgements signed successfully',
      data: {
        signedAt: new Date().toISOString(),
        pdfUrl: pdfUrl // Return PDF URL for download
      }
    });
    
  } catch (error) {
    console.error('Error signing acknowledgements:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save acknowledgements',
      error: error.message
    });
  }
});

module.exports = router;

