// backend/services/groupTypeChangeRequestService.js
const db = require('../config/database');
const MessageQueueService = require('./messageQueue.service');
const EmailTemplatesService = require('./emailTemplates.service');
const { buildTenantAppBaseUrl } = require('../utils/tenantAppUrl');

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || '00000000-0000-0000-0000-000000000000';

/**
 * Pull the columns we need for tenant-aware URL building. Returns null when the
 * tenant isn't found (caller should not crash — it just falls back to defaults).
 */
async function loadTenantForUrl(pool, tenantId) {
  const r = await pool.request()
    .input('TenantId', tenantId)
    .query(`
      SELECT TenantId, Name, CustomDomain, DefaultUrlPath, IsDefaultUrlPathVerified, AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);
  return r.recordset[0] || null;
}

/**
 * Resolve the agent's email + first name + group name for a given GroupId.
 * Approve / deny / auto-approve emails go ONLY to the agent (no group-admin
 * recipients, no carbon-copies). Returns null if the agent has no email or the
 * group has no agent assigned, in which case the caller silently skips sending.
 */
async function resolveAgentRecipientForGroup(pool, groupId) {
  const r = await pool.request()
    .input('GroupId', groupId)
    .query(`
      SELECT
        g.Name        AS GroupName,
        g.GroupType   AS GroupType,
        u.Email       AS AgentEmail,
        u.FirstName   AS AgentFirstName,
        u.LastName    AS AgentLastName
      FROM oe.Groups g
      LEFT JOIN oe.Agents a ON a.AgentId = g.AgentId
      LEFT JOIN oe.Users  u ON u.UserId  = a.UserId
      WHERE g.GroupId = @GroupId
    `);
  if (!r.recordset.length) return null;
  const row = r.recordset[0];
  if (!row.AgentEmail) return null;
  return {
    groupName: row.GroupName,
    agentEmail: row.AgentEmail,
    agentFirstName: row.AgentFirstName || 'Agent',
    agentLastName: row.AgentLastName || ''
  };
}

/**
 * Resolve the recipient list for the "submitted" notification.
 *
 * Source of truth: addresses manually entered in tenant settings under
 *   AdvancedSettings.enrollment.belowMinimumAlertRecipients
 *
 * No role-based auto-resolution — TenantAdmin role users are NOT auto-added.
 * If the tenant wants admins to be notified, those addresses must be entered
 * explicitly in the settings field.
 *
 * Returns an array of { email, firstName } (firstName is always null since
 * we have no user record to look up).
 */
async function resolveTenantAdminRecipients(pool, tenantId) {
  const recipients = [];
  const seen = new Set();
  const push = (email) => {
    if (!email) return;
    const key = String(email).trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    recipients.push({ email: String(email).trim(), firstName: null });
  };

  const tenantRow = await pool.request()
    .input('TenantId', tenantId)
    .query(`SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId`);
  try {
    const extra = JSON.parse(tenantRow.recordset[0]?.AdvancedSettings || '{}')
      ?.enrollment?.belowMinimumAlertRecipients;
    if (Array.isArray(extra)) {
      for (const addr of extra) {
        if (typeof addr === 'string' && addr.trim()) push(addr.trim());
      }
    }
  } catch {
    // malformed AdvancedSettings JSON — no recipients
  }

  return recipients;
}

async function lookupRequesterName(pool, userId) {
  if (!userId) return 'an agent';
  const r = await pool.request()
    .input('UserId', userId)
    .query(`SELECT FirstName, LastName FROM oe.Users WHERE UserId = @UserId`);
  if (!r.recordset.length) return 'an agent';
  return `${r.recordset[0].FirstName || ''} ${r.recordset[0].LastName || ''}`.trim() || 'an agent';
}

function buildGroupUrl(tenant, groupId) {
  return `${buildTenantAppBaseUrl(tenant)}/groups/${groupId}`;
}

function buildWizardUrl(tenant, groupId) {
  return `${buildGroupUrl(tenant, groupId)}/type-change/wizard`;
}

function buildReviewUrl(tenant) {
  return `${buildTenantAppBaseUrl(tenant)}/tenant-admin/group-type-change-requests`;
}

/**
 * Queue the post-approval email to the agent only.
 * Auto-approve and reviewer-approve flows both call this.
 */
async function queueApprovedEmail({ pool, tenant, tenantId, groupId, currentType, requestedType, autoApproved, reviewerName }) {
  const recipient = await resolveAgentRecipientForGroup(pool, groupId);
  if (!recipient) return;
  const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);
  const templateContent = EmailTemplatesService.loadTemplate('group-type-change-approved');
  const htmlContent = EmailTemplatesService.processTemplate(templateContent, {
    tenantName: tenantConfig.tenantName || '',
    agentFirstName: recipient.agentFirstName,
    groupName: recipient.groupName,
    currentType,
    requestedType,
    autoApproved: autoApproved ? 'true' : '',
    reviewerName: reviewerName || '',
    wizardUrl: buildWizardUrl(tenant, groupId)
  });
  await MessageQueueService.queueEmail({
    tenantId,
    toEmail: recipient.agentEmail,
    toName: recipient.agentFirstName,
    subject: `Approved: ${recipient.groupName} group type change`,
    htmlContent,
    messageType: 'Email'
  });
}

/**
 * Queue the denial email to the agent only.
 */
async function queueDeniedEmail({ pool, tenant, tenantId, groupId, currentType, requestedType, reviewerName, reviewNotes }) {
  const recipient = await resolveAgentRecipientForGroup(pool, groupId);
  if (!recipient) return;
  const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);
  const templateContent = EmailTemplatesService.loadTemplate('group-type-change-denied');
  const htmlContent = EmailTemplatesService.processTemplate(templateContent, {
    tenantName: tenantConfig.tenantName || '',
    agentFirstName: recipient.agentFirstName,
    groupName: recipient.groupName,
    currentType,
    requestedType,
    reviewerName: reviewerName || 'TenantAdmin',
    reviewNotes: reviewNotes || '',
    groupUrl: buildGroupUrl(tenant, groupId)
  });
  await MessageQueueService.queueEmail({
    tenantId,
    toEmail: recipient.agentEmail,
    toName: recipient.agentFirstName,
    subject: `Denied: ${recipient.groupName} group type change`,
    htmlContent,
    messageType: 'Email'
  });
}

/**
 * Queue the "submitted" notification to every TenantAdmin user for the tenant
 * plus any addresses in the tenant's belowMinimumAlertRecipients setting.
 * One MessageQueue row per recipient (no cc/bcc).
 *
 * Only fires for the Pending path; the auto-approve path skips this because
 * there's no review to do.
 */
async function queueSubmittedEmail({ pool, tenant, tenantId, groupId, currentType, requestedType, requesterName, reason }) {
  const recipients = await resolveTenantAdminRecipients(pool, tenantId);
  if (!recipients.length) return;
  const groupRow = await pool.request()
    .input('GroupId', groupId)
    .query(`SELECT Name FROM oe.Groups WHERE GroupId = @GroupId`);
  const groupName = groupRow.recordset[0]?.Name || '';
  const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);
  const templateContent = EmailTemplatesService.loadTemplate('group-type-change-submitted');

  const reviewUrl = buildReviewUrl(tenant);
  const subject = `New request: ${groupName} group type change`;

  for (const recipient of recipients) {
    const htmlContent = EmailTemplatesService.processTemplate(templateContent, {
      tenantName: tenantConfig.tenantName || '',
      requesterName: requesterName || 'an agent',
      groupName,
      currentType,
      requestedType,
      reason: reason || '(no reason provided)',
      reviewUrl
    });
    await MessageQueueService.queueEmail({
      tenantId,
      toEmail: recipient.email,
      toName: recipient.firstName,
      subject,
      htmlContent,
      messageType: 'Email'
    });
  }
}

async function lookupReviewerName(pool, reviewerId) {
  if (!reviewerId) return 'TenantAdmin';
  const r = await pool.request()
    .input('UserId', reviewerId)
    .query(`SELECT FirstName, LastName FROM oe.Users WHERE UserId = @UserId`);
  if (!r.recordset.length) return 'TenantAdmin';
  return `${r.recordset[0].FirstName || ''} ${r.recordset[0].LastName || ''}`.trim() || 'TenantAdmin';
}

async function getTenantAutoApprove(pool, tenantId) {
  const r = await pool.request()
    .input('TenantId', tenantId)
    .query(`SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId`);
  if (!r.recordset.length) return false;
  try {
    const settings = JSON.parse(r.recordset[0].AdvancedSettings || '{}');
    return Boolean(settings?.enrollment?.autoApproveGroupTypeChanges);
  } catch {
    return false;
  }
}

async function createRequest({ groupId, tenantId, requestedBy, requestedType, reason }) {
  if (!['Standard', 'ListBill'].includes(requestedType)) {
    throw Object.assign(new Error('Invalid requestedType'), { status: 400 });
  }
  const pool = await db.getPool();

  const group = await pool.request()
    .input('GroupId', groupId)
    .input('TenantId', tenantId)
    .query(`SELECT GroupType FROM oe.Groups WHERE GroupId = @GroupId AND TenantId = @TenantId`);
  if (!group.recordset.length) throw Object.assign(new Error('Group not found'), { status: 404 });

  const currentType = group.recordset[0].GroupType;
  if (currentType === requestedType) {
    throw Object.assign(new Error('Requested type equals current type'), { status: 400 });
  }

  const pending = await pool.request()
    .input('GroupId', groupId)
    .query(`SELECT RequestId FROM oe.GroupTypeChangeRequests WHERE GroupId = @GroupId AND Status = 'Pending'`);
  if (pending.recordset.length) {
    throw Object.assign(new Error('A pending request already exists for this group'), { status: 409 });
  }

  const autoApprove = await getTenantAutoApprove(pool, tenantId);
  const status = autoApprove ? 'Approved' : 'Pending';

  const insertReq = pool.request()
    .input('GroupId', groupId)
    .input('TenantId', tenantId)
    .input('RequestedBy', requestedBy)
    .input('CurrentType', currentType)
    .input('RequestedType', requestedType)
    .input('Status', status)
    .input('Reason', reason || null)
    .input('ReviewedBy', autoApprove ? SYSTEM_USER_ID : null)
    .input('ReviewedAt', autoApprove ? new Date() : null)
    .input('ReviewNotes', autoApprove ? 'Auto-approved per tenant setting' : null);

  const result = await insertReq.query(`
    INSERT INTO oe.GroupTypeChangeRequests
      (GroupId, TenantId, RequestedBy, CurrentType, RequestedType, Status, Reason, ReviewedBy, ReviewedAt, ReviewNotes)
    OUTPUT INSERTED.*
    VALUES
      (@GroupId, @TenantId, @RequestedBy, @CurrentType, @RequestedType, @Status, @Reason, @ReviewedBy, @ReviewedAt, @ReviewNotes)
  `);

  // Note: GroupType is NOT flipped at approval (or auto-approval) time.
  // It flips when the agent runs the conversion wizard's apply step,
  // so the group never sits in a half-state where products / enrollments
  // are out of sync with the new type.

  const tenant = await loadTenantForUrl(pool, tenantId);

  if (autoApprove) {
    // Notify the agent (and only the agent) so they can run the wizard.
    try {
      await queueApprovedEmail({
        pool,
        tenant,
        tenantId,
        groupId,
        currentType,
        requestedType,
        autoApproved: true,
        reviewerName: ''
      });
    } catch (err) {
      console.warn('[groupTypeChangeRequestService] Failed to queue auto-approved email:', err?.message || err);
    }
  } else {
    // Notify TenantAdmins so they can review the pending request.
    try {
      const requesterName = await lookupRequesterName(pool, requestedBy);
      await queueSubmittedEmail({
        pool,
        tenant,
        tenantId,
        groupId,
        currentType,
        requestedType,
        requesterName,
        reason
      });
    } catch (err) {
      console.warn('[groupTypeChangeRequestService] Failed to queue submitted email:', err?.message || err);
    }
  }

  return result.recordset[0];
}

async function approveRequest({ requestId, tenantId, reviewerId, notes }) {
  const pool = await db.getPool();
  const existing = await pool.request()
    .input('RequestId', requestId)
    .input('TenantId', tenantId)
    .query(`SELECT * FROM oe.GroupTypeChangeRequests WHERE RequestId = @RequestId AND TenantId = @TenantId`);
  if (!existing.recordset.length) throw Object.assign(new Error('Request not found'), { status: 404 });
  const row = existing.recordset[0];
  if (row.Status !== 'Pending') throw Object.assign(new Error('Request is not pending'), { status: 409 });

  await pool.request()
    .input('RequestId', requestId)
    .input('ReviewerId', reviewerId)
    .input('Notes', notes || null)
    .query(`
      UPDATE oe.GroupTypeChangeRequests
      SET Status = 'Approved', ReviewedBy = @ReviewerId, ReviewedAt = SYSUTCDATETIME(),
          ReviewNotes = @Notes, ModifiedDate = SYSUTCDATETIME()
      WHERE RequestId = @RequestId
    `);

  // GroupType flip happens inside the conversion-wizard apply step, not here.
  // The group keeps its current type until products / enrollments are rewired.

  // Email the agent (only the agent) that the request was approved.
  try {
    const reviewerName = await lookupReviewerName(pool, reviewerId);
    const tenant = await loadTenantForUrl(pool, tenantId);
    await queueApprovedEmail({
      pool,
      tenant,
      tenantId,
      groupId: row.GroupId,
      currentType: row.CurrentType,
      requestedType: row.RequestedType,
      autoApproved: false,
      reviewerName
    });
  } catch (err) {
    console.warn('[groupTypeChangeRequestService] Failed to queue approved email:', err?.message || err);
  }

  return { ...row, Status: 'Approved', ReviewedBy: reviewerId, ReviewNotes: notes };
}

async function denyRequest({ requestId, tenantId, reviewerId, notes }) {
  if (!notes) throw Object.assign(new Error('Denial notes are required'), { status: 400 });
  const pool = await db.getPool();

  // Look up the row before updating so we can email the agent with full
  // context (CurrentType, RequestedType, GroupId).
  const existingRow = await pool.request()
    .input('RequestId', requestId)
    .input('TenantId', tenantId)
    .query(`
      SELECT GroupId, CurrentType, RequestedType
      FROM oe.GroupTypeChangeRequests
      WHERE RequestId = @RequestId AND TenantId = @TenantId AND Status = 'Pending'
    `);

  await pool.request()
    .input('RequestId', requestId)
    .input('TenantId', tenantId)
    .input('ReviewerId', reviewerId)
    .input('Notes', notes)
    .query(`
      UPDATE oe.GroupTypeChangeRequests
      SET Status = 'Denied', ReviewedBy = @ReviewerId, ReviewedAt = SYSUTCDATETIME(),
          ReviewNotes = @Notes, ModifiedDate = SYSUTCDATETIME()
      WHERE RequestId = @RequestId AND TenantId = @TenantId AND Status = 'Pending'
    `);

  // Email the agent (only the agent) that the request was denied.
  if (existingRow.recordset.length) {
    try {
      const reviewerName = await lookupReviewerName(pool, reviewerId);
      const tenant = await loadTenantForUrl(pool, tenantId);
      await queueDeniedEmail({
        pool,
        tenant,
        tenantId,
        groupId: existingRow.recordset[0].GroupId,
        currentType: existingRow.recordset[0].CurrentType,
        requestedType: existingRow.recordset[0].RequestedType,
        reviewerName,
        reviewNotes: notes
      });
    } catch (err) {
      console.warn('[groupTypeChangeRequestService] Failed to queue denied email:', err?.message || err);
    }
  }

  return { requestId, status: 'Denied' };
}

async function listRequests({ tenantId, status, groupId, includeAllTenants = false }) {
  const pool = await db.getPool();
  const req = pool.request();
  let sql = `
    SELECT r.*,
           g.Name AS GroupName,
           u.FirstName + ' ' + u.LastName AS RequestedByName,
           t.Name AS TenantName
    FROM oe.GroupTypeChangeRequests r
    LEFT JOIN oe.Groups   g ON g.GroupId  = r.GroupId
    LEFT JOIN oe.Users    u ON u.UserId   = r.RequestedBy
    LEFT JOIN oe.Tenants  t ON t.TenantId = r.TenantId
    WHERE 1=1`;
  if (!includeAllTenants) {
    req.input('TenantId', tenantId);
    sql += ' AND r.TenantId = @TenantId';
  }
  if (status)  { req.input('Status', status);   sql += ' AND r.Status = @Status'; }
  if (groupId) { req.input('GroupId', groupId); sql += ' AND r.GroupId = @GroupId'; }
  sql += ' ORDER BY r.CreatedDate DESC';
  const r = await req.query(sql);
  return r.recordset;
}

module.exports = { createRequest, approveRequest, denyRequest, listRequests };
