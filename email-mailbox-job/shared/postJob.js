// Shared helper: POST to a backend scheduled-job endpoint with the API key.
module.exports = async function postJob(context, url, label) {
  if (!url) {
    context.log.warn(`${label}: endpoint URL not configured — skipping run`);
    return;
  }
  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  context.log(`${label}: POST ${url}`);
  const res = await fetch(url, { method: 'POST', headers, body: '{}' });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep raw */ }

  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    context.log.error(`${label} failed HTTP ${res.status}: ${detail}`);
    throw new Error(`${label} HTTP ${res.status}: ${detail}`);
  }
  context.log(`${label} OK`, res.status, typeof body === 'string' ? body : JSON.stringify(body));
};
