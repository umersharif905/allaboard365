'use strict';

const { v4: uuidv4 } = require('uuid');
const migrationProductMapping = require('./migrationProductMapping.service');
const migrationBatch = require('./migrationBatch.service');
const { lookupBenefitsForProduct } = require('./e123BenefitCatalog.service');
const { fetchAgentProductCatalog } = require('./e123ProductCatalog.service');
const { resolveOrgBrokerId } = require('./orgBrokerResolver.service');
const { fetchProductRateGrid, lookupRateForBenefit } = require('./e123Rates.service');
const { getProductSnapshot } = require('./e123CatalogSnapshot.service');
const { loadProductWizardTemplate, loadTenantLogoUrl, loadReferencePricingRows } = require('./productWizardTemplate.service');
const {
  resolvePricingAllocation,
  buildAgeBandFromAllocation,
  flattenWizardPricingTiers,
  roundMoney
} = require('./e123PricingAllocation.service');
const { parseDate } = require('./householdNormalizer');
const { parseTierFromLabel } = require('./e123TierInference');
const {
  requiresTobaccoFromTiers,
  shouldUseTobaccoPricing,
  inferE123TobaccoPricingRecommendation
} = require('./e123TobaccoPricingInference');
const { resolveVendorAllocationBucket, vendorBucket, normalizeVendorRoutingKey, isVendorCostActive, inferTierCode, isMerchantOrProcessingFeeVendor } = require('./e123CsvExport/csvParser');

const TIER_CODES = ['EE', 'ES', 'EC', 'EF'];
const TIER_LABELS = {
  EE: 'Employee Only (EE)',
  ES: 'Employee + Spouse (ES)',
  EC: 'Employee + Child(ren) (EC)',
  EF: 'Employee + Family (EF)'
};

function wizardTierMapKey(tierCode, configValue1 = '') {
  const ua = configValue1 ? String(configValue1) : '';
  return ua ? `${tierCode}|${ua}` : tierCode;
}

function wizardTierLabel(tierCode, configValue1 = '', configFieldName = '') {
  const base = TIER_LABELS[tierCode] || tierCode;
  if (!configValue1) return base;
  const fieldLabel = configFieldName || 'Unshared Amount';
  return `${base} — ${fieldLabel} ${configValue1}`;
}

function sortWizardTierMapEntries(entries) {
  return [...entries].sort((a, b) => {
    const [codeA, uaA = ''] = a[0].split('|');
    const [codeB, uaB = ''] = b[0].split('|');
    const orderA = TIER_CODES.indexOf(codeA);
    const orderB = TIER_CODES.indexOf(codeB);
    if (orderA !== orderB) {
      return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
    }
    const numA = Number(uaA);
    const numB = Number(uaB);
    if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) {
      return numA - numB;
    }
    return String(uaA).localeCompare(String(uaB));
  });
}

function wizardTierIdentity(tier) {
  const configValue1 = tier?.ageBands?.find((band) => band.configValue1)?.configValue1 || '';
  return wizardTierMapKey(tier.tierType, configValue1);
}

const ALL_US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
];

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function inferSalesType(category) {
  const normalized = normalizeName(category);
  if (normalized.includes('group product') || normalized === 'group') return 'Group';
  if (normalized.includes('individual product') || normalized === 'individual') return 'Individual';
  return 'Both';
}

function parseStateCsv(value) {
  if (value == null || value === '') return [];
  return String(value)
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function inferAllowedStates(catalogEntry) {
  const noSale = [
    ...parseStateCsv(catalogEntry?.noSaleStates),
    ...parseStateCsv(catalogEntry?.defaultNoSaleStates)
  ];
  const uniqueNoSale = [...new Set(noSale)];
  if (!uniqueNoSale.length) return [...ALL_US_STATE_CODES];
  return ALL_US_STATE_CODES.filter((code) => !uniqueNoSale.includes(code));
}

function inferProductType(label, category) {
  const text = `${label || ''} ${category || ''}`.toLowerCase();
  if (/\bdental\b/.test(text)) return 'Dental';
  if (/\bvision\b/.test(text)) return 'Vision';
  if (/\blife\b/.test(text)) return 'Life Insurance';
  if (/\bdisabilit/.test(text)) return 'Disability';
  if (/\baccident\b/.test(text)) return 'Accident';
  if (/\bcritical\s+illness\b/.test(text)) return 'Critical Illness';
  if (/\bhospital\b/.test(text)) return 'Hospital Indemnity';
  if (/\btelemed/.test(text)) return 'Telemedicine';
  if (/\bsharewell|health\s*share|mec\b|essential|copay|\bhsa\b|healthcare|health\b/.test(text)) {
    return 'Healthcare';
  }
  return 'Other';
}

function inferRequiredLicenses(productType) {
  switch (productType) {
    case 'Healthcare':
    case 'Dental':
    case 'Vision':
    case 'Telemedicine':
    case 'Hospital Indemnity':
      return ['Health'];
    case 'Life Insurance':
      return ['Life Insurance'];
    case 'Disability':
      return ['Health'];
    case 'Accident':
    case 'Critical Illness':
      return ['Accident'];
    default:
      return ['None'];
  }
}

function inferVendorGroupIdProductType(label, category) {
  const text = `${label || ''} ${category || ''}`.toLowerCase();
  if (/\bhsa\b/.test(text)) return '2';
  if (/\bcopay\b/.test(text)) return '1';
  if (/\bessential\b|sharewell|health\s*share/.test(text)) return '0';
  return '';
}

function scoreVendorMatch(vendorName, { underwriter, label }) {
  const vendor = normalizeName(vendorName);
  if (!vendor) return 0;
  let score = 0;
  const under = normalizeName(underwriter);
  const productLabel = normalizeName(label);
  if (under && (vendor.includes(under) || under.includes(vendor))) score += 100;
  if (/sharewell/.test(productLabel) && /sharewell/.test(vendor)) score += 90;
  if (/mightywell|mighty well/.test(productLabel) && /mightywell|mighty well/.test(vendor)) score += 90;
  if (/apex/.test(productLabel) && /apex/.test(vendor)) score += 90;
  const tokens = productLabel.split(' ').filter((t) => t.length > 3);
  for (const token of tokens) {
    if (vendor.includes(token)) score += 15;
  }
  return score;
}

function resolveVendorId(subscribedProducts, hints = {}) {
  const vendorCounts = new Map();
  for (const product of subscribedProducts || []) {
    if (!product.vendorId) continue;
    vendorCounts.set(product.vendorId, (vendorCounts.get(product.vendorId) || 0) + 1);
  }

  let bestVendorId = '';
  let bestScore = 0;
  for (const product of subscribedProducts || []) {
    if (!product.vendorId) continue;
    const score = scoreVendorMatch(product.vendorName, hints);
    if (score > bestScore) {
      bestScore = score;
      bestVendorId = product.vendorId;
    }
  }
  if (bestVendorId && bestScore >= 40) {
    return { vendorId: bestVendorId, reason: 'Matched vendor name to E123 underwriter/product label' };
  }

  let topVendorId = '';
  let topCount = 0;
  for (const [vendorId, count] of vendorCounts.entries()) {
    if (count > topCount) {
      topCount = count;
      topVendorId = vendorId;
    }
  }
  if (topVendorId) {
    return { vendorId: topVendorId, reason: 'Used most common vendor on tenant catalog' };
  }

  const first = (subscribedProducts || []).find((p) => p.vendorId);
  if (first?.vendorId) {
    return { vendorId: first.vendorId, reason: 'Used first vendor from tenant catalog' };
  }
  return { vendorId: '', reason: 'No vendor found — select manually in wizard' };
}

function aggregateAgeRange(tiers = [], fallback = { min: 18, max: 64 }) {
  let min = null;
  let max = null;
  for (const tier of tiers) {
    const range = tier.memberAgeRange;
    if (!range) continue;
    min = min == null ? range.min : Math.min(min, range.min);
    max = max == null ? range.max : Math.max(max, range.max);
  }
  return {
    min: min != null ? Math.max(0, Math.floor(min)) : fallback.min,
    max: max != null ? Math.min(120, Math.ceil(max)) : fallback.max
  };
}

function extractUnsharedFromBenefitLabel(benefitLabel) {
  const match = String(benefitLabel || '').match(/\b(\d{3,5})\b/);
  return match ? match[1] : '';
}

function buildCatalogEntryFromSnapshot(snapshot) {
  if (!snapshot) return null;
  const setup = snapshot.setup || {};
  return {
    productId: snapshot.pdid,
    label: snapshot.label || setup.displayLabel || setup.adminLabel || '',
    category: setup.category || setup.subCategory || null,
    underwriter: null,
    description: null,
    noSaleStates: setup.noSaleStates?.length ? setup.noSaleStates.join(',') : null,
    defaultNoSaleStates: null,
    priceByAge: setup.priceByAge,
    priceBySpouseAge: setup.priceBySpouseAge
  };
}

function mergeCatalogEntries(snapshotEntry, apiEntry) {
  if (!snapshotEntry && !apiEntry) return null;
  const snap = snapshotEntry || {};
  const api = apiEntry || {};
  return {
    productId: snap.productId ?? api.productId,
    label: snap.label || api.label || '',
    active: api.active ?? true,
    category: snap.category || api.category || null,
    underwriter: api.underwriter || null,
    description: api.description || null,
    noSaleStates: snap.noSaleStates || api.noSaleStates || null,
    defaultNoSaleStates: api.defaultNoSaleStates || null,
    priceByAge: snap.priceByAge ?? api.priceByAge,
    priceBySpouseAge: snap.priceBySpouseAge ?? api.priceBySpouseAge
  };
}

function collectUnsharedAmountsFromSnapshot(snapshot) {
  const values = new Set();
  for (const row of snapshot?.derivedTiers || []) {
    const ua = extractUnsharedFromBenefitLabel(row.benefitLabel);
    if (ua) values.add(ua);
  }
  for (const row of snapshot?.pricingMatrix || []) {
    const ua = extractUnsharedFromBenefitLabel(row.benefitLabel);
    if (ua) values.add(ua);
  }
  return [...values];
}

function aggregateAgeRangeFromSnapshot(snapshot, fallback = { min: 18, max: 64 }) {
  const rows = snapshot?.derivedTiers?.length
    ? snapshot.derivedTiers
    : snapshot?.pricingMatrix || [];
  let min = null;
  let max = null;
  for (const row of rows) {
    const rowMin = row.memberAgeMin;
    const rowMax = row.memberAgeMax;
    if (rowMin == null && rowMax == null) continue;
    min = min == null ? rowMin : Math.min(min, rowMin ?? min);
    max = max == null ? rowMax : Math.max(max, rowMax ?? max);
  }
  return {
    min: min != null ? Math.max(0, Math.floor(min)) : fallback.min,
    max: max != null ? Math.min(120, Math.ceil(max)) : fallback.max
  };
}

function effectiveDateFromSnapshotRow(row, fallback) {
  if (row?.displayStart) {
    const parsed = parseDate(row.displayStart);
    if (parsed) return parsed.toISOString().slice(0, 10);
  }
  return fallback;
}

function terminationDateFromSnapshotRow(row) {
  if (row?.displayStop) {
    const parsed = parseDate(row.displayStop);
    if (parsed) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function snapshotRowEffectiveDateKey(row, fallback = '') {
  return effectiveDateFromSnapshotRow(row, fallback || null) || String(row?.displayStart || '').trim();
}

function hasSnapshotAllocationSplits(allocation) {
  return (allocation.netRate || 0) > 0
    || (allocation.overrideRate || 0) > 0
    || (allocation.commission || 0) > 0
    || (allocation.systemFees || 0) > 0;
}

function agesMatchDerivedTier(derivedRow, vendorCost) {
  const pMin = derivedRow.memberAgeMin;
  const pMax = derivedRow.memberAgeMax;
  const vMin = vendorCost.memberAgeMin;
  const vMax = vendorCost.memberAgeMax;
  if (vMin == null && vMax == null) return true;
  if (pMin == null && pMax == null) return vMin == null && vMax == null;
  if (pMin == null || pMax == null) return false;
  if (vMin == null || vMax == null) return false;
  if (pMin === vMin && (pMax === vMax || Math.abs(pMax - vMax) <= 2)) return true;
  return pMin === vMin && pMax === vMax;
}

function normalizeBenefitLabel(label) {
  return String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function vendorCostMatchScore(vendorCost, derivedRow, tierCode) {
  let score = 0;
  const vendorLabel = normalizeBenefitLabel(vendorCost.benefitLabel);
  const rowLabel = normalizeBenefitLabel(derivedRow.benefitLabel);
  const vendorTier = inferTierCode(vendorCost.benefitLabel);
  const rowTier = tierCode || inferTierCode(derivedRow.benefitLabel);

  if (vendorCost.benefitId != null && derivedRow.benefitId != null
    && Number(vendorCost.benefitId) === Number(derivedRow.benefitId)) {
    score += 1000;
  }
  if (vendorLabel && rowLabel && vendorLabel === rowLabel) score += 500;
  if (vendorTier && rowTier && vendorTier === rowTier) score += 400;
  if (vendorCost.memberAgeMin != null || vendorCost.memberAgeMax != null) score += 100;
  if (agesMatchDerivedTier(derivedRow, vendorCost)) score += 50;
  if (vendorCost.benefitId == null && !vendorLabel && !vendorTier) score += 1;
  return score;
}

function mergeVendorBreakdownRows(primary = [], secondary = []) {
  const byKey = new Map();
  for (const row of [...primary, ...secondary]) {
    const key = normalizeVendorRoutingKey(row.vendorName, row.vendorId);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || (Number(row.amount) || 0) > (Number(existing.amount) || 0)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function vendorCostMatchesDerivedRow(vendorCost, derivedRow, tierCode) {
  if (!isVendorCostActive(vendorCost)) return false;
  if (!agesMatchDerivedTier(derivedRow, vendorCost)) return false;

  const vendorLabel = normalizeBenefitLabel(vendorCost.benefitLabel);
  const rowLabel = normalizeBenefitLabel(derivedRow.benefitLabel);
  const vendorTier = inferTierCode(vendorCost.benefitLabel);
  const rowTier = tierCode || inferTierCode(derivedRow.benefitLabel);

  if (vendorCost.benefitId != null && derivedRow.benefitId != null
    && Number(vendorCost.benefitId) === Number(derivedRow.benefitId)) {
    return true;
  }

  if (vendorLabel && rowLabel && vendorLabel === rowLabel) return true;

  if (vendorTier && rowTier && vendorTier === rowTier) return true;

  // Product-wide flat fees (Lyric, etc.)
  return vendorCost.benefitId == null && !vendorLabel && !vendorTier;
}

/** Rebuild vendor splits from snapshot vendorCosts — fixes stale isCurrent flags on benefit-scoped rows. */
function rebuildVendorBreakdownForTierRow(derivedRow, snapshot, tierCode) {
  const vendorCosts = (snapshot?.vendorCosts || []).filter(isVendorCostActive);
  let matched = vendorCosts.filter((vendorCost) => (
    vendorCostMatchesDerivedRow(vendorCost, derivedRow, tierCode)
  ));

  if (!matched.length) {
    const rowTier = tierCode || inferTierCode(derivedRow.benefitLabel);
    const rowUa = extractUnsharedFromBenefitLabel(derivedRow.benefitLabel);
    matched = vendorCosts.filter((vendorCost) => {
      const vendorTier = inferTierCode(vendorCost.benefitLabel);
      const vendorUa = extractUnsharedFromBenefitLabel(vendorCost.benefitLabel);
      if (derivedRow.benefitId != null && vendorCost.benefitId != null
        && Number(derivedRow.benefitId) === Number(vendorCost.benefitId)) {
        return true;
      }
      if (rowTier && vendorTier && rowTier === vendorTier) {
        if (!rowUa || !vendorUa || rowUa === vendorUa) return true;
      }
      if (rowTier && vendorTier && rowTier === vendorTier && !vendorUa && !rowUa) {
        return true;
      }
      return false;
    });
  }

  const byVendor = new Map();
  for (const row of matched) {
    const key = normalizeVendorRoutingKey(row.vendorName, row.vendorId);
    if (!key) continue;
    const score = vendorCostMatchScore(row, derivedRow, tierCode);
    const existing = byVendor.get(key);
    if (!existing || score > existing.score) {
      byVendor.set(key, { row, score });
    }
  }

  const rebuilt = [...byVendor.values()]
    .map(({ row: vendorCost }) => ({
      vendorName: vendorCost.vendorName,
      vendorId: vendorCost.vendorId,
      bucket: vendorBucket(vendorCost.vendorName, vendorCost.priceTypes),
      amount: roundMoney(Number(vendorCost.amount) || 0),
      benefitId: vendorCost.benefitId,
      memberAgeMin: vendorCost.memberAgeMin,
      memberAgeMax: vendorCost.memberAgeMax
    }))
    .filter((vendor) => vendor.amount > 0);

  if (rebuilt.length) return rebuilt;

  if (Array.isArray(derivedRow.vendorBreakdown) && derivedRow.vendorBreakdown.length) {
    return derivedRow.vendorBreakdown
      .filter((vendor) => roundMoney(Number(vendor.amount) || 0) > 0)
      .map((vendor) => ({
        vendorName: vendor.vendorName,
        vendorId: vendor.vendorId,
        bucket: vendor.bucket || resolveVendorAllocationBucket(vendor),
        amount: roundMoney(Number(vendor.amount) || 0),
        benefitId: vendor.benefitId,
        memberAgeMin: vendor.memberAgeMin,
        memberAgeMax: vendor.memberAgeMax
      }));
  }

  return [];
}

/** Member productfee.amount stats — fallback when E123 catalog matrix Price and GetRates are $0. */
function resolveMemberPremiumMsrp(migrationTier, { tobaccoStatus = 'N/A' } = {}) {
  if (!migrationTier) return null;
  const stats = migrationTier.feeAmountStats;
  const hasTobaccoSpread = stats
    && stats.sampleSize >= 3
    && stats.min != null
    && stats.max != null
    && (stats.max - stats.min) >= 5;

  if (hasTobaccoSpread) {
    if (tobaccoStatus === 'Yes') return roundMoney(Number(stats.max));
    if (tobaccoStatus === 'No') return roundMoney(Number(stats.min));
  }

  if (stats?.median != null) return roundMoney(Number(stats.median));
  if (stats?.average != null) return roundMoney(Number(stats.average));
  if (migrationTier.feeHints?.amount != null) return roundMoney(Number(migrationTier.feeHints.amount));
  return null;
}

/**
 * MSRP anchor order: E123 catalog matrix → GetRates → member product fees.
 */
function resolveWizardMsrp({ row, rateLookup, migrationTier, tobaccoStatus = 'N/A' } = {}) {
  const catalogMsrp = roundMoney(Number(row?.msrpRate) || 0);
  if (catalogMsrp > 0) {
    return { msrpRate: catalogMsrp, source: 'catalog' };
  }

  if (rateLookup) {
    let rate = null;
    if (tobaccoStatus === 'Yes') {
      rate = rateLookup.tobaccoRate ?? rateLookup.nonTobaccoRate ?? null;
    } else if (tobaccoStatus === 'No') {
      rate = rateLookup.nonTobaccoRate ?? rateLookup.tobaccoRate ?? null;
    } else {
      rate = rateLookup.nonTobaccoRate ?? rateLookup.tobaccoRate ?? null;
    }
    if (rate != null && rate > 0) {
      return { msrpRate: roundMoney(rate), source: 'e123_getrates' };
    }
  }

  const memberMsrp = resolveMemberPremiumMsrp(migrationTier, { tobaccoStatus });
  if (memberMsrp != null && memberMsrp > 0) {
    return { msrpRate: memberMsrp, source: 'member_premium' };
  }

  return { msrpRate: 0, source: 'empty' };
}

function allocationFromSnapshotDerivedRow(
  row,
  snapshot,
  vendorBucketOverrides = {},
  tierCode = null,
  rateLookup = null,
  migrationTier = null
) {
  let netRate = roundMoney(Number(row.netRate) || 0);
  let overrideRate = roundMoney(Number(row.overrideRate) || 0);
  let systemFees = roundMoney(Number(row.otherFees) || 0);
  let msrpRate = roundMoney(Number(row.msrpRate) || 0);
  const resolvedTierCode = tierCode || inferTierCode(row.benefitLabel);
  const rebuiltBreakdown = snapshot?.vendorCosts?.length
    ? rebuildVendorBreakdownForTierRow(row, snapshot, resolvedTierCode)
    : [];
  const vendorBreakdown = rebuiltBreakdown.length > 0
    ? rebuiltBreakdown
    : (row.vendorBreakdown || []);
  const hasVendorBreakdown = Array.isArray(vendorBreakdown) && vendorBreakdown.length > 0;

  if (hasVendorBreakdown) {
    netRate = 0;
    overrideRate = 0;
    systemFees = 0;
    for (const vendor of vendorBreakdown) {
      const amt = roundMoney(Number(vendor.amount) || 0);
      if (!amt) continue;
      const bucket = resolveVendorAllocationBucket(vendor, vendorBucketOverrides);
      if (bucket === 'exclude' || bucket === 'processor') continue;
      if (bucket === 'net') netRate = roundMoney(netRate + amt);
      else if (bucket === 'override') overrideRate = roundMoney(overrideRate + amt);
      else systemFees = roundMoney(systemFees + amt);
    }
  }

  // Catalog matrix → GetRates → member productfee amounts when E123 MSRP is $0.
  let msrpSource = Number(row.msrpRate) > 0 ? 'catalog' : null;
  if (msrpRate <= 0) {
    const resolvedMsrp = resolveWizardMsrp({
      row,
      rateLookup,
      migrationTier,
      tobaccoStatus: 'N/A'
    });
    if (resolvedMsrp.msrpRate > 0) {
      msrpRate = resolvedMsrp.msrpRate;
      msrpSource = resolvedMsrp.source;
    }
  }

  let commission = roundMoney(Number(row.commission) || 0);
  let allocationSource = 'csv_snapshot';
  if (msrpRate > 0) {
    const residual = roundMoney(msrpRate - netRate - overrideRate - systemFees);
    if (hasVendorBreakdown || hasSnapshotAllocationSplits({ netRate, overrideRate, systemFees })) {
      commission = Math.max(0, residual);
      if (msrpSource === 'member_premium') {
        allocationSource = 'member_premium';
      } else if (msrpSource === 'e123_getrates') {
        allocationSource = 'e123_getrates';
      }
    } else if (row.benefitId != null && Array.isArray(snapshot?.pricingMatrix)) {
      const matrixRow = snapshot.pricingMatrix.find(
        (entry) => Number(entry.benefitId) === Number(row.benefitId)
      );
      const commissionable = roundMoney(Number(matrixRow?.commissionableAmount) || 0);
      if (commissionable > 0 && commissionable < msrpRate) {
        overrideRate = roundMoney(msrpRate - commissionable);
        commission = commissionable;
      } else if (commission <= 0) {
        commission = Math.max(0, residual);
      }
    } else if (commission <= 0) {
      commission = Math.max(0, residual);
    }
  }

  return {
    netRate,
    overrideRate,
    commission,
    systemFees,
    msrpRate,
    allocationSource
  };
}

function tierAllocationCompleteness(tier) {
  const bands = tier?.ageBands || [];
  if (!bands.length) return 0;
  return bands.reduce((sum, band) => {
    let score = 0;
    if ((band.netRate || 0) > 0) score += 3;
    if ((band.overrideRate || 0) > 0) score += 4;
    if ((band.commission || 0) > 0) score += 3;
    if ((band.msrpRate || 0) > 0) score += 2;
    return sum + score;
  }, 0);
}

function isAgeBandedAncillaryProduct(productType, snapshotLabel = '') {
  const text = `${productType || ''} ${snapshotLabel || ''}`.toLowerCase();
  return /critical illness|accident|hospital indemnity|dental|vision|life insurance|disability|telemed/.test(text);
}

function resolveSnapshotTierCode(row, productType, snapshotLabel) {
  if (row.tierCode && TIER_CODES.includes(row.tierCode)) return row.tierCode;
  const inferred = inferTierCode(row.benefitLabel);
  if (inferred && TIER_CODES.includes(inferred)) return inferred;
  if (isAgeBandedAncillaryProduct(productType, snapshotLabel)) return 'EE';
  return null;
}

function isAgeBandedSnapshotProduct(snapshot, productType, snapshotLabel = '') {
  if (snapshot?.setup?.priceByAge) return true;
  return isAgeBandedAncillaryProduct(productType, snapshotLabel);
}

function scoreDerivedTierRow(row) {
  let score = 0;
  if ((row.netRate || 0) > 0) score += 3;
  if ((row.overrideRate || 0) > 0) score += 4;
  if ((row.msrpRate || 0) > 0) score += 2;
  if ((row.commission || 0) > 0) score += 3;
  if (Array.isArray(row.vendorBreakdown) && row.vendorBreakdown.length) score += 2;
  return score;
}

function pickPrimaryUnsharedAmount(migrationTiers = [], snapshotUas = []) {
  const counts = new Map();
  for (const tier of migrationTiers) {
    const ua = tier.catalogUnsharedAmount
      || tier.feeHints?.unsharedAmount
      || extractUnsharedFromBenefitLabel(tier.sourceBenefitLabel || tier.catalogBenefitName);
    if (!ua) continue;
    const weight = tier.memberCount || tier.householdCount || 1;
    counts.set(String(ua), (counts.get(String(ua)) || 0) + weight);
  }
  if (counts.size) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return snapshotUas.length ? String(snapshotUas[0]) : null;
}

/**
 * Wizard pricing: one band per family tier (+ UA + effective date) unless E123 is age-banded.
 * Collapses duplicate matrix rows that differ only by age or benefitId copy.
 */
function prepareDerivedTiersForWizard({
  derivedTiers = [],
  snapshot,
  migrationTiers = [],
  productType = '',
  snapshotLabel = '',
  ageRange = null
}) {
  const deduped = dedupeDerivedTierRows(
    derivedTiers,
    migrationTiers,
    productType,
    snapshotLabel,
    snapshot
  );
  if (!deduped.length) return [];

  if (isAgeBandedSnapshotProduct(snapshot, productType, snapshotLabel)) {
    return deduped;
  }

  const resolvedAgeRange = ageRange || aggregateAgeRangeFromSnapshot(snapshot);
  const byGroup = new Map();

  for (const row of deduped) {
    const tierCode = resolveSnapshotTierCode(row, productType, snapshotLabel);
    if (!tierCode) continue;

    const ua = extractUnsharedFromBenefitLabel(row.benefitLabel) || '';
    const key = [
      tierCode,
      ua,
      snapshotRowEffectiveDateKey(row)
    ].join('|');

    const existing = byGroup.get(key);
    if (!existing || scoreDerivedTierRow(row) > scoreDerivedTierRow(existing)) {
      byGroup.set(key, { ...row, tierCode });
    }
  }

  return [...byGroup.values()]
    .sort((a, b) => (
      parseDisplayStartMs(a.displayStart) - parseDisplayStartMs(b.displayStart)
      || TIER_CODES.indexOf(a.tierCode) - TIER_CODES.indexOf(b.tierCode)
      || (a.memberAgeMin ?? 0) - (b.memberAgeMin ?? 0)
    ))
    .map((row) => ({
      ...row,
      memberAgeMin: resolvedAgeRange.min,
      memberAgeMax: resolvedAgeRange.max
    }));
}

function parseDisplayStartMs(value) {
  if (!value) return 0;
  const parsed = parseDate(value);
  return parsed ? parsed.getTime() : 0;
}

function catalogPremiumFromTier(tier) {
  const catalogRows = tier?.catalogPricing?.rows || tier?.catalogPricingRows || [];
  if (catalogRows.length === 1) return Number(catalogRows[0].amount);
  if (catalogRows.length > 1) {
    const amounts = catalogRows
      .map((row) => Number(row.amount))
      .filter((value) => Number.isFinite(value));
    if (amounts.length) {
      const sorted = [...amounts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    }
  }
  return null;
}

function migrationPremiumHint(migrationTiers = []) {
  for (const tier of migrationTiers) {
    const median = tier?.feeAmountStats?.median ?? tier?.feeHints?.amount;
    if (median != null) return Number(median);
  }
  return null;
}

/**
 * E123 does not expose AB365-style bundle parent/child pdids. One pdid can still roll up
 * multiple vendor payees (Lyric, ARM, etc.) via Vendor Costs + pricing matrix rows.
 */
function detectE123ProductComposition(snapshot) {
  if (!snapshot) return null;

  const vendorComponents = [...new Set(
    (snapshot.vendorCosts || [])
      .map((row) => String(row.vendorName || row.Label || '').trim())
      .filter(Boolean)
  )];

  const benefitTiers = [...new Map(
    (snapshot.pricingMatrix || [])
      .filter((row) => row.benefitId != null)
      .map((row) => [String(row.benefitId), {
        benefitId: row.benefitId,
        label: row.benefitLabel || null
      }])
  ).values()];

  const contentLabels = (snapshot.content?.documents || [])
    .map((row) => String(row['Content Label'] || row.contentLabel || '').trim())
    .filter(Boolean);

  const fulfillmentEntries = (snapshot.content?.fulfillment || [])
    .map((row) => ({
      displayLabel: String(row['Display Label'] || row.Label || '').trim() || null,
      agentId: row['Agent ID'] || row.agentId || null,
      code: row.Code || row.code || null
    }))
    .filter((row) => row.displayLabel || row.agentId || row.code);

  const labelText = `${snapshot.label || ''} ${snapshot.setup?.displayLabel || ''}`.toLowerCase();
  const bundleWithOtherProducts = !!snapshot.setup?.bundleWithOtherProducts;
  const hasLyricSignal = vendorComponents.some((name) => /lyric/i.test(name))
    || contentLabels.some((label) => /lyric/i.test(label));
  const likelyComposite = vendorComponents.length > 1
    || (hasLyricSignal && /wellness|copay|mec|bundle|connected/i.test(labelText));

  return {
    bundleWithOtherProducts,
    vendorComponents,
    benefitTiers,
    contentLabels,
    fulfillmentEntries,
    hasLyricSignal,
    likelyComposite
  };
}

function isCompositeE123Snapshot(snapshot) {
  const composition = detectE123ProductComposition(snapshot);
  if (composition?.likelyComposite) return true;
  const label = `${snapshot?.label || ''} ${snapshot?.setup?.displayLabel || ''}`.toLowerCase();
  return /connected wellness|preventive sharewell connect/i.test(label);
}

function parseVendorBucketOverrides(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'net' || value === 'override' || value === 'exclude') out[String(key)] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** One routing row per vendor label — bucket choice applies to all pricing tiers. */
function buildE123VendorRoutingPreview(snapshot, vendorBucketOverrides = {}) {
  if (!snapshot?.vendorCosts?.length) {
    return { hasRouting: false, vendors: [] };
  }

  const byLabel = new Map();
  for (const row of snapshot.vendorCosts) {
    if (!isVendorCostActive(row)) continue;
    if (/processor fee/i.test(row.priceTypes || row.includedPriceTypes || '')) continue;

    const vendorName = String(row.vendorName || row.Label || '').trim();
    if (!vendorName) continue;
    const vendorId = row.vendorId ?? row['Agent ID'] ?? null;
    const routingKey = normalizeVendorRoutingKey(vendorName, vendorId);
    const amount = row.amount != null ? Number(row.amount) : null;
    const defaultBucket = vendorBucket(vendorName, row.priceTypes || row.includedPriceTypes);
    const overrideBucket = vendorBucketOverrides[routingKey]
      || (vendorId != null ? vendorBucketOverrides[String(vendorId)] : null)
      || vendorBucketOverrides[vendorName.toLowerCase()];
    const selectedBucket = overrideBucket === 'net' || overrideBucket === 'override' || overrideBucket === 'exclude'
      ? overrideBucket
      : (defaultBucket === 'net' ? 'net' : defaultBucket === 'exclude' ? 'exclude' : 'override');

    const benefitLabel = String(row.benefitLabel || row.benefit_label || '').trim();
    const existing = byLabel.get(routingKey);
    if (!existing) {
      byLabel.set(routingKey, {
        routingKey,
        vendorId: vendorId != null ? Number(vendorId) : null,
        vendorName,
        amounts: Number.isFinite(amount) ? [amount] : [],
        defaultBucket: defaultBucket === 'net' ? 'net' : defaultBucket === 'exclude' ? 'exclude' : 'override',
        selectedBucket,
        isMerchantFee: isMerchantOrProcessingFeeVendor(vendorName, row.priceTypes || row.includedPriceTypes),
        appliesTo: benefitLabel ? [benefitLabel] : (row.benefitId == null ? ['All tiers'] : [])
      });
      continue;
    }
    if (Number.isFinite(amount) && !existing.amounts.includes(amount)) {
      existing.amounts.push(amount);
    }
    if (benefitLabel && !existing.appliesTo.includes(benefitLabel)) {
      existing.appliesTo.push(benefitLabel);
    }
  }

  const vendors = [...byLabel.values()]
    .map((vendor) => {
      const amounts = vendor.amounts.sort((a, b) => a - b);
      const amountLabel = amounts.length === 0
        ? '—'
        : amounts.length === 1
          ? `$${amounts[0].toFixed(2)}`
          : `$${amounts[0].toFixed(2)}–$${amounts[amounts.length - 1].toFixed(2)}`;
      const appliesTo = vendor.appliesTo.includes('All tiers')
        ? 'All tiers'
        : vendor.appliesTo.join(', ');
      return {
        routingKey: vendor.routingKey,
        vendorId: vendor.vendorId,
        vendorName: vendor.vendorName,
        amountLabel,
        amounts,
        appliesTo,
        defaultBucket: vendor.defaultBucket,
        selectedBucket: vendor.selectedBucket,
        isMerchantFee: vendor.isMerchantFee === true
      };
    })
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));

  return {
    hasRouting: vendors.length > 1,
    vendors,
    skippedInactiveCount: (snapshot.vendorCosts || []).filter((row) => !isVendorCostActive(row)).length
  };
}

async function loadE123CsvSnapshot(sourceProductKey, batchId) {
  let brokerId = await resolveOrgBrokerId();
  if (batchId) {
    const batch = await migrationBatch.getBatch(batchId);
    brokerId = batch?.RootBrokerId || brokerId;
  }
  if (!brokerId) return null;
  try {
    const record = await getProductSnapshot(sourceProductKey, brokerId);
    return record?.snapshot || null;
  } catch {
    return null;
  }
}

async function buildE123VendorRoutingPreviewForProduct({
  sourceProductKey,
  batchId,
  vendorBucketOverrides = {}
}) {
  const snapshot = await loadE123CsvSnapshot(sourceProductKey, batchId);
  if (!snapshot) {
    return { hasRouting: false, vendors: [], missingSnapshot: true };
  }
  return buildE123VendorRoutingPreview(snapshot, vendorBucketOverrides);
}

/** Collapse only exact duplicate CSV rows — keep separate bands when effective dates differ. */
function dedupeDerivedTierRows(
  derivedTiers = [],
  migrationTiers = [],
  productType = '',
  snapshotLabel = '',
  snapshot = null
) {
  const migrationPremium = migrationPremiumHint(migrationTiers);
  const composite = isCompositeE123Snapshot(snapshot || { label: snapshotLabel, vendorCosts: [] });
  const byKey = new Map();

  for (const row of derivedTiers) {
    const tierCode = resolveSnapshotTierCode(row, productType, snapshotLabel);
    if (!tierCode) continue;

    const keyParts = [
      tierCode,
      row.memberAgeMin ?? '',
      row.memberAgeMax ?? '',
      extractUnsharedFromBenefitLabel(row.benefitLabel) || '',
      snapshotRowEffectiveDateKey(row)
    ];
    if (!composite) keyParts.push(row.benefitId ?? '');
    const key = keyParts.join('|');

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row, tierCode });
      continue;
    }

    let keep = existing;
    if (migrationPremium != null) {
      const diffNew = Math.abs((row.msrpRate || 0) - migrationPremium);
      const diffOld = Math.abs((existing.msrpRate || 0) - migrationPremium);
      if (diffNew < diffOld) keep = row;
    } else if ((row.netRate || 0) + (row.overrideRate || 0) > (existing.netRate || 0) + (existing.overrideRate || 0)) {
      keep = row;
    }

    byKey.set(key, { ...keep, tierCode: resolveSnapshotTierCode(keep, productType, snapshotLabel) || tierCode });
  }

  return [...byKey.values()].sort((a, b) => (
    parseDisplayStartMs(a.displayStart) - parseDisplayStartMs(b.displayStart)
    || (a.memberAgeMin ?? 0) - (b.memberAgeMin ?? 0)
    || (a.memberAgeMax ?? 0) - (b.memberAgeMax ?? 0)
    || (a.msrpRate || 0) - (b.msrpRate || 0)
  ));
}

function scoreAgeBandForMigration(band, migrationTier) {
  let score = 0;
  const targetPremium = catalogPremiumFromTier(migrationTier)
    ?? migrationTier?.feeAmountStats?.median
    ?? migrationTier?.feeHints?.amount;
  if (targetPremium != null && band.msrpRate != null) {
    score += Math.max(0, 200 - Math.abs(band.msrpRate - targetPremium) * 10);
  }
  if ((band.netRate || 0) > 0) score += 15;
  if ((band.overrideRate || 0) > 0) score += 10;
  score += parseDisplayStartMs(band.effectiveDate) / 1e12;
  return score;
}

function dateRangesOverlap(a, b) {
  const aStart = parseDisplayStartMs(a.effectiveDate);
  const aEnd = a.terminationDate ? parseDisplayStartMs(a.terminationDate) : Number.POSITIVE_INFINITY;
  const bStart = parseDisplayStartMs(b.effectiveDate);
  const bEnd = b.terminationDate ? parseDisplayStartMs(b.terminationDate) : Number.POSITIVE_INFINITY;
  if (!aStart && !bStart) return true;
  return aEnd > bStart && bEnd > aStart;
}

function collapseOverlappingAgeBands(ageBands = [], migrationTiers = [], tierCode = 'EE') {
  const migrationTier = migrationTiers.find((tier) => resolveBenefitTierCode(tier) === tierCode)
    || migrationTiers[0]
    || null;
  const kept = [];

  for (const band of ageBands) {
    const overlapIdx = kept.findIndex((existing) => (
      existing.minAge === band.minAge
      && existing.maxAge === band.maxAge
      && (existing.tobaccoStatus || 'N/A') === (band.tobaccoStatus || 'N/A')
      && (existing.configValue1 || '') === (band.configValue1 || '')
      && dateRangesOverlap(existing, band)
    ));
    if (overlapIdx === -1) {
      kept.push(band);
      continue;
    }
    const existing = kept[overlapIdx];
    if (scoreAgeBandForMigration(band, migrationTier) >= scoreAgeBandForMigration(existing, migrationTier)) {
      kept[overlapIdx] = band;
    }
  }

  return kept.sort((a, b) => (
    parseDisplayStartMs(a.effectiveDate) - parseDisplayStartMs(b.effectiveDate)
    || (a.minAge ?? 0) - (b.minAge ?? 0)
    || (a.maxAge ?? 0) - (b.maxAge ?? 0)
  ));
}

function dedupeSnapshotAgeBands(ageBands = [], migrationTiers = [], tierCode = 'EE') {
  const migrationTier = migrationTiers.find((tier) => resolveBenefitTierCode(tier) === tierCode)
    || migrationTiers[0]
    || null;
  const byKey = new Map();

  for (const band of ageBands) {
    const key = [
      band.minAge ?? '',
      band.maxAge ?? '',
      band.tobaccoStatus || 'N/A',
      band.configValue1 || '',
      band.effectiveDate || '',
      band.terminationDate || ''
    ].join('|');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, band);
      continue;
    }
    const keep = scoreAgeBandForMigration(band, migrationTier) >= scoreAgeBandForMigration(existing, migrationTier)
      ? band
      : existing;
    byKey.set(key, keep);
  }

  return collapseOverlappingAgeBands([...byKey.values()], migrationTiers, tierCode);
}

function scaleSnapshotAllocation(allocation, targetMsrp) {
  const target = roundMoney(targetMsrp);
  if (!target || target <= 0) {
    return { ...allocation, allocationSource: allocation.allocationSource || 'csv_snapshot' };
  }

  const baseMsrp = roundMoney(allocation.msrpRate || 0);
  const netRate = roundMoney(allocation.netRate || 0);
  const overrideRate = roundMoney(allocation.overrideRate || 0);
  const systemFees = roundMoney(allocation.systemFees || 0);
  const commission = roundMoney(allocation.commission || 0);

  if (!baseMsrp || baseMsrp <= 0) {
    if (netRate > 0 || overrideRate > 0) {
      return {
        netRate,
        overrideRate,
        systemFees,
        msrpRate: target,
        commission: Math.max(0, roundMoney(target - netRate - overrideRate - systemFees)),
        allocationSource: allocation.allocationSource || 'csv_snapshot_msrp_fill'
      };
    }
    return {
      ...allocation,
      msrpRate: target,
      allocationSource: allocation.allocationSource || 'csv_snapshot'
    };
  }

  if (Math.abs(baseMsrp - target) < 0.01) {
    return {
      ...allocation,
      msrpRate: target,
      allocationSource: allocation.allocationSource || 'csv_snapshot'
    };
  }

  const ratio = target / baseMsrp;
  return {
    netRate: roundMoney(netRate * ratio),
    overrideRate: roundMoney(overrideRate * ratio),
    commission: roundMoney(commission * ratio),
    systemFees: roundMoney(systemFees * ratio),
    msrpRate: target,
    allocationSource: 'csv_snapshot_scaled'
  };
}

function buildPricingTiersFromSnapshot({
  snapshot,
  productType = '',
  useTobaccoPricing,
  defaultEffectiveDate,
  configFieldName,
  migrationTiers,
  rateGrid,
  pricingContext,
  vendorBucketOverrides = {},
  ageRange = null
}) {
  const snapshotLabel = snapshot?.label || snapshot?.setup?.displayLabel || '';
  const derivedTiers = prepareDerivedTiersForWizard({
    derivedTiers: snapshot?.derivedTiers || [],
    snapshot,
    migrationTiers,
    productType,
    snapshotLabel,
    ageRange
  });
  if (!derivedTiers.length) return { pricingTiers: [], allocationSources: [] };

  const tiersByCode = new Map();
  const allocationSources = [];

  for (const row of derivedTiers) {
    const tierCode = resolveSnapshotTierCode(row, productType, snapshotLabel);
    if (!tierCode) continue;

    const configValue1 = extractUnsharedFromBenefitLabel(row.benefitLabel) || '';
    const tierKey = wizardTierMapKey(tierCode, configValue1);

    if (!tiersByCode.has(tierKey)) {
      tiersByCode.set(tierKey, {
        tierType: tierCode,
        label: wizardTierLabel(tierCode, configValue1, configFieldName),
        ageBands: [],
        allocationSources: []
      });
    }

    const benefitStub = {
      benefitId: row.benefitId,
      benefitName: row.benefitLabel,
      tier: tierCode,
      unsharedAmount: configValue1 || null
    };
    const migrationTier = findMigrationTierForBenefit(migrationTiers, benefitStub);
    const minAge = row.memberAgeMin ?? 18;
    const maxAge = row.memberAgeMax ?? 64;
    const effectiveDate = effectiveDateFromSnapshotRow(row, defaultEffectiveDate);
    const rateLookup = lookupRateForBenefit(rateGrid, benefitStub);
    const baseAllocation = allocationFromSnapshotDerivedRow(
      row,
      snapshot,
      vendorBucketOverrides,
      tierCode,
      rateLookup,
      migrationTier
    );
    const tobaccoStatuses = useTobaccoPricing ? ['No', 'Yes'] : ['N/A'];
    const tobaccoRates = splitTobaccoRates(migrationTier, rateLookup);
    const snapshotHasSplits = hasSnapshotAllocationSplits(baseAllocation);
    const snapshotHasVendorCosts = (snapshot?.vendorCosts || []).some(isVendorCostActive);
    const canUseSnapshotScaling = snapshotHasSplits
      || baseAllocation.msrpRate > 0
      || snapshotHasVendorCosts
      || (row.netRate || 0) > 0
      || (row.overrideRate || 0) > 0
      || (row.vendorBreakdown?.length > 0);

    for (const tobaccoStatus of tobaccoStatuses) {
      let allocation;
      if (useTobaccoPricing && tobaccoStatus !== 'N/A') {
        const msrp = resolveBandRate(tobaccoStatus, tobaccoRates, migrationTier);
        if (canUseSnapshotScaling) {
          allocation = scaleSnapshotAllocation(baseAllocation, msrp || baseAllocation.msrpRate);
        } else if (rateLookup?.nonTobaccoRate != null || rateLookup?.tobaccoRate != null) {
          allocation = resolvePricingAllocation({
            msrp,
            tierCode,
            configValue1,
            tobaccoStatus,
            migrationTier,
            benefit: benefitStub,
            referenceRows: pricingContext?.referenceRows || [],
            templateRows: pricingContext?.templateRows || [],
            productType: pricingContext?.productType || ''
          });
        } else {
          allocation = scaleSnapshotAllocation(baseAllocation, msrp);
        }
      } else {
        allocation = baseAllocation;
      }

      tiersByCode.get(tierKey).ageBands.push({
        ...buildAgeBandFromAllocation({
          tobaccoStatus,
          minAge,
          maxAge,
          allocation,
          configValue1,
          configFieldName: configValue1 ? configFieldName : '',
          effectiveDate
        }),
        terminationDate: terminationDateFromSnapshotRow(row)
      });
      tiersByCode.get(tierKey).allocationSources.push(allocation.allocationSource || 'csv_snapshot');
    }
  }

  const pricingTiers = sortWizardTierMapEntries([...tiersByCode.entries()]).map(([tierKey, tier]) => {
      const tierCode = tierKey.split('|')[0];
      allocationSources.push(...(tier.allocationSources || []));
      const { allocationSources: _ignored, ...cleanTier } = tier;
      return {
        id: uuidv4(),
        ...cleanTier,
        ageBands: dedupeSnapshotAgeBands(cleanTier.ageBands, migrationTiers, tierCode)
      };
    });

  return { pricingTiers, allocationSources };
}

function mergePricingTiers(primary = [], fallback = []) {
  const byKey = new Map();
  for (const tier of [...(fallback || []), ...(primary || [])]) {
    const key = wizardTierIdentity(tier);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, tier);
      continue;
    }
    const existingScore = tierAllocationCompleteness(existing);
    const nextScore = tierAllocationCompleteness(tier);
    if (nextScore >= existingScore) {
      byKey.set(key, tier);
    }
  }
  return sortWizardTierMapEntries([...byKey.entries()]).map(([, tier]) => tier);
}

function firstOfMonthIso(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function inferDefaultEffectiveDate(households, sourceProductKey, group) {
  const fromStats = group?.enrollmentStats?.effectiveDateRange?.min;
  if (fromStats) return fromStats;

  const dates = [];
  for (const hh of households || []) {
    for (const product of hh.products || []) {
      if (String(product.pdid) !== String(sourceProductKey)) continue;
      const parsed = parseDate(product.dteffective);
      if (parsed) dates.push(parsed);
    }
  }
  if (dates.length) {
    dates.sort((a, b) => a - b);
    return dates[0].toISOString().slice(0, 10);
  }
  return firstOfMonthIso();
}

function collectUnsharedAmounts(catalogBenefits, migrationTiers = []) {
  const values = new Set();
  for (const benefit of catalogBenefits.values()) {
    if (benefit.unsharedAmount != null) values.add(String(benefit.unsharedAmount));
  }
  for (const tier of migrationTiers) {
    const ua = tier.feeHints?.unsharedAmount;
    if (ua != null) values.add(String(ua));
  }
  return [...values].sort((a, b) => Number(a) - Number(b));
}

function buildConfigurationFields(unsharedAmounts, templateFields = []) {
  if (unsharedAmounts.length) {
    const templateUa = templateFields.find((field) => /unshared|deductible/i.test(field.fieldName || ''));
    return [{
      id: templateUa?.id || String(Date.now()),
      fieldName: templateUa?.fieldName || 'Unshared Amount $',
      fieldOptions: unsharedAmounts,
      isDeductible: templateUa?.isDeductible ?? true
    }];
  }
  return templateFields.map((field) => ({ ...field }));
}

function tierRateFromMigrationTier(tier) {
  const memberMsrp = resolveMemberPremiumMsrp(tier);
  if (memberMsrp != null && memberMsrp > 0) return memberMsrp;
  const catalogPremium = catalogPremiumFromTier(tier);
  if (catalogPremium != null && catalogPremium > 0) return catalogPremium;
  return 0;
}

function splitTobaccoRates(migrationTier, rateLookup) {
  const nonTobaccoFromApi = rateLookup?.nonTobaccoRate;
  const tobaccoFromApi = rateLookup?.tobaccoRate;
  if (nonTobaccoFromApi != null || tobaccoFromApi != null) {
    const no = nonTobaccoFromApi ?? tobaccoFromApi ?? 0;
    const yes = tobaccoFromApi ?? nonTobaccoFromApi ?? 0;
    if (no > 0 || yes > 0) {
      return {
        no: no || yes,
        yes: yes || no
      };
    }
  }

  const stats = migrationTier?.feeAmountStats;
  const fallback = tierRateFromMigrationTier(migrationTier);
  if (!stats || stats.sampleSize < 2) {
    return { no: fallback, yes: fallback };
  }
  if ((stats.max - stats.min) >= 5 && stats.sampleSize >= 3) {
    return { no: stats.min, yes: stats.max };
  }
  return { no: stats.median ?? fallback, yes: stats.median ?? fallback };
}

function findMigrationTierForBenefit(migrationTiers, benefit) {
  const benefitKey = benefit?.benefitId != null ? String(benefit.benefitId) : null;
  if (benefitKey) {
    const exact = migrationTiers.find((t) => String(t.sourceBenefitKey || '') === benefitKey);
    if (exact) return exact;
  }
  const tierCode = benefit?.tier;
  const ua = benefit?.unsharedAmount != null ? String(benefit.unsharedAmount) : null;
  return migrationTiers.find((t) => {
    const resolved = t.resolvedTier || t.inferredMemberTier;
    const tierMatch = !tierCode || resolved === tierCode;
    const uaMatch = !ua
      || String(t.feeHints?.unsharedAmount || '') === ua
      || String(t.catalogUnsharedAmount || '') === ua;
    return tierMatch && uaMatch;
  }) || migrationTiers.find((t) => (t.resolvedTier || t.inferredMemberTier) === tierCode);
}

function appendPricingBands({
  tierEntry,
  migrationTier,
  tobaccoRates,
  useTobaccoPricing,
  ageRange,
  configValue1,
  configFieldName,
  effectiveDate,
  pricingContext,
  tierCode,
  benefit
}) {
  const tobaccoStatuses = useTobaccoPricing ? ['No', 'Yes'] : ['N/A'];
  for (const tobaccoStatus of tobaccoStatuses) {
    const msrp = resolveBandRate(tobaccoStatus, tobaccoRates, migrationTier);
    const allocation = resolvePricingAllocation({
      msrp,
      tierCode,
      configValue1,
      tobaccoStatus: tobaccoStatus === 'N/A' ? 'No' : tobaccoStatus,
      migrationTier,
      benefit,
      referenceRows: pricingContext?.referenceRows || [],
      templateRows: pricingContext?.templateRows || [],
      productType: pricingContext?.productType || ''
    });
    tierEntry.ageBands.push(buildAgeBandFromAllocation({
      tobaccoStatus,
      minAge: ageRange.min,
      maxAge: ageRange.max,
      allocation,
      configValue1,
      configFieldName,
      effectiveDate
    }));
    if (!tierEntry.allocationSources) tierEntry.allocationSources = [];
    tierEntry.allocationSources.push(allocation.allocationSource);
  }
}

function resolveBenefitTierCode(tier) {
  const labelTier = parseTierFromLabel(tier.sourceBenefitLabel || tier.feeHints?.benefitLabel)
    || parseTierFromLabel(tier.catalogBenefitName);
  if (labelTier && TIER_CODES.includes(labelTier)) return labelTier;
  if (tier.resolvedTier && TIER_CODES.includes(tier.resolvedTier)) return tier.resolvedTier;
  return parseTierFromMigrationTier(tier);
}

function resolveBandRate(tobaccoStatus, tobaccoRates, migrationTier) {
  if (tobaccoStatus === 'Yes') return tobaccoRates.yes;
  if (tobaccoStatus === 'No') return tobaccoRates.no;
  return tobaccoRates.no ?? tobaccoRates.yes ?? tierRateFromMigrationTier(migrationTier);
}

function appendCatalogBenefitTier({
  tiersByCode,
  benefit,
  migrationTiers,
  useTobaccoPricing,
  ageRange,
  configFieldName,
  rateGrid,
  defaultEffectiveDate,
  pricingContext
}) {
  const tierCode = TIER_CODES.includes(benefit.tier) ? benefit.tier : null;
  if (!tierCode) return;

  const ua = benefit.unsharedAmount != null ? String(benefit.unsharedAmount) : '';
  const tierKey = wizardTierMapKey(tierCode, ua);

  if (!tiersByCode.has(tierKey)) {
    tiersByCode.set(tierKey, {
      tierType: tierCode,
      label: wizardTierLabel(tierCode, ua, configFieldName),
      ageBands: []
    });
  }

  const migrationTier = findMigrationTierForBenefit(migrationTiers, benefit);
  const rateLookup = lookupRateForBenefit(rateGrid, benefit);
  const tobaccoRates = splitTobaccoRates(migrationTier, rateLookup);
  appendPricingBands({
    tierEntry: tiersByCode.get(tierKey),
    migrationTier,
    tobaccoRates,
    useTobaccoPricing,
    ageRange,
    configValue1: ua,
    configFieldName: ua ? configFieldName : '',
    effectiveDate: defaultEffectiveDate,
    pricingContext,
    tierCode,
    benefit
  });
}

function buildPricingTiers({
  catalogBenefits,
  migrationTiers,
  useTobaccoPricing,
  ageRange,
  configFieldName,
  unsharedAmounts,
  rateGrid,
  defaultEffectiveDate,
  pricingContext
}) {
  const effectiveDate = defaultEffectiveDate || firstOfMonthIso();
  const tiersByCode = new Map();
  const catalogList = [...(catalogBenefits?.values() || [])];

  if (catalogList.length > 0) {
    for (const benefit of catalogList) {
      appendCatalogBenefitTier({
        tiersByCode,
        benefit,
        migrationTiers,
        useTobaccoPricing,
        ageRange,
        configFieldName,
        rateGrid,
        defaultEffectiveDate: effectiveDate,
        pricingContext
      });
    }
  }

  if (tiersByCode.size === 0) {
    const grouped = new Map();
    for (const tier of migrationTiers) {
      const code = resolveBenefitTierCode(tier);
      if (!code || !TIER_CODES.includes(code)) continue;
      if (!grouped.has(code)) grouped.set(code, []);
      grouped.get(code).push(tier);
    }

    for (const [tierCode, tierRows] of grouped.entries()) {
      const uaValues = unsharedAmounts.length ? unsharedAmounts : [''];
      for (const ua of uaValues) {
        const tierKey = wizardTierMapKey(tierCode, ua);
        if (!tiersByCode.has(tierKey)) {
          tiersByCode.set(tierKey, {
            tierType: tierCode,
            label: wizardTierLabel(tierCode, ua, configFieldName),
            ageBands: []
          });
        }
        const migrationTier = tierRows.find((t) => !ua
          || String(t.feeHints?.unsharedAmount || '') === ua) || tierRows[0];
        const benefitStub = migrationTier?.sourceBenefitKey
          ? {
            benefitId: migrationTier.sourceBenefitKey,
            benefitName: migrationTier.sourceBenefitLabel,
            tier: tierCode,
            unsharedAmount: ua || null
          }
          : {
            benefitId: null,
            benefitName: migrationTier?.sourceBenefitLabel,
            tier: tierCode,
            unsharedAmount: ua || null
          };
        const rateLookup = lookupRateForBenefit(rateGrid, benefitStub);
        const tobaccoRates = splitTobaccoRates(migrationTier, rateLookup);
        appendPricingBands({
          tierEntry: tiersByCode.get(tierKey),
          migrationTier,
          tobaccoRates,
          useTobaccoPricing,
          ageRange,
          configValue1: ua,
          configFieldName: ua ? configFieldName : '',
          effectiveDate,
          pricingContext,
          tierCode,
          benefit: benefitStub
        });
      }
    }
  }

  if (catalogList.length > 0) {
    for (const benefit of catalogList) {
      const tierKey = wizardTierMapKey(
        benefit.tier,
        benefit.unsharedAmount != null ? String(benefit.unsharedAmount) : ''
      );
      if (tiersByCode.has(tierKey)) continue;
      appendCatalogBenefitTier({
        tiersByCode,
        benefit,
        migrationTiers,
        useTobaccoPricing,
        ageRange,
        configFieldName,
        rateGrid,
        defaultEffectiveDate: effectiveDate,
        pricingContext
      });
    }
  }

  const allocationSources = [];
  const pricingTiers = sortWizardTierMapEntries([...tiersByCode.entries()]).map(([, tier]) => {
      if (tier.allocationSources?.length) allocationSources.push(...tier.allocationSources);
      const { allocationSources: _ignored, ...cleanTier } = tier;
      return { id: uuidv4(), ...cleanTier };
    });

  return { pricingTiers, allocationSources };
}

function parseTierFromMigrationTier(tier) {
  const label = tier.sourceBenefitLabel || tier.feeHints?.benefitLabel || '';
  return parseTierFromLabel(label) || parseTierFromLabel(tier.catalogBenefitName);
}

function buildProductDescription({ catalogEntry, template }) {
  if (template?.formData?.description) {
    return String(template.formData.description).trim();
  }
  if (catalogEntry?.description) {
    return stripHtmlForText(catalogEntry.description);
  }
  return '';
}

function buildE123DraftOverrides({
  sourceProductKey,
  label,
  tenantId,
  pricingTiers,
  configurationFields,
  useTobaccoPricing,
  template,
  migrationAiChunks
}) {
  const overrides = {
    partNumber: `E123-${sourceProductKey}`,
    name: label.trim(),
    productOwnerId: tenantId,
    pricingTiers,
    isHidden: true,
    aiChunks: [
      ...(template?.formData?.aiChunks || []),
      ...migrationAiChunks
    ]
  };

  if (template?.formData) {
    if (configurationFields?.length) {
      overrides.configurationFields = configurationFields;
    }
  } else {
    overrides.configurationFields = configurationFields;
    overrides.requiresTobaccoInfo = useTobaccoPricing;
  }

  return overrides;
}

function mergeWizardDraftFormData({
  template,
  e123Overrides,
  emptyWizardDefaults,
  noTemplateFields = {},
  tenantLogoUrl = ''
}) {
  if (template?.formData) {
    return {
      ...template.formData,
      ...e123Overrides,
      productImageUrl: template.formData.productImageUrl || tenantLogoUrl || '',
      productLogoUrl: template.formData.productLogoUrl || tenantLogoUrl || ''
    };
  }

  return {
    ...emptyWizardDefaults,
    ...e123Overrides,
    ...noTemplateFields,
    productImageUrl: tenantLogoUrl || '',
    productLogoUrl: tenantLogoUrl || ''
  };
}

function emptyIdCardData() {
  return {
    DisableIDCard: false,
    Card_Front: {
      Header: { Image: '' },
      Footer: { Header: '', Text1: '', Text2: '' }
    },
    Card_Back: {
      Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
    }
  };
}

function stripHtmlForText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildMigrationAiChunks({
  label,
  sourceProductKey,
  catalogEntry,
  category,
  group,
  migrationTiers,
  templateName,
  rateGrid
}) {
  const chunks = [];
  const catalogDescription = stripHtmlForText(catalogEntry?.description);
  const productOverviewParts = [
    label ? `Product: ${label}` : null,
    category ? `Category: ${category}` : null,
    catalogEntry?.underwriter ? `Underwriter: ${catalogEntry.underwriter}` : null,
    catalogDescription || null
  ].filter(Boolean);

  if (productOverviewParts.length) {
    chunks.push({
      id: uuidv4(),
      chunk_text: productOverviewParts.join('\n\n'),
      created_at: new Date().toISOString()
    });
  }

  const migrationMeta = [
    `E123 pdid: ${sourceProductKey}`,
    group.enrollmentStats?.enrollmentSummaryLabel
      ? `Enrollment: ${group.enrollmentStats.enrollmentSummaryLabel}`
      : null,
    group.memberCount ? `Members in migration batch: ${group.memberCount}` : null,
    migrationTiers.length ? `Benefit tiers discovered: ${migrationTiers.length}` : null,
    templateName ? `Cloned from AB365 template: ${templateName}` : null,
    rateGrid?.rows?.length ? `E123 rate API rows: ${rateGrid.rows.length}` : null
  ].filter(Boolean).join('\n\n');

  if (migrationMeta) {
    chunks.push({
      id: uuidv4(),
      chunk_text: migrationMeta,
      created_at: new Date().toISOString()
    });
  }

  return chunks;
}

function listPrefilledSections(formData, { templateUsed, rateGridUsed, tenantLogoUsed }) {
  const sections = ['basicDetails', 'vendor', 'configuration', 'pricing'];
  if (formData.idCardData && JSON.stringify(formData.idCardData) !== JSON.stringify(emptyIdCardData())) {
    sections.push('idCard');
  }
  if (formData.planDetailsData && Object.keys(formData.planDetailsData).length > 0) sections.push('planDetails');
  if (formData.productImageUrl || formData.productLogoUrl || tenantLogoUsed) sections.push('media');
  if ((formData.productDocuments && formData.productDocuments.length > 0) || formData.productDocumentUrl) {
    sections.push('documents');
  }
  if (formData.acknowledgementQuestions?.length) sections.push('acknowledgements');
  if (formData.requiredASA) sections.push('requiredASA');
  if (formData.trainingConfig) sections.push('training');
  if (formData.medicalNeedsLinksConfig) sections.push('medicalNeedsLinks');
  if (formData.aiChunks?.length) sections.push('aiChunks');
  if (templateUsed) sections.push('templateClone');
  if (rateGridUsed) sections.push('e123RateApi');
  return sections;
}

function inferQuoteLocation(households, sourceProductKey) {
  const counts = new Map();
  for (const hh of households || []) {
    const hasProduct = (hh.products || []).some((product) => String(product.pdid) === String(sourceProductKey));
    if (!hasProduct) continue;
    const state = String(hh.primary?.state || '').trim().toUpperCase();
    const zip = String(hh.primary?.zip || '').trim().slice(0, 5);
    if (!state) continue;
    const key = `${state}::${zip || '00000'}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = 0;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  if (!bestKey) return { state: 'FL', zipcode: '32801' };
  const [state, zipcode] = bestKey.split('::');
  return { state, zipcode: zipcode === '00000' ? '32801' : zipcode };
}

async function buildE123ProductWizardDraft({
  tenantId,
  sourceProductKey,
  batchId,
  vendorBucketOverrides = {},
  useTobaccoPricingOverride = undefined,
  templateProductId: templateProductIdOverride = undefined
}) {
  const [workspace, households] = await Promise.all([
    migrationProductMapping.getTenantProductMappingWorkspace(tenantId, { batchId }),
    migrationProductMapping.loadHouseholdsForMapping({ batchId, tenantId })
  ]);
  const group = (workspace.e123ProductGroups || []).find(
    (row) => String(row.sourceProductKey) === String(sourceProductKey)
  );
  if (!group) {
    const err = new Error(
      'E123 product not found in migration data. Import member households first, then try again.'
    );
    err.code = 'E123_PRODUCT_NOT_FOUND';
    throw err;
  }

  let brokerId = await resolveOrgBrokerId();
  if (batchId) {
    const batch = await migrationBatch.getBatch(batchId);
    brokerId = batch?.RootBrokerId || brokerId;
  }

  let csvSnapshotRecord = null;
  let csvSnapshot = null;
  if (brokerId) {
    try {
      csvSnapshotRecord = await getProductSnapshot(sourceProductKey, brokerId);
      csvSnapshot = csvSnapshotRecord?.snapshot || null;
    } catch {
      csvSnapshotRecord = null;
      csvSnapshot = null;
    }
  }
  const normalizedVendorOverrides = parseVendorBucketOverrides(vendorBucketOverrides);

  const snapshotCatalogEntry = buildCatalogEntryFromSnapshot(csvSnapshot);
  let apiCatalogEntry = null;
  if (brokerId) {
    try {
      const catalogById = await fetchAgentProductCatalog(brokerId);
      apiCatalogEntry = catalogById.get(String(sourceProductKey)) || null;
    } catch {
      apiCatalogEntry = null;
    }
  }
  const catalogEntry = mergeCatalogEntries(snapshotCatalogEntry, apiCatalogEntry);

  let templateProductId = null;
  if (templateProductIdOverride === null
    || templateProductIdOverride === ''
    || templateProductIdOverride === 'none') {
    templateProductId = null;
  } else if (templateProductIdOverride) {
    templateProductId = String(templateProductIdOverride);
  } else {
    templateProductId = migrationProductMapping.suggestProductId(
      group.sourceProductLabel,
      workspace.subscribedProducts,
      [],
      group.sourceProductKey
    );
  }
  const template = templateProductId
    ? await loadProductWizardTemplate(templateProductId).catch((err) => {
      console.warn('[e123ProductWizardDraft] copy template load failed:', templateProductId, err?.message || err);
      return null;
    })
    : null;

  const migrationTiers = group.tiers || [];
  const templateAgeRange = template?.formData
    ? { min: template.formData.minAge ?? 18, max: template.formData.maxAge ?? 64 }
    : { min: 18, max: 64 };
  const migrationAgeRange = aggregateAgeRange(migrationTiers, templateAgeRange);
  const ageRange = csvSnapshot?.derivedTiers?.length || csvSnapshot?.pricingMatrix?.length
    ? aggregateAgeRangeFromSnapshot(csvSnapshot, migrationAgeRange)
    : migrationAgeRange;
  const quoteLocation = inferQuoteLocation(households, sourceProductKey);

  const [catalogBenefits, rateGrid] = await Promise.all([
    lookupBenefitsForProduct(sourceProductKey),
    brokerId
      ? fetchProductRateGrid(sourceProductKey, brokerId, {
        age: Math.round((ageRange.min + ageRange.max) / 2),
        state: quoteLocation.state,
        zipcode: quoteLocation.zipcode
      })
      : Promise.resolve({ byBenefit: new Map(), rows: [] })
  ]);

  const label = catalogEntry?.label || group.sourceProductLabel || `E123 Product ${sourceProductKey}`;
  const category = catalogEntry?.category || group.catalogStatus?.catalogCategory || null;
  const productType = inferProductType(label, category);
  const useTobaccoPricing = useTobaccoPricingOverride !== undefined
    ? !!useTobaccoPricingOverride
    : shouldUseTobaccoPricing(migrationTiers, rateGrid);
  const defaultEffectiveDate = inferDefaultEffectiveDate(households, sourceProductKey, group);
  const unsharedAmounts = [
    ...new Set([
      ...collectUnsharedAmounts(catalogBenefits, migrationTiers),
      ...collectUnsharedAmountsFromSnapshot(csvSnapshot)
    ])
  ].sort((a, b) => Number(a) - Number(b));
  const configurationFields = buildConfigurationFields(
    unsharedAmounts,
    template?.formData?.configurationFields || []
  );
  const configFieldName = configurationFields[0]?.fieldName || '';
  const templateRows = flattenWizardPricingTiers(template?.formData?.pricingTiers || []);
  const referenceProductIds = [
    templateProductId,
    ...(workspace.subscribedProducts || []).map((product) => product.productId)
  ].filter(Boolean);
  const referenceRows = await loadReferencePricingRows(referenceProductIds);
  const pricingContext = {
    referenceRows,
    templateRows,
    productType
  };

  const snapshotPricing = buildPricingTiersFromSnapshot({
    snapshot: csvSnapshot,
    productType,
    useTobaccoPricing,
    defaultEffectiveDate,
    configFieldName,
    migrationTiers,
    rateGrid,
    pricingContext,
    vendorBucketOverrides: normalizedVendorOverrides,
    ageRange
  });
  const apiPricing = buildPricingTiers({
    catalogBenefits,
    migrationTiers,
    useTobaccoPricing,
    ageRange,
    configFieldName,
    unsharedAmounts,
    rateGrid,
    defaultEffectiveDate,
    pricingContext
  });
  const pricingFromCsvSnapshot = snapshotPricing.pricingTiers.length > 0;
  const hasVendorCostSplits = (csvSnapshot?.vendorCosts || []).some(isVendorCostActive);
  const pricingTiers = pricingFromCsvSnapshot && hasVendorCostSplits
    ? snapshotPricing.pricingTiers
    : mergePricingTiers(snapshotPricing.pricingTiers, apiPricing.pricingTiers);
  const allocationSources = pricingFromCsvSnapshot && hasVendorCostSplits
    ? snapshotPricing.allocationSources
    : [
      ...snapshotPricing.allocationSources,
      ...apiPricing.allocationSources
    ];

  const vendorResolution = resolveVendorId(workspace.subscribedProducts, {
    underwriter: catalogEntry?.underwriter || group.catalogStatus?.catalogUnderwriter,
    label
  });
  const resolvedVendorId = vendorResolution.vendorId || template?.formData?.vendorId || '';

  let tenantLogoUsed = false;
  let tenantLogoUrl = '';
  if (!template?.formData?.productLogoUrl && !template?.formData?.productImageUrl) {
    const tenantLogo = await loadTenantLogoUrl(tenantId);
    if (tenantLogo?.logoUrl) {
      tenantLogoUrl = tenantLogo.logoUrl;
      tenantLogoUsed = true;
    }
  }

  const warnings = [];
  if (!resolvedVendorId) warnings.push('Select a vendor manually.');
  if (!pricingTiers.length) warnings.push('No pricing tiers inferred — add pricing in the wizard.');
  const e123Composition = detectE123ProductComposition(csvSnapshot);
  if (e123Composition?.likelyComposite) {
    const vendorList = e123Composition.vendorComponents.join(', ') || 'multiple vendors';
    warnings.push(
      `E123 vendor costs CSV splits payees for this pdid (${vendorList}). Sharewell → net rate; Lyric and other misc vendors → override rate (wire ACH overrides in AB365 after save).`
    );
    if (e123Composition.hasLyricSignal) {
      warnings.push('Lyric appears in E123 vendor costs or product content for this pdid — typical MightyWELL/Connected Wellness pattern.');
    }
  } else if (e123Composition?.bundleWithOtherProducts) {
    warnings.push('E123 "Bundle=Yes" means this product can be sold bundled with others in checkout — it does not list included child pdids.');
  }
  if (csvSnapshot?.derivedTiers?.length) {
    warnings.push(`Pricing prefilled from uploaded E123 CSV catalog (${csvSnapshot.derivedTiers.length} tier rows with vendor cost splits).`);
  } else if (csvSnapshot) {
    warnings.push('CSV catalog snapshot found but no derived pricing tiers — upload Pricing Matrix and Vendor Costs exports, or pricing will use live APIs.');
  }
  if (!catalogBenefits.size) warnings.push('ShareWELL benefit catalog unavailable; pricing built from CSV snapshot, E123 rates, or member premiums.');
  if (useTobaccoPricing) warnings.push('Tobacco rates included — verify non-tobacco vs tobacco amounts.');
  if (rateGrid?.error) warnings.push(`E123 rate API unavailable (${rateGrid.error}); used CSV snapshot or member premium medians where possible.`);
  else if (!pricingFromCsvSnapshot && rateGrid?.rows?.length) {
    warnings.push(`Pricing prefilled from E123 GetRates (${rateGrid.rows.length} product rate rows).`);
  }
  const allocationCounts = allocationSources.reduce((acc, source) => {
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  if (allocationCounts.msrp_match || allocationCounts.template_exact) {
    warnings.push('Pricing splits copied from matching AB365 product tiers.');
  } else if (allocationCounts.template_scaled || allocationCounts.reference_scaled) {
    warnings.push('Pricing splits scaled from nearest AB365 product tier — verify net/commission.');
  } else if (allocationCounts.commissionable_gap) {
    warnings.push('Some tiers used E123 commissionable-amount gap for override/misc split — verify override and commission.');
  } else if (allocationCounts.tier_commission_default) {
    warnings.push('Some tiers used default agent commission by tier — verify net rate and commission pool.');
  } else if (allocationCounts.msrp_all_net) {
    warnings.push('Some tiers have full MSRP in net rate only — set commission and override manually.');
  } else if (allocationCounts.member_premium) {
    warnings.push('Some tier MSRP amounts came from member product fees in the migration batch — verify net, override, and commission splits.');
  }
  if (template) {
    warnings.push(
      `Copied vendor settings, sales type, description, ID card, plan details, media, and documents from "${template.productName}"${template.isBundle ? ' (bundle shell + included products)' : ''} — pricing from E123.`
    );
  } else if (templateProductId) {
    warnings.push('Could not load the selected AB365 copy template — fill vendor and basic details manually.');
  } else if (templateProductIdOverride === undefined) {
    warnings.push('No close AB365 template found — ID card, plan details, and documents need manual setup.');
  } else {
    warnings.push('Starting without a copy template — add ID card, plan details, and documents in the wizard.');
  }
  if (vendorResolution.reason) warnings.push(vendorResolution.reason);

  const productDescription = buildProductDescription({ catalogEntry, template });

  const migrationAiChunks = buildMigrationAiChunks({
    label: label.trim(),
    sourceProductKey,
    catalogEntry,
    category,
    group,
    migrationTiers,
    templateName: template?.productName || null,
    rateGrid
  });

  const e123Overrides = buildE123DraftOverrides({
    sourceProductKey,
    label,
    tenantId,
    pricingTiers,
    configurationFields,
    useTobaccoPricing,
    template,
    migrationAiChunks
  });

  const emptyWizardDefaults = {
    vendorId: '',
    isVendorPricing: false,
    vendorCommission: 0,
    vendorGroupIdProductType: '',
    eligibilityIndividualVendorGroupId: '',
    eligibilityVendorGroupFallbackProductId: '',
    showGroupIdOnIDCard: false,
    partNumber: '',
    name: '',
    description: '',
    productType: '',
    productOwnerId: tenantId,
    salesType: 'Both',
    minAge: 18,
    maxAge: 64,
    allowedStates: [],
    requiresTobaccoInfo: false,
    effectiveDateLogic: 'FirstOfMonth',
    maxEffectiveDateDays: 60,
    terminationLogic: '',
    requiredLicenses: ['None'],
    isPublic: false,
    isHidden: false,
    isSSNRequired: false,
    premiumReportingCategory: 'ForProfit',
    configurationFields: [],
    pricingTiers: [],
    acknowledgementQuestions: [],
    productQuestionnaires: undefined,
    productImageFile: null,
    productLogoFile: null,
    productDocumentFile: null,
    productDocumentFiles: [],
    productImageUrl: '',
    productLogoUrl: '',
    productDocumentUrl: '',
    productDocuments: [],
    idCardLogoFile: null,
    idCardMemberIdPrefixMask: '',
    idCardData: emptyIdCardData(),
    planDetailsData: {},
    aiChunks: [],
    requiredASA: undefined,
    trainingConfig: undefined,
    medicalNeedsLinksConfig: undefined,
    includeProcessingFee: false,
    roundUpProcessingFee: true,
    processingFeePercentage: null
  };

  const formData = mergeWizardDraftFormData({
    template,
    e123Overrides,
    emptyWizardDefaults,
    tenantLogoUrl,
    noTemplateFields: {
      description: productDescription,
      productType,
      salesType: inferSalesType(category),
      allowedStates: inferAllowedStates(catalogEntry),
      requiredLicenses: inferRequiredLicenses(productType),
      isSSNRequired: true,
      vendorId: resolvedVendorId,
      vendorGroupIdProductType: inferVendorGroupIdProductType(label, category) || '',
      minAge: ageRange.min,
      maxAge: ageRange.max
    }
  });

  const prefilledSections = listPrefilledSections(formData, {
    templateUsed: !!template,
    rateGridUsed: !!(rateGrid?.rows?.length),
    tenantLogoUsed
  });

  return {
    formData,
    meta: {
      sourceProductKey: String(sourceProductKey),
      sourceProductLabel: group.sourceProductLabel,
      mappingMethod: 'deterministic',
      templateProductId: template?.productId || null,
      templateProductName: template?.productName || null,
      usedSharewellCatalog: catalogBenefits.size > 0,
      usedCsvSnapshot: !!csvSnapshot,
      csvSnapshotModifiedUtc: csvSnapshotRecord?.modifiedUtc || null,
      csvSnapshotTierCount: csvSnapshot?.derivedTiers?.length || 0,
      e123Composition,
      pricingFromCsvSnapshot,
      usedE123AgentCatalog: !!apiCatalogEntry,
      usedE123RateApi: !!(rateGrid?.rows?.length),
      e123RateApiError: rateGrid?.error || null,
      pricingTierCount: pricingTiers.length,
      configurationFieldCount: configurationFields.length,
      pricingAllocationCounts: allocationSources.reduce((acc, source) => {
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {}),
      vendorResolutionReason: vendorResolution.reason,
      vendorRouting: buildE123VendorRoutingPreview(csvSnapshot, normalizedVendorOverrides),
      vendorBucketOverrides: normalizedVendorOverrides,
      prefilledSections,
      warnings
    }
  };
}

module.exports = {
  buildE123ProductWizardDraft,
  buildE123VendorRoutingPreview,
  buildE123VendorRoutingPreviewForProduct,
  parseVendorBucketOverrides,
  loadE123CsvSnapshot,
  inferProductType,
  inferSalesType,
  inferAllowedStates,
  inferRequiredLicenses,
  resolveVendorId,
  buildPricingTiers,
  buildPricingTiersFromSnapshot,
  mergePricingTiers,
  mergeCatalogEntries,
  buildCatalogEntryFromSnapshot,
  allocationFromSnapshotDerivedRow,
  resolveMemberPremiumMsrp,
  resolveWizardMsrp,
  hasSnapshotAllocationSplits,
  tierAllocationCompleteness,
  detectE123ProductComposition,
  isCompositeE123Snapshot,
  dedupeDerivedTierRows,
  prepareDerivedTiersForWizard,
  wizardTierMapKey,
  wizardTierLabel,
  wizardTierIdentity,
  dedupeSnapshotAgeBands,
  resolveSnapshotTierCode,
  isAgeBandedAncillaryProduct,
  isAgeBandedSnapshotProduct,
  collectUnsharedAmountsFromSnapshot,
  aggregateAgeRangeFromSnapshot,
  extractUnsharedFromBenefitLabel,
  resolveBenefitTierCode,
  collectUnsharedAmounts,
  requiresTobaccoFromTiers,
  shouldUseTobaccoPricing,
  inferE123TobaccoPricingRecommendation,
  inferDefaultEffectiveDate,
  splitTobaccoRates,
  buildConfigurationFields,
  buildProductDescription,
  buildE123DraftOverrides,
  mergeWizardDraftFormData,
  buildMigrationAiChunks,
  stripHtmlForText
};
