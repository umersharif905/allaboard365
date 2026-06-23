// routes/me/vendor/notifications.js
// In-app notifications for back-office (vendor) users, backed by oe.Notifications.
//
// Rows are written by:
//   - noteMentionService        — when a teammate @-mentions the user in a
//                                 Share Request / Case note ('mention').
//   - publicFormSubmissionService — when a public form owned by the user's
//                                 vendor receives a submission ('form-submission').
//
// Read state is server-side (IsRead/ReadDate on each row), so the unread badge
// stays consistent across devices. Every query is scoped to the caller's
// UserId AND VendorId for tenant/vendor isolation.

const express = require('express');
const { authenticate, authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');
const notificationService = require('../../../services/notificationService');

const router = express.Router();
router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

// GET /api/me/vendor/notifications — newest first + unread count.
router.get('/', async (req, res) => {
    try {
        const { data, unreadCount } = await notificationService.listForVendorUser({
            userId: req.user.UserId,
            vendorId: req.vendor.VendorId
        });
        res.json({ success: true, data, unreadCount });
    } catch (error) {
        console.error('❌ notifications list:', error);
        // The table may not exist yet (migration not run) — degrade gracefully
        // so the bell renders empty instead of erroring the header.
        res.json({ success: true, data: [], unreadCount: 0 });
    }
});

// POST /api/me/vendor/notifications/mark-read — body { ids: string[] }.
router.post('/mark-read', async (req, res) => {
    try {
        const { updated } = await notificationService.markRead({
            userId: req.user.UserId,
            vendorId: req.vendor.VendorId,
            ids: req.body?.ids
        });
        res.json({ success: true, updated });
    } catch (error) {
        console.error('❌ notifications mark-read:', error);
        res.status(500).json({ success: false, message: 'Failed to mark notifications read' });
    }
});

// POST /api/me/vendor/notifications/mark-all-read.
router.post('/mark-all-read', async (req, res) => {
    try {
        const { updated } = await notificationService.markAllRead({
            userId: req.user.UserId,
            vendorId: req.vendor.VendorId
        });
        res.json({ success: true, updated });
    } catch (error) {
        console.error('❌ notifications mark-all-read:', error);
        res.status(500).json({ success: false, message: 'Failed to mark notifications read' });
    }
});

module.exports = router;
