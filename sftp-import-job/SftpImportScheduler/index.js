/**
 * Timer trigger — fires every 5 minutes (UTC).
 * POSTs to the AllAboard backend so due SFTP import jobs are evaluated and run.
 *
 * App settings (Azure):
 *   SFTP_IMPORT_ENDPOINT_URL — full URL, e.g. https://host/api/scheduled-jobs/sftp-import
 *   SCHEDULED_JOB_API_KEY    — must match backend SCHEDULED_JOB_API_KEY when set
 *
 * No SFTP credentials, no DB, no ENCRYPTION_KEY — those stay in the backend process.
 */
module.exports = async function (context, myTimer) {
  const url = process.env.SFTP_IMPORT_ENDPOINT_URL;
  if (!url) {
    context.log.error('SFTP_IMPORT_ENDPOINT_URL is not set');
    throw new Error('SFTP_IMPORT_ENDPOINT_URL is not set');
  }

  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  context.log('SftpImportScheduler POST', url);

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
    context.log.error('SFTP import endpoint failed', res.status, body);
    throw new Error(`HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  context.log('SftpImportScheduler OK', res.status, body);
};
