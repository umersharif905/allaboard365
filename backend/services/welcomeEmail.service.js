/**
 * Welcome Email Service
 * Resolves welcome email template (tenant-specific or All Tenants default),
 * substitutes variables (member, agent, tenant, group, system), and queues the email.
 */

const { getPool, sql } = require('../config/database');
const MessageQueueService = require('./messageQueue.service');
const {
  substituteVariables,
  SQL_MEMBER_EFFECTIVE_TERMINATION_DATE
} = require('./shared/variableSubstitution');

const WELCOME_EMAIL_TEMPLATE_SETTING_KEY = 'WelcomeEmailTemplateId';
const DEFAULT_WELCOME_EMAIL_TEMPLATE_KEY = 'DefaultWelcomeEmailTemplateId';

/**
 * Get the effective welcome email template ID for a tenant.
 * Resolution: tenant-specific setting first; if none, use system default (All Tenants).
 * @param {object} pool - SQL pool
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<string|null>} Template ID or null
 */
async function getEffectiveWelcomeTemplateId(pool, tenantId) {
  let effectiveTemplateId = null;

  if (tenantId) {
    const tenantResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('settingKey', sql.NVarChar(256), WELCOME_EMAIL_TEMPLATE_SETTING_KEY)
      .query(`
        SELECT SettingValue FROM oe.TenantSettings
        WHERE TenantId = @tenantId AND SettingKey = @settingKey
      `);
    if (tenantResult.recordset.length > 0 && tenantResult.recordset[0].SettingValue) {
      effectiveTemplateId = tenantResult.recordset[0].SettingValue.trim();
    }
  }

  if (!effectiveTemplateId) {
    const defaultResult = await pool.request()
      .input('settingKey', sql.NVarChar(256), DEFAULT_WELCOME_EMAIL_TEMPLATE_KEY)
      .query(`
        SELECT SettingValue FROM oe.SystemSettings WHERE SettingKey = @settingKey
      `);
    if (defaultResult.recordset.length > 0 && defaultResult.recordset[0].SettingValue) {
      effectiveTemplateId = defaultResult.recordset[0].SettingValue.trim();
    }
  }

  return effectiveTemplateId || null;
}

/**
 * Load template (Subject, Body, ReplyTo) for a template ID and tenant.
 * Template must be active, Email type, and either for this tenant or global (TenantId IS NULL).
 */
async function loadTemplate(pool, templateId, tenantId) {
  const req = pool.request();
  req.input('templateId', sql.UniqueIdentifier, templateId);
  if (tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    const result = await req.query(`
      SELECT Subject, Body, ReplyTo
      FROM oe.MessageTemplates
      WHERE TemplateId = @templateId
        AND (TenantId = @tenantId OR TenantId IS NULL)
        AND IsActive = 1 AND MessageType = 'Email'
    `);
    return result.recordset.length > 0 ? result.recordset[0] : null;
  }
  const result = await req.query(`
    SELECT Subject, Body, ReplyTo
    FROM oe.MessageTemplates
    WHERE TemplateId = @templateId AND TenantId IS NULL
      AND IsActive = 1 AND MessageType = 'Email'
  `);
  return result.recordset.length > 0 ? result.recordset[0] : null;
}

// substituteVariables is now imported from shared/variableSubstitution.js

/**
 * Load agent info by AgentId (FirstName, LastName, Email, Phone from Agents/Users).
 */
async function loadAgentContext(pool, agentId) {
  if (!agentId) return {};
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT
        ISNULL(a.FirstName, u.FirstName) AS FirstName,
        ISNULL(a.LastName, u.LastName) AS LastName,
        ISNULL(a.Email, u.Email) AS Email,
        ISNULL(a.Phone, u.PhoneNumber) AS Phone
      FROM oe.Agents a
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.AgentId = @agentId
    `);
  if (result.recordset.length === 0) return {};
  const r = result.recordset[0];
  const FirstName = r.FirstName || '';
  const LastName = r.LastName || '';
  const Name = [FirstName, LastName].filter(Boolean).join(' ').trim();
  return {
    FirstName,
    LastName,
    Name,
    Email: r.Email || '',
    Phone: r.Phone || '',
    PhoneNumber: r.Phone || ''
  };
}

/**
 * Load tenant info by TenantId.
 */
async function loadTenantContext(pool, tenantId) {
  if (!tenantId) return {};
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT Name FROM oe.Tenants WHERE TenantId = @tenantId
    `);
  if (result.recordset.length === 0) return {};
  const r = result.recordset[0];
  return { Name: r.Name || '' };
}

/**
 * Load group name by GroupId.
 */
async function loadGroupContext(pool, groupId) {
  if (!groupId) return {};
  const result = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT Name FROM oe.Groups WHERE GroupId = @groupId
    `);
  if (result.recordset.length === 0) return {};
  return { Name: result.recordset[0].Name || '' };
}

/**
 * Queue welcome email for a member after enrollment.
 * Uses tenant-specific welcome template if set; otherwise All Tenants default. If neither, no email.
 *
 * @param {object} pool - SQL pool
 * @param {object} options - { tenantId, memberId, groupId?, groupName? }
 * @returns {Promise<{ queued: boolean, messageId?: string }>}
 */
async function queueWelcomeEmailForMember(pool, options) {
  const { tenantId, memberId, groupId = null, groupName = null } = options;

  const templateId = await getEffectiveWelcomeTemplateId(pool, tenantId);
  if (!templateId) {
    return { queued: false };
  }

  const template = await loadTemplate(pool, templateId, tenantId);
  if (!template) {
    console.warn('⚠️ Welcome email template not found or inactive:', templateId);
    return { queued: false };
  }

  // Load member (primary): Email, FirstName, LastName, UserId, AgentId, GroupId
  const memberResult = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      SELECT m.MemberId, m.UserId, m.AgentId, m.GroupId,
             ${SQL_MEMBER_EFFECTIVE_TERMINATION_DATE} AS TerminationDate,
             u.FirstName, u.LastName, u.Email, u.PhoneNumber
      FROM oe.Members m
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.MemberId = @memberId
    `);
  if (memberResult.recordset.length === 0) {
    console.warn('⚠️ Welcome email: member not found:', memberId);
    return { queued: false };
  }

  const memberRow = memberResult.recordset[0];
  const memberEmail = (memberRow.Email || '').trim();
  if (!memberEmail) {
    return { queued: false };
  }

  // Deduplication: skip if an email was already queued for this recipient in the last 2 minutes.
  // Prevents duplicate welcome emails from double-submissions or network retries.
  try {
    const recentCheck = await pool.request()
      .input('recipientAddress', sql.NVarChar, memberEmail)
      .input('cutoff', sql.DateTime, new Date(Date.now() - 2 * 60 * 1000))
      .query(`
        SELECT TOP 1 MessageId
        FROM oe.MessageQueue
        WHERE RecipientAddress = @recipientAddress
          AND CreatedDate > @cutoff
      `);
    if (recentCheck.recordset.length > 0) {
      console.log('⚠️ Welcome email already queued recently for', memberEmail, '- skipping duplicate');
      return { queued: false, reason: 'duplicate' };
    }
  } catch (dedupeErr) {
    console.warn('⚠️ Welcome email dedup check failed:', dedupeErr?.message);
  }

  const member = {
    FirstName: memberRow.FirstName || '',
    LastName: memberRow.LastName || '',
    Email: memberEmail,
    Phone: memberRow.PhoneNumber || '',
    PhoneNumber: memberRow.PhoneNumber || '',
    TerminationDate: memberRow.TerminationDate ?? null
  };

  const [agent, tenant, group] = await Promise.all([
    loadAgentContext(pool, memberRow.AgentId),
    loadTenantContext(pool, tenantId),
    memberRow.GroupId ? loadGroupContext(pool, memberRow.GroupId) : Promise.resolve(groupName ? { Name: groupName } : {})
  ]);

  const system = { LoginUrl: process.env.LOGIN_URL || process.env.FRONTEND_URL || '' };
  const context = { member, agent, tenant, group, system };

  const subject = substituteVariables(template.Subject || '', context);
  const body = substituteVariables(template.Body || '', context);
  let replyTo = template.ReplyTo ? substituteVariables(template.ReplyTo, context).trim() : null;
  // Only set replyTo if it looks valid (contains @); avoid "  <>" when agent is missing
  if (replyTo && !replyTo.includes('@')) replyTo = null;

  const messageId = await MessageQueueService.queueEmail({
    tenantId,
    toEmail: memberEmail,
    toName: [member.FirstName, member.LastName].filter(Boolean).join(' ').trim(),
    subject,
    htmlContent: body,
    textContent: undefined,
    messageType: 'Email',
    createdBy: null,
    recipientId: memberRow.UserId,
    replyToEmail: replyTo || undefined,
    fromEmail: undefined,
    fromName: undefined
  });

  console.log('✅ Welcome email queued for member:', memberId, 'to', memberEmail);
  return { queued: true, messageId };
}

module.exports = {
  getEffectiveWelcomeTemplateId,
  loadTemplate,
  substituteVariables,
  loadAgentContext,
  loadTenantContext,
  loadGroupContext,
  queueWelcomeEmailForMember
};
