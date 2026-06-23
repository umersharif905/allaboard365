// routes/me/member/sharing-requests.js
// Member portal routes for sharing requests

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getPool, sql } = require('../../../config/database');
const ShareRequestService = require('../../../services/shareRequestService');
const { generateAuthenticatedUrl, isBlobUrl } = require('../../uploads');
const { MAX_UPLOAD_FILE_BYTES } = require('../../../constants/uploadLimits');
const { VENDOR_VISIBLE_PLAN_STATUSES_SQL } = require('../../../constants/enrollmentStatus');

// Configure multer for file uploads
const uploadMulter = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_FILE_BYTES
    }
});

/**
 * GET /api/me/member/sharing-requests
 * Get all share requests for the authenticated member
 */
router.get('/', async (req, res) => {
    try {
        const userId = req.user.UserId;
        const pool = await getPool();
        
        // Get member ID from user
        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT m.MemberId, m.HouseholdId
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId
            `);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        
        const { MemberId, HouseholdId } = memberResult.recordset[0];

        // Get all share requests for this member's household
        const requests = await ShareRequestService.getShareRequestsByHousehold(HouseholdId);

        // Enrich each request with the member's plan "Unshared Amount" (UA) — the
        // same value the care team sees on the request header. Cached per
        // member+vendor: all of a member's requests for a vendor share one plan,
        // so we resolve the UA at most once per plan.
        const uaCache = new Map();
        for (const r of requests) {
            const key = `${r.MemberId}|${r.VendorId}`;
            if (!uaCache.has(key)) {
                let planUA = null;
                try {
                    const hp = await ShareRequestService.getShareRequestHeaderPlan(r.ShareRequestId, r.VendorId);
                    planUA = hp ? hp.UAValue : null;
                } catch (e) {
                    // Non-fatal: UA just won't show for this request.
                }
                uaCache.set(key, planUA);
            }
            r.PlanUAValue = uaCache.get(key);
        }

        res.json({
            success: true,
            data: requests
        });
    } catch (error) {
        console.error('Error fetching member share requests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch share requests',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/me/member/sharing-requests/:id
 * Get a single share request by ID (must belong to member's household)
 */
router.get('/:id', async (req, res) => {
    try {
        const userId = req.user.UserId;
        const { id } = req.params;
        const pool = await getPool();
        
        // Get member ID from user
        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT m.MemberId, m.HouseholdId
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId
            `);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        
        const { HouseholdId } = memberResult.recordset[0];
        
        // Get share request and verify it belongs to member's household
        const request = await ShareRequestService.getShareRequestByIdForMember(id);
        
        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }
        
        // Verify household access
        if (request.HouseholdId !== HouseholdId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        // Member's plan "Unshared Amount" (UA) — same value shown to the care team.
        try {
            const hp = await ShareRequestService.getShareRequestHeaderPlan(request.ShareRequestId, request.VendorId);
            request.PlanUAValue = hp ? hp.UAValue : null;
        } catch (e) {
            request.PlanUAValue = null;
        }

        res.json({
            success: true,
            data: request
        });
    } catch (error) {
        console.error('Error fetching share request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch share request',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/me/member/sharing-requests/:id/documents
 * Get documents for a share request (must belong to member's household)
 */
router.get('/:id/documents', async (req, res) => {
    try {
        const userId = req.user.UserId;
        const { id } = req.params;
        const pool = await getPool();

        // Get member's household from user
        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT m.MemberId, m.HouseholdId
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId
            `);

        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }

        const { HouseholdId } = memberResult.recordset[0];

        // Verify the share request belongs to the member's household
        const request = await ShareRequestService.getShareRequestByIdForMember(id);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }

        if (request.HouseholdId !== HouseholdId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        const documents = await ShareRequestService.getDocuments(id);

        // Sign the stored full BlobUrl so member uploads (public-form-uploads
        // container) and vendor uploads (members container) both resolve.
        // Mirrors routes/me/vendor/share-requests.js:/:id/documents.
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
        console.error('Error fetching share request documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch documents',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/me/member/sharing-requests
 * Create a new share request (member submission)
 */
router.post('/', async (req, res) => {
    try {
        const userId = req.user.UserId;
        const pool = await getPool();
        
        // Get member ID from user
        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT m.MemberId, m.HouseholdId, m.GroupId
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId
            `);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        
        const { MemberId, HouseholdId, GroupId } = memberResult.recordset[0];
        
        // Get vendor ID from member's product enrollments.
        // We include the full set of vendor-visible plan statuses (Active, Pending,
        // Pending Payment, PaymentHold) plus any pending-migration enrollment. Migrated
        // (E123) members enrolled in a vendor's products carry 'Pending Payment' +
        // IsPendingMigration=1 enrollments and are NOT paying through AllAboard365, but
        // they must still be able to submit share requests. Restricting to Status='Active'
        // here previously blocked every migrated member. Mirrors the visibility rule in
        // ShareRequestService.getMemberPlansByMemberId().
        const vendorResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, MemberId)
            .query(`
                SELECT TOP 1 p.VendorId
                FROM oe.Enrollments e
                JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE e.MemberId = @memberId
                AND (
                    e.Status IN (${VENDOR_VISIBLE_PLAN_STATUSES_SQL})
                    OR ISNULL(e.IsPendingMigration, 0) = 1
                )
                AND p.VendorId IS NOT NULL
                ORDER BY
                    CASE WHEN e.Status = 'Active' THEN 0 ELSE 1 END,
                    e.EffectiveDate DESC
            `);

        if (vendorResult.recordset.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No vendor products found for this member'
            });
        }
        
        const vendorId = vendorResult.recordset[0].VendorId;
        
        const {
            requestName,
            requestDescription,
            requestType, // Medical, Maternity, Wellness
            categoryId,
            dateOfService,
            dateOfServiceEnd,
            diagnosisDescription,
            generalNotes
        } = req.body;
        
        // Create the share request
        const result = await ShareRequestService.createShareRequest(
            vendorId,
            {
                memberId: MemberId,
                householdId: HouseholdId,
                requestName: requestName || null,
                requestDescription: requestDescription || null,
                requestType: requestType || 'Medical',
                categoryId: categoryId || null,
                status: 'New',
                determination: 'Pending',
                dateOfService: dateOfService ? new Date(dateOfService) : null,
                dateOfServiceEnd: dateOfServiceEnd ? new Date(dateOfServiceEnd) : null,
                diagnosisDescription: diagnosisDescription || null,
                generalNotes: generalNotes || null,
                createdVia: 'form'
            },
            userId
        );
        
        res.status(201).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error creating share request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create share request',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/me/member/sharing-requests/:id/documents
 * Upload a document for a share request
 */
router.post('/:id/documents', uploadMulter.single('file'), async (req, res) => {
    try {
        const userId = req.user.UserId;
        const { id } = req.params;
        const pool = await getPool();
        
        // Verify member access
        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT m.MemberId, m.HouseholdId
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId
            `);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        
        const { HouseholdId } = memberResult.recordset[0];
        
        // Verify share request belongs to member's household
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, id)
            .query(`
                SELECT HouseholdId FROM oe.ShareRequests WHERE ShareRequestId = @shareRequestId
            `);
        
        if (srResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Share request not found'
            });
        }
        
        if (srResult.recordset[0].HouseholdId !== HouseholdId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        // Use the existing document upload service
        const ShareRequestDocumentService = require('../../../services/shareRequestDocumentService');
        const result = await ShareRequestDocumentService.uploadDocument(
            id,
            req.file,
            req.body.documentType || 'Member Upload',
            userId
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error uploading document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload document',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;

