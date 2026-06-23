'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { authenticate, authorize } = require('../../../middleware/auth');
const VendorExportService = require('../../../services/vendorExportService');
const eligibilityImport = require('../../../services/eligibilityImportService');
const { getPool, sql } = require('../../../config/database');
const { validateTemplatePlaceholders } = require('../../../utils/eligibilityRowTemplate');
const { suggestEligibilityFormat } = require('../../../utils/eligibilityFormatDetection');
const vendorImportFormatPresetService = require('../../../services/vendorImportFormatPreset.service');
const shareRequestImport = require('../../../services/shareRequestImportService');
const vendorImportTenants = require('../../../services/vendorImportTenants.service');
const { createJob, getJob, runJob } = require('../../../services/vendorImportJobRunner');
const { MAX_UPLOAD_FILE_BYTES } = require('../../../constants/uploadLimits');

/** Allow large Sharewell ZIP parse/commit and eligibility CSV imports. */
const VENDOR_IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

function allowLongImport(req, res, next) {
  req.setTimeout(VENDOR_IMPORT_TIMEOUT_MS);
  res.setTimeout(VENDOR_IMPORT_TIMEOUT_MS);
  next();
}

function wantsImportStream(req) {
  return req.query.stream === '1' || String(req.headers.accept || '').includes('text/event-stream');
}

function createImportStreamWriter(req, res) {
  if (!wantsImportStream(req)) {
    return {
      streaming: false,
      emit: () => {},
      complete: (payload) => payload,
      fail: () => {},
    };
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const write = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  return {
    streaming: true,
    emit: (event) => write({ type: 'progress', ...event }),
    complete: (payload) => {
      write({ type: 'complete', ...payload });
      res.end();
    },
    fail: (message) => {
      write({ type: 'error', message });
      res.end();
    },
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(os.tmpdir(), 'vendor-import');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES },
});

router.use(authenticate);
router.use(authorize(['VendorAdmin']));

async function getVendorId(req) {
  return req.user?.VendorId || null;
}

router.get('/format-presets', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const data = await vendorImportFormatPresetService.listFormatPresets(vendorId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/format-presets', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const b = req.body || {};
    const data = await vendorImportFormatPresetService.createFormatPreset(vendorId, {
      slug: b.slug,
      label: b.label,
      rowTemplate: b.rowTemplate ?? b.template,
      sortOrder: b.sortOrder,
      importRules: b.importRules,
      tobaccoCsvColumn: b.tobaccoCsvColumn,
      tobaccoYesValues: b.tobaccoYesValues,
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    const status = /required|invalid|already exists|not installed/i.test(err.message) ? 400 : 500;
    res.status(status).json({
      success: false,
      message: err.message,
      invalidPlaceholders: err.invalidPlaceholders || undefined,
    });
  }
});

router.put('/format-presets/:slug', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const b = req.body || {};
    const data = await vendorImportFormatPresetService.updateFormatPreset(vendorId, req.params.slug, {
      label: b.label,
      rowTemplate: b.rowTemplate ?? b.template,
      sortOrder: b.sortOrder,
      importRules: b.importRules,
      tobaccoCsvColumn: b.tobaccoCsvColumn,
      tobaccoYesValues: b.tobaccoYesValues,
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : /invalid|required/i.test(err.message) ? 400 : 500;
    res.status(status).json({
      success: false,
      message: err.message,
      invalidPlaceholders: err.invalidPlaceholders || undefined,
    });
  }
});

router.delete('/format-presets/:slug', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const removed = await vendorImportFormatPresetService.deleteFormatPreset(vendorId, req.params.slug);
    if (!removed) return res.status(404).json({ success: false, message: 'Format preset not found' });
    res.json({ success: true, message: 'Format removed' });
  } catch (err) {
    const status = /cannot remove|not found/i.test(err.message) ? 409 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/eligibility-format', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });

    const pool = await getPool();
    let row;
    try {
      const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
          SELECT
            VendorId,
            VendorName,
            EligibilityRowTemplate,
            EligibilityDateFormat,
            EligibilityIntegrationPartner,
            DefaultEligibilityFormatSlug
          FROM oe.Vendors
          WHERE VendorId = @vendorId
        `);
      row = r.recordset?.[0];
    } catch (colErr) {
      const msg = (colErr?.message || '').toLowerCase();
      if (!msg.includes('defaulteligibilityformatslug')) throw colErr;
      const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
          SELECT VendorId, VendorName, EligibilityRowTemplate, EligibilityDateFormat, EligibilityIntegrationPartner
          FROM oe.Vendors WHERE VendorId = @vendorId
        `);
      row = r.recordset?.[0];
    }

    if (!row) return res.status(404).json({ success: false, message: 'Vendor not found' });

    res.json({
      success: true,
      data: {
        vendorId: row.VendorId,
        vendorName: row.VendorName,
        eligibilityRowTemplate: row.EligibilityRowTemplate || '',
        eligibilityDateFormat: row.EligibilityDateFormat || 'Padded',
        eligibilityIntegrationPartner: row.EligibilityIntegrationPartner || '',
        defaultEligibilityFormatSlug: row.DefaultEligibilityFormatSlug || 'sharewell_default',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/eligibility-format', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });

    const body = req.body || {};
    const template = body.eligibilityRowTemplate ?? body.EligibilityRowTemplate;
    const dateFormat = body.eligibilityDateFormat ?? body.EligibilityDateFormat;
    const integrationPartner = body.eligibilityIntegrationPartner ?? body.EligibilityIntegrationPartner;
    const defaultSlug = body.defaultEligibilityFormatSlug ?? body.DefaultEligibilityFormatSlug;

    if (template != null && String(template).trim()) {
      const invalid = validateTemplatePlaceholders(String(template));
      if (invalid.length) {
        return res.status(400).json({
          success: false,
          message: `Invalid placeholders: ${invalid.join(', ')}`,
        });
      }
    }

    if (defaultSlug != null) {
      const slugOk = await vendorImportFormatPresetService.isValidFormatSlug(vendorId, defaultSlug);
      if (!slugOk) {
        return res.status(400).json({ success: false, message: `Unknown format slug: ${defaultSlug}` });
      }
    }

    const pool = await getPool();
    const reqDb = pool.request()
      .input('vendorId', sql.UniqueIdentifier, vendorId);

    const sets = ['ModifiedDate = SYSUTCDATETIME()'];
    if (template !== undefined) {
      reqDb.input('eligibilityRowTemplate', sql.NVarChar(sql.MAX), template?.trim() || null);
      sets.push('EligibilityRowTemplate = @eligibilityRowTemplate');
    }
    if (dateFormat !== undefined) {
      reqDb.input('eligibilityDateFormat', sql.NVarChar(32), dateFormat?.trim() || null);
      sets.push('EligibilityDateFormat = @eligibilityDateFormat');
    }
    if (integrationPartner !== undefined) {
      reqDb.input('eligibilityIntegrationPartner', sql.NVarChar(100), integrationPartner?.trim() || null);
      sets.push('EligibilityIntegrationPartner = @eligibilityIntegrationPartner');
    }
    if (defaultSlug !== undefined) {
      reqDb.input('defaultSlug', sql.NVarChar(50), defaultSlug?.trim() || null);
      sets.push('DefaultEligibilityFormatSlug = @defaultSlug');
    }

    try {
      await reqDb.query(`UPDATE oe.Vendors SET ${sets.join(', ')} WHERE VendorId = @vendorId`);
    } catch (colErr) {
      const msg = (colErr?.message || '').toLowerCase();
      if (defaultSlug !== undefined && msg.includes('defaulteligibilityformatslug')) {
        return res.status(400).json({
          success: false,
          message: 'Run sql-changes/2026-05-29-sharewell-vendor-format-slug.sql before setting default format slug.',
        });
      }
      throw colErr;
    }

    res.json({ success: true, message: 'Eligibility format saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/tenants', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const tenants = await vendorImportTenants.getImportEligibleTenantsForVendor(vendorId);
    res.json({ success: true, data: tenants });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/tenant-directory', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const result = await vendorImportTenants.getTenantDirectoryForVendor(vendorId, {
      search: req.query.search ?? req.query.q,
      page: req.query.page,
      limit: req.query.limit ?? req.query.pageSize,
    });
    res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/tenants', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });

    const body = req.body || {};
    const data = await vendorImportTenants.createVendorTenant({
      vendorId,
      userId: req.user?.UserId || req.user?.userId,
      body: {
        name: body.name ?? body.Name,
        contactEmail: body.contactEmail ?? body.ContactEmail,
        contactPhone: body.contactPhone ?? body.ContactPhone,
        primaryAddress: body.primaryAddress ?? body.PrimaryAddress,
        primaryCity: body.primaryCity ?? body.PrimaryCity,
        primaryState: body.primaryState ?? body.PrimaryState,
        primaryZip: body.primaryZip ?? body.PrimaryZip,
        defaultUrlPath: body.defaultUrlPath ?? body.DefaultUrlPath,
        isExternal: body.isExternal ?? body.IsExternal ?? true,
        productIds: body.productIds ?? body.ProductIds,
        timeZone: body.timeZone ?? body.TimeZone,
      },
    });

    res.status(201).json({ success: true, data, message: 'Tenant created' });
  } catch (err) {
    const status = /required|select at least|invalid|not available/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/eligibility-sample', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const { csv, fileName } = await VendorExportService.generateSampleExportData(vendorId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/tenants/:tenantId/eligibility-export', allowLongImport, async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    const { tenantId } = req.params;
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });

    await vendorImportTenants.assertTenantEligibleForVendorImport(vendorId, tenantId);

    const formatSlug = req.query.formatSlug || req.query.format || null;
    const includeTerminations = req.query.includeTerminations === '1'
      || req.query.includeTerminations === 'true';

    const { csv, fileName } = await eligibilityImport.exportTenantEligibilityCsv({
      vendorId,
      tenantId,
      formatSlug,
      includeTerminations,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.send(csv);
  } catch (err) {
    const status = /not eligible|not found|no members/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/jobs/:jobId', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const job = getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Import job not found or expired' });
    }
    res.json({
      success: true,
      job: {
        jobId: job.jobId,
        status: job.status,
        phase: job.phase,
        message: job.message,
        current: job.current,
        total: job.total,
        result: job.status === 'done' ? job.result : null,
        error: job.status === 'error' ? (job.error || job.message) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/** Manual upload only — sniff CSV headers and suggest import format preset. */
router.post('/members/detect-format', upload.single('file'), async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });

    let csvText = req.body?.csvText || '';
    if (req.file?.path) csvText = fs.readFileSync(req.file.path, 'utf8');
    if (!csvText.trim()) {
      return res.status(400).json({ success: false, message: 'CSV file or csvText required' });
    }

    const { headers, rows } = eligibilityImport.parseCsvRows(csvText);
    const presets = await vendorImportFormatPresetService.listFormatPresets(vendorId);
    const selectedSlug = req.body?.formatSlug || null;
    const suggestion = suggestEligibilityFormat({
      headers,
      presets,
      selectedSlug,
      rawRows: rows.slice(0, 40),
    });

    res.json({
      success: true,
      data: {
        headers,
        ...suggestion,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/members/parse', allowLongImport, upload.single('file'), async (req, res) => {
  const useAsync = req.query.async === '1';
  try {
    const vendorId = await getVendorId(req);
    const tenantId = req.body?.tenantId;
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    if (!tenantId) return res.status(400).json({ success: false, message: 'tenantId required' });

    await vendorImportTenants.assertTenantEligibleForVendorImport(vendorId, tenantId);

    let csvText = req.body?.csvText || '';
    if (req.file?.path) csvText = fs.readFileSync(req.file.path, 'utf8');

    const formatSlug = req.body?.formatSlug || null;
    const fileName = req.file?.originalname || 'upload.csv';

    const runParse = async (emit) => {
      emit({ phase: 'parse', message: `Parsing ${fileName}…` });
      const preview = await eligibilityImport.previewEligibilityImport({
        vendorId,
        tenantId,
        csvText,
        formatSlug,
        onProgress: emit,
      });
      return { data: preview };
    };

    if (useAsync) {
      const jobId = createJob({ type: 'members-parse', vendorId, tenantId });
      res.json({ success: true, jobId });
      runJob(jobId, runParse);
      return;
    }

    const result = await runParse(() => {});
    res.json({ success: true, data: result.data });
  } catch (err) {
    const status = /not eligible|required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/members/product-mapping', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    await eligibilityImport.saveVendorImportProductMap(
      vendorId,
      req.body?.mappings || [],
      req.body?.removeSourceProductKeys || [],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/members/product-mapping', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const map = await eligibilityImport.getVendorImportProductMap(vendorId);
    res.json({
      success: true,
      data: [...map.entries()].map(([sourceProductKey, v]) => ({
        sourceProductKey,
        productId: v.ProductId,
        productPricingId: v.ProductPricingId,
        productPricingLabel: v.ProductPricingLabel,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/pricing-tiers', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const data = await eligibilityImport.getVendorImportPricingTiers(vendorId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/agents', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    const tenantId = req.query?.tenantId;
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    if (!tenantId) return res.status(400).json({ success: false, message: 'tenantId required' });
    await vendorImportTenants.assertTenantEligibleForVendorImport(vendorId, tenantId);
    const data = await eligibilityImport.listAgentsForTenantImport(tenantId);
    res.json({ success: true, data });
  } catch (err) {
    const status = /not eligible|required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/members/commit', allowLongImport, upload.single('file'), async (req, res) => {
  const useAsync = req.query.async === '1';
  try {
    const vendorId = await getVendorId(req);
    const tenantId = req.body?.tenantId;
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    if (!tenantId) return res.status(400).json({ success: false, message: 'tenantId required' });

    await vendorImportTenants.assertTenantEligibleForVendorImport(vendorId, tenantId);

    let csvText = req.body?.csvText || '';
    if (req.file?.path) csvText = fs.readFileSync(req.file.path, 'utf8');

    const formatSlug = req.body?.formatSlug || null;
    const isPendingMigration = req.body?.isPendingMigration === 'true';
    const importTerminatedOnlyForHistory = req.body?.importTerminatedOnlyForHistory === 'true';
    const resetMemberAccounts = req.body?.resetMemberAccounts === 'true'
      || req.body?.resetMemberAccounts === true;
    const allowTenantMove = req.body?.allowTenantMove === 'true'
      || req.body?.allowTenantMove === true;
    const importFileName = req.file?.originalname || req.body?.importFileName || 'upload.csv';
    const legacyAgentId = req.body?.agentId && String(req.body.agentId).trim()
      ? String(req.body.agentId).trim()
      : null;
    const householdAgentMap = req.body?.householdAgentMap || null;

    let selectedHouseholdKeys = null;
    const rawKeys = req.body?.selectedHouseholdKeys;
    if (rawKeys) {
      try {
        selectedHouseholdKeys = typeof rawKeys === 'string' ? JSON.parse(rawKeys) : rawKeys;
      } catch {
        selectedHouseholdKeys = String(rawKeys).split(',').map((k) => k.trim()).filter(Boolean);
      }
    }

    const runCommit = async (emit) => {
      emit({ phase: 'commit', message: 'Starting eligibility import…' });
      const data = await eligibilityImport.commitEligibilityImport({
        vendorId,
        tenantId,
        csvText,
        createdBy: req.user?.UserId,
        formatSlug,
        importFileName,
        householdAgentMap,
        agentId: legacyAgentId,
        isPendingMigration,
        selectedHouseholdKeys,
        importTerminatedOnlyForHistory,
        resetMemberAccounts,
        allowTenantMove,
        onProgress: emit,
      });
      return { data };
    };

    if (useAsync) {
      const jobId = createJob({ type: 'members-commit', vendorId, tenantId });
      res.json({ success: true, jobId });
      runJob(jobId, runCommit);
      return;
    }

    const result = await runCommit(() => {});
    res.json({ success: true, data: result.data });
  } catch (err) {
    const status = /not eligible|required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/share-requests/jobs/:jobId', async (req, res) => {
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) return res.status(403).json({ success: false, message: 'Vendor required' });
    const job = getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Import job not found or expired' });
    }
    res.json({
      success: true,
      job: {
        jobId: job.jobId,
        status: job.status,
        phase: job.phase,
        message: job.message,
        current: job.current,
        total: job.total,
        result: job.status === 'done' ? job.result : null,
        error: job.status === 'error' ? (job.error || job.message) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/share-requests/parse', allowLongImport, upload.single('file'), async (req, res) => {
  const useAsync = req.query.async === '1';
  const stream = useAsync ? { streaming: false } : createImportStreamWriter(req, res);
  try {
    const vendorId = await getVendorId(req);
    if (!vendorId) {
      if (stream.streaming) return stream.fail('Vendor required');
      return res.status(403).json({ success: false, message: 'Vendor required' });
    }
    if (!req.file?.path) {
      if (stream.streaming) return stream.fail('ZIP or folder bundle required');
      return res.status(400).json({ success: false, message: 'ZIP or folder bundle required' });
    }

    const queueUnlinked = req.body?.queueUnlinked === 'true' || req.body?.queueUnlinked === true;
    const resyncExisting = req.body?.resyncExisting !== false && req.body?.resyncExisting !== 'false';
    const filePath = req.file.path;
    const fileName = req.file.originalname || 'upload';

    const runParse = async (emit) => {
      emit({ phase: 'upload', message: `Received ${fileName}…` });
      const bundleDir = shareRequestImport.extractBundleDir(filePath, emit);
      const preview = await shareRequestImport.previewShareRequestImport({
        vendorId, bundleDir, queueUnlinked, onProgress: emit,
      });
      return { data: preview, bundleDir };
    };

    if (useAsync) {
      const jobId = createJob({ type: 'share-request-parse', vendorId });
      res.json({ success: true, jobId });
      runJob(jobId, runParse);
      return;
    }

    const result = await runParse((event) => stream.emit(event));
    if (stream.streaming) {
      return stream.complete({ success: true, data: result.data, bundleDir: result.bundleDir });
    }
    res.json({ success: true, data: result.data, bundleDir: result.bundleDir });
  } catch (err) {
    console.error('[vendor-import] share-requests/parse failed:', err.message);
    if (stream.streaming) return stream.fail(err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/share-requests/commit', allowLongImport, async (req, res) => {
  const useAsync = req.query.async === '1';
  const stream = useAsync ? { streaming: false } : createImportStreamWriter(req, res);
  try {
    const vendorId = await getVendorId(req);
    const bundleDir = req.body?.bundleDir;
    if (!vendorId) {
      if (stream.streaming) return stream.fail('Vendor required');
      return res.status(403).json({ success: false, message: 'Vendor required' });
    }
    if (!bundleDir || !fs.existsSync(bundleDir)) {
      if (stream.streaming) return stream.fail('bundleDir required from parse step');
      return res.status(400).json({ success: false, message: 'bundleDir required from parse step' });
    }

    const queueUnlinked = req.body?.queueUnlinked === true;
    const resyncExisting = req.body?.resyncExisting !== false;
    const typeMap = req.body?.typeMap || {};
    const createdBy = req.user?.UserId;

    const runCommit = async (emit) => {
      emit({ phase: 'commit', message: 'Starting share request import…' });
      const data = await shareRequestImport.commitShareRequestImport({
        vendorId,
        bundleDir,
        createdBy,
        queueUnlinked,
        resyncExisting,
        typeMap,
        previewRows: req.body?.previewRows,
        onProgress: emit,
      });
      return { data };
    };

    if (useAsync) {
      const jobId = createJob({ type: 'share-request-commit', vendorId });
      res.json({ success: true, jobId });
      runJob(jobId, runCommit);
      return;
    }

    const result = await runCommit((event) => stream.emit(event));
    if (stream.streaming) {
      return stream.complete({ success: true, data: result.data });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('[vendor-import] share-requests/commit failed:', err.message);
    if (stream.streaming) return stream.fail(err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
