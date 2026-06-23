/**
 * Timer — daily 04:00 UTC: enrollment maintenance only.
 *   ENROLLMENT_TERMINATION_ENDPOINT_URL — POST …/enrollment-termination-sync
 *   ENROLLMENT_CLEANUP_ENDPOINT_URL — POST …/enrollment-cleanup
 *   SCHEDULED_JOB_API_KEY — optional; must match backend when set
 *
 * Billing runs from billing-nightly-job (04:15 UTC).
 */
module.exports = async function (context, myTimer) {
  context.log.info('EnrollmentNightly: enrollment termination + PaymentHold cleanup only.');

  const urls = [
    { name: 'enrollment-termination-sync', url: process.env.ENROLLMENT_TERMINATION_ENDPOINT_URL, required: true },
    { name: 'enrollment-cleanup', url: process.env.ENROLLMENT_CLEANUP_ENDPOINT_URL, required: true }
  ];

  const missingRequired = urls.filter((u) => u.required && !u.url).map((u) => u.name);
  if (missingRequired.length) {
    const msg = `EnrollmentNightly required endpoint URLs missing: ${missingRequired.join(', ')}`;
    context.log.error(msg);
    throw new Error(msg);
  }

  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  async function post(name, url) {
    context.log(`EnrollmentNightly POST ${name}`, url);
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
      context.log.error(`${name} failed`, res.status, body);
      throw new Error(
        `${name} HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`
      );
    }
    context.log(`${name} OK`, res.status, body);
    return body;
  }

  for (const endpoint of urls.filter((u) => u.required && u.url)) {
    await post(endpoint.name, endpoint.url);
  }
};
