/**
 * Daily timer (08:00 UTC) — POSTs product API daily + billing audit daily jobs.
 *
 * App settings (Azure):
 *   PRODUCT_API_DAILY_ENDPOINT_URL — full URL, e.g. https://host/api/scheduled-jobs/product-api-daily
 *   BILLING_AUDIT_DAILY_ENDPOINT_URL — full URL, e.g. https://host/api/scheduled-jobs/billing-audit-daily
 *   SCHEDULED_JOB_API_KEY — optional; must match backend SCHEDULED_JOB_API_KEY when set
 */
module.exports = async function (context, myTimer) {
  const productApiDailyUrl = process.env.PRODUCT_API_DAILY_ENDPOINT_URL;
  const billingAuditUrl = process.env.BILLING_AUDIT_DAILY_ENDPOINT_URL;
  if (!productApiDailyUrl || !billingAuditUrl) {
    context.log.error('PRODUCT_API_DAILY_ENDPOINT_URL and BILLING_AUDIT_DAILY_ENDPOINT_URL must both be set');
    throw new Error('PRODUCT_API_DAILY_ENDPOINT_URL and BILLING_AUDIT_DAILY_ENDPOINT_URL must both be set');
  }

  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  async function post(name, url) {
    context.log(`${name} POST`, url);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: '{}'
    });

    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw */
    }

    if (!res.ok) {
      context.log.error(`${name} endpoint failed`, res.status, body);
      throw new Error(`HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    }

    context.log(`${name} OK`, res.status, body);
    return body;
  }

  await post('product-api-daily', productApiDailyUrl);
  await post('billing-audit-daily', billingAuditUrl);
};
