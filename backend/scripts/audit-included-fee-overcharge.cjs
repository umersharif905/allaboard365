#!/usr/bin/env node
'use strict';

/**
 * Audit over-charging from the included-processing-fee double-count.
 *
 * The authoritative monthly due is invoiceService.monthlyDueFromEnrollmentSums(), which uses
 * shared/payment-product-snapshots resolveProcessingFeeTotalFromParts() to de-dup legacy PPF
 * rows. A household is over-charged only when its latest invoice exceeds that correct due
 * (i.e. a standalone PPF row duplicates the included allocation — "legacy duplicate").
 *
 * Usage: node scripts/audit-included-fee-overcharge.cjs [--db allaboard-prod] [--tenant <id>]
 * Read-only. Writes ai_scripts/included-fee-overcharge-audit.csv.
 */

const fs = require('fs');
const path = require('path');
const mssql = require('mssql');

const ENV = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '../.env'), 'utf8'));
const { resolveProcessingFeeTotalFromParts } = require('../../shared/payment-product-snapshots');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function correctMonthlyDue({ premiumSum, includedOnProducts, ppfOnFeeRow }) {
  const premium = Number(premiumSum) || 0;
  const included = Number(includedOnProducts) || 0;
  const ppfRow = Number(ppfOnFeeRow) || 0;
  const { total } = resolveProcessingFeeTotalFromParts(included, ppfRow);
  return Math.round((premium - ppfRow + total) * 100) / 100;
}

async function main() {
  const dbName = arg('--db') || ENV.DB_NAME;
  const tenantFilter = arg('--tenant');
  const pool = await mssql.connect({
    user: ENV.DB_USER, password: ENV.DB_PASSWORD, server: ENV.DB_SERVER, database: dbName,
    options: { encrypt: true, trustServerCertificate: false, requestTimeout: 120000 },
  });

  const result = await pool.request().query(`
    SELECT
      m.HouseholdId, m.TenantId, t.Name AS Tenant,
      SUM(ISNULL(e.PremiumAmount,0)) AS PremiumSum,
      SUM(CASE WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product','Bundle'))
               AND e.ProductId IS NOT NULL AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
          THEN ISNULL(e.IncludedPaymentProcessingFeeAmount,0) ELSE 0 END) AS IncludedOnProducts,
      SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN ISNULL(e.PremiumAmount,0) ELSE 0 END) AS PpfOnFeeRow,
      (SELECT TOP 1 ISNULL(u.FirstName,'')+' '+ISNULL(u.LastName,'') FROM oe.Members pm JOIN oe.Users u ON u.UserId=pm.UserId
         WHERE pm.HouseholdId=m.HouseholdId
         ORDER BY CASE WHEN pm.RelationshipType IN ('Self','Subscriber','Primary','Employee') THEN 0 ELSE 1 END, pm.MemberSequence) AS PrimaryMember,
      (SELECT TOP 1 i.TotalAmount FROM oe.Invoices i WHERE i.HouseholdId=m.HouseholdId ORDER BY i.DueDate DESC) AS LatestInvoice,
      (SELECT TOP 1 i.DueDate FROM oe.Invoices i WHERE i.HouseholdId=m.HouseholdId ORDER BY i.DueDate DESC) AS LatestDue
    FROM oe.Members m
    JOIN oe.Enrollments e ON e.MemberId = m.MemberId
    JOIN oe.Tenants t ON t.TenantId = m.TenantId
    WHERE e.Status NOT IN ('Cancelled','Declined')
      AND ISNULL(e.IsPendingMigration,0) = 0
      AND e.EffectiveDate <= GETUTCDATE()
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      ${tenantFilter ? 'AND m.TenantId = @tenant' : ''}
    GROUP BY m.HouseholdId, m.TenantId, t.Name
  `.replace('@tenant', tenantFilter ? `'${tenantFilter}'` : ''));

  const rows = result.recordset || [];
  const out = [];
  let overCount = 0, overMonthly = 0;
  const buckets = { OVER_BILLED: 0, CORRECT: 0, UNDER_BILLED: 0, NO_INVOICE: 0 };

  for (const r of rows) {
    const correct = correctMonthlyDue({ premiumSum: r.PremiumSum, includedOnProducts: r.IncludedOnProducts, ppfOnFeeRow: r.PpfOnFeeRow });
    const inv = r.LatestInvoice == null ? null : Math.round(Number(r.LatestInvoice) * 100) / 100;
    let status;
    if (inv == null) status = 'NO_INVOICE';
    else if (Math.abs(inv - correct) < 0.01) status = 'CORRECT';
    else if (inv > correct + 0.01) status = 'OVER_BILLED';
    else status = 'UNDER_BILLED';
    buckets[status]++;
    if (status === 'OVER_BILLED') { overCount++; overMonthly += inv - correct; }
    out.push({
      Tenant: r.Tenant,
      Member: (r.PrimaryMember || '').replace(/,/g, ' ').trim(),
      CorrectDue: correct,
      LatestInvoice: inv == null ? 'NONE' : inv,
      Overcharge: inv == null ? 0 : Math.round((inv - correct) * 100) / 100,
      IncludedOnProducts: Math.round(Number(r.IncludedOnProducts) * 100) / 100,
      PpfRow: Math.round(Number(r.PpfOnFeeRow) * 100) / 100,
      Status: status,
    });
  }

  out.sort((a, b) => b.Overcharge - a.Overcharge);
  const csvPath = path.join(__dirname, '../../ai_scripts/included-fee-overcharge-audit.csv');
  const header = 'Tenant,Member,CorrectDue,LatestInvoice,Overcharge,IncludedOnProducts,PpfRow,Status';
  fs.writeFileSync(csvPath, header + '\n' + out.map(o =>
    [o.Tenant, o.Member, o.CorrectDue, o.LatestInvoice, o.Overcharge, o.IncludedOnProducts, o.PpfRow, o.Status].join(',')
  ).join('\n') + '\n');

  console.log(`households evaluated: ${rows.length}`);
  console.log('status breakdown:', buckets);
  console.log(`OVER_BILLED: ${overCount} households, $${overMonthly.toFixed(2)}/mo total overcharge`);
  console.log(`report: ${csvPath}`);
  console.log('\ntop over-billed:');
  out.filter(o => o.Status === 'OVER_BILLED').slice(0, 20).forEach(o =>
    console.log(`  ${o.Member}: due $${o.CorrectDue} billed $${o.LatestInvoice} (+$${o.Overcharge}) [incl ${o.IncludedOnProducts} / ppfRow ${o.PpfRow}]`));

  await pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
