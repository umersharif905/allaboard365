// routes/me/vendor/share-requests.js
// Share Request Management routes for Vendor Portal

const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');
const { requireShareRequestAccess } = require('../../../middleware/shareRequestAccess');
const ShareRequestService = require('../../../services/shareRequestService');
const FinanceSummaryService = require('../../../services/financeSummaryService');
const cptPricingService = require('../../../services/cptPricingService');
const HistoryTimelineService = require('../../../services/historyTimelineService');
const { sendNoteMentionEmails } = require('../../../services/noteMentionService');
const { getProductDocumentsForProductIds } = require('../../../services/shared/product-documents.service');
const { authenticateProductDocumentsArray, generateAuthenticatedUrl, isBlobUrl } = require('../../uploads');

// All routes require authentication and vendor access
router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(requireShareRequestAccess);

// ============================================================================
// DASHBOARD
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/dashboard
 * Get dashboard statistics
 */
router.get('/dashboard', async (req, res) => {
    try {
        const stats = await ShareRequestService.getDashboardStats(req.vendor.VendorId);
        
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('❌ Error fetching dashboard stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch dashboard statistics',
            error: error.message
        });
    }
});

// ============================================================================
// QUEUES — UNUSED (UI removed 2026-05-11; route handlers retained but unreferenced)
// Queues were collapsed in favor of filtering on the Share Requests list.
// DB tables remain untouched. Safe to delete this whole queues section later.
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/queues
 * Get queues with filtering
 */
router.get('/queues', async (req, res) => {
    try {
        const result = await ShareRequestQueueService.getQueues(req.vendor.VendorId, {
            queueType: req.query.queueType,
            assignedTo: req.query.assignedTo,
            role: req.query.role,
            page: req.query.page,
            limit: req.query.limit,
            sortBy: req.query.sortBy,
            sortOrder: req.query.sortOrder
        });
        
        res.json({
            success: true,
            data: result.data,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('❌ Error fetching queues:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch queues',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/queues/stats
 * Get queue statistics
 */
router.get('/queues/stats', async (req, res) => {
    try {
        const stats = await ShareRequestQueueService.getQueueStats(req.vendor.VendorId);
        
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('❌ Error fetching queue stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch queue stats',
            error: error.message
        });
    }
});

// ============================================================================
// QUEUES (duplicate handler block) — UNUSED (UI removed 2026-05-11)
// ============================================================================

const ShareRequestQueueService = require('../../../services/shareRequestQueueService');

/**
 * GET /api/me/vendor/share-requests/queues
 * Get queues with filtering
 */
router.get('/queues', async (req, res) => {
    try {
        const result = await ShareRequestQueueService.getQueues(req.vendor.VendorId, {
            queueType: req.query.queueType,
            assignedTo: req.query.assignedTo,
            role: req.query.role,
            page: req.query.page,
            limit: req.query.limit,
            sortBy: req.query.sortBy,
            sortOrder: req.query.sortOrder
        });
        
        res.json({
            success: true,
            data: result.data,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('❌ Error fetching queues:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch queues',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/queues/stats
 * Get queue statistics
 */
router.get('/queues/stats', async (req, res) => {
    try {
        const stats = await ShareRequestQueueService.getQueueStats(req.vendor.VendorId);
        
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('❌ Error fetching queue stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch queue stats',
            error: error.message
        });
    }
});

// ============================================================================
// CLAIMING (Soft Ownership)
// ============================================================================
// IMPORTANT: GET /claimers must be defined before GET /:id, otherwise Express
// matches /:id with id='claimers'. The /:id/claim handlers below are distinct
// segments and order-insensitive relative to PUT /:id.

/**
 * GET /api/me/vendor/share-requests/claimers
 * Full roster (VendorAdmin + VendorAgent) for the current vendor with the
 * count of SRs each user currently has claimed. Used by both the rail
 * dropdown and the workspace reassign picker.
 */
router.get('/claimers', async (req, res) => {
    try {
        const claimers = await ShareRequestService.getClaimers(
            req.vendor.VendorId,
            req.user.UserId
        );
        res.json({ success: true, data: claimers });
    } catch (error) {
        console.error('❌ Error fetching claimers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch assignees',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/claim
 * Self-claim. VendorAdmin only. (VendorAgent lost claim privileges; admins
 * now drive every assignment, including self-assignment.) 409 if already
 * claimed by another user; idempotent (200) if re-claimed by the same user.
 */
router.post('/:id/claim', async (req, res) => {
    try {
        const isAdmin = Array.isArray(req.user.roles)
            && req.user.roles.includes('VendorAdmin');
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Only Vendor Admins can assign share requests'
            });
        }

        const result = await ShareRequestService.claimShareRequest(
            req.params.id,
            req.vendor.VendorId,
            req.user.UserId
        );

        if (result.status === 'not_found') {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }
        if (result.status === 'conflict') {
            return res.status(409).json({
                success: false,
                message: 'Share request is already assigned',
                data: {
                    claimedByUserId: result.claimedByUserId,
                    claimedByName: result.claimedByName
                }
            });
        }
        res.json({
            success: true,
            data: {
                shareRequestId: result.shareRequestId,
                claimedByUserId: result.claimedByUserId,
                claimedAt: result.claimedAt,
                claimedByName: result.claimedByName
            }
        });
    } catch (error) {
        console.error('❌ Error claiming share request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to assign share request',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/claim
 * Release a claim. VendorAdmin only — admins can release any claim,
 * including their own. VendorAgents no longer have a self-release path
 * (they don't claim in the first place under the current rules).
 */
router.delete('/:id/claim', async (req, res) => {
    try {
        const isAdmin = Array.isArray(req.user.roles)
            && req.user.roles.includes('VendorAdmin');
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Only Vendor Admins can unassign share requests'
            });
        }

        const result = await ShareRequestService.unclaimShareRequest(
            req.params.id,
            req.vendor.VendorId,
            req.user.UserId,
            isAdmin
        );

        if (result.status === 'not_found') {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }
        // 'unclaimed' or 'noop' — both return 200
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error unclaiming share request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unassign share request',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id/claim
 * Admin assign/reassign. Body: { userId: <uuid> }. VendorAdmin only.
 */
router.put('/:id/claim', async (req, res) => {
    try {
        const isAdmin = Array.isArray(req.user.roles)
            && req.user.roles.includes('VendorAdmin');
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Only Vendor Admins can reassign share requests'
            });
        }

        const { userId } = req.body || {};
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'userId is required'
            });
        }

        const result = await ShareRequestService.reassignShareRequest(
            req.params.id,
            req.vendor.VendorId,
            userId
        );

        if (result.status === 'invalid_user') {
            return res.status(400).json({
                success: false,
                message: 'Target user is not a Vendor Admin/Agent in this vendor'
            });
        }
        if (result.status === 'not_found') {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }

        res.json({
            success: true,
            data: {
                shareRequestId: result.shareRequestId,
                claimedByUserId: result.claimedByUserId,
                claimedAt: result.claimedAt,
                claimedByName: result.claimedByName
            }
        });
    } catch (error) {
        console.error('❌ Error reassigning share request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reassign share request',
            error: error.message
        });
    }
});

// ============================================================================
// SHARE REQUESTS CRUD
// ============================================================================

/**
 * GET /api/me/vendor/share-requests
 * Get all share requests with filtering and pagination
 */
router.get('/', async (req, res) => {
    try {
        // Resolve 'me' sugar for claimedByUserId to the authenticated user id.
        let claimedByUserId = req.query.claimedByUserId;
        if (claimedByUserId === 'me') {
            claimedByUserId = req.user.UserId;
        }

        const result = await ShareRequestService.getShareRequests(req.vendor.VendorId, {
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            determination: req.query.determination,
            requestTypeId: req.query.requestTypeId,
            memberId: req.query.memberId,
            search: req.query.search,
            sortBy: req.query.sortBy,
            sortOrder: req.query.sortOrder,
            dateFrom: req.query.dateFrom,
            dateTo: req.query.dateTo,
            claimed: req.query.claimed,
            claimedByUserId
        });

        res.json({
            success: true,
            data: result.data,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('❌ Error fetching share requests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch share requests',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id
 * Get a single share request by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const shareRequest = await ShareRequestService.getShareRequestById(
            req.params.id,
            req.vendor.VendorId
        );

        if (!shareRequest) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }

        // The Coding section's child components (DiagnosisList,
        // ProcedurePricingSection) self-fetch via their own endpoints so they
        // own their mutate/reload state, so the detail response stays lean.
        res.json({
            success: true,
            data: shareRequest
        });
    } catch (error) {
        console.error('❌ Error fetching share request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch share request',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests
 * Create a new share request
 */
router.post('/', async (req, res) => {
    try {
        const { memberId, requestTypeId } = req.body;

        if (!memberId) {
            return res.status(400).json({
                success: false,
                message: 'Member ID is required'
            });
        }

        if (!requestTypeId) {
            return res.status(400).json({
                success: false,
                message: 'Request type is required'
            });
        }

        const result = await ShareRequestService.createShareRequest(
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );

        res.status(201).json({
            success: true,
            data: result,
            message: 'Share request created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating share request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create share request',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id
 * Update a share request
 */
router.put('/:id', async (req, res) => {
    try {
        const result = await ShareRequestService.updateShareRequest(
            req.params.id,
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
            message: 'Share request updated successfully'
        });
    } catch (error) {
        console.error('❌ Error updating share request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update share request',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id/status
 * Update share request status and/or determination
 */
router.put('/:id/status', async (req, res) => {
    try {
        const { status, determination, reason, memberOutcomeNote } = req.body;

        if (!status && !determination && memberOutcomeNote === undefined) {
            return res.status(400).json({
                success: false,
                message: 'Status or determination is required'
            });
        }

        const result = await ShareRequestService.updateStatus(
            req.params.id,
            req.vendor.VendorId,
            status,
            determination,
            reason,
            req.user.UserId,
            memberOutcomeNote
        );

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

        res.json({
            success: true,
            message: 'Status updated successfully'
        });
    } catch (error) {
        console.error('❌ Error updating status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update status',
            error: error.message
        });
    }
});

// ============================================================================
// PROVIDERS (On a Share Request)
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/providers
 * Get providers linked to a share request
 */
router.get('/:id/providers', async (req, res) => {
    try {
        const providers = await ShareRequestService.getShareRequestProviders(req.params.id);
        
        res.json({
            success: true,
            data: providers
        });
    } catch (error) {
        console.error('❌ Error fetching share request providers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch providers',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/providers
 * Add a provider to a share request
 */
router.post('/:id/providers', async (req, res) => {
    try {
        const { providerId, providerRole, notes } = req.body;

        if (!providerId) {
            return res.status(400).json({
                success: false,
                message: 'Provider ID is required'
            });
        }

        const result = await ShareRequestService.addProviderToRequest(
            req.params.id,
            providerId,
            providerRole,
            notes,
            req.user.UserId
        );

        res.status(201).json({
            success: true,
            data: result,
            message: 'Provider added successfully'
        });
    } catch (error) {
        console.error('❌ Error adding provider:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add provider',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/providers/:providerId
 * Remove a provider from a share request
 */
router.delete('/:id/providers/:shareRequestProviderId', async (req, res) => {
    try {
        await ShareRequestService.removeProviderFromRequest(
            req.params.shareRequestProviderId, 
            req.params.id, 
            req.user.UserId
        );
        
        res.json({
            success: true,
            message: 'Provider removed successfully'
        });
    } catch (error) {
        console.error('❌ Error removing provider:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove provider',
            error: error.message
        });
    }
});

// ============================================================================
// MEMBER PLANS (Enrollments)
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/member-plans/:memberId
 * Get member's enrolled plans by member ID (for vendor member detail page)
 */
router.get('/member-plans/:memberId', async (req, res) => {
    try {
        const plans = await ShareRequestService.getMemberPlansByMemberId(
            req.params.memberId,
            req.vendor.VendorId
        );

        // Attach productDocuments to each plan (mirrors agent/products + groupProducts pattern)
        const productIds = plans.map((p) => p.ProductId).filter(Boolean);
        if (productIds.length > 0) {
            const pool = await getPool();
            const productDocumentsMap = await getProductDocumentsForProductIds(pool, productIds, sql);
            for (const plan of plans) {
                let productDocs = productDocumentsMap.get(plan.ProductId) || [];
                if (productDocs.length === 0 && plan.ProductDocumentUrl && typeof plan.ProductDocumentUrl === 'string' && plan.ProductDocumentUrl.trim()) {
                    productDocs = [{ documentUrl: plan.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
                }
                if (productDocs.length > 0) {
                    productDocs = await authenticateProductDocumentsArray(productDocs);
                }
                plan.productDocuments = productDocs;
            }
        }

        res.json({
            success: true,
            data: plans
        });
    } catch (error) {
        console.error('❌ Error fetching member plans:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch member plans',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/member-plans
 * Get member's enrolled plans that are linked to this vendor (for share request detail)
 */
router.get('/:id/member-plans', async (req, res) => {
    try {
        const plans = await ShareRequestService.getMemberPlans(
            req.params.id,
            req.vendor.VendorId
        );

        res.json({
            success: true,
            data: plans
        });
    } catch (error) {
        console.error('❌ Error fetching member plans:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch member plans',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/header-plan
 * Return one resolved plan for the share-request detail page header
 * (share-eligible enrollment for the SR's member; bundle name preferred).
 */
router.get('/:id/header-plan', async (req, res) => {
    try {
        const data = await ShareRequestService.getShareRequestHeaderPlan(
            req.params.id,
            req.vendor.VendorId
        );
        res.json({ success: true, data });
    } catch (error) {
        console.error('❌ Error fetching share request header plan:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch share request header plan',
            error: error.message
        });
    }
});

// ============================================================================
// DIAGNOSES (ICD-10 Codes)
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/diagnoses
 * Get all diagnoses for a share request
 */
router.get('/:id/diagnoses', async (req, res) => {
    try {
        const diagnoses = await ShareRequestService.getDiagnoses(req.params.id);
        
        res.json({
            success: true,
            data: diagnoses
        });
    } catch (error) {
        console.error('❌ Error fetching diagnoses:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch diagnoses',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/diagnoses
 * Add a diagnosis code
 */
router.post('/:id/diagnoses', async (req, res) => {
    try {
        const { icd10Code, description, isPrimary } = req.body;
        
        if (!icd10Code) {
            return res.status(400).json({
                success: false,
                message: 'ICD-10 code is required'
            });
        }

        // Basic format validation for ICD-10 (letter followed by digits, optional dot)
        const icd10Pattern = /^[A-Z]\d{2}\.?\d{0,4}[A-Z]?$/i;
        if (!icd10Pattern.test(icd10Code.trim())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid ICD-10 code format. Expected format: A00.0 or A00'
            });
        }

        const result = await ShareRequestService.addDiagnosis(
            req.params.id,
            { icd10Code, description, isPrimary },
            req.user.userId
        );
        
        res.status(201).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('❌ Error adding diagnosis:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add diagnosis',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id/diagnoses/:diagnosisId
 * Update a diagnosis code
 */
router.put('/:id/diagnoses/:diagnosisId', async (req, res) => {
    try {
        const { icd10Code, description, isPrimary, sortOrder } = req.body;
        
        // Validate ICD-10 format if provided
        if (icd10Code) {
            const icd10Pattern = /^[A-Z]\d{2}\.?\d{0,4}[A-Z]?$/i;
            if (!icd10Pattern.test(icd10Code.trim())) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid ICD-10 code format'
                });
            }
        }

        const result = await ShareRequestService.updateDiagnosis(
            req.params.diagnosisId,
            { icd10Code, description, isPrimary, sortOrder },
            req.user.userId
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('❌ Error updating diagnosis:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update diagnosis',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/diagnoses/:diagnosisId
 * Delete a diagnosis code
 */
router.delete('/:id/diagnoses/:diagnosisId', async (req, res) => {
    try {
        await ShareRequestService.deleteDiagnosis(
            req.params.diagnosisId, 
            req.params.id, 
            req.user.UserId
        );
        
        res.json({
            success: true,
            message: 'Diagnosis deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting diagnosis:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete diagnosis',
            error: error.message
        });
    }
});

// ============================================================================
// PROCEDURES (CPT Codes)
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/procedures
 * Get all procedures for a share request
 */
router.get('/:id/procedures', async (req, res) => {
    try {
        const procedures = await ShareRequestService.getProcedures(req.params.id);
        
        res.json({
            success: true,
            data: procedures
        });
    } catch (error) {
        console.error('❌ Error fetching procedures:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch procedures',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/procedures
 * Add a procedure code
 */
router.post('/:id/procedures', async (req, res) => {
    try {
        const { cptCode, description } = req.body;
        
        if (!cptCode) {
            return res.status(400).json({
                success: false,
                message: 'CPT code is required'
            });
        }

        // Basic format validation for CPT (5 digits, optionally with modifier)
        const cptPattern = /^\d{5}(-\d{2})?$/;
        if (!cptPattern.test(cptCode.trim())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid CPT code format. Expected format: 99213 or 99213-25'
            });
        }

        const result = await ShareRequestService.addProcedure(
            req.params.id,
            { cptCode, description },
            req.user.userId
        );
        
        res.status(201).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('❌ Error adding procedure:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add procedure',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id/procedures/:procedureId
 * Update a procedure code
 */
router.put('/:id/procedures/:procedureId', async (req, res) => {
    try {
        const { cptCode, description, sortOrder } = req.body;
        
        // Validate CPT format if provided
        if (cptCode) {
            const cptPattern = /^\d{5}(-\d{2})?$/;
            if (!cptPattern.test(cptCode.trim())) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid CPT code format'
                });
            }
        }

        const result = await ShareRequestService.updateProcedure(
            req.params.procedureId,
            { cptCode, description, sortOrder }
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('❌ Error updating procedure:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update procedure',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/procedures/:procedureId/pricing-refresh
 * Fetch live Medicare pricing for the procedure's CPT code and snapshot it
 * (PricingSnapshot JSON + headline MedicareTotal / TargetMin / TargetMax).
 * Body: { zip? } — defaults to the member's ZIP; omit both for national rates.
 */
router.post('/:id/procedures/:procedureId/pricing-refresh', async (req, res) => {
    try {
        const procedures = await ShareRequestService.getProcedures(req.params.id);
        const procedure = procedures.find(p => p.ProcedureId.toLowerCase() === req.params.procedureId.toLowerCase());
        if (!procedure) {
            return res.status(404).json({ success: false, message: 'Procedure not found on this share request' });
        }

        let zip = (req.body?.zip || '').trim();
        if (zip && !/^\d{5}$/.test(zip)) {
            return res.status(400).json({ success: false, message: 'ZIP must be 5 digits' });
        }
        if (!zip) {
            const sr = await ShareRequestService.getShareRequestById(req.params.id, req.vendor.VendorId);
            zip = (sr?.MemberZipCode || '').trim().slice(0, 5);
            if (!/^\d{5}$/.test(zip)) zip = '';
        }

        // Strip any modifier (99213-25 -> 99213) for the pricing lookup
        const code = procedure.CPTCode.split('-')[0];
        const snapshotData = await cptPricingService.buildSnapshot(code, zip || undefined);
        const updated = await ShareRequestService.savePricingSnapshot(
            req.params.procedureId, req.params.id, snapshotData, req.user.userId
        );
        if (!updated) {
            return res.status(404).json({ success: false, message: 'Procedure not found on this share request' });
        }

        res.json({ success: true, data: updated });
    } catch (error) {
        if (error.code === 'CPT_NOT_FOUND') {
            return res.status(404).json({ success: false, message: error.message });
        }
        if (error.code === 'PRICING_NOT_CONFIGURED') {
            return res.status(503).json({ success: false, message: 'Pricing service is not configured' });
        }
        console.error('❌ Error refreshing procedure pricing:', error);
        res.status(502).json({
            success: false,
            message: 'Failed to refresh pricing',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/procedures/:procedureId
 * Delete a procedure code
 */
router.delete('/:id/procedures/:procedureId', async (req, res) => {
    try {
        await ShareRequestService.deleteProcedure(
            req.params.procedureId, 
            req.params.id, 
            req.user.UserId
        );
        
        res.json({
            success: true,
            message: 'Procedure deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting procedure:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete procedure',
            error: error.message
        });
    }
});

// ============================================================================
// FINANCE SUMMARY
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/finance-summary
 * Computed finances for a share request (from bills + transactions, normalized
 * via financeCategory). Backs the Finances tab summary cards.
 */
router.get('/:id/finance-summary', async (req, res) => {
    try {
        // Vendor-scoped: getShareRequestSummary returns null if the SR isn't this
        // vendor's, so finances never leak cross-tenant.
        const summary = await FinanceSummaryService.getShareRequestSummary(
            req.params.id,
            req.vendor.VendorId
        );

        if (!summary) {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }

        res.json({
            success: true,
            data: summary
        });
    } catch (error) {
        console.error('❌ Error computing finance summary:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to compute finance summary',
            error: error.message
        });
    }
});

// ============================================================================
// BILLS
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/bills
 * Get bills for a share request
 */
router.get('/:id/bills', async (req, res) => {
    try {
        const bills = await ShareRequestService.getBills(req.params.id);
        
        res.json({
            success: true,
            data: bills
        });
    } catch (error) {
        console.error('❌ Error fetching bills:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch bills',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/bills
 * Create a new bill
 */
router.post('/:id/bills', async (req, res) => {
    try {
        const result = await ShareRequestService.createBill(
            req.params.id,
            req.body,
            req.user.UserId
        );

        res.status(201).json({
            success: true,
            data: result,
            message: 'Bill created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating bill:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create bill',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id/bills/:billId
 * Update a bill
 */
router.put('/:id/bills/:billId', async (req, res) => {
    try {
        const result = await ShareRequestService.updateBill(
            req.params.billId,
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
            message: 'Bill updated successfully'
        });
    } catch (error) {
        console.error('❌ Error updating bill:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update bill',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/bills/:billId
 * Delete a bill (soft delete)
 */
router.delete('/:id/bills/:billId', async (req, res) => {
    try {
        await ShareRequestService.deleteBill(
            req.params.billId, 
            req.params.id, 
            req.user.UserId
        );
        
        res.json({
            success: true,
            message: 'Bill deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting bill:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete bill',
            error: error.message
        });
    }
});

// ============================================================================
// TRANSACTIONS
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/transactions
 * Get transactions for a share request
 */
router.get('/:id/transactions', async (req, res) => {
    try {
        const transactions = await ShareRequestService.getTransactions(req.params.id);
        
        res.json({
            success: true,
            data: transactions
        });
    } catch (error) {
        console.error('❌ Error fetching transactions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch transactions',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/transactions
 * Create a new transaction
 */
router.post('/:id/transactions', async (req, res) => {
    try {
        const { transactionType, amount } = req.body;

        if (!transactionType) {
            return res.status(400).json({
                success: false,
                message: 'Transaction type is required'
            });
        }

        if (amount === undefined || amount === null) {
            return res.status(400).json({
                success: false,
                message: 'Amount is required'
            });
        }

        const result = await ShareRequestService.createTransaction(
            req.params.id,
            req.body,
            req.user.UserId
        );

        res.status(201).json({
            success: true,
            data: result,
            message: 'Transaction created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating transaction:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create transaction',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id/transactions/:transactionId
 * Update a transaction
 */
router.put('/:id/transactions/:transactionId', async (req, res) => {
    try {
        const result = await ShareRequestService.updateTransaction(
            req.params.transactionId,
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
            message: 'Transaction updated successfully'
        });
    } catch (error) {
        console.error('❌ Error updating transaction:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update transaction',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/transactions/:transactionId
 * Delete a transaction
 */
router.delete('/:id/transactions/:transactionId', async (req, res) => {
    try {
        await ShareRequestService.deleteTransaction(
            req.params.transactionId, 
            req.params.id, 
            req.user.UserId
        );
        
        res.json({
            success: true,
            message: 'Transaction deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting transaction:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete transaction',
            error: error.message
        });
    }
});

// ============================================================================
// NOTES & ACTIVITY
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/notes
 * Get notes/activity for a share request
 */
router.get('/:id/notes', async (req, res) => {
    try {
        // category filter:
        //   'manual'   (default) - user-authored notes only; backs the Notes tab
        //   'activity'           - system entries only; legacy
        //   'all'                - everything; legacy
        const allowed = ['manual', 'activity', 'all'];
        const category = allowed.includes(req.query.category) ? req.query.category : 'manual';
        const notes = await ShareRequestService.getNotes(req.params.id, true, category);

        res.json({
            success: true,
            data: notes
        });
    } catch (error) {
        console.error('❌ Error fetching notes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch notes',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/activity
 * Unified activity log — merges StatusHistory and non-manual notes into a
 * single time-ordered timeline. Backs the History tab.
 */
router.get('/:id/activity', async (req, res) => {
    try {
        const items = await ShareRequestService.getActivityLog(req.params.id);
        res.json({
            success: true,
            data: items
        });
    } catch (error) {
        console.error('❌ Error fetching activity log:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch activity log',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/history
 * Unified, read-only history timeline — status changes, notes, encounters,
 * forms and communications merged time-ordered. Backs the History tab.
 */
router.get('/:id/history', async (req, res) => {
    try {
        const events = await HistoryTimelineService.getTimeline('share-request', req.params.id, req.vendor.VendorId);
        res.json({ success: true, data: events });
    } catch (error) {
        const status = error.statusCode || 500;
        console.error('❌ Error fetching share request history:', error);
        res.status(status).json({
            success: false,
            message: error.message || 'Failed to fetch history'
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/notes
 * Add a note to a share request
 */
router.post('/:id/notes', async (req, res) => {
    try {
        const { note, noteType = 'Note', isInternal = true, mentionedUserIds } = req.body;

        if (!note) {
            return res.status(400).json({
                success: false,
                message: 'Note content is required'
            });
        }

        // Validate noteType is one of the allowed communication types
        const allowedTypes = ['Note', 'Call', 'Email', 'PushNotification', 'StatusChange', 'Communication', 'SystemActivity'];
        const validNoteType = allowedTypes.includes(noteType) ? noteType : 'Note';

        const result = await ShareRequestService.addNote(
            req.params.id,
            validNoteType,
            note,
            isInternal,
            req.user.UserId
        );

        // Notify @-mentioned teammates (best-effort; never blocks the note save).
        // Mirrors the vendor-case notes path: mentions notify regardless of the
        // note's communication type — gating on noteType silently dropped them.
        if (Array.isArray(mentionedUserIds) && mentionedUserIds.length > 0) {
            const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
            const authorName = `${req.user?.FirstName || req.user?.firstName || ''} ${req.user?.LastName || req.user?.lastName || ''}`.trim();
            sendNoteMentionEmails({
                authorUserId: req.user.UserId,
                authorName,
                mentionedUserIds,
                vendorId: req.vendor?.VendorId,
                contextType: 'share-request',
                contextId: req.params.id,
                noteText: note,
                baseUrl
            })
                .then(({ sent, error, reason }) => {
                    if (error) {
                        console.error('[share-request notes] mention emails error:', error);
                    } else if (sent > 0) {
                        console.log(`[share-request notes] mention emails sent: ${sent} (sr=${req.params.id}, tagged=${mentionedUserIds.length})`);
                    } else {
                        console.warn(`[share-request notes] mention emails sent 0 — ${reason || 'unknown'} (sr=${req.params.id}, tagged=${mentionedUserIds.length})`);
                    }
                })
                .catch((e) => console.error('[share-request notes] mention emails failed:', e.message));
        }

        res.status(201).json({
            success: true,
            data: result,
            message: `${validNoteType === 'PushNotification' ? 'Push Notification' : validNoteType} added successfully`
        });
    } catch (error) {
        console.error('❌ Error adding note:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add note',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id/notes/:noteId
 * Update a note
 */
router.put('/:id/notes/:noteId', async (req, res) => {
    try {
        const { noteId } = req.params;
        const { note } = req.body;

        if (!note || !note.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Note content is required'
            });
        }

        const result = await ShareRequestService.updateNote(
            noteId,
            note.trim(),
            req.user.UserId
        );

        res.json({
            success: true,
            data: result,
            message: 'Note updated successfully'
        });
    } catch (error) {
        console.error('❌ Error updating note:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update note',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/notes/:noteId
 * Archive (soft delete) a note
 */
router.delete('/:id/notes/:noteId', async (req, res) => {
    try {
        const { noteId } = req.params;

        const result = await ShareRequestService.archiveNote(
            noteId,
            req.user.UserId
        );

        res.json({
            success: true,
            data: result,
            message: 'Note archived successfully'
        });
    } catch (error) {
        console.error('❌ Error archiving note:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to archive note',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/status-history
 * Get status history for a share request
 */
router.get('/:id/status-history', async (req, res) => {
    try {
        const history = await ShareRequestService.getStatusHistory(req.params.id);
        
        res.json({
            success: true,
            data: history
        });
    } catch (error) {
        console.error('❌ Error fetching status history:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch status history',
            error: error.message
        });
    }
});

// ============================================================================
// DOCUMENTS
// ============================================================================

const multer = require('multer');
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const { MAX_LARGE_UPLOAD_BYTES } = require('../../../constants/uploadLimits');

// Configure multer for file uploads
const uploadMulter = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_LARGE_UPLOAD_BYTES,
        files: 10 // Maximum 10 files per request
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = {
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
            'image/tiff': '.tiff',
            'image/bmp': '.bmp',
            'application/zip': '.zip',
            'application/x-zip-compressed': '.zip'
        };
        if (allowedTypes[file.mimetype]) {
            cb(null, true);
        } else {
            cb(new Error(`File type ${file.mimetype} not allowed`));
        }
    }
});

// Initialize Azure Blob Service Client for share request documents
let shareRequestBlobClient;
try {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (connectionString) {
        shareRequestBlobClient = BlobServiceClient.fromConnectionString(connectionString);
        console.log('✅ Azure Blob Storage client initialized for share request documents');
    }
} catch (error) {
    console.error('❌ Failed to initialize Azure Blob client:', error.message);
}

/**
 * GET /api/me/vendor/share-requests/:id/form-submissions
 * Form submissions linked to this share request (forms-redesign Section 5).
 * The SR Workspace renders these under the "Documents and Forms" tab below
 * the SR-attached document files.
 *
 * Payload + resolved-member identity fields are included so the UI can
 * render the auto-resolution discrepancy parens (followup Slice A.3): when
 * an auto-resolved submission's payload name/email/phone diverges from the
 * member's profile, the care team sees both side-by-side.
 */
router.get('/:id/form-submissions', async (req, res) => {
    try {
        const { id } = req.params;
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRe.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid share request id' });
        }
        const pool = await getPool();
        // Tenant isolation: only return submissions whose SR is owned by this vendor.
        const result = await pool.request()
            .input('srId', sql.UniqueIdentifier, id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT
                    s.SubmissionId,
                    s.FormTemplateId,
                    s.AuthMode,
                    s.InvitationId,
                    s.MemberMatchStatus,
                    s.MemberId,
                    s.CreatedDate,
                    s.PayloadFirstName,
                    s.PayloadLastName,
                    s.PayloadEmail,
                    s.PayloadPhone,
                    t.Title AS FormTitle,
                    t.FormKind,
                    u.FirstName AS MemberFirstName,
                    u.LastName AS MemberLastName,
                    u.Email AS MemberEmail,
                    u.PhoneNumber AS MemberPhone
                FROM oe.PublicFormSubmissions s
                INNER JOIN oe.PublicFormTemplates t ON t.FormTemplateId = s.FormTemplateId
                INNER JOIN oe.ShareRequests sr ON sr.ShareRequestId = s.ShareRequestId
                LEFT JOIN oe.Members m ON m.MemberId = s.MemberId
                LEFT JOIN oe.Users u ON u.UserId = m.UserId
                WHERE s.ShareRequestId = @srId
                  AND sr.VendorId = @vendorId
                ORDER BY s.CreatedDate DESC
            `);
        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching SR form-submissions:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch form submissions' });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/form-invitations
 * Active public-form invitations linked to this share request
 * (forms-page redesign B-016). Lets the SR "Documents and Forms" tab
 * show "we sent this form, it's pending" rows alongside the submitted
 * forms — care team can see what's outstanding without waiting for
 * the recipient to submit.
 *
 * Excludes revoked invitations and invitations that already have at
 * least one submission attached (those are visible as submission rows
 * instead).
 */
router.get('/:id/form-invitations', async (req, res) => {
    try {
        const { id } = req.params;
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRe.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid share request id' });
        }
        const pool = await getPool();
        const result = await pool.request()
            .input('srId', sql.UniqueIdentifier, id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT
                    i.InvitationId,
                    i.FormTemplateId,
                    i.MemberId,
                    i.Mode,
                    i.LinkedShareRequestId,
                    i.ExpiresAt,
                    i.FirstUsedAt,
                    i.DeliveryMethod,
                    i.RevokedAt,
                    i.SentByUserId,
                    i.SentToEmail,
                    i.CreatedDate,
                    t.Title AS FormTitle,
                    t.FormKind,
                    u.FirstName + ' ' + u.LastName AS SentByName
                FROM oe.PublicFormInvitations i
                INNER JOIN oe.PublicFormTemplates t ON t.FormTemplateId = i.FormTemplateId
                INNER JOIN oe.ShareRequests sr ON sr.ShareRequestId = i.LinkedShareRequestId
                LEFT JOIN oe.Users u ON u.UserId = i.SentByUserId
                WHERE i.LinkedShareRequestId = @srId
                  AND sr.VendorId = @vendorId
                  AND i.RevokedAt IS NULL
                  AND (i.ExpiresAt IS NULL OR i.ExpiresAt > SYSUTCDATETIME())
                  AND NOT EXISTS (
                    SELECT 1 FROM oe.PublicFormSubmissions s
                    WHERE s.InvitationId = i.InvitationId
                  )
                ORDER BY i.CreatedDate DESC
            `);
        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching SR form-invitations:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch form invitations' });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/documents
 * Get documents for a share request
 */
router.get('/:id/documents', async (req, res) => {
    try {
        const documents = await ShareRequestService.getDocuments(req.params.id);
        
        // Generate authenticated URLs for documents.
        //
        // Documents in this list span two containers: agent/vendor uploads live
        // in `members` (BlobPath has no container prefix), while member uploads
        // attached from public sharing-form submissions live in
        // `public-form-uploads` (BlobPath = `public-form-uploads/...`). The old
        // code hardcoded the `members` container and used BlobPath as the blob
        // name, so member uploads resolved to `members/public-form-uploads/...`
        // — a blob that doesn't exist (BlobNotFound). Sign the stored full
        // BlobUrl instead: generateAuthenticatedUrl parses the real container
        // and blob name out of the URL, so both cases resolve correctly.
        const documentsWithUrls = await Promise.all(documents.map(async (doc) => {
            if (doc.BlobUrl && isBlobUrl(doc.BlobUrl)) {
                try {
                    doc.AuthenticatedUrl = await generateAuthenticatedUrl(doc.BlobUrl);
                } catch (e) {
                    console.error('Error generating SAS URL:', e.message);
                    doc.AuthenticatedUrl = doc.BlobUrl;
                }
            }
            return doc;
        }));
        
        res.json({
            success: true,
            data: documentsWithUrls
        });
    } catch (error) {
        console.error('❌ Error fetching documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch documents',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/documents/upload
 * Upload document(s) for a share request
 * Folder schema: members/{HouseholdId}/{ShareRequestId}/{filename}
 */
router.post('/:id/documents/upload', uploadMulter.array('files', 10), async (req, res) => {
    try {
        const shareRequestId = req.params.id;
        const userId = req.user?.UserId || req.user?.userId;
        
        if (!shareRequestBlobClient) {
            return res.status(503).json({
                success: false,
                message: 'Storage service unavailable'
            });
        }

        // Get the share request to retrieve HouseholdId
        const pool = await getPool();
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT sr.ShareRequestId, sr.HouseholdId, sr.RequestNumber
                FROM oe.ShareRequests sr
                WHERE sr.ShareRequestId = @shareRequestId
            `);

        if (srResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }

        const shareRequest = srResult.recordset[0];
        const householdId = shareRequest.HouseholdId;

        if (!householdId) {
            return res.status(400).json({
                success: false,
                message: 'Share request has no associated household'
            });
        }

        const files = req.files || [];
        if (files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No files uploaded'
            });
        }

        const { documentType, billId, description } = req.body;
        const uploadedDocs = [];
        const containerName = 'members';

        // Get or create container
        const containerClient = shareRequestBlobClient.getContainerClient(containerName);
        await containerClient.createIfNotExists();

        for (const file of files) {
            try {
                // Generate blob path: HouseholdId/ShareRequestId/filename
                const fileExtension = file.originalname.split('.').pop();
                const uniqueFilename = `${uuidv4()}.${fileExtension}`;
                const blobPath = `${householdId}/${shareRequestId}/${uniqueFilename}`;
                
                console.log(`📁 Uploading document: ${file.originalname} to ${blobPath}`);

                const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
                
                // Upload to Azure
                await blockBlobClient.uploadData(file.buffer, {
                    blobHTTPHeaders: {
                        blobContentType: file.mimetype
                    },
                    metadata: {
                        originalName: encodeURIComponent(file.originalname),
                        shareRequestId: shareRequestId,
                        householdId: householdId,
                        uploadDate: new Date().toISOString()
                    }
                });

                const blobUrl = blockBlobClient.url;
                console.log(`✅ Uploaded to: ${blobUrl}`);

                // Create document record in database
                const result = await ShareRequestService.createDocument(shareRequestId, {
                    documentName: file.originalname,
                    documentType: documentType || 'General',
                    fileName: uniqueFilename,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    blobUrl: blobUrl,
                    blobPath: blobPath,
                    description: description || null,
                    billId: billId || null,
                    uploadedBy: 'Vendor'
                }, userId);

                uploadedDocs.push({
                    documentId: result.documentId,
                    documentName: file.originalname,
                    fileName: uniqueFilename,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    blobPath: blobPath,
                    blobUrl: blobUrl
                });

            } catch (uploadError) {
                console.error(`❌ Error uploading ${file.originalname}:`, uploadError);
                uploadedDocs.push({
                    documentName: file.originalname,
                    error: uploadError.message,
                    status: 'failed'
                });
            }
        }

        const successCount = uploadedDocs.filter(d => d.documentId).length;
        const failCount = uploadedDocs.filter(d => d.error).length;

        res.status(201).json({
            success: successCount > 0,
            message: `Successfully uploaded ${successCount} document(s)${failCount > 0 ? `, ${failCount} failed` : ''}`,
            data: uploadedDocs,
            summary: {
                total: files.length,
                successful: successCount,
                failed: failCount
            }
        });

    } catch (error) {
        console.error('❌ Error uploading documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload documents',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/documents
 * Create a document record (file upload handled separately)
 */
router.post('/:id/documents', async (req, res) => {
    try {
        const { documentName, fileName } = req.body;

        if (!documentName || !fileName) {
            return res.status(400).json({
                success: false,
                message: 'Document name and file name are required'
            });
        }

        const result = await ShareRequestService.createDocument(
            req.params.id,
            req.body,
            req.user.UserId
        );

        res.status(201).json({
            success: true,
            data: result,
            message: 'Document record created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create document record',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/documents/:documentId
 * Delete a document (soft delete + optionally delete from blob storage)
 */
router.delete('/:id/documents/:documentId', async (req, res) => {
    try {
        // Get document info first to delete from blob storage
        const pool = await getPool();
        const docResult = await pool.request()
            .input('documentId', sql.UniqueIdentifier, req.params.documentId)
            .query(`
                SELECT BlobPath, BlobUrl 
                FROM oe.ShareRequestDocuments 
                WHERE DocumentId = @documentId
            `);

        // Soft delete from database
        await ShareRequestService.deleteDocument(req.params.documentId, req.user.UserId);

        // Optionally delete from blob storage (commented out to keep files for audit)
        // if (docResult.recordset[0]?.BlobPath && shareRequestBlobClient) {
        //     const containerClient = shareRequestBlobClient.getContainerClient('members');
        //     const blockBlobClient = containerClient.getBlockBlobClient(docResult.recordset[0].BlobPath);
        //     await blockBlobClient.deleteIfExists();
        // }
        
        res.json({
            success: true,
            message: 'Document deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete document',
            error: error.message
        });
    }
});

// ============================================================================
// EMAILS — retired. The per-share-request email feature (graphEmailService +
// oe.ShareRequestEmails + the never-mounted EmailLogTab) was superseded by the
// unified Back Office inbox (/api/me/vendor/inbox). Email now links to a share
// request via encounters and shows in History through the encounter collector.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
// ============================================================================

// ============================================================================
// CALL LOG ROUTES
// ============================================================================

const ZoomPhoneService = require('../../../services/zoomPhoneService');

/**
 * GET /api/me/vendor/share-requests/:id/call-logs
 * Get call logs for a share request
 */
router.get('/:id/call-logs', async (req, res) => {
    try {
        const callLogs = await ZoomPhoneService.getShareRequestCallLogs(req.params.id);

        res.json({
            success: true,
            data: callLogs
        });
    } catch (error) {
        console.error('❌ Error fetching call logs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch call logs',
            error: error.message
        });
    }
});

// Helper: resolve a share request's recipient UserId for this vendor.
async function loadShareRequestRecipient(pool, shareRequestId, vendorId) {
    const result = await pool.request()
        .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT TOP 1 m.UserId
            FROM oe.ShareRequests sr
            INNER JOIN oe.Members m ON sr.MemberId = m.MemberId
            WHERE sr.ShareRequestId = @shareRequestId
              AND sr.VendorId = @vendorId
        `);
    return result.recordset[0] || null;
}

/**
 * GET /api/me/vendor/share-requests/:id/communications
 * Read-only MessageHistory feed for the share request's member.
 */
router.get('/:id/communications', async (req, res) => {
    try {
        const pool = await getPool();
        const recipient = await loadShareRequestRecipient(pool, req.params.id, req.vendor.VendorId);
        if (!recipient) {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }
        if (!recipient.UserId) {
            return res.json({
                success: true,
                data: { data: [], total: 0, page: 1, limit: 0, totalPages: 0 }
            });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const request = pool.request();
        request.input('recipientId', sql.UniqueIdentifier, recipient.UserId);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);

        const countResult = await request.query(`
            SELECT COUNT(*) AS totalCount
            FROM oe.MessageHistory mh
            WHERE mh.RecipientId = @recipientId
        `);
        const totalItems = countResult.recordset[0].totalCount;

        const result = await request.query(`
            SELECT
                mh.HistoryId AS historyId,
                mh.MessageId AS messageId,
                mh.TenantId AS tenantId,
                mh.RecipientId AS recipientId,
                COALESCE(u.FirstName + ' ' + u.LastName, 'Unknown User') AS recipientName,
                mh.RecipientAddress AS recipientAddress,
                mh.MessageType AS messageType,
                mh.Subject AS subject,
                mh.Status AS status,
                mh.ProviderMessageId AS providerMessageId,
                mh.ErrorMessage AS errorMessage,
                mh.SentDate AS sentDate,
                mh.BatchId AS batchId
            FROM oe.MessageHistory mh
            LEFT JOIN oe.Users u ON mh.RecipientId = u.UserId
            WHERE mh.RecipientId = @recipientId
            ORDER BY mh.SentDate DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `);

        res.json({
            success: true,
            data: {
                data: result.recordset,
                total: totalItems,
                page,
                limit,
                totalPages: Math.ceil(totalItems / limit)
            }
        });
    } catch (error) {
        console.error('❌ Error fetching share request communications:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch communications', error: error.message });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/communications/:historyId
 */
router.get('/:id/communications/:historyId', async (req, res) => {
    try {
        const pool = await getPool();
        const recipient = await loadShareRequestRecipient(pool, req.params.id, req.vendor.VendorId);
        if (!recipient || !recipient.UserId) {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }

        const historyResult = await pool.request()
            .input('historyId', sql.UniqueIdentifier, req.params.historyId)
            .input('recipientId', sql.UniqueIdentifier, recipient.UserId)
            .query(`
                SELECT
                    mh.HistoryId AS historyId,
                    mh.MessageId AS messageId,
                    mh.TenantId AS tenantId,
                    mh.RecipientId AS recipientId,
                    COALESCE(u.FirstName + ' ' + u.LastName, 'Unknown User') AS recipientName,
                    mh.RecipientAddress AS recipientAddress,
                    mh.MessageType AS messageType,
                    mh.Subject AS subject,
                    mh.Status AS status,
                    mh.ProviderMessageId AS providerMessageId,
                    mh.ErrorMessage AS errorMessage,
                    mh.SentDate AS sentDate,
                    mh.Body AS body,
                    mh.FromAddress AS fromAddress
                FROM oe.MessageHistory mh
                LEFT JOIN oe.Users u ON mh.RecipientId = u.UserId
                WHERE mh.HistoryId = @historyId
                  AND mh.RecipientId = @recipientId
            `);

        if (historyResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Message not found' });
        }

        const message = historyResult.recordset[0];

        const eventsResult = await pool.request()
            .input('messageId', sql.UniqueIdentifier, message.messageId)
            .query(`
                SELECT EventType AS event,
                       EventTime AS timestamp,
                       Reason    AS details,
                       Provider  AS provider,
                       MxServer  AS mxServer,
                       EventType AS eventType
                FROM oe.MessageEvent
                WHERE MessageId = @messageId
                ORDER BY EventTime ASC
            `);

        res.json({ success: true, data: { ...message, events: eventsResult.recordset } });
    } catch (error) {
        console.error('❌ Error fetching share request communication details:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch communication details', error: error.message });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/call-logs
 * Create a manual call log entry
 */
router.post('/:id/call-logs', async (req, res) => {
    try {
        const shareRequestId = req.params.id;
        const userId = req.user?.UserId || req.user?.userId;

        // Get the share request to find vendor and member
        const pool = await getPool();
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT sr.VendorId, sr.MemberId, u.FirstName, u.LastName, u.PhoneNumber as Phone
                FROM oe.ShareRequests sr
                LEFT JOIN oe.Members m ON sr.MemberId = m.MemberId
                LEFT JOIN oe.Users u ON m.UserId = u.UserId
                WHERE sr.ShareRequestId = @shareRequestId
            `);

        if (srResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }

        const sr = srResult.recordset[0];

        const {
            callType,
            callStartTime,
            callEndTime,
            callerNumber,
            calleeNumber,
            callNotes,
            callSummary
        } = req.body;

        // Calculate duration if both times provided
        let callDurationSeconds = null;
        if (callStartTime && callEndTime) {
            callDurationSeconds = Math.round(
                (new Date(callEndTime) - new Date(callStartTime)) / 1000
            );
        }

        const callLogId = await ZoomPhoneService.recordCallLog(sr.VendorId, {
            callType: callType || 'Outbound',
            callStatus: 'Completed',
            callerNumber: callerNumber,
            callerName: callType === 'Inbound' ? `${sr.FirstName} ${sr.LastName}` : null,
            calleeNumber: calleeNumber || sr.Phone,
            calleeName: callType !== 'Inbound' ? `${sr.FirstName} ${sr.LastName}` : null,
            callStartTime: callStartTime ? new Date(callStartTime) : new Date(),
            callEndTime: callEndTime ? new Date(callEndTime) : new Date(),
            callDurationSeconds,
            memberId: sr.MemberId,
            shareRequestId,
            matchedBy: 'Manual',
            agentUserId: userId,
            callNotes,
            callSummary,
            source: 'Manual'
        }, userId);

        // Log call to activity history
        try {
            const callTypeLabel = (callType || 'Outbound') === 'Inbound' ? 'Inbound call' : 'Outbound call';
            const durationText = callDurationSeconds ? ` (${Math.floor(callDurationSeconds / 60)}m ${callDurationSeconds % 60}s)` : '';
            const callDescription = `${callTypeLabel}${durationText}${callSummary ? `: ${callSummary}` : ''}`;
            console.log('📝 Logging call to activity:', { shareRequestId, note: callDescription, userId, idType: typeof shareRequestId });
            const result = await ShareRequestService.addNote(
                shareRequestId,
                'Communication',
                callDescription,
                true,
                userId
            );
            console.log('📝 addNote result:', result);
            console.log('✅ Call activity logged successfully');
        } catch (activityError) {
            console.error('❌ Failed to log call to activity:', activityError);
            console.error('❌ Error details:', {
                message: activityError.message,
                stack: activityError.stack,
                shareRequestId: shareRequestId,
                userId: userId
            });
            // Don't fail the request if activity logging fails
        }

        res.status(201).json({
            success: true,
            data: { callLogId },
            message: 'Call log created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating call log:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create call log',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/share-requests/:id/call-logs/:callLogId
 * Update a call log entry
 */
router.put('/:id/call-logs/:callLogId', async (req, res) => {
    try {
        const { callLogId } = req.params;
        const userId = req.user?.UserId || req.user?.userId;
        const { callNotes, callSummary } = req.body;

        await ZoomPhoneService.updateCallLog(callLogId, {
            callNotes,
            callSummary
        }, userId);

        res.json({
            success: true,
            message: 'Call log updated successfully'
        });
    } catch (error) {
        console.error('❌ Error updating call log:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update call log',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/search
 * Search share requests by phone number or member name (for call linking)
 */
router.get('/search', async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q || q.length < 2) {
            return res.json({
                success: true,
                data: []
            });
        }

        const results = await ZoomPhoneService.searchShareRequests(
            req.vendor.VendorId,
            q
        );

        res.json({
            success: true,
            data: results
        });
    } catch (error) {
        console.error('❌ Error searching share requests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search share requests',
            error: error.message
        });
    }
});

// ============================================================================
// SMS MESSAGING ROUTES
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/sms
 * Get all SMS messages for a share request (share request specific only)
 */
router.get('/:id/sms', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT 
                    sm.SmsMessageId,
                    sm.Direction,
                    sm.FromNumber,
                    sm.ToNumber,
                    sm.MessageBody,
                    sm.MessageStatus,
                    sm.SentAt,
                    sm.DeliveredAt,
                    sm.ReceivedAt,
                    sm.ZoomMessageId,
                    sm.TwilioMessageSid,
                    sm.CreatedDate,
                    sm.ShareRequestId,
                    u.FirstName AS AgentFirstName,
                    u.LastName AS AgentLastName,
                    mu.FirstName AS MemberFirstName,
                    mu.LastName AS MemberLastName
                FROM oe.VendorSmsMessages sm
                LEFT JOIN oe.Users u ON sm.AgentUserId = u.UserId
                LEFT JOIN oe.Members m ON sm.MemberId = m.MemberId
                LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
                WHERE sm.ShareRequestId = @shareRequestId
                  AND sm.VendorId = @vendorId
                  AND sm.IsActive = 1
                ORDER BY COALESCE(sm.SentAt, sm.ReceivedAt, sm.CreatedDate) ASC
            `);

        res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('❌ Error fetching SMS messages:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch SMS messages',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/:id/sms/conversation
 * Get full SMS conversation history with the member (all messages, regardless of ShareRequestId)
 * Queries by MemberId AND phone number to catch all messages, including those not yet linked
 */
router.get('/:id/sms/conversation', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        
        // First get the share request to find the member and their phone number
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT 
                    sr.MemberId,
                    u.PhoneNumber
                FROM oe.ShareRequests sr
                LEFT JOIN oe.Members m ON sr.MemberId = m.MemberId
                LEFT JOIN oe.Users u ON m.UserId = u.UserId
                WHERE sr.ShareRequestId = @shareRequestId
            `);

        if (srResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }

        const memberId = srResult.recordset[0].MemberId;
        const memberPhone = srResult.recordset[0].PhoneNumber;
        
        // Normalize phone number for matching (try multiple formats)
        const phoneVariants = [];
        if (memberPhone) {
            let cleaned = memberPhone.replace(/[^\d+]/g, '');
            phoneVariants.push(cleaned); // Original format
            if (cleaned.startsWith('+1')) {
                phoneVariants.push(cleaned.substring(2)); // Remove +1
                phoneVariants.push('1' + cleaned.substring(2)); // Add 1 without +
            } else if (cleaned.startsWith('1') && cleaned.length === 11) {
                phoneVariants.push('+' + cleaned); // Add +
                phoneVariants.push(cleaned.substring(1)); // Remove leading 1
            } else if (cleaned.length === 10) {
                phoneVariants.push('+1' + cleaned); // Add +1
                phoneVariants.push('1' + cleaned); // Add 1
            }
        }
        const uniquePhoneVariants = [...new Set(phoneVariants.filter(Boolean))];
        
        // Build query to match by MemberId OR phone number (to catch all messages)
        const phoneConditions = uniquePhoneVariants.length > 0 
            ? uniquePhoneVariants.map((_, index) => `(sm.FromNumber = @phone${index} OR sm.ToNumber = @phone${index})`).join(' OR ')
            : '1=0'; // No phone number, can't match by phone
        
        const conversationRequest = pool.request();
        conversationRequest.input('memberId', sql.UniqueIdentifier, memberId);
        conversationRequest.input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId);
        uniquePhoneVariants.forEach((phone, index) => {
            conversationRequest.input(`phone${index}`, sql.NVarChar, phone);
        });
        
        // Get all SMS messages for this member (by MemberId OR phone number)
        const result = await conversationRequest.query(`
            SELECT 
                sm.SmsMessageId,
                sm.Direction,
                sm.FromNumber,
                sm.ToNumber,
                sm.MessageBody,
                sm.MessageStatus,
                sm.SentAt,
                sm.DeliveredAt,
                sm.ReceivedAt,
                sm.ZoomMessageId,
                sm.TwilioMessageSid,
                sm.CreatedDate,
                sm.ShareRequestId,
                sm.MemberId,
                sr.RequestNumber,
                u.FirstName AS AgentFirstName,
                u.LastName AS AgentLastName,
                mu.FirstName AS MemberFirstName,
                mu.LastName AS MemberLastName
            FROM oe.VendorSmsMessages sm
            LEFT JOIN oe.Users u ON sm.AgentUserId = u.UserId
            LEFT JOIN oe.Members m ON sm.MemberId = m.MemberId
            LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
            LEFT JOIN oe.ShareRequests sr ON sm.ShareRequestId = sr.ShareRequestId
            WHERE sm.VendorId = @vendorId
              AND sm.IsActive = 1
              AND (
                  sm.MemberId = @memberId
                  ${uniquePhoneVariants.length > 0 ? `OR (${phoneConditions})` : ''}
              )
            ORDER BY COALESCE(sm.SentAt, sm.ReceivedAt, sm.CreatedDate) ASC
        `);

        res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('❌ Error fetching SMS conversation:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch SMS conversation',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/sms
 * Send an SMS message for a share request
 */
router.post('/:id/sms', async (req, res) => {
    try {
        const { id } = req.params;
        let { toNumber, messageBody } = req.body;
        const userId = req.user?.UserId || req.user?.userId;
        const pool = await getPool();

        if (!toNumber || !messageBody) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and message are required'
            });
        }

        // Get share request info first (to include RequestNumber and check opt-out)
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, id)
            .query(`
                SELECT sr.ShareRequestId, sr.RequestNumber, sr.MemberId, m.UserId, u.PhoneNumber
                FROM oe.ShareRequests sr
                LEFT JOIN oe.Members m ON sr.MemberId = m.MemberId
                LEFT JOIN oe.Users u ON m.UserId = u.UserId
                WHERE sr.ShareRequestId = @shareRequestId
            `);

        const shareRequest = srResult.recordset[0];
        if (!shareRequest) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }

        // Check if member has opted out of SMS for this share request
        // First check if ShareRequestMembers table exists
        const tableCheck = await pool.request()
            .query(`
                SELECT TABLE_NAME
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'ShareRequestMembers'
            `);

        if (tableCheck.recordset.length > 0) {
            const optOutCheck = await pool.request()
                .input('shareRequestId', sql.UniqueIdentifier, id)
                .input('memberId', sql.UniqueIdentifier, shareRequest.MemberId)
                .query(`
                    SELECT OptedOutOfSms
                    FROM oe.ShareRequestMembers
                    WHERE ShareRequestId = @shareRequestId AND MemberId = @memberId
                `);

            if (optOutCheck.recordset.length > 0 && optOutCheck.recordset[0].OptedOutOfSms === 1) {
                return res.status(400).json({
                    success: false,
                    message: 'This member has opted out of SMS for this share request'
                });
            }
        }

        // Include RequestNumber in message and add opt-out text
        const requestNumberText = shareRequest.RequestNumber ? `\n\nShare Request: ${shareRequest.RequestNumber}` : '';
        const optOutText = '\n\nReply STOP to opt out';
        if (!messageBody.trim().endsWith('Reply STOP to opt out') && !messageBody.trim().endsWith('STOP to opt out')) {
            messageBody = messageBody + requestNumberText + optOutText;
        }

        // Get vendor's SMS config (Twilio or Zoom)
        // Check if Twilio columns exist first
        const columnCheckRequest = pool.request();
        const columnCheckResult = await columnCheckRequest.query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'oe' 
            AND TABLE_NAME = 'Vendors'
            AND COLUMN_NAME IN ('TwilioAccountSid', 'TwilioAuthToken', 'TwilioPhoneNumber', 'SmsProvider')
        `);
        const existingTwilioColumns = new Set(columnCheckResult.recordset.map(r => r.COLUMN_NAME));
        
        const vendorResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT 
                    PhoneProviderEnabled, 
                    ${existingTwilioColumns.has('SmsProvider') ? 'SmsProvider' : 'NULL'} AS SmsProvider,
                    ${existingTwilioColumns.has('TwilioAccountSid') ? 'TwilioAccountSid' : 'NULL'} AS TwilioAccountSid, 
                    ${existingTwilioColumns.has('TwilioAuthToken') ? 'TwilioAuthToken' : 'NULL'} AS TwilioAuthToken, 
                    ${existingTwilioColumns.has('TwilioPhoneNumber') ? 'TwilioPhoneNumber' : 'NULL'} AS TwilioPhoneNumber,
                    SmsFromNumber,
                    -- Zoom fields (for backward compatibility)
                    ZoomAccountId, 
                    ZoomClientId, 
                    ZoomClientSecret, 
                    SmsZoomUserId
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);

        if (vendorResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }

        const vendor = vendorResult.recordset[0];
        
        // Determine SMS provider (default to Twilio if SmsProvider not set)
        const smsProvider = vendor.SmsProvider || 'Twilio';
        
        if (!vendor.PhoneProviderEnabled) {
            return res.status(400).json({
                success: false,
                message: 'Phone system is not enabled for this vendor. Go to Settings > Phone System to enable it.'
            });
        }

        // shareRequest already retrieved above

        // Normalize phone numbers to E.164 format
        const normalizePhone = (phone) => {
            if (!phone) return phone;
            let cleaned = phone.replace(/[^\d+]/g, '');
            if (!cleaned.startsWith('+')) {
                if (cleaned.startsWith('1') && cleaned.length === 11) {
                    cleaned = '+' + cleaned;
                } else {
                    cleaned = '+1' + cleaned;
                }
            }
            return cleaned;
        };

        const normalizedToNumber = normalizePhone(toNumber);

        // Send SMS via Twilio or Zoom based on provider
        let externalMessageId = null;
        let messageStatus = 'Pending';
        let smsErrorMessage = null;
        let fromNumber = null;

        if (smsProvider === 'Twilio') {
            // ========== TWILIO SMS ==========
            if (!vendor.TwilioAccountSid || !vendor.TwilioAuthToken) {
                return res.status(400).json({
                    success: false,
                    message: 'Twilio is not configured. Go to Settings > Phone System > SMS Settings and add your Twilio Account SID and Auth Token.'
                });
            }

            fromNumber = vendor.TwilioPhoneNumber || vendor.SmsFromNumber;
            if (!fromNumber) {
                return res.status(400).json({
                    success: false,
                    message: 'No Twilio phone number configured. Go to Settings > Phone System > SMS Settings and add your Twilio phone number (e.g., +19043736872).'
                });
            }

            fromNumber = normalizePhone(fromNumber);
            console.log('📱 Sending SMS via Twilio:', { fromNumber, toNumber: normalizedToNumber, messageLength: messageBody.length });

            try {
                const twilio = require('twilio');
                
                // Decrypt auth token if needed
                let authToken = vendor.TwilioAuthToken;
                try {
                    const encryptionService = require('../../../services/encryptionService');
                    if (authToken && authToken.includes(':')) {
                        authToken = encryptionService.decrypt(authToken);
                    }
                } catch (e) {
                    console.log('Auth token not encrypted or decryption failed, using as-is');
                }

                const twilioClient = twilio(vendor.TwilioAccountSid, authToken);
                
                const message = await twilioClient.messages.create({
                    body: messageBody,
                    from: fromNumber,
                    to: normalizedToNumber
                });

                externalMessageId = message.sid;
                messageStatus = 'Sent';
                console.log('✅ SMS sent successfully via Twilio! Message SID:', externalMessageId);
            } catch (twilioError) {
                console.error('❌ Twilio SMS error:', twilioError.message);
                smsErrorMessage = twilioError.message || 'Failed to send SMS via Twilio';
                messageStatus = 'Failed';
            }
        } else {
            // ========== ZOOM SMS (backward compatibility) ==========
            const ZoomPhoneService = require('../../../services/zoomPhoneService');
            
            if (!vendor.ZoomAccountId) {
                return res.status(400).json({
                    success: false,
                    message: 'Zoom Phone is not configured for this vendor'
                });
            }

            // Decrypt client secret if needed
            let clientSecret = vendor.ZoomClientSecret;
            try {
                const encryptionService = require('../../../services/encryptionService');
                if (clientSecret && clientSecret.includes(':')) {
                    clientSecret = encryptionService.decrypt(clientSecret);
                }
            } catch (e) {
                console.log('Client secret not encrypted or decryption failed, using as-is');
            }

            const zoomConfig = {
                accountId: vendor.ZoomAccountId,
                clientId: vendor.ZoomClientId,
                clientSecret: clientSecret
            };

            let accessToken;
            try {
                accessToken = await ZoomPhoneService.getAccessToken(zoomConfig);
            } catch (err) {
                console.error('Failed to get Zoom access token:', err.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to authenticate with Zoom. Please check your Zoom Phone configuration in Settings.'
                });
            }

            fromNumber = vendor.SmsFromNumber;
            if (!fromNumber) {
                return res.status(400).json({
                    success: false,
                    message: 'No SMS sender number configured. Go to Settings > Phone System and add your Zoom Phone number.'
                });
            }

            fromNumber = normalizePhone(fromNumber);
            console.log('📱 Sending SMS via Zoom (legacy support):', { fromNumber, toNumber: normalizedToNumber, messageLength: messageBody.length });
            
            // Zoom SMS - Note: Server-to-Server OAuth has limitations with SMS API
            // This is kept for backward compatibility but Twilio is recommended
            try {
                const axios = require('axios');
                let zoomSmsUserId = vendor.SmsZoomUserId;
                
                // Try to get account owner's user ID
                if (!zoomSmsUserId) {
                    try {
                        const meResponse = await axios.get('https://api.zoom.us/v2/users/me', {
                            headers: { 'Authorization': `Bearer ${accessToken}` }
                        });
                        zoomSmsUserId = meResponse.data?.id;
                    } catch (e) {
                        console.log('Could not get account owner ID');
                    }
                }
                
                if (zoomSmsUserId) {
                    const smsResponse = await axios.post('https://api.zoom.us/v2/phone/sms/messages', {
                        message: messageBody,
                        sender: {
                            user_id: zoomSmsUserId,
                            phone_number: fromNumber
                        },
                        to_members: [{ phone_number: normalizedToNumber }]
                    }, {
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    
                    externalMessageId = smsResponse.data?.id || smsResponse.data?.message_id;
                    messageStatus = 'Sent';
                    console.log('✅ SMS sent via Zoom, message ID:', externalMessageId);
                } else {
                    throw new Error('Zoom SMS requires user ID. Please configure SMS Zoom User ID in Settings or switch to Twilio.');
                }
            } catch (zoomError) {
                console.error('❌ Zoom SMS error:', zoomError.response?.data || zoomError.message);
                smsErrorMessage = zoomError.response?.data?.message || zoomError.message || 'Failed to send SMS via Zoom. Consider switching to Twilio in Settings.';
                messageStatus = 'Failed';
            }
        }

        // Save to database
        const smsId = require('uuid').v4();
        
        // Check if TwilioMessageSid column exists
        const smsColumnCheckRequest = pool.request();
        const smsColumnCheckResult = await smsColumnCheckRequest.query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'oe' 
            AND TABLE_NAME = 'VendorSmsMessages'
            AND COLUMN_NAME IN ('TwilioMessageSid', 'ZoomMessageId')
        `);
        const existingSmsColumns = new Set(smsColumnCheckResult.recordset.map(r => r.COLUMN_NAME));
        const hasTwilioMessageSid = existingSmsColumns.has('TwilioMessageSid');
        const hasZoomMessageId = existingSmsColumns.has('ZoomMessageId');
        
        // Build INSERT query based on provider and available columns
        let insertQuery;
        if (smsProvider === 'Twilio' && hasTwilioMessageSid) {
            // Use TwilioMessageSid if available
            insertQuery = `
                INSERT INTO oe.VendorSmsMessages (
                    SmsMessageId, VendorId, Direction, FromNumber, ToNumber, 
                    MessageBody, MessageStatus, MemberId, ShareRequestId,
                    AgentUserId, TwilioMessageSid, SentAt, CreatedBy, MatchedBy
                ) VALUES (
                    @smsMessageId, @vendorId, @direction, @fromNumber, @toNumber,
                    @messageBody, @messageStatus, @memberId, @shareRequestId,
                    @agentUserId, @externalMessageId, @sentAt, @createdBy, 'Manual'
                )
            `;
        } else if (hasZoomMessageId) {
            // Fall back to ZoomMessageId if TwilioMessageSid doesn't exist (backward compatibility)
            insertQuery = `
                INSERT INTO oe.VendorSmsMessages (
                    SmsMessageId, VendorId, Direction, FromNumber, ToNumber, 
                    MessageBody, MessageStatus, MemberId, ShareRequestId,
                    AgentUserId, ZoomMessageId, SentAt, CreatedBy, MatchedBy
                ) VALUES (
                    @smsMessageId, @vendorId, @direction, @fromNumber, @toNumber,
                    @messageBody, @messageStatus, @memberId, @shareRequestId,
                    @agentUserId, @externalMessageId, @sentAt, @createdBy, 'Manual'
                )
            `;
        } else {
            // No message ID column available, insert without it
            insertQuery = `
                INSERT INTO oe.VendorSmsMessages (
                    SmsMessageId, VendorId, Direction, FromNumber, ToNumber, 
                    MessageBody, MessageStatus, MemberId, ShareRequestId,
                    AgentUserId, SentAt, CreatedBy, MatchedBy
                ) VALUES (
                    @smsMessageId, @vendorId, @direction, @fromNumber, @toNumber,
                    @messageBody, @messageStatus, @memberId, @shareRequestId,
                    @agentUserId, @sentAt, @createdBy, 'Manual'
                )
            `;
        }
        
        await pool.request()
            .input('smsMessageId', sql.UniqueIdentifier, smsId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('direction', sql.NVarChar, 'Outbound')
            .input('fromNumber', sql.NVarChar, fromNumber)
            .input('toNumber', sql.NVarChar, normalizedToNumber)
            .input('messageBody', sql.NVarChar, messageBody)
            .input('messageStatus', sql.NVarChar, messageStatus)
            .input('memberId', sql.UniqueIdentifier, shareRequest?.MemberId || null)
            .input('shareRequestId', sql.UniqueIdentifier, id)
            .input('agentUserId', sql.UniqueIdentifier, userId)
            .input('externalMessageId', sql.NVarChar, externalMessageId)
            .input('sentAt', sql.DateTime2, new Date())
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(insertQuery);

        // Log SMS to activity history (only if message was sent successfully)
        if (messageStatus === 'Sent' || messageStatus === 'Pending') {
            try {
                const smsPreview = messageBody.length > 50 ? messageBody.substring(0, 50) + '...' : messageBody;
                const activityNote = `SMS sent to ${normalizedToNumber}: "${smsPreview}"`;
                console.log('📝 Logging SMS to activity:', { shareRequestId: id, note: activityNote, userId, idType: typeof id });
                const result = await ShareRequestService.addNote(
                    id,
                    'Communication',
                    activityNote,
                    true,
                    userId
                );
                console.log('📝 addNote result:', result);
                console.log('✅ SMS activity logged successfully');
            } catch (activityError) {
                console.error('❌ Failed to log SMS to activity:', activityError);
                console.error('❌ Error details:', {
                    message: activityError.message,
                    stack: activityError.stack,
                    shareRequestId: id,
                    userId: userId
                });
                // Don't fail the request if activity logging fails
            }
        }

        if (messageStatus === 'Failed') {
            return res.status(500).json({
                success: false,
                message: smsErrorMessage || `SMS saved but failed to send via ${smsProvider}. Check your ${smsProvider} configuration in Settings.`
            });
        }

        res.json({
            success: true,
            message: `SMS sent successfully via ${smsProvider}`,
            data: {
                SmsMessageId: smsId,
                MessageStatus: messageStatus,
                ExternalMessageId: externalMessageId,
                Provider: smsProvider
            }
        });
    } catch (error) {
        console.error('❌ Error sending SMS:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send SMS',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/sms/:smsId
 * Archive an SMS message
 */
router.delete('/:id/sms/:smsId', async (req, res) => {
    try {
        const { id, smsId } = req.params;
        const userId = req.user?.UserId || req.user?.userId;
        const pool = await getPool();

        await pool.request()
            .input('smsMessageId', sql.UniqueIdentifier, smsId)
            .input('shareRequestId', sql.UniqueIdentifier, id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.VendorSmsMessages
                SET IsActive = 0, ModifiedDate = GETDATE(), ModifiedBy = @userId
                WHERE SmsMessageId = @smsMessageId 
                  AND ShareRequestId = @shareRequestId
                  AND VendorId = @vendorId
            `);

        res.json({
            success: true,
            message: 'SMS archived successfully'
        });
    } catch (error) {
        console.error('❌ Error archiving SMS:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to archive SMS',
            error: error.message
        });
    }
});


// Share Request FAP (Financial Assistance Program) was removed 2026-05-30. The
// Finances tab no longer has a FAP sub-tab; financial assistance is now recorded
// via the 'Financial Aid' ledger transaction type. The FAP routes, service, and
// oe.ShareRequestFinancialApplications table were retired — see
// docs/billing-rework/BLOCKERS.md and sql-changes/2026-05-30-drop-share-request-fap.sql.
// NOTE: this is unrelated to the Provider FAP subsystem (routes/me/vendor/fap.js
// + services/fapService.js), which remains in place.


// ============================================================================
// PER-REQUEST QUEUES — UNUSED (UI removed 2026-05-11; handlers retained but unreferenced)
// ============================================================================

/**
 * GET /api/me/vendor/share-requests/:id/queues
 * Get queues for a specific share request
 */
router.get('/:id/queues', async (req, res) => {
    try {
        const queues = await ShareRequestQueueService.getQueuesForRequest(req.params.id);
        
        res.json({
            success: true,
            data: queues
        });
    } catch (error) {
        console.error('❌ Error fetching request queues:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch request queues',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/queues
 * Add share request to queue
 */
router.post('/:id/queues', async (req, res) => {
    try {
        const { queueType, priority, assignedTo } = req.body;
        
        if (!queueType) {
            return res.status(400).json({
                success: false,
                message: 'Queue type is required'
            });
        }
        
        const result = await ShareRequestQueueService.addToQueue(
            req.params.id,
            queueType,
            priority || 0,
            assignedTo || null,
            req.user.UserId
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }
        
        res.status(201).json({
            success: true,
            data: result,
            message: 'Added to queue successfully'
        });
    } catch (error) {
        console.error('❌ Error adding to queue:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add to queue',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/share-requests/:id/queues/:queueType
 * Remove share request from queue
 */
router.delete('/:id/queues/:queueType', async (req, res) => {
    try {
        const result = await ShareRequestQueueService.removeFromQueue(
            req.params.id,
            req.params.queueType,
            req.body.reason || null,
            req.user.UserId
        );
        
        res.json({
            success: true,
            message: 'Removed from queue successfully'
        });
    } catch (error) {
        console.error('❌ Error removing from queue:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove from queue',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/queues/auto-assign
 * Auto-assign queues based on status and flags
 */
router.post('/:id/queues/auto-assign', async (req, res) => {
    try {
        const result = await ShareRequestQueueService.autoAssignQueues(
            req.params.id,
            req.user.UserId
        );
        
        res.json({
            success: true,
            data: result,
            message: 'Queues auto-assigned successfully'
        });
    } catch (error) {
        console.error('❌ Error auto-assigning queues:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to auto-assign queues',
            error: error.message
        });
    }
});


// ============================================================================
// ALLOWANCES
// ============================================================================

const ShareRequestAllowanceService = require('../../../services/shareRequestAllowanceService');

/**
 * GET /api/me/vendor/share-requests/:id/allowances
 * Get allowances for a share request
 */
router.get('/:id/allowances', async (req, res) => {
    try {
        const allowances = await ShareRequestAllowanceService.getAllowances(req.params.id);
        
        res.json({
            success: true,
            data: allowances
        });
    } catch (error) {
        console.error('❌ Error fetching allowances:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch allowances',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/allowances
 * Initialize allowances for a share request
 */
router.post('/:id/allowances', async (req, res) => {
    try {
        const { enrollmentId, serviceType, serviceCategory, amount } = req.body;
        
        if (!enrollmentId || !serviceType || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Enrollment ID, service type, and amount are required'
            });
        }
        
        const result = await ShareRequestAllowanceService.initializeAllowances(
            req.params.id,
            enrollmentId,
            serviceType,
            serviceCategory || null,
            amount,
            req.user.UserId
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }
        
        res.status(201).json({
            success: true,
            data: result,
            message: 'Allowance initialized successfully'
        });
    } catch (error) {
        console.error('❌ Error initializing allowance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initialize allowance',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/allowances/:allowanceId/decrement
 * Decrement allowance (apply usage)
 */
router.post('/allowances/:allowanceId/decrement', async (req, res) => {
    try {
        const { amount } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required'
            });
        }
        
        const result = await ShareRequestAllowanceService.decrementAllowance(
            req.params.allowanceId,
            amount,
            req.user.UserId
        );
        
        res.json({
            success: true,
            data: result,
            message: 'Allowance decremented successfully'
        });
    } catch (error) {
        console.error('❌ Error decrementing allowance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to decrement allowance',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/share-requests/allowances/balance
 * Get allowance balance for a service type
 */
router.get('/allowances/balance', async (req, res) => {
    try {
        const { memberId, enrollmentId, serviceType, serviceCategory } = req.query;
        
        if (!memberId || !enrollmentId || !serviceType) {
            return res.status(400).json({
                success: false,
                message: 'Member ID, enrollment ID, and service type are required'
            });
        }
        
        const balance = await ShareRequestAllowanceService.getAllowanceBalance(
            memberId,
            enrollmentId,
            serviceType,
            serviceCategory || null
        );
        
        res.json({
            success: true,
            data: balance
        });
    } catch (error) {
        console.error('❌ Error fetching allowance balance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch allowance balance',
            error: error.message
        });
    }
});

// ============================================================================
// UA RESET TRACKING
// ============================================================================

const ShareRequestUAResetService = require('../../../services/shareRequestUAResetService');

/**
 * GET /api/me/vendor/share-requests/:id/ua-reset
 * Get UA reset tracking for a share request
 */
router.get('/:id/ua-reset', async (req, res) => {
    try {
        const uaTracking = await ShareRequestUAResetService.getUAResetTracking(req.params.id);
        
        res.json({
            success: true,
            data: uaTracking
        });
    } catch (error) {
        console.error('❌ Error fetching UA reset tracking:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch UA reset tracking',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/:id/ua-reset
 * Initialize UA reset tracking
 */
router.post('/:id/ua-reset', async (req, res) => {
    try {
        const { enrollmentId, uaAmount } = req.body;
        
        if (!enrollmentId || !uaAmount) {
            return res.status(400).json({
                success: false,
                message: 'Enrollment ID and UA amount are required'
            });
        }
        
        const result = await ShareRequestUAResetService.initializeUATracking(
            req.params.id,
            enrollmentId,
            uaAmount,
            req.user.UserId
        );
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }
        
        res.status(201).json({
            success: true,
            data: result,
            message: 'UA tracking initialized successfully'
        });
    } catch (error) {
        console.error('❌ Error initializing UA tracking:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initialize UA tracking',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/ua-reset/:uaResetId/check-reset
 * Check and reset UA if eligible
 */
router.post('/ua-reset/:uaResetId/check-reset', async (req, res) => {
    try {
        const result = await ShareRequestUAResetService.checkAndResetUA(
            req.params.uaResetId,
            req.user.UserId
        );
        
        res.json({
            success: true,
            data: result,
            message: result.reset ? 'UA reset successfully' : result.message
        });
    } catch (error) {
        console.error('❌ Error checking UA reset:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check UA reset',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/share-requests/ua-reset/process-eligible
 * Process all eligible UA resets (batch job)
 */
router.post('/ua-reset/process-eligible', async (req, res) => {
    try {
        const result = await ShareRequestUAResetService.processEligibleUAResets(
            req.vendor.VendorId,
            req.user.UserId
        );
        
        res.json({
            success: true,
            data: result,
            message: `Processed ${result.processed} UA tracking records, ${result.reset} reset`
        });
    } catch (error) {
        console.error('❌ Error processing eligible UA resets:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process eligible UA resets',
            error: error.message
        });
    }
});

console.log('✅ Mounted Share Request routes (including email, call log, SMS, FAP, queues, allowances, and UA reset endpoints)');

module.exports = router;

