const express = require('express');
const multer = require('multer');
const router = express.Router();
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../config/database');
const sql = require('mssql');
const { MAX_UPLOAD_FILE_BYTES } = require('../constants/uploadLimits');

// Base allowed MIME types (standard uploads)
const STANDARD_UPLOAD_MIME_TYPES = {
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/csv': '.csv',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg'
};

function isStandardUploadMime(mimetype) {
    return Boolean(STANDARD_UPLOAD_MIME_TYPES[mimetype]);
}

function isMarketingResourcesMime(mimetype) {
    if (isStandardUploadMime(mimetype)) return true;
    if (mimetype.startsWith('audio/') || mimetype.startsWith('video/')) return true;
    if (mimetype === 'application/zip' || mimetype === 'application/x-zip-compressed') return true;
    return false;
}

// Configure multer for file uploads (memory storage)
// Note: Azure Blob Storage supports files up to 190.7 TiB per block blob
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_FILE_BYTES,
        files: 5 // Maximum 5 files per request
    },
    fileFilter: (req, file, cb) => {
        if (isStandardUploadMime(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`File type ${file.mimetype} not allowed`));
        }
    }
});

// Tenant marketing library: larger cap + audio/video/zip
const marketingResourcesUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 150 * 1024 * 1024,
        files: 5
    },
    fileFilter: (req, file, cb) => {
        if (isMarketingResourcesMime(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`File type ${file.mimetype} not allowed for marketing resources`));
        }
    }
});

// Initialize Azure Blob Service Client
let blobServiceClient;
try {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
        console.error('❌ AZURE_STORAGE_CONNECTION_STRING not found in environment variables');
    } else {
        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        console.log('✅ Azure Blob Storage client initialized');
    }
} catch (error) {
    console.error('❌ Failed to initialize Azure Blob Storage client:', error.message);
}

// Helper function to upload to Azure Blob Storage
async function uploadToAzureBlob(file, containerName, blobName) {
    if (!blobServiceClient) {
        console.error('❌ Azure Blob Storage client not initialized - check AZURE_STORAGE_CONNECTION_STRING environment variable');
        throw new Error('Azure Blob Storage client not initialized');
    }

    try {
        console.log(`📦 Starting upload to Azure - Container: ${containerName}, Blob: ${blobName}, File size: ${file.size} bytes`);
        
        const containerClient = blobServiceClient.getContainerClient(containerName);
        
        // Create container if it doesn't exist
        try {
            await containerClient.createIfNotExists({ access: 'blob' });
            console.log(`✅ Container ${containerName} is ready`);
        } catch (containerError) {
            console.error(`⚠️ Container ${containerName} check/creation issue:`, containerError.message);
            // Continue anyway - container might already exist
        }

        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        const mimeLower = String(file.mimetype || '').toLowerCase();
        const nameLower = String(blobName || '').toLowerCase();
        const isPdf = mimeLower === 'application/pdf' || nameLower.endsWith('.pdf');

        // Upload file with metadata — PDFs: inline disposition so browsers/embeds prefer viewing over download
        const blobHTTPHeaders = {
            blobContentType: file.mimetype || (isPdf ? 'application/pdf' : 'application/octet-stream')
        };
        if (isPdf) {
            blobHTTPHeaders.blobContentDisposition = 'inline';
        }

        // Sanitize originalName: Azure metadata headers must be ASCII-safe.
        // macOS filenames often contain Unicode whitespace (e.g. U+202F narrow no-break space)
        // which causes MAC signature mismatches on the Azure side.
        const safeOriginalName = (file.originalname || 'unknown')
            .replace(/[^\x20-\x7E]/g, '_');

        const uploadOptions = {
            blobHTTPHeaders,
            metadata: {
                originalName: safeOriginalName,
                uploadedBy: 'allaboard365-system',
                uploadDate: new Date().toISOString()
            }
        };

        console.log(`⬆️ Uploading ${file.size} bytes to Azure Blob Storage...`);
        await blockBlobClient.uploadData(file.buffer, uploadOptions);
        
        console.log(`✅ Successfully uploaded to Azure: ${blockBlobClient.url}`);
        return blockBlobClient.url;
        
    } catch (error) {
        console.error('❌ Azure Blob Storage upload error:', {
            message: error.message,
            code: error.code,
            statusCode: error.statusCode,
            containerName,
            blobName,
            fileSize: file.size,
            mimeType: file.mimetype,
            errorDetails: error.details || 'No additional details'
        });
        
        // Provide more specific error message
        if (error.code === 'ENOTFOUND') {
            throw new Error('Cannot connect to Azure Storage - check connection string and network connectivity');
        } else if (error.code === 'ETIMEDOUT') {
            throw new Error('Azure Storage connection timeout - check network connectivity');
        } else if (error.statusCode === 403) {
            throw new Error('Azure Storage access denied - check account permissions and connection string');
        } else if (error.statusCode === 404) {
            throw new Error('Azure Storage account not found - check connection string');
        } else {
            throw new Error(`Azure upload failed: ${error.message}`);
        }
    }
}

/**
 * Read SAS lifetime for marketing-resources / Resource Library files in the private `documents` container.
 * Short SAS (see default in generateSASUrl) breaks bookmarked or cached links; these tenant-shared files use a long-lived read signature.
 * (True anonymous public access would require container/blob ACL changes in Azure — this remains signed URLs.)
 */
const MARKETING_RESOURCE_SAS_EXPIRES_MINUTES = 365 * 24 * 60;

// Helper function to generate SAS URL for authenticated blob access
function generateSASUrl(containerName, blobName, permissions = 'r', expiresInMinutes = 60) {
    if (!blobServiceClient) {
        throw new Error('Azure Blob Storage client not initialized');
    }

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    // Set time window with skew tolerance.
    // Azure and app-server clocks may differ by seconds/minutes; starting in the past avoids transient 403s.
    const startsOn = new Date();
    startsOn.setMinutes(startsOn.getMinutes() - 5);
    const expiresOn = new Date();
    expiresOn.setMinutes(expiresOn.getMinutes() + expiresInMinutes);
    
    // Generate SAS token
    const sasToken = generateBlobSASQueryParameters({
        containerName: containerName,
        blobName: blobName,
        permissions: BlobSASPermissions.parse(permissions),
        expiresOn: expiresOn,
        startsOn: startsOn
    }, blobServiceClient.credential).toString();
    
    return `${blockBlobClient.url}?${sasToken}`;
}

const DOCUMENTS_CONTAINER_NAME = 'documents';

/**
 * Copy a blob to a new name in the documents container (e.g. agency resource copy; independent of source FileId).
 * @param {string} sourceBlobName - StoredFileName in oe.FileUploads
 * @returns {Promise<string>} new blob / stored file name
 */
async function copyDocumentsBlobToNewName(sourceBlobName) {
    if (!blobServiceClient) {
        throw new Error('Azure Blob Storage client not initialized');
    }
    if (!sourceBlobName || !String(sourceBlobName).trim()) {
        throw new Error('sourceBlobName is required');
    }
    const ext = (String(sourceBlobName).match(/(\.[^.]+)$/) || [null, ''])[1] || '';
    const destBlobName = `${uuidv4()}${ext}`;
    const containerClient = blobServiceClient.getContainerClient(DOCUMENTS_CONTAINER_NAME);
    const source = containerClient.getBlockBlobClient(sourceBlobName);
    const dest = containerClient.getBlockBlobClient(destBlobName);
    const copySource = generateSASUrl(DOCUMENTS_CONTAINER_NAME, sourceBlobName, 'r', 90);
    const poller = await dest.beginCopyFromURL(copySource);
    await poller.pollUntilDone();
    return destBlobName;
}

function getUploadContainerMapping() {
    return {
        'products': 'products',
        'images': 'products',
        'logos': 'logos',
        'documents': 'documents',
        'members': 'members',
        'agents': 'logos',
        'affiliates': 'affiliates',
        'agreements': 'agreements',
        'training': 'training',
        'marketing-resources': 'documents'
    };
}

// POST File Upload - Now with real Azure Blob Storage
async function handleMultipartUpload(req, res, forcedUploadType) {
    try {
        const {
            uploadType,
            entityId,
            category = 'general'
        } = req.body;

        const normalizedUploadType = forcedUploadType || uploadType || req.body.type || req.body.fileType;
        const incomingFiles = Array.isArray(req.files) ? req.files : [];

        console.log('📤 Upload request received:', {
            uploadType: normalizedUploadType,
            entityId,
            filesCount: incomingFiles.length,
            category
        });

        if (incomingFiles.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No files uploaded'
            });
        }

        const containerMapping = getUploadContainerMapping();
        const containerName = containerMapping[normalizedUploadType] || 'general';
        const uploadedFiles = [];

        for (const file of incomingFiles) {
            try {
                const fileExtension = file.originalname.split('.').pop();
                const blobName = `${uuidv4()}.${fileExtension}`;

                console.log(`📁 Uploading ${file.originalname} to container: ${containerName}, blob: ${blobName}`);

                const url = await uploadToAzureBlob(file, containerName, blobName);

                const privateContainers = ['documents', 'agreements'];
                let authenticatedUrl = url;

                if (privateContainers.includes(containerName) && url.includes('blob.core.windows.net')) {
                    try {
                        const sasMinutes =
                            normalizedUploadType === 'marketing-resources'
                                ? MARKETING_RESOURCE_SAS_EXPIRES_MINUTES
                                : 60;
                        authenticatedUrl = await generateAuthenticatedUrl(url, sasMinutes);
                        console.log(`🔐 Authenticated URL for private container: ${containerName}`);
                    } catch (authError) {
                        console.warn(`⚠️ Failed to authenticate URL for ${containerName}:`, authError.message);
                    }
                }

                uploadedFiles.push({
                    fileId: blobName.split('.')[0],
                    fileName: file.originalname,
                    storedFileName: blobName,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    uploadType: normalizedUploadType,
                    entityId: entityId || 'marketplace',
                    url: authenticatedUrl,
                    containerName: containerName
                });

                console.log(`✅ File uploaded successfully: ${authenticatedUrl}`);
            } catch (uploadError) {
                console.error(`❌ Error uploading file ${file.originalname}:`, uploadError);
                uploadedFiles.push({
                    fileName: file.originalname,
                    error: uploadError.message,
                    status: 'failed'
                });
            }
        }

        const successCount = uploadedFiles.filter(f => f.url).length;
        const failCount = uploadedFiles.filter(f => f.error).length;

        if (successCount === 0) {
            const errorDetails = uploadedFiles.filter(f => f.error);
            console.error('❌ All file uploads failed:', errorDetails);
            return res.status(500).json({
                success: false,
                message: 'All file uploads failed',
                errors: errorDetails,
                details: errorDetails.map(e => `${e.fileName}: ${e.error}`).join('; ')
            });
        }

        if (incomingFiles.length === 1 && uploadedFiles[0].url) {
            const u0 = uploadedFiles[0];
            return res.json({
                success: true,
                message: 'File uploaded successfully',
                data: [{
                    url: u0.url,
                    filename: u0.storedFileName,
                    fileId: u0.fileId,
                    mimeType: u0.mimeType,
                    fileSize: u0.fileSize,
                    fileName: u0.fileName
                }],
                url: u0.url,
                filename: u0.storedFileName,
                fileId: u0.fileId
            });
        }

        res.status(201).json({
            success: true,
            message: `Successfully uploaded ${successCount} file(s)${failCount > 0 ? `, ${failCount} failed` : ''}`,
            data: uploadedFiles,
            summary: {
                total: incomingFiles.length,
                successful: successCount,
                failed: failCount
            }
        });
    } catch (error) {
        console.error('❌ Error in file upload endpoint:', error);
        res.status(500).json({
            success: false,
            message: 'File upload failed',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
}

router.post('/marketing-resources', marketingResourcesUpload.any(), (req, res) => handleMultipartUpload(req, res, 'marketing-resources'));

router.post('/', upload.any(), (req, res) => handleMultipartUpload(req, res, null));

// GET File Uploads - List files for an entity
router.get('/', async (req, res) => {
    try {
        const { uploadType, entityId, containerName } = req.query;
        
        if (!blobServiceClient) {
            return res.status(503).json({
                success: false,
                message: 'Storage service unavailable'
            });
        }

        const container = containerName || uploadType || 'general';
        const containerClient = blobServiceClient.getContainerClient(container);
        
        const blobs = [];
        
        // List blobs with prefix if entityId provided
        const listOptions = entityId ? { prefix: entityId } : {};
        
        for await (const blob of containerClient.listBlobsFlat(listOptions)) {
            blobs.push({
                name: blob.name,
                url: `${containerClient.url}/${blob.name}`,
                contentType: blob.properties.contentType,
                contentLength: blob.properties.contentLength,
                lastModified: blob.properties.lastModified,
                metadata: blob.metadata
            });
        }
        
        res.json({
            success: true,
            message: `Found ${blobs.length} files`,
            data: blobs,
            container: container
        });
        
    } catch (error) {
        console.error('❌ Error listing files:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch files',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// DELETE File - Remove from blob storage
router.delete('/:containerName/:blobName', async (req, res) => {
    try {
        const { containerName, blobName } = req.params;
        
        if (!blobServiceClient) {
            return res.status(503).json({
                success: false,
                message: 'Storage service unavailable'
            });
        }

        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.deleteIfExists();
        
        res.json({
            success: true,
            message: 'File deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Error deleting file:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to delete file',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET SAS URL for authenticated blob access
router.get('/sas/:containerName/:blobName', async (req, res) => {
    try {
        const { containerName, blobName } = req.params;
        const { permissions = 'r', expiresInMinutes = 60 } = req.query;
        
        if (!blobServiceClient) {
            return res.status(503).json({
                success: false,
                message: 'Storage service unavailable'
            });
        }

        // Generate SAS URL
        const sasUrl = generateSASUrl(containerName, blobName, permissions, parseInt(expiresInMinutes));
        
        res.json({
            success: true,
            message: 'SAS URL generated successfully',
            data: {
                url: sasUrl,
                containerName,
                blobName,
                expiresInMinutes: parseInt(expiresInMinutes),
                permissions
            }
        });
        
    } catch (error) {
        console.error('❌ Error generating SAS URL:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate SAS URL',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * GET /api/uploads/image-proxy
 * Proxy images from Azure Blob Storage to avoid CORS issues for html2canvas
 * Authorization: Public (images don't require authentication per backend-system.md)
 * Query params: url (encoded blob URL)
 * When parseBlobUrl fails (e.g. SAS or alternate URL format), falls back to HTTP fetch for Azure hosts.
 */
router.get('/image-proxy', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'Image URL is required'
            });
        }

        const blobUrl = decodeURIComponent(url);
        const parsed = parseBlobUrl(blobUrl);

        const sendImage = (imageBuffer, contentType) => {
            res.setHeader('Content-Type', contentType || 'image/png');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Content-Length', imageBuffer.length);
            return res.send(imageBuffer);
        };

        // Prefer the Azure SDK when the URL parses as a blob path AND the client
        // is configured. If the client is unavailable (e.g. local dev without
        // AZURE_STORAGE_CONNECTION_STRING) or the SDK download fails, fall
        // through to a plain HTTP fetch so publicly-readable blobs still load.
        if (parsed && blobServiceClient) {
            try {
                const { containerName, blobName } = parsed;
                const containerClient = blobServiceClient.getContainerClient(containerName);
                const blockBlobClient = containerClient.getBlockBlobClient(blobName);
                const downloadResponse = await blockBlobClient.download(0);
                const imageBuffer = await streamToBuffer(downloadResponse.readableStreamBody);
                const contentType = getContentTypeFromBlobName(blobName) || 'image/png';
                return sendImage(imageBuffer, contentType);
            } catch (sdkErr) {
                console.warn('⚠️ Image proxy: Azure SDK download failed, falling back to HTTP fetch:', sdkErr.message);
            }
        }

        // Fallback: fetch via HTTP for Azure blob URLs (no SDK client, SDK
        // failure, or non-parseable formats such as SAS / custom hosts).
        try {
            const parsedUrl = new URL(blobUrl);
            if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid image URL format'
                });
            }
            if (!parsedUrl.hostname.includes('blob.core.windows.net')) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid blob URL format'
                });
            }
            const fetchResponse = await fetch(blobUrl, { method: 'GET' });
            if (!fetchResponse.ok) {
                return res.status(fetchResponse.status).json({
                    success: false,
                    message: 'Failed to fetch image',
                    error: { code: 'IMAGE_PROXY_FETCH_ERROR' }
                });
            }
            const contentType = fetchResponse.headers.get('Content-Type') || 'image/png';
            const arrayBuffer = await fetchResponse.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            return sendImage(imageBuffer, contentType);
        } catch (fetchErr) {
            console.error('❌ Image proxy fetch fallback error:', fetchErr.message);
            return res.status(500).json({
                success: false,
                message: 'Failed to load image',
                error: { message: fetchErr.message, code: 'IMAGE_PROXY_ERROR' }
            });
        }
    } catch (error) {
        console.error('❌ Error proxying image:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load image',
            error: {
                message: error.message,
                code: 'IMAGE_PROXY_ERROR'
            }
        });
    }
});

// Helper function to convert stream to buffer
function streamToBuffer(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', (data) => chunks.push(data));
        readableStream.on('end', () => resolve(Buffer.concat(chunks)));
        readableStream.on('error', reject);
    });
}

// Helper function to determine content type from blob name
function getContentTypeFromBlobName(blobName) {
    const ext = blobName.split('.').pop()?.toLowerCase();
    const contentTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml'
    };
    return contentTypes[ext] || null;
}

// GET Health check for storage service
router.get('/health', async (req, res) => {
    try {
        if (!blobServiceClient) {
            return res.status(503).json({
                success: false,
                status: 'unavailable',
                message: 'Azure Blob Storage client not initialized'
            });
        }

        // Try to access the account properties
        const accountInfo = await blobServiceClient.getAccountInfo();
        
        res.json({
            success: true,
            status: 'healthy',
            message: 'Azure Blob Storage is connected',
            accountKind: accountInfo.accountKind,
            skuName: accountInfo.skuName
        });
        
    } catch (error) {
        res.status(503).json({
            success: false,
            status: 'unhealthy',
            message: 'Azure Blob Storage connection failed',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Service unavailable'
        });
    }
});

// Helper function to authenticate blob URLs in any object with URL fields
// NOTE: As per backend-system.md, image URLs (logos, product images) no longer require authentication
// Only authenticate document URLs (PDFs, etc.) for security
async function authenticateUrls(obj, urlFields = ['ProductDocumentUrl', 'FileUrl', 'UploadedDocumentUrl', 'PdfUrl']) {
    if (!blobServiceClient) {
        console.warn('❌ Blob service not available, returning original URLs');
        return obj;
    }

    const authenticatedObj = { ...obj };
    
    const productImageFields = ['ProductImageUrl', 'ProductLogoUrl', 'productImageUrl', 'productLogoUrl'];
    for (const field of urlFields) {
        // Handle both capitalized and lowercase field names
        const url = obj[field] || obj[field.charAt(0).toUpperCase() + field.slice(1)];
        if (url && isBlobUrl(url)) {
            try {
                console.log(`🔐 Authenticating ${field}:`, url);
                const useProductImageFallback = productImageFields.some(f => field === f || field === f.charAt(0).toUpperCase() + f.slice(1));
                const authenticatedUrl = useProductImageFallback
                    ? await generateAuthenticatedUrlForProductImageOrLogo(url)
                    : await generateAuthenticatedUrl(url);
                // Update both field name variations
                authenticatedObj[field] = authenticatedUrl;
                authenticatedObj[field.charAt(0).toUpperCase() + field.slice(1)] = authenticatedUrl;
                console.log(`✅ Authenticated ${field}:`, authenticatedUrl);
            } catch (error) {
                console.warn(`❌ Failed to authenticate ${field}:`, error.message);
            }
        }
    }

    return authenticatedObj;
}

// Helper function to authenticate a single document URL (for productDocuments array)
async function authenticateDocumentUrl(documentUrl) {
    if (!blobServiceClient || !documentUrl || !isBlobUrl(documentUrl)) return documentUrl;
    try {
        return await generateAuthenticatedUrl(documentUrl);
    } catch (error) {
        console.warn('❌ Failed to authenticate document URL:', error.message);
        return documentUrl;
    }
}

// Authenticate all document URLs in a productDocuments array
async function authenticateProductDocumentsArray(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return docs;
    return Promise.all(
        docs.map(async (doc) => {
            const rawUrl = doc.documentUrl || doc.DocumentUrl;
            const authenticatedUrl = await authenticateDocumentUrl(rawUrl);
            return {
                productDocumentId: doc.productDocumentId || doc.ProductDocumentId,
                documentUrl: authenticatedUrl,
                displayName: doc.displayName || doc.DisplayName,
                sortOrder: doc.sortOrder ?? doc.SortOrder ?? 0
            };
        })
    );
}

// Helper function to authenticate blob URLs in product data (backward compatibility)
// NOTE: As per backend-system.md, only authenticate document URLs, not images/logos
async function authenticateProductUrls(product) {
    console.log('🔍 Authenticating product document URLs for:', product.Name || product.ProductName || product.productName);
    console.log('  - ProductDocumentUrl:', product.ProductDocumentUrl || product.productDocumentUrl);
    console.log('  - productDocuments count:', product.productDocuments?.length ?? 0);
    console.log('  - ProductImageUrl (public):', product.ProductImageUrl || product.productImageUrl);
    console.log('  - ProductLogoUrl (public):', product.ProductLogoUrl || product.productLogoUrl);
    
    if (!blobServiceClient) {
        console.warn('❌ Blob service not available, returning original URLs');
        return product;
    }

    const authenticatedProduct = { ...product };

    // Product images and logos are publicly accessible - no authentication needed
    // Only authenticate document URLs for security
    
    // Authenticate ProductDocumentUrl (handle both field name variations)
    const documentUrl = product.ProductDocumentUrl || product.productDocumentUrl;
    if (documentUrl && isBlobUrl(documentUrl)) {
        try {
            console.log('🔐 Authenticating ProductDocumentUrl:', documentUrl);
            const authenticatedUrl = await generateAuthenticatedUrl(documentUrl);
            authenticatedProduct.ProductDocumentUrl = authenticatedUrl;
            authenticatedProduct.productDocumentUrl = authenticatedUrl;
            console.log('✅ Authenticated ProductDocumentUrl:', authenticatedUrl);
        } catch (error) {
            console.warn('❌ Failed to authenticate ProductDocumentUrl:', error.message);
        }
    }

    // Authenticate productDocuments array (multiple documents per product)
    if (Array.isArray(product.productDocuments) && product.productDocuments.length > 0) {
        authenticatedProduct.productDocuments = await authenticateProductDocumentsArray(product.productDocuments);
    }

    console.log('🎯 Final product URLs (images/logos public, documents authenticated):');
    console.log('  - ProductImageUrl (public):', authenticatedProduct.ProductImageUrl || authenticatedProduct.productImageUrl);
    console.log('  - ProductLogoUrl (public):', authenticatedProduct.ProductLogoUrl || authenticatedProduct.productLogoUrl);
    console.log('  - ProductDocumentUrl (authenticated):', authenticatedProduct.ProductDocumentUrl || authenticatedProduct.productDocumentUrl);
    console.log('  - productDocuments (authenticated):', authenticatedProduct.productDocuments?.length ?? 0);

    // Process nested image URLs in IDCardData and PlanDetailsData
    if (authenticatedProduct.IDCardData) {
        try {
            console.log('🖼️ Processing image URLs in IDCardData...');
            authenticatedProduct.IDCardData = await processNestedImageUrls(authenticatedProduct.IDCardData);
            console.log('✅ IDCardData image URLs processed');
        } catch (error) {
            console.warn('⚠️ Failed to process IDCardData image URLs:', error.message);
        }
    }
    
    if (authenticatedProduct.PlanDetailsData) {
        try {
            console.log('🖼️ Processing image URLs in PlanDetailsData...');
            authenticatedProduct.PlanDetailsData = await processNestedImageUrls(authenticatedProduct.PlanDetailsData);
            console.log('✅ PlanDetailsData image URLs processed');
        } catch (error) {
            console.warn('⚠️ Failed to process PlanDetailsData image URLs:', error.message);
        }
    }

    return authenticatedProduct;
}

// Helper function to check if URL is a blob URL
function isBlobUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.includes('blob.core.windows.net') || 
               urlObj.hostname.includes('storage.allaboard365.com');
    } catch {
        return false;
    }
}

// Helper function to generate authenticated URL
async function generateAuthenticatedUrl(blobUrl, expiresInMinutes = 60) {
    const parsed = parseBlobUrl(blobUrl);
    if (!parsed) {
        return blobUrl;
    }

    const sasUrl = generateSASUrl(parsed.containerName, parsed.blobName, 'r', expiresInMinutes);
    return sasUrl;
}

// Product image/logo fallback: DB may have .../products/... but uploads go to 'logos'.
// When the stored URL points at container "products", generate SAS for "logos" + same blob name
// so existing blobs in logos (from TenantAdminProducts upload flow) are served correctly.
async function generateAuthenticatedUrlForProductImageOrLogo(blobUrl) {
    const parsed = parseBlobUrl(blobUrl);
    if (!parsed) {
        return blobUrl;
    }
    let containerName = parsed.containerName;
    if (containerName === 'products') {
        containerName = 'logos';
    }
    const sasUrl = generateSASUrl(containerName, parsed.blobName, 'r', 60);
    return sasUrl;
}

/**
 * Recursively process URLs in nested objects (e.g., IDCardData, PlanDetailsData)
 * Strips expired SAS tokens from image/logo URLs in public containers
 * @param {any} obj - Object that may contain nested URLs
 * @param {string[]} imageUrlFields - Field names that contain image/logo URLs (default: ['Image', 'Logo', 'image', 'logo'])
 * @returns {any} - Object with processed URLs
 */
async function processNestedImageUrls(obj, imageUrlFields = ['Image', 'Logo', 'image', 'logo']) {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }
    
    // Handle arrays
    if (Array.isArray(obj)) {
        return await Promise.all(obj.map(item => processNestedImageUrls(item, imageUrlFields)));
    }
    
    // Create a copy to avoid mutating the original
    const processed = { ...obj };
    
    // Process each property
    for (const key in processed) {
        if (processed.hasOwnProperty(key)) {
            const value = processed[key];
            
            // Check if this field contains an image/logo URL
            if (imageUrlFields.some(field => key.includes(field) || key.endsWith(field))) {
                if (typeof value === 'string' && value.length > 0 && isBlobUrl(value)) {
                    // Strip SAS tokens from image/logo URLs (they're in public containers)
                    processed[key] = stripSasToken(value);
                }
            } else if (typeof value === 'object' && value !== null) {
                // Recursively process nested objects
                processed[key] = await processNestedImageUrls(value, imageUrlFields);
            }
        }
    }
    
    return processed;
}

/**
 * Strip SAS tokens from blob URLs
 * Since logos and images are in public containers, they don't need SAS tokens
 * @param {string} blobUrl - Blob URL that may contain SAS token
 * @returns {string} - Blob URL without SAS token
 */
function stripSasToken(blobUrl) {
    if (!blobUrl || typeof blobUrl !== 'string') {
        return blobUrl;
    }
    
    // Remove query parameters (SAS tokens) from blob URLs
    // Example: https://storage.blob.core.windows.net/container/blob.png?sv=...&sig=...
    // Becomes: https://storage.blob.core.windows.net/container/blob.png
    try {
        const url = new URL(blobUrl);
        // Only strip if it's a blob storage URL
        if (url.hostname.includes('.blob.core.windows.net')) {
            return `${url.protocol}//${url.hostname}${url.pathname}`;
        }
    } catch (e) {
        // If URL parsing fails, try simple string replacement
        const questionMarkIndex = blobUrl.indexOf('?');
        if (questionMarkIndex > 0 && blobUrl.includes('.blob.core.windows.net')) {
            return blobUrl.substring(0, questionMarkIndex);
        }
    }
    
    return blobUrl;
}

// Helper function to parse blob URL
function parseBlobUrl(blobUrl) {
    try {
        const url = new URL(blobUrl);
        // Use pathname directly to preserve URL encoding
        // pathname is automatically decoded by URL parser, so we need to re-encode
        // the path components to match the actual blob name in Azure
        const pathParts = url.pathname.split('/').filter(part => part.length > 0);
        
        if (pathParts.length >= 2) {
            // Reconstruct the blob name preserving any special characters
            // The pathname is already decoded by URL parser, which is what we want
            // because getBlockBlobClient will encode it properly
            return {
                containerName: decodeURIComponent(pathParts[0]),
                blobName: pathParts.slice(1).map(part => decodeURIComponent(part)).join('/')
            };
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

const PDF_HEADER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Download image bytes for PDF embedding: Azure SDK when URL parses as a blob path (private blobs),
 * then HTTP GET fallback (SAS URL, custom host, etc.).
 * @param {string} url
 * @returns {Promise<Buffer|null>}
 */
async function downloadBlobImageBufferForPdf(url) {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
        return null;
    }
    const trimmed = url.trim();
    const parsed = parseBlobUrl(trimmed);
    if (parsed && blobServiceClient) {
        try {
            const { containerName, blobName } = parsed;
            const containerClient = blobServiceClient.getContainerClient(containerName);
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            const downloadResponse = await blockBlobClient.download(0);
            const buf = await streamToBuffer(downloadResponse.readableStreamBody);
            if (buf && buf.length > 0 && buf.length <= PDF_HEADER_IMAGE_MAX_BYTES) {
                return buf;
            }
        } catch (e) {
            console.warn('downloadBlobImageBufferForPdf: Azure SDK failed', e.message);
        }
    }
    try {
        const res = await fetch(trimmed, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) {
            return null;
        }
        const cl = res.headers.get('content-length');
        if (cl && parseInt(cl, 10) > PDF_HEADER_IMAGE_MAX_BYTES) {
            return null;
        }
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length > PDF_HEADER_IMAGE_MAX_BYTES) {
            return null;
        }
        return buf.length > 0 ? buf : null;
    } catch (e) {
        console.warn('downloadBlobImageBufferForPdf: HTTP fetch failed', e.message);
        return null;
    }
}

// Startup verification - Check Azure connectivity
async function verifyAzureConnection() {
    if (!blobServiceClient) {
        console.warn('⚠️ Azure Blob Storage client not initialized - uploads will fail');
        console.warn('⚠️ Please set AZURE_STORAGE_CONNECTION_STRING environment variable');
        return false;
    }
    
    try {
        console.log('🔍 Verifying Azure Blob Storage connection...');
        // Try to list containers to verify connection
        const iterator = blobServiceClient.listContainers().byPage({ maxPageSize: 1 });
        await iterator.next();
        console.log('✅ Azure Blob Storage connection verified');
        return true;
    } catch (error) {
        console.error('❌ Azure Blob Storage connection verification failed:', {
            message: error.message,
            code: error.code,
            details: error.details || 'No additional details'
        });
        console.error('⚠️ File uploads will fail until Azure connectivity is restored');
        return false;
    }
}

// Run verification on module load (non-blocking)
verifyAzureConnection().catch(err => {
    console.error('❌ Failed to verify Azure connection:', err.message);
});

// Token-protected upload for unauthenticated onboarding flows (group onboarding logo, agent onboarding documents).
// Caller must send linkToken (group) or sessionToken (agent) in the form body; we validate before uploading.
const onboardingUploadRouter = express.Router();
onboardingUploadRouter.post('/', upload.any(), async (req, res) => {
    try {
        const { linkToken, sessionToken } = req.body || {};
        if (!linkToken && !sessionToken) {
            return res.status(400).json({ success: false, message: 'linkToken or sessionToken is required' });
        }
        if (linkToken && sessionToken) {
            return res.status(400).json({ success: false, message: 'Send only linkToken or sessionToken, not both' });
        }
        const pool = await getPool();
        if (linkToken) {
            const linkResult = await pool.request()
                .input('linkToken', sql.NVarChar, linkToken)
                .query("SELECT 1 FROM oe.GroupOnboardingLinks WHERE LinkToken = @linkToken AND Status = 'Active'");
            if (!linkResult.recordset || linkResult.recordset.length === 0) {
                return res.status(401).json({ success: false, message: 'Invalid or expired group onboarding link' });
            }
        } else {
            const sessionResult = await pool.request()
                .input('sessionToken', sql.NVarChar, sessionToken)
                .query(`
                    SELECT 1 FROM oe.AgentOnboardingSessions
                    WHERE SessionToken = @sessionToken
                    AND (ExpiresDate IS NULL OR ExpiresDate > GETUTCDATE())
                    AND Status NOT IN ('Completed', 'Expired')
                `);
            if (!sessionResult.recordset || sessionResult.recordset.length === 0) {
                return res.status(401).json({ success: false, message: 'Invalid or expired agent onboarding session' });
            }
        }
        const uploadType = req.body.uploadType || req.body.type || req.body.fileType;
        const entityId = req.body.entityId || 'onboarding';
        const category = req.body.category || 'general';
        const incomingFiles = Array.isArray(req.files) ? req.files : [];
        if (incomingFiles.length === 0) {
            return res.status(400).json({ success: false, message: 'No files uploaded' });
        }
        const containerMapping = getUploadContainerMapping();
        const containerName = containerMapping[uploadType] || 'general';
        const uploadedFiles = [];
        for (const file of incomingFiles) {
            try {
                const fileExtension = file.originalname.split('.').pop();
                const blobName = `${uuidv4()}.${fileExtension}`;
                const url = await uploadToAzureBlob(file, containerName, blobName);
                const privateContainers = ['documents', 'agreements'];
                let authenticatedUrl = url;
                if (privateContainers.includes(containerName) && url.includes('blob.core.windows.net')) {
                    try {
                        authenticatedUrl = await generateAuthenticatedUrl(url);
                    } catch (authError) {
                        // continue with original url
                    }
                }
                uploadedFiles.push({
                    fileId: blobName.split('.')[0],
                    fileName: file.originalname,
                    storedFileName: blobName,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    uploadType,
                    entityId,
                    url: authenticatedUrl,
                    containerName
                });
            } catch (uploadError) {
                console.error(`❌ Onboarding upload error ${file.originalname}:`, uploadError.message);
                uploadedFiles.push({ fileName: file.originalname, error: uploadError.message, status: 'failed' });
            }
        }
        const successCount = uploadedFiles.filter(f => f.url).length;
        const failCount = uploadedFiles.filter(f => f.error).length;
        if (successCount === 0) {
            return res.status(500).json({
                success: false,
                message: 'All file uploads failed',
                errors: uploadedFiles.filter(f => f.error)
            });
        }
        if (incomingFiles.length === 1 && uploadedFiles[0].url) {
            return res.json({
                success: true,
                message: 'File uploaded successfully',
                data: [{ url: uploadedFiles[0].url, filename: uploadedFiles[0].storedFileName, fileId: uploadedFiles[0].fileId }],
                url: uploadedFiles[0].url,
                filename: uploadedFiles[0].storedFileName,
                fileId: uploadedFiles[0].fileId
            });
        }
        return res.status(201).json({
            success: true,
            message: `Successfully uploaded ${successCount} file(s)${failCount > 0 ? `, ${failCount} failed` : ''}`,
            data: uploadedFiles,
            summary: { total: incomingFiles.length, successful: successCount, failed: failCount }
        });
    } catch (error) {
        console.error('❌ Onboarding upload endpoint error:', error);
        return res.status(500).json({
            success: false,
            message: 'Upload failed',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// Export the upload function for use in other modules
// Delete a single blob (best-effort). Purges staged draft uploads when a draft
// is discarded or a staged file is removed.
async function deleteAzureBlob(containerName, blobName) {
    if (!blobServiceClient) return false;
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const res = await containerClient.getBlockBlobClient(blobName).deleteIfExists();
    return !!(res && res.succeeded);
}

module.exports = {
    router,
    onboardingUploadRouter,
    uploadToAzureBlob,
    deleteAzureBlob,
    generateSASUrl,
    copyDocumentsBlobToNewName,
    DOCUMENTS_CONTAINER_NAME,
    MARKETING_RESOURCE_SAS_EXPIRES_MINUTES,
    generateAuthenticatedUrl,
    verifyAzureConnection,
    isBlobUrl,
    authenticateProductUrls,
    authenticateProductDocumentsArray,
    authenticateUrls,
    stripSasToken,
    processNestedImageUrls,
    downloadBlobImageBufferForPdf
};
