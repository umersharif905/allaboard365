'use strict';

const {
  deriveTierUaImportKeyFromPlanCode,
  hasVendorImportProductMappingScoped,
} = require('./vendorImportPricingKey');

const TIER_UA_KEY = /^(EE|ES|EC|EF)_(\d+(?:\.\d+)?)$/i;
const UA_ONLY_KEY = /^\d+(?:\.\d+)?$/;
const TIER_ONLY_KEY = /^(EE|ES|EC|EF)$/i;

function isTierUaPlanKey(key) {
  return TIER_UA_KEY.test(String(key || '').trim());
}

/** UA column value alone (Calstar and similar formats). */
function isUaOnlyPlanKey(key) {
  return UA_ONLY_KEY.test(String(key || '').trim());
}

function isTierOnlyPlanKey(key) {
  return TIER_ONLY_KEY.test(String(key || '').trim());
}

/** Product display names that are not valid catalog import keys. */
function isGenericProductPlanName(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (isTierUaPlanKey(n)) return false;
  if (isTierOnlyPlanKey(n)) return false;
  if (isUaOnlyPlanKey(n)) return false;
  return /essential|sharewell|healthshare|sw-health|wellness|copay|mec|dental|vision|quest|lyric|recuro|accident/i.test(n);
}

/**
 * Weak codes are ones unlikely to auto-map — not every non-{Tier}_{UA} key
 * (vendor-specific IDs like LYR123 or Calstar UA-only values are fine).
 */
function weakPlanCodeReason(planKey) {
  const key = String(planKey || '').trim();
  if (!key) return null;
  if (isGenericProductPlanName(key)) return 'generic_plan_name';
  if (isTierUaPlanKey(key) || isUaOnlyPlanKey(key)) return null;
  if (isTierOnlyPlanKey(key)) return 'tier_without_ua';
  return null;
}

function weakPlanCodeSuggestion(reason) {
  if (reason === 'generic_plan_name') {
    return 'Leave Plan Name blank and set Plan Tier (EE/ES/EC/EF) plus UA — the unshared amount from your product config (any value, e.g. {Tier}_1500 or {Tier}_3000).';
  }
  if (reason === 'tier_without_ua') {
    return 'Plan Tier is set without UA. Add the UA column matching your configured unshared amount for that product.';
  }
  return null;
}

/** Plan keys visible in raw CSV before format template maps Plan Name (Align SHA exports). */
function peekPlanKeysFromRawRows(rawRows = []) {
  const keys = new Set();
  for (const row of rawRows) {
    const planName = String(row['Plan Name'] || row['Product Name'] || '').trim();
    if (!planName) continue;
    const derived = deriveTierUaImportKeyFromPlanCode(planName);
    keys.add(derived || planName);
  }
  return [...keys];
}

function detectAlignShaFormatMismatch({ formatSlug, headers = [], distinctProducts = [], rawRows = [] }) {
  if (formatSlug !== 'sharewell_align') return null;
  if ((distinctProducts || []).length > 0) return null;

  const headerSet = new Set((headers || []).map((h) => String(h).trim().toLowerCase()));
  const hasPlanName = headerSet.has('plan name');
  const lacksNative = !headerSet.has('product_id') && !headerSet.has('benefit_id');
  if (!hasPlanName || !lacksNative) return null;

  const peeked = peekPlanKeysFromRawRows(rawRows);
  if (peeked.length === 0) return null;

  return {
    code: 'align_sha_layout',
    message:
      'File uses ShareWELL Standard columns (Plan Name with Align codes like 11321_AH3000ES). '
      + 'Use format "Align Health SHA (ShareWELL 24-col)" or update "Align Health (native + SHA plan codes)" '
      + 'to include Plan Name in the template. Detected plan keys: '
      + `${peeked.slice(0, 8).join(', ')}${peeked.length > 8 ? '…' : ''}.`,
  };
}

function buildEligibilityImportValidation({
  exportRows = [],
  rawRows = [],
  distinctProducts = [],
  planCodeGroups = [],
  productMap = new Map(),
  formatSlug = '',
  headers = [],
  productKeyFromRow,
  importRules = null,
}) {
  const keyFn = productKeyFromRow || (() => '');
  const groupByLookup = new Map(
    (planCodeGroups || []).map((g) => [g.lookupKey, g]),
  );
  const unmappedProducts = distinctProducts.filter((lookupKey) => {
    const targetProductId = groupByLookup.get(lookupKey)?.targetProductId || null;
    return !hasVendorImportProductMappingScoped(
      productMap,
      lookupKey,
      importRules,
      targetProductId,
    );
  });

  const weakPlanCodes = [];
  for (const planKey of unmappedProducts) {
    const reason = weakPlanCodeReason(planKey);
    if (reason) {
      weakPlanCodes.push({
        planKey,
        reason,
        suggestion: weakPlanCodeSuggestion(reason),
      });
    }
  }

  let rowsMissingPlanCode = 0;
  let rowsWithGenericPlanNameOnly = 0;
  for (const row of exportRows) {
    const pk = keyFn(row);
    if (!pk) rowsMissingPlanCode += 1;
    const planName = String(row['Plan Name'] || row['Product Name'] || '').trim();
    const tier = String(row['Plan Tier'] || row['Family Size Tier'] || '').trim();
    const ua = String(row.UA || row['Plan Selected.1'] || '').trim();
    if (planName && isGenericProductPlanName(planName) && !tier && !ua) {
      rowsWithGenericPlanNameOnly += 1;
    }
  }

  const formatIssues = [];
  if (formatSlug === 'sharewell_default') {
    const headerSet = new Set((headers || []).map((h) => String(h).trim().toLowerCase()));
    for (const col of ['plan tier', 'ua', 'member id']) {
      if (!headerSet.has(col)) {
        formatIssues.push({
          code: 'missing_column',
          message: `Expected column "${col}" for ShareWELL Standard format.`,
        });
      }
    }
  }

  const alignShaMismatch = detectAlignShaFormatMismatch({
    formatSlug,
    headers,
    distinctProducts,
    rawRows: rawRows.length ? rawRows : exportRows,
  });
  if (alignShaMismatch) formatIssues.push(alignShaMismatch);

  const mappedCount = distinctProducts.length - unmappedProducts.length;
  const hasBlockingIssues = unmappedProducts.length > 0
    || (distinctProducts.length === 0 && formatIssues.some((f) => f.code === 'align_sha_layout'));

  return {
    unmappedProducts,
    weakPlanCodes,
    rowsMissingPlanCode,
    rowsWithGenericPlanNameOnly,
    formatIssues,
    mappedProductCount: mappedCount,
    totalDistinctProducts: distinctProducts.length,
    hasBlockingIssues,
    summary: hasBlockingIssues
      ? `${unmappedProducts.length} plan code(s) need mapping before import.`
      : distinctProducts.length
        ? `All ${distinctProducts.length} plan code(s) are mapped.`
        : 'No plan codes found in file.',
  };
}

module.exports = {
  isTierUaPlanKey,
  isUaOnlyPlanKey,
  isTierOnlyPlanKey,
  isGenericProductPlanName,
  weakPlanCodeReason,
  peekPlanKeysFromRawRows,
  detectAlignShaFormatMismatch,
  buildEligibilityImportValidation,
};
