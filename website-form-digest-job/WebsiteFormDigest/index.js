/**
 * Timer — Mondays at 13:00 UTC (≈ 9am ET / 8am CT): POST /api/cron/website-form-digest
 *
 * The backend job aggregates the prior 7 days (168h) of oe.WebsiteFormSubmissions
 * per tenant and emails the per-tenant digest recipients configured in
 * AdvancedSettings.websiteForm.digestRecipients. If a tenant got 0 submissions in
 * the window but >0 in the prior week, the digest includes a "forms may be
 * broken" warning banner.
 *
 * App settings (Azure):
 *   WEBSITE_FORM_DIGEST_ENDPOINT_URL — full URL, e.g. https://api.allaboard365.com/api/cron/website-form-digest
 *   SCHEDULED_JOB_API_KEY            — must match backend env var of the same name
 */
module.exports = async function (context, myTimer) {
  const url = process.env.WEBSITE_FORM_DIGEST_ENDPOINT_URL;
  if (!url) {
    context.log.warn(
      'WEBSITE_FORM_DIGEST_ENDPOINT_URL is not configured — skipping run'
    );
    return;
  }

  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  context.log('WebsiteFormDigest POST', url);

  // 168h = 7-day window so the Monday digest covers the whole prior week.
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ windowHours: 168 }) });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep raw */ }

  if (!res.ok) {
    context.log.error(
      `website-form-digest failed HTTP ${res.status}`,
      typeof body === 'string' ? body : JSON.stringify(body)
    );
    throw new Error(
      `website-form-digest HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`
    );
  }

  context.log('website-form-digest OK', res.status, JSON.stringify(body));
};
