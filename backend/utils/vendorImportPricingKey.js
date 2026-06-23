'use strict';

const { relabelUaForRules, normalizeImportRules } = require('./vendorImportRules');

function normalizeKeyToken(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\.0+$/, '')
    .replace(/\s+/g, '');
}

/**
 * Build import file plan key from a ProductPricing row (e.g. EE_6000).
 */
function buildPricingImportKey(row) {
  const tier = normalizeKeyToken(row.TierType);
  let ua = null;

  for (let i = 1; i <= 5; i += 1) {
    const field = String(row[`ConfigField${i}`] || '').trim();
    const val = String(row[`ConfigValue${i}`] || '').trim();
    if (!val) continue;
    if (/ua|deductible|unshared|amount|plan selected/i.test(field)) {
      ua = val.replace(/\.0+$/, '');
      break;
    }
  }

  if (!ua && row.ConfigValue1 != null && String(row.ConfigValue1).trim()) {
    ua = String(row.ConfigValue1).trim().replace(/\.0+$/, '');
  }

  if (tier && ua) return `${tier}_${ua}`;
  if (tier) return tier;

  const label = String(row.Label || '').trim();
  if (label) return normalizeKeyToken(label.replace(/\s+/g, '_'));

  return null;
}

function formatPricingTierLabel(row) {
  const productName = row.ProductName || 'Product';
  const tier = row.TierType ? String(row.TierType).trim() : '';
  const ua = row.ConfigValue1 != null && String(row.ConfigValue1).trim()
    ? String(row.ConfigValue1).trim().replace(/\.0+$/, '')
    : '';
  const label = row.Label && row.Label !== tier ? String(row.Label).trim() : '';
  const tobacco = row.TobaccoStatus != null && String(row.TobaccoStatus).trim()
    ? String(row.TobaccoStatus).trim()
    : '';

  const parts = [];
  if (tier) parts.push(tier);
  if (ua) parts.push(`UA ${ua}`);
  if (tobacco) parts.push(`Tobacco ${tobacco}`);
  if (label) parts.push(label);
  const tierPart = parts.length ? parts.join(' · ') : 'Standard tier';
  return `${productName} — ${tierPart}`;
}

function normalizeSourceProductKey(key) {
  const s = String(key || '').trim().toUpperCase();
  const match = s.match(/^([A-Z]+)_([0-9.]+)$/);
  if (match) return `${match[1]}_${match[2].replace(/\.0+$/, '')}`;
  return normalizeKeyToken(s);
}

const TIER_UA_CANONICAL = /^(EE|ES|EC|EF)_(\d{3,6})$/i;
/** Composite vendor codes ending in UA digits + tier (e.g. 11321_AH1500EE → EE_1500). */
const TIER_UA_SUFFIX = /(\d{3,6})(EE|ES|EC|EF)$/i;

/**
 * Derive catalog import key {Tier}_{UA} from opaque composite plan codes in export files.
 * Returns null when the code cannot be normalized (caller keeps the raw key for manual mapping).
 */
function deriveTierUaImportKeyFromPlanCode(planCode) {
  const raw = String(planCode || '').trim();
  if (!raw) return null;

  const canonical = normalizeSourceProductKey(raw);
  if (TIER_UA_CANONICAL.test(canonical)) return canonical;

  const suffix = raw.toUpperCase().match(TIER_UA_SUFFIX);
  if (suffix) {
    const ua = suffix[1].replace(/\.0+$/, '');
    const tier = suffix[2].toUpperCase();
    return `${tier}_${ua}`;
  }

  return null;
}

/** Apply Align-style UA relabel (3000→2500, 6000→5000) to tier_UA catalog keys. */
function relabelTierUaCatalogKey(planKey, importRules) {
  const raw = String(planKey || '').trim().toUpperCase();
  if (!raw || !importRules) return raw;
  const rules = normalizeImportRules(importRules);
  const { deriveTierUaImportKeyFromPlanCodeWithRules } = require('./vendorImportRules');
  const fromComposite = deriveTierUaImportKeyFromPlanCodeWithRules(raw, rules);
  if (fromComposite) return fromComposite;
  const m = raw.match(/^([A-Z]+)_([0-9.]+)$/);
  if (!m) return raw;
  const ua = relabelUaForRules(m[2].replace(/\.0+$/, ''), rules);
  return `${m[1]}_${ua}`;
}

/** Candidate keys to match oe.VendorImportProductMap (raw, normalized, derived, relabeled). */
function importKeyLookupCandidates(planKey, importRules = null) {
  const raw = String(planKey || '').trim();
  if (!raw) return [];

  const candidates = [];
  const add = (k) => {
    if (k && !candidates.includes(k)) candidates.push(k);
  };

  add(raw);
  add(normalizeSourceProductKey(raw));
  add(deriveTierUaImportKeyFromPlanCode(raw));
  if (importRules) {
    const { deriveTierUaImportKeyFromPlanCodeWithRules } = require('./vendorImportRules');
    add(deriveTierUaImportKeyFromPlanCodeWithRules(raw, importRules));
    add(relabelTierUaCatalogKey(raw, importRules));
  }
  return candidates;
}

function resolveVendorImportProductMapping(productMap, planKey, importRules = null) {
  if (!productMap || typeof productMap.get !== 'function') return null;

  for (const key of importKeyLookupCandidates(planKey, importRules)) {
    const mapping = productMap.get(key);
    if (mapping?.ProductId && mapping?.ProductPricingId) {
      return { mapping, resolvedKey: key };
    }
  }
  return null;
}

function hasVendorImportProductMapping(productMap, planKey, importRules = null) {
  return !!resolveVendorImportProductMapping(productMap, planKey, importRules);
}

/** Same checks as preview/commit when multi-product rules scope map rows by targetProductId. */
function hasVendorImportProductMappingScoped(productMap, planKey, importRules, targetProductId = null) {
  const resolved = resolveVendorImportProductMapping(productMap, planKey, importRules);
  if (!resolved?.mapping?.ProductId || !resolved?.mapping?.ProductPricingId) return false;
  if (
    targetProductId
    && String(resolved.mapping.ProductId).toLowerCase() !== String(targetProductId).toLowerCase()
  ) {
    return false;
  }
  return true;
}

module.exports = {
  buildPricingImportKey,
  formatPricingTierLabel,
  normalizeSourceProductKey,
  normalizeKeyToken,
  deriveTierUaImportKeyFromPlanCode,
  importKeyLookupCandidates,
  relabelTierUaCatalogKey,
  resolveVendorImportProductMapping,
  hasVendorImportProductMapping,
  hasVendorImportProductMappingScoped,
};
