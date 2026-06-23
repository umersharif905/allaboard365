#!/usr/bin/env node
'use strict';

/**
 * Read-only probe: for the stuck "Pending / ACH_PAYMENT_CREDIT_PENDING" payments,
 * ask DIME what each transaction looks like NOW and what the nightly reconcile
 * (dime_status audit) would map it to. Does NOT write anything.
 *
 * Usage: node scripts/probe-stuck-pending-ach.cjs
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getPool, sql } = require('../config/database');
const DimeService = require('../services/dimeService');
const { requireShared } = require('../config/shared-modules');
const { mapDimePayloadToPaymentRecordStatus, isSuccessfulPaymentRecordStatus } =
  requireShared('payment-status');

async function main() {
  const pool = await getPool();
  const res = await pool.request().query(`
    SELECT p.PaymentId, p.TenantId, p.Amount, p.Status, p.FailureReason,
           p.PaymentMethod, p.Processor, p.ProcessorTransactionId, p.TransactionType,
           p.PaymentDate, p.InvoiceId
    FROM oe.Payments p
    WHERE LOWER(LTRIM(RTRIM(p.Status))) = 'pending'
      AND p.FailureReason LIKE '%ACH_PAYMENT_CREDIT_PENDING%'
    ORDER BY p.PaymentDate DESC
  `);
  const rows = res.recordset || [];
  console.log(`Found ${rows.length} stuck pending rows\n`);

  for (const row of rows) {
    const txId = String(row.ProcessorTransactionId || '').trim();
    console.log('────────────────────────────────────────────────────────');
    console.log(`PaymentId=${row.PaymentId}`);
    console.log(`  amount=$${row.Amount}  method=${row.PaymentMethod}  txId=${txId}  date=${new Date(row.PaymentDate).toISOString()}`);

    if (!txId) {
      console.log('  ⚠️ no ProcessorTransactionId — reconcile cannot look this up');
      continue;
    }

    let dimeResult;
    try {
      dimeResult = await DimeService.getTransactionForAudit(
        String(row.TenantId),
        txId,
        row.PaymentMethod,
        null
      );
    } catch (e) {
      console.log(`  ❌ getTransactionForAudit threw: ${e.message || e}`);
      continue;
    }

    if (!dimeResult.success) {
      console.log(`  ❌ DIME lookup FAILED: ${dimeResult.error?.message || 'unknown'} (status=${dimeResult.error?.status}) attemptedTypes=${JSON.stringify(dimeResult.attemptedTypes)}`);
      continue;
    }

    const d = dimeResult.data || {};
    const mapped = mapDimePayloadToPaymentRecordStatus(d);
    console.log(`  ✅ DIME found (source=${dimeResult.source}, attempted=${JSON.stringify(dimeResult.attemptedTypes)})`);
    console.log(`     transaction_status=${d.transaction_status ?? d.transactionStatus ?? '(none)'}`);
    console.log(`     status=${d.status ?? '(none)'}  status_code=${d.status_code ?? '(none)'}  status_text=${d.status_text ?? '(none)'}  pending=${d.pending ?? '(none)'}`);
    console.log(`     → reconcile would map to: ${mapped}  (successful=${isSuccessfulPaymentRecordStatus(mapped)})`);
    if (mapped !== 'Pending') {
      console.log(`     >>> MISMATCH: DB=Pending but DIME=${mapped} — nightly reconcile SHOULD flip this`);
    }
  }

  // ---- Dry-run the actual nightly dime_status audit for MightyWELL ----
  const MIGHTYWELL = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
  const { runAudit } = require('../services/dimePaymentStatusAudit.service');
  console.log('\n\n=== DRY-RUN nightly dime_status audit (MightyWELL, hoursBack=168, default pending sweep) ===');
  const a = await runAudit({
    tenantId: MIGHTYWELL,
    hoursBack: 168,
    dryRun: true,
    limit: 500,
    prioritizeSuccessfulFirst: true,
    pendingLookbackDays: 14,
    pendingSecondaryLimit: 200,
  });
  console.log(JSON.stringify({
    passAPrimaryCount: a.passAPrimaryCount,
    passCCount: a.passCCount,
    examined: a.examined,
    inSync: a.inSync,
    skipped: a.skipped,
    errors: a.errors,
    wouldUpdate: a.wouldUpdate,
  }, null, 2));
  const mismatches = (a.rows || []).filter((r) => r.newStatus && !r.inSync);
  console.log(`Rows the audit WOULD update: ${mismatches.length}`);
  for (const r of mismatches) {
    console.log(`  - ${r.paymentId} $${r.amount} ${r.currentStatus} -> ${r.newStatus} (dimeTxStatus=${r.dimeTransactionStatus})`);
  }
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
