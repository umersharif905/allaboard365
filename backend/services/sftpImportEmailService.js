'use strict';

const sendGridEmailService = require('./sendGridEmailService');

const FROM_ADDRESS =
  process.env.SFTP_IMPORT_REPORT_FROM ||
  process.env.BILLING_AUDIT_DAILY_REPORT_FROM ||
  'noreply@allaboard365.com';

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function statusLabel(status) {
  switch (status) {
    case 'success':  return '✅ Success';
    case 'partial':  return '⚠️ Partial';
    case 'failed':   return '❌ Failed';
    case 'no-files': return '📭 No Files';
    case 'skipped':  return '⏭ Skipped';
    default:         return esc(status);
  }
}

function buildSubject(jobName, status) {
  const labels = {
    success:  'Success',
    partial:  'Partial Failure',
    failed:   'Failed',
    'no-files': 'No Files Found',
    skipped:  'Skipped',
  };
  return `[SFTP Import] ${esc(jobName)}: ${labels[status] || status}`;
}

function buildHtml({ jobId, jobName, tenantId, runId, status, counts, errors }) {
  const countsHtml = `
    <table style="border-collapse:collapse;font-family:monospace;font-size:13px;">
      <tr><td style="padding:2px 12px 2px 0">Files Found</td><td><strong>${counts.filesFound}</strong></td></tr>
      <tr><td style="padding:2px 12px 2px 0">Files Imported</td><td><strong>${counts.filesImported}</strong></td></tr>
      <tr><td style="padding:2px 12px 2px 0">Files Failed</td><td><strong>${counts.filesFailed}</strong></td></tr>
      <tr><td style="padding:2px 12px 2px 0">Households Created</td><td><strong>${counts.householdsCreated}</strong></td></tr>
      <tr><td style="padding:2px 12px 2px 0">Households Updated</td><td><strong>${counts.householdsUpdated}</strong></td></tr>
      <tr><td style="padding:2px 12px 2px 0">Households Terminated</td><td><strong>${counts.householdsTerminated}</strong></td></tr>
      <tr><td style="padding:2px 12px 2px 0">Households Skipped</td><td><strong>${counts.householdsSkipped}</strong></td></tr>
    </table>`;

  const errorsHtml = errors && errors.length
    ? `<h3 style="color:#c00">Errors</h3><ul>${errors.slice(0, 20).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    : '';

  return `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#333">
  <h2>SFTP Import Report — ${statusLabel(status)}</h2>
  <table style="font-size:13px;margin-bottom:16px">
    <tr><td style="padding:2px 12px 2px 0;color:#666">Job</td><td><strong>${esc(jobName)}</strong></td></tr>
    <tr><td style="padding:2px 12px 2px 0;color:#666">Job ID</td><td>${esc(jobId)}</td></tr>
    <tr><td style="padding:2px 12px 2px 0;color:#666">Tenant ID</td><td>${esc(tenantId)}</td></tr>
    <tr><td style="padding:2px 12px 2px 0;color:#666">Run ID</td><td>${esc(runId)}</td></tr>
    <tr><td style="padding:2px 12px 2px 0;color:#666">Run Time</td><td>${new Date().toISOString()} UTC</td></tr>
  </table>
  <h3>Import Summary</h3>
  ${countsHtml}
  ${errorsHtml}
  <hr style="margin-top:24px"/>
  <p style="font-size:11px;color:#999">AllAboard365 automated SFTP import notification</p>
</body>
</html>`;
}

/**
 * Send a run completion report to configured recipients.
 * SendGrid failures are caught and logged — they do not affect run status.
 *
 * @param {{ to, jobId, jobName, tenantId, runId, status, counts, errors }} opts
 */
async function sendRunReport({ to, jobId, jobName, tenantId, runId, status, counts, errors }) {
  if (!to || !to.length) return;

  const html = buildHtml({ jobId, jobName, tenantId, runId, status, counts, errors });
  const subject = buildSubject(jobName, status);

  try {
    await sendGridEmailService.sendEmail({
      to: Array.isArray(to) ? to : [to],
      from: FROM_ADDRESS,
      subject,
      html,
      text: subject,
    });
  } catch (err) {
    console.error('[sftpImportEmailService] SendGrid failed:', err.message);
  }
}

module.exports = { sendRunReport };
