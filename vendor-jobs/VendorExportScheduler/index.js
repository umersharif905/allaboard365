/**
 * Timer trigger — fires every 5 minutes (UTC), aligned with backend LastRunAt cooldown.
 * POSTs to the AllAboard API so due jobs in oe.VendorScheduledJobs + legacy schedules run.
 *
 * App settings (Azure):
 *   VENDOR_EXPORT_ENDPOINT_URL — full URL, e.g. https://host/api/scheduled-jobs/vendor-exports
 *   SCHEDULED_JOB_API_KEY — optional; must match backend SCHEDULED_JOB_API_KEY when set
 * (SendGrid/DB keys are not used here — only the backend / message center that actually send mail need those.)
 */
module.exports = async function (context, myTimer) {
  const url = process.env.VENDOR_EXPORT_ENDPOINT_URL;
  if (!url) {
    context.log.error('VENDOR_EXPORT_ENDPOINT_URL is not set');
    throw new Error('VENDOR_EXPORT_ENDPOINT_URL is not set');
  }

  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  const headers = {};
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  context.log('VendorExportScheduler POST', url);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: '{}',
  });

  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }

  if (!res.ok) {
    context.log.error('Vendor export endpoint failed', res.status, body);
    throw new Error(`HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  context.log('VendorExportScheduler OK', res.status, body);
};
