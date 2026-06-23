// routes/me/vendor/case-studies.js
// Case Study (Patient/Client Success Story) routes for the Vendor Portal.
// Vendors author case studies from completed share requests; the marketing websites
// will later pull published ones via a separate public endpoint.

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { requireShareRequestAccess } = require('../../../middleware/shareRequestAccess');
const CaseStudyService = require('../../../services/caseStudyService');

// All routes require authentication + vendor (Share Request module) access.
router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(requireShareRequestAccess);

const GUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const isGuid = (v) => typeof v === 'string' && GUID_RE.test(v);

/**
 * GET /api/me/vendor/case-studies
 * List case studies for the vendor (optional ?status= & ?brand= filters).
 */
router.get('/', async (req, res) => {
    try {
        const data = await CaseStudyService.list(req.vendor.VendorId, {
            status: req.query.status,
            brand: req.query.brand,
        });
        res.json({ success: true, data });
    } catch (error) {
        console.error('❌ Error listing case studies:', error);
        res.status(500).json({ success: false, message: 'Failed to list case studies', error: error.message });
    }
});

/**
 * GET /api/me/vendor/case-studies/prefill/:shareRequestId
 * Build an auto-populated draft from a completed share request (not persisted).
 */
router.get('/prefill/:shareRequestId', async (req, res) => {
    try {
        if (!isGuid(req.params.shareRequestId)) {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }
        const draft = await CaseStudyService.getPrefill(req.params.shareRequestId, req.vendor.VendorId);
        if (!draft) {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }
        res.json({ success: true, data: draft });
    } catch (error) {
        console.error('❌ Error building case study prefill:', error);
        res.status(500).json({ success: false, message: 'Failed to build case study draft', error: error.message });
    }
});

/**
 * GET /api/me/vendor/case-studies/:id
 */
router.get('/:id', async (req, res) => {
    try {
        if (!isGuid(req.params.id)) {
            return res.status(404).json({ success: false, message: 'Case study not found' });
        }
        const data = await CaseStudyService.getById(req.params.id, req.vendor.VendorId);
        if (!data) {
            return res.status(404).json({ success: false, message: 'Case study not found' });
        }
        res.json({ success: true, data });
    } catch (error) {
        console.error('❌ Error fetching case study:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch case study', error: error.message });
    }
});

/**
 * POST /api/me/vendor/case-studies
 */
router.post('/', async (req, res) => {
    try {
        const data = await CaseStudyService.create(req.vendor.VendorId, req.user.UserId, req.body || {});
        res.status(201).json({ success: true, data });
    } catch (error) {
        console.error('❌ Error creating case study:', error);
        res.status(500).json({ success: false, message: 'Failed to create case study', error: error.message });
    }
});

/**
 * PUT /api/me/vendor/case-studies/:id
 */
router.put('/:id', async (req, res) => {
    try {
        if (!isGuid(req.params.id)) {
            return res.status(404).json({ success: false, message: 'Case study not found' });
        }
        const data = await CaseStudyService.update(
            req.params.id,
            req.vendor.VendorId,
            req.user.UserId,
            req.body || {}
        );
        if (!data) {
            return res.status(404).json({ success: false, message: 'Case study not found' });
        }
        res.json({ success: true, data });
    } catch (error) {
        console.error('❌ Error updating case study:', error);
        res.status(500).json({ success: false, message: 'Failed to update case study', error: error.message });
    }
});

/**
 * DELETE /api/me/vendor/case-studies/:id
 * Permanently delete a case study (vendor-scoped). It disappears from the public
 * website endpoint on the next fetch.
 */
router.delete('/:id', async (req, res) => {
    try {
        if (!isGuid(req.params.id)) {
            return res.status(404).json({ success: false, message: 'Case study not found' });
        }
        const ok = await CaseStudyService.remove(req.params.id, req.vendor.VendorId);
        if (!ok) {
            return res.status(404).json({ success: false, message: 'Case study not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error deleting case study:', error);
        res.status(500).json({ success: false, message: 'Failed to delete case study', error: error.message });
    }
});

module.exports = router;
