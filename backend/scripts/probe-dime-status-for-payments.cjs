#!/usr/bin/env node
'use strict';

/**
 * Read-only: for a given set of oe.Payments rows, fetch each transaction's CURRENT
 * DIME status and flag mismatches against our stored Status — specifically the
 * dangerous case where we show Completed but DIME now reports a rejected/returned/
 * refunded ACH (post-settlement clawback the pending-sweep never re-examines).
 *
 * Usage: node scripts/probe-dime-status-for-payments.cjs <tenantId> <paymentId,paymentId,...>
 *        node scripts/probe-dime-status-for-payments.cjs --household <householdId>
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getPool, sql } = require('../config/database');
const DimeService = require('../services/dimeService');
const { requireShared } = require('../config/shared-modules');
const { mapDimePayloadToPaymentRecordStatus, isSuccessfulPaymentRecordStatus } = requireShared('payment-status');

async function loadRows(pool) {
  const args = process.argv.slice(2);
  const sweepIdx = args.indexOf('--sweep');
  if (sweepIdx !== -1) {
    const tenantId = args[sweepIdx + 1];
    const sinceIdx = args.indexOf('--since');
    const since = sinceIdx !== -1 ? args[sinceIdx + 1] : '2026-03-01';
    const r = await pool.request()
      .input('t', sql.UniqueIdentifier, tenantId)
      .input('since', sql.DateTime2, new Date(since))
      .query(`
        SELECT CAST(PaymentId AS varchar(40)) AS PaymentId, CAST(TenantId AS varchar(40)) AS TenantId,
               Amount, Status, PaymentMethod, CAST(ProcessorTransactionId AS varchar(40)) AS DimeTxn,
               CONVERT(varchar(10),PaymentDate,120) AS Dt, CAST(HouseholdId AS varchar(40)) AS HouseholdId
        FROM oe.Payments
        WHERE TenantId=@t AND Status='Completed' AND ProcessorTransactionId IS NOT NULL
          AND PaymentMethod IN ('ACH','Recurring','dime') AND PaymentDate >= @since
        ORDER BY PaymentDate`);
    return r.recordset || [];
  }
  const hhIdx = args.indexOf('--household');
  if (hhIdx !== -1) {
    const hh = args[hhIdx + 1];
    const r = await pool.request().input('hh', sql.UniqueIdentifier, hh).query(`
      SELECT CAST(PaymentId AS varchar(40)) AS PaymentId, CAST(TenantId AS varchar(40)) AS TenantId,
             Amount, Status, PaymentMethod, CAST(ProcessorTransactionId AS varchar(40)) AS DimeTxn,
             CONVERT(varchar(10),PaymentDate,120) AS Dt
      FROM oe.Payments WHERE HouseholdId=@hh AND ProcessorTransactionId IS NOT NULL
      ORDER BY PaymentDate`);
    return r.recordset || [];
  }
  const tenantId = args[0];
  const ids = (args[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = [];
  for (const id of ids) {
    const r = await pool.request().input('id', sql.UniqueIdentifier, id).query(`
      SELECT CAST(PaymentId AS varchar(40)) AS PaymentId, CAST(TenantId AS varchar(40)) AS TenantId,
             Amount, Status, PaymentMethod, CAST(ProcessorTransactionId AS varchar(40)) AS DimeTxn,
             CONVERT(varchar(10),PaymentDate,120) AS Dt
      FROM oe.Payments WHERE PaymentId=@id`);
    if (r.recordset[0]) rows.push({ ...r.recordset[0], TenantId: r.recordset[0].TenantId || tenantId });
  }
  return rows;
}

async function main() {
  const pool = await getPool();
  const rows = await loadRows(pool);
  console.log(`Checking ${rows.length} payment row(s) against DIME\n`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mismatches = [];
  let lookupFails = 0;
  for (const row of rows) {
    await sleep(120);
    const txId = String(row.DimeTxn || '').trim();
    if (!txId) { console.log(`- ${row.Dt} $${row.Amount} ${row.Status} (no DIME txn — skip)`); continue; }
    let res;
    try {
      res = await DimeService.getTransactionForAudit(String(row.TenantId), txId, row.PaymentMethod, null);
    } catch (e) { console.log(`- ${row.Dt} $${row.Amount} txn ${txId}: lookup threw ${e.message}`); continue; }
    if (!res.success) {
      lookupFails++;
      console.log(`- ${row.Dt} $${row.Amount} DB=${row.Status} txn ${txId}: DIME lookup FAILED status=${res.error?.status} hh=${row.HouseholdId || ''}`);
      continue;
    }
    const d = res.data || {};
    const mapped = mapDimePayloadToPaymentRecordStatus(d);
    const dbSuccess = isSuccessfulPaymentRecordStatus(row.Status);
    const dimeSuccess = isSuccessfulPaymentRecordStatus(mapped);
    const flag = dbSuccess && !dimeSuccess ? '  <<< OVERSTATED (DB success, DIME not)' : (mapped !== row.Status ? '  (status differs)' : '');
    console.log(`- ${row.Dt} $${row.Amount} txn ${txId}  DB=${row.Status}  DIME_status=${d.transaction_status}  -> mapped=${mapped}${flag}`);
    if (dbSuccess && !dimeSuccess) mismatches.push({ ...row, dimeStatus: d.transaction_status, mapped });
  }

  console.log(`\n=== ${mismatches.length} OVERSTATED row(s) (DB shows paid, DIME does not); ${lookupFails} lookup failures ===`);
  for (const m of mismatches) {
    console.log(`  ${m.PaymentId} hh=${m.HouseholdId || ''} ${m.Dt} $${m.Amount}  DB=${m.Status}  DIME=${m.dimeStatus} -> ${m.mapped}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('probe failed:', e); process.exit(1); });
