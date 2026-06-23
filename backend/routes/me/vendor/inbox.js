// routes/me/vendor/inbox.js
// Back Office email inbox — open to the whole vendor team (VendorAdmin +
// VendorAgent); the shared mailbox is visible to all back-office staff.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md

const express = require('express');
const multer = require('multer');
const router = express.Router();

const { authenticate, authorize } = require('../../../middleware/auth');
const { sendNoteMentionEmails } = require('../../../services/noteMentionService');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');
const { MAX_LARGE_UPLOAD_BYTES } = require('../../../constants/uploadLimits');
const emailThreadService = require('../../../services/emailThreadService');
const emailSendService = require('../../../services/emailSendService');
const emailSyncService = require('../../../services/emailSyncService');
const emailAttachmentService = require('../../../services/emailAttachmentService');

router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

const uploadMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LARGE_UPLOAD_BYTES, files: 10 } });

const userDisplayName = (req) =>
    `${req.user?.FirstName || req.user?.firstName || ''} ${req.user?.LastName || req.user?.lastName || ''}`.trim() || null;
const ctxFromReq = (req) => ({ userId: req.user.UserId, userName: userDisplayName(req) });

// List threads (inbox) -------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        const result = await emailThreadService.listThreads(req.vendor.VendorId, {
            page: req.query.page,
            limit: req.query.limit,
            needsReply: req.query.needsReply,
            unlinked: req.query.unlinked,
            shareRequestId: req.query.shareRequestId,
            caseId: req.query.caseId,
            memberId: req.query.memberId,
            q: req.query.q || req.query.search,
            owner: req.query.owner, // 'mine' | 'unassigned' | (all)
            currentUserId: req.user.UserId,
        });
        res.json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
        console.error('❌ inbox list:', err);
        res.status(500).json({ success: false, message: 'Failed to list threads', error: err.message });
    }
});

// Manual sync (delta reconcile) ---------------------------------------------
router.post('/sync', async (req, res) => {
    try {
        const result = await emailSyncService.reconcileDelta(req.vendor.VendorId);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('❌ inbox sync:', err);
        res.status(502).json({ success: false, message: 'Sync failed', error: err.message });
    }
});

// Compose a brand-new email -------------------------------------------------
router.post('/compose', uploadMulter.array('files', 10), async (req, res) => {
    try {
        const { to, toName, subject, bodyHtml, memberId, caseId, shareRequestId } = req.body || {};
        const thread = await emailSendService.sendNew(req.vendor.VendorId, {
            to, toName, subject, bodyHtml,
            memberId: memberId || undefined,
            caseId: caseId || undefined,
            shareRequestId: shareRequestId || undefined,
            files: req.files || [],
            ctx: ctxFromReq(req),
        });
        res.status(201).json({ success: true, data: thread });
    } catch (err) {
        console.error('❌ inbox compose:', err);
        res.status(err.statusCode || 502).json({ success: false, message: 'Failed to send email', error: err.message });
    }
});

// Member's open SRs/cases — for the compose-new link pickers -----------------
router.get('/member-link-options', async (req, res) => {
    try {
        if (!req.query.memberId) return res.status(400).json({ success: false, message: 'memberId is required' });
        const data = await emailThreadService.getMemberLinkOptions(req.vendor.VendorId, req.query.memberId);
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ inbox member-link-options:', err);
        res.status(500).json({ success: false, message: 'Failed to load link options', error: err.message });
    }
});

// Customer email history — every thread for a member and/or counterparty address,
// grouped by conversation (read-only "Show history" modal). Registered before
// '/:threadId' so the literal path isn't swallowed by the param route.
router.get('/customer-history', async (req, res) => {
    try {
        const data = await emailThreadService.getCustomerHistory(req.vendor.VendorId, {
            memberId: req.query.memberId || null,
            address: req.query.address || null,
            scope: req.query.scope || 'both',
            caseId: req.query.caseId || null,
            shareRequestId: req.query.shareRequestId || null,
        });
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ inbox customer-history:', err);
        res.status(500).json({ success: false, message: 'Failed to load customer history', error: err.message });
    }
});

// Single thread --------------------------------------------------------------
router.get('/:threadId', async (req, res) => {
    try {
        const thread = await emailThreadService.getThread(req.vendor.VendorId, req.params.threadId);
        if (!thread) return res.status(404).json({ success: false, message: 'Thread not found' });
        res.json({ success: true, data: thread });
    } catch (err) {
        console.error('❌ inbox get thread:', err);
        res.status(500).json({ success: false, message: 'Failed to get thread', error: err.message });
    }
});

// Collision presence (viewing / replying) -----------------------------------
router.get('/:threadId/presence', async (req, res) => {
    try {
        const data = await emailThreadService.getPresence(req.vendor.VendorId, req.params.threadId);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to get presence', error: err.message });
    }
});

router.post('/:threadId/presence', async (req, res) => {
    try {
        const data = await emailThreadService.heartbeatPresence(
            req.vendor.VendorId, req.params.threadId, req.user.UserId, userDisplayName(req), req.body?.state
        );
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to set presence', error: err.message });
    }
});

router.post('/:threadId/presence/stop', async (req, res) => {
    try {
        await emailThreadService.clearPresence(req.vendor.VendorId, req.params.threadId, req.user.UserId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to clear presence', error: err.message });
    }
});

router.post('/:threadId/read', async (req, res) => {
    try {
        const thread = await emailThreadService.markThreadRead(req.vendor.VendorId, req.params.threadId);
        res.json({ success: true, data: thread });
    } catch (err) {
        console.error('❌ inbox mark read:', err);
        res.status(500).json({ success: false, message: 'Failed to mark read', error: err.message });
    }
});

router.get('/:threadId/attachments', async (req, res) => {
    try {
        const data = await emailAttachmentService.listForThread(req.vendor.VendorId, req.params.threadId);
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ inbox attachments:', err);
        res.status(500).json({ success: false, message: 'Failed to list attachments', error: err.message });
    }
});

router.get('/:threadId/match-suggestion', async (req, res) => {
    try {
        const data = await emailThreadService.getThreadSuggestion(req.vendor.VendorId, req.params.threadId);
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ inbox match-suggestion:', err);
        res.status(500).json({ success: false, message: 'Failed to compute suggestion', error: err.message });
    }
});

router.post('/:threadId/dismiss-suggestion', async (req, res) => {
    try {
        await emailThreadService.dismissSuggestion(req.vendor.VendorId, req.params.threadId);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ inbox dismiss-suggestion:', err);
        res.status(500).json({ success: false, message: 'Failed to dismiss suggestion', error: err.message });
    }
});

router.get('/:threadId/suggest-links', async (req, res) => {
    try {
        const data = await emailThreadService.suggestLinks(req.vendor.VendorId, req.params.threadId);
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ inbox suggest-links:', err);
        res.status(500).json({ success: false, message: 'Failed to suggest links', error: err.message });
    }
});

router.post('/:threadId/link', async (req, res) => {
    try {
        const { memberId, caseId, shareRequestId } = req.body || {};
        const thread = await emailThreadService.linkThread(
            req.vendor.VendorId, req.params.threadId,
            { memberId, caseId, shareRequestId }, ctxFromReq(req)
        );
        res.json({ success: true, data: thread });
    } catch (err) {
        console.error('❌ inbox link:', err);
        res.status(err.statusCode || 500).json({ success: false, message: 'Failed to link thread', error: err.message });
    }
});

router.post('/:threadId/unlink', async (req, res) => {
    try {
        const thread = await emailThreadService.unlinkThread(req.vendor.VendorId, req.params.threadId, ctxFromReq(req));
        res.json({ success: true, data: thread });
    } catch (err) {
        console.error('❌ inbox unlink:', err);
        res.status(500).json({ success: false, message: 'Failed to unlink thread', error: err.message });
    }
});

// Soft-assign a thread's owner. body: { ownerUserId } — send the caller's id to
// claim, "me" as a shortcut, or null/"" to unassign. Not a lock.
router.post('/:threadId/assign', async (req, res) => {
    try {
        let { ownerUserId } = req.body || {};
        if (ownerUserId === 'me') ownerUserId = req.user.UserId;
        const thread = await emailThreadService.assignThread(req.vendor.VendorId, req.params.threadId, ownerUserId || null);
        res.json({ success: true, data: thread });
    } catch (err) {
        console.error('❌ inbox assign:', err);
        res.status(500).json({ success: false, message: 'Failed to assign thread', error: err.message });
    }
});

router.post('/:threadId/reply', uploadMulter.array('files', 10), async (req, res) => {
    try {
        const { bodyHtml, replyAll } = req.body || {};
        if (!bodyHtml || !String(bodyHtml).trim()) {
            return res.status(400).json({ success: false, message: 'bodyHtml is required' });
        }
        const message = await emailSendService.sendReply(req.vendor.VendorId, {
            threadId: req.params.threadId,
            bodyHtml,
            replyAll: replyAll === true || replyAll === 'true',
            files: req.files || [],
            ctx: ctxFromReq(req),
        });
        res.json({ success: true, data: message });
    } catch (err) {
        console.error('❌ inbox reply:', err);
        res.status(err.statusCode || 502).json({ success: false, message: 'Failed to send reply', error: err.message });
    }
});

// Internal notes (team-only) -------------------------------------------------
router.get('/:threadId/notes', async (req, res) => {
    try {
        const data = await emailThreadService.listThreadNotes(req.vendor.VendorId, req.params.threadId);
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ inbox notes list:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

router.post('/:threadId/notes', async (req, res) => {
    try {
        const note = await emailThreadService.addThreadNote(req.vendor.VendorId, req.params.threadId, {
            note: req.body?.note,
            userId: req.user.UserId,
            userName: userDisplayName(req),
        });
        const mentionedUserIds = req.body?.mentionedUserIds;
        if (Array.isArray(mentionedUserIds) && mentionedUserIds.length > 0) {
            const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
            sendNoteMentionEmails({
                authorUserId: req.user.UserId,
                authorName: userDisplayName(req),
                mentionedUserIds,
                vendorId: req.vendor.VendorId,
                contextType: 'email',
                contextId: req.params.threadId,
                noteText: req.body?.note,
                baseUrl,
            }).catch((e) => console.error('[inbox notes] mention emails failed:', e.message));
        }
        res.status(201).json({ success: true, data: note });
    } catch (err) {
        console.error('❌ inbox note add:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// "Handled" resolution -------------------------------------------------------
router.post('/:threadId/resolve', async (req, res) => {
    try {
        // Optional note explaining how it was handled (e.g. "sent ACH form via forms page").
        if (req.body?.note && String(req.body.note).trim()) {
            await emailThreadService.addThreadNote(req.vendor.VendorId, req.params.threadId, {
                note: req.body.note, userId: req.user.UserId, userName: userDisplayName(req),
            });
        }
        const data = await emailThreadService.setThreadResolved(req.vendor.VendorId, req.params.threadId, req.user.UserId, true);
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ inbox resolve:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

router.post('/:threadId/unresolve', async (req, res) => {
    try {
        const data = await emailThreadService.setThreadResolved(req.vendor.VendorId, req.params.threadId, req.user.UserId, false);
        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ inbox unresolve:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

module.exports = router;
