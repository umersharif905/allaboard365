#!/usr/bin/env node
'use strict';

/**
 * Read-only: pull each member's FULL DIME transaction ledger (GET /api/transactions
 * with filters.customer_uuid) and compute TRUE settled funds, so we don't mistake a
 * failed attempt for an unpaid invoice when a later RETRY actually settled (the
 * "Makala" false-positive the single-txn sweep produces).
 *
 * For each household: lists every DIME transaction in the window and nets out
 * credits vs returns/rejected, grouped by amount, so we can compare against invoices.
 *
 * Usage: node scripts/probe-dime-customer-ledger.cjs <tenantId> <householdId,householdId,...> [--start 2026-03-01] [--end 2026-06-30]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');
const { getPool, sql } = require('../config/database');
const DimeService = require('../services/dimeService');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}

// A DIME status that represents money that actually stayed with us (settled credit),
// vs money that never cleared (rejected/returned) or went back out (refund).
function classify(status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('REJECT') || s.includes('RETURN') || s.includes('FAIL') || s.includes('DECLIN') || s.includes('VOID')) return 'failed';
  if (s.includes('REFUND')) return 'refund';
  if (s.includes('FEE')) return 'fee';
  if (s.includes('CREDIT') || s.includes('APPROVED') || s.includes('SETTLED') || s.includes('SUCCESS') || s.includes('COMPLETE')) return 'credit';
  if (s.includes('PENDING') || s.includes('PROCESSING')) return 'pending';
  return 'other';
}

async function listTransactions(config, customerUuid, startDate, endDate) {
  const headers = DimeService.getHeaders(config, { silent: true });
  const body = {
    data: { sid: config.sid },
    filters: {
      customer_uuid: customerUuid,
      start_date: `${startDate} 00:00:00`,
      end_date: `${endDate} 23:59:59`
    }
  };
  const resp = await axios.request({
    method: 'GET',
    url: `${config.baseUrl}/api/transactions`,
    headers,
    data: body
  });
  const d = resp.data;
  // Be liberal about the envelope shape DIME returns.
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.data?.transactions)) return d.data.transactions;
  if (Array.isArray(d?.transactions)) return d.transactions;
  if (Array.isArray(d?.data?.data)) return d.data.data;
  return [];
}

async function main() {
  const tenantId = process.argv[2];
  const households = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const start = arg('--start', '2026-03-01');
  const end = arg('--end', '2026-06-30');
  if (!tenantId || households.length === 0) {
    console.error('Usage: node scripts/probe-dime-customer-ledger.cjs <tenantId> <hh1,hh2,...> [--start YYYY-MM-DD] [--end YYYY-MM-DD]');
    process.exit(1);
  }

  const pool = await getPool();
  const config = await DimeService.getConfigForTenant(tenantId);

  for (const hh of households) {
    const r = await pool.request().input('hh', sql.UniqueIdentifier, hh).query(`
      SELECT TOP 1 m.ProcessorCustomerId AS uuid, MIN(u.FirstName+' '+u.LastName) OVER () AS name
      FROM oe.Members m INNER JOIN oe.Users u ON u.UserId=m.UserId
      WHERE m.HouseholdId=@hh AND m.ProcessorCustomerId IS NOT NULL`);
    const uuid = r.recordset[0]?.uuid;
    const name = r.recordset[0]?.name || '(unknown)';
    console.log(`\n================ ${name}  hh=${hh}  cust=${uuid || 'NONE'} ================`);
    if (!uuid) { console.log('  no ProcessorCustomerId — skip'); continue; }

    let txns;
    try {
      txns = await listTransactions(config, uuid, start, end);
    } catch (e) {
      console.log(`  list FAILED: ${e.response?.status} ${e.response?.data?.message || e.message}`);
      continue;
    }
    txns.sort((a, b) => String(a.transaction_date || a.created_at || a.date || '').localeCompare(String(b.transaction_date || b.created_at || b.date || '')));

    // Group by transaction_number so we can NET a CREDIT against a later RETURNED/REJECTED
    // on the same txn (provisional credit later clawed back = $0, not settled).
    const byNum = new Map();
    for (const t of txns) {
      const status = t.transaction_status || t.status || t.sub_type || t.type || '';
      const amount = Number(t.amount ?? t.gross ?? t.gross_amount ?? 0);
      const num = String(t.transaction_number || t.transaction_id || t.id || '');
      const date = t.transaction_date || t.created_at || t.date || '';
      const cls = classify(status);
      if (!byNum.has(num)) byNum.set(num, { num, lines: [], credit: 0, failed: false, refund: 0, pending: 0, firstDate: date });
      const g = byNum.get(num);
      g.lines.push({ status, amount, cls, date });
      if (cls === 'credit') g.credit = Math.max(g.credit, amount);
      else if (cls === 'failed') g.failed = true; // any reject/return on this txn kills it (fees count too but amount is the $25 fee, not the principal)
      else if (cls === 'refund') g.refund += amount;
      else if (cls === 'pending') g.pending = Math.max(g.pending, amount);
    }

    for (const t of txns) {
      const status = t.transaction_status || t.status || t.sub_type || t.type || '';
      const amount = Number(t.amount ?? t.gross ?? t.gross_amount ?? 0);
      const net = t.net ?? t.net_amount;
      const date = t.transaction_date || t.created_at || t.date || '';
      const num = t.transaction_number || t.transaction_id || t.id || '';
      console.log(`  ${String(date).slice(0,10)}  #${String(num).padEnd(12)} ${String(status).padEnd(30)} $${amount}${net != null ? ` (net ${net})` : ''}`);
    }

    let settled = 0, pending = 0, failedPrincipal = 0;
    const settledTxns = [];
    for (const g of byNum.values()) {
      // A return/reject line for an ACH carries the principal amount; if a txn has BOTH a
      // credit and a failed line, the principal bounced → net 0.
      const hasFailedPrincipal = g.lines.some((l) => l.cls === 'failed' && l.amount >= g.credit && g.credit > 0);
      if (g.credit > 0 && !hasFailedPrincipal) { settled += g.credit; settledTxns.push(`#${g.num} $${g.credit}`); }
      else if (g.credit > 0 && hasFailedPrincipal) { failedPrincipal += g.credit; }
      else if (g.pending > 0) pending += g.pending;
    }
    console.log(`  --- TRUE settled $${settled.toFixed(2)} [${settledTxns.join(', ')}] | bounced $${failedPrincipal.toFixed(2)} | pending $${pending.toFixed(2)} | ${txns.length} txns`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('probe failed:', e.response?.data || e.message || e); process.exit(1); });
