const MessageQueueService = require('./messageQueue.service');
const { publishBugReport: publishBugReportWebhook } = require('./bugReportWebhookService');

const SYSADMIN_EMAIL = 'sysadmin@allaboard365.com';
const IMPROVE_EMAIL = 'improve@allaboard365.com';

/**
 * Bug report API service: webhook, confirmation email, SysAdmin copy, and improve@ notification.
 * Each action is in its own function so you can comment in/out for testing.
 */

/**
 * 0. Publish bug report or feature request to external webhook (e.g. Cursor Automations).
 * Non-blocking: logs and continues if webhook is not configured or fails.
 * @param {Object} opts
 * @param {string} [opts.type] 'bug' | 'feature'
 * @param {string} opts.submitterEmail
 * @param {string} [opts.submitterName]
 * @param {string} opts.description
 * @param {string} [opts.tenantId]
 * @param {string} [opts.createdBy]
 * @returns {Promise<Object|undefined>} Webhook response or undefined on skip/failure
 */
async function publishToWebhook({
  type = 'bug',
  submitterEmail,
  submitterName,
  description,
  tenantId,
  createdBy,
  posthogSessionUrl,
}) {
  try {
    const label = type === 'feature' ? 'Feature request' : 'Bug report';
    const replayNote = posthogSessionUrl ? ' [PostHog replay attached]' : '';
    const context = `${label} from ${submitterEmail}${submitterName ? ` (${submitterName})` : ''}: ${(description || '').slice(0, 200)}${replayNote}`;
    const payload = {
      type: type || 'bug',
      submitterEmail,
      submitterName: submitterName || null,
      description: description || '',
      tenantId: tenantId || null,
      createdBy: createdBy || null,
      source: 'bug-report-fab',
      ...(posthogSessionUrl ? { posthogSessionUrl } : {}),
    };
    return await publishBugReportWebhook({ context, payload });
  } catch (err) {
    console.warn('[bugReport.service] Webhook skipped or failed:', err.message);
    return undefined;
  }
}

/**
 * 1. Send confirmation email to the submitter (MessageQueue).
 * @param {Object} opts
 * @param {string} [opts.type] 'bug' | 'feature'
 * @param {string} opts.submitterEmail
 * @param {string} [opts.submitterName]
 * @param {string} opts.description
 * @param {string} [opts.tenantId]
 * @param {string} [opts.createdBy]
 * @returns {Promise<string>} Message ID
 */
async function sendConfirmationToSubmitter({ type = 'bug', submitterEmail, submitterName, description, tenantId, createdBy }) {
  const isFeature = type === 'feature';
  const subject = isFeature ? 'Feature request received' : 'Bug report received';
  const label = isFeature ? 'feature request' : 'bug report';
  const intro = isFeature ? 'We received your feature request and will consider it.' : 'We received your bug report and will look into it.';
  const htmlContent = `
    <p>${intro}</p>
    <p><strong>Your ${label}:</strong></p>
    <p>${escapeHtml(description || '(no description)')}</p>
    <p>Thank you,<br/>All Aboard 365</p>
  `;
  const textContent = `${intro}\n\nYour ${label}:\n${description || '(no description)'}\n\nThank you,\nAll Aboard 365`;

  return MessageQueueService.queueEmail({
    tenantId: tenantId || null,
    toEmail: submitterEmail,
    toName: submitterName || null,
    subject,
    htmlContent,
    textContent,
    createdBy: createdBy || null,
    recipientId: createdBy || null
  });
}

/**
 * 2. Queue a copy to SysAdmin (visible in Message Queue).
 * @param {Object} opts
 * @param {string} [opts.type] 'bug' | 'feature'
 * @param {string} opts.description
 * @param {string} opts.submitterEmail
 * @param {string} [opts.tenantId]
 * @param {string} [opts.createdBy]
 * @returns {Promise<string>} Message ID
 */
async function queueCopyToSysAdmin({ type = 'bug', description, submitterEmail, tenantId, createdBy }) {
  const prefix = type === 'feature' ? '[Feature Request]' : '[Bug Report]';
  const label = type === 'feature' ? 'Feature request' : 'Bug report';
  const subject = `${prefix} From ${submitterEmail}`;
  const htmlContent = `
    <p><strong>${label} (for SysAdmin visibility in Message Queue)</strong></p>
    <p><strong>From:</strong> ${escapeHtml(submitterEmail)}</p>
    <p><strong>Description:</strong></p>
    <p>${escapeHtml(description || '(no description)')}</p>
  `;
  const textContent = `${label} from ${submitterEmail}\n\n${description || '(no description)'}`;

  return MessageQueueService.queueEmail({
    tenantId: tenantId || null,
    toEmail: SYSADMIN_EMAIL,
    toName: 'SysAdmin',
    subject,
    htmlContent,
    textContent,
    createdBy: createdBy || null,
    recipientId: null
  });
}

/**
 * 3. Send email notification to improve@allaboard365.com.
 * @param {Object} opts
 * @param {string} [opts.type] 'bug' | 'feature'
 * @param {string} opts.description
 * @param {string} opts.submitterEmail
 * @param {string} [opts.tenantId]
 * @param {string} [opts.createdBy]
 * @returns {Promise<string>} Message ID
 */
async function notifyImprove({ type = 'bug', description, submitterEmail, tenantId, createdBy }) {
  const label = type === 'feature' ? 'feature request' : 'bug report';
  const subject = `New ${label} from ${submitterEmail}`;
  const htmlContent = `
    <p><strong>New ${label}</strong></p>
    <p><strong>From:</strong> ${escapeHtml(submitterEmail)}</p>
    <p><strong>Description:</strong></p>
    <p>${escapeHtml(description || '(no description)')}</p>
  `;
  const textContent = `New ${label} from ${submitterEmail}\n\n${description || '(no description)'}`;

  return MessageQueueService.queueEmail({
    tenantId: tenantId || null,
    toEmail: IMPROVE_EMAIL,
    toName: 'Improve',
    subject,
    htmlContent,
    textContent,
    createdBy: createdBy || null,
    recipientId: null
  });
}

/**
 * Orchestrator: run all three actions. Comment out any call below to disable that action while testing.
 * @param {Object} opts
 * @param {string} [opts.type] 'bug' | 'feature'
 * @param {string} opts.submitterEmail
 * @param {string} [opts.submitterName]
 * @param {string} opts.description
 * @param {string} [opts.tenantId]
 * @param {string} [opts.createdBy]
 * @returns {Promise<{ confirmationId?: string, sysAdminId?: string, improveId?: string }>}
 */
async function submitBugReport({
  type = 'bug',
  submitterEmail,
  submitterName,
  description,
  tenantId,
  createdBy,
  posthogSessionUrl,
}) {
  const result = {};
  const opts = {
    type,
    submitterEmail,
    submitterName,
    description,
    tenantId,
    createdBy,
    posthogSessionUrl,
  };

  // 0. Publish to webhook (comment out next 5 lines to disable while testing)
  result.webhook = await publishToWebhook(opts);

  // 1. Confirmation to submitter (comment out next 6 lines to disable while testing)
  result.confirmationId = await sendConfirmationToSubmitter(opts);

  // 2. Copy to SysAdmin – visible in Message Queue (comment out next 6 lines to disable while testing)
  result.sysAdminId = await queueCopyToSysAdmin(opts);

  // 3. Notify improve@ (comment out next 6 lines to disable while testing)
  result.improveId = await notifyImprove(opts);

  return result;
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  publishToWebhook,
  sendConfirmationToSubmitter,
  queueCopyToSysAdmin,
  notifyImprove,
  submitBugReport
};
