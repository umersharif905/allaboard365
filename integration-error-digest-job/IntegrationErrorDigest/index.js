/**
 * Timer — every 15 min: POST /api/scheduled-jobs/integration-error-digest
 *
 * The backend job scans oe.SystemIntegrationErrors for un-notified high/critical rows,
 * emails the configured recipient list, and stamps NotificationSentAt so the same
 * row never gets emailed twice. Known user-resolvable errors (bank declines, validation
 * failures) are recorded as Priority='normal' elsewhere and never trigger email.
 *
 * App settings (Azure):
 *   INTEGRATION_ERROR_DIGEST_ENDPOINT_URL — full URL, e.g. https://host/api/scheduled-jobs/integration-error-digest
 *   SCHEDULED_JOB_API_KEY — optional; must match backend SCHEDULED_JOB_API_KEY when set
 */
module.exports = async function (context, myTimer) {
  const url = process.env.INTEGRATION_ERROR_DIGEST_ENDPOINT_URL;
  if (!url) {
    context.log.warn(
      'INTEGRATION_ERROR_DIGEST_ENDPOINT_URL is not configured — skipping run'
    );
    return;
  }

  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  context.log('IntegrationErrorDigest POST', url);

  const res = await fetch(url, { method: 'POST', headers, body: '{}' });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep raw */ }

  if (!res.ok) {
    context.log.error(
      `integration-error-digest failed HTTP ${res.status}`,
      typeof body === 'string' ? body : JSON.stringify(body)
    );
    throw new Error(
      `integration-error-digest HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`
    );
  }

  context.log('integration-error-digest OK', res.status, body);
};
