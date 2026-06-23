/**
 * Product API Integration routes - API config, run-api, api-pending, run-api-for-enrollment
 * Mounted at /api/me/tenant-admin/product-api
 */
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize, getUserRoles } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const ProductAPIService = require('../../../services/ProductAPIService');
const productAPIQueries = require('../../../services/productAPIQueries');
const { runProductApiForProduct } = require('../../../services/productAPIRunJob');

/** Redact values for keys that look like secrets (for debug display only) */
function redactSecretsForDisplay(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const sensitive = ['password', 'secret', 'token', 'apikey', 'api_key', 'auth', 'key', 'credential'];
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = String(k).toLowerCase();
    const isSensitive = sensitive.some(s => keyLower.includes(s));
    if (Array.isArray(out)) {
      out.push(typeof v === 'object' && v !== null ? redactSecretsForDisplay(v) : v);
    } else {
      out[k] = isSensitive ? '***' : (typeof v === 'object' && v !== null && !(v instanceof Date) ? redactSecretsForDisplay(v) : v);
    }
  }
  return out;
}

/** Ensure product is owned by current tenant (or exists if SysAdmin) */
async function ensureProductAccess(pool, productId, tenantId, user) {
  const isSysAdmin = getUserRoles(user).includes('SysAdmin');
  const r = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`SELECT ProductId, ProductOwnerId FROM oe.Products WHERE ProductId = @productId`);
  if (r.recordset.length === 0) return null;
  if (isSysAdmin) return r.recordset[0];
  if (r.recordset[0].ProductOwnerId === tenantId) return r.recordset[0];
  return null;
}

// POST /run-api-for-enrollment - must be before :productId
router.post('/run-api-for-enrollment', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { enrollmentId, force } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!enrollmentId) {
      return res.status(400).json({ success: false, message: 'enrollmentId is required' });
    }
    const pool = await getPool();

    const enrollReq = await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .query(`
        SELECT e.EnrollmentId, e.MemberId, e.ProductId, e.HouseholdId, e.ExternalAPISyncedAt, e.ExternalAPIDeactivatedAt,
               e.TerminationDate, p.ProductOwnerId, p.Name as ProductName
        FROM oe.Enrollments e
        JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE e.EnrollmentId = @enrollmentId
      `);
    if (enrollReq.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }
    const enrollment = enrollReq.recordset[0];
    const isSysAdmin = getUserRoles(req.user).includes('SysAdmin');
    if (!isSysAdmin && tenantId && enrollment.ProductOwnerId !== tenantId) {
      return res.status(403).json({ success: false, message: 'Product not owned by your tenant' });
    }

    const configReq = await pool.request()
      .input('productId', sql.UniqueIdentifier, enrollment.ProductId)
      .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
    if (configReq.recordset.length === 0) {
      return res.status(400).json({ success: false, message: 'Product has no API config' });
    }
    const configJson = configReq.recordset[0].ConfigJson;
    const config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;

    const memberReq = await pool.request()
      .input('memberId', sql.UniqueIdentifier, enrollment.MemberId)
      .query(`
        SELECT m.MemberId, m.HouseholdId, m.HouseholdMemberID, m.Tier, m.RelationshipType, FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
               m.Address, m.City, m.State, m.Zip, m.Gender,
               u.FirstName, u.LastName, u.Email, u.PhoneNumber
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `);
    if (memberReq.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }
    const member = memberReq.recordset[0];

    const today = new Date().toISOString().split('T')[0];
    const termDate = enrollment.TerminationDate ? new Date(enrollment.TerminationDate).toISOString().split('T')[0] : null;
    let activated = 0, deactivated = 0, updated = 0, errors = [];

    if (termDate && termDate <= today && config.deactivation?.enabled) {
      const hasActiveEnrollment = await pool.request()
        .input('memberId', sql.UniqueIdentifier, enrollment.MemberId)
        .input('productId', sql.UniqueIdentifier, enrollment.ProductId)
        .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
        .input('today', sql.Date, today)
        .query(`
          SELECT 1
          FROM oe.Enrollments e2
          WHERE e2.MemberId = @memberId AND e2.ProductId = @productId AND e2.EnrollmentId != @enrollmentId
            AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @today)
            AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL)
        `);
      if (hasActiveEnrollment.recordset.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Member has another active enrollment for this product; deactivation skipped.'
        });
      }
      try {
        await ProductAPIService.callDeactivationAPI({
          productId: enrollment.ProductId,
          enrollment: { EnrollmentId: enrollment.EnrollmentId, MemberId: enrollment.MemberId, HouseholdId: enrollment.HouseholdId },
          member,
          config: config.deactivation,
          fullConfig: config
        });
        await pool.request()
          .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
          .input('now', sql.DateTime2, new Date())
          .query(`UPDATE oe.Enrollments SET ExternalAPIDeactivatedAt = @now WHERE EnrollmentId = @enrollmentId`);
        deactivated = 1;
      } catch (err) {
        errors.push({
          enrollmentId,
          type: 'deactivation',
          message: err.message,
          responseBody: err.responseBody,
          responseStatus: err.responseStatus
        });
      }
    } else if ((!termDate || termDate > today) && (force || !enrollment.ExternalAPISyncedAt) && member.RelationshipType === 'P') {
      const hasPriorSynced = await pool.request()
        .input('memberId', sql.UniqueIdentifier, enrollment.MemberId)
        .input('productId', sql.UniqueIdentifier, enrollment.ProductId)
        .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
        .query(`
          SELECT 1 FROM oe.Enrollments e2
          WHERE e2.MemberId = @memberId AND e2.ProductId = @productId AND e2.EnrollmentId != @enrollmentId
            AND e2.ExternalAPISyncedAt IS NOT NULL
        `);
      const useUpdate = hasPriorSynced.recordset.length > 0 && config.update?.enabled;
      if (useUpdate) {
        try {
          const enrollmentCtx = { EnrollmentId: enrollment.EnrollmentId, MemberId: enrollment.MemberId, HouseholdId: enrollment.HouseholdId, TerminationDate: enrollment.TerminationDate };
          const result = await ProductAPIService.callUpdateAPI({
            productId: enrollment.ProductId,
            member,
            enrollment: enrollmentCtx,
            config: config.update,
            fullConfig: config
          });
          const responseJson = result.rawResponse != null ? JSON.stringify(result.rawResponse) : null;
          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('now', sql.DateTime2, new Date())
            .input('responseJson', sql.NVarChar, responseJson)
            .query(`UPDATE oe.Enrollments SET ExternalAPISyncedAt = @now, ExternalAPIResponseJson = @responseJson WHERE EnrollmentId = @enrollmentId`);
          activated = 0;
          updated = 1;
        } catch (err) {
          errors.push({
            enrollmentId,
            type: 'update',
            message: err.message,
            responseBody: err.responseBody,
            responseStatus: err.responseStatus
          });
        }
      } else if (config.enrollment?.enabled) {
        try {
        const result = await ProductAPIService.callEnrollmentAPI({
          productId: enrollment.ProductId,
          member,
          householdMembers: [],
          config: config.enrollment,
          fullConfig: config
        });
        const responseJson = result.rawResponse != null ? JSON.stringify(result.rawResponse) : null;
        await pool.request()
          .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
          .input('now', sql.DateTime2, new Date())
          .input('responseJson', sql.NVarChar, responseJson)
          .query(`UPDATE oe.Enrollments SET ExternalAPISyncedAt = @now, ExternalAPIResponseJson = @responseJson WHERE EnrollmentId = @enrollmentId`);
        activated = 1;
        } catch (err) {
          errors.push({
            enrollmentId,
            type: 'activation',
            message: err.message,
            responseBody: err.responseBody,
            responseStatus: err.responseStatus
          });
        }
      }
    }

    res.json({ success: true, data: { activated, deactivated, updated, errors } });
  } catch (error) {
    console.error('❌ run-api-for-enrollment error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// POST /run-update-for-enrollment - run update API for a single already-synced enrollment
router.post('/run-update-for-enrollment', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { enrollmentId } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!enrollmentId) {
      return res.status(400).json({ success: false, message: 'enrollmentId is required' });
    }
    const pool = await getPool();

    const enrollReq = await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .query(`
        SELECT e.EnrollmentId, e.MemberId, e.ProductId, e.HouseholdId, e.ExternalAPISyncedAt, e.TerminationDate, p.ProductOwnerId
        FROM oe.Enrollments e
        JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE e.EnrollmentId = @enrollmentId
      `);
    if (enrollReq.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }
    const enrollment = enrollReq.recordset[0];
    const isSysAdmin = getUserRoles(req.user).includes('SysAdmin');
    if (!isSysAdmin && tenantId && enrollment.ProductOwnerId !== tenantId) {
      return res.status(403).json({ success: false, message: 'Product not owned by your tenant' });
    }

    const configReq = await pool.request()
      .input('productId', sql.UniqueIdentifier, enrollment.ProductId)
      .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
    if (configReq.recordset.length === 0) {
      return res.status(400).json({ success: false, message: 'Product has no API config' });
    }
    const configJson = configReq.recordset[0].ConfigJson;
    const config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;

    if (!config.update?.enabled) {
      return res.status(400).json({ success: false, message: 'Product has no update API config enabled' });
    }

    if (!enrollment.ExternalAPISyncedAt) {
      return res.status(400).json({ success: false, message: 'Enrollment not yet synced - run enrollment API first' });
    }

    const memberReq = await pool.request()
      .input('memberId', sql.UniqueIdentifier, enrollment.MemberId)
      .query(`
        SELECT m.MemberId, m.HouseholdId, m.HouseholdMemberID, m.Tier, m.RelationshipType, FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
               m.Address, m.City, m.State, m.Zip, m.Gender,
               u.FirstName, u.LastName, u.Email, u.PhoneNumber
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `);
    if (memberReq.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }
    const member = memberReq.recordset[0];

    const enrollmentCtx = { EnrollmentId: enrollment.EnrollmentId, MemberId: enrollment.MemberId, HouseholdId: enrollment.HouseholdId, TerminationDate: enrollment.TerminationDate };
    const result = await ProductAPIService.callUpdateAPI({
      productId: enrollment.ProductId,
      member,
      enrollment: enrollmentCtx,
      config: config.update,
      fullConfig: config
    });

    const responseJson = result.rawResponse != null ? JSON.stringify(result.rawResponse) : null;
    await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .input('now', sql.DateTime2, new Date())
      .input('responseJson', sql.NVarChar, responseJson)
      .query(`UPDATE oe.Enrollments SET ExternalAPISyncedAt = @now, ExternalAPIResponseJson = @responseJson WHERE EnrollmentId = @enrollmentId`);

    res.json({ success: true, data: { updated: 1 } });
  } catch (error) {
    console.error('❌ run-update-for-enrollment error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Update failed',
      data: { responseBody: error.responseBody, responseStatus: error.responseStatus }
    });
  }
});

// POST /test-auth-step - test auth step config, returns full response + extracted token
router.post('/test-auth-step', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const axios = require('axios');
    const { endpoint, method = 'POST', contentType = 'application/x-www-form-urlencoded', body = [], responseMapping = {} } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ success: false, message: 'endpoint is required' });
    }
    const resolveEnv = (val) => (typeof val !== 'string' ? String(val) : String(val).replace(/\$\{([^}]+)\}/g, (_, n) => process.env[n?.trim()] ?? ''));
    const bodyObj = {};
    for (const item of Array.isArray(body) ? body : []) {
      const k = item.key || item.Key;
      if (k) bodyObj[k] = resolveEnv(item.value || item.Value || '');
    }
    const methodUpper = (method || 'POST').toUpperCase();
    const ct = contentType || 'application/x-www-form-urlencoded';
    let axiosConfig;
    if (ct === 'multipart/form-data') {
      const FormData = require('form-data');
      const form = new FormData();
      for (const [k, v] of Object.entries(bodyObj)) {
        form.append(k, String(v ?? ''));
      }
      axiosConfig = {
        method: methodUpper,
        url: endpoint.trim(),
        headers: form.getHeaders(),
        data: form,
        timeout: 15000,
        validateStatus: () => true
      };
    } else {
      const ctHeader = ct === 'application/json' ? 'application/json' : 'application/x-www-form-urlencoded';
      axiosConfig = {
        method: methodUpper,
        url: endpoint.trim(),
        headers: { 'Content-Type': ctHeader },
        timeout: 15000,
        validateStatus: () => true
      };
      if (methodUpper !== 'GET' && Object.keys(bodyObj).length > 0) {
        axiosConfig.data = ct === 'application/x-www-form-urlencoded' ? new URLSearchParams(bodyObj).toString() : bodyObj;
      }
    }
    ProductAPIService.logProductAPIRequest('TEST-AUTH', methodUpper, endpoint.trim(), axiosConfig.headers || {}, bodyObj, ct);
    const response = await axios(axiosConfig);
    const responseHeaders = {};
    if (response.headers && typeof response.headers === 'object') {
      for (const [k, v] of Object.entries(response.headers)) {
        if (typeof v === 'string' && !k.startsWith('.')) responseHeaders[k] = v;
      }
    }
    const mapping = responseMapping || {};
    const resolvedMapping = {
      tokenPath: mapping.tokenPath || 'headers.Authorization',
      tokenPrefixStrip: mapping.tokenPrefixStrip != null ? mapping.tokenPrefixStrip : 'Bearer '
    };
    const extractedToken = ProductAPIService.extractToken(
      { headers: response.headers, data: response.data },
      resolvedMapping
    );
    res.json({
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        data: response.data,
        extractedToken: extractedToken || null
      }
    });
  } catch (error) {
    console.error('❌ test-auth-step error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Auth step failed',
      data: { error: error.message }
    });
  }
});

// POST /test-run - test API config with manual inputs (no productId required)
// Accepts headers/body as objects OR as arrays with prefill; if authStep + authToken prefill, fetches token automatically
router.post('/test-run', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const axios = require('axios');
    const { endpoint, method = 'POST', contentType = 'application/json', headers: headersInput = {}, body: bodyInput = {}, authStep, responseMapping: responseMappingInput } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ success: false, message: 'endpoint is required' });
    }
    let headers = {};
    let body = {};
    let authTokenUsed = null;
    if (Array.isArray(headersInput)) {
      const ctx = { member: null, enrollment: null };
      const needsAuth = headersInput.some((h) => (h.prefill || h.Prefill) === 'authToken') ||
        (Array.isArray(bodyInput) && bodyInput.some((b) => (b.prefill || b.Prefill) === 'authToken'));
      if (needsAuth && authStep?.enabled) {
        authTokenUsed = await ProductAPIService.fetchAuthToken(authStep);
      } else if (needsAuth) {
        return res.status(400).json({ success: false, message: 'Auth Token prefill used but auth step not configured' });
      }
      headers = ProductAPIService.substitutePrefills(headersInput, ctx, { authToken: authTokenUsed });
      body = Array.isArray(bodyInput) ? ProductAPIService.substitutePrefills(bodyInput, ctx, { authToken: authTokenUsed }) : {};
    } else {
      headers = typeof headersInput === 'object' ? headersInput : {};
      body = typeof bodyInput === 'object' ? bodyInput : {};
    }
    const methodUpper = (method || 'POST').toUpperCase();
    const ct = contentType || 'application/json';
    let axiosConfig;
    if (ct === 'multipart/form-data') {
      const FormData = require('form-data');
      const form = new FormData();
      for (const [k, v] of Object.entries(body || {})) {
        form.append(k, String(v ?? ''));
      }
      axiosConfig = {
        method: methodUpper,
        url: endpoint.trim(),
        headers: { ...headers, ...form.getHeaders() },
        data: form,
        timeout: 30000,
        validateStatus: () => true
      };
    } else {
      const ctHeader = ct === 'application/x-www-form-urlencoded' ? 'application/x-www-form-urlencoded' : 'application/json';
      axiosConfig = {
        method: methodUpper,
        url: endpoint.trim(),
        headers: { ...headers, 'Content-Type': ctHeader },
        timeout: 30000,
        validateStatus: () => true
      };
      if (methodUpper !== 'GET' && body && typeof body === 'object' && Object.keys(body).length > 0) {
        axiosConfig.data = ct === 'application/x-www-form-urlencoded' ? new URLSearchParams(body).toString() : body;
      }
    }
    ProductAPIService.logProductAPIRequest('TEST-RUN', methodUpper, endpoint.trim(), axiosConfig.headers || {}, body, ct);
    const response = await axios(axiosConfig);
    const responseHeaders = {};
    if (response.headers && typeof response.headers === 'object') {
      for (const [k, v] of Object.entries(response.headers)) {
        if (typeof v === 'string' && !k.startsWith('.')) responseHeaders[k] = v;
      }
    }
    let extractedValue = null;
    let tokenPathUsed = null;
    if (responseMappingInput && responseMappingInput.tokenPath) {
      const mapping = {
        tokenPath: responseMappingInput.tokenPath,
        tokenPrefixStrip: responseMappingInput.tokenPrefixStrip != null ? responseMappingInput.tokenPrefixStrip : 'Bearer '
      };
      extractedValue = ProductAPIService.extractToken({ headers: response.headers, data: response.data }, mapping);
      tokenPathUsed = responseMappingInput.tokenPath;
    }
    res.json({
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        data: response.data,
        authTokenUsed: authTokenUsed ? (authTokenUsed.length > 50 ? authTokenUsed.substring(0, 30) + '...' + authTokenUsed.slice(-10) : authTokenUsed) : null,
        extractedValue: extractedValue ?? null,
        tokenPathUsed: tokenPathUsed ?? null
      }
    });
  } catch (error) {
    console.error('❌ test-run error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Test request failed',
      data: { error: error.code || error.message }
    });
  }
});

// GET /:productId/api-pending
router.get('/:productId/api-pending', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const today = new Date().toISOString().split('T')[0];
    const counts = await productAPIQueries.getApiPendingCounts(pool, productId, today);

    res.json({
      success: true,
      data: {
        pendingHouseholds: counts.pendingHouseholds,
        pendingDeactivations: counts.pendingDeactivations,
        syncedHouseholds: counts.syncedHouseholds
      }
    });
  } catch (error) {
    console.error('❌ api-pending error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// GET /:productId/api-pending-deactivations - list members with pending deactivations (lazy load, limited)
router.get('/:productId/api-pending-deactivations', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const today = new Date().toISOString().split('T')[0];
    const rows = await productAPIQueries.getPendingDeactivationsList(pool, productId, today, limit);
    const list = (rows || []).map((r) => ({
      enrollmentId: r.EnrollmentId,
      memberId: r.MemberId,
      memberName: ((r.FirstName || '') + ' ' + (r.LastName || '')).trim() || 'Unknown',
      terminationDate: r.TerminationDate
    }));
    res.json({ success: true, data: { list } });
  } catch (error) {
    console.error('❌ api-pending-deactivations error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// GET /:productId/api-config
router.get('/:productId/api-config', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const r = await pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`SELECT ConfigJson, LastRunAt FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
    const row = r.recordset[0];
    const config = row ? (typeof row.ConfigJson === 'string' ? JSON.parse(row.ConfigJson || '{}') : row.ConfigJson || {}) : null;
    res.json({ success: true, data: { config, lastRunAt: row?.LastRunAt } });
  } catch (error) {
    console.error('❌ api-config GET error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// PUT /:productId/api-config
router.put('/:productId/api-config', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const { config } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const configJson = typeof config === 'string' ? config : JSON.stringify(config || {});

    await pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .input('configJson', sql.NVarChar, configJson)
      .query(`
        MERGE oe.ProductAPIConfigs AS target
        USING (SELECT @productId AS ProductId) AS source
        ON target.ProductId = source.ProductId
        WHEN MATCHED THEN
          UPDATE SET ConfigJson = @configJson, ModifiedDate = GETUTCDATE()
        WHEN NOT MATCHED THEN
          INSERT (ProductAPIConfigId, ProductId, ConfigJson, CreatedDate, ModifiedDate)
          VALUES (NEWID(), @productId, @configJson, GETUTCDATE(), GETUTCDATE());
      `);

    res.json({ success: true, message: 'API config saved' });
  } catch (error) {
    console.error('❌ api-config PUT error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// GET /:productId/enrolled-primary-members - primary members (RelationshipType = 'P') who have an enrollment for this product
router.get('/:productId/enrolled-primary-members', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const r = await pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`
        SELECT DISTINCT m.MemberId, e.EnrollmentId,
               (ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, '')) AS MemberName,
               u.Email AS MemberEmail,
               m.HouseholdMemberID
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        WHERE e.ProductId = @productId
          AND m.RelationshipType = 'P'
          AND m.TenantId = (SELECT ProductOwnerId FROM oe.Products WHERE ProductId = @productId)
        ORDER BY MemberName
      `);
    const list = (r.recordset || []).map((row) => ({
      memberId: row.MemberId,
      enrollmentId: row.EnrollmentId,
      label: (row.MemberName || '').trim() || 'Unknown',
      email: row.MemberEmail || '',
      householdMemberID: row.HouseholdMemberID || ''
    }));
    res.json({ success: true, data: { list } });
  } catch (error) {
    console.error('❌ enrolled-primary-members error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// POST /:productId/resolve-prefills - resolve header/body prefills for a given member's enrollment in this product
router.post('/:productId/resolve-prefills', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const { memberId, headers: headersInput = [], body: bodyInput = [] } = req.body || {};
    if (!memberId) {
      return res.status(400).json({ success: false, message: 'memberId is required' });
    }
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const memberReq = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`
        SELECT m.MemberId, m.HouseholdId, m.HouseholdMemberID, m.Tier, m.RelationshipType, FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
               m.Address, m.City, m.State, m.Zip, m.Gender,
               u.FirstName, u.LastName, u.Email, u.PhoneNumber
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `);
    if (memberReq.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }
    const enrollReq = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`
        SELECT TOP 1 EnrollmentId, MemberId, HouseholdId, EffectiveDate, TerminationDate
        FROM oe.Enrollments
        WHERE MemberId = @memberId AND ProductId = @productId
        ORDER BY EffectiveDate DESC
      `);
    if (enrollReq.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'No enrollment found for this member and product' });
    }
    const member = memberReq.recordset[0];
    const enrollment = enrollReq.recordset[0];
    const ctx = { member, enrollment };
    let authTokenUsed = null;
    const needsAuth = (headersInput || []).some((h) => (h.prefill || h.Prefill) === 'authToken') ||
      (Array.isArray(bodyInput) && (bodyInput || []).some((b) => (b.prefill || b.Prefill) === 'authToken'));
    const configReq = await pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
    const config = configReq.recordset[0] ? (typeof configReq.recordset[0].ConfigJson === 'string' ? JSON.parse(configReq.recordset[0].ConfigJson || '{}') : configReq.recordset[0].ConfigJson) : {};
    if (needsAuth && config?.authStep?.enabled) {
      authTokenUsed = await ProductAPIService.fetchAuthToken(config.authStep);
    }
    const headers = ProductAPIService.substitutePrefills(headersInput || [], ctx, { authToken: authTokenUsed });
    const body = Array.isArray(bodyInput) ? ProductAPIService.substitutePrefills(bodyInput, ctx, { authToken: authTokenUsed }) : {};
    res.json({ success: true, data: { headers, body } });
  } catch (error) {
    console.error('❌ resolve-prefills error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// POST /:productId/test-sso-login - test SSO admin login, return response and extracted token
router.post('/:productId/test-sso-login', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const configReq = await pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
    if (configReq.recordset.length === 0) {
      return res.status(400).json({ success: false, message: 'Product has no API config' });
    }
    const config = typeof configReq.recordset[0].ConfigJson === 'string'
      ? JSON.parse(configReq.recordset[0].ConfigJson) : configReq.recordset[0].ConfigJson;
    const sso = config?.sso;
    if (!sso?.enabled || !sso?.login?.endpoint) {
      return res.status(400).json({ success: false, message: 'SSO not enabled or login endpoint missing' });
    }
    const login = sso.login;
    const resolveEnvVars = (val) => {
      if (typeof val !== 'string') return val;
      return val.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name?.trim()] ?? '');
    };
    const bodyObj = {};
    for (const item of login.body || []) {
      const k = item.key || item.Key;
      if (k) bodyObj[k] = resolveEnvVars(item.value || item.Value || '');
    }
    const axios = require('axios');
    const method = (login.method || 'POST').toUpperCase();
    let axiosConfig = {
      method,
      url: login.endpoint.trim(),
      timeout: 15000,
      validateStatus: () => true
    };
    if (login.contentType === 'multipart/form-data') {
      const FormData = require('form-data');
      const form = new FormData();
      for (const [k, v] of Object.entries(bodyObj)) {
        form.append(k, String(v ?? ''));
      }
      axiosConfig.data = form;
      axiosConfig.headers = form.getHeaders();
    } else if (login.contentType === 'application/x-www-form-urlencoded') {
      axiosConfig.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      axiosConfig.data = new URLSearchParams(bodyObj).toString();
    } else {
      axiosConfig.headers = { 'Content-Type': 'application/json' };
      if (method !== 'GET' && Object.keys(bodyObj).length > 0) {
        axiosConfig.data = bodyObj;
      }
    }
    ProductAPIService.logProductAPIRequest('SSO-TEST-LOGIN', method, login.endpoint.trim(), axiosConfig.headers || {}, bodyObj, login.contentType);
    const response = await axios(axiosConfig);
    ProductAPIService.logProductAPIResponse('SSO-TEST-LOGIN', response.status, response.statusText, response.data);
    const responseHeaders = {};
    if (response.headers && typeof response.headers === 'object') {
      for (const [k, v] of Object.entries(response.headers)) {
        if (typeof v !== 'string' || k.startsWith('.')) continue;
        const lower = k.toLowerCase();
        if (lower.includes('auth') || lower.includes('token') || lower.includes('key') || lower.includes('cookie')) {
          responseHeaders[k] = v.length > 30 ? v.slice(0, 12) + '...' + v.slice(-6) : '***';
        } else {
          responseHeaders[k] = v;
        }
      }
    }
    const mapping = login.responseMapping || {};
    const resolvedMapping = {
      tokenPath: mapping.tokenPath || 'headers.Authorization',
      tokenPrefixStrip: mapping.tokenPrefixStrip != null ? mapping.tokenPrefixStrip : 'Bearer '
    };
    const extractedToken = ProductAPIService.extractToken(
      { headers: response.headers, data: response.data },
      resolvedMapping
    );
    const tokenPreview = extractedToken
      ? (extractedToken.length > 40 ? extractedToken.substring(0, 20) + '...' + extractedToken.slice(-8) : extractedToken)
      : null;
    res.json({
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        data: response.data,
        extractedToken: tokenPreview,
        tokenPathUsed: mapping.tokenPath || 'headers.Authorization',
        requestUrl: login.endpoint.trim(),
        requestMethod: method,
        requestBody: redactSecretsForDisplay(bodyObj)
      }
    });
  } catch (error) {
    console.error('❌ test-sso-login error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'SSO login test failed',
      data: { error: error.code || error.message }
    });
  }
});

// POST /:productId/test-sso-token - test member token request only (admin login + token request, return token/response; no portal)
router.post('/:productId/test-sso-token', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const { testMemberExternalId } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const configReq = await pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
    if (configReq.recordset.length === 0) {
      return res.status(400).json({ success: false, message: 'Product has no API config' });
    }
    const config = typeof configReq.recordset[0].ConfigJson === 'string'
      ? JSON.parse(configReq.recordset[0].ConfigJson) : configReq.recordset[0].ConfigJson;
    const sso = config?.sso;
    if (!sso?.enabled || !sso?.login?.endpoint) {
      return res.status(400).json({ success: false, message: 'SSO not enabled or login URL missing' });
    }
    if (!sso.tokenRequest?.enabled || !sso.tokenRequest?.endpoint) {
      return res.status(400).json({ success: false, message: 'Token request must be enabled to test member token' });
    }
    const memberExternalId = (testMemberExternalId && String(testMemberExternalId).trim()) || 'TEST_MEMBER';
    let accessToken;
    try {
      accessToken = await ProductAPIService.fetchAuthToken(sso.login);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'SSO login failed: ' + (err.message || 'no token') });
    }
    const ctx = { member: { HouseholdMemberID: memberExternalId }, enrollment: null };
    const body = ProductAPIService.substitutePrefills(sso.tokenRequest.body || [], ctx, { authToken: accessToken });
    const headers = ProductAPIService.substitutePrefills(sso.tokenRequest.headers || [], ctx, { authToken: accessToken });
    const axios = require('axios');
    const method = (sso.tokenRequest.method || 'POST').toUpperCase();
    const ct = sso.tokenRequest.contentType || 'application/x-www-form-urlencoded';
    let axiosConfig = {
      method,
      url: sso.tokenRequest.endpoint.trim(),
      timeout: 15000,
      validateStatus: () => true
    };
    if (ct === 'application/x-www-form-urlencoded') {
      axiosConfig.headers = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
      axiosConfig.data = new URLSearchParams(body).toString();
    } else if (ct === 'application/json') {
      axiosConfig.headers = { ...headers, 'Content-Type': 'application/json' };
      axiosConfig.data = body;
    } else {
      const FormData = require('form-data');
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) {
        form.append(k, String(v ?? ''));
      }
      axiosConfig.data = form;
      axiosConfig.headers = { ...headers, ...form.getHeaders() };
    }
    ProductAPIService.logProductAPIRequest('SSO-TEST-TOKEN', method, sso.tokenRequest.endpoint.trim(), axiosConfig.headers || {}, body, ct);
    const resp = await axios(axiosConfig);
    ProductAPIService.logProductAPIResponse('SSO-TEST-TOKEN', resp.status, resp.statusText, resp.data);
    const memberToken = (resp.data && typeof resp.data === 'object' && resp.data.accessToken != null)
      ? resp.data.accessToken
      : (typeof resp.data === 'string' && resp.data.length < 2000 ? resp.data.trim() : null);
    const memberTokenPreview = memberToken
      ? (memberToken.length > 40 ? memberToken.substring(0, 20) + '...' + memberToken.slice(-8) : memberToken)
      : null;
    res.json({
      success: true,
      data: {
        status: resp.status,
        statusText: resp.statusText,
        memberTokenPreview,
        data: resp.data,
        requestUrl: sso.tokenRequest.endpoint.trim(),
        requestMethod: method,
        requestBody: redactSecretsForDisplay(body)
      }
    });
  } catch (error) {
    console.error('❌ test-sso-token error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Member token test failed',
      data: { error: error.code || error.message }
    });
  }
});

// POST /:productId/test-sso-portal - get SSO portal URL (login + optional token request), return url to open in new tab
router.post('/:productId/test-sso-portal', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const { testMemberExternalId } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    const configReq = await pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
    if (configReq.recordset.length === 0) {
      return res.status(400).json({ success: false, message: 'Product has no API config' });
    }
    const config = typeof configReq.recordset[0].ConfigJson === 'string'
      ? JSON.parse(configReq.recordset[0].ConfigJson) : configReq.recordset[0].ConfigJson;
    const sso = config?.sso;
    if (!sso?.enabled || !sso?.login?.endpoint || !sso?.portal?.portalBaseUrl) {
      return res.status(400).json({ success: false, message: 'SSO not enabled or login/portal URL missing' });
    }
    const memberExternalId = (testMemberExternalId && String(testMemberExternalId).trim()) || 'TEST_MEMBER';
    let accessToken;
    try {
      accessToken = await ProductAPIService.fetchAuthToken(sso.login);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'SSO login failed: ' + (err.message || 'no token') });
    }
    if (sso.tokenRequest?.enabled && sso.tokenRequest?.endpoint) {
      const resolveEnvVars = (val) => {
        if (typeof val !== 'string') return val;
        return val.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name?.trim()] ?? '');
      };
      const ctx = { member: { HouseholdMemberID: memberExternalId }, enrollment: null };
      const body = ProductAPIService.substitutePrefills(sso.tokenRequest.body || [], ctx, { authToken: accessToken });
      const headers = ProductAPIService.substitutePrefills(sso.tokenRequest.headers || [], ctx, { authToken: accessToken });
      const axios = require('axios');
      const method = (sso.tokenRequest.method || 'POST').toUpperCase();
      const ct = sso.tokenRequest.contentType || 'application/x-www-form-urlencoded';
      let axiosConfig = {
        method,
        url: sso.tokenRequest.endpoint.trim(),
        timeout: 15000,
        validateStatus: () => true
      };
      if (ct === 'application/x-www-form-urlencoded') {
        axiosConfig.headers = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
        axiosConfig.data = new URLSearchParams(body).toString();
      } else if (ct === 'application/json') {
        axiosConfig.headers = { ...headers, 'Content-Type': 'application/json' };
        axiosConfig.data = body;
      } else {
        const FormData = require('form-data');
        const form = new FormData();
        for (const [k, v] of Object.entries(body)) {
          form.append(k, String(v ?? ''));
        }
        axiosConfig.data = form;
        axiosConfig.headers = { ...headers, ...form.getHeaders() };
      }
      const resp = await axios(axiosConfig);
      if (resp.status >= 400) {
        return res.status(400).json({
          success: false,
          message: 'Token request failed: ' + resp.status + ' ' + (resp.data && typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data)
        });
      }
      if (resp.data && typeof resp.data === 'object' && resp.data.accessToken != null) {
        accessToken = resp.data.accessToken;
      } else if (typeof resp.data === 'string' && resp.data.length < 2000) {
        accessToken = resp.data.trim();
      } else {
        return res.status(400).json({ success: false, message: 'Token request did not return accessToken' });
      }
    }
    const portal = sso.portal;
    let urlTemplate = (portal.urlTemplate || '').trim() || '/{accessToken}';
    urlTemplate = urlTemplate.replace(/\{accessToken\}/g, encodeURIComponent(accessToken));
    const customFields = portal.customFields || [];
    const customObj = {};
    for (const item of customFields) {
      const k = (item.key || item.Key || '').trim();
      if (k) customObj[k] = item.value || item.Value || '';
    }
    for (const [k, v] of Object.entries(customObj)) {
      urlTemplate = urlTemplate.replace(new RegExp('\\{' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}', 'g'), encodeURIComponent(v));
    }
    const queryParts = [];
    for (const [k, v] of Object.entries(customObj)) {
      if (!urlTemplate.includes('{' + k + '}')) {
        queryParts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
    }
    const baseUrl = (portal.portalBaseUrl || '').trim().replace(/\/$/, '');
    const path = urlTemplate.startsWith('http') ? urlTemplate : urlTemplate.startsWith('/') ? urlTemplate : '/' + urlTemplate;
    const finalUrl = path.startsWith('http') ? path : baseUrl + path;
    const sep = finalUrl.includes('?') ? '&' : '?';
    const url = queryParts.length ? finalUrl + sep + queryParts.join('&') : finalUrl;
    res.json({ success: true, data: { url } });
  } catch (error) {
    console.error('❌ test-sso-portal error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'SSO portal test failed',
      data: { error: error.code || error.message }
    });
  }
});

// POST /:productId/run-api
router.post('/:productId/run-api', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId } = req.params;
    const { updateAll } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;
    const pool = await getPool();
    const allowed = await ensureProductAccess(pool, productId, tenantId, req.user);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const data = await runProductApiForProduct(pool, productId, { updateAll: !!updateAll });
    if (data.skipped) {
      return res.status(400).json({ success: false, message: 'Product has no API config' });
    }

    res.json({
      success: true,
      data: { activated: data.activated, deactivated: data.deactivated, updated: data.updated, errors: data.errors, activatedList: data.activatedList, updatedList: data.updatedList, deactivatedList: data.deactivatedList }
    });
  } catch (error) {
    console.error('❌ run-api error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

module.exports = router;
