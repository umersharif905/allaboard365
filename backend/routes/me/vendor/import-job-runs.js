'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const vendorImportJobRunService = require('../../../services/vendorImportJobRunService');

router.use(authenticate);
router.use(authorize(['VendorAdmin']));

function getVendorId(req) {
  return req.user?.VendorId || null;
}

// GET /api/me/vendor/import-job-runs
// Query: jobId?, status?, fromDate?, toDate?, page=1, limit=25
router.get('/', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    await vendorImportJobRunService.releaseStaleRuns().catch(() => {});

    const { jobId, status, fromDate, toDate, page, limit } = req.query;
    const result = await vendorImportJobRunService.listRuns(vendorId, {
      jobId,
      status,
      fromDate,
      toDate,
      page,
      limit,
    });
    res.json({ success: true, data: result.runs, pagination: result.pagination });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/me/vendor/import-job-runs/:runId
router.get('/:runId', async (req, res) => {
  try {
    const vendorId = getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const data = await vendorImportJobRunService.getRunWithFiles(req.params.runId, vendorId);
    if (!data) return res.status(404).json({ success: false, message: 'Run not found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
