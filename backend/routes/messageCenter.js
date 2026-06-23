const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authenticate, getUserRoles, authorize } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const { resolveMessagingScope } = require('../services/messagingScope.service');

const WELCOME_EMAIL_TEMPLATE_SETTING_KEY = 'WelcomeEmailTemplateId';
const DEFAULT_WELCOME_EMAIL_TEMPLATE_KEY = 'DefaultWelcomeEmailTemplateId'; // SystemSettings (global default)

/**
 * SysAdmin list routes used to return every tenant's rows when no ?tenantId was passed.
 * Default is the active tenant from requireTenantAccess (x-current-tenant-id / tenant switch).
 * SysAdmin: pass allTenants=true to list across tenants (admin overview).
 */
function wantsAllTenants(req) {
  const userRoles = getUserRoles(req.user);
  return userRoles.includes('SysAdmin') && (req.query.allTenants === 'true' || req.query.allTenants === '1');
}

/** ?tenantId= wins for SysAdmin (explicit picker); otherwise active tenant from middleware */
function effectiveListTenantId(req) {
  const userRoles = getUserRoles(req.user);
  const q = req.query.tenantId;
  if (userRoles.includes('SysAdmin') && q) {
    return q;
  }
  return req.tenantId || req.user?.TenantId || null;
}

// Test endpoint to verify routes are working
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Message Center routes are working!',
    user: req.user ? { userId: req.user.UserId, roles: getUserRoles(req.user) } : null
  });
});

/**
 * GET /api/message-center/welcome-email-template
 * Get the effective welcome email template for the tenant.
 * Resolution: tenant-specific setting first; if none, use default (TenantId IS NULL).
 * Query: ?currentTenantId= or ?tenantId= for context tenant (SysAdmin). Uses req.tenantId from middleware otherwise.
 * Returns: welcomeEmailTemplateId (effective), defaultWelcomeTemplateId (global default, for SysAdmin UI).
 */
router.get('/welcome-email-template', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');
    // Context tenant from middleware (set from header/query by requireTenantAccess)
    const contextTenantId = req.tenantId;

    const request = pool.request();
    request.input('settingKey', sql.NVarChar, WELCOME_EMAIL_TEMPLATE_SETTING_KEY);

    // 1) Tenant-specific setting (only when we have a context tenant)
    let effectiveTemplateId = null;
    if (contextTenantId) {
      request.input('contextTenantId', sql.UniqueIdentifier, contextTenantId);
      const tenantSettingResult = await request.query(`
        SELECT SettingValue
        FROM oe.TenantSettings
        WHERE TenantId = @contextTenantId AND SettingKey = @settingKey
      `);
      if (tenantSettingResult.recordset.length > 0 && tenantSettingResult.recordset[0].SettingValue) {
        effectiveTemplateId = tenantSettingResult.recordset[0].SettingValue.trim();
      }
    }

    // 2) Default (system-wide) - from SystemSettings, fallback when no tenant-specific setting
    const defaultRequest = pool.request();
    defaultRequest.input('settingKey', sql.NVarChar, DEFAULT_WELCOME_EMAIL_TEMPLATE_KEY);
    const defaultResult = await defaultRequest.query(`
      SELECT SettingValue
      FROM oe.SystemSettings
      WHERE SettingKey = @settingKey
    `);
    const defaultTemplateId = defaultResult.recordset.length > 0 && defaultResult.recordset[0].SettingValue
      ? defaultResult.recordset[0].SettingValue.trim()
      : null;

    if (!effectiveTemplateId) {
      effectiveTemplateId = defaultTemplateId;
    }

    if (!effectiveTemplateId) {
      return res.json({
        success: true,
        data: {
          welcomeEmailTemplateId: null,
          ...(isSysAdmin && defaultTemplateId ? { defaultWelcomeTemplateId: defaultTemplateId } : {})
        }
      });
    }

    // Resolve template details (effective template must be valid for context tenant or global)
    let templateResult;
    if (contextTenantId) {
      const tr = pool.request();
      tr.input('templateId', sql.UniqueIdentifier, effectiveTemplateId);
      tr.input('contextTenantId', sql.UniqueIdentifier, contextTenantId);
      templateResult = await tr.query(`
        SELECT TemplateId, TemplateName, Subject
        FROM oe.MessageTemplates
        WHERE TemplateId = @templateId
          AND (TenantId = @contextTenantId OR TenantId IS NULL)
          AND IsActive = 1
          AND MessageType = 'Email'
      `);
    } else {
      const tr = pool.request();
      tr.input('templateId', sql.UniqueIdentifier, effectiveTemplateId);
      templateResult = await tr.query(`
        SELECT TemplateId, TemplateName, Subject
        FROM oe.MessageTemplates
        WHERE TemplateId = @templateId
          AND TenantId IS NULL
          AND IsActive = 1
          AND MessageType = 'Email'
      `);
    }

    if (templateResult.recordset.length === 0) {
      return res.json({
        success: true,
        data: {
          welcomeEmailTemplateId: effectiveTemplateId,
          templateName: null,
          subject: null,
          ...(isSysAdmin ? { defaultWelcomeTemplateId: defaultTemplateId } : {})
        }
      });
    }

    const row = templateResult.recordset[0];
    res.json({
      success: true,
      data: {
        welcomeEmailTemplateId: row.TemplateId,
        templateName: row.TemplateName,
        subject: row.Subject,
        ...(isSysAdmin ? { defaultWelcomeTemplateId: defaultTemplateId } : {})
      }
    });
  } catch (error) {
    console.error('Error getting welcome email template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get welcome email template',
      error: error.message
    });
  }
});

/**
 * PUT /api/message-center/welcome-email-template
 * Set or clear the template used as the welcome email.
 * Body: { templateId: "<guid>" | null, tenantId?: "<guid>" | null }
 * - tenantId omitted: use req.tenantId (current context).
 * - SysAdmin only: tenantId = "<guid>" sets for that tenant; tenantId = null sets the global default.
 * @access TenantAdmin, SysAdmin (requires requireTenantAccess for tenant context)
 */
router.put('/welcome-email-template', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');
    const templateId = req.body?.templateId;
    // Explicitly check for 'tenantId' key so we distinguish "not sent" from "sent null" (null = set global default)
    const bodyTenantId = req.body && Object.prototype.hasOwnProperty.call(req.body, 'tenantId') ? req.body.tenantId : undefined;

    // Target tenant: SysAdmin may pass body.tenantId (guid = that tenant, null = global default); else use context
    let targetTenantId = req.tenantId;
    if (isSysAdmin && bodyTenantId !== undefined) {
      targetTenantId = (bodyTenantId === null || bodyTenantId === '') ? null : bodyTenantId;
    }
    if (targetTenantId === undefined) {
      targetTenantId = req.tenantId;
    }
    // Non-SysAdmin must have a tenant (no global default for them)
    if (!targetTenantId && !isSysAdmin) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }

    const clearTemplate = templateId == null || (typeof templateId === 'string' && templateId.trim() === '');

    if (clearTemplate) {
      if (targetTenantId) {
        const delRequest = pool.request();
        delRequest.input('tenantId', sql.UniqueIdentifier, targetTenantId);
        delRequest.input('settingKey', sql.NVarChar, WELCOME_EMAIL_TEMPLATE_SETTING_KEY);
        await delRequest.query(`
          DELETE FROM oe.TenantSettings
          WHERE TenantId = @tenantId AND SettingKey = @settingKey
        `);
      } else {
        const delRequest = pool.request();
        delRequest.input('settingKey', sql.NVarChar, DEFAULT_WELCOME_EMAIL_TEMPLATE_KEY);
        delRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        await delRequest.query(`
          UPDATE oe.SystemSettings SET SettingValue = NULL, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy WHERE SettingKey = @settingKey
        `);
      }
      return res.json({
        success: true,
        data: { welcomeEmailTemplateId: null },
        message: 'Welcome email template cleared'
      });
    }

    const templateIdStr = typeof templateId === 'string' ? templateId.trim() : String(templateId);
    if (!templateIdStr) {
      return res.status(400).json({ success: false, message: 'templateId must be a non-empty GUID or null to clear' });
    }

    // Validate template: for a tenant target, template must be for that tenant or global; for default (null), template must be global
    let validateResult;
    if (targetTenantId) {
      const vr = pool.request();
      vr.input('templateId', sql.UniqueIdentifier, templateIdStr);
      vr.input('tenantId', sql.UniqueIdentifier, targetTenantId);
      validateResult = await vr.query(`
        SELECT TemplateId, TemplateName, Subject
        FROM oe.MessageTemplates
        WHERE TemplateId = @templateId
          AND (TenantId = @tenantId OR TenantId IS NULL)
          AND IsActive = 1
          AND MessageType = 'Email'
      `);
    } else {
      const vr = pool.request();
      vr.input('templateId', sql.UniqueIdentifier, templateIdStr);
      validateResult = await vr.query(`
        SELECT TemplateId, TemplateName, Subject
        FROM oe.MessageTemplates
        WHERE TemplateId = @templateId
          AND TenantId IS NULL
          AND IsActive = 1
          AND MessageType = 'Email'
      `);
    }

    if (validateResult.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: targetTenantId
          ? 'Template not found or not usable as welcome email. It must be an active Email template for this tenant (or global).'
          : 'Template not found or not global. Default welcome email must be a global (All Tenants) template.'
      });
    }

    if (targetTenantId) {
      const upsertRequest = pool.request();
      upsertRequest.input('tenantId', sql.UniqueIdentifier, targetTenantId);
      upsertRequest.input('settingKey', sql.NVarChar, WELCOME_EMAIL_TEMPLATE_SETTING_KEY);
      upsertRequest.input('settingValue', sql.NVarChar, templateIdStr);
      upsertRequest.input('settingType', sql.NVarChar, 'String');
      upsertRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
      await upsertRequest.query(`
        MERGE oe.TenantSettings AS target
        USING (SELECT @tenantId AS TenantId, @settingKey AS SettingKey) AS source
        ON target.TenantId = source.TenantId AND target.SettingKey = source.SettingKey
        WHEN MATCHED THEN
          UPDATE SET
            SettingValue = @settingValue,
            ModifiedDate = GETDATE(),
            ModifiedBy = @modifiedBy
        WHEN NOT MATCHED THEN
          INSERT (TenantId, SettingKey, SettingValue, SettingType, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
          VALUES (@tenantId, @settingKey, @settingValue, @settingType, GETDATE(), GETDATE(), @modifiedBy, @modifiedBy);
      `);
    } else {
      const sysRequest = pool.request();
      sysRequest.input('settingKey', sql.NVarChar, DEFAULT_WELCOME_EMAIL_TEMPLATE_KEY);
      sysRequest.input('settingValue', sql.NVarChar, templateIdStr);
      sysRequest.input('settingType', sql.NVarChar, 'String');
      sysRequest.input('category', sql.NVarChar, 'Email');
      sysRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
      await sysRequest.query(`
        IF EXISTS (SELECT 1 FROM oe.SystemSettings WHERE SettingKey = @settingKey)
          UPDATE oe.SystemSettings SET SettingValue = @settingValue, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy WHERE SettingKey = @settingKey
        ELSE
          INSERT INTO oe.SystemSettings (SettingKey, SettingValue, SettingType, Category, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
          VALUES (@settingKey, @settingValue, @settingType, @category, GETDATE(), GETDATE(), @modifiedBy, @modifiedBy);
      `);
    }

    const row = validateResult.recordset[0];
    res.json({
      success: true,
      data: {
        welcomeEmailTemplateId: row.TemplateId,
        templateName: row.TemplateName,
        subject: row.Subject
      },
      message: 'Welcome email template updated'
    });
  } catch (error) {
    console.error('Error setting welcome email template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set welcome email template',
      error: error.message
    });
  }
});

/**
 * GET /api/message-center/templates
 * Get message templates - returns real data from database
 * Visibility Rules (no globals; revised 2026-05-11):
 * - Vendor caller: TenantId = userTenantId AND VendorId = vendorIdFilter
 * - TenantAdmin:   TenantId = userTenantId AND VendorId IS NULL
 * - SysAdmin:      no base filter — optional ?scope=tenant|vendor and ?tenantId=<uuid> narrowing
 */
router.get('/templates', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    console.log('📧 Message Center: Getting templates for user:', req.user?.Email);

    const pool = await getPool();
    const { page = 1, limit = 10, search, messageType, isActive } = req.query;
    const offset = (page - 1) * limit;
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');
    const scope = await resolveMessagingScope(req);

    // Start building the query
    let whereConditions = [];
    const request = pool.request();
    const userTenantId = req.tenantId || req.user?.TenantId || null;

    if (scope.isVendor) {
      // Vendor caller: filter by VendorId only. Vendor templates have TenantId IS NULL
      // per the XOR rule (CK_MessageTemplates_TenantOrVendor) — tenant is implicit.
      whereConditions.push('VendorId = @vendorIdFilter');
      request.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
    } else if (isSysAdmin) {
      // SysAdmin: no base filter — narrow only with explicit query params
      if (req.query.tenantId) {
        whereConditions.push('TenantId = @tenantId');
        request.input('tenantId', sql.UniqueIdentifier, req.query.tenantId);
      }
      if (req.query.scope === 'tenant') {
        whereConditions.push('VendorId IS NULL');
      } else if (req.query.scope === 'vendor') {
        whereConditions.push('VendorId IS NOT NULL');
      }
    } else {
      // TenantAdmin: tenant rows that are not vendor-owned
      if (!userTenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      whereConditions.push('TenantId = @tenantId');
      request.input('tenantId', sql.UniqueIdentifier, userTenantId);
      whereConditions.push('VendorId IS NULL');
    }

    if (search) {
      whereConditions.push('(TemplateName LIKE @search OR Subject LIKE @search)');
      request.input('search', sql.NVarChar, `%${search}%`);
    }

    if (messageType) {
      whereConditions.push('MessageType = @messageType');
      request.input('messageType', sql.NVarChar, messageType);
    }

    if (isActive !== undefined) {
      whereConditions.push('IsActive = @isActive');
      request.input('isActive', sql.Bit, isActive === 'true');
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM oe.MessageTemplates ${whereClause}`;
    console.log('Count Query:', countQuery);
    
    const countResult = await request.query(countQuery);
    const total = countResult.recordset[0].total;

    // Get paginated results
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    // We need the whereClause to apply to the unaliased columns of oe.MessageTemplates.
    // Since whereConditions reference bare column names, this works whether we alias
    // the table or not — but we add JOINs for Tenant/Vendor names without affecting filters.
    const dataQuery = `
      SELECT
        mt.TemplateId as templateId,
        mt.TenantId as tenantId,
        mt.VendorId as vendorId,
        t.Name as tenantName,
        v.VendorName as vendorName,
        mt.TemplateName as templateName,
        mt.MessageType as messageType,
        mt.Subject as subject,
        mt.Body as body,
        mt.ReplyTo as replyTo,
        mt.IsActive as isActive,
        mt.CreatedDate as createdDate,
        mt.CreatedBy as createdBy,
        mt.ModifiedDate as modifiedDate,
        mt.ModifiedBy as modifiedBy,
        mt.MessageCategory as messageCategory
      FROM oe.MessageTemplates mt
      LEFT JOIN oe.Tenants t ON mt.TenantId = t.TenantId
      LEFT JOIN oe.Vendors v ON mt.VendorId = v.VendorId
      ${whereClause ? whereClause.replace(/\b(TemplateId|TenantId|VendorId|TemplateName|MessageType|Subject|Body|ReplyTo|IsActive)\b/g, 'mt.$1') : ''}
      ORDER BY mt.TemplateName
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `;

    console.log('Data Query:', dataQuery);
    const result = await request.query(dataQuery);

    console.log(`✅ Found ${result.recordset.length} templates (Total: ${total})`);

    res.json({
      success: true,
      data: {
        data: result.recordset,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalItems: total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching templates:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch templates',
      error: error.message 
    });
  }
});

/**
 * POST /api/message-center/templates
 * Create a new template.
 * Visibility model (revised 2026-05-11 — no globals):
 * - Vendor caller: TenantId = userTenantId, VendorId = userVendorId (forced).
 * - TenantAdmin:   TenantId = userTenantId, VendorId = NULL (forced).
 * - SysAdmin:
 *     - If `createForVendorId` is provided: VendorId = createForVendorId,
 *       and TenantId is INFERRED from oe.Users (any user row for that vendor).
 *       Any `createForTenantId` sent by the client is ignored. If the vendor
 *       has no portal users, returns 400 — tenant context can't be determined.
 *     - Else if `createForTenantId` is provided: TenantId = createForTenantId,
 *       VendorId = NULL (tenant-scoped template).
 *     - Else: falls back to the SysAdmin's active tenant.
 */
router.post('/templates', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    console.log('📝 Create template request:', {
      body: req.body,
      user: {
        UserId: req.user?.UserId,
        UserRoles: getUserRoles(req.user),
        TenantId: req.user?.TenantId
      }
    });

    const pool = await getPool();
    const scope = await resolveMessagingScope(req);
    const {
      templateName,
      messageType,   // 'Email' or 'SMS'
      subject,
      body,
      replyTo,       // Optional - e.g. {[agent.Email]} for welcome emails
      isActive = true,
      messageCategory = 'Marketing',
      createForTenantId,
      createForVendorId
    } = req.body;

    // Validate required fields
    if (!templateName || !messageType || !body) {
      console.log('❌ Validation failed:', { templateName, messageType, bodyLength: body?.length });
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: templateName, messageType, and body are required'
      });
    }

    // Determine final TenantId and VendorId based on caller role
    let finalTenantId;
    let finalVendorId;
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');

    if (scope.isVendor) {
      // Vendor caller: vendor template, TenantId IS NULL per XOR rule.
      finalTenantId = null;
      finalVendorId = scope.vendorIdFilter;
    } else if (isSysAdmin) {
      // SysAdmin:
      //   - createForVendorId → vendor template (TenantId=NULL, VendorId=picked)
      //   - createForTenantId → tenant template (TenantId=picked, VendorId=NULL)
      //   - neither → fall back to SysAdmin's active tenant (tenant template)
      // XOR enforced by CK_MessageTemplates_TenantOrVendor in the DB.
      if (createForVendorId) {
        finalTenantId = null;
        finalVendorId = createForVendorId;
      } else {
        finalTenantId = createForTenantId || req.tenantId || req.user?.TenantId || null;
        finalVendorId = null;
        if (!finalTenantId) {
          return res.status(400).json({
            success: false,
            message: 'createForTenantId is required when creating a tenant template as SysAdmin'
          });
        }
      }
    } else {
      // TenantAdmin: tenant template, scoped to their tenant.
      finalTenantId = req.user.TenantId;
      finalVendorId = null;
      if (!finalTenantId) {
        return res.status(400).json({ success: false, message: 'User must belong to a tenant to create templates' });
      }
    }

    // Generate new GUID for template
    const templateId = require('crypto').randomUUID();

    console.log('📋 Template details:', {
      templateId,
      tenantId: finalTenantId,
      vendorId: finalVendorId,
      templateName,
      messageType,
      subjectLength: subject?.length,
      bodyLength: body.length,
      isActive,
      createdBy: req.user.UserId
    });

    const request = pool.request();
    request.input('templateId', sql.UniqueIdentifier, templateId);
    request.input('tenantId', sql.UniqueIdentifier, finalTenantId);
    request.input('vendorId', sql.UniqueIdentifier, finalVendorId);
    request.input('templateName', sql.NVarChar, templateName);
    request.input('messageType', sql.NVarChar, messageType);
    // Handle null subject for SMS templates
    request.input('subject', sql.NVarChar, subject || null);
    request.input('body', sql.NVarChar, body);
    request.input('replyTo', sql.NVarChar, replyTo == null || replyTo === '' ? null : replyTo);
    request.input('isActive', sql.Bit, isActive);
    request.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
    const cat = messageCategory === 'System' ? 'System' : 'Marketing';
    request.input('messageCategory', sql.NVarChar(20), cat);

    const insertQuery = `
      INSERT INTO oe.MessageTemplates (
        TemplateId, TenantId, VendorId, TemplateName, MessageType, MessageCategory,
        Subject, Body, ReplyTo, IsActive, CreatedDate, CreatedBy
      ) VALUES (
        @templateId, @tenantId, @vendorId, @templateName, @messageType, @messageCategory,
        @subject, @body, @replyTo, @isActive, GETDATE(), @createdBy
      )
    `;

    console.log('🔄 Executing insert query...');
    await request.query(insertQuery);

    console.log(`✅ Created template: ${templateName} (ID: ${templateId}, TenantId: ${finalTenantId}, VendorId: ${finalVendorId || 'none'})`);

    res.json({
      success: true,
      data: { templateId, tenantId: finalTenantId, vendorId: finalVendorId },
      message: 'Template created successfully'
    });
  } catch (error) {
    console.error('❌ Error creating template - Full error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create template',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * PUT /api/message-center/templates/:id
 * Update existing template
 */
router.put('/templates/:id', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { templateName, messageType, subject, body, replyTo, isActive, messageCategory,
            // Owner reassignment — SysAdmin only. XOR enforced.
            tenantId: newTenantId, vendorId: newVendorId } = req.body;

    // Scope-guarded existence check before updating (no globals — 2-way branch)
    const scope = await resolveMessagingScope(req);
    const tenantIdForScope = req.tenantId || req.user?.TenantId || null;
    const callerRoles = getUserRoles(req.user);
    const callerIsSysAdmin = callerRoles.includes('SysAdmin');

    const existingRequest = pool.request();
    existingRequest.input('id', sql.UniqueIdentifier, req.params.id);
    let existingQuery;
    if (scope.isVendor) {
      // Vendor caller: vendor rows only (XOR — vendor templates have TenantId IS NULL).
      existingRequest.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
      existingQuery = 'SELECT TemplateId FROM oe.MessageTemplates WHERE TemplateId = @id AND VendorId = @vendorIdFilter';
    } else if (callerIsSysAdmin) {
      // SysAdmin may edit ANY template (no scope filter)
      existingQuery = 'SELECT TemplateId FROM oe.MessageTemplates WHERE TemplateId = @id';
    } else {
      // TenantAdmin: their tenant's tenant-owned templates
      existingRequest.input('tenantId', sql.UniqueIdentifier, tenantIdForScope);
      existingQuery = 'SELECT TemplateId FROM oe.MessageTemplates WHERE TemplateId = @id AND TenantId = @tenantId AND VendorId IS NULL';
    }
    const existing = await existingRequest.query(existingQuery);
    if (existing.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found or out of scope' });
    }

    const request = pool.request();
    request.input('templateId', sql.UniqueIdentifier, req.params.id);
    request.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

    // Build update fields
    const updateFields = [];
    if (templateName !== undefined) {
      updateFields.push('TemplateName = @templateName');
      request.input('templateName', sql.NVarChar, templateName);
    }

    if (messageType !== undefined) {
      updateFields.push('MessageType = @messageType');
      request.input('messageType', sql.NVarChar, messageType);
    }

    if (subject !== undefined) {
      updateFields.push('Subject = @subject');
      request.input('subject', sql.NVarChar, subject);
    }

    if (body !== undefined) {
      updateFields.push('Body = @body');
      request.input('body', sql.NVarChar, body);
    }
    if (replyTo !== undefined) {
      updateFields.push('ReplyTo = @replyTo');
      request.input('replyTo', sql.NVarChar, replyTo === null || replyTo === '' ? null : replyTo);
    }
    if (isActive !== undefined) {
      updateFields.push('IsActive = @isActive');
      request.input('isActive', sql.Bit, isActive);
    }
    if (messageCategory !== undefined) {
      const cat = messageCategory === 'System' ? 'System' : 'Marketing';
      updateFields.push('MessageCategory = @messageCategory');
      request.input('messageCategory', sql.NVarChar(20), cat);
    }

    // SysAdmin owner reassignment: change which tenant or vendor owns this template.
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
      updateFields.push('TenantId = @newTenantId', 'VendorId = @newVendorId');
      request.input('newTenantId', sql.UniqueIdentifier, tHas ? newTenantId : null);
      request.input('newVendorId', sql.UniqueIdentifier, vHas ? newVendorId : null);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    updateFields.push('ModifiedDate = GETDATE()', 'ModifiedBy = @modifiedBy');

    // The SELECT gate above already enforces scope; the UPDATE only needs to target the row.
    const updateQuery = `
      UPDATE oe.MessageTemplates
      SET ${updateFields.join(', ')}
      WHERE TemplateId = @templateId
    `;

    const result = await request.query(updateQuery);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found or no permission to update'
      });
    }

    res.json({ 
      success: true, 
      message: 'Template updated successfully' 
    });
  } catch (error) {
    console.error('❌ Error updating template:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update template',
      error: error.message 
    });
  }
});

/**
 * DELETE /api/message-center/templates/:id
 * Delete a template
 * Deletion Rules:
 * - Global templates (TenantId NULL): Only SysAdmin can delete
 * - Tenant templates: SysAdmin or users from that tenant can delete
 */
router.delete('/templates/:id', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();

    // Scope-guarded existence check
    const scope = await resolveMessagingScope(req);
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');

    const checkRequest = pool.request();
    checkRequest.input('templateId', sql.UniqueIdentifier, req.params.id);
    let checkQuery;
    if (scope.isVendor) {
      checkRequest.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
      checkQuery = `SELECT TenantId, TemplateName FROM oe.MessageTemplates
                    WHERE TemplateId = @templateId AND VendorId = @vendorIdFilter`;
    } else if (isSysAdmin) {
      // SysAdmin may delete ANY template (no scope filter)
      checkQuery = `SELECT TenantId, TemplateName FROM oe.MessageTemplates
                    WHERE TemplateId = @templateId`;
    } else {
      checkRequest.input('tenantId', sql.UniqueIdentifier, req.tenantId || req.user?.TenantId || null);
      checkQuery = `SELECT TenantId, TemplateName FROM oe.MessageTemplates
                    WHERE TemplateId = @templateId AND TenantId = @tenantId AND VendorId IS NULL`;
    }

    const checkResult = await checkRequest.query(checkQuery);

    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found or out of scope'
      });
    }

    const currentTemplate = checkResult.recordset[0];
    const currentTenantId = currentTemplate.TenantId;

    // Proceed with deletion
    const deleteRequest = pool.request();
    deleteRequest.input('templateId', sql.UniqueIdentifier, req.params.id);
    
    const result = await deleteRequest.query(`
      DELETE FROM oe.MessageTemplates 
      WHERE TemplateId = @templateId
    `);

    console.log(`✅ Deleted template: ${currentTemplate.TemplateName} (TenantId: ${currentTenantId || 'GLOBAL'})`);

    res.json({ 
      success: true, 
      message: 'Template deleted successfully' 
    });
  } catch (error) {
    console.error('❌ Error deleting template:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete template',
      error: error.message 
    });
  }
});

/**
 * POST /api/message-center/templates/:id/test
 * Test a template with sample data
 */
router.post('/templates/:id/test', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { testData } = req.body;

    // Scope-guarded fetch (no globals — 2-way branch: vendor strict vs non-vendor permissive)
    const scope = await resolveMessagingScope(req);
    const tenantIdForScope = req.tenantId || req.user?.TenantId || null;
    const callerRoles = getUserRoles(req.user);
    const callerIsSysAdmin = callerRoles.includes('SysAdmin');
    const templateRequest = pool.request()
      .input('templateId', sql.UniqueIdentifier, req.params.id);
    let templateQuery;
    if (scope.isVendor) {
      templateRequest.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
      templateQuery = `SELECT Subject, Body, ReplyTo FROM oe.MessageTemplates
         WHERE TemplateId = @templateId AND VendorId = @vendorIdFilter`;
    } else if (callerIsSysAdmin) {
      templateQuery = `SELECT Subject, Body, ReplyTo FROM oe.MessageTemplates
         WHERE TemplateId = @templateId`;
    } else {
      templateRequest.input('tenantId', sql.UniqueIdentifier, tenantIdForScope);
      templateQuery = `SELECT Subject, Body, ReplyTo FROM oe.MessageTemplates
         WHERE TemplateId = @templateId AND TenantId = @tenantId AND VendorId IS NULL`;
    }
    const result = await templateRequest.query(templateQuery);

    if (!result.recordset.length) {
      return res.status(404).json({ 
        success: false, 
        message: 'Template not found' 
      });
    }

    const template = result.recordset[0];
    let processedSubject = template.Subject || '';
    let processedBody = template.Body || '';
    let processedReplyTo = template.ReplyTo || '';

    // Replace variables with test data (escape regex metacharacters in keys like member.TerminationDate)
    if (testData) {
      const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      Object.entries(testData).forEach(([key, value]) => {
        const regex = new RegExp(`\\{\\[${escapeRe(key)}\\]\\}`, 'g');
        processedSubject = processedSubject.replace(regex, String(value ?? ''));
        processedBody = processedBody.replace(regex, String(value ?? ''));
        processedReplyTo = processedReplyTo.replace(regex, String(value ?? ''));
      });
    }

    res.json({
      success: true,
      data: {
        subject: processedSubject,
        body: processedBody,
        ...(processedReplyTo && { replyTo: processedReplyTo })
      }
    });
  } catch (error) {
    console.error('Error testing template:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to test template',
      error: error.message 
    });
  }
});

/**
 * POST /api/message-center/templates/:id/preview-group
 * Preview a template with group/member context
 */
router.post('/templates/:id/preview-group', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { groupId } = req.body;
    const templateId = req.params.id;
    const scope = await resolveMessagingScope(req);

    if (!groupId) {
      return res.status(400).json({
        success: false,
        message: 'Group ID is required'
      });
    }

    // Verify access to group
    const accessCheck = pool.request();
    accessCheck.input('groupId', sql.UniqueIdentifier, groupId);

    const callerRoles = getUserRoles(req.user);
    const callerIsSysAdmin = callerRoles.includes('SysAdmin');

    let accessQuery;
    if (callerIsSysAdmin) {
      // SysAdmin: no tenant restriction (can preview against any group)
      accessQuery = 'SELECT GroupId, TenantId, Name FROM oe.Groups WHERE GroupId = @groupId';
    } else {
      const scopeId = req.tenantId || req.user?.TenantId || null;
      if (!scopeId) {
        return res.status(403).json({ success: false, message: 'Tenant context required' });
      }
      accessCheck.input('userTenantId', sql.UniqueIdentifier, scopeId);
      accessQuery = 'SELECT GroupId, TenantId, Name FROM oe.Groups WHERE GroupId = @groupId AND TenantId = @userTenantId';
    }

    const accessResult = await accessCheck.query(accessQuery);
    if (accessResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found or access denied'
      });
    }

    const groupData = accessResult.recordset[0];

    // Get the template (scope-guarded — no globals)
    const templateRequest = pool.request();
    templateRequest.input('templateId', sql.UniqueIdentifier, templateId);
    let templateQuery;
    if (scope.isVendor) {
      templateRequest.input('tenantId', sql.UniqueIdentifier, groupData.TenantId);
      templateRequest.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
      templateQuery = `SELECT Subject, Body, ReplyTo
         FROM oe.MessageTemplates
         WHERE TemplateId = @templateId
         AND TenantId = @tenantId
         AND VendorId = @vendorIdFilter
         AND IsActive = 1`;
    } else if (callerIsSysAdmin) {
      templateQuery = `SELECT Subject, Body, ReplyTo
         FROM oe.MessageTemplates
         WHERE TemplateId = @templateId
         AND IsActive = 1`;
    } else {
      templateRequest.input('tenantId', sql.UniqueIdentifier, groupData.TenantId);
      templateQuery = `SELECT Subject, Body, ReplyTo
         FROM oe.MessageTemplates
         WHERE TemplateId = @templateId
         AND TenantId = @tenantId
         AND VendorId IS NULL
         AND IsActive = 1`;
    }
    const templateResult = await templateRequest.query(templateQuery);

    if (!templateResult.recordset.length) {
      return res.status(404).json({ 
        success: false, 
        message: 'Template not found or not accessible' 
      });
    }

    const template = templateResult.recordset[0];
    let processedReplyTo = template.ReplyTo || '';
    
    // Get a sample member from the group for preview
    const { formatMemberDateForTemplate, SQL_MEMBER_EFFECTIVE_TERMINATION_DATE } = require('../services/shared/variableSubstitution');
    const memberResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT TOP 1
          m.MemberId,
          u.FirstName,
          u.LastName,
          ${SQL_MEMBER_EFFECTIVE_TERMINATION_DATE} AS TerminationDate,
          u.Email,
          u.PhoneNumber
        FROM oe.Members m
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.GroupId = @groupId
        AND m.RelationshipType = 'P'
        ORDER BY m.CreatedDate DESC
      `);
    const row = memberResult.recordset[0];
    const sampleMember = row || {
      FirstName: 'John',
      LastName: 'Doe',
      Email: 'john.doe@example.com',
      PhoneNumber: '(555) 123-4567'
    };
    const terminationPreview =
      row?.TerminationDate != null && row.TerminationDate !== ''
        ? formatMemberDateForTemplate(row.TerminationDate)
        : '12/31/2025';

    // Replace template variables with sample data
    let processedSubject = template.Subject || '';
    let processedBody = template.Body || '';

    // Member variables
    processedSubject = processedSubject
      .replace(/\{\[member\.FirstName\]\}/g, sampleMember.FirstName || '')
      .replace(/\{\[member\.LastName\]\}/g, sampleMember.LastName || '')
      .replace(/\{\[member\.Email\]\}/g, sampleMember.Email || '')
      .replace(/\{\[member\.Phone\]\}/g, sampleMember.PhoneNumber || '')
      .replace(/\{\[member\.FullName\]\}/g, `${sampleMember.FirstName || ''} ${sampleMember.LastName || ''}`.trim())
      .replace(/\{\[member\.TerminationDate\]\}/g, terminationPreview);

    processedBody = processedBody
      .replace(/\{\[member\.FirstName\]\}/g, sampleMember.FirstName || '')
      .replace(/\{\[member\.LastName\]\}/g, sampleMember.LastName || '')
      .replace(/\{\[member\.Email\]\}/g, sampleMember.Email || '')
      .replace(/\{\[member\.Phone\]\}/g, sampleMember.PhoneNumber || '')
      .replace(/\{\[member\.FullName\]\}/g, `${sampleMember.FirstName || ''} ${sampleMember.LastName || ''}`.trim())
      .replace(/\{\[member\.TerminationDate\]\}/g, terminationPreview);

    // Group variables
    processedSubject = processedSubject
      .replace(/\{\[group\.Name\]\}/g, groupData.Name || '');
    
    processedBody = processedBody
      .replace(/\{\[group\.Name\]\}/g, groupData.Name || '');

    // System variables
    const currentDate = new Date().toLocaleDateString();
    const currentYear = new Date().getFullYear().toString();
    
    processedSubject = processedSubject
      .replace(/\{\[system\.CurrentDate\]\}/g, currentDate)
      .replace(/\{\[system\.CurrentYear\]\}/g, currentYear);
    
    processedBody = processedBody
      .replace(/\{\[system\.CurrentDate\]\}/g, currentDate)
      .replace(/\{\[system\.CurrentYear\]\}/g, currentYear);

    // Same variable substitution for ReplyTo
    processedReplyTo = processedReplyTo
      .replace(/\{\[member\.FirstName\]\}/g, sampleMember.FirstName || '')
      .replace(/\{\[member\.LastName\]\}/g, sampleMember.LastName || '')
      .replace(/\{\[member\.Email\]\}/g, sampleMember.Email || '')
      .replace(/\{\[member\.Phone\]\}/g, sampleMember.PhoneNumber || '')
      .replace(/\{\[member\.FullName\]\}/g, `${sampleMember.FirstName || ''} ${sampleMember.LastName || ''}`.trim())
      .replace(/\{\[member\.TerminationDate\]\}/g, terminationPreview)
      .replace(/\{\[group\.Name\]\}/g, groupData.Name || '')
      .replace(/\{\[system\.CurrentDate\]\}/g, currentDate)
      .replace(/\{\[system\.CurrentYear\]\}/g, currentYear);

    res.json({
      success: true,
      data: {
        subject: processedSubject,
        body: processedBody,
        ...(processedReplyTo && { replyTo: processedReplyTo })
      }
    });
  } catch (error) {
    console.error('Error previewing template with group context:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to preview template',
      error: error.message 
    });
  }
});

// ============================================================================
// SCHEDULED MESSAGES
// ============================================================================

/**
 * POST /api/message-center/quick-send
 * Quick-send a template to an individual email address with variable substitution.
 */
router.post('/quick-send', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { recipientEmail, recipientEmails, subject, body, templateId } = req.body;
    const userRoles = getUserRoles(req.user);
    const tenantId = req.tenantId || req.user?.TenantId;

    // Support single email or array
    const emails = recipientEmails || (recipientEmail ? [recipientEmail] : []);
    const validEmails = emails.filter(e => typeof e === 'string' && e.includes('@')).map(e => e.trim().toLowerCase());

    if (validEmails.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one valid recipient email is required' });
    }

    if (!body && !templateId) {
      return res.status(400).json({ success: false, message: 'Email body or template ID is required' });
    }

    // Marketing templates get the CAN-SPAM footer + List-Unsubscribe and respect member opt-out.
    // A free-form send (no templateId) is treated as System (transactional) — no marketing extras.
    let messageCategory = 'System';

    // If a templateId is supplied, enforce scope before doing anything else (no globals — 2-way).
    if (templateId) {
      const scope = await resolveMessagingScope(req);
      const callerIsSysAdmin = userRoles.includes('SysAdmin');
      const tmplReq = pool.request().input('templateId', sql.UniqueIdentifier, templateId);
      const selectCols = `SELECT TemplateId, ISNULL(MessageCategory, 'Marketing') AS MessageCategory FROM oe.MessageTemplates`;
      let tmplQuery;
      if (scope.isVendor) {
        tmplReq.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
        tmplQuery = `${selectCols}
             WHERE TemplateId = @templateId AND VendorId = @vendorIdFilter`;
      } else if (callerIsSysAdmin) {
        tmplQuery = `${selectCols} WHERE TemplateId = @templateId`;
      } else {
        tmplReq.input('tenantId', sql.UniqueIdentifier, tenantId || null);
        tmplQuery = `${selectCols}
             WHERE TemplateId = @templateId AND TenantId = @tenantId AND VendorId IS NULL`;
      }
      const tmplCheck = await tmplReq.query(tmplQuery);
      if (tmplCheck.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Template not found or out of scope' });
      }
      messageCategory = tmplCheck.recordset[0].MessageCategory === 'Marketing' ? 'Marketing' : 'System';
    }

    const { substituteVariables, loadAgentContext, loadTenantContext, loadGroupContext } = require('../services/welcomeEmail.service');
    const { SQL_MEMBER_EFFECTIVE_TERMINATION_DATE } = require('../services/shared/variableSubstitution');
    const { isEmailMarketingOptedOut } = require('../services/memberCommunicationPreferences.service');
    const MessageQueueService = require('../services/messageQueue.service');
    const isMarketing = messageCategory === 'Marketing';
    const messageIds = [];
    const skippedOptOut = [];

    // CAN-SPAM footer needs the tenant's postal address; load once per tenant.
    const tenantFooterCache = new Map();
    const loadTenantFooter = async (tid) => {
      if (!tid) return { name: '', postalLine: '' };
      if (tenantFooterCache.has(tid)) return tenantFooterCache.get(tid);
      const tr = await pool.request()
        .input('tid', sql.UniqueIdentifier, tid)
        .query(`SELECT Name, PrimaryAddress, PrimaryCity, PrimaryState, PrimaryZip FROM oe.Tenants WHERE TenantId = @tid`);
      const t = tr.recordset[0] || {};
      const postalLine = [t.PrimaryAddress, t.PrimaryCity, t.PrimaryState, t.PrimaryZip].filter(Boolean).join(', ');
      const info = { name: t.Name || '', postalLine };
      tenantFooterCache.set(tid, info);
      return info;
    };

    // Send to each recipient with full variable substitution (same as enrollment welcome flow)
    for (const email of validEmails) {
      let recipientUserId = null;
      let recipientMemberId = null;
      let recipientTenantId = tenantId || null;
      let memberContext = {};
      let agentContext = {};
      let tenantContext = {};
      let groupContext = {};

      try {
        // Look up Member + User by email (same join as welcomeEmail.service)
        const memberResult = await pool.request()
          .input('email', sql.NVarChar, email)
          .query(`SELECT TOP 1 m.MemberId, m.UserId, m.AgentId, m.GroupId, m.TenantId,
                         ${SQL_MEMBER_EFFECTIVE_TERMINATION_DATE} AS TerminationDate,
                         u.FirstName, u.LastName, u.Email, u.PhoneNumber
                  FROM oe.Members m
                  JOIN oe.Users u ON m.UserId = u.UserId
                  WHERE LOWER(u.Email) = @email
                  ORDER BY m.CreatedDate DESC`);
        const row = memberResult.recordset[0];

        if (row) {
          recipientUserId = row.UserId;
          recipientMemberId = row.MemberId;
          recipientTenantId = row.TenantId || tenantId || null;
          memberContext = {
            FirstName: row.FirstName || '',
            LastName: row.LastName || '',
            Email: row.Email || '',
            Phone: row.PhoneNumber || '',
            PhoneNumber: row.PhoneNumber || '',
            TerminationDate: row.TerminationDate ?? null
          };

          // Load full context in parallel — same functions the welcome email uses
          const [agent, tenant, group] = await Promise.all([
            loadAgentContext(pool, row.AgentId),
            loadTenantContext(pool, row.TenantId || tenantId),
            row.GroupId ? loadGroupContext(pool, row.GroupId) : Promise.resolve({})
          ]);
          agentContext = agent;
          tenantContext = tenant;
          groupContext = group;
        } else {
          // No member record — try Users table as fallback
          const userResult = await pool.request()
            .input('email', sql.NVarChar, email)
            .query(`SELECT TOP 1 UserId, FirstName, LastName, Email, PhoneNumber FROM oe.Users WHERE LOWER(Email) = @email`);
          const u = userResult.recordset[0];
          if (u) {
            recipientUserId = u.UserId;
            memberContext = { FirstName: u.FirstName || '', LastName: u.LastName || '', Email: u.Email || '', Phone: u.PhoneNumber || '' };
          }
          tenantContext = tenantId ? await loadTenantContext(pool, tenantId) : {};
        }
      } catch (e) { console.warn('Quick-send: failed to load context for', email, e.message); }

      // Marketing quick-sends must respect the member's email opt-out (CAN-SPAM / Joey's report).
      if (isMarketing && recipientMemberId && (await isEmailMarketingOptedOut(recipientMemberId))) {
        skippedOptOut.push(email);
        continue;
      }

      const context = { member: memberContext, agent: agentContext, tenant: tenantContext, group: groupContext, system: { LoginUrl: process.env.LOGIN_URL || process.env.FRONTEND_URL || '' } };
      const finalSubject = substituteVariables(subject || 'Message', context);
      const finalBody = substituteVariables(body || '', context);

      // Marketing templates carry the unsubscribe footer + List-Unsubscribe header (added in queueEmail).
      let marketingCompliance = null;
      if (isMarketing && recipientMemberId) {
        const footer = await loadTenantFooter(recipientTenantId);
        marketingCompliance = {
          memberId: recipientMemberId,
          tenantId: recipientTenantId,
          tenantName: footer.name,
          postalLine: footer.postalLine
        };
      }

      const messageId = await MessageQueueService.queueEmail({
        tenantId: recipientTenantId,
        recipientId: recipientUserId,
        toEmail: email,
        subject: finalSubject,
        htmlContent: finalBody,
        textContent: '',
        createdBy: null,
        marketingCompliance
      });
      messageIds.push(messageId);
    }

    const sentCount = messageIds.length;
    const skippedCount = skippedOptOut.length;
    let resultMessage = `Email queued for ${sentCount} recipient(s)`;
    if (skippedCount > 0) {
      resultMessage += `; ${skippedCount} skipped (unsubscribed from marketing)`;
    }
    return res.json({
      success: true,
      message: resultMessage,
      messageIds,
      count: sentCount,
      skipped: skippedCount,
      skippedEmails: skippedOptOut
    });
  } catch (err) {
    console.error('Quick-send failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

/**
 * GET /api/message-center/schedules
 * Get scheduled messages (paginated). Returns computed nextRunDate.
 */
router.get('/schedules', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { page = 1, limit = 10, search, messageType, isActive } = req.query;
    const offset = (page - 1) * limit;

    let whereConditions = [];
    const request = pool.request();

    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (scopeId) {
        whereConditions.push('sm.TenantId = @tenantId');
        request.input('tenantId', sql.UniqueIdentifier, scopeId);
      }
    }

    if (search) {
      whereConditions.push('sm.ScheduleName LIKE @search');
      request.input('search', sql.NVarChar, `%${search}%`);
    }

    if (messageType) {
      whereConditions.push('sm.MessageType = @messageType');
      request.input('messageType', sql.NVarChar, messageType);
    }

    if (isActive !== undefined) {
      whereConditions.push('sm.IsActive = @isActive');
      request.input('isActive', sql.Bit, isActive === 'true');
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    // Total count
    const countResult = await request.query(`
      SELECT COUNT(*) as total
      FROM oe.ScheduledMessages sm
      ${whereClause}
    `);
    const total = countResult.recordset[0].total;

    // Page query
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    const result = await request.query(`
      SELECT 
        sm.ScheduleId as scheduleId,
        sm.TenantId as tenantId,
        sm.ScheduleName as scheduleName,
        sm.TemplateId as templateId,
        mt.TemplateName as templateName,
        sm.MessageType as messageType,
        sm.RecurrencePattern as recurrencePattern,
        sm.RecurrenceTime as recurrenceTime,
        sm.LastRunDate as lastRunDate,
        sm.IsActive as isActive,
        sm.CreatedDate as createdDate
      FROM oe.ScheduledMessages sm
      LEFT JOIN oe.MessageTemplates mt ON sm.TemplateId = mt.TemplateId
      ${whereClause}
      ORDER BY sm.CreatedDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const computeNextRunDate = (row) => {
      try {
        const pattern = row.recurrencePattern;
        const time = row.recurrenceTime; // time as string e.g. '10:00:00'
        const lastRun = row.lastRunDate ? new Date(row.lastRunDate) : null;
        const now = new Date();
        // Build base next date from today at recurrence time
        const [hh, mm, ss] = (time || '10:00:00').split(':').map(n => parseInt(n, 10));
        let candidate = new Date();
        candidate.setHours(hh || 0, mm || 0, ss || 0, 0);

        const advanceToFuture = () => { if (candidate <= now) candidate = new Date(candidate.getTime() + 24*60*60*1000); };

        switch (pattern) {
          case 'Daily':
            advanceToFuture();
            break;
          case 'Weekly': {
            // next same weekday as lastRun or today; if lastRun exists, add 7 days from lastRun's time
            if (lastRun) {
              candidate = new Date(lastRun);
              candidate.setHours(hh || 0, mm || 0, ss || 0, 0);
              candidate = new Date(candidate.getTime() + 7 * 24 * 60 * 60 * 1000);
            } else {
              while (candidate <= now) candidate = new Date(candidate.getTime() + 7 * 24 * 60 * 60 * 1000);
            }
            break;
          }
          case 'Monthly': {
            const base = lastRun ? new Date(lastRun) : now;
            const next = new Date(base);
            next.setHours(hh || 0, mm || 0, ss || 0, 0);
            next.setMonth(next.getMonth() + 1);
            candidate = next;
            break;
          }
          case 'FirstOfMonth': {
            const base = now;
            let y = base.getFullYear();
            let m = base.getMonth();
            // If already past first of this month at time, go to next month
            const firstThis = new Date(y, m, 1, hh || 0, mm || 0, ss || 0, 0);
            candidate = firstThis > now ? firstThis : new Date(y, m + 1, 1, hh || 0, mm || 0, ss || 0, 0);
            break;
          }
          case 'Annual': {
            const base = lastRun ? new Date(lastRun) : now;
            const next = new Date(base);
            next.setHours(hh || 0, mm || 0, ss || 0, 0);
            next.setFullYear(next.getFullYear() + 1);
            candidate = next;
            break;
          }
          default:
            return null;
        }
        return candidate.toISOString();
      } catch (e) {
        return null;
      }
    };

    const processed = result.recordset.map(row => ({
      ...row,
      nextRunDate: computeNextRunDate(row)
    }));

    res.json({
      success: true,
      data: {
        data: processed,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalItems: total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching schedules:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch schedules',
      error: error.message 
    });
  }
});

/**
 * GET /api/message-center/schedules/:id
 */
router.get('/schedules/:id', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('scheduleId', sql.UniqueIdentifier, req.params.id);

    const result = await request.query(`
      SELECT 
        sm.ScheduleId as scheduleId,
        sm.TenantId as tenantId,
        sm.ScheduleName as scheduleName,
        sm.TemplateId as templateId,
        sm.MessageType as messageType,
        sm.RecurrencePattern as recurrencePattern,
        sm.RecurrenceTime as recurrenceTime,
        sm.LastRunDate as lastRunDate,
        sm.IsActive as isActive,
        sm.CreatedDate as createdDate,
        sm.CreatedBy as createdBy,
        sm.ModifiedDate as modifiedDate,
        sm.ModifiedBy as modifiedBy
      FROM oe.ScheduledMessages sm
      WHERE sm.ScheduleId = @scheduleId
    `);

    if (!result.recordset.length) {
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }

    const row = result.recordset[0];
    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (scopeId && String(row.tenantId) !== String(scopeId)) {
        return res.status(404).json({ success: false, message: 'Schedule not found' });
      }
    }
    res.json({ success: true, data: { ...row } });
  } catch (error) {
    console.error('❌ Error fetching schedule:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch schedule', error: error.message });
  }
});

/**
 * POST /api/message-center/schedules
 * Create new schedule
 */
router.post('/schedules', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const {
      tenantId, // may be null (global) when allowed
      scheduleName,
      templateId,
      messageType,
      recurrencePattern,
      recurrenceTime,
      isActive = true,
    } = req.body;

    if (!scheduleName || !messageType || !recurrencePattern || !recurrenceTime) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Normalize time to HH:MM:SS
    let normalizedTime = String(recurrenceTime).trim();
    const timeMatch = normalizedTime.match(/^\d{1,2}:\d{2}(?::\d{2})?$/);
    if (!timeMatch) {
      return res.status(400).json({ success: false, message: 'Invalid time format. Expected HH:MM or HH:MM:SS' });
    }
    if (normalizedTime.split(':').length === 2) {
      normalizedTime = `${normalizedTime}:00`;
    }

    const scheduleId = require('crypto').randomUUID();
    const userRoles = getUserRoles(req.user);
    const resolvedScheduleTenantId = userRoles.includes('SysAdmin')
      ? (tenantId || null)
      : (req.tenantId || req.user.TenantId || null);

    const request = pool.request();
    request.input('scheduleId', sql.UniqueIdentifier, scheduleId);
    request.input('tenantId', sql.UniqueIdentifier, resolvedScheduleTenantId);
    request.input('scheduleName', sql.NVarChar, scheduleName);
    request.input('templateId', sql.UniqueIdentifier, templateId || null);
    request.input('messageType', sql.NVarChar, messageType);
    request.input('recurrencePattern', sql.NVarChar, recurrencePattern);
    // Bind as NVARCHAR to avoid driver validation; convert in SQL
    request.input('recurrenceTime', sql.NVarChar, normalizedTime);
    request.input('isActive', sql.Bit, isActive);
    request.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

    await request.query(`
      INSERT INTO oe.ScheduledMessages (
        ScheduleId, TenantId, ScheduleName, TemplateId,
        MessageType, RecurrencePattern, RecurrenceTime,
        IsActive, CreatedDate, CreatedBy
      ) VALUES (
        @scheduleId, @tenantId, @scheduleName, @templateId,
        @messageType, @recurrencePattern, TRY_CONVERT(time, @recurrenceTime),
        @isActive, GETDATE(), @createdBy
      )
    `);

    res.json({ success: true, data: { scheduleId } });
  } catch (error) {
    console.error('❌ Error creating schedule:', error);
    res.status(500).json({ success: false, message: 'Failed to create schedule', error: error.message });
  }
});

/**
 * PUT /api/message-center/schedules/:id
 * Update schedule
 */
router.put('/schedules/:id', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('scheduleId', sql.UniqueIdentifier, req.params.id);

    const updateFields = [];
    const {
      tenantId, scheduleName, templateId, messageType,
      recurrencePattern, recurrenceTime, isActive
    } = req.body;

    if (tenantId !== undefined) { updateFields.push('TenantId = @tenantId'); request.input('tenantId', sql.UniqueIdentifier, tenantId || null); }
    if (scheduleName !== undefined) { updateFields.push('ScheduleName = @scheduleName'); request.input('scheduleName', sql.NVarChar, scheduleName); }
    if (templateId !== undefined) { updateFields.push('TemplateId = @templateId'); request.input('templateId', sql.UniqueIdentifier, templateId || null); }
    if (messageType !== undefined) { updateFields.push('MessageType = @messageType'); request.input('messageType', sql.NVarChar, messageType); }
    if (recurrencePattern !== undefined) { updateFields.push('RecurrencePattern = @recurrencePattern'); request.input('recurrencePattern', sql.NVarChar, recurrencePattern); }
    if (recurrenceTime !== undefined) {
      // Normalize time
      let normalizedTime = String(recurrenceTime).trim();
      const timeMatch = normalizedTime.match(/^\d{1,2}:\d{2}(?::\d{2})?$/);
      if (!timeMatch) {
        return res.status(400).json({ success: false, message: 'Invalid time format. Expected HH:MM or HH:MM:SS' });
      }
      if (normalizedTime.split(':').length === 2) {
        normalizedTime = `${normalizedTime}:00`;
      }
      updateFields.push('RecurrenceTime = TRY_CONVERT(time, @recurrenceTime)');
      request.input('recurrenceTime', sql.NVarChar, normalizedTime);
    }
    if (isActive !== undefined) { updateFields.push('IsActive = @isActive'); request.input('isActive', sql.Bit, isActive); }

    if (!updateFields.length) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    updateFields.push('ModifiedDate = GETDATE()', 'ModifiedBy = @modifiedBy');
    request.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

    const result = await request.query(`
      UPDATE oe.ScheduledMessages
      SET ${updateFields.join(', ')}
      WHERE ScheduleId = @scheduleId
    `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }

    res.json({ success: true, message: 'Schedule updated' });
  } catch (error) {
    console.error('❌ Error updating schedule:', error);
    res.status(500).json({ success: false, message: 'Failed to update schedule', error: error.message });
  }
});

/**
 * DELETE /api/message-center/schedules/:id
 */
router.delete('/schedules/:id', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('scheduleId', sql.UniqueIdentifier, req.params.id);

    const result = await request.query('DELETE FROM oe.ScheduledMessages WHERE ScheduleId = @scheduleId');
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: 'Schedule not found' });
    }
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (error) {
    console.error('❌ Error deleting schedule:', error);
    res.status(500).json({ success: false, message: 'Failed to delete schedule', error: error.message });
  }
});

/**
 * POST /api/message-center/schedules/:id/run
 * Run schedule immediately -> queue messages in oe.MessageQueue
 * NOTE: Recipient targeting is not yet defined in schema; implement once rules provided.
 */
router.post('/schedules/:id/run', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    // Placeholder until recipient rules are finalized
    // For now, return 202 Accepted with zero queued
    res.status(202).json({ success: true, data: { messagesQueued: 0 }, message: 'Run queued (recipient rules pending)' });
  } catch (error) {
    console.error('❌ Error running schedule:', error);
    res.status(500).json({ success: false, message: 'Failed to run schedule', error: error.message });
  }
});

// ============================================================================
// MESSAGE QUEUE
// ============================================================================

/**
 * GET /api/message-center/batches
 * Send batches (e.g. message blast): one row per batch with SMS/email progress.
 */
router.get('/batches', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { page = 1, limit = 20, startDate, endDate } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const whereConditions = [];

    const bindBatchFilters = (reqSql) => {
      if (!wantsAllTenants(req)) {
        const scopeId = effectiveListTenantId(req);
        if (scopeId) {
          whereConditions.push('b.TenantId = @tenantId');
          reqSql.input('tenantId', sql.UniqueIdentifier, scopeId);
        }
      }

      if (startDate) {
        const startDateTime = new Date(`${startDate}T00:00:00Z`);
        whereConditions.push('b.CreatedDate >= @startDate');
        reqSql.input('startDate', sql.DateTime2, startDateTime);
      }

      if (endDate) {
        const endDateTime = new Date(`${endDate}T23:59:59Z`);
        whereConditions.push('b.CreatedDate <= @endDate');
        reqSql.input('endDate', sql.DateTime2, endDateTime);
      }
    };

    if (startDate) {
      try {
        new Date(`${startDate}T00:00:00Z`);
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid start date format' });
      }
    }
    if (endDate) {
      try {
        new Date(`${endDate}T23:59:59Z`);
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid end date format' });
      }
    }

    const countReq = pool.request();
    bindBatchFilters(countReq);
    const whereClauseCount = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS totalCount
      FROM oe.MessageSendBatch b
      ${whereClauseCount}
    `);
    const totalItems = countResult.recordset[0].totalCount;

    whereConditions.length = 0;
    const listReq = pool.request();
    bindBatchFilters(listReq);
    const whereClauseList = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    listReq.input('offset', sql.Int, offset);
    listReq.input('limit', sql.Int, parseInt(limit, 10));

    const listResult = await listReq.query(`
      SELECT
        b.BatchId AS batchId,
        b.TenantId AS tenantId,
        ISNULL(tn.Name, '') AS tenantName,
        b.Label AS label,
        b.SmsTotal AS smsTotal,
        b.EmailTotal AS emailTotal,
        b.CreatedDate AS createdDate,
        (SELECT COUNT(*) FROM oe.MessageQueue q WHERE q.BatchId = b.BatchId AND q.MessageType = N'SMS' AND q.Status IN (N'Pending', N'Processing')) AS smsPending,
        (SELECT COUNT(*) FROM oe.MessageQueue q WHERE q.BatchId = b.BatchId AND q.MessageType = N'SMS' AND q.Status = N'Failed') AS smsQueueFailed,
        (SELECT COUNT(*) FROM oe.MessageHistory h WHERE h.BatchId = b.BatchId AND h.MessageType = N'SMS' AND h.Status = N'Sent') AS smsSent,
        (SELECT COUNT(*) FROM oe.MessageHistory h WHERE h.BatchId = b.BatchId AND h.MessageType = N'SMS' AND h.Status = N'Failed') AS smsHistoryFailed,
        (SELECT COUNT(*) FROM oe.MessageQueue q WHERE q.BatchId = b.BatchId AND q.MessageType = N'Email' AND q.Status IN (N'Pending', N'Processing')) AS emailPending,
        (SELECT COUNT(*) FROM oe.MessageQueue q WHERE q.BatchId = b.BatchId AND q.MessageType = N'Email' AND q.Status = N'Failed') AS emailQueueFailed,
        (SELECT COUNT(*) FROM oe.MessageHistory h WHERE h.BatchId = b.BatchId AND h.MessageType = N'Email' AND h.Status = N'Sent') AS emailSent,
        (SELECT COUNT(*) FROM oe.MessageHistory h WHERE h.BatchId = b.BatchId AND h.MessageType = N'Email' AND h.Status = N'Failed') AS emailHistoryFailed
      FROM oe.MessageSendBatch b
      LEFT JOIN oe.Tenants tn ON tn.TenantId = b.TenantId
      ${whereClauseList}
      ORDER BY b.CreatedDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    res.json({
      success: true,
      data: {
        data: listResult.recordset,
        total: totalItems,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        totalPages: Math.ceil(totalItems / parseInt(limit, 10))
      }
    });
  } catch (error) {
    console.error('Error fetching message batches:', error);
    res.status(500).json({
      success: false,
      message: error.message && error.message.includes('MessageSendBatch')
        ? 'Message batch tables missing — run sql-changes/2026-03-27-message-send-batch.sql on the SQL database (one-time; not part of Message Center deploy)'
        : 'Failed to fetch batches',
      error: error.message
    });
  }
});

/**
 * GET /api/message-center/queue
 * Get message queue items
 */
router.get('/queue', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { page = 1, limit = 10, status, messageType, startDate, endDate } = req.query;
    const offset = (page - 1) * limit;

    let whereConditions = [];
    const request = pool.request();

    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (scopeId) {
        whereConditions.push('mq.TenantId = @tenantId');
        request.input('tenantId', sql.UniqueIdentifier, scopeId);
      }
    }

    if (status) {
      whereConditions.push('mq.Status = @status');
      request.input('status', sql.NVarChar, status);
    }

    if (messageType) {
      whereConditions.push('mq.MessageType = @messageType');
      request.input('messageType', sql.NVarChar, messageType);
    }

    if (startDate) {
      try {
        const startDateTime = new Date(`${startDate}T00:00:00Z`);
        whereConditions.push('mq.CreatedDate >= @startDate');
        request.input('startDate', sql.DateTime2, startDateTime);
      } catch (e) {
        console.error('❌ Invalid startDate:', startDate, e);
        return res.status(400).json({ success: false, message: 'Invalid start date format' });
      }
    }

    if (endDate) {
      try {
        const endDateTime = new Date(`${endDate}T23:59:59Z`);
        whereConditions.push('mq.CreatedDate <= @endDate');
        request.input('endDate', sql.DateTime2, endDateTime);
      } catch (e) {
        console.error('❌ Invalid endDate:', endDate, e);
        return res.status(400).json({ success: false, message: 'Invalid end date format' });
      }
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    // Get total count for pagination
    const countResult = await request.query(`
      SELECT COUNT(*) as totalCount
      FROM oe.MessageQueue mq
      LEFT JOIN oe.Users u ON mq.RecipientId = u.UserId
      ${whereClause}
    `);

    const totalItems = countResult.recordset[0].totalCount;

    // Get paginated data
    const result = await request.query(`
      SELECT 
        mq.MessageId as messageId,
        mq.TenantId as tenantId,
        mq.RecipientId as recipientId,
        u.FirstName + ' ' + u.LastName as recipientName,
        mq.RecipientAddress as recipientAddress,
        mq.MessageType as messageType,
        mq.Subject as subject,
        mq.Body as body,
        mq.Status as status,
        mq.RetryCount as retryCount,
        mq.ErrorMessage as errorMessage,
        mq.CreatedDate as createdDate,
        mq.ProcessedDate as processedDate,
        mq.BatchId as batchId
      FROM oe.MessageQueue mq
      LEFT JOIN oe.Users u ON mq.RecipientId = u.UserId
      ${whereClause}
      ORDER BY mq.CreatedDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    res.json({
      success: true,
      data: {
        data: result.recordset,
        total: totalItems,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalItems / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ Error fetching queue:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch queue',
      error: error.message 
    });
  }
});

// ============================================================================
// MESSAGE HISTORY
// ============================================================================

/**
 * GET /api/message-center/history
 * Get message history
 */
router.get('/history', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { page = 1, limit = 10, recipientId, messageType, status, startDate, endDate } = req.query;
    const offset = (page - 1) * limit;

    let whereConditions = [];
    const request = pool.request();

    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (scopeId) {
        whereConditions.push('mh.TenantId = @tenantId');
        request.input('tenantId', sql.UniqueIdentifier, scopeId);
      }
    }

    if (recipientId) {
      whereConditions.push('mh.RecipientId = @recipientId');
      request.input('recipientId', sql.UniqueIdentifier, recipientId);
    }

    if (messageType) {
      whereConditions.push('mh.MessageType = @messageType');
      request.input('messageType', sql.NVarChar, messageType);
    }

    if (status) {
      whereConditions.push('mh.Status = @status');
      request.input('status', sql.NVarChar, status);
    }

    if (startDate) {
      try {
        const startDateTime = new Date(`${startDate}T00:00:00Z`);
        whereConditions.push('mh.SentDate >= @startDate');
        request.input('startDate', sql.DateTime2, startDateTime);
      } catch (e) {
        console.error('❌ Invalid startDate:', startDate, e);
        return res.status(400).json({ success: false, message: 'Invalid start date format' });
      }
    }

    if (endDate) {
      try {
        const endDateTime = new Date(`${endDate}T23:59:59Z`);
        whereConditions.push('mh.SentDate <= @endDate');
        request.input('endDate', sql.DateTime2, endDateTime);
      } catch (e) {
        console.error('❌ Invalid endDate:', endDate, e);
        return res.status(400).json({ success: false, message: 'Invalid end date format' });
      }
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, parseInt(limit));

    // Get total count for pagination
    const countResult = await request.query(`
      SELECT COUNT(*) as totalCount
      FROM oe.MessageHistory mh
      LEFT JOIN oe.Users u ON mh.RecipientId = u.UserId
      ${whereClause}
    `);

    const totalItems = countResult.recordset[0].totalCount;

    // Get paginated data
    const result = await request.query(`
      SELECT 
        mh.HistoryId as historyId,
        mh.MessageId as messageId,
        mh.TenantId as tenantId,
        mh.RecipientId as recipientId,
        COALESCE(u.FirstName + ' ' + u.LastName, 'Unknown User') as recipientName,
        mh.RecipientAddress as recipientAddress,
        mh.MessageType as messageType,
        mh.Subject as subject,
        mh.Status as status,
        mh.ProviderMessageId as providerMessageId,
        mh.ErrorMessage as errorMessage,
        mh.SentDate as sentDate,
        mh.BatchId as batchId
      FROM oe.MessageHistory mh
      LEFT JOIN oe.Users u ON mh.RecipientId = u.UserId
      ${whereClause}
      ORDER BY mh.SentDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    res.json({
      success: true,
      data: {
        data: result.recordset,
        total: totalItems,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalItems / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ Error fetching history:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch history',
      error: error.message 
    });
  }
});

/**
 * GET /api/message-center/history/:id/details
 * Get delivery details for a specific message
 */
router.get('/history/:id/details', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const { id } = req.params;

    const request = pool.request();
    request.input('historyId', sql.UniqueIdentifier, id);

    // Get the message history record first
    const historyResult = await request.query(`
      SELECT
        mh.HistoryId as historyId,
        mh.MessageId as messageId,
        mh.TenantId as tenantId,
        mh.RecipientId as recipientId,
        COALESCE(u.FirstName + ' ' + u.LastName, 'Unknown User') as recipientName,
        mh.RecipientAddress as recipientAddress,
        mh.MessageType as messageType,
        mh.Subject as subject,
        mh.Status as status,
        mh.ProviderMessageId as providerMessageId,
        mh.ErrorMessage as errorMessage,
        mh.SentDate as sentDate,
        mh.Body as body,
        mh.FromAddress as fromAddress
      FROM oe.MessageHistory mh
      LEFT JOIN oe.Users u ON mh.RecipientId = u.UserId
      WHERE mh.HistoryId = @historyId
    `);

    if (historyResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    const message = historyResult.recordset[0];

    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (scopeId && String(scopeId) !== String(message.tenantId)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    // Real provider events for this message, keyed by MessageId
    const eventsRequest = pool.request();
    eventsRequest.input('messageId', sql.UniqueIdentifier, message.messageId);
    const eventsResult = await eventsRequest.query(`
      SELECT EventType AS event,
             EventTime AS timestamp,
             Reason    AS details,
             Provider  AS provider,
             MxServer  AS mxServer,
             EventType AS eventType
        FROM oe.MessageEvent
       WHERE MessageId = @messageId
       ORDER BY EventTime ASC
    `);

    let events = eventsResult.recordset;

    // Fallback for historical rows predating the webhook (0 events in MessageEvent).
    // Use master's richer timeline: Queued + any SendGrid lines captured in the
    // errorMessage column (newline-delimited with [ISO] prefix), plus a Failed
    // synthetic line when Status='Failed' and we have nothing else.
    if (events.length === 0) {
      events = [];
      events.push({
        event: 'Queued',
        timestamp: message.sentDate,
        details: `Submitted via ${message.messageType}${
          message.messageType === 'Email' ? ' (provider events appear below when available)' : ''
        }`
      });

      const errText = message.errorMessage && String(message.errorMessage).trim();
      const sgLines = errText ? errText.split(/\r?\n/).filter((x) => String(x).trim()) : [];
      for (const line of sgLines) {
        const m = /^\[([^\]]+)\]\s+(.+)$/.exec(line);
        if (m) {
          events.push({ event: 'Provider', timestamp: m[1], details: m[2] });
        } else {
          events.push({ event: 'Provider', timestamp: message.sentDate, details: line });
        }
      }

      if (message.status === 'Failed' && sgLines.length === 0) {
        events.push({
          event: 'Failed',
          timestamp: message.sentDate,
          details: 'Message delivery failed'
        });
      }
    }

    // Effective status computed from the real event stream.
    const effectiveStatus = (() => {
      const types = events.map(e => e.event);
      if (types.includes('delivered')) return 'Delivered';
      if (types.some(t => ['bounce', 'dropped', 'spam_report', 'blocked', 'failed', 'undelivered'].includes(t))) {
        return 'Failed';
      }
      if (types.includes('deferred')) return 'Deferred';
      return message.status || 'Sent';
    })();

    res.json({
      success: true,
      data: {
        ...message,
        effectiveStatus,
        events: events
      }
    });
  } catch (error) {
    console.error('❌ Error fetching delivery details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch delivery details',
      error: error.message
    });
  }
});

/**
 * GET /api/message-center/history/export
 * Export message history
 */
router.get('/history/export', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { format = 'csv', startDate, endDate, status, messageType } = req.query;

    if (!['csv', 'excel'].includes(format)) {
      return res.status(400).json({ success: false, message: 'Invalid format. Use csv or excel.' });
    }

    const pool = await getPool();
    let whereConditions = [];
    const request = pool.request();

    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (scopeId) {
        whereConditions.push('mh.TenantId = @tenantId');
        request.input('tenantId', sql.UniqueIdentifier, scopeId);
      }
    }

    if (messageType) {
      whereConditions.push('mh.MessageType = @messageType');
      request.input('messageType', sql.NVarChar, messageType);
    }

    if (status) {
      whereConditions.push('mh.Status = @status');
      request.input('status', sql.NVarChar, status);
    }

    if (startDate) {
      try {
        const startDateTime = new Date(`${startDate}T00:00:00Z`);
        whereConditions.push('mh.SentDate >= @startDate');
        request.input('startDate', sql.DateTime2, startDateTime);
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid start date format' });
      }
    }

    if (endDate) {
      try {
        const endDateTime = new Date(`${endDate}T23:59:59Z`);
        whereConditions.push('mh.SentDate <= @endDate');
        request.input('endDate', sql.DateTime2, endDateTime);
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid end date format' });
      }
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    const result = await request.query(`
      SELECT 
        mh.HistoryId as historyId,
        mh.MessageId as messageId,
        t.Name as tenantName,
        COALESCE(u.FirstName + ' ' + u.LastName, 'Unknown User') as recipientName,
        mh.RecipientAddress as recipientAddress,
        mh.MessageType as messageType,
        mh.Subject as subject,
        mh.Status as status,
        mh.ProviderMessageId as providerMessageId,
        mh.ErrorMessage as errorMessage,
        mh.SentDate as sentDate
      FROM oe.MessageHistory mh
      LEFT JOIN oe.Users u ON mh.RecipientId = u.UserId
      LEFT JOIN oe.Tenants t ON mh.TenantId = t.TenantId
      ${whereClause}
      ORDER BY mh.SentDate DESC
    `);

    const data = result.recordset;

    if (format === 'csv') {
      // Generate CSV
      const headers = ['Date Sent', 'Tenant', 'Recipient Name', 'Recipient Address', 'Type', 'Subject', 'Status', 'Provider ID', 'Error Message'];
      const csvRows = [headers.join(',')];
      
      data.forEach(row => {
        const csvRow = [
          row.sentDate ? new Date(row.sentDate).toLocaleString() : '',
          row.tenantName || '',
          row.recipientName || '',
          row.recipientAddress || '',
          row.messageType || '',
          row.subject ? `"${row.subject.replace(/"/g, '""')}"` : '',
          row.status || '',
          row.providerMessageId || '',
          row.errorMessage ? `"${row.errorMessage.replace(/"/g, '""')}"` : ''
        ];
        csvRows.push(csvRow.join(','));
      });

      const csvContent = csvRows.join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="message-history-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csvContent);
    } else {
      // For Excel format, return JSON data that frontend can process
      // In a real implementation, you'd use a library like exceljs
      res.json({
        success: true,
        data: data,
        message: 'Excel export not fully implemented - returning JSON data'
      });
    }
  } catch (error) {
    console.error('❌ Error exporting history:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export history',
      error: error.message 
    });
  }
});

/**
 * GET /api/message-center/analytics
 * Get message analytics data
 */
router.get('/analytics', authenticate, authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const pool = await getPool();
    
    // Set default date range to last 30 days if not provided
    const defaultEndDate = new Date();
    const defaultStartDate = new Date();
    defaultStartDate.setDate(defaultStartDate.getDate() - 30);
    
    const start = startDate ? new Date(`${startDate}T00:00:00Z`) : defaultStartDate;
    const end = endDate ? new Date(`${endDate}T23:59:59Z`) : defaultEndDate;
    
    let whereConditions = [];
    const request = pool.request();
    
    // Date filtering
    whereConditions.push('mh.SentDate >= @startDate');
    whereConditions.push('mh.SentDate <= @endDate');
    request.input('startDate', sql.DateTime2, start);
    request.input('endDate', sql.DateTime2, end);
    
    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (scopeId) {
        whereConditions.push('mh.TenantId = @tenantId');
        request.input('tenantId', sql.UniqueIdentifier, scopeId);
      }
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    // Get overall statistics
    const statsResult = await request.query(`
      SELECT 
        COUNT(*) as totalMessages,
        SUM(CASE WHEN Status IN ('Sent', 'Sending', 'Deferred', 'Delivered', 'Opened') THEN 1 ELSE 0 END) as totalSent,
        SUM(CASE WHEN Status = 'Failed' THEN 1 ELSE 0 END) as totalFailed,
        SUM(CASE WHEN MessageType = 'Email' THEN 1 ELSE 0 END) as emailCount,
        SUM(CASE WHEN MessageType = 'SMS' THEN 1 ELSE 0 END) as smsCount
      FROM oe.MessageHistory mh
      ${whereClause}
    `);
    
    const stats = statsResult.recordset[0];
    const totalMessages = parseInt(stats.totalMessages) || 0;
    const totalSent = parseInt(stats.totalSent) || 0;
    const totalFailed = parseInt(stats.totalFailed) || 0;
    const emailCount = parseInt(stats.emailCount) || 0;
    const smsCount = parseInt(stats.smsCount) || 0;
    
    // Calculate rates
    const deliveryRate = totalMessages > 0 ? Math.round((totalSent / totalMessages) * 100 * 100) / 100 : 0;
    
    // Get daily statistics
    const dailyResult = await request.query(`
      SELECT 
        CAST(mh.SentDate as DATE) as date,
        COUNT(*) as totalSent,
        SUM(CASE WHEN Status = 'Failed' THEN 1 ELSE 0 END) as totalFailed
      FROM oe.MessageHistory mh
      ${whereClause}
      GROUP BY CAST(mh.SentDate as DATE)
      ORDER BY CAST(mh.SentDate as DATE)
    `);
    
    // Get tenant summaries (SysAdmin + allTenants only — avoids leaking other tenants when scoped)
    let tenantSummaries = [];
    if (getUserRoles(req.user).includes('SysAdmin') && wantsAllTenants(req)) {
      const tenantResult = await request.query(`
        SELECT 
          t.TenantId,
          t.Name as TenantName,
          COUNT(mh.HistoryId) as TotalMessages,
          SUM(CASE WHEN mh.MessageType = 'Email' THEN 1 ELSE 0 END) as EmailsSent,
          SUM(CASE WHEN mh.MessageType = 'SMS' THEN 1 ELSE 0 END) as SmsSent,
          SUM(CASE WHEN mh.Status = 'Failed' THEN 1 ELSE 0 END) as FailedCount,
          MAX(mh.SentDate) as LastActivity
        FROM oe.Tenants t
        LEFT JOIN oe.MessageHistory mh ON t.TenantId = mh.TenantId AND mh.SentDate >= @startDate AND mh.SentDate <= @endDate
        GROUP BY t.TenantId, t.Name
        HAVING COUNT(mh.HistoryId) > 0
        ORDER BY TotalMessages DESC
      `);
      
      tenantSummaries = tenantResult.recordset.map(tenant => {
        const total = parseInt(tenant.TotalMessages) || 0;
        const failed = parseInt(tenant.FailedCount) || 0;
        const failureRate = total > 0 ? Math.round((failed / total) * 100 * 100) / 100 : 0;
        
        return {
          tenantId: tenant.TenantId,
          tenantName: tenant.TenantName,
          totalMessages: total,
          emailsSent: parseInt(tenant.EmailsSent) || 0,
          smsSent: parseInt(tenant.SmsSent) || 0,
          failureRate: failureRate,
          lastActivity: tenant.LastActivity
        };
      });
    }
    
    // Format daily stats
    const dailyStats = dailyResult.recordset.map(day => ({
      date: day.date.toISOString().split('T')[0],
      sent: parseInt(day.totalSent) || 0,
      failed: parseInt(day.totalFailed) || 0
    }));
    
    const analytics = {
      totalSent,
      totalFailed,
      deliveryRate,
      byType: {
        email: emailCount,
        sms: smsCount
      },
      byStatus: {
        sent: totalSent,
        failed: totalFailed
      },
      dailyStats,
      tenantSummaries
    };
    
    res.json({
      success: true,
      data: analytics
    });
    
  } catch (error) {
    console.error('❌ Error fetching analytics:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch analytics',
      error: error.message 
    });
  }
});


// Campaign routes
const campaignRoutes = require('./campaigns');
router.use('/campaigns', campaignRoutes);

module.exports = router;