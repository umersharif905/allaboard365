#!/usr/bin/env node
'use strict';

/**
 * Probe E123 payment data for a household member ID.
 * Usage: node scripts/e123-probe-member-payment.js SW0530092 [brokerId]
 * Requires E123_CORPID, E123_USERNAME, E123_PASSWORD in backend/.env
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getE123MemberSearchConfig } = require('../services/migration/e123Config');
const { userGetAllPage, fetchAllUsersForBroker } = require('../services/migration/e123Api.service');
const { buildHouseholdsFromE123Pages, computeFetchCoverageStats } = require('../services/migration/householdNormalizer');
const {
  pickBestPaymentForUser,
  hasMaskedPaymentHint,
  extractPaymentFromTransactionPayment
} = require('../services/migration/e123PaymentExtract.service');

function redactPayment(pm) {
  if (!pm) return null;
  const out = { ...pm };
  if (out.cardNumber) out.cardNumber = `****${String(out.cardNumber).slice(-4)} (len ${String(out.cardNumber).length})`;
  if (out.accountNumber) out.accountNumber = `****${String(out.accountNumber).slice(-4)} (len ${String(out.accountNumber).length})`;
  if (out.routingNumber) out.routingNumber = `****${String(out.routingNumber).slice(-4)}`;
  return out;
}

function summarizeTransactionsForUser(transactions, userId) {
  const uid = String(userId || '');
  const userTx = (transactions || []).filter((tx) => String(tx.userid || '') === uid);
  const summaries = [];
  for (const tx of userTx.slice(0, 15)) {
    for (const tp of tx.transactionpayments || []) {
      const extracted = extractPaymentFromTransactionPayment(tp, tx.paytype);
      summaries.push({
        transid: tx.transid || tp.transid,
        paytype: tx.paytype,
        transdate: tx.transdate,
        hasFullCc: !!(tp.ccnum && String(tp.ccnum).replace(/\D/g, '').length >= 13),
        cclast4: tp.cclast4 || null,
        hasFullAch: !!(tp.ckaba && tp.ckacc
          && String(tp.ckaba).replace(/\D/g, '').length === 9
          && String(tp.ckacc).replace(/\D/g, '').length >= 5
          && !/[*xX#]/.test(String(tp.ckacc))),
        extracted: extracted ? redactPayment(extracted) : null,
        rejectedReason: extracted ? null : (
          tp.cclast4 && !tp.ccnum ? 'masked card only' :
          tp.ckaba || tp.ckacc ? 'incomplete ACH' : 'no payment fields'
        )
      });
    }
  }
  return summaries;
}

async function findMemberViaMemberIdFilter(memberId) {
  const filters = [
    { MEMBERID: memberId },
    { MEMBER_ID: memberId },
    { memberid: memberId },
    { MEMBERID: memberId, RETURN_TRANSACTIONS: 1, RETURN_PRODUCTS: 1, RETURN_DEPENDENTS: 1 }
  ];
  for (const f of filters) {
    try {
      const page = await userGetAllPage(f);
      const match = (page.users || []).find((u) => String(u.memberid || '').trim() === memberId);
      if (match) {
        return { filter: f, page, user: match };
      }
    } catch (err) {
      console.warn(`   filter ${JSON.stringify(f)} failed:`, err.message);
    }
  }
  return null;
}

async function main() {
  const memberId = String(process.argv[2] || 'SW0530092').trim();
  const brokerId = Number(process.argv[3]) || Number(process.env.E123_PROBE_BROKER_ID) || null;
  const cfg = getE123MemberSearchConfig();

  console.log('=== E123 payment probe ===');
  console.log('Member ID:', memberId);
  console.log('Configured:', !!(cfg.corpid && cfg.username && cfg.password));
  if (!cfg.corpid || !cfg.username || !cfg.password) {
    console.error('Set E123_CORPID, E123_USERNAME, E123_PASSWORD in backend/.env');
    process.exit(1);
  }

  console.log('\n1) Direct MEMBERID filter on user.getall...');
  const direct = await findMemberViaMemberIdFilter(memberId);
  if (direct) {
    const uid = String(direct.user.userid);
    console.log(`   Found via ${JSON.stringify(direct.filter)} — userid=${uid}, name=${direct.user.firstname} ${direct.user.lastname}`);
    const hh = buildHouseholdsFromE123Pages({
      users: [direct.user],
      dependents: direct.page.dependents || [],
      products: direct.page.products || [],
      transactions: direct.page.transactions || []
    });
    const household = hh[0];
    console.log('   paymentMethod:', redactPayment(household?.paymentMethod));
    console.log('   paymentMethodMeta:', household?.paymentMethodMeta || null);
    console.log('   masked hint:', hasMaskedPaymentHint(direct.page.transactions, uid));
    const txSummary = summarizeTransactionsForUser(direct.page.transactions, uid);
    console.log(`   transaction payments scanned: ${txSummary.length}`);
    txSummary.slice(0, 5).forEach((row, i) => {
      console.log(`   [${i + 1}]`, JSON.stringify(row));
    });
    process.exit(0);
  }
  console.log('   No user returned for MEMBERID filters — try broker scan.');

  if (!brokerId) {
    console.error('\nPass brokerId as 2nd arg or set E123_PROBE_BROKER_ID (agent root from migration batch).');
    process.exit(2);
  }

  console.log(`\n2) Scan broker ${brokerId} downline for ${memberId}...`);
  const tree = await fetchAllUsersForBroker({ brokerId, includeDownline: true });
  const user = tree.users.find((u) => String(u.memberid || '').trim() === memberId);
  if (!user) {
    console.error('   Member not found in broker tree.');
    process.exit(3);
  }

  const uid = String(user.userid);
  console.log(`   Found userid=${uid}, brokerid=${user.brokerid}, name=${user.firstname} ${user.lastname}`);

  const households = buildHouseholdsFromE123Pages(tree);
  const household = households.find((h) => h.householdMemberId === memberId);
  const stats = computeFetchCoverageStats(households);

  console.log('\n3) Household payment extraction');
  console.log('   paymentMethod:', redactPayment(household?.paymentMethod));
  console.log('   paymentMethodMeta:', household?.paymentMethodMeta || null);
  console.log('   pickBestPaymentForUser:', redactPayment(pickBestPaymentForUser(tree.transactions, uid)));
  console.log('   masked hint:', hasMaskedPaymentHint(tree.transactions, uid));
  console.log('   batch coverage:', stats);

  const txSummary = summarizeTransactionsForUser(tree.transactions, uid);
  console.log(`\n4) Recent transaction payments (${txSummary.length} rows)`);
  txSummary.slice(0, 8).forEach((row, i) => {
    console.log(`   [${i + 1}]`, JSON.stringify(row));
  });

  if (!household?.paymentMethod) {
    console.log('\n→ Import would NOT store a payment method (no full PAN/account in E123 transactions).');
  } else {
    console.log('\n→ Import CAN store encrypted payment method on apply/re-sync.');
  }
}

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
