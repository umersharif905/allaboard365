'use strict';

const BillingAuditReportsService = require('./billingAuditReports.service');
const { computeMissingRecurringDelta } = require('./billingAuditMissingRecurringCompare.service');

function compactAuditRunForReport(runPayload) {
  const results = runPayload?.results || {};
  const compact = {};
  for (const [k, v] of Object.entries(results)) {
    if (!v || typeof v !== 'object') {
      compact[k] = v;
      continue;
    }
    const base = {
      ok: v.ok,
      durationMs: v.durationMs,
      error: v.error,
      count: v.count,
      examined: v.examined,
      inSync: v.inSync,
      errors: v.errors,
      wouldUpdate: v.wouldUpdate,
      invoicesSynced: v.invoicesSynced,
      dryRun: v.dryRun,
      dbMrrTotal: v.dbMrrTotal,
      expectedEnrollmentMrr: v.expectedEnrollmentMrr,
      futureGroupDeferredMrr: v.futureGroupDeferredMrr,
      futureGroupDeferredEnrollmentCount: v.futureGroupDeferredEnrollmentCount,
      groupMrr: v.groupMrr,
      individualMrr: v.individualMrr,
      dimeApiActiveMrr: v.dimeApiActiveMrr,
      mrrDbMinusDimeApi: v.mrrDbMinusDimeApi,
      mrrExpectedMinusDimeApi: v.mrrExpectedMinusDimeApi,
      dimeApiMrrMeta: v.dimeApiMrrMeta,
      note: v.note
    };
    if (k === 'missing_recurring' && Array.isArray(v.sample)) {
      base.sample = v.sample;
    }
    if (k === 'orphan_payments') {
      if (v.totalNoInvoiceAllStatuses != null) base.totalNoInvoiceAllStatuses = v.totalNoInvoiceAllStatuses;
      base.completedNoInvoiceCount = v.completedNoInvoiceCount;
      base.note = v.note;
      if (Array.isArray(v.rows)) base.rows = v.rows.slice(0, 50);
    }
    compact[k] = base;
  }
  return {
    tenantId: runPayload.tenantId,
    audits: runPayload.audits,
    totalDurationMs: runPayload.totalDurationMs,
    results: compact
  };
}

/**
 * Load previous report, compute missing-recurring delta, return summary + detail for insertReport.
 * Full member list lives in detail only (keeps summaryJson small).
 */
async function buildPersistedAuditSummary({
  tenantId,
  auditSummary,
  runPayload,
  tenantName,
  runAtIso,
  suppressMissingRecurring = false
}) {
  const previous = await BillingAuditReportsService.getLatestReport(tenantId);

  if (suppressMissingRecurring) {
    const prevSnap = previous?.detail?.missingRecurringSnapshot;
    const memberKeys = Array.isArray(prevSnap?.memberKeys) ? prevSnap.memberKeys : [];
    return {
      summary: {
        auditSummary,
        auditRun: compactAuditRunForReport(runPayload),
        missingRecurringSinceLastReport: {
          comparable: false,
          reason: 'external_tenant_billing'
        },
        ...(tenantName ? { tenantName } : {}),
        runAt: runAtIso || new Date().toISOString()
      },
      detail: {
        missingRecurringSnapshot: { memberKeys }
      }
    };
  }

  const mr = runPayload?.results?.missing_recurring;
  const memberKeys = Array.isArray(mr?.memberKeys) ? mr.memberKeys : [];
  const missingRecurringSinceLastReport = computeMissingRecurringDelta(previous, memberKeys);

  return {
    summary: {
      auditSummary,
      auditRun: compactAuditRunForReport(runPayload),
      missingRecurringSinceLastReport,
      ...(tenantName ? { tenantName } : {}),
      runAt: runAtIso || new Date().toISOString()
    },
    detail: {
      missingRecurringSnapshot: { memberKeys }
    }
  };
}

module.exports = {
  compactAuditRunForReport,
  buildPersistedAuditSummary
};
