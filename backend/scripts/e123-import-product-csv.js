#!/usr/bin/env node
'use strict';

/**
 * Build E123 product JSON from broker CSV exports (no Playwright).
 *
 * Usage:
 *   node scripts/e123-import-product-csv.js --pdid 45173 --csv ~/Downloads/775982_Product_*.csv
 *   node scripts/e123-import-product-csv.js --pdid 45173 \
 *     --csv ~/Downloads/775982_Product_052026201612.csv \
 *     --csv ~/Downloads/775982_Product_052026201626.csv
 */

const fs = require('fs');
const path = require('path');
const { buildProductExportFromCsv } = require('../services/migration/e123CsvExport/csvParser');

const DEFAULT_OUTPUT_DIR = path.join(__dirname, '../data/e123-product-export');

function expandGlobs(patterns) {
  const files = [];
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const dir = path.dirname(pattern);
      const base = path.basename(pattern);
      const re = new RegExp(`^${base.replace(/\*/g, '.*')}$`);
      for (const name of fs.readdirSync(dir)) {
        if (re.test(name)) files.push(path.join(dir, name));
      }
    } else {
      files.push(pattern);
    }
  }
  return [...new Set(files)].sort();
}

function parseArgs(argv) {
  const args = { pdid: null, csv: [], out: DEFAULT_OUTPUT_DIR };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--pdid') args.pdid = Number(argv[++i]);
    else if (argv[i] === '--csv') args.csv.push(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.pdid || !Number.isFinite(args.pdid) || !args.csv.length) {
    console.error('Usage: node scripts/e123-import-product-csv.js --pdid <id> --csv <file> [--csv <file> ...]');
    process.exit(1);
  }

  const csvPaths = expandGlobs(args.csv.map((p) => p.replace(/^~/, process.env.HOME || '')));
  const missing = csvPaths.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error('Missing CSV files:', missing.join(', '));
    process.exit(1);
  }

  console.log(`Importing product ${args.pdid} from ${csvPaths.length} CSV file(s)...`);
  const exportDoc = buildProductExportFromCsv(args.pdid, csvPaths);

  fs.mkdirSync(args.out, { recursive: true });
  const outPath = path.join(args.out, `${args.pdid}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(exportDoc, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify({
    pdid: exportDoc.pdid,
    label: exportDoc.label,
    source: exportDoc.source,
    pricingRows: exportDoc.stats.pricingRowCount,
    vendorCostRows: exportDoc.stats.vendorCostRowCount,
    currentVendorRows: exportDoc.stats.currentVendorCostRowCount,
    derivedTiers: exportDoc.derivedTiers.map((t) => ({
      tier: t.tierCode,
      benefit: t.benefitLabel,
      ages: [t.memberAgeMin, t.memberAgeMax],
      msrp: t.msrpRate,
      net: t.netRate,
      override: t.overrideRate,
      other: t.otherFees,
      commission: t.commission
    }))
  }, null, 2));
}

main();
