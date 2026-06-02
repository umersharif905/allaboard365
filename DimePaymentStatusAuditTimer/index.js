const { runAudit, listTenantIdsForDimeAudit } = require('../shared/dimePaymentStatusAudit');

/**
 * Timer: reconcile oe.Payments.Status with DIME for recent rows (same logic as tenant-admin dime-payment-status-audit).
 *
 * NCRONTAB is UTC: "0 0 4,8,12,16 * * *" ≈ 4× daily at 04:00, 08:00, 12:00, 16:00 UTC.
 * For US Eastern wall-clock times, change `schedule` in function.json (e.g. 9,13,17,21 UTC ≈ 4/8/12/4 ET standard time).
 *
 * Env:
 * - DIME_STATUS_AUDIT_LOOKBACK_HOURS (default 168) — payments with PaymentDate in this window; Pass C still scans Pending up to 14d older
 * - DIME_STATUS_AUDIT_LIMIT (default 500) — max rows per tenant (same cap as API audit)
 * - DIME_STATUS_AUDIT_TENANT_IDS — optional comma-separated tenant UUIDs; if empty, all tenants with DIME rows in window
 * - DIME_STATUS_AUDIT_TIMER_DISABLED — set to "true" to no-op (e.g. local)
 */
module.exports = async function (context, myTimer) {
  if (process.env.DIME_STATUS_AUDIT_TIMER_DISABLED === 'true' || process.env.DIME_STATUS_AUDIT_TIMER_DISABLED === '1') {
    context.log('DimePaymentStatusAuditTimer: skipped (DIME_STATUS_AUDIT_TIMER_DISABLED)');
    return;
  }

  const hoursBack = Math.min(
    168,
    Math.max(1, parseInt(process.env.DIME_STATUS_AUDIT_LOOKBACK_HOURS || '168', 10) || 168)
  );
  const limit = Math.min(1000, Math.max(1, parseInt(process.env.DIME_STATUS_AUDIT_LIMIT || '500', 10) || 500));
  const allowTenants = (process.env.DIME_STATUS_AUDIT_TENANT_IDS || '').trim();

  let tenantIds;
  if (allowTenants) {
    tenantIds = allowTenants.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    tenantIds = await listTenantIdsForDimeAudit(hoursBack);
  }

  context.log(
    `DimePaymentStatusAuditTimer: ${tenantIds.length} tenant(s), lookback ${hoursBack}h, limit ${limit} per tenant`
  );

  const summary = {
    tenantsProcessed: 0,
    tenantFailures: 0,
    examined: 0,
    updated: 0,
    rowErrors: 0,
    invoicesSynced: 0,
    tenantResults: []
  };

  for (const tenantId of tenantIds) {
    try {
      const r = await runAudit({ tenantId, hoursBack, dryRun: false, limit });
      summary.tenantsProcessed += 1;
      summary.examined += r.examined;
      summary.updated += r.updated;
      summary.rowErrors += r.errors;
      summary.invoicesSynced += r.invoicesSynced;
      summary.tenantResults.push({
        tenantId,
        examined: r.examined,
        updated: r.updated,
        rowErrors: r.errors,
        invoicesSynced: r.invoicesSynced
      });
    } catch (e) {
      summary.tenantFailures += 1;
      summary.tenantResults.push({ tenantId, error: e.message });
      context.log.error(`DimePaymentStatusAuditTimer tenant ${tenantId} failed:`, e);
    }
  }

  context.log('DimePaymentStatusAuditTimer completed:', JSON.stringify(summary));
};
