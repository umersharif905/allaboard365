'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const vendorInvoiceService = require('../../../services/vendorInvoiceService');

router.use(authenticate);
router.use(authorize(['VendorAdmin']));

async function resolveVendorId(req, res) {
  const userId = req.user?.UserId || req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'User not authenticated' });
    return null;
  }
  const vendorId = req.user?.VendorId
    || await vendorInvoiceService.getVendorIdForUser(await getPool(), userId);
  if (!vendorId) {
    res.status(404).json({ success: false, message: 'Vendor not found for this user' });
    return null;
  }
  return vendorId;
}

router.get('/preview', async (req, res) => {
  try {
    const vendorId = await resolveVendorId(req, res);
    if (!vendorId) return;

    const { periodStart, periodEnd } = vendorInvoiceService.validatePeriod(
      req.query.periodStart,
      req.query.periodEnd
    );

    const data = await vendorInvoiceService.buildPreview(vendorId, periodStart, periodEnd);
    res.json({
      success: true,
      data: {
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        tenants: data.tenants,
        summary: data.summary,
        warnings: data.warnings,
      },
    });
  } catch (err) {
    const status = /required|valid date|periodEnd/.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const vendorId = await resolveVendorId(req, res);
    if (!vendorId) return;

    const body = req.body || {};
    const { periodStart, periodEnd } = vendorInvoiceService.validatePeriod(
      body.periodStart,
      body.periodEnd
    );
    const tenantIds = Array.isArray(body.tenantIds) ? body.tenantIds.filter(Boolean) : [];

    const { zipBuffer, zipName, warnings, mismatchTenants } =
      await vendorInvoiceService.buildGenerateZip(
        vendorId,
        periodStart,
        periodEnd,
        tenantIds
      );

    if (warnings.length) {
      res.setHeader('X-Invoice-Warnings', String(warnings.length));
      res.setHeader(
        'X-Invoice-Warning-Detail',
        encodeURIComponent(warnings.slice(0, 5).join(' | '))
      );
    }
    if (mismatchTenants?.length) {
      res.setHeader('X-Invoice-Mismatch', '1');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.send(zipBuffer);
  } catch (err) {
    const status = /required|valid date|periodEnd|Select at least|archiver/.test(err.message)
      ? 400
      : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
