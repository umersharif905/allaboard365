// backend/services/email-verification-mailer.js
const MessageQueueService = require('./messageQueue.service');
const EmailTemplatesService = require('./emailTemplates.service');

const TEMPLATE_NAME = 'email-verification-code';

/**
 * Render the verification email and queue it.
 * Used by both the authenticated /me/email-verification routes and the
 * tokened post-enrollment wizard routes.
 */
async function queueVerificationEmail({ tenantId, tenantName, toEmail, toName = '', verificationCode, createdBy = null, recipientId = null }) {
  // Resolve canonical tenant name from tenant config when possible. The caller
  // passes a tenantName as a fallback in case the lookup fails or the context
  // is pre-DB (e.g. tests).
  let resolvedTenantName = tenantName || 'AllAboard365';
  try {
    if (tenantId) {
      const cfg = await EmailTemplatesService.getTenantEmailConfig(tenantId);
      if (cfg?.tenantName) resolvedTenantName = cfg.tenantName;
    }
  } catch (err) {
    // Non-fatal: fall through with caller-provided tenantName.
    console.warn('⚠️ email-verification-mailer: tenant config lookup failed, using fallback', err?.message || err);
  }

  const template = EmailTemplatesService.loadTemplate(TEMPLATE_NAME);
  const html = EmailTemplatesService.processTemplate(template, {
    tenantName: resolvedTenantName,
    verificationCode,
    year: new Date().getFullYear().toString()
  });

  return MessageQueueService.queueEmail({
    tenantId,
    toEmail,
    toName,
    subject: `Verify Your Email - ${resolvedTenantName}`,
    htmlContent: html,
    messageType: 'Email',
    createdBy,
    recipientId
  });
}

module.exports = { queueVerificationEmail };
