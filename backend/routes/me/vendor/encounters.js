// routes/me/vendor/encounters.js
// Encounters — back-office vendor portal. See spec at
// docs/superpowers/specs/2026-05-15-encounters-design.md.
// Only VendorAdmin / VendorAgent.

const express = require('express');
const multer = require('multer');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');
const EncounterService = require('../../../services/encounterService');
const { MAX_LARGE_UPLOAD_BYTES } = require('../../../constants/uploadLimits');

router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

const userDisplayName = (req) =>
    `${req.user?.FirstName || req.user?.firstName || ''} ${req.user?.LastName || req.user?.lastName || ''}`.trim() || null;

const ctxFromReq = (req) => ({
    userId: req.user.UserId,
    userName: userDisplayName(req)
});

// ---------------------------------------------------------------------------
// Blob client (lazy init; mirrors share-requests / cases pattern)
// ---------------------------------------------------------------------------
let encounterBlobClient;
try {
    const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (cs) {
        encounterBlobClient = BlobServiceClient.fromConnectionString(cs);
        console.log('✅ Azure Blob client initialized for encounter attachments');
    }
} catch (e) {
    console.error('❌ Failed to init Azure Blob client (encounters):', e.message);
}

const uploadMulter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LARGE_UPLOAD_BYTES, files: 10 },
    fileFilter: (req, file, cb) => {
        const allowed = new Set([
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/csv', 'text/plain',
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp'
        ]);
        return allowed.has(file.mimetype) ? cb(null, true) : cb(new Error(`File type ${file.mimetype} not allowed`));
    }
});

// ---------------------------------------------------------------------------
// META / DASHBOARD
// ---------------------------------------------------------------------------

router.get('/meta', (req, res) => {
    res.json({
        success: true,
        data: {
            channels: EncounterService.ENCOUNTER_CHANNELS,
            directions: EncounterService.ENCOUNTER_DIRECTIONS,
            sources: EncounterService.ENCOUNTER_SOURCES
        }
    });
});

router.get('/dashboard', async (req, res) => {
    try {
        const stats = await EncounterService.getDashboardStats(req.vendor.VendorId, req.user.UserId);
        res.json({ success: true, data: stats });
    } catch (err) {
        console.error('❌ encounters dashboard:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard', error: err.message });
    }
});

// Must come before GET /:id so the literal segment isn't swallowed.
router.get('/assignees', async (req, res) => {
    try {
        const data = await EncounterService.getAssignees(req.vendor.VendorId, req.user.UserId);
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ encounters assignees:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch assignees', error: err.message });
    }
});

// ---------------------------------------------------------------------------
// LIST + CRUD
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
    try {
        let assignedToUserId = req.query.assignedToUserId;
        if (assignedToUserId === 'me') assignedToUserId = req.user.UserId;

        // ?mine=true means "encounters I created" (see EncounterListRail "Opened by me" pill).
        const createdByUserId = (req.query.mine === 'true' || req.query.mine === '1')
            ? req.user.UserId
            : req.query.createdByUserId;

        const result = await EncounterService.listEncounters(req.vendor.VendorId, {
            page: req.query.page,
            limit: req.query.limit,
            noMember: req.query.noMember,
            archived: req.query.archived,
            assignedToUserId,
            createdByUserId,
            memberId: req.query.memberId,
            caseId: req.query.caseId,
            shareRequestId: req.query.shareRequestId,
            channel: req.query.channel,
            direction: req.query.direction,
            followUp: req.query.followUp,
            q: req.query.q || req.query.search
        });
        res.json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
        console.error('❌ encounters list:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch encounters', error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const row = await EncounterService.getEncounterById(req.vendor.VendorId, req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Encounter not found' });
        res.json({ success: true, data: row });
    } catch (err) {
        console.error('❌ encounter get:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch encounter', error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const row = await EncounterService.createEncounter(req.vendor.VendorId, req.body || {}, ctxFromReq(req));
        res.status(201).json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ encounter create:', err);
        res.status(status).json({ success: false, message: err.message || 'Failed to create encounter' });
    }
});

router.patch('/:id', async (req, res) => {
    try {
        const row = await EncounterService.updateEncounter(req.vendor.VendorId, req.params.id, req.body || {}, ctxFromReq(req));
        res.json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ encounter update:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await EncounterService.archiveEncounter(req.vendor.VendorId, req.params.id, ctxFromReq(req));
        res.json({ success: true });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ encounter archive:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// ASSIGN + FOLLOW-UP + CONVERT
// ---------------------------------------------------------------------------

router.post('/:id/assign', async (req, res) => {
    try {
        const userId = req.body?.userId === null ? null : (req.body?.userId || req.user.UserId);
        const row = await EncounterService.assignEncounter(req.vendor.VendorId, req.params.id, userId, ctxFromReq(req));
        res.json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ encounter assign:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.post('/:id/follow-up/complete', async (req, res) => {
    try {
        const row = await EncounterService.completeFollowUp(req.vendor.VendorId, req.params.id, ctxFromReq(req));
        res.json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ encounter follow-up complete:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.post('/:id/convert-to-case', async (req, res) => {
    try {
        const result = await EncounterService.convertToCase(req.vendor.VendorId, req.params.id, {
            title: req.body?.title,
            description: req.body?.description,
            caseType: req.body?.caseType,
            caseSubcategory: req.body?.caseSubcategory,
            subcategoryDetail: req.body?.subcategoryDetail
        }, ctxFromReq(req));
        res.status(201).json({ success: true, data: result });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ encounter convert-to-case:', err);
        res.status(status).json({ success: false, message: err.message, code: err.code });
    }
});

// ---------------------------------------------------------------------------
// ATTACHMENTS
// ---------------------------------------------------------------------------

router.get('/:id/attachments', async (req, res) => {
    try {
        const items = await EncounterService.listAttachments(req.vendor.VendorId, req.params.id);
        const enriched = await Promise.all(items.map(async (att) => {
            if (att.BlobUrl && encounterBlobClient) {
                try {
                    const containerClient = encounterBlobClient.getContainerClient('members');
                    const blobPath = att.BlobPath || att.BlobUrl.split('/members/')[1]?.split('?')[0];
                    if (blobPath) {
                        const expiresOn = new Date();
                        expiresOn.setHours(expiresOn.getHours() + 1);
                        const sas = generateBlobSASQueryParameters({
                            containerName: 'members',
                            blobName: blobPath,
                            permissions: BlobSASPermissions.parse('r'),
                            expiresOn,
                            startsOn: new Date()
                        }, encounterBlobClient.credential).toString();
                        att.AuthenticatedUrl = `${containerClient.getBlockBlobClient(blobPath).url}?${sas}`;
                    }
                } catch (e) {
                    console.warn('encounter attachment SAS failed:', e.message);
                    att.AuthenticatedUrl = att.BlobUrl;
                }
            }
            return att;
        }));
        res.json({ success: true, data: enriched });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ encounter attachments list:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.post('/:id/attachments', uploadMulter.array('files', 10), async (req, res) => {
    try {
        if (!encounterBlobClient) return res.status(503).json({ success: false, message: 'Storage service unavailable' });

        const enc = await EncounterService.getEncounterById(req.vendor.VendorId, req.params.id);
        if (!enc) return res.status(404).json({ success: false, message: 'Encounter not found' });

        const files = req.files || [];
        if (files.length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });

        // Use the encounter's member household for path scoping. If the encounter
        // has no member assigned, put it under a vendor-scoped folder so the path
        // is still meaningful and not tied to a placeholder member.
        // The literal "_triage/" path segment is preserved for backward compat with
        // already-uploaded blobs; not user-facing.
        const householdId = enc.MemberId
            ? await EncounterService.getMemberHousehold(enc.MemberId)
            : null;
        const containerClient = encounterBlobClient.getContainerClient('members');
        await containerClient.createIfNotExists();

        const uploaded = [];
        for (const file of files) {
            const ext = file.originalname.split('.').pop();
            const uniqueName = `${uuidv4()}.${ext}`;
            const scope = householdId
                ? `${householdId}/encounters/${enc.EncounterId}`
                : `_triage/${req.vendor.VendorId}/encounters/${enc.EncounterId}`;
            const blobPath = `${scope}/${uniqueName}`;
            const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
            await blockBlobClient.uploadData(file.buffer, {
                blobHTTPHeaders: { blobContentType: file.mimetype },
                metadata: {
                    originalName: encodeURIComponent(file.originalname),
                    encounterId: enc.EncounterId,
                    householdId: householdId ? String(householdId) : 'triage'
                }
            });
            const rec = await EncounterService.createAttachmentRecord(req.vendor.VendorId, enc.EncounterId, {
                fileName: file.originalname,
                mimeType: file.mimetype,
                fileSize: file.size,
                blobUrl: blockBlobClient.url,
                blobPath,
                description: req.body?.description || null,
                uploadedBy: userDisplayName(req) || 'Vendor'
            }, ctxFromReq(req));
            uploaded.push({ attachmentId: rec.AttachmentId, fileName: file.originalname });
        }
        res.status(201).json({ success: true, data: uploaded });
    } catch (err) {
        console.error('❌ encounter attachment upload:', err);
        res.status(500).json({ success: false, message: 'Attachment upload failed', error: err.message });
    }
});

router.delete('/:id/attachments/:attachmentId', async (req, res) => {
    try {
        const ok = await EncounterService.softDeleteAttachment(req.vendor.VendorId, req.params.id, req.params.attachmentId);
        if (!ok) return res.status(404).json({ success: false, message: 'Attachment not found' });
        res.json({ success: true });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ encounter attachment delete:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

module.exports = router;
