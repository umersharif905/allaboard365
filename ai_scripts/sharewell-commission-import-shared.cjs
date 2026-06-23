'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('../backend/node_modules/xlsx');

const SHAREWELL_TENANT_ID = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6';
const XLSX_PATH = path.join(__dirname, 'ShareWELL-Commission-Groups.xlsx');
const SKIP_SHEETS = new Set(['Roster', 'Summary']);

/** Steve Schone = GA; keep default tenant SortOrder ladder (GA = 2). */
const GA_TOP_SORT_ORDER = 2;

const PRODUCTS = [
  { label: 'Sharewell Essential', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
  { label: 'Copay MEC', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
  { label: 'HAS MEC', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
  { label: 'Dental', families: ['Rate'], isPercent: true },
  { label: 'Vision', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
  { label: 'Labs', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
  { label: 'Sharewell Connected 1500/3000', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
  { label: 'Sharewell Connected 6000', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
  { label: 'Connected Wellness 1500/3000', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
  { label: 'Connected Wellness 6000', families: ['MO', 'MS-MC', 'MF'], isPercent: false },
];

const PRODUCT_NAME_CANDIDATES = {
  'Sharewell Essential': ['Essential (ShareWELL)', 'Essential (Sharewell) - 2025', 'Essential ShareWELL Memership'],
  'Copay MEC': ['Mightywell Copay MEC', 'Essential Copay'],
  'HAS MEC': ['Mightywell HSA MEC', 'eBenefits HSA MEC'],
  Dental: ['GetWell Dental'],
  Vision: ['MightyWELL Vision'],
  Labs: ['Quest Select'],
  'Sharewell Connected 1500/3000': ['ShareWELL Connect *', 'ShareWELL Plus '],
  'Sharewell Connected 6000': ['ShareWELL Connect *'],
  'Connected Wellness 1500/3000': ['Connected Wellness', 'Essential Wellness *'],
  'Connected Wellness 6000': ['Connected Wellness'],
};

const FAMILY_TO_EE = { MO: 'EE', 'MS-MC': ['ES', 'EC'], MF: 'EF', Rate: 'EE' };

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

function loadEnv(dbFlag) {
  loadEnvFile(path.join(__dirname, '../backend/.env'));
  if (dbFlag === '--testing') loadEnvFile(path.join(__dirname, '.env'));
}

function dbConfig(flag) {
  const server = process.env.DB_SERVER || 'allboard-prod.database.windows.net';
  if (flag === '--testing') {
    return {
      server,
      database: 'allaboard-testing',
      user: process.env.DB_USER_TESTING_RW || process.env.DB_USER,
      password: process.env.DB_PASSWORD_TESTING_RW || process.env.DB_PASSWORD,
      label: 'TESTING',
    };
  }
  return {
    server,
    database: process.env.DB_NAME || 'allaboard-prod',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    label: 'PROD',
  };
}

function parseAmount(raw, isPercent) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (isPercent) {
    const m = s.match(/([\d.]+)\s*%?/);
    return m ? Number(m[1]) : null;
  }
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function sheetTierToSortOrder(sheetTierNum, maxTier) {
  return sheetTierNum + (GA_TOP_SORT_ORDER - maxTier);
}

function sortOrderToName(sortOrder, levelNameBySort) {
  return levelNameBySort.get(sortOrder) || `Level ${sortOrder}`;
}

function parseGroupSheet(rows) {
  const meta = { name: '', upline: '', agencies: '', dualContext: false, exclude: false };
  let headerRowIdx = -1;
  let agentsSectionIdx = -1;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const c0 = String(r[0] || '').trim();
    if (i === 0 && c0) meta.name = c0;
    if (c0.startsWith('Upline:')) meta.upline = c0.replace(/^Upline:\s*/, '');
    if (c0.startsWith('Agencies using this group:')) meta.agencies = c0.replace(/^Agencies using this group:\s*/, '');
    if (/likely exclude/i.test(c0)) meta.exclude = true;
    if (/Individual vs Groups columns/i.test(c0)) meta.dualContext = true;
    if (c0 === 'Agent Tier') headerRowIdx = i;
    if (c0 === 'Agents in this tier') agentsSectionIdx = i;
  }

  if (headerRowIdx < 0) return null;

  const headers = rows[headerRowIdx].map((h) => String(h || '').trim());
  const tierRows = [];
  for (let i = headerRowIdx + 1; i < (agentsSectionIdx > 0 ? agentsSectionIdx : rows.length); i += 1) {
    const r = rows[i];
    if (!r || !r.length || !String(r[0] || '').trim()) break;
    if (String(r[0]).trim() === 'Agents in this tier') break;
    tierRows.push(r);
  }

  const tiers = tierRows.map((r) => {
    const label = String(r[0]).trim();
    const m = label.match(/Agent Tier (\d+)/);
    const tierNum = m ? Number(m[1]) : null;
    const values = {};
    for (let ci = 1; ci < headers.length; ci += 1) {
      const header = headers[ci];
      if (!header) continue;
      values[header] = r[ci];
    }
    return { tierLabel: label, tierNum, values };
  });

  const maxTier = tiers.reduce((m, t) => Math.max(m, t.tierNum || 0), 0);

  const agents = [];
  if (agentsSectionIdx >= 0) {
    for (let i = agentsSectionIdx + 2; i < rows.length; i += 1) {
      const r = rows[i];
      if (!r || !String(r[1] || '').trim()) continue;
      agents.push({
        tierLabel: String(r[0] || '').trim(),
        name: String(r[1] || '').trim(),
        e123Id: r[2] != null && r[2] !== '' ? Number(r[2]) : null,
        upline: String(r[3] || '').trim(),
      });
    }
  }

  return { meta, headers, tiers, maxTier, agents };
}

function extractProductTiersFromValues(values, product, dualContext) {
  const pt = {};
  const suffixes = dualContext ? ['Individual'] : [null];

  for (const suffix of suffixes) {
    for (const fam of product.families) {
      const famLabel = product.isPercent ? 'Rate (%)' : fam;
      const header = suffix
        ? `${product.label} ${famLabel} (${suffix})`
        : `${product.label} ${famLabel}`;
      const amount = parseAmount(values[header], product.isPercent);
      if (amount == null) continue;
      const map = FAMILY_TO_EE[fam];
      if (product.isPercent) {
        const rate = amount > 1 ? amount / 100 : amount;
        pt.EE = { rate };
      } else if (Array.isArray(map)) {
        for (const k of map) pt[k] = { flatAmount: amount };
      } else {
        pt[map] = { flatAmount: amount };
      }
    }
  }

  return Object.keys(pt).length ? pt : null;
}

function resolveProductId(label, tenantProducts) {
  const candidates = PRODUCT_NAME_CANDIDATES[label] || [label];
  for (const name of candidates) {
    const hit = tenantProducts.find((p) => p.Name.toLowerCase() === name.toLowerCase());
    if (hit) return { productId: hit.ProductId, productName: hit.Name, salesType: hit.SalesType };
  }
  const fuzzy = tenantProducts.find((p) => {
    const n = p.Name.toLowerCase();
    return candidates.some((c) => n.includes(c.toLowerCase().replace(/\*/g, '').trim()));
  });
  if (fuzzy) return { productId: fuzzy.ProductId, productName: fuzzy.Name, salesType: fuzzy.SalesType, fuzzy: true };
  return null;
}

function buildCommissionJsonForProduct(tiers, maxTier, product, dualContext, levelNameBySort) {
  const jsonTiers = [];

  for (const tier of tiers) {
    const sortOrder = sheetTierToSortOrder(tier.tierNum, maxTier);
    const productTiers = extractProductTiersFromValues(tier.values, product, dualContext);
    if (!productTiers) continue;

    const entry = {
      level: sortOrder,
      name: sortOrderToName(sortOrder, levelNameBySort),
      productTiers,
    };

    if (product.isPercent && productTiers.EE?.rate != null) {
      entry.rate = productTiers.EE.rate;
    }

    jsonTiers.push(entry);
  }

  if (!jsonTiers.length) return null;

  return {
    description: 'ShareWELL E123 import',
    renewable: false,
    type: product.isPercent ? 'percentage' : 'flatrate',
    tiers: jsonTiers,
  };
}

function loadWorkbookGroups() {
  if (!fs.existsSync(XLSX_PATH)) {
    throw new Error(`Missing xlsx: ${XLSX_PATH}`);
  }
  const wb = XLSX.readFile(XLSX_PATH);
  const groups = [];

  for (const sheetName of wb.SheetNames) {
    if (SKIP_SHEETS.has(sheetName)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    const parsed = parseGroupSheet(rows);
    if (!parsed) continue;

    const exclude = parsed.meta.exclude || /vendor copy/i.test(sheetName);
    groups.push({
      sheetName,
      groupName: sheetName,
      description: [parsed.meta.name, parsed.meta.upline, parsed.meta.agencies].filter(Boolean).join(' · '),
      excludeFromImport: exclude,
      dualContext: parsed.meta.dualContext,
      ...parsed,
    });
  }

  return groups;
}

function buildImportPlan({ groups, tenantProducts, levelNameBySort }) {
  const importGroups = [];
  const skipped = [];
  const productGaps = new Set();

  for (const group of groups) {
    if (group.excludeFromImport) {
      skipped.push({ groupName: group.groupName, reason: 'excluded' });
      continue;
    }

    const rules = [];
    for (const product of PRODUCTS) {
      const resolved = resolveProductId(product.label, tenantProducts);
      const hasAmounts = group.tiers.some((t) =>
        extractProductTiersFromValues(t.values, product, group.dualContext)
      );
      if (!resolved) {
        if (hasAmounts) productGaps.add(product.label);
        continue;
      }

      const commissionJson = buildCommissionJsonForProduct(
        group.tiers,
        group.maxTier,
        product,
        group.dualContext,
        levelNameBySort
      );
      if (!commissionJson) continue;

      rules.push({
        ruleName: `${group.groupName} — ${resolved.productName}`,
        productId: resolved.productId,
        productName: resolved.productName,
        commissionJson,
        tierLevels: commissionJson.tiers.map((t) => t.level),
      });
    }

    importGroups.push({
      groupName: group.groupName,
      description: group.description,
      agentCount: group.agents.length,
      tiers: group.tiers.map((t) => ({
        sheetTier: t.tierLabel,
        sortOrder: sheetTierToSortOrder(t.tierNum, group.maxTier),
        tenantLevel: sortOrderToName(sheetTierToSortOrder(t.tierNum, group.maxTier), levelNameBySort),
      })),
      rules,
    });
  }

  return { importGroups, skipped, productGaps: [...productGaps] };
}

module.exports = {
  SHAREWELL_TENANT_ID,
  XLSX_PATH,
  GA_TOP_SORT_ORDER,
  loadEnv,
  dbConfig,
  loadWorkbookGroups,
  buildImportPlan,
  sheetTierToSortOrder,
  sortOrderToName,
};
