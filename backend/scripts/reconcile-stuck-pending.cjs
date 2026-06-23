#!/usr/bin/env node
'use strict';

/**
 * Run the dime_status reconcile (WITH WRITES) for one tenant, using a wide
 * pending sweep so older stuck-Pending rows are caught too. Same logic the
 * nightly orchestrator uses (updates oe.Payments + syncs invoice in a txn).
 *
 * Usage: node scripts/reconcile-stuck-pending.cjs <tenantId> [--write]
 *   (omit --write for a dry run)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { runAudit } = require('../services/dimePaymentStatusAudit.service');

async function main() {
  const tenantId = process.argv[2];
  const doWrite = process.argv.includes('--write');
  if (!tenantId) {
    console.error('Usage: node scripts/reconcile-stuck-pending.cjs <tenantId> [--write]');
    process.exit(1);
  }

  console.log(`${doWrite ? '✍️  WRITE' : '🧪 DRY-RUN'} reconcile for tenant ${tenantId}\n`);

  const r = await runAudit({
    tenantId,
    hoursBack: 168,
    dryRun: !doWrite,
    limit: 1000,
    prioritizeSuccessfulFirst: true,
    pendingLookbackDays: 366,
    pendingSecondaryLimit: 1000,
  });

  console.log(JSON.stringify({
    dryRun: r.dryRun,
    passAPrimaryCount: r.passAPrimaryCount,
    passCCount: r.passCCount,
    examined: r.examined,
    inSync: r.inSync,
    skipped: r.skipped,
    errors: r.errors,
    wouldUpdate: r.wouldUpdate,
    updated: r.updated,
    invoicesSynced: r.invoicesSynced,
  }, null, 2));

  const changed = (r.rows || []).filter((x) => x.applied || (r.dryRun && x.newStatus && !x.inSync));
  console.log(`\nRows ${doWrite ? 'UPDATED' : 'that WOULD update'}: ${changed.length}`);
  for (const x of changed) {
    console.log(`  - ${x.paymentId} $${x.amount} ${x.currentStatus === x.newStatus ? '->' : x.currentStatus + ' -> '}${x.newStatus} (dimeTxStatus=${x.dimeTransactionStatus}) invoiceSynced=${x.invoiceSynced ?? x.wouldSyncInvoice ?? false}`);
  }

  const errs = (r.rows || []).filter((x) => x.error);
  if (errs.length) {
    console.log(`\nRows with ERRORS (need follow-up): ${errs.length}`);
    for (const x of errs) {
      console.log(`  - ${x.paymentId} $${x.amount} method=${x.paymentMethod} txId=${x.processorTransactionId} :: ${x.error}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('reconcile failed:', e);
    process.exit(1);
  });
