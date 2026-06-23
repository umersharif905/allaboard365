#!/usr/bin/env node
'use strict';

/**
 * Export ShareWELL eligibility data from live SQL to standard 24-column CSVs.
 *
 * Usage:
 *   node ai_scripts/sharewell-export.js [--slug=align_health] [--as-of-date=2026-05-01]
 *
 * Align / Align SHA: partner + active-as-of (matches invoice_generator).
 * Other slugs: full account dump (all member_products rows).
 *
 * Output: ~/Downloads/sharewell-YYYY-MM-DD/{slug}.csv
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sql = require('mssql');

// Env loaded by sharewell-export.sh (same pattern as db-query.sh)

const {
  SHAREWELL_ACCOUNTS,
  mapDbRowToStandard,
  rowsToCsv,
  buildAccountQuery,
  pickExportProductRows,
  buildPartnerPricingQuery,
  applyInvoicePricingToRows,
} = require('../backend/utils/sharewellExportMapping');

function parseArgs(argv) {
  const slugArg = argv.find((a) => a.startsWith('--slug='));
  const slug = slugArg ? slugArg.split('=')[1] : null;
  const asOfArg = argv.find((a) => a.startsWith('--as-of-date='));
  const asOfDate = asOfArg ? asOfArg.split('=')[1] : new Date().toISOString().slice(0, 10);
  return { slug, asOfDate };
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid --as-of-date: ${value} (use YYYY-MM-DD)`);
  }
  return value;
}

function getDbConfig() {
  const server = process.env.SHAREWELL_DB_SERVER || process.env.DB_SERVER;
  const database = process.env.SHAREWELL_DB_DATABASE || process.env.SHAREWELL_DB_NAME || 'ShareWELLPartners';
  const user = process.env.SHAREWELL_DB_USER || process.env.DB_USER;
  const password = process.env.SHAREWELL_DB_PASSWORD || process.env.DB_PASSWORD;
  return {
    user,
    password,
    server,
    database,
    options: { encrypt: true, trustServerCertificate: false },
  };
}

async function exportAccount(pool, slug, outDir, asOfDate) {
  const cfg = SHAREWELL_ACCOUNTS[slug];
  const built = buildAccountQuery(slug, asOfDate);
  const request = pool.request();
  let recordset;

  if (built && built.pickProducts) {
    request.input('partnerName', sql.NVarChar(100), built.partnerName);
    request.input('asOfDate', sql.Date, built.asOfDate);
    const result = await request.query(built.query);
    recordset = pickExportProductRows(result.recordset || []);
    const pricingBuilt = buildPartnerPricingQuery(built.partnerName);
    const pricingReq = pool.request();
    pricingReq.input('partnerName', sql.NVarChar(100), pricingBuilt.partnerName);
    const pricingResult = await pricingReq.query(pricingBuilt.query);
    recordset = applyInvoicePricingToRows(recordset, pricingResult.recordset || []);
  } else {
    const sqlText = typeof built === 'string' ? built : built.query;
    const result = await pool.request().query(sqlText);
    recordset = result.recordset || [];
  }

  const mapped = recordset.map((row) => mapDbRowToStandard(row, slug));
  const csv = rowsToCsv(mapped);
  const filePath = path.join(outDir, `${slug}.csv`);
  fs.writeFileSync(filePath, csv, 'utf8');
  const primaries = mapped.filter((r) => r.Relationship === 'P').length;
  return {
    slug,
    label: cfg.label,
    rows: mapped.length,
    primaries,
    asOfDate: built.asOfDate || null,
    filePath,
  };
}

async function main() {
  const { slug, asOfDate } = parseArgs(process.argv.slice(2));
  parseIsoDate(asOfDate);
  const dbConfig = getDbConfig();

  if (!dbConfig.password || !dbConfig.server || !dbConfig.user) {
    console.error('❌ Missing SHAREWELL_DB_SERVER, SHAREWELL_DB_USER, or SHAREWELL_DB_PASSWORD in ai_scripts/.env');
    process.exit(1);
  }

  const outDir = path.join(os.homedir(), 'Downloads', `sharewell-${asOfDate}`);
  fs.mkdirSync(outDir, { recursive: true });

  const slugs = slug ? [slug] : Object.keys(SHAREWELL_ACCOUNTS);
  console.log(`📊 Connecting to ShareWELL ${dbConfig.database} @ ${dbConfig.server}…`);
  console.log(`📅 As-of date: ${asOfDate} (Align/SHA use invoice-active rules)`);

  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const summaries = [];
    for (const s of slugs) {
      console.log(`\n⏳ Exporting ${s}…`);
      summaries.push(await exportAccount(pool, s, outDir, asOfDate));
    }

    console.log('\n✅ Export complete');
    for (const s of summaries) {
      const extra = s.primaries != null ? `, ${s.primaries} primaries` : '';
      console.log(`   ${s.label}: ${s.rows} rows${extra} → ${s.filePath}`);
    }
  } catch (err) {
    console.error('❌ Export failed:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

main();
