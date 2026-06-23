'use strict';

const { getPool } = require('../config/database');
const { getAuditSummary } = require('./billingAuditSummary.service');
const { runAudits } = require('./billingAuditRun.service');
const BillingAuditReportsService = require('./billingAuditReports.service');
const { buildPersistedAuditSummary, compactAuditRunForReport } = require('./billingAuditReportPersist.service');
const { sendBillingAuditDailyReport } = require('./billingAuditDailyReportEmail');
const { isExternalTenantBillingSuppressed } = require('../utils/externalTenantBilling');

/** Nightly batch: mrr_compare runs DB totals only (skipDimeMrrForMrrCompare). No payment_json_fees (expensive / low signal in batch). */
const SCHEDULED_AUDITS = [
  'missing_recurring',
  'failed_payments',
  'webhook_errors',
  'enrollment_month_gaps',
  'payment_hold_enrollments',
  'mrr_compare',
  'invoice_payout_integrity',
  'orphan_payments'
];

/** External tenants (IsExternal) do not bill here — omit missing_recurring from nightly batch. */
function scheduledAuditsForTenant(tenantRow) {
  if (isExternalTenantBillingSuppressed(tenantRow)) {
    return SCHEDULED_AUDITS.filter((id) => id !== 'missing_recurring');
  }
  return SCHEDULED_AUDITS;
}

/**
 * Runs summary + DB-only audits per tenant, persists oe.BillingAuditReports,
 * sends consolidated email to improve@allaboard365.com and per-tenant emails when configured on oe.Tenants.
 * @returns {Promise<{ tenantsProcessed: number; reportsWritten: number; errors: string[] }>}
 */
async function runDailyBillingAuditJob() {
  const pool = await getPool();
  const tenantsRes = await pool.request().query(`
    SELECT TenantId, Name,
           CAST(BillingAuditReportEmails AS NVARCHAR(MAX)) AS BillingAuditReportEmails,
           ISNULL(IsExternal, 0) AS IsExternal
    FROM oe.Tenants
    ORDER BY Name
  `);
  const tenants = tenantsRes.recordset || [];
  const perTenant = [];
  const errors = [];
  let reportsWritten = 0;

  for (const t of tenants) {
    const tenantId = String(t.TenantId);
    const tenantName = t.Name || tenantId;
    const skipMissingRecurring = isExternalTenantBillingSuppressed(t);
    try {
      const auditSummary = await getAuditSummary(tenantId, {
        includeDimeApiMrr: false,
        includePaymentJsonInvalid: false,
        skipMissingRecurring
      });
      const runPayload = await runAudits({
        tenantId,
        audits: scheduledAuditsForTenant(t),
        limit: 300,
        dryRun: true,
        skipDimeMrrForMrrCompare: true
      });
      const persisted = await buildPersistedAuditSummary({
        tenantId,
        auditSummary,
        runPayload,
        tenantName,
        runAtIso: new Date().toISOString(),
        suppressMissingRecurring: skipMissingRecurring
      });
      await BillingAuditReportsService.insertReport({
        tenantId,
        triggerName: 'scheduled',
        summary: persisted.summary,
        detail: persisted.detail,
        createdBy: 'scheduled-job/billing-audit-daily'
      });
      reportsWritten += 1;
      perTenant.push({
        tenantId,
        tenantName,
        auditSummary,
        auditRun: compactAuditRunForReport(runPayload),
        missingRecurringSinceLastReport: persisted.summary.missingRecurringSinceLastReport,
        billingAuditReportEmails:
          t.BillingAuditReportEmails != null && String(t.BillingAuditReportEmails).trim()
            ? String(t.BillingAuditReportEmails)
            : null
      });
    } catch (e) {
      const msg = e.message || String(e);
      errors.push(`${tenantName} (${tenantId}): ${msg}`);
      console.error(`billing-audit-daily tenant ${tenantId}:`, e);
    }
  }

  await sendBillingAuditDailyReport({ perTenant, errors });

  return {
    tenantsProcessed: tenants.length,
    reportsWritten,
    errors
  };
}

module.exports = { runDailyBillingAuditJob, SCHEDULED_AUDITS, scheduledAuditsForTenant };
