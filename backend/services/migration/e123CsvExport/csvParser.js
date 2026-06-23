'use strict';

const fs = require('fs');
const path = require('path');

function normalizeHeaderName(header) {
  return String(header || '').replace(/^\ufeff/, '').trim();
}

/** Parse E123 Product ID from a CSV cell (handles BOM, commas, whitespace). */
function parseProductId(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/^\ufeff/, '').trim().replace(/,/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

function productIdFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  for (const key of Object.keys(row)) {
    if (normalizeHeaderName(key).toLowerCase() === 'product id') {
      return parseProductId(row[key]);
    }
  }
  return parseProductId(row['Product ID'] ?? row.ProductID ?? row.pdid ?? row.Pdid);
}

function rowMatchesProductId(row, pdid) {
  return productIdFromRow(row) === pdid;
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function readCsvFromText(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const rawHeaders = parseCsvLine(lines[0]);
  const headers = rawHeaders.map(normalizeHeaderName);
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      if (!h) return;
      row[h] = String(values[i] ?? '').replace(/^\ufeff/, '').trim();
    });
    return row;
  });
  return { headers, rows };
}

function readCsv(filePath) {
  return readCsvFromText(fs.readFileSync(filePath, 'utf8'));
}

function readCsvFromBuffer(buffer) {
  return readCsvFromText(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer));
}

function num(val) {
  if (val == null || val === '') return null;
  const n = Number(String(val).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function inferTierCode(benefitLabel) {
  const label = String(benefitLabel || '').toLowerCase();
  if (/member only/.test(label)) return 'EE';
  if (/member \+ spouse/.test(label) && !/child/.test(label)) return 'ES';
  if (/member \+ child/.test(label)) return 'EC';
  if (/family/.test(label)) return 'EF';
  return null;
}

function isMerchantOrProcessingFeeVendor(vendorName, priceType) {
  if (/processor fee/i.test(priceType || '')) return true;
  const n = String(vendorName || '').toLowerCase();
  return /merchant\s*fee|processing\s*fee|^merchant fee$/.test(n)
    || (n.includes('merchant') && n.includes('fee'));
}

function vendorBucket(vendorName, priceType) {
  if (isMerchantOrProcessingFeeVendor(vendorName, priceType)) return 'exclude';
  const n = String(vendorName || '').toLowerCase();
  // Primary underwriter / net payee on the product vendor record
  if (n.includes('apex')) return 'net';
  if (n.includes('sharewell') && !n.includes('partner')) return 'net';
  // Misc payees — route to AB365 override bucket for ACH wiring later
  if (n.includes('mwp admin') || n.includes('tpa')) return 'override';
  if (n.includes('lyric') || n.includes('partner') || n.includes('mightywell')) return 'override';
  return 'override';
}

/** Re-map legacy snapshot rows that stored misc vendors as bucket "other". */
function resolveVendorAllocationBucket(vendor, overrides = {}) {
  if (!vendor) return 'override';
  const vendorId = String(vendor.vendorId ?? vendor['Agent ID'] ?? '').trim();
  const vendorName = String(vendor.vendorName || vendor.Label || '').trim();
  const vendorKey = vendorName.toLowerCase();
  if (vendorId && overrides[vendorId]) return overrides[vendorId];
  if (vendorKey && overrides[vendorKey]) return overrides[vendorKey];
  if (vendor.bucket === 'processor' || vendor.bucket === 'exclude') return 'exclude';
  if (vendor.bucket === 'other') {
    return vendorBucket(vendorName, vendor.includedPriceTypes || vendor.priceTypes);
  }
  return vendor.bucket || vendorBucket(vendorName, vendor.includedPriceTypes || vendor.priceTypes);
}

function normalizeVendorRoutingKey(vendorName, vendorId) {
  const id = vendorId != null ? String(vendorId).trim() : '';
  if (id) return id;
  return String(vendorName || '').trim().toLowerCase();
}

function isCurrentPricingRow(row) {
  if (row.Type !== 'Product') return false;
  const stop = row['Display Stop'];
  if (stop && /11\/30\/2025|12\/31\/2025/i.test(stop)) return false;
  const start = row['Display Start'];
  if (start && /12\/01\/2025|01\/01\/2026/i.test(start)) return true;
  return !stop;
}

function isCurrentVendorRow(row) {
  if (/processor fee/i.test(row.includedPriceTypes || '')) return false;
  const covEnd = row.transactionCoverageEndDate;
  if (covEnd && /12\/31\/2025/i.test(covEnd)) return false;
  const txEnd = row.transactionEndDate;
  if (txEnd && /(aug|sep|feb|dec).*2025/i.test(txEnd)) return false;

  const covStart = row.transactionCoverageStartDate;
  if (covStart && /01\/01\/2026/i.test(covStart)) return true;

  // Benefit-scoped vendor costs (Sharewell per EE/ES/EC/EF) — active when not expired
  const benefitId = num(row.benefit_id);
  if (benefitId != null && !covEnd && !txEnd) {
    const priceTypes = row.includedPriceTypes || 'Product';
    return priceTypes === 'Product' || !priceTypes;
  }

  // Product-wide flat fees (Lyric, Partners, etc.) — active when not explicitly ended
  if (!row.benefit_id && !covEnd && !txEnd) {
    const priceTypes = row.includedPriceTypes || 'Product';
    return !priceTypes || priceTypes === 'Product';
  }
  return false;
}

/** Active check for stored snapshot vendorCosts rows (re-evaluates bad isCurrent flags). */
function isVendorCostActive(row) {
  if (/processor fee/i.test(row.priceTypes || row.includedPriceTypes || '')) return false;
  const covEnd = row.coverageEnd || row.transactionCoverageEndDate;
  if (covEnd && /12\/31\/2025/i.test(covEnd)) return false;
  const txEnd = row.transactionEnd || row.transactionEndDate;
  if (txEnd && /(aug|sep|feb|dec).*2025/i.test(txEnd)) return false;

  const covStart = row.coverageStart || row.transactionCoverageStartDate;
  if (covStart && /01\/01\/2026/i.test(covStart)) return true;

  const benefitId = row.benefitId ?? num(row.benefit_id);
  if (benefitId != null && !covEnd && !txEnd) {
    const priceTypes = row.priceTypes || row.includedPriceTypes || 'Product';
    return priceTypes === 'Product' || !priceTypes;
  }

  if ((benefitId == null || benefitId === '') && !covEnd && !txEnd) {
    const priceTypes = row.priceTypes || row.includedPriceTypes;
    return !priceTypes || priceTypes === 'Product';
  }

  return false;
}

function agesMatch(pricing, vendor) {
  const pMin = num(pricing['Member Age Minimum']);
  const pMax = num(pricing['Member Age Maximum']);
  const vMin = num(vendor.minAge);
  const vMax = num(vendor.maxAge);

  if (vMin == null && vMax == null) return true;
  if (pMin == null && pMax == null) return vMin == null && vMax == null;
  if (pMin == null || pMax == null) return false;
  if (vMin == null || vMax == null) return false;

  // Pricing 40-67 matches vendor 40-65 (E123 inconsistency)
  if (pMin === vMin && (pMax === vMax || Math.abs(pMax - vMax) <= 2)) return true;
  return pMin === vMin && pMax === vMax;
}

function benefitsMatch(pricing, vendor) {
  const pBenefit = num(pricing['Benefit ID']);
  const vBenefit = num(vendor.benefit_id);
  if (vBenefit == null) return true;
  return pBenefit === vBenefit;
}

function matchVendorToPricing(pricing, vendor) {
  if (!benefitsMatch(pricing, vendor)) return false;
  if (!agesMatch(pricing, vendor)) return false;

  const vSpouseMin = num(vendor.minAgeSpouse);
  const vSpouseMax = num(vendor.maxAgeSpouse);
  if (vSpouseMin != null || vSpouseMax != null) {
    const pMin = num(pricing['Member Age Minimum']);
    const pMax = num(pricing['Member Age Maximum']);
    // Pricing rows without spouse dimensions: prefer vendor rows where member band matches
    // and spouse band is the "default" (18-39 when member is 18-39)
    if (pMin === 18 && pMax === 39 && vSpouseMin === 18 && vSpouseMax === 39) return true;
    if (pMin === 40 && pMax === 67 && vSpouseMin === 40 && vSpouseMax === 67) return true;
    if (pMin === 40 && pMax === 67 && vSpouseMin === 18 && vSpouseMax === 39) return false;
    if (pMin === 18 && pMax === 39 && vSpouseMin === 40) return false;
  }
  return true;
}

function scoreVendorPricingMatch(vendor, pricing) {
  let score = 0;
  const pBenefit = num(pricing['Benefit ID']);
  const vBenefit = num(vendor.benefit_id);
  if (vBenefit != null && pBenefit === vBenefit) score += 1000;
  const vendorTier = inferTierCode(vendor.benefit_label);
  const pricingTier = inferTierCode(pricing['Benefit Label']);
  if (vendorTier && pricingTier && vendorTier === pricingTier) score += 400;
  const vendorLabel = String(vendor.benefit_label || '').trim().toLowerCase();
  const pricingLabel = String(pricing['Benefit Label'] || '').trim().toLowerCase();
  if (vendorLabel && pricingLabel && vendorLabel === pricingLabel) score += 300;
  if (vendor.minAge !== '' && vendor.minAge != null) score += 100;
  if (vBenefit == null && !vendorLabel && !vendorTier) score += 1;
  return score;
}

function pickVendorRows(pricing, vendorRows) {
  const current = vendorRows.filter(isCurrentVendorRow);
  const matched = current.filter((v) => matchVendorToPricing(pricing, v));

  const byVendor = new Map();
  for (const row of matched) {
    const key = row['Agent ID'] || row.Label;
    const score = scoreVendorPricingMatch(row, pricing);
    const existing = byVendor.get(key);
    if (!existing || score > existing.score) {
      byVendor.set(key, { row, score });
    }
  }
  return [...byVendor.values()].map((entry) => entry.row);
}

function deriveTierAllocations(pricingRows, vendorRows) {
  return pricingRows.map((price) => {
    const vendors = pickVendorRows(price, vendorRows);
    let netRate = 0;
    let overrideRate = 0;
    let otherFees = 0;
    const vendorBreakdown = [];

    for (const v of vendors) {
      const bucket = vendorBucket(v.Label, v.includedPriceTypes);
      const amt = v.feeType === 'percent' ? 0 : (num(v.cost) || 0);
      if (bucket === 'processor') continue;
      vendorBreakdown.push({
        vendorName: v.Label,
        vendorId: num(v['Agent ID']),
        bucket,
        amount: amt,
        benefitId: num(v.benefit_id),
        memberAgeMin: num(v.minAge),
        memberAgeMax: num(v.maxAge)
      });
      if (bucket === 'net') netRate += amt;
      else if (bucket === 'override') overrideRate += amt;
      else otherFees += amt;
    }

    const msrp = num(price.Price);
    const commission = Math.max(0, Math.round((msrp - netRate - overrideRate - otherFees) * 100) / 100);

    return {
      tierCode: inferTierCode(price['Benefit Label']),
      benefitLabel: price['Benefit Label'],
      benefitId: num(price['Benefit ID']),
      memberAgeMin: num(price['Member Age Minimum']),
      memberAgeMax: num(price['Member Age Maximum']),
      msrpRate: msrp,
      netRate: Math.round(netRate * 100) / 100,
      overrideRate: Math.round(overrideRate * 100) / 100,
      commission,
      otherFees: Math.round(otherFees * 100) / 100,
      displayStart: price['Display Start'] || null,
      displayStop: price['Display Stop'] || null,
      vendorBreakdown
    };
  });
}

const CSV_KIND_LABELS = {
  setup: 'Product Information',
  pricing: 'Pricing Matrix',
  vendorCosts: 'Vendor Costs',
  fulfillment: 'Vendor Products',
  content: 'Product Content'
};

const REQUIRED_CSV_KINDS = ['setup', 'pricing', 'vendorCosts', 'content', 'fulfillment'];

function detectCsvKind(headers) {
  const h = new Set(headers);
  if (h.has('feeType') && h.has('transactionCoverageStartDate')) return 'vendorCosts';
  if (h.has('Price') && h.has('Benefit ID')) return 'pricing';
  if (h.has('Admin Label') && h.has('Commissionable')) return 'setup';
  if (h.has('Content Label') && h.has('Document Name')) return 'content';
  if (h.has('CardIssuerID') || (h.has('Short HTML') && h.has('Agent ID'))) return 'fulfillment';
  return 'unknown';
}

function inferBrokerIdFromFilenames(filenames = []) {
  for (const name of filenames) {
    const match = String(name || '').match(/^(\d+)_Product_/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function loadCsvBundle(csvPaths) {
  const inputs = csvPaths.map((filePath) => ({
    originalname: path.basename(filePath),
    buffer: fs.readFileSync(filePath)
  }));
  return loadCsvBundleFromUploads(inputs);
}

function loadCsvBundleFromUploads(uploads = []) {
  const parsed = uploads.map((file) => {
    const { headers, rows } = readCsvFromBuffer(file.buffer);
    return {
      file,
      headers,
      rows,
      kind: detectCsvKind(headers)
    };
  });

  // If the user selects extra copies, keep the largest recognized export per kind.
  const bestByKind = new Map();
  for (const item of parsed) {
    if (item.kind === 'unknown') continue;
    const existing = bestByKind.get(item.kind);
    if (!existing || item.rows.length > existing.rows.length) {
      bestByKind.set(item.kind, item);
    }
  }

  const bundle = { pricing: [], vendorCosts: [], setup: [], content: [], fulfillment: [] };
  const manifest = [];

  for (const [kind, item] of bestByKind.entries()) {
    bundle[kind].push(...item.rows);
    manifest.push({
      kind,
      kindLabel: CSV_KIND_LABELS[kind] || 'Unknown',
      originalName: item.file.originalname || null,
      rowCount: item.rows.length
    });
  }

  for (const item of parsed) {
    if (item.kind === 'unknown') {
      manifest.push({
        kind: 'unknown',
        kindLabel: 'Unknown',
        originalName: item.file.originalname || null,
        rowCount: item.rows.length
      });
    }
  }

  const kindsPresent = new Set(manifest.filter((m) => m.kind !== 'unknown').map((m) => m.kind));
  const missingKinds = REQUIRED_CSV_KINDS.filter((k) => !kindsPresent.has(k));

  return { bundle, manifest, missingKinds };
}

function collectProductIds(bundle) {
  const ids = new Set();
  for (const rows of Object.values(bundle)) {
    for (const row of rows) {
      const pdid = productIdFromRow(row);
      if (pdid != null) ids.add(pdid);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function buildProductSnapshotFromBundle(pdid, bundle) {
  const pdidNum = parseProductId(pdid);
  if (pdidNum == null) return null;

  const pricingMatrix = bundle.pricing
    .filter((r) => rowMatchesProductId(r, pdidNum) && isCurrentPricingRow(r))
    .map((r) => ({
      recordId: null,
      type: r.Type,
      amount: num(r.Price),
      period: r['Period Label'] || 'Monthly',
      benefitLabel: r['Benefit Label'],
      benefitId: num(r['Benefit ID']),
      memberAgeMin: num(r['Member Age Minimum']),
      memberAgeMax: num(r['Member Age Maximum']),
      displayStart: r['Display Start'] || null,
      displayStop: r['Display Stop'] || null,
      commissionableAmount: num(r['Commissionable Amount'])
    }));

  const vendorCosts = bundle.vendorCosts
    .filter((r) => rowMatchesProductId(r, pdidNum))
    .map((r) => ({
      vendorName: r.Label,
      vendorId: num(r['Agent ID']),
      amount: r.feeType === 'dollar' ? num(r.cost) : null,
      amountPercent: r.feeType === 'percent' ? num(r.cost) : null,
      benefitId: num(r.benefit_id),
      benefitLabel: r.benefit_label,
      memberAgeMin: num(r.minAge),
      memberAgeMax: num(r.maxAge),
      spouseAgeMin: num(r.minAgeSpouse),
      spouseAgeMax: num(r.maxAgeSpouse),
      priceTypes: r.includedPriceTypes,
      coverageStart: r.transactionCoverageStartDate || null,
      coverageEnd: r.transactionCoverageEndDate || null,
      transactionStart: r.transactionStartDate || null,
      transactionEnd: r.transactionEndDate || null,
      isCurrent: isCurrentVendorRow(r)
    }));

  const setupRows = bundle.setup.filter((r) => rowMatchesProductId(r, pdidNum));
  const setup = setupRows[0] ? {
    adminLabel: setupRows[0]['Admin Label'],
    displayLabel: setupRows[0]['Display Label'],
    category: setupRows[0].Category1,
    subCategory: setupRows[0]['Sub-Category'],
    noSaleStates: (setupRows[0]['No Sale States'] || '').split(',').map((s) => s.trim()).filter(Boolean),
    productIsCommissionable: setupRows[0].Commissionable === 'Yes',
    bundleWithOtherProducts: setupRows[0].Bundle === 'Yes',
    priceByAge: setupRows[0]['Price By Age'] === 'Yes',
    priceBySpouseAge: setupRows[0]['Price By Spouse Age'] === 'Yes'
  } : {};

  const label = pricingMatrix[0]?.benefitLabel
    ? setup.displayLabel || setupRows[0]?.['Display Label']
    : setup.displayLabel;

  const derivedTiers = deriveTierAllocations(
    bundle.pricing.filter((r) => rowMatchesProductId(r, pdidNum) && isCurrentPricingRow(r)),
    bundle.vendorCosts.filter((r) => rowMatchesProductId(r, pdidNum))
  );

  return {
    pdid: pdidNum,
    label: setup.displayLabel || setup.adminLabel || null,
    exportedAt: new Date().toISOString(),
    source: 'e123-csv-export',
    setup,
    pricingMatrix,
    vendorCosts,
    derivedTiers,
    content: {
      documents: bundle.content.filter((r) => rowMatchesProductId(r, pdidNum)),
      fulfillment: bundle.fulfillment.filter((r) => rowMatchesProductId(r, pdidNum))
    },
    stats: {
      pricingRowCount: pricingMatrix.length,
      vendorCostRowCount: vendorCosts.length,
      currentVendorCostRowCount: vendorCosts.filter((r) => r.isCurrent).length,
      derivedTierCount: derivedTiers.length
    }
  };
}

function buildCatalogFromBundle(bundle) {
  const productIds = collectProductIds(bundle);
  const products = productIds
    .map((pdid) => buildProductSnapshotFromBundle(pdid, bundle))
    .filter(Boolean);
  return {
    productCount: products.length,
    products
  };
}

function buildProductExportFromCsv(pdid, csvPaths) {
  const { bundle } = loadCsvBundle(csvPaths);
  return buildProductSnapshotFromBundle(pdid, bundle);
}

module.exports = {
  readCsv,
  readCsvFromBuffer,
  readCsvFromText,
  detectCsvKind,
  normalizeHeaderName,
  parseProductId,
  productIdFromRow,
  CSV_KIND_LABELS,
  REQUIRED_CSV_KINDS,
  inferBrokerIdFromFilenames,
  loadCsvBundle,
  loadCsvBundleFromUploads,
  collectProductIds,
  isCurrentPricingRow,
  isCurrentVendorRow,
  isVendorCostActive,
  inferTierCode,
  deriveTierAllocations,
  isMerchantOrProcessingFeeVendor,
  vendorBucket,
  resolveVendorAllocationBucket,
  normalizeVendorRoutingKey,
  buildProductSnapshotFromBundle,
  buildCatalogFromBundle,
  buildProductExportFromCsv
};
