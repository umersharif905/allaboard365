#!/usr/bin/env node
'use strict';

/**
 * Manual runner for the weekly DIME ledger reconcile service.
 *
 * Dry-run (default) computes + prints findings and writes NOTHING (no integration
 * errors, no billing rows) — safe against prod with a read-only login.
 *
 * Usage:
 *   node scripts/run-ledger-reconcile.cjs --tenant <uuid> [--lookback 45] [--max 500] [--write]
 *   --write  → also record integration-error rows (requires a writable login)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { runDimeLedgerReconcile } = require('../services/dimeLedgerReconcile.service');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

async function main() {
  const tenantId = arg('--tenant', null);
  const dryRun = !process.argv.includes('--write');
  const lookbackDays = Number(arg('--lookback', 45));
  const maxHouseholds = Number(arg('--max', 500));

  console.log(`\n=== DIME ledger reconcile (${dryRun ? 'DRY-RUN — no writes' : 'WRITE'}) ===`);
  console.log(`tenant=${tenantId || 'ALL'} lookbackDays=${lookbackDays} maxHouseholds=${maxHouseholds}`);
  console.log(`DB=${process.env.DB_NAME}@${process.env.DB_SERVER} user=${process.env.DB_USER}\n`);

  const res = await runDimeLedgerReconcile({ tenantId, dryRun, lookbackDays, maxHouseholds });

  for (const t of res.tenants) {
    if (t.skipped) {
      console.log(`-- tenant ${t.tenantId}: SKIPPED (${t.reason})`);
      continue;
    }
    if (t.ok === false) {
      console.log(`-- tenant ${t.tenantId}: ERROR ${t.error}`);
      continue;
    }
    console.log(
      `-- ${t.tenantName || t.tenantId}: candidates=${t.candidateCount} scanned=${t.scanned} ` +
      `apiErrors=${t.apiErrors} overstated=${t.overstatedCount} understated=${t.understatedCount} ` +
      `(window ${t.window.startDate}..${t.window.endDate})`
    );
    for (const d of t.discrepancies) {
      const parts = [];
      if (d.overstatedCents > 0) parts.push(`overstated ${money(d.overstatedCents)} [${d.overstatedTxns.join(', ')}]`);
      if (d.understatedCents > 0) parts.push(`understated ${money(d.understatedCents)} [${d.understatedTxns.join(', ')}]`);
      console.log(
        `   [${d.status.toUpperCase()}] ${d.name || d.householdId} ` +
        `(DB=${money(d.dbCompletedCents)} settled=${money(d.dimeSettledCents)} bounced=${money(d.dimeBouncedCents)}) ` +
        parts.join(' | ')
      );
    }
    const fetchErrs = (t.findings || []).filter((f) => f.error);
    if (fetchErrs.length) {
      console.log(`   ${fetchErrs.length} ledger-fetch error(s):`);
      for (const f of fetchErrs.slice(0, 10)) console.log(`     - ${f.name || f.householdId}: ${f.error}`);
    }
  }

  console.log(`\n=== totals: ${JSON.stringify(res.totals)} ===`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('ledger reconcile run failed:', e.response?.data || e.message || e);
  process.exit(1);
});
