'use strict';

const Sentry = require('@sentry/node');
const { getPool } = require('../config/database');
const invoiceService = require('./invoiceService');
const { runDailyBillingAuditJob } = require('./billingAuditDailyJob.service');
const { runAudits } = require('./billingAuditRun.service');
const overdueReminderRunner = require('./overdueInvoiceReminderRunner.service');
const { recordIntegrationError } = require('./integrationErrorService');

function numInRange(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Walk the per-tenant dime_status results and sum any row-level `errors` counts.
 * These are individual payments the reconcile couldn't process (e.g. DIME lookup
 * failures) — distinct from step-level failures, but still worth surfacing.
 */
function countReconcileRowErrors(dimeReconcile) {
  let total = 0;
  const tenants = (dimeReconcile && dimeReconcile.tenants) || [];
  for (const t of tenants) {
    const results = (t && t.results) || [];
    const list = Array.isArray(results) ? results : [results];
    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const n = Number(r.errors ?? r.errorCount ?? (Array.isArray(r.errorsList) ? r.errorsList.length : 0));
      if (Number.isFinite(n)) total += n;
    }
  }
  return total;
}

/**
 * Route nightly failures to the channels we actually watch. The backend does not
 * ship console logs to App Insights, so the AI inspector (LogInspector) reads
 * backend errors from oe.SystemIntegrationErrors. Category 'billing' is a
 * critical category there → it pages via the alert email. We also push to Sentry
 * for a second, request-independent channel. Both are best-effort: reporting
 * failures must never mask the nightly result.
 */
async function reportNightlyErrors(out) {
  try {
    const rowErrors = countReconcileRowErrors(out.dimeReconcile);
    const hasStepErrors = out.stepErrors.length > 0;
    if (!hasStepErrors && rowErrors === 0) return;

    const parts = [];
    if (hasStepErrors) parts.push(`${out.stepErrors.length} step error(s)`);
    if (rowErrors > 0) parts.push(`${rowErrors} reconcile row error(s)`);
    const message = `Billing nightly finished with ${parts.join(' and ')}`;

    try {
      await recordIntegrationError({
        category: 'billing',
        source: 'billingNightlyOrchestrator',
        severity: hasStepErrors ? 'error' : 'warning',
        priority: hasStepErrors ? 'critical' : 'high',
        message,
        detail: {
          startedAt: out.startedAt,
          finishedAt: out.finishedAt,
          stepErrors: out.stepErrors,
          reconcileRowErrors: rowErrors
        }
      });
    } catch (_) {}

    if (hasStepErrors) {
      try {
        Sentry.captureException(new Error(message), {
          level: 'error',
          tags: { job: 'billing-nightly' },
          extra: { stepErrors: out.stepErrors, reconcileRowErrors: rowErrors }
        });
      } catch (_) {}
    }
  } catch (_) {
    // Never let error reporting throw out of the orchestrator.
  }
}

/**
 * Unified nightly billing: DIME payment-status reconcile (writes, per-tenant isolated) →
 * individual invoice nightly maintenance → billing audit daily (reports + email).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipDimeReconcile] — or env BILLING_NIGHTLY_SKIP_DIME_RECONCILE=true
 * @param {number} [opts.hoursBack] — DIME payment window 1–168 (default 168 or BILLING_NIGHTLY_DIME_HOURS_BACK)
 * @param {number} [opts.dimeLimit] — max payments per tenant for dime_status (default 500 or BILLING_NIGHTLY_DIME_LIMIT)
 * @param {number} [opts.successRecheckDays] — Pass B older succeeded window (0 = off; default 0 or BILLING_NIGHTLY_SUCCESS_RECHECK_DAYS)
 * @param {number} [opts.secondaryLimit] — Pass B max rows (0 = off; default 0 or BILLING_NIGHTLY_DIME_SECONDARY_LIMIT)
 * @param {number} [opts.pendingLookbackDays] — Pass C Pending ACH sweep (default 14)
 * @param {number} [opts.pendingSecondaryLimit] — Pass C max rows (default 200)
 */
async function runBillingNightlyOrchestrator(opts = {}) {
  const skipDime =
    opts.skipDimeReconcile === true || process.env.BILLING_NIGHTLY_SKIP_DIME_RECONCILE === 'true';
  const hoursBack = numInRange(
    opts.hoursBack ?? process.env.BILLING_NIGHTLY_DIME_HOURS_BACK,
    1,
    168,
    168
  );
  const dimeLimit = numInRange(opts.dimeLimit ?? process.env.BILLING_NIGHTLY_DIME_LIMIT, 1, 1000, 500);
  const successRecheckDays = numInRange(
    opts.successRecheckDays ?? process.env.BILLING_NIGHTLY_SUCCESS_RECHECK_DAYS,
    0,
    366,
    0
  );
  const secondaryLimit = numInRange(
    opts.secondaryLimit ?? process.env.BILLING_NIGHTLY_DIME_SECONDARY_LIMIT,
    0,
    1000,
    0
  );
  const pendingLookbackDays = numInRange(
    opts.pendingLookbackDays ?? process.env.BILLING_NIGHTLY_PENDING_LOOKBACK_DAYS,
    0,
    366,
    14
  );
  const pendingSecondaryLimit = numInRange(
    opts.pendingSecondaryLimit ?? process.env.BILLING_NIGHTLY_PENDING_LIMIT,
    0,
    1000,
    200
  );

  const out = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dimeReconcile: null,
    invoiceNightly: null,
    billingAuditDaily: null,
    stepErrors: []
  };

  if (!skipDime) {
    const tenantResults = [];
    try {
      const pool = await getPool();
      const tr = await pool.request().query(`
        SELECT CAST(TenantId AS NVARCHAR(36)) AS TenantId
        FROM oe.Tenants
        ORDER BY Name
      `);
      const tenants = tr.recordset || [];
      for (const row of tenants) {
        const tenantId = String(row.TenantId);
        try {
          const runPayload = await runAudits({
            tenantId,
            audits: ['dime_status'],
            dryRun: false,
            hoursBack,
            limit: dimeLimit,
            skipDimeMrrForMrrCompare: true,
            prioritizeSuccessfulFirst: true,
            successRecheckDays,
            secondaryLimit,
            pendingLookbackDays,
            pendingSecondaryLimit
          });
          tenantResults.push({ tenantId, ok: true, results: runPayload.results });
        } catch (e) {
          const err = e.message || String(e);
          tenantResults.push({ tenantId, ok: false, error: err });
          out.stepErrors.push({ step: 'dime_status', tenantId, error: err });
        }
      }
      out.dimeReconcile = {
        ok: true,
        tenantCount: tenants.length,
        tenants: tenantResults,
        hoursBack,
        dimeLimit,
        successRecheckDays,
        secondaryLimit,
        pendingLookbackDays,
        pendingSecondaryLimit
      };
    } catch (e) {
      const err = e.message || String(e);
      out.dimeReconcile = { ok: false, error: err };
      out.stepErrors.push({ step: 'dime_reconcile', error: err });
    }
  } else {
    out.dimeReconcile = { skipped: true };
  }

  try {
    out.invoiceNightly = { ok: true, stats: await invoiceService.runNightlyIndividualInvoices() };
  } catch (e) {
    const err = e.message || String(e);
    out.invoiceNightly = { ok: false, error: err };
    out.stepErrors.push({ step: 'invoice_nightly', error: err });
  }

  // Overdue invoice reminders run AFTER invoice-nightly so we see freshly-marked
  // Overdue rows from the same pass. Failure isolated — does not block billing audit.
  try {
    out.overdueReminders = { ok: true, summary: await overdueReminderRunner.run() };
  } catch (e) {
    const err = e.message || String(e);
    out.overdueReminders = { ok: false, error: err };
    out.stepErrors.push({ step: 'overdue_reminders', error: err });
  }

  try {
    out.billingAuditDaily = { ok: true, data: await runDailyBillingAuditJob() };
  } catch (e) {
    const err = e.message || String(e);
    out.billingAuditDaily = { ok: false, error: err };
    out.stepErrors.push({ step: 'billing_audit_daily', error: err });
  }

  out.finishedAt = new Date().toISOString();
  await reportNightlyErrors(out);
  return out;
}

module.exports = { runBillingNightlyOrchestrator, countReconcileRowErrors, reportNightlyErrors };
