#!/usr/bin/env node
'use strict';

/**
 * Read-only owner/net-zero check for the unattributed NULL-tenant orphan payments.
 *
 * The orphan rows turned out to be DIME ACH_PAYMENT_REFUND transactions (money
 * OUT to the member), mis-stored as Pending payments. This script:
 *   1. Looks each orphan txn up under MightyWELL's DIME config (the low-integer
 *      ACH ids match MightyWELL's sequence; 401/366 are confirmed MightyWELL).
 *   2. Prints owner identity + status + the parent charge linkage.
 *   3. Resolves each refund's parent_transaction_info_id (the original charge)
 *      and tallies charges-in vs refunds-out to confirm a net-zero position.
 * Writes NOTHING.
 *
 * Usage: node scripts/probe-orphan-payment-owners.cjs
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const DimeService = require('../services/dimeService');
const { requireShared } = require('../config/shared-modules');
const { mapDimePayloadToPaymentRecordStatus } = requireShared('payment-status');

const MIGHTYWELL = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';

const TARGETS = [
  { txId: '252', method: 'ACH', amount: 855.01 },
  { txId: '253', method: 'ACH', amount: 855.01 },
  { txId: '254', method: 'ACH', amount: 855.01 },
  { txId: '255', method: 'ACH', amount: 855.01 },
  { txId: '489', method: 'ACH', amount: 363.23 },
];

function num(v) {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const byCustomer = new Map(); // email -> { chargesIn, refundsOut }

  for (const t of TARGETS) {
    console.log('────────────────────────────────────────────────────────');
    console.log(`DIME txn ${t.txId}  (orphan $${t.amount} ${t.method})`);
    const result = await DimeService.getTransactionForAudit(MIGHTYWELL, t.txId, t.method, null);
    if (!result.success) {
      console.log(`  ❌ lookup FAILED: ${result.error?.message || 'unknown'} (status=${result.error?.status})`);
      continue;
    }
    const d = result.data || {};
    const email = d.email || '(unknown)';
    const amt = num(d.amount);
    const isRefund = String(d.transaction_status || '').toLowerCase().includes('refund');
    console.log(`  owner=${email}  amount=${amt}  txn_status=${d.transaction_status}  mapped=${mapDimePayloadToPaymentRecordStatus(d)}`);
    console.log(`  transaction_info_id=${d.transaction_info_id}  parent_transaction_info_id=${d.parent_transaction_info_id}`);

    if (!byCustomer.has(email)) byCustomer.set(email, { chargesIn: 0, refundsOut: 0, parents: [] });
    const acc = byCustomer.get(email);
    if (isRefund) {
      acc.refundsOut += amt;
      if (d.parent_transaction_info_id) acc.parents.push(String(d.parent_transaction_info_id));
    } else {
      acc.chargesIn += amt;
    }
  }

  // Resolve each refund's parent charge (by transaction_info_id) and tally charges-in.
  console.log('\n=== Parent charges (resolved by parent_transaction_info_id) ===');
  for (const [email, acc] of byCustomer) {
    for (const parentInfoId of acc.parents) {
      const r = await DimeService.getTransactionForAudit(MIGHTYWELL, null, 'ACH', parentInfoId);
      if (!r.success) {
        console.log(`  ${email}: parent ${parentInfoId} lookup FAILED: ${r.error?.message} (status=${r.error?.status})`);
        continue;
      }
      const d = r.data || {};
      const amt = num(d.amount);
      acc.chargesIn += amt;
      console.log(`  ${email}: parent infoId=${parentInfoId}  amount=${amt}  txn_status=${d.transaction_status}  txn#=${d.transaction_number}`);
    }
  }

  console.log('\n=== Net position per customer (charges in − refunds out) ===');
  for (const [email, acc] of byCustomer) {
    const net = acc.chargesIn - acc.refundsOut;
    console.log(`  ${email}: chargesIn=$${acc.chargesIn.toFixed(2)}  refundsOut=$${acc.refundsOut.toFixed(2)}  NET=$${net.toFixed(2)} ${Math.abs(net) < 0.01 ? '✅ net-zero' : '⚠️ NON-ZERO'}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('probe failed:', e); process.exit(1); });
