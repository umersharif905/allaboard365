/**
 * Timer — daily 04:15 UTC (after enrollment-nightly-job): billing + optional vendor minimum check.
 *
 * Unified (recommended): set BILLING_NIGHTLY_ENDPOINT_URL → POST …/billing-nightly
 * (DIME reconcile + individual invoice nightly + billing audit daily).
 *
 * Legacy: omit BILLING_NIGHTLY; set BILLING_AUDIT_DAILY_ENDPOINT_URL (required),
 * optionally INVOICE_NIGHTLY_ENDPOINT_URL. No scheduled DIME reconcile on that path.
 *
 * Optional: BELOW_MINIMUM_CHECK_ENDPOINT_URL (same host as other scheduled jobs).
 * SCHEDULED_JOB_API_KEY — optional; must match backend when set.
 *
 * Enrollment runs from enrollment-nightly-job (04:00 UTC).
 */
module.exports = async function (context, myTimer) {
  const billingNightlyUrl = process.env.BILLING_NIGHTLY_ENDPOINT_URL;

  if (billingNightlyUrl) {
    context.log.info(
      'BillingNightly: unified — POST billing-nightly (DIME reconcile, invoice nightly, billing audit). Legacy billing URLs ignored.'
    );
  } else {
    context.log.warn(
      'BillingNightly: legacy — billing-audit-daily + optional invoice-nightly. Set BILLING_NIGHTLY_ENDPOINT_URL for unified job + DIME.'
    );
  }

  const urls = [];

  if (billingNightlyUrl) {
    urls.push({ name: 'billing-nightly', url: billingNightlyUrl, required: true });
  } else {
    urls.push({
      name: 'billing-audit-daily',
      url: process.env.BILLING_AUDIT_DAILY_ENDPOINT_URL,
      required: true
    });
    urls.push({
      name: 'invoice-nightly-run',
      url: process.env.INVOICE_NIGHTLY_ENDPOINT_URL,
      required: false
    });
  }

  urls.push({
    name: 'below-minimum-check',
    url: process.env.BELOW_MINIMUM_CHECK_ENDPOINT_URL,
    required: false
  });

  const missingRequired = urls.filter((u) => u.required && !u.url).map((u) => u.name);
  if (missingRequired.length) {
    const msg = `BillingNightly required endpoint URLs missing: ${missingRequired.join(', ')}`;
    context.log.error(msg);
    throw new Error(msg);
  }

  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  async function post(name, url) {
    context.log(`BillingNightly POST ${name}`, url);
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
      const errDetail = typeof body === 'string' ? body : JSON.stringify(body);
      context.log.error(
        `SCHEDULED_JOB_FAILURE endpoint=${name} status=${res.status} url=${url} body=${errDetail}`
      );
      throw new Error(`${name} HTTP ${res.status}: ${errDetail}`);
    }
    context.log(`${name} OK`, res.status, body);
    return body;
  }

  for (const endpoint of urls.filter((u) => u.required && u.url)) {
    await post(endpoint.name, endpoint.url);
  }

  for (const endpoint of urls.filter((u) => !u.required && u.url)) {
    try {
      await post(endpoint.name, endpoint.url);
    } catch (err) {
      context.log.error(`${endpoint.name} failed (non-fatal):`, err?.message || err);
    }
  }
};
