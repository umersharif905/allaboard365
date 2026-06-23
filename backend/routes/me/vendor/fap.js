// routes/me/vendor/fap.js
// FAP Management routes for Vendor Portal

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { requireShareRequestAccess } = require('../../../middleware/shareRequestAccess');
const FAPService = require('../../../services/fapService');
const multer = require('multer');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const { MAX_UPLOAD_FILE_BYTES } = require('../../../constants/uploadLimits');

// All routes require authentication and vendor access
router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent', 'Agent', 'SysAdmin']));
router.use(requireShareRequestAccess);

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_FILE_BYTES,
        files: 5
    }
});

// Initialize Azure Blob Service Client
let blobServiceClient;
try {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (connectionString) {
        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    }
} catch (error) {
    console.error('❌ Failed to initialize Azure Blob Storage client:', error.message);
}

// Helper function to upload to Azure Blob Storage
async function uploadToAzureBlob(file, containerName, blobName) {
    if (!blobServiceClient) {
        throw new Error('Azure Blob Storage client not initialized');
    }
    
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists({ access: 'blob' });
    
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    await blockBlobClient.upload(file.buffer, file.size, {
        blobHTTPHeaders: { blobContentType: file.mimetype },
        metadata: { originalName: file.originalname }
    });
    
    return blockBlobClient.url;
}

// Helper function to generate authenticated URL
function generateAuthenticatedUrl(blobUrl, containerName, blobName) {
    if (!blobServiceClient) return blobUrl;
    
    try {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blobClient = containerClient.getBlobClient(blobName);
        
        const sasToken = generateBlobSASQueryParameters({
            containerName,
            blobName,
            permissions: BlobSASPermissions.parse('r'),
            startsOn: new Date(),
            expiresOn: new Date(new Date().valueOf() + 3600 * 1000) // 1 hour
        }, blobServiceClient.credential);
        
        return `${blobClient.url}?${sasToken.toString()}`;
    } catch (error) {
        console.error('Error generating authenticated URL:', error);
        return blobUrl;
    }
}

// ============================================================================
// FAP SETTINGS
// ============================================================================

/**
 * GET /api/me/vendor/providers/:providerId/fap/settings
 * Get FAP settings for a provider
 */
router.get('/providers/:providerId/fap/settings', async (req, res) => {
    try {
        const settings = await FAPService.getFAPSettings(
            req.params.providerId,
            req.vendor.VendorId
        );
        
        // Transform database PascalCase fields to camelCase for frontend
        const transformedSettings = settings ? {
            providerId: settings.ProviderId,
            vendorId: settings.VendorId,
            fapSettingsId: settings.FAPSettingsId,
            fapWebsiteUrl: settings.FAPWebsiteUrl,
            fapFormUrl: settings.FAPFormUrl,
            fapInstructionsUrl: settings.FAPInstructionsUrl,
            primaryContactName: settings.PrimaryContactName,
            primaryContactPhone: settings.PrimaryContactPhone,
            primaryContactEmail: settings.PrimaryContactEmail,
            faxNumber: settings.FaxNumber,
            officeHours: settings.OfficeHours,
            expectedProcessingTimeDays: settings.ExpectedProcessingTimeDays,
            requiredDocumentation: settings.RequiredDocumentation,
            providerSpecificRules: settings.ProviderSpecificRules,
            createdDate: settings.CreatedDate,
            createdBy: settings.CreatedBy,
            createdByFirstName: settings.CreatedByFirstName,
            createdByLastName: settings.CreatedByLastName,
            modifiedDate: settings.ModifiedDate,
            modifiedBy: settings.ModifiedBy,
            modifiedByFirstName: settings.ModifiedByFirstName,
            modifiedByLastName: settings.ModifiedByLastName
        } : null;
        
        res.json({
            success: true,
            data: transformedSettings
        });
    } catch (error) {
        console.error('❌ Error fetching FAP settings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch FAP settings',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/providers/:providerId/fap/settings
 * Create or update FAP settings
 */
router.put('/providers/:providerId/fap/settings', async (req, res) => {
    try {
        const settings = await FAPService.upsertFAPSettings(
            req.params.providerId,
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );
        
        res.json({
            success: true,
            data: settings,
            message: 'FAP settings saved successfully'
        });
    } catch (error) {
        console.error('❌ Error saving FAP settings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save FAP settings',
            error: error.message
        });
    }
});

// ============================================================================
// FAP SUBMISSIONS
// ============================================================================

/**
 * GET /api/me/vendor/providers/:providerId/fap/submissions
 * Get FAP submissions for a provider
 */
router.get('/providers/:providerId/fap/submissions', async (req, res) => {
    try {
        const result = await FAPService.getFAPSubmissions(
            req.params.providerId,
            req.vendor.VendorId,
            {
                page: req.query.page,
                limit: req.query.limit,
                status: req.query.status,
                sortBy: req.query.sortBy,
                sortOrder: req.query.sortOrder
            }
        );
        
        res.json({
            success: true,
            data: result.data,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('❌ Error fetching FAP submissions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch FAP submissions',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/fap/submissions/:submissionId
 * Get a single FAP submission
 */
router.get('/fap/submissions/:submissionId', async (req, res) => {
    try {
        const submission = await FAPService.getFAPSubmissionById(
            req.params.submissionId,
            req.vendor.VendorId
        );
        
        if (!submission) {
            return res.status(404).json({
                success: false,
                message: 'FAP submission not found'
            });
        }
        
        res.json({
            success: true,
            data: submission
        });
    } catch (error) {
        console.error('❌ Error fetching FAP submission:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch FAP submission',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/providers/:providerId/fap/submissions
 * Create a new FAP submission
 */
router.post('/providers/:providerId/fap/submissions', async (req, res) => {
    try {
        const submission = await FAPService.createFAPSubmission(
            req.params.providerId,
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );
        
        res.status(201).json({
            success: true,
            data: submission,
            message: 'FAP submission created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating FAP submission:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create FAP submission',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/fap/submissions/:submissionId
 * Update a FAP submission
 */
router.put('/fap/submissions/:submissionId', async (req, res) => {
    try {
        const result = await FAPService.updateFAPSubmission(
            req.params.submissionId,
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }
        
        res.json({
            success: true,
            data: result.data,
            message: 'FAP submission updated successfully'
        });
    } catch (error) {
        console.error('❌ Error updating FAP submission:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update FAP submission',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/fap/submissions/:submissionId
 * Delete a FAP submission
 */
router.delete('/fap/submissions/:submissionId', async (req, res) => {
    try {
        const result = await FAPService.deleteFAPSubmission(
            req.params.submissionId,
            req.vendor.VendorId
        );
        
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: 'FAP submission not found'
            });
        }
        
        res.json({
            success: true,
            message: 'FAP submission deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting FAP submission:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete FAP submission',
            error: error.message
        });
    }
});

// ============================================================================
// FAP DOCUMENTS
// ============================================================================

/**
 * GET /api/me/vendor/providers/:providerId/fap/documents
 * Get FAP documents for a provider
 */
router.get('/providers/:providerId/fap/documents', async (req, res) => {
    try {
        const documents = await FAPService.getFAPDocuments(
            req.params.providerId,
            null,
            req.vendor.VendorId
        );
        
        // Generate authenticated URLs
        const documentsWithUrls = documents.map(doc => ({
            ...doc,
            AuthenticatedUrl: doc.BlobPath 
                ? generateAuthenticatedUrl(doc.BlobUrl, 'fap-documents', doc.BlobPath)
                : doc.BlobUrl
        }));
        
        res.json({
            success: true,
            data: documentsWithUrls
        });
    } catch (error) {
        console.error('❌ Error fetching FAP documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch FAP documents',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/fap/submissions/:submissionId/documents
 * Get FAP documents for a submission
 */
router.get('/fap/submissions/:submissionId/documents', async (req, res) => {
    try {
        const documents = await FAPService.getFAPDocuments(
            null,
            req.params.submissionId,
            req.vendor.VendorId
        );
        
        // Generate authenticated URLs
        const documentsWithUrls = documents.map(doc => ({
            ...doc,
            AuthenticatedUrl: doc.BlobPath 
                ? generateAuthenticatedUrl(doc.BlobUrl, 'fap-documents', doc.BlobPath)
                : doc.BlobUrl
        }));
        
        res.json({
            success: true,
            data: documentsWithUrls
        });
    } catch (error) {
        console.error('❌ Error fetching FAP documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch FAP documents',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/providers/:providerId/fap/documents
 * Upload FAP document for a provider
 */
router.post('/providers/:providerId/fap/documents', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }
        
        const file = req.file;
        const blobName = `providers/${req.params.providerId}/${uuidv4()}-${file.originalname}`;
        const blobUrl = await uploadToAzureBlob(file, 'fap-documents', blobName);
        
        const document = await FAPService.createFAPDocument(
            req.params.providerId,
            null,
            req.vendor.VendorId,
            {
                documentName: req.body.documentName || file.originalname,
                documentType: req.body.documentType,
                fileName: file.originalname,
                fileSize: file.size,
                mimeType: file.mimetype,
                blobUrl: blobUrl,
                blobPath: blobName,
                description: req.body.description
            },
            req.user.UserId
        );
        
        res.status(201).json({
            success: true,
            data: document,
            message: 'Document uploaded successfully'
        });
    } catch (error) {
        console.error('❌ Error uploading FAP document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload document',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/fap/submissions/:submissionId/documents
 * Upload FAP document for a submission
 */
router.post('/fap/submissions/:submissionId/documents', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }
        
        const file = req.file;
        const blobName = `submissions/${req.params.submissionId}/${uuidv4()}-${file.originalname}`;
        const blobUrl = await uploadToAzureBlob(file, 'fap-documents', blobName);
        
        // Get provider ID from submission
        const submission = await FAPService.getFAPSubmissionById(
            req.params.submissionId,
            req.vendor.VendorId
        );
        
        if (!submission) {
            return res.status(404).json({
                success: false,
                message: 'FAP submission not found'
            });
        }
        
        const document = await FAPService.createFAPDocument(
            submission.ProviderId,
            req.params.submissionId,
            req.vendor.VendorId,
            {
                documentName: req.body.documentName || file.originalname,
                documentType: req.body.documentType,
                fileName: file.originalname,
                fileSize: file.size,
                mimeType: file.mimetype,
                blobUrl: blobUrl,
                blobPath: blobName,
                description: req.body.description
            },
            req.user.UserId
        );
        
        res.status(201).json({
            success: true,
            data: document,
            message: 'Document uploaded successfully'
        });
    } catch (error) {
        console.error('❌ Error uploading FAP document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload document',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/fap/documents/:documentId
 * Delete a FAP document
 */
router.delete('/fap/documents/:documentId', async (req, res) => {
    try {
        const result = await FAPService.deleteFAPDocument(
            req.params.documentId,
            req.vendor.VendorId
        );
        
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Document deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting FAP document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete document',
            error: error.message
        });
    }
});

// ============================================================================
// FAP NOTES
// ============================================================================

/**
 * GET /api/me/vendor/providers/:providerId/fap/notes
 * Get FAP notes for a provider
 */
router.get('/providers/:providerId/fap/notes', async (req, res) => {
    try {
        const notes = await FAPService.getFAPNotes(
            req.params.providerId,
            null,
            req.vendor.VendorId,
            {
                page: req.query.page,
                limit: req.query.limit
            }
        );
        
        // Transform database PascalCase fields to camelCase for frontend
        const transformedNotes = notes.map(note => ({
            noteId: note.NoteId || note.noteId,
            providerId: note.ProviderId || note.providerId,
            submissionId: note.SubmissionId || note.submissionId,
            vendorId: note.VendorId || note.vendorId,
            noteType: note.NoteType || note.noteType,
            contactMethod: note.ContactMethod || note.contactMethod,
            personContacted: note.PersonContacted || note.personContacted,
            note: note.Note || note.note,
            nextFollowUpDate: note.NextFollowUpDate || note.nextFollowUpDate,
            isInternal: note.IsInternal !== undefined ? note.IsInternal : (note.isInternal !== undefined ? note.isInternal : false),
            createdDate: note.CreatedDate || note.createdDate,
            createdBy: note.CreatedBy || note.createdBy,
            createdByName: note.CreatedByName || note.createdByName,
            createdByFirstName: note.CreatedByFirstName || note.createdByFirstName,
            createdByLastName: note.CreatedByLastName || note.createdByLastName,
        }));
        
        res.json({
            success: true,
            data: transformedNotes
        });
    } catch (error) {
        console.error('❌ Error fetching FAP notes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch FAP notes',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/fap/submissions/:submissionId/notes
 * Get FAP notes for a submission
 */
router.get('/fap/submissions/:submissionId/notes', async (req, res) => {
    try {
        const notes = await FAPService.getFAPNotes(
            null,
            req.params.submissionId,
            req.vendor.VendorId,
            {
                page: req.query.page,
                limit: req.query.limit
            }
        );
        
        res.json({
            success: true,
            data: notes
        });
    } catch (error) {
        console.error('❌ Error fetching FAP notes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch FAP notes',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/providers/:providerId/fap/notes
 * Create FAP note for a provider
 */
router.post('/providers/:providerId/fap/notes', async (req, res) => {
    try {
        const note = await FAPService.createFAPNote(
            req.params.providerId,
            null,
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );
        
        res.status(201).json({
            success: true,
            data: note,
            message: 'Note created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating FAP note:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create note',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/fap/submissions/:submissionId/notes
 * Create FAP note for a submission
 */
router.post('/fap/submissions/:submissionId/notes', async (req, res) => {
    try {
        // Get provider ID from submission
        const submission = await FAPService.getFAPSubmissionById(
            req.params.submissionId,
            req.vendor.VendorId
        );
        
        if (!submission) {
            return res.status(404).json({
                success: false,
                message: 'FAP submission not found'
            });
        }
        
        const note = await FAPService.createFAPNote(
            submission.ProviderId,
            req.params.submissionId,
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );
        
        res.status(201).json({
            success: true,
            data: note,
            message: 'Note created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating FAP note:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create note',
            error: error.message
        });
    }
});

// ============================================================================
// PROVIDER RANKINGS
// ============================================================================

/**
 * GET /api/me/vendor/providers/:providerId/fap/rankings
 * Get all provider rankings (multiple rankings per provider)
 */
router.get('/providers/:providerId/fap/rankings', async (req, res) => {
    try {
        const rankings = await FAPService.getProviderRankings(
            req.params.providerId,
            req.vendor.VendorId
        );
        
        // Transform database PascalCase fields to camelCase for frontend
        const transformedRankings = rankings.map(ranking => ({
            rankingId: ranking.RankingId || ranking.rankingId,
            providerId: ranking.ProviderId || ranking.providerId,
            vendorId: ranking.VendorId || ranking.vendorId,
            shareRequestId: ranking.ShareRequestId || ranking.shareRequestId || null,
            shareRequestNumber: ranking.ShareRequestNumber || ranking.shareRequestNumber || null,
            fairPricingRating: ranking.FairPricingRating !== undefined ? ranking.FairPricingRating : (ranking.fairPricingRating !== undefined ? ranking.fairPricingRating : null),
            communicationRating: ranking.CommunicationRating !== undefined ? ranking.CommunicationRating : (ranking.communicationRating !== undefined ? ranking.communicationRating : null),
            negotiationRating: ranking.NegotiationRating !== undefined ? ranking.NegotiationRating : (ranking.negotiationRating !== undefined ? ranking.negotiationRating : null),
            fairPricingNotes: ranking.FairPricingNotes || ranking.fairPricingNotes || null,
            communicationNotes: ranking.CommunicationNotes || ranking.communicationNotes || null,
            negotiationNotes: ranking.NegotiationNotes || ranking.negotiationNotes || null,
            rankedBy: ranking.RankedBy || ranking.rankedBy || 'Vendor',
            memberId: ranking.MemberId || ranking.memberId || null,
            createdDate: ranking.CreatedDate || ranking.createdDate,
            createdBy: ranking.CreatedBy || ranking.createdBy,
            createdByFirstName: ranking.CreatedByFirstName || ranking.createdByFirstName,
            createdByLastName: ranking.CreatedByLastName || ranking.createdByLastName,
            modifiedDate: ranking.ModifiedDate || ranking.modifiedDate,
            modifiedBy: ranking.ModifiedBy || ranking.modifiedBy,
            modifiedByFirstName: ranking.ModifiedByFirstName || ranking.modifiedByFirstName,
            modifiedByLastName: ranking.ModifiedByLastName || ranking.modifiedByLastName,
        }));
        
        res.json({
            success: true,
            data: transformedRankings
        });
    } catch (error) {
        console.error('❌ Error fetching provider rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch provider rankings',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/providers/:providerId/fap/share-requests
 * Get ShareRequests linked to this provider (for ranking dropdown)
 */
router.get('/providers/:providerId/fap/share-requests', async (req, res) => {
    try {
        const shareRequests = await FAPService.getProviderShareRequests(
            req.params.providerId,
            req.vendor.VendorId
        );
        
        const transformedShareRequests = shareRequests.map(sr => ({
            shareRequestId: sr.ShareRequestId,
            requestNumber: sr.RequestNumber,
            requestName: sr.RequestName,
            status: sr.Status,
            submittedDate: sr.SubmittedDate,
            dateOfService: sr.DateOfService,
        }));
        
        res.json({
            success: true,
            data: transformedShareRequests
        });
    } catch (error) {
        console.error('❌ Error fetching provider share requests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch share requests',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/providers/:providerId/fap/rankings
 * Create a new provider ranking
 */
router.post('/providers/:providerId/fap/rankings', async (req, res) => {
    try {
        const ranking = await FAPService.createProviderRanking(
            req.params.providerId,
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );
        
        // Transform response
        const transformedRanking = ranking ? {
            rankingId: ranking.RankingId || ranking.rankingId,
            providerId: ranking.ProviderId || ranking.providerId,
            vendorId: ranking.VendorId || ranking.vendorId,
            shareRequestId: ranking.ShareRequestId || ranking.shareRequestId || null,
            shareRequestNumber: ranking.ShareRequestNumber || ranking.shareRequestNumber || null,
            fairPricingRating: ranking.FairPricingRating !== undefined ? ranking.FairPricingRating : (ranking.fairPricingRating !== undefined ? ranking.fairPricingRating : null),
            communicationRating: ranking.CommunicationRating !== undefined ? ranking.CommunicationRating : (ranking.communicationRating !== undefined ? ranking.communicationRating : null),
            negotiationRating: ranking.NegotiationRating !== undefined ? ranking.NegotiationRating : (ranking.negotiationRating !== undefined ? ranking.negotiationRating : null),
            fairPricingNotes: ranking.FairPricingNotes || ranking.fairPricingNotes || null,
            communicationNotes: ranking.CommunicationNotes || ranking.communicationNotes || null,
            negotiationNotes: ranking.NegotiationNotes || ranking.negotiationNotes || null,
            rankedBy: ranking.RankedBy || ranking.rankedBy || 'Vendor',
            memberId: ranking.MemberId || ranking.memberId || null,
            createdDate: ranking.CreatedDate || ranking.createdDate,
            createdBy: ranking.CreatedBy || ranking.createdBy,
            createdByFirstName: ranking.CreatedByFirstName || ranking.createdByFirstName,
            createdByLastName: ranking.CreatedByLastName || ranking.createdByLastName,
            modifiedDate: ranking.ModifiedDate || ranking.modifiedDate,
            modifiedBy: ranking.ModifiedBy || ranking.modifiedBy,
            modifiedByFirstName: ranking.ModifiedByFirstName || ranking.modifiedByFirstName,
            modifiedByLastName: ranking.ModifiedByLastName || ranking.modifiedByLastName,
        } : null;
        
        res.json({
            success: true,
            data: transformedRanking
        });
    } catch (error) {
        console.error('❌ Error creating provider ranking:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create provider ranking',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/providers/:providerId/fap/rankings/:rankingId
 * Update an existing provider ranking
 */
router.put('/providers/:providerId/fap/rankings/:rankingId', async (req, res) => {
    try {
        const ranking = await FAPService.updateProviderRanking(
            req.params.rankingId,
            req.body,
            req.user.UserId
        );
        
        // Transform response
        const transformedRanking = ranking ? {
            rankingId: ranking.RankingId || ranking.rankingId,
            providerId: ranking.ProviderId || ranking.providerId,
            vendorId: ranking.VendorId || ranking.vendorId,
            shareRequestId: ranking.ShareRequestId || ranking.shareRequestId || null,
            shareRequestNumber: ranking.ShareRequestNumber || ranking.shareRequestNumber || null,
            fairPricingRating: ranking.FairPricingRating !== undefined ? ranking.FairPricingRating : (ranking.fairPricingRating !== undefined ? ranking.fairPricingRating : null),
            communicationRating: ranking.CommunicationRating !== undefined ? ranking.CommunicationRating : (ranking.communicationRating !== undefined ? ranking.communicationRating : null),
            negotiationRating: ranking.NegotiationRating !== undefined ? ranking.NegotiationRating : (ranking.negotiationRating !== undefined ? ranking.negotiationRating : null),
            fairPricingNotes: ranking.FairPricingNotes || ranking.fairPricingNotes || null,
            communicationNotes: ranking.CommunicationNotes || ranking.communicationNotes || null,
            negotiationNotes: ranking.NegotiationNotes || ranking.negotiationNotes || null,
            rankedBy: ranking.RankedBy || ranking.rankedBy || 'Vendor',
            memberId: ranking.MemberId || ranking.memberId || null,
            createdDate: ranking.CreatedDate || ranking.createdDate,
            createdBy: ranking.CreatedBy || ranking.createdBy,
            createdByFirstName: ranking.CreatedByFirstName || ranking.createdByFirstName,
            createdByLastName: ranking.CreatedByLastName || ranking.createdByLastName,
            modifiedDate: ranking.ModifiedDate || ranking.modifiedDate,
            modifiedBy: ranking.ModifiedBy || ranking.modifiedBy,
            modifiedByFirstName: ranking.ModifiedByFirstName || ranking.modifiedByFirstName,
            modifiedByLastName: ranking.ModifiedByLastName || ranking.modifiedByLastName,
        } : null;
        
        res.json({
            success: true,
            data: transformedRanking
        });
    } catch (error) {
        console.error('❌ Error updating provider ranking:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update provider ranking',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/providers/:providerId/fap/rankings/:rankingId
 * Delete a provider ranking
 */
router.delete('/providers/:providerId/fap/rankings/:rankingId', async (req, res) => {
    try {
        await FAPService.deleteProviderRanking(req.params.rankingId);
        
        res.json({
            success: true,
            message: 'Ranking deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting provider ranking:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete provider ranking',
            error: error.message
        });
    }
});

// ============================================================================
// ANALYTICS
// ============================================================================

/**
 * GET /api/me/vendor/fap/analytics
 * Get FAP analytics
 */
router.get('/fap/analytics', async (req, res) => {
    try {
        const analytics = await FAPService.getFAPAnalytics(
            req.vendor.VendorId,
            {
                providerId: req.query.providerId,
                dateFrom: req.query.dateFrom,
                dateTo: req.query.dateTo
            }
        );
        
        res.json({
            success: true,
            data: analytics
        });
    } catch (error) {
        console.error('❌ Error fetching FAP analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch FAP analytics',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/providers/:providerId/fap/summary
 * Get provider FAP summary
 */
router.get('/providers/:providerId/fap/summary', async (req, res) => {
    try {
        const summary = await FAPService.getProviderFAPSummary(
            req.params.providerId,
            req.vendor.VendorId
        );
        
        res.json({
            success: true,
            data: summary
        });
    } catch (error) {
        console.error('❌ Error fetching provider FAP summary:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch provider FAP summary',
            error: error.message
        });
    }
});

console.log('✅ Mounted FAP routes');

module.exports = router;

