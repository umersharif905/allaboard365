/**
 * LogInspector — Hourly timer (top of every hour)
 *
 * 1. Discovers all Web Apps + Function Apps in the AllAboard365 resource group
 * 2. Pulls recent logs from each via App Insights Query API
 * 3. Sends logs to GPT-4.1 for analysis
 * 4. Stores findings in oe.AiInspectorReports
 * 5. Emails critical (Priority 1) findings via SendGrid
 *
 * App settings (Azure):
 *   OPENAI_API_KEY               — OpenAI API key for GPT analysis
 *   AZURE_CLIENT_ID              — Service Principal for Azure Management API
 *   AZURE_CLIENT_SECRET          — Service Principal secret
 *   AZURE_TENANT_ID              — Azure AD tenant
 *   AZURE_SUBSCRIPTION_ID        — Azure subscription
 *   RESOURCE_GROUP_NAME           — default: AllAboard365
 *   DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD — MSSQL connection
 *   SENDGRID_API_KEY             — SendGrid for alert emails
 *   DEFAULT_FROM_EMAIL           — sender address
 *   ALERT_EMAIL                  — recipient for critical alerts (default: jeremy@mightywell.us)
 *   BUG_REPORT_WEBHOOK_URL       — Cursor automation webhook (same as backend)
 *   BUG_REPORT_WEBHOOK_BEARER_TOKEN
 *   AI_INSPECTOR_CURSOR_AUTOMATION_ENABLED — set false to disable P1 → Cursor forwarding
 */

const crypto = require('crypto');
const { listAllSites, fetchRecentLogs } = require('../shared/azureLogClient');
const { analyzeLogs } = require('../shared/aiAnalyzer');
const { insertFindings, fetchRecentIntegrationErrors, closePool } = require('../shared/reportDatabase');
const { sendCriticalAlert } = require('../shared/alertEmailer');
const { publishCriticalFindingsToCursor } = require('../shared/cursorWebhook');

const MAX_CONCURRENT_FETCHES = 4;

// Map SystemIntegrationErrors.Severity -> AiInspectorReports.Priority
const SEVERITY_PRIORITY = { critical: 1, error: 1, warning: 2, info: 3 };
// Errors in these categories are always Priority 1 regardless of Severity — payment
// / pricing failures silently eat revenue and need human eyes today.
const CRITICAL_CATEGORIES = new Set(['enrollment_wizard_payment', 'billing', 'commissions']);
// Integration-error lookback: one full hour plus 15 min overlap to cover clock drift
// between the Function host and the SQL server. Dedup by IntegrationErrorId handles
// the overlap (see fetchRecentIntegrationErrors in shared/reportDatabase.js).
// Can be overridden with INTEGRATION_ERRORS_LOOKBACK_MIN env var for backfills /
// incident response (e.g. set to 4320 to replay the last 3 days after a code fix).
const INTEGRATION_ERRORS_LOOKBACK_MIN = Number(process.env.INTEGRATION_ERRORS_LOOKBACK_MIN) || 75;

module.exports = async function (context, myTimer) {
  const runId = crypto.randomUUID();
  const log = (...args) => context.log(...args);

  log(`LogInspector run started — RunId: ${runId}`);

  let totalFindings = 0;
  const allCriticalFindings = [];

  try {
    // 1. Discover all sites
    const sites = await listAllSites(log);
    if (!sites || sites.length === 0) {
      log('No sites found in resource group — nothing to inspect');
      return;
    }
    log(`Will inspect ${sites.length} site(s): ${sites.map((s) => s.name).join(', ')}`);

    // 2-4. Process sites in batches to avoid overwhelming OpenAI
    const monitorable = sites.filter((s) => s.appInsightsAppId);
    const skipped = sites.filter((s) => !s.appInsightsAppId);
    if (skipped.length > 0) {
      log(`Skipping ${skipped.length} site(s) without App Insights: ${skipped.map((s) => s.name).join(', ')}`);
    }

    for (let i = 0; i < monitorable.length; i += MAX_CONCURRENT_FETCHES) {
      const batch = monitorable.slice(i, i + MAX_CONCURRENT_FETCHES);
      const results = await Promise.allSettled(
        batch.map((site) => processSite(site.name, site.appInsightsAppId, runId, log))
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const siteName = batch[j].name;

        if (result.status === 'fulfilled') {
          const { findingsCount, criticalFindings } = result.value;
          totalFindings += findingsCount;
          allCriticalFindings.push(...criticalFindings);
        } else {
          log(`${siteName}: unhandled error — ${result.reason?.message || result.reason}`);
        }
      }
    }

    // 4b. Inspect structured integration errors the backend writes to SQL.
    // The backend doesn't ship to App Insights, so these never surface via the
    // per-site log query above. This is where ReferenceErrors, DIME failures,
    // pricing mismatches, etc. actually live.
    try {
      const integrationFindings = await processIntegrationErrors(runId, log);
      totalFindings += integrationFindings.insertedCount;
      allCriticalFindings.push(...integrationFindings.criticalFindings);
    } catch (err) {
      log(`Integration-errors pass failed: ${err.message}`);
    }

    // 5. Send alert email + Cursor automation for all Priority 1 findings
    if (allCriticalFindings.length > 0) {
      log(`Sending critical alert for ${allCriticalFindings.length} finding(s)...`);
      await sendCriticalAlert(allCriticalFindings, runId, log);

      log(`Forwarding ${allCriticalFindings.length} P1 finding(s) to Cursor automation...`);
      const cursorResult = await publishCriticalFindingsToCursor(allCriticalFindings, runId, log);
      log(`Cursor webhook: ${cursorResult.sent} sent, ${cursorResult.failed || 0} failed, ${cursorResult.skipped || 0} skipped`);
    }

    log(`LogInspector run complete — RunId: ${runId}, ${totalFindings} total finding(s), ${allCriticalFindings.length} critical`);
  } catch (err) {
    log(`LogInspector fatal error: ${err.message}`);
    throw err;
  } finally {
    await closePool();
  }
};

/**
 * Process a single site: fetch logs -> analyze -> store.
 * Returns { findingsCount, criticalFindings }.
 */
async function processSite(siteName, appInsightsAppId, runId, log) {
  // Fetch logs
  const logText = await fetchRecentLogs(siteName, log, appInsightsAppId);
  if (!logText) {
    return { findingsCount: 0, criticalFindings: [] };
  }

  // Analyze with GPT
  const findings = await analyzeLogs(siteName, logText, log);
  if (!findings || findings.length === 0) {
    return { findingsCount: 0, criticalFindings: [] };
  }

  // Store in DB
  const inserted = await insertFindings(siteName, runId, findings, log);
  log(`${siteName}: ${inserted} finding(s) stored`);

  // Collect critical findings for the alert email
  const criticalFindings = findings
    .filter((f) => f.priority === 1)
    .map((f) => ({ appServiceName: siteName, ...f }));

  return { findingsCount: inserted, criticalFindings };
}

/**
 * Convert rows from oe.SystemIntegrationErrors into AI Inspector findings.
 *
 * We deliberately skip GPT here — the backend already categorized these rows
 * (Source / Category / Severity / Message), so re-asking an LLM to "figure out"
 * what's wrong adds latency and occasional hallucination. Direct 1:1 mapping
 * is faster, deterministic, and cheap.
 *
 * Returns { insertedCount, criticalFindings } with the same shape the App
 * Insights path uses, so the outer run report stays consistent.
 */
async function processIntegrationErrors(runId, log) {
  const errors = await fetchRecentIntegrationErrors(INTEGRATION_ERRORS_LOOKBACK_MIN, log);
  if (!errors || errors.length === 0) {
    log(`SystemIntegrationErrors: no new rows in the last ${INTEGRATION_ERRORS_LOOKBACK_MIN} minutes`);
    return { insertedCount: 0, criticalFindings: [] };
  }

  log(`SystemIntegrationErrors: ${errors.length} new row(s) to report`);

  // Group by Source+Message so 5 identical ReferenceErrors become one finding with
  // occurrence count, instead of five separate emails. Still dedup-safe — every
  // IntegrationErrorId is listed in RawLogExcerpt so future runs skip them all.
  const groups = new Map();
  for (const e of errors) {
    const key = `${e.Source || 'unknown'}|${(e.Message || '').slice(0, 200)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const findings = [];
  const criticalFindings = [];

  for (const [, rows] of groups) {
    const head = rows[0];
    const severityLower = String(head.Severity || '').toLowerCase();
    const categoryLower = String(head.Category || '').toLowerCase();
    const isCriticalCategory = CRITICAL_CATEGORIES.has(categoryLower);
    const priority = isCriticalCategory ? 1 : (SEVERITY_PRIORITY[severityLower] || 2);

    const idList = rows.map((r) => `IntegrationErrorId:${r.IntegrationErrorId}`).join(' ');
    const firstAt = rows[rows.length - 1].CreatedDate;
    const lastAt = rows[0].CreatedDate;

    const title = truncate(
      `[${head.Source || 'unknown'}] ${head.Message || '(no message)'}`,
      480
    );

    const summary = [
      `Occurrences: ${rows.length} in the last ${INTEGRATION_ERRORS_LOOKBACK_MIN} minute(s)`,
      `Category: ${head.Category || 'n/a'}`,
      `Source: ${head.Source || 'n/a'}`,
      `Severity: ${head.Severity || 'n/a'}`,
      `First seen: ${firstAt?.toISOString?.() || firstAt}`,
      `Last seen:  ${lastAt?.toISOString?.() || lastAt}`,
      '',
      `Message: ${head.Message || '(none)'}`,
      head.DetailJson ? `\nDetail: ${truncate(head.DetailJson, 2000)}` : '',
    ].join('\n');

    const rawLogExcerpt = `${idList}\n\n${rows.slice(0, 5).map((r) =>
      `[${(r.CreatedDate?.toISOString?.() || r.CreatedDate)}] ${r.Severity} ${r.Source} — ${r.Message}`
    ).join('\n')}`;

    const recommendation = buildRecommendation(head);

    findings.push({
      priority,
      category: head.Category || 'IntegrationError',
      title,
      summary,
      rawLogExcerpt,
      recommendation,
    });
  }

  // Single virtual "app service" so these show up separately in the UI from App
  // Insights findings. Keeps the dashboard and email grouping sensible.
  const virtualSiteName = 'AllAboard365-Backend (SystemIntegrationErrors)';
  const inserted = await insertFindings(virtualSiteName, runId, findings, log);
  log(`SystemIntegrationErrors: ${inserted} finding(s) stored`);

  for (const f of findings) {
    if (f.priority === 1) {
      criticalFindings.push({ appServiceName: virtualSiteName, ...f });
    }
  }

  return { insertedCount: inserted, criticalFindings };
}

function truncate(str, n) {
  if (!str) return '';
  const s = String(str);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function buildRecommendation(row) {
  const msg = String(row.Message || '');
  if (/ReferenceError.*not defined/i.test(msg) || /is not defined/i.test(msg)) {
    return 'Likely scoping/undefined-variable regression. Inspect the stack trace in DetailJson, grep the symbol across the affected route, and add a missing require/declaration or pass the value via function params.';
  }
  if (/status code 400/i.test(msg) && /dime/i.test(row.Category || row.Source || '')) {
    return 'DIME returned 400. Check PaymentAttempts and SystemIntegrationErrors.DetailJson for validationErrors; usually a bad card/account number or billing address mismatch.';
  }
  if (/PRICING_VALIDATION_FAILED/i.test(msg)) {
    return 'Frontend pricing disagreed with backend. Likely stale pricing config or a missing product/tier. Check oe.ProductPricing and the Pricing Authority fingerprint.';
  }
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) {
    return 'Upstream/DB timeout. Check SQL DTU, DIME status, and app service instance count during the affected window.';
  }
  return null;
}
