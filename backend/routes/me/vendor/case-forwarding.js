// backend/routes/me/vendor/case-forwarding.js
// VendorAdmin-managed TPA forwarding targets + per-case preview/send.
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');
const CaseForwardingService = require('../../../services/caseForwardingService');

router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

// VendorAdmin-only guard for settings mutations
const requireVendorAdmin = (req, res, next) => {
  if (req.user.currentRole !== 'VendorAdmin' && req.user.UserType !== 'VendorAdmin') {
    return res.status(403).json({ success: false, message: 'VendorAdmin required' });
  }
  next();
};

// --- Settings CRUD ---
router.get('/targets', async (req, res) => {
  try {
    const rows = await CaseForwardingService.listTargets(req.vendor.VendorId);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('❌ forwarding targets list:', err);
    res.status(500).json({ success: false, message: 'Failed to list targets', error: err.message });
  }
});

router.post('/targets', requireVendorAdmin, async (req, res) => {
  try {
    const row = await CaseForwardingService.createTarget(req.vendor.VendorId, {
      planVendorId: req.body?.planVendorId,
      label: req.body?.label,
      forwardingEmails: req.body?.forwardingEmails,
      templateId: req.body?.templateId,
      userId: req.user.UserId,
    });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('❌ forwarding target create:', err);
    res.status(500).json({ success: false, message: 'Failed to create target', error: err.message });
  }
});

router.put('/targets/:id', requireVendorAdmin, async (req, res) => {
  try {
    const row = await CaseForwardingService.updateTarget(req.vendor.VendorId, req.params.id, {
      label: req.body?.label,
      forwardingEmails: req.body?.forwardingEmails,
      templateId: req.body?.templateId,
      isActive: req.body?.isActive,
      userId: req.user.UserId,
    });
    if (!row) return res.status(404).json({ success: false, message: 'Target not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('❌ forwarding target update:', err);
    res.status(500).json({ success: false, message: 'Failed to update target', error: err.message });
  }
});

router.delete('/targets/:id', requireVendorAdmin, async (req, res) => {
  try {
    await CaseForwardingService.deleteTarget(req.vendor.VendorId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ forwarding target delete:', err);
    res.status(500).json({ success: false, message: 'Failed to delete target', error: err.message });
  }
});

router.get('/cases/:id/preview', async (req, res) => {
  try {
    const payload = await CaseForwardingService.buildPreview(req.vendor.VendorId, req.params.id);
    res.json({ success: true, data: payload });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('❌ forwarding preview:', err);
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/cases/:id/send', async (req, res) => {
  try {
    const result = await CaseForwardingService.send(req.vendor.VendorId, req.params.id, {
      to: req.body?.to,
      subject: req.body?.subject,
      body: req.body?.body,
      documentIds: req.body?.documentIds || [],
      userId: req.user.UserId,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('❌ forwarding send:', err);
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/starter-template', requireVendorAdmin, async (req, res) => {
  try {
    const row = await CaseForwardingService.createStarterTemplate(req.vendor.VendorId, req.body?.variant, req.user.UserId);
    res.json({ success: true, data: row });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('❌ starter template:', err);
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
