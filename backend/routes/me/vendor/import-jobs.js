'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const vendorImportJobService = require('../../../services/vendorImportJobService');
const vendorImportJobRunService = require('../../../services/vendorImportJobRunService');
const sftpImportOrchestrator = require('../../../services/sftpImportOrchestrator');

router.use(authenticate);
router.use(authorize(['VendorAdmin']));

function getVendorId(req) {
  return req.user?.VendorId || null;
}

/** Accept array or JSON string (legacy clients double-encoded notifyEmails). */
function coerceNotifyEmails(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value.split(',').map((e) => e.trim()).filter(Boolean);
    }
  }
  return undefined;
}

// GET /api/me/vendor/import-jobs
router.get('/', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const data = await vendorImportJobService.listJobs(vendorId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/me/vendor/import-jobs
router.post('/', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const b = req.body || {};
    const data = await vendorImportJobService.createJob({
      vendorId,
      connectionId: b.connectionId,
      tenantId: b.tenantId,
      jobName: b.jobName,
      notifyEmails: coerceNotifyEmails(b.notifyEmails),
      subFolderPath: b.subFolderPath,
      formatSlug: b.formatSlug,
      cronScheduleUtc: b.cronScheduleUtc,
      archiveFolder: b.archiveFolder,
      notifyOnSuccess: b.notifyOnSuccess,
      notifyOnFailure: b.notifyOnFailure,
      notifyOnNoFiles: b.notifyOnNoFiles,
      allowTenantMove: b.allowTenantMove,
      skipHouseholdWithUnmappedPlans: b.skipHouseholdWithUnmappedPlans,
      createdBy: req.user?.UserId || null,
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    const status = /required|invalid|not eligible|not found|unknown format/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// GET /api/me/vendor/import-jobs/:jobId
router.get('/:jobId', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const data = await vendorImportJobService.getJob(req.params.jobId, vendorId);
    if (!data) return res.status(404).json({ success: false, message: 'Import job not found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/me/vendor/import-jobs/:jobId
router.put('/:jobId', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const b = req.body || {};
    const data = await vendorImportJobService.updateJob(req.params.jobId, vendorId, {
      connectionId: b.connectionId,
      tenantId: b.tenantId,
      jobName: b.jobName,
      subFolderPath: b.subFolderPath,
      formatSlug: b.formatSlug,
      cronScheduleUtc: b.cronScheduleUtc,
      archiveFolder: b.archiveFolder,
      notifyEmails: coerceNotifyEmails(b.notifyEmails),
      notifyOnSuccess: b.notifyOnSuccess,
      notifyOnFailure: b.notifyOnFailure,
      notifyOnNoFiles: b.notifyOnNoFiles,
      allowTenantMove: b.allowTenantMove,
      skipHouseholdWithUnmappedPlans: b.skipHouseholdWithUnmappedPlans,
    });
    if (!data) return res.status(404).json({ success: false, message: 'Import job not found' });
    res.json({ success: true, data });
  } catch (err) {
    const status = /invalid|not eligible|not found|unknown format/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// DELETE /api/me/vendor/import-jobs/:jobId
router.delete('/:jobId', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    await vendorImportJobService.deleteJob(req.params.jobId, vendorId);
    res.json({ success: true, message: 'Import job deleted' });
  } catch (err) {
    const status = err.statusCode === 409 ? 409 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// PATCH /api/me/vendor/import-jobs/:jobId/enable
router.patch('/:jobId/enable', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const enabled = req.body?.enabled !== false && req.body?.enabled !== 0;
    const data = await vendorImportJobService.setEnabled(req.params.jobId, vendorId, enabled);
    if (!data) return res.status(404).json({ success: false, message: 'Import job not found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/me/vendor/import-jobs/:jobId/cancel-run
router.post('/:jobId/cancel-run', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const result = await vendorImportJobRunService.cancelJobRuns(
      req.params.jobId,
      vendorId,
      { reason: req.body?.reason }
    );
    if (!result.found) {
      return res.status(404).json({ success: false, message: 'Import job not found' });
    }
    res.json({
      success: true,
      data: { cancelledRuns: result.cancelledRuns },
      message: result.cancelledRuns
        ? `Stopped ${result.cancelledRuns} run(s)`
        : 'Job lock cleared',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/me/vendor/import-jobs/:jobId/run-now
router.post('/:jobId/run-now', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const runId = await sftpImportOrchestrator.runJobById(req.params.jobId, vendorId);
    res.json({ success: true, data: { runId } });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : /already running/i.test(err.message) ? 409 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
