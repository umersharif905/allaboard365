const express = require('express');
const multer = require('multer');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize, requireTenantAccess } = require('../../../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { MAX_UPLOAD_FILE_BYTES } = require('../../../constants/uploadLimits');

// Configure multer for file uploads (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_FILE_BYTES,
    },
    fileFilter: (req, file, cb) => {
        // Only allow PDF, DOC, DOCX files
        const allowedTypes = {
            'application/pdf': '.pdf',
            'application/msword': '.doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
        };

        if (allowedTypes[file.mimetype]) {
            cb(null, true);
        } else {
            cb(new Error(`File type ${file.mimetype} not allowed. Only PDF, DOC, and DOCX files are supported.`));
        }
    }
});

// Helper function to upload to Azure Blob Storage
async function uploadToAzureBlob(file, containerName, blobName) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
        throw new Error('Azure Storage connection string not configured');
    }
    
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    
    // Create container if it doesn't exist
    await containerClient.createIfNotExists();
    
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    await blockBlobClient.upload(file.buffer, file.size, {
        blobHTTPHeaders: {
            blobContentType: file.mimetype
        },
        metadata: {
            originalName: file.originalname,
            uploadedBy: 'allaboard365-system'
        }
    });
    
    return blockBlobClient.url;
}

// GET /api/me/tenant-admin/agent-onboarding/documents
// Get all agent agreement documents for the current tenant
router.get('/documents', authenticate, authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const pool = await getPool();
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user.TenantId;
        
        const query = `
            SELECT 
                FileId,
                FileName,
                StoredFileName,
                FilePath,
                FileSize,
                MimeType,
                Description,
                CreatedDate,
                ModifiedDate
            FROM oe.FileUploads
            WHERE TenantId = @tenantId
                AND UploadType = 'agentAgreement'
                AND Category = 'Required Document'
                AND Status = 'Active'
            ORDER BY CreatedDate DESC
        `;
        
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const result = await request.query(query);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching agent agreement documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch agent agreement documents',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// POST /api/me/tenant-admin/agent-onboarding/documents
// Upload a new agent agreement document
router.post('/documents', authenticate, authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }
        
        const pool = await getPool();
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user.TenantId;
        const userId = req.user.UserId;
        
        // Allow multiple documents - no need to deactivate existing ones
        
        // Upload file to Azure Blob Storage
        const fileId = uuidv4();
        // Use safe filename without special characters for blob storage
        const storedFileName = `${fileId}_${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const containerName = 'agreements';
        const blobName = `agent-agreements/${tenantId}/${storedFileName}`;
        
        // Actually upload the file to Azure Blob Storage
        const fileUrl = await uploadToAzureBlob(req.file, containerName, blobName);
        
        // Save file metadata to database
        const insertQuery = `
            INSERT INTO oe.FileUploads (
                FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
                UploadType, EntityId, Category, Description, UploadedBy, TenantId, Status, CreatedDate
            ) VALUES (
                @fileId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
                @uploadType, @entityId, @category, @description, @uploadedBy, @tenantId, @status, @createdDate
            )
        `;
        
        const insertRequest = pool.request();
        insertRequest.input('fileId', sql.UniqueIdentifier, fileId);
        insertRequest.input('fileName', sql.NVarChar, req.file.originalname);
        insertRequest.input('storedFileName', sql.NVarChar, storedFileName);
        insertRequest.input('filePath', sql.NVarChar, fileUrl);
        insertRequest.input('fileSize', sql.Int, req.file.size);
        insertRequest.input('mimeType', sql.NVarChar, req.file.mimetype);
        insertRequest.input('uploadType', sql.NVarChar, 'agentAgreement');
        insertRequest.input('entityId', sql.NVarChar, tenantId);
        insertRequest.input('category', sql.NVarChar, 'Required Document');
        insertRequest.input('description', sql.NVarChar, 'Agent required document');
        insertRequest.input('uploadedBy', sql.UniqueIdentifier, userId);
        insertRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        insertRequest.input('status', sql.NVarChar, 'Active');
        insertRequest.input('createdDate', sql.DateTime2, new Date());
        
        await insertRequest.query(insertQuery);
        
        console.log(`✅ Agent agreement document uploaded: ${req.file.originalname} for tenant ${tenantId}`);
        
        res.json({
            success: true,
            message: 'Agent agreement document uploaded successfully',
            data: {
                fileId,
                fileName: req.file.originalname,
                fileUrl,
                fileSize: req.file.size,
                mimeType: req.file.mimetype
            }
        });
        
    } catch (error) {
        console.error('❌ Error uploading agent agreement document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload agent agreement document',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// DELETE /api/me/tenant-admin/agent-onboarding/documents/:fileId
// Delete an agent agreement document
router.delete('/documents/:fileId', authenticate, authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const pool = await getPool();
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user.TenantId;
        const userId = req.user.UserId;
        const { fileId } = req.params;
        
        // Soft delete the file record
        const deleteQuery = `
            UPDATE oe.FileUploads 
            SET Status = 'Inactive', ModifiedDate = GETDATE(), ModifiedBy = @userId
            WHERE FileId = @fileId 
                AND TenantId = @tenantId 
                AND UploadType = 'agentAgreement'
        `;
        
        const request = pool.request();
        request.input('fileId', sql.UniqueIdentifier, fileId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        request.input('userId', sql.UniqueIdentifier, userId);
        
        const result = await request.query(deleteQuery);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent agreement document not found'
            });
        }
        
        console.log(`✅ Agent agreement document deleted: ${fileId} for tenant ${tenantId}`);
        
        res.json({
            success: true,
            message: 'Agent agreement document deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Error deleting agent agreement document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete agent agreement document',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;
