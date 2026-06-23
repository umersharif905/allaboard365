const { runAudit, listTenantIdsForDimeAudit } = require('../shared/dimePaymentStatusAudit');
const { runLedgerAudit } = require('../shared/dimeLedgerAudit');
const { runScheduleAudit } = require('../shared/dimeScheduleAudit');
const { recordIntegrationErrorOnce } = require('../shared/integrationErrors');

/**
 * Timer: reconcile oe.Payments.Status with DIME for recent rows (same logic as tenant-admin dime-payment-status-audit),
 * then run the DIME → DB ledger audit (catches post-settlement clawbacks + settled txns missing a DB row —
 * the two patterns single-transaction lookups cannot see; see shared/dimeLedgerAudit.js).
 *
 * NCRONTAB is UTC: "0 0 4,8,12,16 * * *" ≈ 4× daily at 04:00, 08:00, 12:00, 16:00 UTC.
 * For US Eastern wall-clock times, change `schedule` in function.json (e.g. 9,13,17,21 UTC ≈ 4/8/12/4 ET standard time).
 *
 * Env:
 * - DIME_STATUS_AUDIT_LOOKBACK_HOURS (default 168) — payments with PaymentDate in this window; Pass C still scans Pending up to 14d older
 * - DIME_STATUS_AUDIT_LIMIT (default 500) — max rows per tenant (same cap as API audit)
 * - DIME_STATUS_AUDIT_TENANT_IDS — optional comma-separated tenant UUIDs; if empty, all tenants with DIME rows in window
 * - DIME_STATUS_AUDIT_TIMER_DISABLED — set to "true" to no-op (e.g. local)
 * - DIME_LEDGER_AUDIT_DISABLED — set to "true" to skip the DIME → DB ledger pass
 * - DIME_LEDGER_AUDIT_DAYS_BACK (default 35) — ledger window per customer (returns land up to ~6 days after settle)
 * - DIME_SCHEDULE_AUDIT_DISABLED — set to "true" to skip the recurring-schedule reconciliation pass
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

  const ledgerAuditEnabled = !(
    process.env.DIME_LEDGER_AUDIT_DISABLED === 'true' || process.env.DIME_LEDGER_AUDIT_DISABLED === '1'
  );
  const ledgerDaysBack = Math.min(
    92,
    Math.max(7, parseInt(process.env.DIME_LEDGER_AUDIT_DAYS_BACK || '35', 10) || 35)
  );
  const scheduleAuditEnabled = !(
    process.env.DIME_SCHEDULE_AUDIT_DISABLED === 'true' || process.env.DIME_SCHEDULE_AUDIT_DISABLED === '1'
  );

  const summary = {
    tenantsProcessed: 0,
    tenantFailures: 0,
    examined: 0,
    updated: 0,
    rowErrors: 0,
    invoicesSynced: 0,
    ledgerClawbacksFound: 0,
    ledgerClawbacksFixed: 0,
    ledgerMissingRows: 0,
    scheduleOrphans: 0,
    scheduleAmountMismatches: 0,
    scheduleMultipleActive: 0,
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

      const tenantResult = {
        tenantId,
        examined: r.examined,
        updated: r.updated,
        rowErrors: r.errors,
        invoicesSynced: r.invoicesSynced
      };

      if (ledgerAuditEnabled) {
        try {
          const lr = await runLedgerAudit({ tenantId, daysBack: ledgerDaysBack, dryRun: false });
          summary.ledgerClawbacksFound += lr.clawbacksFound;
          summary.ledgerClawbacksFixed += lr.clawbacksFixed;
          summary.ledgerMissingRows += lr.missingRows.length;
          tenantResult.ledger = {
            customersChecked: lr.customersChecked,
            customerLookupFailures: lr.customerLookupFailures,
            settledTransactions: lr.settledTransactions,
            clawbacksFound: lr.clawbacksFound,
            clawbacksFixed: lr.clawbacksFixed,
            missingRows: lr.missingRows,
            errors: lr.errors
          };
          if (lr.missingRows.length > 0) {
            // Missing rows are never auto-inserted — needs human reconcile.
            context.log.warn(
              `DimeLedgerAudit tenant ${tenantId}: ${lr.missingRows.length} settled DIME txn(s) have NO oe.Payments row:`,
              JSON.stringify(lr.missingRows)
            );
            // critical → surfaces with a red badge in AdminIntegrationErrors and is
            // emailed by the 15-min integration-error digest. One alert per txn,
            // deduped so 4×-daily runs don't repeat the same finding.
            for (const m of lr.missingRows) {
              await recordIntegrationErrorOnce({
                category: 'billing',
                source: 'DimeLedgerAudit',
                severity: 'error',
                priority: 'critical',
                tenantId,
                message: `Settled DIME txn #${m.transactionNumber} ($${Number(m.amount).toFixed(2)}, ${m.settledDate || 'date unknown'}) has NO oe.Payments row — ${m.description || 'payer unknown'}. Money received but not recorded; needs manual reconcile.`,
                detail: m
              });
            }
          }
          if (lr.clawbacksFound > 0) {
            context.log.warn(
              `DimeLedgerAudit tenant ${tenantId}: ${lr.clawbacksFixed}/${lr.clawbacksFound} settled-then-returned payment(s) corrected:`,
              JSON.stringify(lr.clawbacks)
            );
            for (const c of lr.clawbacks) {
              await recordIntegrationErrorOnce({
                category: 'billing',
                source: 'DimeLedgerAudit',
                severity: 'warning',
                priority: 'high',
                tenantId,
                message: `Settled-then-returned DIME txn #${c.transactionNumber} ($${Number(c.amount).toFixed(2)}) — ${c.description || 'payer unknown'}. ${c.fixed ? 'Payment auto-corrected to Failed and invoice adjusted.' : `NOT auto-fixed${c.error ? ` (${c.error})` : ''} — needs manual review.`}`,
                detail: c
              });
            }
          }
        } catch (ledgerErr) {
          tenantResult.ledgerError = ledgerErr.message;
          context.log.error(`DimeLedgerAudit tenant ${tenantId} failed:`, ledgerErr);
        }
      }

      if (scheduleAuditEnabled) {
        try {
          const sr = await runScheduleAudit({ tenantId });
          summary.scheduleOrphans += sr.orphans.length;
          summary.scheduleAmountMismatches += sr.amountMismatches.length;
          summary.scheduleMultipleActive += sr.multipleActive.length;
          tenantResult.schedules = {
            customersChecked: sr.customersChecked,
            customerLookupFailures: sr.customerLookupFailures,
            activeSchedulesSeen: sr.activeSchedulesSeen,
            orphans: sr.orphans,
            amountMismatches: sr.amountMismatches,
            multipleActive: sr.multipleActive
          };
          // Orphans charge customers money our system can't see — critical.
          for (const o of sr.orphans) {
            context.log.warn(`DimeScheduleAudit tenant ${tenantId}: ORPHAN active DIME schedule:`, JSON.stringify(o));
            await recordIntegrationErrorOnce({
              category: 'billing',
              source: 'DimeScheduleAudit',
              severity: 'error',
              priority: 'critical',
              tenantId,
              message: `Active DIME schedule #${o.scheduleId} ($${Number(o.dimeAmount).toFixed(2)}/mo, next run ${o.nextRunDate || 'unknown'}) has NO row in our DB — ${o.name || o.customerUuid}. It will keep charging the customer invisibly; needs manual review/cancel.`,
              detail: o
            });
          }
          for (const mm of sr.amountMismatches) {
            context.log.warn(`DimeScheduleAudit tenant ${tenantId}: amount mismatch:`, JSON.stringify(mm));
            await recordIntegrationErrorOnce({
              category: 'billing',
              source: 'DimeScheduleAudit',
              severity: 'warning',
              priority: 'high',
              tenantId,
              message: `DIME schedule #${mm.scheduleId} will charge $${Number(mm.dimeAmount).toFixed(2)} but our DB expects $${Number(mm.dbAmount).toFixed(2)} — ${mm.name || mm.customerUuid} (next run ${mm.nextRunDate || 'unknown'}). Wrong amount will be pulled; needs manual fix.`,
              detail: mm
            });
          }
          for (const ma of sr.multipleActive) {
            context.log.warn(`DimeScheduleAudit tenant ${tenantId}: multiple active schedules:`, JSON.stringify(ma));
            await recordIntegrationErrorOnce({
              category: 'billing',
              source: 'DimeScheduleAudit',
              severity: 'error',
              priority: 'critical',
              tenantId,
              message: `Customer ${ma.customerUuid} has ${ma.scheduleIds.length} ACTIVE DIME schedules (${ma.scheduleIds.join(', ')} — $${ma.amounts.join(', $')}). Double-charge in progress; needs manual review.`,
              detail: ma
            });
          }
        } catch (scheduleErr) {
          tenantResult.scheduleAuditError = scheduleErr.message;
          context.log.error(`DimeScheduleAudit tenant ${tenantId} failed:`, scheduleErr);
        }
      }

      summary.tenantResults.push(tenantResult);
    } catch (e) {
      summary.tenantFailures += 1;
      summary.tenantResults.push({ tenantId, error: e.message });
      context.log.error(`DimePaymentStatusAuditTimer tenant ${tenantId} failed:`, e);
    }
  }

  context.log('DimePaymentStatusAuditTimer completed:', JSON.stringify(summary));
};
