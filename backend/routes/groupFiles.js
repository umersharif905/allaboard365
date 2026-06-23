// File: backend/routes/groupFiles.js
// Document Management for Groups
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize , getUserRoles } = require('../middleware/auth');
const logger = require('../config/logger');
const { GROUP_DETAIL_READ_STATUS_SQL } = require('../utils/groupRouteAccess');

// Audit logging function
const auditLog = async (userId, action, description, details = {}) => {
    try {
        const pool = await getPool();
        await pool.request()
            .input('UserId', sql.UniqueIdentifier, userId)
            .input('Action', sql.NVarChar, action)
            .input('Description', sql.NVarChar, description)
            .input('Details', sql.NVarChar, JSON.stringify(details))
            .input('CreatedDate', sql.DateTime2, new Date())
            .query(`
                INSERT INTO oe.AuditLogs (UserId, Action, Description, Details, CreatedDate)
                VALUES (@UserId, @Action, @Description, @Details, @CreatedDate)
            `);
    } catch (error) {
        console.error('❌ Audit logging failed:', error);
    }
};

// GET /api/groups/:groupId/documents - Get all documents for a group
router.get('/:groupId/documents', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        console.log(`📄 GET /api/groups/${req.params.groupId}/documents - Fetching documents`);
        
        const { groupId } = req.params;
        console.log(`🔍 DEBUG: Fetching documents for group ID ${groupId}, roles: ${getUserRoles(req.user).join(',')}, tenantId: ${req.user?.TenantId}`);
        const pool = await getPool();
        const request = pool.request();
        
        // Validate group access and tenant isolation
        let groupCheckQuery = `
            SELECT g.GroupId, g.Name, g.TenantId 
            FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        request.input('groupId', sql.UniqueIdentifier, groupId);
        
        // Non-SysAdmin users can only access their tenant's groups
        // if (!getUserRoles(req.user).includes('SysAdmin')) {
        //     groupCheckQuery += ' AND g.TenantId = @userTenantId';
        //     request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        // }
        
        const groupResult = await request.query(groupCheckQuery);
        console.log(`🔍 DEBUG: Group query result: ${JSON.stringify(groupResult.recordset)}`);
        
        if (groupResult.recordset.length === 0) {
            console.log(`❌ DEBUG: Group not found: ${groupId}`);
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        // Get documents for the group
        const documentsQuery = `
            SELECT 
                f.FileId as DocumentId,
                f.EntityId as GroupId,
                f.FileName,
                f.MimeType as FileType,
                f.FileSize,
                f.Category as DocumentType,
                f.Description,
                f.CreatedDate as UploadedDate,
                f.UploadedBy,
                f.FilePath as Url,
                f.Status,
                f.StoredFileName,
                CASE 
                    WHEN CHARINDEX('/', f.FilePath) > 0 
                    THEN SUBSTRING(f.FilePath, 1, CHARINDEX('/', f.FilePath) - 1)
                    ELSE 'documents'
                END as ContainerName,
                -- Get uploader name
                CONCAT(u.FirstName, ' ', u.LastName) as UploadedByName
            FROM oe.FileUploads f
            LEFT JOIN oe.Users u ON f.UploadedBy = u.UserId
            WHERE TRY_CAST(f.EntityId AS UNIQUEIDENTIFIER) = @groupId 
                AND f.UploadType = 'documents'
                AND f.Status = 'Active'
            ORDER BY f.CreatedDate DESC
        `;
        
        const request2 = pool.request();
        request2.input('groupId', sql.UniqueIdentifier, groupId);
        
        const documentsResult = await request2.query(documentsQuery);
        
        console.log(`✅ Found ${documentsResult.recordset.length} documents for group ${groupId}`);
        
        // Authenticate document URLs before returning (generate fresh SAS tokens)
        let authenticatedDocuments = documentsResult.recordset;
        try {
            const uploadsModule = require('./uploads');
            const { generateAuthenticatedUrl, isBlobUrl } = uploadsModule;
            
            if (generateAuthenticatedUrl && isBlobUrl) {
                authenticatedDocuments = await Promise.all(
                    documentsResult.recordset.map(async (doc) => {
                        let authenticatedUrl = doc.Url;
                        if (doc.Url && isBlobUrl(doc.Url)) {
                            try {
                                authenticatedUrl = await generateAuthenticatedUrl(doc.Url);
                            } catch (error) {
                                console.warn(`⚠️ Failed to authenticate document URL for ${doc.DocumentId}:`, error.message);
                                // Keep original URL if authentication fails
                            }
                        }
                        return {
                            ...doc,
                            Url: authenticatedUrl
                        };
                    })
                );
            } else {
                console.warn('⚠️ generateAuthenticatedUrl or isBlobUrl not available from uploads module');
            }
        } catch (error) {
            console.error('❌ Error requiring uploads module or authenticating URLs:', error);
            // Continue with unauthenticated URLs if there's an error
            authenticatedDocuments = documentsResult.recordset;
        }
        
        res.json({
            success: true,
            data: authenticatedDocuments
        });
        
    } catch (error) {
        console.error('❌ Error fetching group documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch documents',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// POST /api/groups/:groupId/documents - Save document metadata after upload
router.post('/:groupId/documents', authorize(['TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        console.log(`📄 POST /api/groups/${req.params.groupId}/documents - Saving document metadata`);
        
        const { groupId } = req.params;
        const {
            fileName,
            fileType,
            fileSize,
            documentType,
            description,
            url,
            storedFileName,
            containerName
        } = req.body;
        
        // Validate required fields
        if (!fileName || !fileType || !fileSize || !documentType) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: fileName, fileType, fileSize, documentType'
            });
        }
        
        const pool = await getPool();
        const request = pool.request();
        
        // Validate group access and tenant isolation
        let groupCheckQuery = `
            SELECT g.GroupId, g.Name, g.TenantId 
            FROM oe.Groups g
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        request.input('groupId', sql.UniqueIdentifier, groupId);
        
        // Non-SysAdmin users can only access their tenant's groups
        // if (!getUserRoles(req.user).includes('SysAdmin')) {
        //     groupCheckQuery += ' AND g.TenantId = @userTenantId';
        //     request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        // }
        
        const groupResult = await request.query(groupCheckQuery);
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        const group = groupResult.recordset[0];
        
        // Insert document metadata
        const documentId = require('crypto').randomUUID();
        
        const insertQuery = `
            INSERT INTO oe.FileUploads (
                FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
                UploadType, EntityId, Category, Description, UploadedBy, TenantId, Status, CreatedDate
            ) VALUES (
                @documentId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
                @uploadType, @entityId, @category, @description, @uploadedBy, @tenantId, @status, @createdDate
            )
        `;
        
        const request2 = pool.request();
        request2.input('documentId', sql.UniqueIdentifier, documentId);
        request2.input('fileName', sql.NVarChar, fileName);
        request2.input('storedFileName', sql.NVarChar, storedFileName || fileName);
        request2.input('filePath', sql.NVarChar, url || `groups/${groupId}/${storedFileName || fileName}`);
        request2.input('fileSize', sql.Int, fileSize);
        request2.input('mimeType', sql.NVarChar, fileType);
        request2.input('uploadType', sql.NVarChar, 'documents');
        request2.input('entityId', sql.NVarChar, groupId);
        request2.input('category', sql.NVarChar, documentType);
        request2.input('description', sql.NVarChar, description || null);
        request2.input('uploadedBy', sql.UniqueIdentifier, req.user.UserId);
        request2.input('tenantId', sql.UniqueIdentifier, group.TenantId);
        request2.input('status', sql.NVarChar, 'Active');
        request2.input('createdDate', sql.DateTime2, new Date());
        
        await request2.query(insertQuery);
        
        // Log the activity
        await auditLog(req.user.UserId, 'DOCUMENT_UPLOAD', 'Document uploaded', {
            documentId,
            fileName,
            documentType,
            groupId,
            fileSize
        });
        
        console.log(`✅ Document metadata saved: ${fileName} for group ${groupId}`);
        
        res.status(201).json({
            success: true,
            message: 'Document metadata saved successfully',
            data: {
                documentId,
                fileName,
                documentType
            }
        });
        
    } catch (error) {
        console.error('❌ Error saving document metadata:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save document metadata',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// DELETE /api/groups/:groupId/documents/:documentId - Delete a document
router.delete('/:groupId/documents/:documentId', authorize(['TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        console.log(`🗑️ DELETE /api/groups/${req.params.groupId}/documents/${req.params.documentId}`);
        
        const { groupId, documentId } = req.params;
        const pool = await getPool();
        const request = pool.request();
        
        // Validate group access and get document details
        let query = `
            SELECT 
                f.FileId,
                f.FileName,
                f.FilePath,
                f.TenantId,
                g.GroupId,
                g.Name as GroupName
            FROM oe.FileUploads f
            INNER JOIN oe.Groups g ON f.EntityId = g.GroupId
            WHERE f.FileId = @documentId 
                AND f.EntityId = @groupId 
                AND f.UploadType = 'documents'
                AND f.Status = 'Active'
        `;
        
        request.input('documentId', sql.UniqueIdentifier, documentId);
        request.input('groupId', sql.UniqueIdentifier, groupId);
        
        // Non-SysAdmin users can only access their tenant's documents
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            query += ' AND f.TenantId = @userTenantId';
            request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Document not found or access denied'
            });
        }
        
        const document = result.recordset[0];
        
        // Soft delete the document
        const deleteQuery = `
            UPDATE oe.FileUploads 
            SET Status = 'Deleted', 
                ModifiedDate = @modifiedDate,
                ModifiedBy = @modifiedBy
            WHERE FileId = @documentId
        `;
        
        const request2 = pool.request();
        request2.input('documentId', sql.UniqueIdentifier, documentId);
        request2.input('modifiedDate', sql.DateTime2, new Date());
        request2.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        
        await request2.query(deleteQuery);
        
        // Log the activity
        await auditLog(req.user.UserId, 'DOCUMENT_DELETE', 'Document deleted', {
            documentId,
            fileName: document.FileName,
            groupId,
            groupName: document.GroupName
        });
        
        console.log(`✅ Document deleted: ${document.FileName} from group ${groupId}`);
        
        res.json({
            success: true,
            message: 'Document deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Error deleting document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete document',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET /api/groups/:groupId/documents/:documentId/download - Download a document
router.get('/:groupId/documents/:documentId/download', authorize(['TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        console.log(`⬇️ GET /api/groups/${req.params.groupId}/documents/${req.params.documentId}/download`);
        
        const { groupId, documentId } = req.params;
        const pool = await getPool();
        const request = pool.request();
        
        // Get document details
        let query = `
            SELECT 
                f.FileId,
                f.FileName,
                f.FilePath,
                f.MimeType,
                f.TenantId
            FROM oe.FileUploads f
            INNER JOIN oe.Groups g ON f.EntityId = g.GroupId
            WHERE f.FileId = @documentId 
                AND f.EntityId = @groupId 
                AND f.UploadType = 'documents'
                AND f.Status = 'Active'
        `;
        
        request.input('documentId', sql.UniqueIdentifier, documentId);
        request.input('groupId', sql.UniqueIdentifier, groupId);
        
        // Non-SysAdmin users can only access their tenant's documents
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            query += ' AND f.TenantId = @userTenantId';
            request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Document not found or access denied'
            });
        }
        
        const document = result.recordset[0];
        
        // Generate fresh SAS token for download (tokens expire, so always generate fresh)
        const { generateAuthenticatedUrl, isBlobUrl } = require('./uploads');
        let downloadUrl = document.FilePath;
        
        if (document.FilePath && isBlobUrl(document.FilePath)) {
            try {
                downloadUrl = await generateAuthenticatedUrl(document.FilePath);
                console.log('🔐 Generated fresh authenticated URL for document download');
            } catch (error) {
                console.error('❌ Failed to authenticate document URL for download:', error.message);
                // Return original URL if authentication fails (may not work if expired)
                downloadUrl = document.FilePath;
            }
        }
        
        res.json({
            success: true,
            data: {
                downloadUrl: downloadUrl,
                fileName: document.FileName,
                mimeType: document.MimeType
            }
        });
        
    } catch (error) {
        console.error('❌ Error downloading document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to download document',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;