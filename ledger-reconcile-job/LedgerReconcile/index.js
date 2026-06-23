/**
 * Timer — WEEKLY (Sunday 06:00 UTC): DIME full-ledger settlement audit (report-only).
 *
 * POSTs LEDGER_RECONCILE_ENDPOINT_URL → …/api/scheduled-jobs/ledger-reconcile, which
 * pulls each active ACH household's complete DIME customer ledger, nets credits vs
 * returns/rejects, matches by transaction id against our Completed payments, and writes
 * over/understatement findings to oe.SystemIntegrationErrors (AI inspector watches
 * 'billing'). It does NOT modify payments/invoices — it only reports.
 *
 * Heavier than the nightly (one DIME API call per household) and ACH-cadenced, so it
 * runs on its own weekly schedule rather than inside billing-nightly.
 *
 * App settings:
 *   LEDGER_RECONCILE_ENDPOINT_URL  required — POST target on the backend
 *   SCHEDULED_JOB_API_KEY          optional — must match backend when set (else 401)
 *   LEDGER_RECONCILE_BODY          optional — JSON overrides, e.g. {"lookbackDays":60}
 */
module.exports = async function (context, myTimer) {
  const url = process.env.LEDGER_RECONCILE_ENDPOINT_URL;
  if (!url) {
    const msg = 'LedgerReconcile: LEDGER_RECONCILE_ENDPOINT_URL not set';
    context.log.error(msg);
    throw new Error(msg);
  }

  let body = '{}';
  if (process.env.LEDGER_RECONCILE_BODY) {
    try {
      JSON.parse(process.env.LEDGER_RECONCILE_BODY); // validate
      body = process.env.LEDGER_RECONCILE_BODY;
    } catch (e) {
      context.log.warn(`LedgerReconcile: ignoring invalid LEDGER_RECONCILE_BODY (${e.message})`);
    }
  }

  const headers = { 'content-type': 'application/json' };
  const apiKey = process.env.SCHEDULED_JOB_API_KEY;
  if (apiKey) headers['x-api-key'] = apiKey;

  context.log(`LedgerReconcile POST ledger-reconcile ${url}`);
  const res = await fetch(url, { method: 'POST', headers, body });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw */
  }

  if (!res.ok) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    context.log.error(`SCHEDULED_JOB_FAILURE endpoint=ledger-reconcile status=${res.status} url=${url} body=${detail}`);
    throw new Error(`ledger-reconcile HTTP ${res.status}: ${detail}`);
  }

  context.log('ledger-reconcile OK', res.status, parsed && parsed.message ? parsed.message : '');
  return parsed;
};
