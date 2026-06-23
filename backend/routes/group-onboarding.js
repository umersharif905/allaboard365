const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const DimeService = require('../services/dimeService');
const dimeCardBrand = require('../services/dimeCardBrand');
const PaymentMethodService = require('../services/PaymentMethodService');
const UserRolesService = require('../services/shared/user-roles.service');

// GET /api/group-onboarding/:linkToken/group-data - Get group onboarding data including ASA requirements
router.get('/:linkToken/group-data', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const pool = await getPool();
    
        console.log('🔍 Fetching group onboarding data for linkToken:', linkToken);

        // Get group and tenant information with link status details (including payment info from GroupPaymentMethods)
        const groupQuery = `
      SELECT
        gol.GroupId,
        g.TenantId,
        g.GroupType,
        gol.Status as LinkStatus,
        gol.ExpiresAt,
        gol.UsedDate,
        gol.CreatedDate,
        g.Name as GroupName,
        g.PrimaryContact,
        g.ContactEmail,
        g.ContactPhone,
        g.Address,
        g.City,
        g.State,
        g.Zip,
        g.TaxIdNumber,
        g.BusinessType,
        g.LogoUrl as GroupLogoUrl,
        g.AgentId,
        t.Name as TenantName,
        t.CustomLogoUrl as TenantLogoUrl,
        CASE
          WHEN a.AgentId IS NOT NULL THEN CONCAT(agent_user.FirstName, ' ', agent_user.LastName)
          ELSE NULL
        END as AgentName
      FROM oe.GroupOnboardingLinks gol
      INNER JOIN oe.Groups g ON gol.GroupId = g.GroupId
      INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
      LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
      LEFT JOIN oe.Users agent_user ON a.UserId = agent_user.UserId
      WHERE gol.LinkToken = @linkToken 
    `;
    
        const groupRequest = pool.request();
        groupRequest.input('linkToken', sql.NVarChar, linkToken);
        const groupResult = await groupRequest.query(groupQuery);
    
        if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group onboarding link not found',
        linkStatus: 'not_found'
      });
        }

        const groupData = groupResult.recordset[0];
        
        // Get existing payment methods from GroupPaymentMethods table
        const paymentMethodsQuery = `
          SELECT 
            Type,
            BankName,
            AccountNumberLast4,
            CardBrand,
            CardLast4,
            IsDefault,
            Status
          FROM oe.GroupPaymentMethods
          WHERE GroupId = @groupId AND Status = 'Active'
        `;
        
        const paymentMethodsRequest = pool.request();
        paymentMethodsRequest.input('groupId', sql.UniqueIdentifier, groupData.GroupId);
        const paymentMethodsResult = await paymentMethodsRequest.query(paymentMethodsQuery);
        
        // Process payment methods to extract ACH and Credit Card info
        const paymentMethods = paymentMethodsResult.recordset;
        let achInfo = null;
        let creditCardInfo = null;
        
        paymentMethods.forEach(pm => {
          if (pm.Type === 'ACH') {
            achInfo = {
              bankName: pm.BankName,
              accountLast4: pm.AccountNumberLast4,
              isDefault: pm.IsDefault
            };
          } else if (pm.Type === 'CreditCard') {
            creditCardInfo = {
              cardBrand: pm.CardBrand,
              cardLast4: pm.CardLast4,
              isDefault: pm.IsDefault
            };
          }
        });
        
        // Check link status and expiration
        const now = new Date();
        const expiresAt = new Date(groupData.ExpiresAt);
        const isExpired = expiresAt < now;
        const isUsed = groupData.UsedDate !== null;
        const linkStatus = groupData.LinkStatus;
        
        console.log('🔍 Link status check:', {
          linkStatus,
          isExpired,
          isUsed,
          expiresAt: expiresAt.toISOString(),
          usedDate: groupData.UsedDate,
          now: now.toISOString()
        });
        
        // Return appropriate status based on link state
        if (isUsed) {
          return res.json({
            success: true,
            linkStatus: 'used',
            data: {
              groupId: groupData.GroupId,
              groupName: groupData.GroupName,
              tenantId: groupData.TenantId,
              tenantName: groupData.TenantName,
              tenantLogoUrl: groupData.TenantLogoUrl,
              groupLogoUrl: groupData.GroupLogoUrl,
              usedDate: groupData.UsedDate,
              message: 'This onboarding link has already been used'
            }
          });
        }
        
        if (isExpired) {
          return res.json({
            success: true,
            linkStatus: 'expired',
            data: {
              groupId: groupData.GroupId,
              groupName: groupData.GroupName,
              tenantId: groupData.TenantId,
              tenantName: groupData.TenantName,
              tenantLogoUrl: groupData.TenantLogoUrl,
              groupLogoUrl: groupData.GroupLogoUrl,
              expiresAt: groupData.ExpiresAt,
              message: 'This onboarding link has expired'
            }
          });
        }
        
        if (linkStatus === 'InProgress') {
          // Prepare current data for pre-filling forms (same as active status, including payment info from GroupPaymentMethods)
          const currentData = {
            name: groupData.GroupName || '',
            primaryContact: groupData.PrimaryContact || '',
            contactEmail: groupData.ContactEmail || '',
            contactPhone: groupData.ContactPhone || '',
            address: groupData.Address || '',
            city: groupData.City || '',
            state: groupData.State || '',
            zip: groupData.Zip || '',
            taxIdNumber: groupData.TaxIdNumber || '',
            businessType: groupData.BusinessType || '',
            // Payment information from GroupPaymentMethods table (last 4 digits only for security)
            creditCardNumber: creditCardInfo?.cardLast4 || '',
            creditCardType: creditCardInfo?.cardBrand || '',
            achBankName: achInfo?.bankName || '',
            achAccountNumber: achInfo?.accountLast4 || ''
          };
          
          return res.json({
            success: true,
            linkStatus: 'in_progress',
            data: {
              groupId: groupData.GroupId,
              groupName: groupData.GroupName,
              tenantId: groupData.TenantId,
              tenantName: groupData.TenantName,
              tenantLogoUrl: groupData.TenantLogoUrl,
              groupLogoUrl: groupData.GroupLogoUrl,
              agentName: groupData.AgentName || null,
              currentData,
              message: 'Onboarding is in progress - password setup needed'
            }
          });
        }
        
        if (linkStatus !== 'Active') {
          return res.json({
            success: true,
            linkStatus: 'inactive',
            data: {
              groupId: groupData.GroupId,
              groupName: groupData.GroupName,
              tenantId: groupData.TenantId,
              tenantName: groupData.TenantName,
              tenantLogoUrl: groupData.TenantLogoUrl,
              groupLogoUrl: groupData.GroupLogoUrl,
              message: 'This onboarding link is not active'
            }
          });
        }

        // Check if any products require ASA agreements
        const asaQuery = `
            SELECT TOP 1 p.RequiredASA, p.ProductId
            FROM oe.GroupOnboardingLinks gol
            INNER JOIN oe.Groups g ON gol.GroupId = g.GroupId
            INNER JOIN oe.GroupProducts gp ON g.GroupId = gp.GroupId
            INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
            WHERE gol.LinkToken = @linkToken
            AND p.RequiredASA IS NOT NULL
            AND p.RequiredASA != ''
        `;
        
        const asaRequest = pool.request();
        asaRequest.input('linkToken', sql.NVarChar, linkToken);
        const asaResult = await asaRequest.query(asaQuery);
        
        let requiresASA = false;
        let asaAgreement = null;

        // List-Bill groups never require an ASA — members enroll on individual policies.
        const isListBillGroup = groupData.GroupType === 'ListBill';

        if (!isListBillGroup && asaResult.recordset.length > 0) {
            const asaData = asaResult.recordset[0].RequiredASA;
            const productId = asaResult.recordset[0].ProductId;
            try {
                asaAgreement = typeof asaData === 'string' ? JSON.parse(asaData) : asaData;
                // Add the productId to the ASA agreement data
                asaAgreement.productId = productId;
                
                // Authenticate the document URL before returning it
                // Follow the same pattern as public/onboarding.js - construct blob path from StoredFileName and TenantId
                // Get the document metadata from FileUploads table to construct the correct blob path
                if (asaAgreement.documentId) {
                    try {
                        const fileQuery = `
                            SELECT StoredFileName, TenantId, FilePath
                            FROM oe.FileUploads
                            WHERE FileId = @documentId AND Status = 'Active'
                        `;
                        const fileRequest = pool.request();
                        fileRequest.input('documentId', sql.UniqueIdentifier, asaAgreement.documentId);
                        const fileResult = await fileRequest.query(fileQuery);
                        
                        if (fileResult.recordset.length > 0) {
                            const fileData = fileResult.recordset[0];
                            
                            // Extract blob name from FilePath if available, otherwise construct it
                            // The FilePath in database might be the actual blob URL, so parse it first
                            let blobName = null;
                            const containerName = 'agreements';
                            
                            // Try multiple blob paths since the FilePath in DB might be wrong
                            // Based on upload code, agent agreements should be at: agent-agreements/{tenantId}/{StoredFileName}
                            // But FilePath might be stored incorrectly as root path
                            const blobPathsToTry = [];
                            
                            if (fileData.FilePath) {
                                try {
                                    // Extract blob name from FilePath URL (most reliable)
                                    const url = new URL(fileData.FilePath);
                                    const pathParts = url.pathname.split('/').filter(p => p);
                                    const containerIndex = pathParts.indexOf('agreements');
                                    if (containerIndex >= 0 && containerIndex < pathParts.length - 1) {
                                        const extractedBlobName = pathParts.slice(containerIndex + 1).join('/').split('?')[0];
                                        if (extractedBlobName && !blobPathsToTry.includes(extractedBlobName)) {
                                            blobPathsToTry.push(extractedBlobName);
                                        }
                                    }
                                } catch (urlError) {
                                    console.warn('⚠️ Could not parse FilePath URL:', urlError.message);
                                }
                            }
                            
                            // Try root path in agreements container (common case)
                            if (fileData.StoredFileName) {
                                blobPathsToTry.push(fileData.StoredFileName);
                            }
                            
                            // Try agent-agreements path if we have TenantId
                            if (fileData.StoredFileName && fileData.TenantId) {
                                const agentAgreementPath = `agent-agreements/${fileData.TenantId}/${fileData.StoredFileName}`;
                                if (!blobPathsToTry.includes(agentAgreementPath)) {
                                    blobPathsToTry.push(agentAgreementPath);
                                }
                            }
                            
                            // Try each blob path until we find one that exists
                            let authenticatedUrl = null;
                            for (const blobPathToTry of blobPathsToTry) {
                                try {
                                    // Check if blob exists
                                    const { BlobServiceClient } = require('@azure/storage-blob');
                                    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
                                    if (connectionString) {
                                        const blobServiceClient = require('@azure/storage-blob').BlobServiceClient.fromConnectionString(connectionString);
                                        const containerClient = blobServiceClient.getContainerClient(containerName);
                                        const blockBlobClient = containerClient.getBlockBlobClient(blobPathToTry);
                                        const exists = await blockBlobClient.exists();
                                        
                                        if (exists) {
                                            // Generate SAS URL for this blob path
                                            const { generateSASUrl } = require('./uploads');
                                            authenticatedUrl = generateSASUrl(containerName, blobPathToTry, 'r', 60);
                                            console.log('✅ Found blob at path and generated authenticated URL:', {
                                                documentId: asaAgreement.documentId,
                                                blobPath: blobPathToTry,
                                                authenticatedUrl: authenticatedUrl.substring(0, 100) + '...'
                                            });
                                            break; // Found it, stop trying
                                        } else {
                                            console.warn(`⚠️ Blob does not exist at path: ${blobPathToTry}`);
                                        }
                                    }
                                } catch (checkError) {
                                    console.warn(`⚠️ Error checking blob at path ${blobPathToTry}:`, checkError.message);
                                }
                            }
                            
                            if (authenticatedUrl) {
                                asaAgreement.documentUrl = authenticatedUrl;
                            } else {
                                // None of the blob paths exist - this means the blob was never uploaded or was deleted
                                console.error('❌ Blob does not exist at any of the tried paths:', blobPathsToTry);
                                console.error('   This document may need to be reuploaded.');
                                // Fallback: try to authenticate FilePath even though blob might not exist
                                if (fileData.FilePath) {
                                    try {
                                        const { generateAuthenticatedUrl, isBlobUrl } = require('./uploads');
                                        if (isBlobUrl(fileData.FilePath)) {
                                            asaAgreement.documentUrl = await generateAuthenticatedUrl(fileData.FilePath);
                                            console.log('⚠️ Using FilePath fallback (blob may not exist)');
                                        } else {
                                            asaAgreement.documentUrl = fileData.FilePath;
                                        }
                                    } catch (fallbackError) {
                                        asaAgreement.documentUrl = fileData.FilePath || asaAgreement.documentUrl;
                                    }
                                }
                            }
                        } else {
                            console.warn('⚠️ Document not found in FileUploads, using documentUrl from RequiredASA');
                            // Fallback: try to authenticate the existing documentUrl
                            if (asaAgreement.documentUrl) {
                                try {
                                    const { generateAuthenticatedUrl, isBlobUrl } = require('./uploads');
                                    if (isBlobUrl(asaAgreement.documentUrl)) {
                                        asaAgreement.documentUrl = await generateAuthenticatedUrl(asaAgreement.documentUrl);
                                        console.log('🔐 Authenticated ASA document URL (fallback)');
                                    }
                                } catch (authError) {
                                    console.warn('❌ Failed to authenticate ASA document URL:', authError.message);
                                }
                            }
                        }
                    } catch (fileError) {
                        console.warn('⚠️ Error querying FileUploads, using documentUrl from RequiredASA:', fileError.message);
                        // Fallback: try to authenticate the existing documentUrl
                        if (asaAgreement.documentUrl) {
                            try {
                                const { generateAuthenticatedUrl, isBlobUrl } = require('./uploads');
                                if (isBlobUrl(asaAgreement.documentUrl)) {
                                    asaAgreement.documentUrl = await generateAuthenticatedUrl(asaAgreement.documentUrl);
                                    console.log('🔐 Authenticated ASA document URL (fallback)');
                                }
                            } catch (authError) {
                                console.warn('❌ Failed to authenticate ASA document URL:', authError.message);
                            }
                        }
                    }
                } else if (asaAgreement.documentUrl) {
                    // If no documentId, try to authenticate the existing documentUrl
                    try {
                        const { generateAuthenticatedUrl, isBlobUrl } = require('./uploads');
                        if (isBlobUrl(asaAgreement.documentUrl)) {
                            asaAgreement.documentUrl = await generateAuthenticatedUrl(asaAgreement.documentUrl);
                            console.log('🔐 Authenticated ASA document URL (no documentId)');
                        }
                    } catch (authError) {
                        console.warn('❌ Failed to authenticate ASA document URL:', authError.message);
                    }
                }
                
                requiresASA = true;
                console.log('✅ Found ASA agreement requirement:', asaAgreement);
            } catch (error) {
                console.error('❌ Error parsing ASA agreement data:', error);
                requiresASA = false;
                asaAgreement = null;
            }
        }

        // Prepare current data for pre-filling forms (including payment info from GroupPaymentMethods)
        const currentData = {
            name: groupData.GroupName || '',
            primaryContact: groupData.PrimaryContact || '',
            contactEmail: groupData.ContactEmail || '',
            contactPhone: groupData.ContactPhone || '',
            address: groupData.Address || '',
            city: groupData.City || '',
            state: groupData.State || '',
            zip: groupData.Zip || '',
            taxIdNumber: groupData.TaxIdNumber || '',
            businessType: groupData.BusinessType || '',
            // Payment information from GroupPaymentMethods table (last 4 digits only for security)
            creditCardNumber: creditCardInfo?.cardLast4 || '',
            creditCardType: creditCardInfo?.cardBrand || '',
            achBankName: achInfo?.bankName || '',
            achAccountNumber: achInfo?.accountLast4 || ''
    };
    
    res.json({
      success: true,
      linkStatus: 'active',
      data: {
        groupId: groupData.GroupId,
        groupName: groupData.GroupName,
        tenantId: groupData.TenantId,
        tenantName: groupData.TenantName,
        tenantLogoUrl: groupData.TenantLogoUrl,
        groupLogoUrl: groupData.GroupLogoUrl,
        agentName: groupData.AgentName || null,
        currentData,
        isComplete: false,
        requiresASA,
        asaAgreement
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching group onboarding data:', error);
    res.status(500).json({
      success: false,
            message: 'Server error while fetching onboarding data'
    });
  }
});

// GET /api/group-onboarding/:linkToken/status - Check if onboarding is completed
router.get('/:linkToken/status', async (req, res) => {
  try {
    const { linkToken } = req.params;
    
    if (!linkToken) {
      return res.status(400).json({
        success: false,
        message: 'Link token is required'
      });
    }

    const pool = await getPool();
    
    // Check if the onboarding link exists and is used
    const statusQuery = `
      SELECT 
        gol.Status,
        gol.UsedDate,
        gol.UsedBy,
        u.Email as UserEmail
      FROM oe.GroupOnboardingLinks gol
      LEFT JOIN oe.Users u ON gol.UsedBy = u.UserId
      WHERE gol.LinkToken = @linkToken
    `;
    
    const statusRequest = pool.request();
    statusRequest.input('linkToken', sql.NVarChar, linkToken);
    const statusResult = await statusRequest.query(statusQuery);
    
    if (statusResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Onboarding link not found'
      });
    }
    
    const linkData = statusResult.recordset[0];
    const isCompleted = linkData.Status === 'Used';
    const isInProgress = linkData.Status === 'InProgress';
    
    res.json({
      success: true,
      data: {
        isCompleted,
        isInProgress,
        status: linkData.Status,
        usedDate: linkData.UsedDate,
        usedBy: linkData.UserEmail
      }
    });
    
  } catch (error) {
    console.error('❌ Error checking onboarding status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking onboarding status'
    });
  }
});

// POST /api/group-onboarding/sign-asa - Save ASA signature and generate signed document
router.post('/sign-asa', async (req, res) => {
    try {
        const { linkToken, productId, signatureData, signerName, signerEmail, signedDocumentUrl } = req.body;

        console.log('📝 ASA Signature submission:', {
            linkToken,
            productId,
            signerName,
            signerEmail,
            hasSignature: !!signatureData,
            isTemplateBased: signatureData === 'template-based',
            hasSignedDocumentUrl: !!signedDocumentUrl
        });

        // Validate required fields
        if (!linkToken || !productId || !signerName || !signerEmail) {
            return res.status(400).json({
                success: false,
                message: 'Link token, product ID, signer name, and email are required'
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
    
        // Get group onboarding data to find group and vendor info
        const groupQuery = `
            SELECT 
                gol.GroupId,
                g.TenantId,
                g.Name as GroupName,
                p.VendorId,
                p.RequiredASA
        FROM oe.GroupOnboardingLinks gol
            INNER JOIN oe.Groups g ON gol.GroupId = g.GroupId
            INNER JOIN oe.GroupProducts gp ON g.GroupId = gp.GroupId
            INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
        WHERE gol.LinkToken = @linkToken 
                AND p.ProductId = @productId
                AND p.RequiredASA IS NOT NULL 
                AND p.RequiredASA != ''
      `;
      
        const groupRequest = pool.request();
        groupRequest.input('linkToken', sql.NVarChar, linkToken);
        groupRequest.input('productId', sql.UniqueIdentifier, productId);
      
        const groupResult = await groupRequest.query(groupQuery);
      
        if (groupResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
                message: 'Group onboarding link or product not found, or product does not require ASA'
            });
        }

        const groupData = groupResult.recordset[0];

        // Parse the RequiredASA data to get document info
        let asaData;
        try {
            asaData = typeof groupData.RequiredASA === 'string' ? JSON.parse(groupData.RequiredASA) : groupData.RequiredASA;
        } catch (error) {
            console.error('❌ Error parsing RequiredASA data:', error);
            return res.status(400).json({
                success: false,
                message: 'Invalid ASA agreement data'
            });
        }

        if (!asaData || !asaData.documentUrl) {
            return res.status(404).json({
                success: false,
                message: 'No ASA agreement document URL found'
            });
        }

        // Get document metadata from FileUploads table to get correct blob path
        let vendorDocument = {
            FileId: asaData.documentId,
            FileName: asaData.documentName,
            FilePath: asaData.documentUrl,
            MimeType: 'application/pdf'
        };

        // Try to get the actual blob path from FileUploads table
        if (asaData.documentId) {
            try {
                const fileQuery = `
                    SELECT StoredFileName, FilePath, TenantId, UploadType, FileName
                    FROM oe.FileUploads
                    WHERE FileId = @documentId AND Status = 'Active'
                `;
                const fileRequest = pool.request();
                fileRequest.input('documentId', sql.UniqueIdentifier, asaData.documentId);
                const fileResult = await fileRequest.query(fileQuery);
                
                if (fileResult.recordset.length > 0) {
                    const fileData = fileResult.recordset[0];
                    console.log('📄 Found document in FileUploads:', {
                        documentId: asaData.documentId,
                        storedFileName: fileData.StoredFileName,
                        fileName: fileData.FileName,
                        filePath: fileData.FilePath,
                        tenantId: fileData.TenantId,
                        uploadType: fileData.UploadType
                    });
                    
                    // Use the StoredFileName to construct the correct blob path
                    // Different upload types use different blob path structures:
                    // - agentAgreement: agent-agreements/{tenantId}/{StoredFileName}
                    // - agreements: agent-agreements/{tenantId}/{StoredFileName} (same)
                    // - vendor documents: vendors/{vendorId}/{StoredFileName}
                    if (fileData.StoredFileName && fileData.TenantId) {
                        let blobPath;
                        if (fileData.UploadType === 'agentAgreement' || fileData.UploadType === 'agreements') {
                            blobPath = `agent-agreements/${fileData.TenantId}/${fileData.StoredFileName}`;
                        } else {
                            // For other upload types, try to extract from FilePath or use default structure
                            blobPath = `agent-agreements/${fileData.TenantId}/${fileData.StoredFileName}`;
                        }
                        
                        vendorDocument = {
                            ...vendorDocument,
                            StoredFileName: fileData.StoredFileName,
                            TenantId: fileData.TenantId,
                            BlobPath: blobPath,
                            UploadType: fileData.UploadType
                        };
                        
                        console.log('✅ Constructed blob path from FileUploads:', {
                            blobPath,
                            storedFileName: fileData.StoredFileName,
                            tenantId: fileData.TenantId
                        });
                    } else {
                        console.warn('⚠️ Document found but missing StoredFileName or TenantId:', {
                            hasStoredFileName: !!fileData.StoredFileName,
                            hasTenantId: !!fileData.TenantId,
                            filePath: fileData.FilePath
                        });
                        
                        // Try to extract blob path from FilePath if available
                        if (fileData.FilePath && fileData.FilePath.includes('blob.core.windows.net')) {
                            const urlParts = fileData.FilePath.split('/');
                            const containerIndex = urlParts.findIndex(part => part === 'agreements');
                            if (containerIndex >= 0 && urlParts.length > containerIndex + 1) {
                                const blobPathFromUrl = urlParts.slice(containerIndex + 1).join('/').split('?')[0];
                                vendorDocument.BlobPath = blobPathFromUrl;
                                console.log('✅ Extracted blob path from FilePath:', blobPathFromUrl);
                            }
                        }
                    }
                } else {
                    console.warn('⚠️ Document not found in FileUploads table:', asaData.documentId);
                }
            } catch (fileError) {
                console.warn('⚠️ Could not fetch document from FileUploads, using URL directly:', fileError.message);
                // Continue with URL-based approach
            }
        }

        let baseBlobUrl;
        let fileName;
        let fileSize = 0; // Default file size

        // Handle template-based signing vs basic signing
        if (signatureData === 'template-based' && signedDocumentUrl) {
            // Template-based signing: use the provided signed document URL
            console.log('📝 Using template-based signed document URL');
            baseBlobUrl = signedDocumentUrl.split('?')[0]; // Remove query params for storage
            fileName = `asa-agreement-${groupData.GroupId}-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.pdf`;
            
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
            const signedPdfBase64 = await generateASAAgreementPDF(
                vendorDocument,
                signatureData,
                signerName,
                signerEmail,
                groupData.GroupName
            );

            // Upload signed document to blob storage
            const { uploadToAzureBlob } = require('./uploads');
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
            fileName = `asa-agreement-${groupData.GroupId}-${timestamp}.pdf`;
            
            const fileObject = {
                buffer: Buffer.from(signedPdfBase64, 'base64'),
                originalname: fileName,
                mimetype: 'application/pdf',
                size: Buffer.from(signedPdfBase64, 'base64').length
            };
            
            fileSize = fileObject.size; // Set fileSize for FileUploads entry

            const uploadedUrl = await uploadToAzureBlob(fileObject, 'asa-signatures', fileName);

            // Remove query parameters (SAS token) from uploadedUrl to store base URL only
            // We'll generate fresh SAS tokens on-demand when retrieving/downloading
            const { isBlobUrl } = require('./uploads');
            baseBlobUrl = uploadedUrl;
            if (uploadedUrl && isBlobUrl(uploadedUrl)) {
                // Remove query parameters to get base URL (SAS tokens expire, so we store base URL)
                baseBlobUrl = uploadedUrl.split('?')[0];
                console.log('📄 Storing base blob URL (without SAS token) for signed ASA document');
            }
            
            // Authenticate the signed document URL for SignedASAAgreements table (for immediate download)
            const { generateAuthenticatedUrl } = require('./uploads');
            signedDocumentUrl = uploadedUrl;
            if (uploadedUrl && isBlobUrl(uploadedUrl)) {
                try {
                    signedDocumentUrl = await generateAuthenticatedUrl(uploadedUrl);
                    console.log('🔐 Authenticated signed document URL for SignedASAAgreements table');
                } catch (error) {
                    console.warn('❌ Failed to authenticate signed document URL:', error.message);
                }
            }
        }

        // Capture IP address and user agent from request headers (more secure than client-provided)
        const ipAddress = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || '127.0.0.1';
        const userAgent = req.headers['user-agent'] || 'Unknown';

        // Save to SignedASAAgreements table
        const insertQuery = `
            INSERT INTO oe.SignedASAAgreements 
            (GroupId, ProductId, VendorId, DocumentId, SignatureData, SignedDocumentUrl, 
             SignedByEmail, SignedByName, SignedDate, Status, CreatedDate, ModifiedDate, IpAddress, UserAgent)
            OUTPUT INSERTED.SignedAgreementId
            VALUES 
            (@groupId, @productId, @vendorId, @documentId, @signatureData, @signedDocumentUrl,
             @signedByEmail, @signedByName, @signedDate, @status, @createdDate, @modifiedDate, @ipAddress, @userAgent)
        `;

        const insertRequest = pool.request();
        insertRequest.input('groupId', sql.UniqueIdentifier, groupData.GroupId);
        insertRequest.input('productId', sql.UniqueIdentifier, productId);
        insertRequest.input('vendorId', sql.UniqueIdentifier, groupData.VendorId);
        insertRequest.input('documentId', sql.UniqueIdentifier, vendorDocument.FileId);
        insertRequest.input('signatureData', sql.NVarChar(sql.MAX), signatureData);
        insertRequest.input('signedDocumentUrl', sql.NVarChar(500), signedDocumentUrl);
        insertRequest.input('signedByEmail', sql.NVarChar(255), signerEmail);
        insertRequest.input('signedByName', sql.NVarChar(255), signerName);
        insertRequest.input('signedDate', sql.DateTime2, new Date());
        insertRequest.input('status', sql.NVarChar(50), 'Completed');
        insertRequest.input('createdDate', sql.DateTime2, new Date());
        insertRequest.input('modifiedDate', sql.DateTime2, new Date());
        insertRequest.input('ipAddress', sql.NVarChar(45), ipAddress);
        insertRequest.input('userAgent', sql.NVarChar(500), userAgent);

        const insertResult = await insertRequest.query(insertQuery);
        const signedAgreementId = insertResult.recordset?.[0]?.SignedAgreementId || null;

        // Fire asa_signed vendor scheduled job(s) async. Don't block the client on email send,
        // and don't let a bad trigger run cause the sign-asa endpoint to fail.
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
        
        // Create FileUploads entry for the signed ASA document
        const { v4: uuidv4 } = require('uuid');
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
        
        // Get the product name for the description
        const productQuery = `SELECT Name FROM oe.Products WHERE ProductId = @productId`;
        const productResult = await pool.request()
            .input('productId', sql.UniqueIdentifier, productId)
            .query(productQuery);
        const productName = productResult.recordset[0]?.Name || 'Product';
        
        // Create FileUploads entry for the signed ASA document (required for GroupDocumentsTab)
        // For public routes (group onboarding), UploadedBy can be NULL since there's no authenticated user
        const fileUploadRequest = pool.request();
        fileUploadRequest.input('fileUploadId', sql.UniqueIdentifier, fileUploadId);
        fileUploadRequest.input('fileName', sql.NVarChar, fileName);
        fileUploadRequest.input('storedFileName', sql.NVarChar, storedFileName);
        fileUploadRequest.input('filePath', sql.NVarChar, baseBlobUrl); // Store base URL without SAS token
        fileUploadRequest.input('fileSize', sql.Int, fileSize);
        fileUploadRequest.input('mimeType', sql.NVarChar, 'application/pdf');
        fileUploadRequest.input('uploadType', sql.NVarChar, 'documents');
        fileUploadRequest.input('entityId', sql.NVarChar, groupData.GroupId);
        fileUploadRequest.input('category', sql.NVarChar, 'ASASigned');
        fileUploadRequest.input('description', sql.NVarChar, `Signed ASA Agreement for ${productName}`);
        fileUploadRequest.input('uploadedBy', sql.UniqueIdentifier, null); // NULL for public routes
        fileUploadRequest.input('tenantId', sql.UniqueIdentifier, groupData.TenantId);
        fileUploadRequest.input('status', sql.NVarChar, 'Active');
        fileUploadRequest.input('createdDate', sql.DateTime2, new Date());
        
        await fileUploadRequest.query(insertFileUploadQuery);
        
        console.log('✅ Signed ASA document saved to FileUploads:', {
            fileUploadId,
            fileName,
            groupId: groupData.GroupId,
            productId: productId,
            uploadedBy: null // Public route, no authenticated user
        });

        console.log('✅ ASA agreement signed and saved successfully:', {
            groupId: groupData.GroupId,
            productId: productId,
            signedDocumentUrl: signedDocumentUrl,
            ipAddress: ipAddress
        });
      
      res.json({
        success: true,
            message: 'ASA agreement signed successfully',
        data: {
                signedAgreementId: groupData.GroupId, // Using GroupId as identifier
                signedDocumentUrl: signedDocumentUrl,
                groupId: groupData.GroupId,
                productId: productId
            }
      });
      
    } catch (error) {
        console.error('❌ Error signing ASA agreement:', error);
    res.status(500).json({
      success: false,
            message: 'Failed to sign ASA agreement',
            error: {
                message: error.message,
                code: 'ASA_SIGNATURE_ERROR'
            }
    });
  }
});

// Helper function to generate ASA agreement PDF with original document merged
async function generateASAAgreementPDF(vendorDocument, signatureData, signerName, signerEmail, groupName) {
    try {
        const { PDFDocument } = require('pdf-lib');
        const { BlobServiceClient } = require('@azure/storage-blob');
        
        // Initialize Azure Blob Service Client
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error('Azure Storage connection string not configured');
        }
        
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        
        // Determine the correct blob path
        // Priority: Use BlobPath if available (from FileUploads table), otherwise extract from URL
        let containerName = 'agreements';
        let blobName;
        
        if (vendorDocument.BlobPath) {
            // Use the blob path from FileUploads table (e.g., agent-agreements/{tenantId}/{filename})
            blobName = vendorDocument.BlobPath;
            console.log('📄 Using blob path from FileUploads:', {
                container: containerName,
                blob: blobName
            });
        } else {
            // Extract container and blob name from the FilePath URL
            // FilePath format: https://oestorage.blob.core.windows.net/agreements/filename.pdf?...
            // OR: https://oestorage.blob.core.windows.net/agreements/agent-agreements/{tenantId}/filename.pdf?...
            const urlParts = vendorDocument.FilePath.split('/');
            const urlContainerName = urlParts[3]; // 'agreements'
            if (urlContainerName) {
                containerName = urlContainerName;
            }
            
            // Get everything after the container name as the blob path
            // URL structure: https://oestorage.blob.core.windows.net/agreements/agent-agreements/tenantId/filename.pdf
            if (urlParts.length > 4) {
                const blobPathWithQuery = urlParts.slice(4).join('/'); // Join all parts after container
                blobName = blobPathWithQuery.split('?')[0]; // Remove query parameters (SAS token)
            } else {
                // Fallback: try to get from last part of URL
                const blobNameWithQuery = urlParts[urlParts.length - 1];
                blobName = blobNameWithQuery.split('?')[0];
            }
            
            console.log('📄 Extracted blob path from URL:', {
                container: containerName,
                blob: blobName,
                originalUrl: vendorDocument.FilePath
            });
        }
        
        console.log('📄 Downloading original ASA agreement from Azure Blob Storage:', {
            container: containerName,
            blob: blobName,
            hasBlobPath: !!vendorDocument.BlobPath,
            storedFileName: vendorDocument.StoredFileName
        });
        
        // Download the blob directly using Azure Storage SDK
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        let originalPdf;
        try {
            // Check if blob exists first
            const blobExists = await blockBlobClient.exists();
            if (!blobExists) {
                console.error('❌ Blob does not exist at path:', {
                    container: containerName,
                    blob: blobName,
                    documentId: vendorDocument.FileId,
                    fileName: vendorDocument.FileName
                });
                
                // Try alternative: check if file exists at root of container
                const rootBlobClient = containerClient.getBlockBlobClient(vendorDocument.FileName || `${vendorDocument.FileId}.pdf`);
                const rootExists = await rootBlobClient.exists();
                
                if (rootExists) {
                    console.log('✅ Found blob at root level, using that instead');
                    const downloadResponse = await rootBlobClient.download();
                    const chunks = [];
                    for await (const chunk of downloadResponse.readableStreamBody) {
                        chunks.push(chunk);
                    }
                    const originalPdfBytes = Buffer.concat(chunks);
                    originalPdf = await PDFDocument.load(originalPdfBytes);
                } else {
                    // Generate PDF without original document - just signature page
                    console.warn('⚠️ Original ASA document not found. Generating signature-only PDF.');
                    originalPdf = null; // Will create signature-only PDF
                }
            } else {
                const downloadResponse = await blockBlobClient.download();
                const chunks = [];
                for await (const chunk of downloadResponse.readableStreamBody) {
                    chunks.push(chunk);
                }
                const originalPdfBytes = Buffer.concat(chunks);
                originalPdf = await PDFDocument.load(originalPdfBytes);
            }
        } catch (downloadError) {
            console.error('❌ Error downloading blob:', {
                error: downloadError.message,
                code: downloadError.code,
                container: containerName,
                blob: blobName
            });
            
            // Generate PDF without original document - just signature page
            console.warn('⚠️ Could not download original ASA document. Generating signature-only PDF.');
            originalPdf = null; // Will create signature-only PDF
        }
        
        // Create a new PDF document for the signature page
        const PDFKit = require('pdfkit');
        const signaturePdf = new PDFKit({
                size: 'A4',
                margins: {
                    top: 50,
                    bottom: 50,
                    left: 50,
                    right: 50
                }
            });

        const signatureChunks = [];
        signaturePdf.on('data', chunk => signatureChunks.push(chunk));
        
        const signaturePromise = new Promise((resolve, reject) => {
            signaturePdf.on('end', () => {
                try {
                    const result = Buffer.concat(signatureChunks);
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            signaturePdf.on('error', reject);
        });

        // Add signature page content
        signaturePdf.fontSize(20)
               .font('Helvetica-Bold')
               .text('AGENT SERVICE AGREEMENT (ASA)', { align: 'center' });
            
        signaturePdf.moveDown(0.5);
        signaturePdf.fontSize(12)
               .font('Helvetica')
               .text(`Group: ${groupName}`, { align: 'center' });
        signaturePdf.text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        
        signaturePdf.moveDown(2);
        signaturePdf.fontSize(16)
               .font('Helvetica-Bold')
           .text('SIGNATURE PAGE');
        
        signaturePdf.moveDown(1);
        signaturePdf.fontSize(12)
               .font('Helvetica')
               .text(`This agreement has been digitally signed by the group administrator.`);
            
        signaturePdf.moveDown(1);
        signaturePdf.text(`Signer: ${signerName}`);
        signaturePdf.text(`Email: ${signerEmail}`);
        signaturePdf.text(`Date: ${new Date().toLocaleDateString()}`);
        signaturePdf.text(`Time: ${new Date().toLocaleTimeString()}`);
        
        signaturePdf.moveDown(1);
            
            // Add signature box
        const signatureBoxY = signaturePdf.y;
        signaturePdf.rect(50, signatureBoxY - 5, 500, 100)
               .stroke()
               .moveDown(0.5);
            
            // Handle different signature types
            if (signatureData && signatureData.startsWith('data:image/')) {
                try {
                    const base64Data = signatureData.split(',')[1];
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    
                signaturePdf.fontSize(10)
                       .font('Helvetica-Bold')
                       .text('Digital Signature:');
                signaturePdf.moveDown(0.2);
                    
                    const maxWidth = 200;
                    const maxHeight = 60;
                signaturePdf.image(imageBuffer, { width: maxWidth, height: maxHeight });
                    
                } catch (imageError) {
                    console.warn('⚠️ Failed to embed signature image:', imageError.message);
                signaturePdf.fontSize(10)
                       .font('Helvetica-Bold')
                       .text('Digital Signature: [Image signature - see original data]');
                }
            } else if (signatureData && signatureData.trim()) {
            signaturePdf.fontSize(10)
                   .font('Helvetica-Bold')
                   .text('Digital Signature:');
            signaturePdf.moveDown(0.2);
            signaturePdf.fontSize(12)
                   .font('Helvetica')
                   .text(signatureData);
            }

        signaturePdf.moveDown(2);
        signaturePdf.fontSize(10)
               .font('Helvetica')
               .text('This document represents a legally binding agreement between the group and the vendor.', { align: 'center' });
        signaturePdf.text('The signature above indicates acceptance of all terms and conditions.', { align: 'center' });

        signaturePdf.end();
        
        // Wait for signature PDF to be generated
        const signaturePdfBuffer = await signaturePromise;
        const signaturePdfDoc = await PDFDocument.load(signaturePdfBuffer);
        
        // Create final merged PDF
        const mergedPdf = await PDFDocument.create();
        
        // Copy all pages from the original ASA agreement (if available)
        if (originalPdf) {
            try {
                const originalPages = await mergedPdf.copyPages(originalPdf, originalPdf.getPageIndices());
                originalPages.forEach((page) => mergedPdf.addPage(page));
                console.log('✅ Added original document pages to merged PDF');
            } catch (copyError) {
                console.warn('⚠️ Error copying original pages, continuing with signature page only:', copyError.message);
            }
        } else {
            // Add a cover page explaining that the original document was not available
            const coverPage = mergedPdf.addPage();
            const { width, height } = coverPage.getSize();
            
            coverPage.drawText('AGENT SERVICE AGREEMENT', {
                x: 50,
                y: height - 100,
                size: 24,
            });
            coverPage.drawText('Original document reference not available.', {
                x: 50,
                y: height - 150,
                size: 12,
            });
            coverPage.drawText('Please refer to the agreement document provided separately.', {
                x: 50,
                y: height - 180,
                size: 12,
            });
        }
        
        // Add the signature page
        const signaturePages = await mergedPdf.copyPages(signaturePdfDoc, signaturePdfDoc.getPageIndices());
        signaturePages.forEach((page) => mergedPdf.addPage(page));
        
        // Generate the final PDF
        const pdfBytes = await mergedPdf.save();
        return Buffer.from(pdfBytes).toString('base64');
        
    } catch (error) {
        console.error('❌ Error generating merged ASA PDF:', error);
        throw error;
    }
}

// POST /api/group-onboarding/:linkToken/complete - Complete group onboarding
router.post('/:linkToken/complete', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { groupInfo, groupAdminInfo, bankingInfo, billingInfo, logoUrl } = req.body;
    
    console.log('🔍 Complete onboarding request:', {
      linkToken,
      hasGroupInfo: !!groupInfo,
      hasGroupAdminInfo: !!groupAdminInfo,
      hasBankingInfo: !!bankingInfo,
      hasBillingInfo: !!billingInfo,
      hasLogoUrl: !!logoUrl,
      bankingInfoPaymentMethod: bankingInfo?.paymentMethod || 'NOT PROVIDED',
      bankingInfoKeys: bankingInfo ? Object.keys(bankingInfo) : []
    });
    
    // Debug address data
    console.log('🔍 DEBUG: Address data received:', {
      groupInfo: {
        address: groupInfo?.address,
        city: groupInfo?.city,
        state: groupInfo?.state,
        zip: groupInfo?.zip
      },
      billingInfo: {
        sameAsPrimary: billingInfo?.sameAsPrimary,
        address: billingInfo?.address,
        city: billingInfo?.city,
        state: billingInfo?.state,
        zip: billingInfo?.zip
      },
      bankingInfo: {
        phoneNumber: bankingInfo?.phoneNumber
      }
    });

    if (!linkToken || !groupInfo || !groupAdminInfo) {
      return res.status(400).json({
        success: false,
        message: 'Link token, group info, and group admin info are required'
      });
    }

    const taxId = (groupInfo.taxIdNumber != null && typeof groupInfo.taxIdNumber === 'string') ? groupInfo.taxIdNumber.trim() : '';
    if (!taxId) {
      return res.status(400).json({
        success: false,
        message: 'EIN (Tax ID) is required. Please complete business info with a valid Tax ID number.'
      });
    }

    const pool = await getPool();
    const transaction = pool.transaction();
    
    try {
      await transaction.begin();
      
      // Get group information from the link
      const linkQuery = `
        SELECT gol.GroupId, g.TenantId, g.Name as GroupName
        FROM oe.GroupOnboardingLinks gol
        INNER JOIN oe.Groups g ON gol.GroupId = g.GroupId
        WHERE gol.LinkToken = @linkToken AND gol.Status = 'Active'
      `;
      
      const linkRequest = transaction.request();
      linkRequest.input('linkToken', sql.NVarChar, linkToken);
      const linkResult = await linkRequest.query(linkQuery);
      
      if (linkResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Onboarding link not found or expired'
        });
      }
      
      const linkData = linkResult.recordset[0];
      const { GroupId: groupId, TenantId: tenantId } = linkData;
      
      // Logo URL is already handled by the frontend upload service
      
      // Update group information
      // Only include payment fields in SQL if bankingInfo exists AND paymentMethod is selected
      const hasPaymentMethod = bankingInfo && bankingInfo.paymentMethod && bankingInfo.paymentMethod.trim() !== '';
      const updateGroupQuery = `
        UPDATE oe.Groups SET
          Name = @name,
          PrimaryContact = @primaryContact,
          ContactEmail = @contactEmail,
          ContactPhone = @contactPhone,
          Address = @address,
          City = @city,
          State = @state,
          Zip = @zip,
          TaxIdNumber = @taxIdNumber,
          BusinessType = @businessType,
          ${logoUrl ? 'LogoUrl = @logoUrl,' : ''}
          ${hasPaymentMethod ? 'CreditCardNumber = @creditCardNumber, CreditCardType = @creditCardType, CreditCardExpiry = @creditCardExpiry, CreditCardName = @creditCardName, ACHBankName = @achBankName, ACHAccountType = @achAccountType, ACHRoutingNumber = @achRoutingNumber, ACHAccountNumber = @achAccountNumber, ACHAccountName = @achAccountName,' : ''}
          ModifiedDate = GETUTCDATE()
        WHERE GroupId = @groupId
      `;
      
      const updateRequest = transaction.request();
      updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
      updateRequest.input('name', sql.NVarChar, groupInfo.name);
      updateRequest.input('primaryContact', sql.NVarChar, groupInfo.primaryContact);
      updateRequest.input('contactEmail', sql.NVarChar, groupInfo.contactEmail);
      updateRequest.input('contactPhone', sql.NVarChar, groupInfo.contactPhone);
      updateRequest.input('address', sql.NVarChar, groupInfo.address);
      updateRequest.input('city', sql.NVarChar, groupInfo.city);
      updateRequest.input('state', sql.NVarChar, groupInfo.state);
      updateRequest.input('zip', sql.NVarChar, groupInfo.zip);
      updateRequest.input('taxIdNumber', sql.NVarChar, groupInfo.taxIdNumber);
      updateRequest.input('businessType', sql.NVarChar, groupInfo.businessType);
      
      if (logoUrl) {
        updateRequest.input('logoUrl', sql.NVarChar, logoUrl);
      }
      
      // Add banking info parameters (only store last 4 digits and basic info in Groups table)
      // Only add parameters if payment method is actually selected
      if (hasPaymentMethod) {
        // Store only last 4 digits of credit card number
        const creditCardLast4 = bankingInfo.creditCardNumber ? bankingInfo.creditCardNumber.slice(-4) : '';
        updateRequest.input('creditCardNumber', sql.NVarChar, creditCardLast4);
        updateRequest.input('creditCardType', sql.NVarChar, bankingInfo.creditCardType || '');
        updateRequest.input('creditCardExpiry', sql.NVarChar, bankingInfo.creditCardExpiry || '');
        updateRequest.input('creditCardName', sql.NVarChar, bankingInfo.creditCardName || '');
        updateRequest.input('achBankName', sql.NVarChar, bankingInfo.achBankName || '');
        updateRequest.input('achAccountType', sql.NVarChar, bankingInfo.achAccountType || '');
        updateRequest.input('achRoutingNumber', sql.NVarChar, bankingInfo.achRoutingNumber || '');
        // Store only last 4 digits of account number
        const achAccountLast4 = bankingInfo.achAccountNumber ? bankingInfo.achAccountNumber.slice(-4) : '';
        updateRequest.input('achAccountNumber', sql.NVarChar, achAccountLast4);
        updateRequest.input('achAccountName', sql.NVarChar, bankingInfo.achAccountName || '');
      }
      
      await updateRequest.query(updateGroupQuery);
      
      // Create primary location for the group if it doesn't exist
      const checkLocationRequest = transaction.request();
      checkLocationRequest.input('groupId', sql.UniqueIdentifier, groupId);
      const locationCheckResult = await checkLocationRequest.query(`
        SELECT COUNT(*) as locationCount
        FROM oe.GroupLocations
        WHERE GroupId = @groupId
      `);
      
      const locationCount = locationCheckResult.recordset[0].locationCount;
      let primaryLocationId = null;
      
      if (locationCount === 0) {
        // Create primary location
        primaryLocationId = require('crypto').randomUUID();
        const locationRequest = transaction.request();
        locationRequest.input('locationId', sql.UniqueIdentifier, primaryLocationId);
        locationRequest.input('groupId', sql.UniqueIdentifier, groupId);
        locationRequest.input('name', sql.NVarChar, 'Primary Location');
        locationRequest.input('address', sql.NVarChar, groupInfo.address || '');
        locationRequest.input('city', sql.NVarChar, groupInfo.city || '');
        locationRequest.input('state', sql.NVarChar, groupInfo.state || '');
        locationRequest.input('zip', sql.NVarChar, groupInfo.zip || '');
        locationRequest.input('contactName', sql.NVarChar, groupInfo.primaryContact || null);
        locationRequest.input('contactPhone', sql.NVarChar, groupInfo.contactPhone || null);
        locationRequest.input('contactEmail', sql.NVarChar, groupInfo.contactEmail || null);
        locationRequest.input('isPrimary', sql.Bit, 1);
        locationRequest.input('useLocationACH', sql.Bit, 0);
        locationRequest.input('createdBy', sql.UniqueIdentifier, userId);
        
        await locationRequest.query(`
          INSERT INTO oe.GroupLocations 
          (LocationId, GroupId, Name, Address, City, State, Zip,
           ContactName, ContactPhone, ContactEmail, IsPrimary, UseLocationACH, Status,
           CreatedDate, ModifiedDate, CreatedBy)
          VALUES 
          (@locationId, @groupId, @name, @address, @city, @state, @zip,
           @contactName, @contactPhone, @contactEmail, @isPrimary, @useLocationACH, 'Active',
           GETDATE(), GETDATE(), @createdBy)
        `);
        console.log(`✅ Created primary location for group ${groupId} during onboarding`);
      } else {
        // Get existing primary location ID for payment method association
        const getPrimaryRequest = transaction.request();
        getPrimaryRequest.input('groupId', sql.UniqueIdentifier, groupId);
        const primaryResult = await getPrimaryRequest.query(`
          SELECT LocationId FROM oe.GroupLocations 
          WHERE GroupId = @groupId AND IsPrimary = 1
        `);
        
        if (primaryResult.recordset.length > 0) {
          primaryLocationId = primaryResult.recordset[0].LocationId;
        }
      }
      
      // Create payment method record with DIME if banking info is provided AND payment method is selected
      // Only process payment methods if a payment method type is actually provided
      console.log('🔍 Payment method check:', {
        hasBankingInfo: !!bankingInfo,
        paymentMethod: bankingInfo?.paymentMethod,
        paymentMethodTrimmed: bankingInfo?.paymentMethod?.trim(),
        willProcessPayment: !!(bankingInfo && bankingInfo.paymentMethod && bankingInfo.paymentMethod.trim() !== '')
      });
      
      if (bankingInfo && bankingInfo.paymentMethod && bankingInfo.paymentMethod.trim() !== '') {
        try {
          console.log('💳 Processing group payment method with DIME during onboarding:', {
            paymentMethod: bankingInfo.paymentMethod,
            hasPhoneNumber: !!bankingInfo.phoneNumber
          });

          // Check for existing payment methods of the same type
          const existingPaymentQuery = `
            SELECT PaymentMethodId, Type, IsDefault
            FROM oe.GroupPaymentMethods
            WHERE GroupId = @groupId 
            AND Type = @paymentMethodType
            AND Status = 'Active'
          `;
          
          const existingPaymentRequest = transaction.request();
          existingPaymentRequest.input('groupId', sql.UniqueIdentifier, groupId);
          existingPaymentRequest.input('paymentMethodType', sql.NVarChar, bankingInfo.paymentMethod === 'credit' ? 'CreditCard' : 'ACH');
          const existingPaymentResult = await existingPaymentRequest.query(existingPaymentQuery);
          
          if (existingPaymentResult.recordset.length > 0) {
            console.log(`⚠️ Found existing ${bankingInfo.paymentMethod === 'credit' ? 'credit card' : 'ACH'} payment method - will override and make new one primary`);
            
            // Mark existing payment method of same type as inactive (override behavior)
            const deactivateExistingQuery = `
              UPDATE oe.GroupPaymentMethods
              SET Status = 'Inactive', IsDefault = 0, ModifiedDate = GETUTCDATE()
              WHERE GroupId = @groupId 
              AND Type = @paymentMethodType
              AND Status = 'Active'
            `;
            
            const deactivateRequest = transaction.request();
            deactivateRequest.input('groupId', sql.UniqueIdentifier, groupId);
            deactivateRequest.input('paymentMethodType', sql.NVarChar, bankingInfo.paymentMethod === 'credit' ? 'CreditCard' : 'ACH');
            await deactivateRequest.query(deactivateExistingQuery);
            
            console.log('✅ Deactivated existing payment method of same type');
          }

          // Prepare customer data for DIME
          const customerData = {
            firstName: groupInfo.primaryContactFirstName || groupInfo.primaryContact?.split(' ')[0] || 'Group',
            lastName: groupInfo.primaryContactLastName || groupInfo.primaryContact?.split(' ').slice(1).join(' ') || 'Admin',
            email: groupInfo.contactEmail || 'group@example.com',
            phone: bankingInfo.phoneNumber || groupInfo.contactPhone || '+17707892072',
            billingAddress: billingInfo?.address || groupInfo.address || '',
            billingCity: billingInfo?.city || groupInfo.city || '',
            billingState: billingInfo?.state || groupInfo.state || '',
            billingZip: billingInfo?.zip || groupInfo.zip || '',
            billingCountry: 'US'
          };

          // Ensure DIME customer exists using unified service
          const customerResult = await PaymentMethodService.ensureDimeCustomer(
            customerData, 
            'group', 
            groupId, 
            tenantId,
            transaction
          );

          if (!customerResult.success) {
            throw new Error(`Failed to create DIME customer: ${customerResult.error?.message || customerResult.message}`);
          }

          const dimeCustomerId = customerResult.customerId;

          // Store DIME customer ID in group
          const updateCustomerRequest = transaction.request();
          updateCustomerRequest.input('groupId', sql.UniqueIdentifier, groupId);
          updateCustomerRequest.input('customerId', sql.NVarChar(255), dimeCustomerId);
          await updateCustomerRequest.query(`
            UPDATE oe.Groups 
            SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
            WHERE GroupId = @groupId
          `);

          // Prepare payment method data for unified service
          // When sameAsPrimary is true, use business address from groupInfo
          // Otherwise, use the manually entered billing address from billingInfo
          const useBusinessAddress = billingInfo?.sameAsPrimary !== false; // Default to true if not specified
          const finalBillingAddress = useBusinessAddress 
            ? (groupInfo.address || '')
            : (billingInfo?.address || '');
          const finalBillingCity = useBusinessAddress 
            ? (groupInfo.city || '')
            : (billingInfo?.city || '');
          const finalBillingState = useBusinessAddress 
            ? (groupInfo.state || '')
            : (billingInfo?.state || '');
          const finalBillingZip = useBusinessAddress 
            ? (groupInfo.zip || '')
            : (billingInfo?.zip || '');

          const paymentMethodData = {
            paymentMethodType: bankingInfo.paymentMethod === 'credit' ? 'CreditCard' : 'ACH',
            billingAddress: finalBillingAddress,
            billingCity: finalBillingCity,
            billingState: finalBillingState,
            billingZip: finalBillingZip,
            billingCountry: 'US'
          };

          console.log('🔍 DEBUG: Billing address resolution:', {
            sameAsPrimary: billingInfo?.sameAsPrimary,
            useBusinessAddress,
            finalBillingAddress,
            finalBillingCity,
            finalBillingState,
            finalBillingZip,
            groupInfoAddress: groupInfo.address,
            billingInfoAddress: billingInfo?.address
          });
          
          // Validate required address fields for DIME (required for both credit cards and ACH)
          if (!paymentMethodData.billingAddress || !paymentMethodData.billingCity || !paymentMethodData.billingState || !paymentMethodData.billingZip) {
            console.error('❌ Missing required billing address fields:', {
              billingAddress: paymentMethodData.billingAddress,
              billingCity: paymentMethodData.billingCity,
              billingState: paymentMethodData.billingState,
              billingZip: paymentMethodData.billingZip,
              sameAsPrimary: billingInfo?.sameAsPrimary,
              groupInfo: {
                address: groupInfo.address,
                city: groupInfo.city,
                state: groupInfo.state,
                zip: groupInfo.zip
              },
              billingInfo: billingInfo
            });
            throw new Error('Complete billing address (address, city, state, zip) is required for payment processing. Please ensure the business address is complete in the Business Info step.');
          }

          // Add payment method specific fields
          if (bankingInfo.paymentMethod === 'credit') {
            // Parse expiry date (MM/YYYY format)
            let expiryMonth, expiryYear;
            if (bankingInfo.creditCardExpiry) {
              const [month, year] = bankingInfo.creditCardExpiry.split('/');
              expiryMonth = parseInt(month);
              expiryYear = parseInt(year);
            }

            paymentMethodData.cardNumber = bankingInfo.creditCardNumber;
            // Use unified card brand detection method (DIME strings); fallback to UI credit card type label
            paymentMethodData.cardBrand = DimeService.getCardBrand(bankingInfo.creditCardNumber)
              || dimeCardBrand.mapDisplayBrandToDime(bankingInfo.creditCardType)
              || null;
            paymentMethodData.expiryMonth = expiryMonth;
            paymentMethodData.expiryYear = expiryYear;
            paymentMethodData.cvv = bankingInfo.creditCardCvv;
            paymentMethodData.cardholderName = bankingInfo.creditCardName;
          } else if (bankingInfo.paymentMethod === 'ach') {
            paymentMethodData.bankName = bankingInfo.achBankName;
            paymentMethodData.accountType = bankingInfo.achAccountType || 'Checking';
            paymentMethodData.routingNumber = bankingInfo.achRoutingNumber;
            paymentMethodData.accountNumber = bankingInfo.achAccountNumber;
            paymentMethodData.accountHolderName = bankingInfo.achAccountName;
          }

          // Create payment method using unified service (includes proper tokenization)
          const dimeResult = await PaymentMethodService.createPaymentMethod(
            paymentMethodData, 
            dimeCustomerId, 
            tenantId
          );

          if (!dimeResult.success) {
            throw new Error(`Failed to create payment method: ${dimeResult.error?.message || dimeResult.message}`);
          }

          // Insert payment method using unified service (link to primary location)
          const insertResult = await PaymentMethodService.insertPaymentMethod(
            paymentMethodData,
            'group',
            groupId,
            dimeResult,
            null, // No userId for group onboarding
            tenantId,
            transaction,
            primaryLocationId // Link payment method to primary location
          );

          if (!insertResult.success) {
            throw new Error(`Failed to save payment method: ${insertResult.error?.message || insertResult.message}`);
          }

          // Set this payment method as default (needed for recurring payments)
          await PaymentMethodService.updatePaymentMethodDefaults('group', groupId, insertResult.paymentMethodId, null, tenantId, transaction, primaryLocationId);
          
          console.log('✅ Group payment method created with DIME tokens during onboarding and set as default');
          console.log('ℹ️ Recurring payment management is handled by oe_payment_manager (not created during onboarding)');
        } catch (paymentError) {
          console.error('❌ Error processing group payment method with DIME:', paymentError);
          // ACID COMPLIANCE: Throw error to rollback entire transaction
          throw new Error(`Failed to process payment method: ${paymentError.message}`);
        }
      } else {
        // No payment method provided - skip DIME customer creation entirely
        console.log('ℹ️ No payment method provided - skipping DIME customer creation');
      }
      
      // Create or update group admin user
      const checkUserQuery = `
        SELECT UserId, FirstName, LastName FROM oe.Users 
        WHERE Email = @email AND TenantId = @tenantId
      `;
      
      const checkRequest = transaction.request();
      checkRequest.input('email', sql.NVarChar, groupAdminInfo.email);
      checkRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
      const userResult = await checkRequest.query(checkUserQuery);
      
      let userId;
      
      if (userResult.recordset.length === 0) {
        // Create new user (GroupId link will be in GroupAdmins table)
        const newUserId = require('crypto').randomUUID();
        const createUserQuery = `
          INSERT INTO oe.Users (
            UserId, TenantId, FirstName, LastName, Email, PhoneNumber,
            Status, CreatedDate, ModifiedDate
          ) VALUES (
            @userId, @tenantId, @firstName, @lastName, @email, @phoneNumber,
            'Pending', GETUTCDATE(), GETUTCDATE()
          )
        `;
        
        const createRequest = transaction.request();
        createRequest.input('userId', sql.UniqueIdentifier, newUserId);
        createRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        createRequest.input('firstName', sql.NVarChar, groupAdminInfo.firstName || '');
        createRequest.input('lastName', sql.NVarChar, groupAdminInfo.lastName || '');
        createRequest.input('email', sql.NVarChar, groupAdminInfo.email);
        createRequest.input('phoneNumber', sql.NVarChar, groupAdminInfo.phone || null);
        
        await createRequest.query(createUserQuery);
        
        console.log(`✅ Created new user: ${groupAdminInfo.firstName} ${groupAdminInfo.lastName} (${groupAdminInfo.email})`);
        userId = newUserId;
      } else {
        // User already exists - update firstName and lastName if provided
        userId = userResult.recordset[0].UserId;
        const existingFirstName = userResult.recordset[0].FirstName || '';
        const existingLastName = userResult.recordset[0].LastName || '';
        
        // Only update if we have new firstName/lastName values
        if (groupAdminInfo.firstName || groupAdminInfo.lastName) {
          const updateUserQuery = `
            UPDATE oe.Users SET
              FirstName = @firstName,
              LastName = @lastName,
              ModifiedDate = GETUTCDATE()
            WHERE UserId = @userId
          `;
          
          const updateRequest = transaction.request();
          updateRequest.input('userId', sql.UniqueIdentifier, userId);
          // Use new values if provided, otherwise keep existing
          updateRequest.input('firstName', sql.NVarChar, groupAdminInfo.firstName || existingFirstName);
          updateRequest.input('lastName', sql.NVarChar, groupAdminInfo.lastName || existingLastName);
          
          await updateRequest.query(updateUserQuery);
          console.log(`✅ Updated existing user's name: ${groupAdminInfo.firstName || existingFirstName} ${groupAdminInfo.lastName || existingLastName}`);
        }
      }
      
      // Update onboarding link status to "In Progress" (not "Used" yet - password setup is still needed)
      const updateLinkQuery = `
        UPDATE oe.GroupOnboardingLinks SET
          Status = 'InProgress',
          UsedBy = @userId
        WHERE LinkToken = @linkToken
      `;
      
      const linkUpdateRequest = transaction.request();
      linkUpdateRequest.input('linkToken', sql.NVarChar, linkToken);
      linkUpdateRequest.input('userId', sql.UniqueIdentifier, userId);
      await linkUpdateRequest.query(updateLinkQuery);
      
      // Create or update GroupAdmin link in GroupAdmins table (within transaction)
      const checkGroupAdminQuery = `
        SELECT GroupAdminId FROM oe.GroupAdmins 
        WHERE UserId = @userId AND GroupId = @groupId
      `;
      const checkGroupAdminRequest = transaction.request();
      checkGroupAdminRequest.input('userId', sql.UniqueIdentifier, userId);
      checkGroupAdminRequest.input('groupId', sql.UniqueIdentifier, groupId);
      const existingGroupAdmin = await checkGroupAdminRequest.query(checkGroupAdminQuery);
      
      if (existingGroupAdmin.recordset.length === 0) {
        // Create new GroupAdmin link
        const groupAdminId = require('crypto').randomUUID();
        const createGroupAdminQuery = `
          INSERT INTO oe.GroupAdmins (
            GroupAdminId, UserId, GroupId, Status, AssignedDate, CreatedDate, ModifiedDate
          ) VALUES (
            @groupAdminId, @userId, @groupId, 'Active', GETUTCDATE(), GETUTCDATE(), GETUTCDATE()
          )
        `;
        
        const groupAdminRequest = transaction.request();
        groupAdminRequest.input('groupAdminId', sql.UniqueIdentifier, groupAdminId);
        groupAdminRequest.input('userId', sql.UniqueIdentifier, userId);
        groupAdminRequest.input('groupId', sql.UniqueIdentifier, groupId);
        await groupAdminRequest.query(createGroupAdminQuery);
        
        console.log('✅ GroupAdmin link created in GroupAdmins table:', { userId, groupId, groupAdminId });
      } else {
        console.log('✅ GroupAdmin link already exists in GroupAdmins table');
      }
      
      await transaction.commit();
      
      // Assign GroupAdmin role AFTER transaction completes (prevents nested transaction deadlock)
      try {
        await UserRolesService.assignRoleToUser(userId, 'GroupAdmin', null);
        console.log('✅ GroupAdmin role assigned to user:', userId);
      } catch (roleError) {
        console.error('❌ Error assigning GroupAdmin role (non-fatal):', roleError);
        // Don't fail the whole onboarding if role assignment fails
        // The user can still log in and roles can be fixed later
      }
      
      console.log('✅ Group onboarding completed successfully:', {
        groupId,
        userId,
        email: groupAdminInfo.email
      });
      
      res.json({
        success: true,
        data: {
          email: groupAdminInfo.email,
          userId: userId
        },
        message: 'Group onboarding completed successfully'
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error completing group onboarding:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error while completing onboarding',
      error: {
        message: error.message,
        code: 'ONBOARDING_COMPLETION_ERROR'
      }
    });
  }
});

// POST /api/group-onboarding/:linkToken/setup-password - Setup password for group admin
router.post('/:linkToken/setup-password', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const { password } = req.body;
    
    console.log('🔍 Setup password request for linkToken:', linkToken);
    
    if (!linkToken || !password) {
      return res.status(400).json({
        success: false,
        message: 'Link token and password are required'
      });
    }

    // Validate password strength (HIPAA compliant)
    const passwordRequirements = require('../constants/password-requirements');
    const passwordRegex = passwordRequirements.getPasswordRegex();
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: passwordRequirements.getPasswordErrorMessage()
      });
    }
    
    const pool = await getPool();
    
    // Get user from the in-progress onboarding link
    const userQuery = `
      SELECT gol.UsedBy as UserId, u.Email, u.TenantId, g.GroupId
      FROM oe.GroupOnboardingLinks gol
      INNER JOIN oe.Users u ON gol.UsedBy = u.UserId
      INNER JOIN oe.Groups g ON gol.GroupId = g.GroupId
      WHERE gol.LinkToken = @linkToken AND gol.Status = 'InProgress'
    `;
    
    const userRequest = pool.request();
    userRequest.input('linkToken', sql.NVarChar, linkToken);
    const userResult = await userRequest.query(userQuery);
    
    if (userResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired onboarding link'
      });
    }
    
    const userData = userResult.recordset[0];
    const { UserId: userId, Email: email, TenantId: tenantId, GroupId: groupId } = userData;
    
    // Hash the password
    const bcrypt = require('bcrypt');
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Update user with hashed password and activate account
    const updatePasswordQuery = `
      UPDATE oe.Users SET
        PasswordHash = @hashedPassword,
        Status = 'Active',
        ModifiedDate = GETUTCDATE()
      WHERE UserId = @userId
    `;
    
    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, userId);
    updateRequest.input('hashedPassword', sql.NVarChar, hashedPassword);
    await updateRequest.query(updatePasswordQuery);
    
    // Generate JWT token
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { 
        userId: userId,
        email: email,
        tenantId: tenantId,
        groupId: groupId,
        userType: 'GroupAdmin'
      },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '24h' }
    );
    
    // Mark the onboarding link as "Used" now that password is set up
    const markUsedQuery = `
      UPDATE oe.GroupOnboardingLinks SET
        Status = 'Used',
        UsedDate = GETUTCDATE()
      WHERE LinkToken = @linkToken
    `;
    
    const markUsedRequest = pool.request();
    markUsedRequest.input('linkToken', sql.NVarChar, linkToken);
    await markUsedRequest.query(markUsedQuery);
    
    console.log('✅ Password setup completed successfully for user:', email);
    
    res.json({
      success: true,
      data: {
        token: token,
        userId: userId,
        email: email,
        groupId: groupId
      },
      message: 'Password setup completed successfully'
    });
    
  } catch (error) {
    console.error('❌ Error setting up password:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while setting up password'
    });
  }
});

// GET /api/group-onboarding/:linkToken/products - Get products for group during onboarding (public endpoint)
router.get('/:linkToken/products', async (req, res) => {
  try {
    const { linkToken } = req.params;
    const pool = await getPool();
    
    console.log('🔍 Fetching group products for onboarding linkToken:', linkToken);

    // First, get the group ID from the onboarding link
    const groupQuery = `
      SELECT g.GroupId
      FROM oe.GroupOnboardingLinks gol
      INNER JOIN oe.Groups g ON gol.GroupId = g.GroupId
      WHERE gol.LinkToken = @linkToken 
    `;
    
    const groupRequest = pool.request();
    groupRequest.input('linkToken', sql.NVarChar, linkToken);
    const groupResult = await groupRequest.query(groupQuery);

    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group onboarding link not found or expired'
      });
    }

    const groupId = groupResult.recordset[0].GroupId;

    // Get products assigned to this group
    const productsQuery = `
      SELECT 
        gp.GroupProductId,
        gp.GroupId,
        gp.ProductId,
        1 as IsAssigned,
        gp.IsActive,
        p.Name,
        p.ProductType,
        p.Description,
        p.ProductLogoUrl,
        p.ProductImageUrl,
        p.ProductDocumentUrl,
        p.MinAge,
        p.MaxAge,
        p.SalesType,
        p.AllowedStates,
        p.RequiredASA,
        COALESCE(t.Name, 'Unknown') as ProductOwner,
        -- Get base price from ProductPricing if available
        ISNULL((
          SELECT MIN(pp.NetRate + ISNULL(pp.OverrideRate, 0))
          FROM oe.ProductPricing pp
          WHERE pp.ProductId = p.ProductId 
          AND pp.Status = 'Active'
        ), 0) as BasePrice
      FROM oe.GroupProducts gp
      INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
      LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
      WHERE gp.GroupId = @groupId
      ORDER BY p.Name
    `;
    
    const productsRequest = pool.request();
    productsRequest.input('groupId', sql.UniqueIdentifier, groupId);
    const productsResult = await productsRequest.query(productsQuery);

    const groupProducts = productsResult.recordset.map(product => ({
      GroupProductId: product.GroupProductId,
      GroupId: product.GroupId,
      ProductId: product.ProductId,
      Name: product.Name,
      ProductType: product.ProductType,
      Description: product.Description,
      BasePrice: product.BasePrice,
      ProductLogoUrl: product.ProductLogoUrl,
      ProductImageUrl: product.ProductImageUrl,
      ProductDocumentUrl: product.ProductDocumentUrl,
      MinAge: product.MinAge,
      MaxAge: product.MaxAge,
      SalesType: product.SalesType,
      AllowedStates: product.AllowedStates,
      RequiredASA: product.RequiredASA,
      ProductOwner: product.ProductOwner,
      IsAssigned: product.IsAssigned,
      IsActive: product.IsActive
    }));

    console.log(`✅ Found ${groupProducts.length} products for group ${groupId}`);

    res.json({
      success: true,
      data: {
        groupProducts: groupProducts,
        availableProducts: [] // Empty for onboarding - only show assigned products
      },
      message: `Found ${groupProducts.length} products for this group`
    });

  } catch (error) {
    console.error('❌ Error fetching group products for onboarding:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching group products',
      error: {
        message: error.message,
        code: error.code || 'UNKNOWN_ERROR'
        }
    });
}
});

// GET /api/group-onboarding/:linkToken/tenant-redirect - Get tenant redirection information
router.get('/:linkToken/tenant-redirect', async (req, res) => {
  const pool = await getPool();
  try {
    const { linkToken } = req.params;
    
    console.log('🔍 Getting tenant redirect info for group onboarding link:', linkToken);
    
    // Get group onboarding link and tenant information
    const groupOnboardingLinkQuery = `
      SELECT 
        gol.LinkId,
        gol.GroupId,
        g.TenantId,
        t.Name as TenantName,
        t.CustomDomain,
        t.DefaultUrlPath,
        t.IsDefaultUrlPathVerified
      FROM oe.GroupOnboardingLinks gol
      INNER JOIN oe.Groups g ON gol.GroupId = g.GroupId
      INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
      WHERE gol.LinkToken = @linkToken
        AND gol.IsActive = 1
        AND t.Status = 'Active'
    `;
    
    const request = pool.request();
    request.input('linkToken', sql.NVarChar, linkToken);
    
    const result = await request.query(groupOnboardingLinkQuery);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group onboarding link not found or inactive'
      });
    }
    
    const tenantInfo = result.recordset[0];
    
    // Determine redirect URL based on priority:
    // 1. CustomDomain (if available and working)
    // 2. DefaultUrlPath (if verified)
    // 3. Default to /login
    
    let redirectUrl = '/login'; // Default fallback
    let redirectType = 'default';
    
    if (tenantInfo.CustomDomain && tenantInfo.CustomDomain.trim() !== '') {
      // Use custom domain
      redirectUrl = `https://${tenantInfo.CustomDomain}/login`;
      redirectType = 'custom_domain';
    } else if (tenantInfo.DefaultUrlPath && tenantInfo.IsDefaultUrlPathVerified) {
      // Use default URL path
      redirectUrl = `https://app.allaboard365.com/${tenantInfo.DefaultUrlPath}/login`;
      redirectType = 'default_url_path';
    }
    
    console.log('✅ Group onboarding tenant redirect info:', {
      tenantName: tenantInfo.TenantName,
      customDomain: tenantInfo.CustomDomain,
      defaultUrlPath: tenantInfo.DefaultUrlPath,
      redirectUrl: redirectUrl,
      redirectType: redirectType
    });
    
    res.json({
      success: true,
      data: {
        tenantName: tenantInfo.TenantName,
        customDomain: tenantInfo.CustomDomain,
        defaultUrlPath: tenantInfo.DefaultUrlPath,
        redirectUrl: redirectUrl,
        redirectType: redirectType
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching tenant redirect info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tenant redirect information',
      error: error.message
    });
  }
});

// Export PDF generation function for use in other routes
module.exports = router;
module.exports.generateASAAgreementPDF = generateASAAgreementPDF;