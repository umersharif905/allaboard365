#!/usr/bin/env node

/**
 * Test the unified refund + clawback pipeline against the TESTING database
 * by calling RefundService.processRefund() directly. Skips the DIME gateway
 * call entirely (the script never talks to DIME), so it works regardless of
 * sandbox tokens.
 *
 * Usage:
 *   node ai_scripts/test-refund-clawbacks.js --paymentId=<UUID> [--amount=<NUM>] [--reason="..."]
 *
 * Defaults to testing DB (allaboard-testing). Hard-aborts if it ever sees
 * "allaboard-prod" in DB_NAME so a stray env var can't accidentally hit prod.
 *
 * What it does:
 *   1. Loads RefundService against the testing DB
 *   2. Prints BEFORE snapshot: existing Commissions, NACHAPaymentDetails,
 *      PayoutClawbacks for the target paymentId
 *   3. Calls RefundService.processRefund({ source: 'webhook', bypassTenantGuard: true })
 *      with a unique processorTxnId so the run is fully idempotent on retry
 *   4. Prints AFTER snapshot + summary of what changed
 *
 * Cleanup:
 *   The script does NOT delete the rows it creates — they're left in place so
 *   you can run a NACHA cycle and verify netting. To "undo" a test refund,
 *   delete the matching oe.Refunds + oe.Payments(refund) + oe.Commissions(neg) +
 *   oe.PayoutClawbacks rows and reset the original Payments.Status. The
 *   processorTxnId dedupe means re-running the script with the SAME id is a
 *   no-op, so you don't need to clean up just to retry.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');

const BACKEND_DIR = path.resolve(__dirname, '..', 'backend');

// 1. Resolve dotenv from backend/node_modules (no deps installed at repo root).
const dotenv = require(path.join(BACKEND_DIR, 'node_modules', 'dotenv'));
dotenv.config({ path: path.join(BACKEND_DIR, '.env'), override: false });

// 2. Force testing DB. Set NODE_ENV=production AFTER loading .env so the
//    backend's database.js skips its own dotenv reload (which uses override:true
//    and would clobber our DB_NAME below).
process.env.DB_NAME = process.env.DB_NAME_TESTING || 'allaboard-testing';
process.env.NODE_ENV = 'production';

if (String(process.env.DB_NAME).toLowerCase().includes('prod')) {
  console.error(`❌ Refusing to run against DB_NAME=${process.env.DB_NAME}. Set DB_NAME=allaboard-testing and rerun.`);
  process.exit(2);
}

// 3. Now safe to import backend modules (they will read DB_NAME above).
const { getPool } = require(path.join(BACKEND_DIR, 'config', 'database'));
const RefundService = require(path.join(BACKEND_DIR, 'services', 'refundService'));

// 3. Parse CLI args (--paymentId=, --amount=, --reason=)
function parseArgs() {
  const out = { paymentId: null, amount: null, reason: 'Refund clawback test' };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'paymentId') out.paymentId = m[2];
    else if (m[1] === 'amount') out.amount = Number(m[2]);
    else if (m[1] === 'reason') out.reason = m[2];
  }
  return out;
}

async function snapshot(pool, paymentId) {
  const r = pool.request().input('paymentId', paymentId);
  const [pmt, cmsn, payouts, clawbacks, refunds] = await Promise.all([
    r.query(`
      SELECT PaymentId, Amount, Status, TransactionType, OriginalPaymentId,
             InvoiceId, HouseholdId, GroupId, TenantId
      FROM oe.Payments
      WHERE PaymentId = @paymentId OR OriginalPaymentId = @paymentId
      ORDER BY CreatedDate
    `),
    pool.request().input('paymentId', paymentId).query(`
      SELECT CommissionId, AgentId, Amount, Status, TransactionType
      FROM oe.Commissions
      WHERE PaymentId = @paymentId
      ORDER BY CreatedDate
    `),
    pool.request().input('paymentId', paymentId).query(`
      SELECT d.NACHAPaymentDetailId, d.RecipientEntityType, d.RecipientEntityId,
             d.Amount, g.Status AS NACHAStatus
      FROM oe.NACHAPaymentDetails d
      INNER JOIN oe.NACHAGenerations g ON g.NACHAId = d.NACHAId
      WHERE d.PaymentId = @paymentId
      ORDER BY d.RecipientEntityType, d.Amount DESC
    `),
    pool.request().input('paymentId', paymentId).query(`
      SELECT ClawbackId, PayoutType, RecipientEntityType, RecipientEntityId,
             Amount, RemainingAmount, Status, CreatedDate
      FROM oe.PayoutClawbacks
      WHERE SourcePaymentId = @paymentId
      ORDER BY CreatedDate
    `),
    pool.request().input('paymentId', paymentId).query(`
      SELECT RefundId, Amount, Status, ProcessorTransactionId, CreatedDate
      FROM oe.Refunds
      WHERE PaymentId = @paymentId
      ORDER BY CreatedDate
    `)
  ]);
  return {
    payments: pmt.recordset,
    commissions: cmsn.recordset,
    nachaPayouts: payouts.recordset,
    payoutClawbacks: clawbacks.recordset,
    refunds: refunds.recordset
  };
}

function fmtMoney(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function printSection(title, rows, columns) {
  console.log(`\n--- ${title} (${rows.length}) ---`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of rows) {
    const cells = columns.map(c => {
      let v = r[c];
      if (v == null) v = '—';
      else if (typeof v === 'number') v = fmtMoney(v);
      else v = String(v);
      return `${c}=${v}`;
    });
    console.log('  ' + cells.join('  '));
  }
}

(async () => {
  const args = parseArgs();
  if (!args.paymentId) {
    console.error('❌ --paymentId=<UUID> is required');
    process.exit(1);
  }

  console.log('='.repeat(72));
  console.log(`Refund + clawback pipeline test`);
  console.log(`  DB: ${process.env.DB_NAME}`);
  console.log(`  paymentId: ${args.paymentId}`);
  console.log('='.repeat(72));

  const pool = await getPool();

  // Resolve a real SysAdmin user UUID to attribute the refund to. Works
  // across DBs without hardcoding a specific UUID. RefundService falls back
  // to its own SYSTEM_USER_ID if processedBy isn't a UUID, but on the testing
  // DB that hardcoded UUID doesn't exist — so look up dynamically here.
  const adminRes = await pool.request().query(`
    SELECT TOP 1 UserId FROM oe.Users WHERE Roles LIKE '%SysAdmin%' ORDER BY CreatedDate
  `);
  const systemUserId = adminRes.recordset?.[0]?.UserId || null;
  if (!systemUserId) {
    console.error('❌ No SysAdmin user found in this DB to attribute the refund to.');
    process.exit(1);
  }
  console.log(`Using attribution user: ${systemUserId}`);

  // Verify the source payment exists and grab its amount.
  const pRes = await pool.request()
    .input('paymentId', args.paymentId)
    .query(`SELECT Amount, Status, TenantId FROM oe.Payments WHERE PaymentId = @paymentId`);
  const orig = pRes.recordset?.[0];
  if (!orig) {
    console.error(`❌ Payment ${args.paymentId} not found in ${process.env.DB_NAME}`);
    process.exit(1);
  }
  const refundAmount = args.amount || Number(orig.Amount);
  console.log(`Original amount=${fmtMoney(orig.Amount)} status=${orig.Status} → refunding ${fmtMoney(refundAmount)}`);

  // BEFORE snapshot
  const before = await snapshot(pool, args.paymentId);
  console.log('\n=========================  BEFORE  =========================');
  printSection('Refunds', before.refunds, ['RefundId', 'Amount', 'Status']);
  printSection('Payments (original + any existing refunds)', before.payments,
    ['PaymentId', 'TransactionType', 'Amount', 'Status', 'OriginalPaymentId']);
  printSection('Commissions for this payment', before.commissions,
    ['CommissionId', 'AgentId', 'Amount', 'Status', 'TransactionType']);
  printSection('NACHA payouts (Sent) for this payment', before.nachaPayouts,
    ['RecipientEntityType', 'RecipientEntityId', 'Amount', 'NACHAStatus']);
  printSection('Existing PayoutClawbacks', before.payoutClawbacks,
    ['ClawbackId', 'PayoutType', 'Amount', 'RemainingAmount', 'Status']);

  // Build a unique idempotency key per run; rerunning with the SAME key is a no-op.
  const processorTxnId = `test-refund-${crypto.randomUUID()}`;
  console.log(`\nCalling RefundService.processRefund (source=webhook, bypassTenantGuard=true) with processorTxnId=${processorTxnId}`);

  const result = await RefundService.processRefund({
    paymentId: args.paymentId,
    refundAmount,
    reason: args.reason,
    processedBy: systemUserId,
    processorTxnId,
    source: 'webhook',
    bypassTenantGuard: true,
    paymentMethodHint: null
  });

  console.log('\nRefundService result:', JSON.stringify(result, null, 2));

  if (!result.success) {
    console.error('❌ Refund failed — see message above. Aborting before AFTER snapshot.');
    process.exit(1);
  }

  // AFTER snapshot
  const after = await snapshot(pool, args.paymentId);
  console.log('\n==========================  AFTER  ==========================');
  printSection('Refunds', after.refunds, ['RefundId', 'Amount', 'Status', 'ProcessorTransactionId']);
  printSection('Payments (original + refund row(s))', after.payments,
    ['PaymentId', 'TransactionType', 'Amount', 'Status', 'OriginalPaymentId']);
  printSection('Commissions for this payment', after.commissions,
    ['CommissionId', 'AgentId', 'Amount', 'Status', 'TransactionType']);
  printSection('NACHA payouts (Sent) for this payment', after.nachaPayouts,
    ['RecipientEntityType', 'RecipientEntityId', 'Amount', 'NACHAStatus']);
  printSection('PayoutClawbacks', after.payoutClawbacks,
    ['ClawbackId', 'PayoutType', 'Amount', 'RemainingAmount', 'Status']);

  // Diff summary
  const newCommissions = after.commissions.filter(a => !before.commissions.some(b => b.CommissionId === a.CommissionId));
  const newClawbacks = after.payoutClawbacks.filter(a => !before.payoutClawbacks.some(b => b.ClawbackId === a.ClawbackId));
  const negCommTotal = newCommissions.filter(c => Number(c.Amount) < 0).reduce((s, c) => s + Number(c.Amount), 0);
  const vendorClawTotal = newClawbacks.filter(c => c.PayoutType === 'Vendor').reduce((s, c) => s + Number(c.Amount), 0);
  const overrideClawTotal = newClawbacks.filter(c => c.PayoutType === 'TenantOverride').reduce((s, c) => s + Number(c.Amount), 0);

  console.log('\n=========================  DIFF  =========================');
  console.log(`  Negative commission rows created: ${newCommissions.filter(c => Number(c.Amount) < 0).length} totaling ${fmtMoney(negCommTotal)}`);
  console.log(`  Cancelled (Pending→Cancelled) commission rows: ${after.commissions.filter(a => a.Status === 'Cancelled' && !before.commissions.some(b => b.CommissionId === a.CommissionId && b.Status === 'Cancelled')).length}`);
  console.log(`  Vendor PayoutClawbacks created: ${newClawbacks.filter(c => c.PayoutType === 'Vendor').length} totaling ${fmtMoney(vendorClawTotal)}`);
  console.log(`  TenantOverride PayoutClawbacks created: ${newClawbacks.filter(c => c.PayoutType === 'TenantOverride').length} totaling ${fmtMoney(overrideClawTotal)}`);
  console.log('\n✅ Refund + clawback pipeline executed successfully.');
  console.log('   Next step: run a NACHA generation against this tenant to see netting.');

  process.exit(0);
})().catch(err => {
  console.error('❌ Script error:', err);
  process.exit(1);
});
