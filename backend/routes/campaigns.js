// backend/routes/campaigns.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authenticate, authorize, getUserRoles } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const { resolveMessagingScope } = require('../services/messagingScope.service');

const MESSAGING_ROLES = ['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent'];

/**
 * Helper: append a VendorId scope clause to a query string and bind the input
 * if needed. No-globals model (revised 2026-05-11):
 *   - Vendor caller:  AND VendorId = @vendorIdFilter
 *   - SysAdmin:       no clause appended (sees everything; query-param narrowing handled separately)
 *   - TenantAdmin:    AND VendorId IS NULL
 *
 * @param {string} query - The base SQL query (must already contain WHERE).
 * @param {object} request - mssql request object (for binding inputs).
 * @param {object} scope - { vendorIdFilter, isVendor } from resolveMessagingScope.
 * @param {string} [alias] - optional table alias (e.g. 'c.')
 * @param {object} [reqObj] - optional Express req object, for role-based detection (SysAdmin).
 * @returns {string} updated query
 */
function appendVendorScope(query, request, scope, alias = '', reqObj = null) {
  const col = `${alias}VendorId`;
  if (scope.isVendor) {
    request.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
    return `${query} AND ${col} = @vendorIdFilter`;
  }
  if (reqObj && isSysAdminUser(reqObj)) {
    return query; // SysAdmin sees everything by default
  }
  return `${query} AND ${col} IS NULL`;
}

/**
 * Scope-guarded existence check for a campaign — used by step routes.
 * Returns true if the caller can see/mutate this campaign.
 * No-globals model: SysAdmin can see ANY campaign; TenantAdmin strict; Vendor strict.
 */
async function callerCanAccessCampaign(pool, req, campaignId, scope) {
  const callerRoles = getUserRoles(req.user);
  const callerIsSysAdmin = callerRoles.includes('SysAdmin');
  const tenantIdForScope = req.tenantId || req.user?.TenantId || null;
  const r = pool.request();
  r.input('campaignId', sql.UniqueIdentifier, campaignId);
  let q;
  if (scope.isVendor) {
    // Vendor campaigns have TenantId IS NULL per XOR (CK_Campaigns_TenantOrVendor).
    r.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
    q = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @campaignId AND VendorId = @vendorIdFilter';
  } else if (callerIsSysAdmin) {
    q = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @campaignId';
  } else {
    r.input('tenantId', sql.UniqueIdentifier, tenantIdForScope);
    q = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @campaignId AND TenantId = @tenantId AND VendorId IS NULL';
  }
  const result = await r.query(q);
  return result.recordset.length > 0;
}

/**
 * Validate that a referenced template is accessible to the caller given scope.
 * XOR model:
 *   - Vendor: VendorId = scope.vendorIdFilter (TenantId IS NULL implied)
 *   - TenantAdmin: TenantId match AND VendorId IS NULL
 *   - SysAdmin: any template (no scope restriction)
 */
async function callerCanReferenceTemplate(pool, req, templateId, scope) {
  const callerRoles = getUserRoles(req.user);
  const callerIsSysAdmin = callerRoles.includes('SysAdmin');
  const tenantIdForScope = req.tenantId || req.user?.TenantId || null;
  const r = pool.request();
  r.input('templateId', sql.UniqueIdentifier, templateId);
  let q;
  if (scope.isVendor) {
    r.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
    q = 'SELECT TemplateId FROM oe.MessageTemplates WHERE TemplateId = @templateId AND VendorId = @vendorIdFilter';
  } else if (callerIsSysAdmin) {
    q = 'SELECT TemplateId FROM oe.MessageTemplates WHERE TemplateId = @templateId';
  } else {
    r.input('tenantId', sql.UniqueIdentifier, tenantIdForScope);
    q = 'SELECT TemplateId FROM oe.MessageTemplates WHERE TemplateId = @templateId AND TenantId = @tenantId AND VendorId IS NULL';
  }
  const result = await r.query(q);
  return result.recordset.length > 0;
}

/**
 * Helper: get the effective tenant ID from the authenticated request.
 * Matches the pattern used in messageCenter.js templates route.
 */
function getEffectiveTenantId(req) {
  return req.tenantId || req.user?.TenantId || null;
}

function isSysAdminUser(req) {
  const roles = getUserRoles(req.user);
  return roles.includes('SysAdmin');
}

// GET /api/message-center/campaigns — List campaigns
// Scope rules (no globals; revised 2026-05-11):
//   - Vendor caller: WHERE c.TenantId = userTenantId AND c.VendorId = userVendorId
//   - TenantAdmin:   WHERE c.TenantId = userTenantId AND c.VendorId IS NULL
//   - SysAdmin:      no base filter — optional ?scope=tenant|vendor and ?tenantId=<uuid>
router.get('/', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const sysAdmin = isSysAdminUser(req);
    const userTenantId = req.tenantId || req.user?.TenantId || null;
    const { triggerType, isActive, search } = req.query;

    let query = `
      SELECT c.CampaignId, c.TenantId, c.VendorId,
             t.Name AS TenantName, v.VendorName AS VendorName,
             c.CampaignName, c.TriggerType, c.RecipientType, c.IsActive,
             c.CreatedDate, c.CreatedBy, c.ModifiedDate, c.ModifiedBy,
             (SELECT COUNT(*) FROM oe.CampaignSteps WHERE CampaignId = c.CampaignId) AS StepCount,
             (SELECT COUNT(*) FROM oe.CampaignEnrollments WHERE CampaignId = c.CampaignId AND Status = 'Active') AS ActiveEnrollments
      FROM oe.Campaigns c
      LEFT JOIN oe.Tenants t ON c.TenantId = t.TenantId
      LEFT JOIN oe.Vendors v ON c.VendorId = v.VendorId
      WHERE 1=1
    `;
    const request = pool.request();

    if (scope.isVendor) {
      // Vendor campaigns have TenantId IS NULL per XOR (CK_Campaigns_TenantOrVendor).
      // No TenantId clause; appendVendorScope adds the VendorId filter below.
    } else if (sysAdmin) {
      // SysAdmin: no base filter, but allow narrowing via query params
      if (req.query.tenantId) {
        query += ` AND c.TenantId = @tenantId`;
        request.input('tenantId', sql.UniqueIdentifier, req.query.tenantId);
      }
      if (req.query.scope === 'tenant') {
        query += ` AND c.VendorId IS NULL`;
      } else if (req.query.scope === 'vendor') {
        query += ` AND c.VendorId IS NOT NULL`;
      }
    } else {
      // TenantAdmin
      if (!userTenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      query += ` AND c.TenantId = @tenantId`;
      request.input('tenantId', sql.UniqueIdentifier, userTenantId);
    }

    // Vendor scope clause (vendor strict; non-vendor uses appendVendorScope's no-globals logic)
    query = appendVendorScope(query, request, scope, 'c.', req);

    if (triggerType) {
      query += ` AND c.TriggerType = @triggerType`;
      request.input('triggerType', sql.NVarChar(50), triggerType);
    }

    if (isActive !== undefined && isActive !== '') {
      query += ` AND c.IsActive = @isActive`;
      request.input('isActive', sql.Bit, isActive === 'true' ? 1 : 0);
    }

    if (search) {
      query += ` AND c.CampaignName LIKE @search`;
      request.input('search', sql.NVarChar(200), `%${search}%`);
    }

    query += ` ORDER BY c.CreatedDate DESC`;

    const result = await request.query(query);
    const campaigns = result.recordset.map(row => ({
      campaignId: row.CampaignId,
      tenantId: row.TenantId,
      vendorId: row.VendorId,
      tenantName: row.TenantName || null,
      vendorName: row.VendorName || null,
      campaignName: row.CampaignName,
      triggerType: row.TriggerType,
      recipientType: row.RecipientType,
      isActive: row.IsActive,
      createdDate: row.CreatedDate,
      createdBy: row.CreatedBy,
      modifiedDate: row.ModifiedDate,
      modifiedBy: row.ModifiedBy,
      stepCount: row.StepCount,
      activeEnrollments: row.ActiveEnrollments
    }));
    res.json({ success: true, data: campaigns });
  } catch (err) {
    console.error('GET /campaigns error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch campaigns' });
  }
});

// GET /api/message-center/campaigns/templates/:templateId/usage — Check template usage in campaigns
// NOTE: This route must come before /:id to avoid conflict
router.get('/templates/:templateId/usage', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const sysAdmin = isSysAdminUser(req);
    // SysAdmin: no tenant filter; everyone else: bound to their tenant
    const scopeId = sysAdmin ? (req.query.tenantId || null) : (req.tenantId || req.user?.TenantId || null);
    const reqSql = pool.request().input('templateId', sql.UniqueIdentifier, req.params.templateId);
    let usageQuery = `
        SELECT DISTINCT c.CampaignId, c.CampaignName
        FROM oe.CampaignSteps cs
        JOIN oe.Campaigns c ON cs.CampaignId = c.CampaignId
        WHERE (cs.EmailTemplateId = @templateId OR cs.SmsTemplateId = @templateId)
    `;
    if (scopeId) {
      usageQuery += ` AND c.TenantId = @tenantScope`;
      reqSql.input('tenantScope', sql.UniqueIdentifier, scopeId);
    }
    usageQuery = appendVendorScope(usageQuery, reqSql, scope, 'c.', req);
    const result = await reqSql.query(usageQuery);

    const usage = result.recordset.map(r => ({ campaignId: r.CampaignId, campaignName: r.CampaignName }));
    res.json({ success: true, data: usage });
  } catch (err) {
    console.error('GET /campaigns/templates/:templateId/usage error:', err);
    res.status(500).json({ success: false, message: 'Failed to check template usage' });
  }
});

// GET /api/message-center/campaigns/:id — Get campaign with steps
router.get('/:id', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const sysAdmin = isSysAdminUser(req);
    const userTenantId = req.tenantId || req.user?.TenantId || null;

    const request = pool.request();
    request.input('campaignId', sql.UniqueIdentifier, req.params.id);

    let query = `
      SELECT c.* FROM oe.Campaigns c WHERE c.CampaignId = @campaignId
    `;
    // No-globals: SysAdmin sees ANY campaign by id; vendor/tenant strict by their tenant.
    if (scope.isVendor) {
      if (userTenantId) {
        query += ` AND c.TenantId = @tenantId`;
        request.input('tenantId', sql.UniqueIdentifier, userTenantId);
      }
    } else if (!sysAdmin) {
      // TenantAdmin
      if (userTenantId) {
        query += ` AND c.TenantId = @tenantId`;
        request.input('tenantId', sql.UniqueIdentifier, userTenantId);
      }
    }
    query = appendVendorScope(query, request, scope, 'c.', req);

    const campaignResult = await request.query(query);
    if (!campaignResult.recordset.length) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    const stepsResult = await pool.request()
      .input('campaignId', sql.UniqueIdentifier, req.params.id)
      .query(`
        SELECT cs.StepId, cs.CampaignId, cs.StepOrder, cs.DelayDays,
               cs.EmailTemplateId, cs.SmsTemplateId, cs.IsActive, cs.CreatedDate,
               et.TemplateName AS EmailTemplateName,
               st.TemplateName AS SmsTemplateName
        FROM oe.CampaignSteps cs
        LEFT JOIN oe.MessageTemplates et ON cs.EmailTemplateId = et.TemplateId
        LEFT JOIN oe.MessageTemplates st ON cs.SmsTemplateId = st.TemplateId
        WHERE cs.CampaignId = @campaignId
        ORDER BY cs.StepOrder
      `);

    const row = campaignResult.recordset[0];
    const campaign = {
      campaignId: row.CampaignId,
      tenantId: row.TenantId,
      vendorId: row.VendorId,
      campaignName: row.CampaignName,
      triggerType: row.TriggerType,
      recipientType: row.RecipientType,
      isActive: row.IsActive,
      createdDate: row.CreatedDate,
      createdBy: row.CreatedBy,
      modifiedDate: row.ModifiedDate,
      modifiedBy: row.ModifiedBy,
      steps: stepsResult.recordset.map(s => ({
        stepId: s.StepId,
        campaignId: s.CampaignId,
        stepOrder: s.StepOrder,
        delayDays: s.DelayDays,
        emailTemplateId: s.EmailTemplateId,
        smsTemplateId: s.SmsTemplateId,
        isActive: s.IsActive,
        createdDate: s.CreatedDate,
        emailTemplateName: s.EmailTemplateName,
        smsTemplateName: s.SmsTemplateName
      }))
    };

    res.json({ success: true, data: campaign });
  } catch (err) {
    console.error('GET /campaigns/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch campaign' });
  }
});

// POST /api/message-center/campaigns — Create campaign
// No-globals model (revised 2026-05-11):
//   - Vendor caller:  TenantId = userTenantId, VendorId = userVendorId
//   - TenantAdmin:    TenantId = userTenantId, VendorId = NULL
//   - SysAdmin:
//       - If createForVendorId is provided: VendorId = createForVendorId,
//         TenantId inferred from oe.Users for that vendor. Any
//         createForTenantId sent by the client is ignored. 400 if the vendor
//         has no portal users.
//       - Else if createForTenantId is provided: tenant-scoped (VendorId = NULL).
//       - Else: falls back to active tenant.
router.post('/', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const sysAdmin = isSysAdminUser(req);
    const { campaignName, triggerType, recipientType, isActive, createForTenantId, createForVendorId } = req.body;

    if (!campaignName || !triggerType) {
      return res.status(400).json({ success: false, message: 'campaignName and triggerType are required' });
    }

    // RecipientType: 'Member' (default) delivers to the enrolling member;
    // 'Agent' delivers to the member's assigned agent.
    const finalRecipientType = recipientType === 'Agent' ? 'Agent' : 'Member';

    // XOR rule (CK_Campaigns_TenantOrVendor): vendor campaigns have TenantId=NULL,
    // tenant campaigns have VendorId=NULL.
    let finalTenantId;
    let finalVendorId;
    if (scope.isVendor) {
      finalTenantId = null;
      finalVendorId = scope.vendorIdFilter;
    } else if (sysAdmin) {
      if (createForVendorId) {
        finalTenantId = null;
        finalVendorId = createForVendorId;
      } else {
        finalTenantId = createForTenantId || getEffectiveTenantId(req);
        finalVendorId = null;
        if (!finalTenantId) {
          return res.status(400).json({
            success: false,
            message: 'createForTenantId is required when creating a tenant campaign as SysAdmin'
          });
        }
      }
    } else {
      finalTenantId = getEffectiveTenantId(req);
      finalVendorId = null;
      if (!finalTenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
    }

    const campaignId = require('crypto').randomUUID();

    await pool.request()
      .input('campaignId', sql.UniqueIdentifier, campaignId)
      .input('tenantId', sql.UniqueIdentifier, finalTenantId)
      .input('vendorId', sql.UniqueIdentifier, finalVendorId)
      .input('campaignName', sql.NVarChar(200), campaignName)
      .input('triggerType', sql.NVarChar(50), triggerType)
      .input('recipientType', sql.NVarChar(20), finalRecipientType)
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
      .query(`
        INSERT INTO oe.Campaigns (CampaignId, TenantId, VendorId, CampaignName, TriggerType, RecipientType, IsActive, CreatedBy)
        VALUES (@campaignId, @tenantId, @vendorId, @campaignName, @triggerType, @recipientType, @isActive, @createdBy)
      `);

    res.status(201).json({ success: true, data: { campaignId, tenantId: finalTenantId, vendorId: finalVendorId } });
  } catch (err) {
    console.error('POST /campaigns error:', err);
    res.status(500).json({ success: false, message: 'Failed to create campaign' });
  }
});

// PUT /api/message-center/campaigns/:id — Update campaign
router.put('/:id', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const callerRoles = getUserRoles(req.user);
    const callerIsSysAdmin = callerRoles.includes('SysAdmin');
    const tenantIdForScope = req.tenantId || req.user?.TenantId || null;
    const { campaignName, triggerType, recipientType, isActive,
            // Owner reassignment — SysAdmin only. XOR enforced.
            tenantId: newTenantId, vendorId: newVendorId } = req.body;

    // Scope-guarded existence check (no globals — 2-way; SysAdmin sees ANY)
    const existingRequest = pool.request();
    existingRequest.input('id', sql.UniqueIdentifier, req.params.id);
    let existingQuery;
    if (scope.isVendor) {
      // Vendor campaigns: VendorId only (TenantId IS NULL per XOR).
      existingRequest.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
      existingQuery = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @id AND VendorId = @vendorIdFilter';
    } else if (callerIsSysAdmin) {
      existingQuery = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @id';
    } else {
      existingRequest.input('tenantId', sql.UniqueIdentifier, tenantIdForScope);
      existingQuery = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @id AND TenantId = @tenantId AND VendorId IS NULL';
    }
    const existing = await existingRequest.query(existingQuery);
    if (existing.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Campaign not found or out of scope' });
    }

    const sets = [];
    const request = pool.request();
    request.input('campaignId', sql.UniqueIdentifier, req.params.id);
    request.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

    if (campaignName !== undefined) {
      sets.push('CampaignName = @campaignName');
      request.input('campaignName', sql.NVarChar(200), campaignName);
    }
    if (triggerType !== undefined) {
      sets.push('TriggerType = @triggerType');
      request.input('triggerType', sql.NVarChar(50), triggerType);
    }
    if (recipientType !== undefined) {
      sets.push('RecipientType = @recipientType');
      request.input('recipientType', sql.NVarChar(20), recipientType === 'Agent' ? 'Agent' : 'Member');
    }
    if (isActive !== undefined) {
      sets.push('IsActive = @isActive');
      request.input('isActive', sql.Bit, isActive ? 1 : 0);
    }

    // SysAdmin owner reassignment: change which tenant or vendor owns this campaign.
    // XOR enforced — exactly one of (tenantId, vendorId) must be non-null when either is sent.
    if (callerIsSysAdmin && (newTenantId !== undefined || newVendorId !== undefined)) {
      const tHas = newTenantId !== null && newTenantId !== undefined && newTenantId !== '';
      const vHas = newVendorId !== null && newVendorId !== undefined && newVendorId !== '';
      if (tHas === vHas) {
        return res.status(400).json({
          success: false,
          message: 'Owner reassignment requires exactly one of tenantId or vendorId (XOR).'
        });
      }
      sets.push('TenantId = @newTenantId', 'VendorId = @newVendorId');
      request.input('newTenantId', sql.UniqueIdentifier, tHas ? newTenantId : null);
      request.input('newVendorId', sql.UniqueIdentifier, vHas ? newVendorId : null);
    }

    if (!sets.length) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    sets.push('ModifiedDate = SYSUTCDATETIME()', 'ModifiedBy = @modifiedBy');

    // SELECT gate above enforces scope; UPDATE only targets the row.
    const query = `UPDATE oe.Campaigns SET ${sets.join(', ')} WHERE CampaignId = @campaignId`;

    await request.query(query);
    res.json({ success: true, message: 'Campaign updated' });
  } catch (err) {
    console.error('PUT /campaigns/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to update campaign' });
  }
});

// DELETE /api/message-center/campaigns/:id — Delete campaign
router.delete('/:id', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const callerRoles = getUserRoles(req.user);
    const callerIsSysAdmin = callerRoles.includes('SysAdmin');
    const tenantIdForScope = req.tenantId || req.user?.TenantId || null;

    // Scope-guarded existence check (no globals — 2-way; SysAdmin sees ANY)
    const checkRequest = pool.request();
    checkRequest.input('id', sql.UniqueIdentifier, req.params.id);
    let checkQuery;
    if (scope.isVendor) {
      // Vendor campaigns: VendorId only (TenantId IS NULL per XOR).
      checkRequest.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
      checkQuery = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @id AND VendorId = @vendorIdFilter';
    } else if (callerIsSysAdmin) {
      checkQuery = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @id';
    } else {
      checkRequest.input('tenantId', sql.UniqueIdentifier, tenantIdForScope);
      checkQuery = 'SELECT CampaignId FROM oe.Campaigns WHERE CampaignId = @id AND TenantId = @tenantId AND VendorId IS NULL';
    }
    const checkResult = await checkRequest.query(checkQuery);
    if (checkResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Campaign not found or out of scope' });
    }

    // Cancel active enrollments first
    await pool.request()
      .input('campaignId', sql.UniqueIdentifier, req.params.id)
      .query(`
        UPDATE oe.CampaignEnrollments
        SET Status = 'Cancelled', CompletedDate = SYSUTCDATETIME()
        WHERE CampaignId = @campaignId AND Status = 'Active'
      `);

    // SELECT gate above enforces scope; DELETE only targets the row.
    await pool.request()
      .input('campaignId', sql.UniqueIdentifier, req.params.id)
      .query(`DELETE FROM oe.Campaigns WHERE CampaignId = @campaignId`);

    res.json({ success: true, message: 'Campaign deleted' });
  } catch (err) {
    console.error('DELETE /campaigns/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete campaign' });
  }
});

// POST /api/message-center/campaigns/:id/duplicate — Duplicate campaign
// Revised 2026-05-11: duplicate ALWAYS preserves source TenantId AND VendorId regardless of caller.
// Authorization rule: caller must be able to "see" the source row using the standard scope gate.
router.post('/:id/duplicate', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const callerRoles = getUserRoles(req.user);
    const callerIsSysAdmin = callerRoles.includes('SysAdmin');
    const tenantIdForScope = req.tenantId || req.user?.TenantId || null;
    const newCampaignId = require('crypto').randomUUID();

    // Scope-guarded fetch of the original campaign (2-way; SysAdmin sees ANY)
    const origRequest = pool.request();
    origRequest.input('campaignId', sql.UniqueIdentifier, req.params.id);
    let origQuery;
    if (scope.isVendor) {
      // Vendor campaigns: VendorId only (TenantId IS NULL per XOR).
      origRequest.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
      origQuery = 'SELECT * FROM oe.Campaigns WHERE CampaignId = @campaignId AND VendorId = @vendorIdFilter';
    } else if (callerIsSysAdmin) {
      origQuery = 'SELECT * FROM oe.Campaigns WHERE CampaignId = @campaignId';
    } else {
      origRequest.input('tenantId', sql.UniqueIdentifier, tenantIdForScope);
      origQuery = 'SELECT * FROM oe.Campaigns WHERE CampaignId = @campaignId AND TenantId = @tenantId AND VendorId IS NULL';
    }
    const original = await origRequest.query(origQuery);

    if (!original.recordset.length) {
      return res.status(404).json({ success: false, message: 'Campaign not found or out of scope' });
    }

    const camp = original.recordset[0];

    // Scope-preserving duplicate: ALWAYS copy source's TenantId AND VendorId, regardless of caller.
    await pool.request()
      .input('newId', sql.UniqueIdentifier, newCampaignId)
      .input('tenantId', sql.UniqueIdentifier, camp.TenantId)
      .input('vendorId', sql.UniqueIdentifier, camp.VendorId || null)
      .input('name', sql.NVarChar(200), `${camp.CampaignName} (Copy)`)
      .input('triggerType', sql.NVarChar(50), camp.TriggerType)
      .input('recipientType', sql.NVarChar(20), camp.RecipientType || 'Member')
      .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
      .query(`
        INSERT INTO oe.Campaigns (CampaignId, TenantId, VendorId, CampaignName, TriggerType, RecipientType, IsActive, CreatedBy)
        VALUES (@newId, @tenantId, @vendorId, @name, @triggerType, @recipientType, 0, @createdBy)
      `);

    // Copy steps
    const steps = await pool.request()
      .input('campaignId', sql.UniqueIdentifier, req.params.id)
      .query(`SELECT StepOrder, DelayDays, EmailTemplateId, SmsTemplateId, IsActive FROM oe.CampaignSteps WHERE CampaignId = @campaignId ORDER BY StepOrder`);

    for (const step of steps.recordset) {
      await pool.request()
        .input('newCampaignId', sql.UniqueIdentifier, newCampaignId)
        .input('stepOrder', sql.Int, step.StepOrder)
        .input('delayDays', sql.Int, step.DelayDays)
        .input('emailTemplateId', sql.UniqueIdentifier, step.EmailTemplateId)
        .input('smsTemplateId', sql.UniqueIdentifier, step.SmsTemplateId)
        .input('isActive', sql.Bit, step.IsActive)
        .query(`
          INSERT INTO oe.CampaignSteps (StepId, CampaignId, StepOrder, DelayDays, EmailTemplateId, SmsTemplateId, IsActive)
          VALUES (NEWID(), @newCampaignId, @stepOrder, @delayDays, @emailTemplateId, @smsTemplateId, @isActive)
        `);
    }

    res.status(201).json({ success: true, data: { campaignId: newCampaignId } });
  } catch (err) {
    console.error('POST /campaigns/:id/duplicate error:', err);
    res.status(500).json({ success: false, message: 'Failed to duplicate campaign' });
  }
});

// --- Campaign Steps ---

// POST /api/message-center/campaigns/:id/steps — Add step
router.post('/:id/steps', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const { delayDays = 0, emailTemplateId, smsTemplateId, isActive = true } = req.body;
    const stepId = require('crypto').randomUUID();

    // Scope-guarded campaign lookup
    if (!(await callerCanAccessCampaign(pool, req, req.params.id, scope))) {
      return res.status(404).json({ success: false, message: 'Campaign not found or out of scope' });
    }

    // Validate referenced templates are within scope
    if (emailTemplateId) {
      if (!(await callerCanReferenceTemplate(pool, req, emailTemplateId, scope))) {
        return res.status(400).json({ success: false, message: 'Email template not found or out of scope' });
      }
    }
    if (smsTemplateId) {
      if (!(await callerCanReferenceTemplate(pool, req, smsTemplateId, scope))) {
        return res.status(400).json({ success: false, message: 'SMS template not found or out of scope' });
      }
    }

    // Get next step order
    const maxResult = await pool.request()
      .input('campaignId', sql.UniqueIdentifier, req.params.id)
      .query(`SELECT ISNULL(MAX(StepOrder), 0) + 1 AS NextOrder FROM oe.CampaignSteps WHERE CampaignId = @campaignId`);

    const stepOrder = maxResult.recordset[0].NextOrder;

    await pool.request()
      .input('stepId', sql.UniqueIdentifier, stepId)
      .input('campaignId', sql.UniqueIdentifier, req.params.id)
      .input('stepOrder', sql.Int, stepOrder)
      .input('delayDays', sql.Int, delayDays)
      .input('emailTemplateId', sql.UniqueIdentifier, emailTemplateId || null)
      .input('smsTemplateId', sql.UniqueIdentifier, smsTemplateId || null)
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .query(`
        INSERT INTO oe.CampaignSteps (StepId, CampaignId, StepOrder, DelayDays, EmailTemplateId, SmsTemplateId, IsActive)
        VALUES (@stepId, @campaignId, @stepOrder, @delayDays, @emailTemplateId, @smsTemplateId, @isActive)
      `);

    res.status(201).json({ success: true, data: { stepId, stepOrder } });
  } catch (err) {
    console.error('POST /campaigns/:id/steps error:', err);
    res.status(500).json({ success: false, message: 'Failed to add step' });
  }
});

// PUT /api/message-center/campaigns/:id/steps/reorder — Reorder steps
// NOTE: This route must come before /:id/steps/:stepId to avoid conflict
router.put('/:id/steps/reorder', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const { steps } = req.body; // [{ stepId, stepOrder }]

    if (!Array.isArray(steps)) {
      return res.status(400).json({ success: false, message: 'steps array required' });
    }

    // Scope-guarded campaign lookup
    if (!(await callerCanAccessCampaign(pool, req, req.params.id, scope))) {
      return res.status(404).json({ success: false, message: 'Campaign not found or out of scope' });
    }

    for (const step of steps) {
      await pool.request()
        .input('stepId', sql.UniqueIdentifier, step.stepId)
        .input('stepOrder', sql.Int, step.stepOrder)
        .input('campaignId', sql.UniqueIdentifier, req.params.id)
        .query(`
          UPDATE oe.CampaignSteps SET StepOrder = @stepOrder, ModifiedDate = SYSUTCDATETIME()
          WHERE StepId = @stepId AND CampaignId = @campaignId
        `);
    }

    res.json({ success: true, message: 'Steps reordered' });
  } catch (err) {
    console.error('PUT /campaigns/:id/steps/reorder error:', err);
    res.status(500).json({ success: false, message: 'Failed to reorder steps' });
  }
});

// PUT /api/message-center/campaigns/:id/steps/:stepId — Update step
router.put('/:id/steps/:stepId', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const { delayDays, emailTemplateId, smsTemplateId, isActive } = req.body;

    // Scope-guarded campaign lookup
    if (!(await callerCanAccessCampaign(pool, req, req.params.id, scope))) {
      return res.status(404).json({ success: false, message: 'Campaign not found or out of scope' });
    }

    // Validate referenced templates are within scope
    if (emailTemplateId) {
      if (!(await callerCanReferenceTemplate(pool, req, emailTemplateId, scope))) {
        return res.status(400).json({ success: false, message: 'Email template not found or out of scope' });
      }
    }
    if (smsTemplateId) {
      if (!(await callerCanReferenceTemplate(pool, req, smsTemplateId, scope))) {
        return res.status(400).json({ success: false, message: 'SMS template not found or out of scope' });
      }
    }

    const sets = [];
    const request = pool.request();
    request.input('stepId', sql.UniqueIdentifier, req.params.stepId);
    request.input('campaignId', sql.UniqueIdentifier, req.params.id);

    if (delayDays !== undefined) {
      sets.push('DelayDays = @delayDays');
      request.input('delayDays', sql.Int, delayDays);
    }
    if (emailTemplateId !== undefined) {
      sets.push('EmailTemplateId = @emailTemplateId');
      request.input('emailTemplateId', sql.UniqueIdentifier, emailTemplateId || null);
    }
    if (smsTemplateId !== undefined) {
      sets.push('SmsTemplateId = @smsTemplateId');
      request.input('smsTemplateId', sql.UniqueIdentifier, smsTemplateId || null);
    }
    if (isActive !== undefined) {
      sets.push('IsActive = @isActive');
      request.input('isActive', sql.Bit, isActive ? 1 : 0);
    }

    if (!sets.length) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    sets.push('ModifiedDate = SYSUTCDATETIME()');

    await request.query(`
      UPDATE oe.CampaignSteps SET ${sets.join(', ')}
      WHERE StepId = @stepId AND CampaignId = @campaignId
    `);

    res.json({ success: true, message: 'Step updated' });
  } catch (err) {
    console.error('PUT /campaigns/:id/steps/:stepId error:', err);
    res.status(500).json({ success: false, message: 'Failed to update step' });
  }
});

// DELETE /api/message-center/campaigns/:id/steps/:stepId — Remove step
router.delete('/:id/steps/:stepId', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);

    // Scope-guarded campaign lookup
    if (!(await callerCanAccessCampaign(pool, req, req.params.id, scope))) {
      return res.status(404).json({ success: false, message: 'Campaign not found or out of scope' });
    }

    await pool.request()
      .input('stepId', sql.UniqueIdentifier, req.params.stepId)
      .input('campaignId', sql.UniqueIdentifier, req.params.id)
      .query(`DELETE FROM oe.CampaignSteps WHERE StepId = @stepId AND CampaignId = @campaignId`);

    res.json({ success: true, message: 'Step deleted' });
  } catch (err) {
    console.error('DELETE /campaigns/:id/steps/:stepId error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete step' });
  }
});

// GET /api/message-center/campaigns/:id/enrollments — List campaign enrollments
router.get('/:id/enrollments', authenticate, authorize(MESSAGING_ROLES), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const scope = await resolveMessagingScope(req);

    // Scope-guarded campaign lookup
    if (!(await callerCanAccessCampaign(pool, req, req.params.id, scope))) {
      return res.status(404).json({ success: false, message: 'Campaign not found or out of scope' });
    }

    const result = await pool.request()
      .input('campaignId', sql.UniqueIdentifier, req.params.id)
      .query(`
        SELECT ce.CampaignEnrollmentId, ce.MemberId, ce.TriggerDate, ce.CurrentStepOrder,
               ce.Status, ce.CreatedDate, ce.CompletedDate,
               u.FirstName, u.LastName, u.Email
        FROM oe.CampaignEnrollments ce
        JOIN oe.Members m ON ce.MemberId = m.MemberId
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE ce.CampaignId = @campaignId
        ORDER BY ce.CreatedDate DESC
      `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('GET /campaigns/:id/enrollments error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch enrollments' });
  }
});

module.exports = router;
