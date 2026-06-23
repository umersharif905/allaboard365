'use strict';

/**
 * Per-format import rules (stored on oe.VendorImportFormatPresets.ImportRulesJson).
 * No vendor-specific hardcoding — Align/Mightywell values live in DB seed JSON only.
 */

const VALID_ROW_GRAINS = ['perPrimary', 'perProduct', 'perMember'];

const DEFAULT_IMPORT_RULES = {
  rowGrain: 'perPrimary',
  products: [],
  tobacco: {
    columns: ['Tobacco Surcharge', 'Tobacco_Surcharge', 'TobaccoSurcharge'],
    yesValues: [],
    yesWhenNumericGreaterThan: 0,
    yesTextPatterns: ['yes', 'y', 'true', '1'],
  },
  planKey: {
    /** Ordered resolution strategies: planCode | composite | tierUa */
    strategies: ['planCode', 'tierUa'],
    /** Each entry: comma-separated export-field fallbacks for one composite segment (joined with compositeSeparator). */
    compositeFields: [],
    compositeSeparator: '_',
    tierFields: 'PlanTier,Family Size Tier,Plan Tier,Coverage Tier',
    tierPattern: '^(EE|ES|EC|EF)$',
    uaFields: 'UA,Deductible IUA,Plan Base',
    planCodeFields: 'Plan Name,Product Name',
    tierUaSuffixRegex: '(\\d{3,6})(EE|ES|EC|EF)$',
    uaRelabel: [],
    sourceKeyIncludeRegex: null,
  },
  productMapping: {
    assumedProductId: null,
    defaultProductNameContains: null,
    planCodePrefixes: [],
  },
  /** Optional regexes to derive household base member id (first capture group). */
  householdMemberId: {
    suffixStripPatterns: [],
  },
};

const DEFAULT_PRODUCT_SOURCE = {
  mode: 'none',
  fields: 'Product_ID',
};

function inferTierModeFromStrategies(strategies) {
  const s = strategies || [];
  if (s.includes('composite') && s.includes('tierUa')) return 'composite_then_tier';
  if (s[0] === 'composite' && s.length === 1) return 'composite';
  if (s[0] === 'tierUa' && !s.includes('composite')) return 'tierUa';
  if (s[0] === 'planCode' && !s.includes('composite')) return 'planCode';
  return 'composite_then_tier';
}

function syncProductTierSources(planKey) {
  const ps = planKey.productSource || {};
  planKey.productSource = {
    mode: ps.mode === 'fields' ? 'fields' : 'none',
    fields: String(ps.fields || DEFAULT_PRODUCT_SOURCE.fields).trim(),
  };

  const strategies = normalizePlanKeyStrategies(planKey);
  const tierSource = planKey.tierSource || {};
  planKey.tierSource = {
    mode: tierSource.mode || inferTierModeFromStrategies(strategies),
    strategies: tierSource.strategies?.length ? tierSource.strategies : strategies,
    compositeFields: normalizeCompositeFieldsList(
      tierSource.compositeFields?.length ? tierSource.compositeFields : planKey.compositeFields,
    ),
    compositeSeparator: String(tierSource.compositeSeparator || planKey.compositeSeparator || '_').trim() || '_',
    tierFields: normalizeFieldsCsvSpec(tierSource.tierFields, planKey.tierFields, DEFAULT_IMPORT_RULES.planKey.tierFields),
    tierPattern: String(tierSource.tierPattern || planKey.tierPattern || DEFAULT_IMPORT_RULES.planKey.tierPattern).trim(),
    uaFields: normalizeFieldsCsvSpec(tierSource.uaFields, planKey.uaFields, DEFAULT_IMPORT_RULES.planKey.uaFields),
    planCodeFields: normalizeFieldsCsvSpec(
      tierSource.planCodeFields,
      planKey.planCodeFields,
      DEFAULT_IMPORT_RULES.planKey.planCodeFields,
    ),
    tierUaSuffixRegex: String(
      tierSource.tierUaSuffixRegex || planKey.tierUaSuffixRegex || DEFAULT_IMPORT_RULES.planKey.tierUaSuffixRegex,
    ).trim(),
    uaRelabel: tierSource.uaRelabel || planKey.uaRelabel || [],
  };

  planKey.strategies = planKey.tierSource.strategies;
  planKey.compositeFields = planKey.tierSource.compositeFields;
  planKey.compositeSeparator = planKey.tierSource.compositeSeparator;
  planKey.tierFields = planKey.tierSource.tierFields;
  planKey.tierPattern = planKey.tierSource.tierPattern;
  planKey.uaFields = planKey.tierSource.uaFields;
  planKey.planCodeFields = planKey.tierSource.planCodeFields;
  planKey.tierUaSuffixRegex = planKey.tierSource.tierUaSuffixRegex;
  planKey.uaRelabel = planKey.tierSource.uaRelabel;
  return planKey;
}

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== 'object') return { ...base };
  const out = { ...base };
  for (const key of Object.keys(overlay)) {
    const v = overlay[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], v);
    } else if (v !== undefined) {
      out[key] = v;
    }
  }
  return out;
}

function parseImportRulesJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function normalizeImportRules(raw) {
  const parsed = typeof raw === 'string' ? parseImportRulesJson(raw) : raw;
  const merged = deepMerge(DEFAULT_IMPORT_RULES, parsed || {});

  merged.tobacco.columns = (merged.tobacco.columns || [])
    .map((c) => String(c).trim())
    .filter(Boolean);
  merged.tobacco.yesValues = (merged.tobacco.yesValues || [])
    .map((v) => String(v).trim())
    .filter((v) => v !== '');
  merged.tobacco.yesTextPatterns = (merged.tobacco.yesTextPatterns || [])
    .map((v) => String(v).trim().toLowerCase())
    .filter(Boolean);

  merged.planKey.tierUaSuffixRegex = String(merged.planKey.tierUaSuffixRegex || '').trim()
    || DEFAULT_IMPORT_RULES.planKey.tierUaSuffixRegex;
  merged.planKey.uaRelabel = (merged.planKey.uaRelabel || [])
    .map((r) => ({
      from: String(r.from ?? r.fileUa ?? '').trim().replace(/\.0+$/, ''),
      to: String(r.to ?? r.catalogUa ?? '').trim().replace(/\.0+$/, ''),
    }))
    .filter((r) => r.from && r.to);

  const includeRe = merged.planKey.sourceKeyIncludeRegex;
  merged.planKey.sourceKeyIncludeRegex = includeRe ? String(includeRe).trim() : null;

  merged.planKey.strategies = normalizePlanKeyStrategies(merged.planKey);
  merged.planKey.compositeFields = normalizeCompositeFieldsList(merged.planKey.compositeFields);
  merged.planKey.compositeSeparator = String(merged.planKey.compositeSeparator || '_').trim() || '_';
  merged.planKey.tierFields = normalizeFieldsCsvSpec(merged.planKey.tierFields, DEFAULT_IMPORT_RULES.planKey.tierFields);
  merged.planKey.tierPattern = String(merged.planKey.tierPattern || DEFAULT_IMPORT_RULES.planKey.tierPattern).trim();
  merged.planKey.uaFields = normalizeFieldsCsvSpec(merged.planKey.uaFields, DEFAULT_IMPORT_RULES.planKey.uaFields);
  merged.planKey.planCodeFields = normalizeFieldsCsvSpec(
    merged.planKey.planCodeFields,
    DEFAULT_IMPORT_RULES.planKey.planCodeFields,
  );

  const pmc = merged.productMapping.defaultProductNameContains;
  merged.productMapping.defaultProductNameContains = pmc
    ? String(pmc).trim()
    : null;
  merged.productMapping.planCodePrefixes = (merged.productMapping.planCodePrefixes || [])
    .map((p) => String(p).trim())
    .filter(Boolean);
  const assumed = merged.productMapping.assumedProductId;
  merged.productMapping.assumedProductId = assumed ? String(assumed).trim() : null;

  syncProductTierSources(merged.planKey);

  const rg = String(merged.rowGrain || '').trim();
  merged.rowGrain = VALID_ROW_GRAINS.includes(rg) ? rg : DEFAULT_IMPORT_RULES.rowGrain;
  merged.products = normalizeImportProductsArray(merged.products, merged.planKey);

  const patterns = merged.householdMemberId?.suffixStripPatterns || [];
  merged.householdMemberId = {
    suffixStripPatterns: patterns
      .map((p) => String(p).trim())
      .filter(Boolean),
  };

  return merged;
}

/**
 * Normalize member id for household grouping using format ImportRulesJson.
 * Each suffixStripPattern is a regex; first capture group becomes the base id when matched.
 */
function normalizeHouseholdMemberIdForGrouping(memberId, rules) {
  const s = String(memberId || '').trim();
  if (!s) return s;
  const r = normalizeImportRules(rules);
  const patterns = r.householdMemberId?.suffixStripPatterns || [];
  for (const raw of patterns) {
    try {
      const m = s.match(new RegExp(raw, 'i'));
      if (m?.[1]) return String(m[1]).trim();
    } catch {
      /* invalid pattern — skip */
    }
  }
  return s;
}

function normalizeProductMatch(raw) {
  const mode = raw?.mode || 'always';
  const field = raw?.field ? String(raw.field).trim() : '';
  const values = (raw?.values || []).map((v) => String(v).trim()).filter(Boolean);
  if (mode === 'fieldEquals') return { mode, field, values };
  if (mode === 'fieldTruthy' || mode === 'fieldNonBlank') return { mode, field };
  return { mode: 'always' };
}

function normalizeKeyStrategyConfig(raw, fallbackPlanKey) {
  const pk = fallbackPlanKey || DEFAULT_IMPORT_RULES.planKey;
  const base = {
    type: 'planCode',
    strategies: normalizePlanKeyStrategies(pk),
    compositeFields: normalizeCompositeFieldsList(pk.compositeFields),
    compositeSeparator: pk.compositeSeparator || '_',
    tierFields: pk.tierFields,
    tierPattern: pk.tierPattern,
    uaFields: pk.uaFields,
    planCodeFields: pk.planCodeFields,
    tierUaSuffixRegex: pk.tierUaSuffixRegex,
    uaRelabel: pk.uaRelabel || [],
    valueMap: {},
  };
  const ks = { ...base, ...(raw || {}) };
  const types = ['planCode', 'composite', 'codedMap', 'householdTier'];
  ks.type = types.includes(ks.type) ? ks.type : 'planCode';
  ks.strategies = (ks.strategies || base.strategies).map((s) => String(s).trim()).filter(Boolean);
  if (!ks.strategies.length) {
    ks.strategies = ks.type === 'composite' ? ['planCode', 'composite', 'tierUa'] : ['planCode', 'tierUa'];
  }
  ks.compositeFields = normalizeCompositeFieldsList(ks.compositeFields);
  ks.compositeSeparator = String(ks.compositeSeparator || '_').trim() || '_';
  ks.tierFields = normalizeFieldsCsvSpec(ks.tierFields, pk.tierFields, DEFAULT_IMPORT_RULES.planKey.tierFields);
  ks.tierPattern = String(ks.tierPattern || pk.tierPattern).trim();
  ks.uaFields = normalizeFieldsCsvSpec(ks.uaFields, pk.uaFields, DEFAULT_IMPORT_RULES.planKey.uaFields);
  ks.planCodeFields = normalizeFieldsCsvSpec(ks.planCodeFields, pk.planCodeFields, DEFAULT_IMPORT_RULES.planKey.planCodeFields);
  ks.tierUaSuffixRegex = String(ks.tierUaSuffixRegex || pk.tierUaSuffixRegex).trim();
  ks.uaRelabel = (ks.uaRelabel || []).map((r) => ({
    from: String(r.from ?? '').trim().replace(/\.0+$/, ''),
    to: String(r.to ?? '').trim().replace(/\.0+$/, ''),
  })).filter((r) => r.from && r.to);
  if (ks.valueMap && typeof ks.valueMap === 'object') {
    const vm = {};
    for (const [k, v] of Object.entries(ks.valueMap)) {
      const fk = String(k).trim().toUpperCase();
      const fv = String(v).trim().toUpperCase();
      if (fk && fv) vm[fk] = fv;
    }
    ks.valueMap = vm;
  } else {
    ks.valueMap = {};
  }
  return ks;
}

function normalizeImportProductsArray(raw, planKey) {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw.map((p, i) => ({
    id: String(p.id || `prod_${i}`).trim() || `prod_${i}`,
    label: String(p.label || `Product ${i + 1}`).trim() || `Product ${i + 1}`,
    targetProductId: p.targetProductId ? String(p.targetProductId).trim() : null,
    match: normalizeProductMatch(p.match),
    keyStrategy: normalizeKeyStrategyConfig(p.keyStrategy, planKey),
  }));
}

function usesMultiProductResolver(rules) {
  if (!rules || typeof rules !== 'object') return false;
  return Array.isArray(rules.products) && rules.products.length > 0;
}

function isTruthyCellValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  const upper = s.toUpperCase();
  if (['YES', 'Y', 'TRUE', '1', '100'].includes(upper)) return true;
  const num = Number(s.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(num) && num > 0;
}

function evalProductMatch(row, match) {
  const m = normalizeProductMatch(match);
  if (m.mode === 'always') return true;
  if (!m.field) return false;
  const raw = firstRowValueByFieldsCsv(row, m.field);
  if (m.mode === 'fieldNonBlank') return !!String(raw || '').trim();
  if (m.mode === 'fieldTruthy') return isTruthyCellValue(raw);
  if (m.mode === 'fieldEquals') {
    const val = String(raw || '').trim().toUpperCase();
    const allowed = (m.values || []).map((v) => String(v).trim().toUpperCase()).filter(Boolean);
    if (!allowed.length) return !!val;
    return allowed.includes(val);
  }
  return false;
}

function planKeyRulesFromKeyStrategy(keyStrategy, baseRules) {
  const r = normalizeImportRules(baseRules);
  const ks = normalizeKeyStrategyConfig(keyStrategy, r.planKey);
  const planKey = {
    ...r.planKey,
    strategies: ks.strategies,
    compositeFields: ks.compositeFields,
    compositeSeparator: ks.compositeSeparator,
    tierFields: ks.tierFields,
    tierPattern: ks.tierPattern,
    uaFields: ks.uaFields,
    planCodeFields: ks.planCodeFields,
    tierUaSuffixRegex: ks.tierUaSuffixRegex,
    uaRelabel: ks.uaRelabel,
  };
  syncProductTierSources(planKey);
  return { ...r, planKey };
}

function inferHouseholdTierFromContext(ctx) {
  const hasPrimary = !!ctx?.hasPrimary;
  const hasSpouse = !!ctx?.hasSpouse;
  const hasChild = !!ctx?.hasChild;
  if (hasPrimary && !hasSpouse && !hasChild) return 'EE';
  if (hasPrimary && hasSpouse && !hasChild) return 'ES';
  if (hasPrimary && !hasSpouse && hasChild) return 'EC';
  if (hasPrimary && hasSpouse && hasChild) return 'EF';
  return 'EE';
}

function planKeyFromKeyStrategy(row, keyStrategy, rules, ctx = {}) {
  const ks = normalizeKeyStrategyConfig(keyStrategy, rules?.planKey);
  if (ks.type === 'householdTier') {
    const tier = inferHouseholdTierFromContext(ctx);
    const ua = normalizePlanUa(firstRowValueByFieldsCsv(row, ks.uaFields));
    if (tier && ua) return `${tier}_${relabelUaForRules(ua, normalizeImportRules(rules))}`;
    return tier || '';
  }
  if (ks.type === 'codedMap') {
    const codeRaw = firstRowValueByFieldsCsv(row, ks.tierFields).toUpperCase();
    const mapped = ks.valueMap?.[codeRaw] || codeRaw;
    const ua = normalizePlanUa(firstRowValueByFieldsCsv(row, ks.uaFields));
    if (mapped && ua) return `${mapped}_${relabelUaForRules(ua, normalizeImportRules(rules))}`;
    return mapped || '';
  }
  if (ks.type === 'planCode') {
    const { isTierOnlyPlanKey } = require('./eligibilityImportValidation');
    const raw = firstRowValueByFieldsCsv(row, ks.planCodeFields);
    if (!raw || isGenericProductPlanName(raw)) return '';
    const derived = deriveTierUaImportKeyFromPlanCodeWithRules(raw, normalizeImportRules(rules));
    if (derived) return derived;
    if (isTierOnlyPlanKey(raw)) {
      const subRules = planKeyRulesFromKeyStrategy(ks, rules);
      for (const strategy of ks.strategies) {
        if (strategy === 'planCode') continue;
        const key = tryPlanKeyStrategy(row, subRules, strategy);
        if (key) return key;
      }
      return '';
    }
    if (String(raw).includes('_')) return String(raw).trim();
    return '';
  }
  const subRules = planKeyRulesFromKeyStrategy(ks, rules);
  if (ks.type === 'composite') {
    for (const strategy of ['composite', 'tierUa', 'planCode']) {
      const key = tryPlanKeyStrategy(row, subRules, strategy);
      if (key) return key;
    }
    return '';
  }
  for (const strategy of ks.strategies) {
    const key = tryPlanKeyStrategy(row, subRules, strategy);
    if (key) return key;
  }
  return '';
}

/**
 * Resolve zero or more product catalog keys for one CSV row (multi-product formats).
 * @returns {Array<{ productId, label, targetProductId, key }>}
 */
function resolveProductsForRow(row, rules, ctx = {}) {
  const r = normalizeImportRules(rules);
  if (!usesMultiProductResolver(rules)) {
    const key = planKeyFromImportRules(row, r);
    if (!key) return [];
    return [{
      productId: null,
      label: null,
      targetProductId: r.productMapping?.assumedProductId || null,
      key,
    }];
  }
  const out = [];
  for (const product of r.products) {
    if (!evalProductMatch(row, product.match)) continue;
    const key = planKeyFromKeyStrategy(row, product.keyStrategy, r, ctx);
    if (!key) continue;
    out.push({
      productId: product.id,
      label: product.label,
      targetProductId: product.targetProductId,
      key,
    });
  }
  return out;
}

function normalizeFieldsCsvSpec(val, fallback = '') {
  if (Array.isArray(val)) {
    const parts = val.map((v) => String(v).trim()).filter(Boolean);
    return parts.length ? parts.join(',') : fallback;
  }
  const s = String(val ?? '').trim();
  return s || fallback;
}

function normalizeCompositeFieldsList(val) {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(val)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizePlanKeyStrategies(planKey) {
  const raw = planKey?.strategies;
  let strategies = [];
  if (Array.isArray(raw)) {
    strategies = raw.map((s) => String(s).trim()).filter(Boolean);
  } else if (typeof raw === 'string' && raw.trim()) {
    strategies = raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (strategies.length) return strategies;
  if (normalizeCompositeFieldsList(planKey?.compositeFields).length) {
    return ['planCode', 'composite', 'tierUa'];
  }
  return [...DEFAULT_IMPORT_RULES.planKey.strategies];
}

function normalizePlanUa(value) {
  return String(value || '')
    .trim()
    .replace(/[$,]/g, '')
    .replace(/\.0+$/, '');
}

/** First non-empty value from row using comma-separated field / placeholder names (same pattern as tobacco columns). */
function firstRowValueByFieldsCsv(row, fieldsCsv) {
  if (!row || !fieldsCsv) return '';
  let exportFieldByPlaceholder = null;
  const names = String(fieldsCsv).split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    const direct = row[name];
    if (direct != null && String(direct).trim() !== '') return String(direct).trim();
    if (!exportFieldByPlaceholder) {
      try {
        const VendorExportService = require('../services/vendorExportService');
        exportFieldByPlaceholder = VendorExportService.getPlaceholderToFieldMap();
      } catch {
        exportFieldByPlaceholder = {};
      }
    }
    const mapped = exportFieldByPlaceholder[name];
    if (mapped) {
      const v = row[mapped];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return '';
}

function isGenericProductPlanName(name) {
  const { isGenericProductPlanName: isGeneric } = require('./eligibilityImportValidation');
  return isGeneric(name);
}

function tryPlanKeyStrategy(row, rules, strategy) {
  const r = normalizeImportRules(rules);

  if (strategy === 'composite') {
    const segments = r.planKey.compositeFields;
    if (!segments.length) return '';
    const parts = segments.map((seg) => firstRowValueByFieldsCsv(row, seg));
    if (parts.some((p) => !p)) return '';
    const composite = parts.join(r.planKey.compositeSeparator);
    const derived = deriveTierUaImportKeyFromPlanCodeWithRules(composite, r);
    return derived || composite;
  }

  if (strategy === 'tierUa') {
    const { isTierOnlyPlanKey } = require('./eligibilityImportValidation');
    let tier = firstRowValueByFieldsCsv(row, r.planKey.tierFields).toUpperCase();
    if (!tier) {
      const fromPlanCode = firstRowValueByFieldsCsv(row, r.planKey.planCodeFields);
      if (isTierOnlyPlanKey(fromPlanCode)) tier = fromPlanCode.toUpperCase();
    }
    const ua = normalizePlanUa(firstRowValueByFieldsCsv(row, r.planKey.uaFields));
    if (!tier || !ua) return '';
    try {
      if (!new RegExp(r.planKey.tierPattern, 'i').test(tier)) return '';
    } catch {
      return '';
    }
    return `${tier}_${relabelUaForRules(ua, r)}`;
  }

  if (strategy === 'planCode') {
    const { isTierOnlyPlanKey } = require('./eligibilityImportValidation');
    const raw = firstRowValueByFieldsCsv(row, r.planKey.planCodeFields);
    if (!raw || isGenericProductPlanName(raw)) return '';
    if (isTierOnlyPlanKey(raw)) return '';
    const derived = deriveTierUaImportKeyFromPlanCodeWithRules(raw, r);
    if (derived) return derived;
    if (String(raw).includes('_')) return raw;
    return '';
  }

  return '';
}

/**
 * Resolve import / catalog lookup key from row using format ImportRulesJson only.
 * Does not fall back to a different key shape unless the next strategy in rules says so.
 */
/** True when format rules define composite/tierUa resolution (not generic planCode-only). */
function importRulesUsePlanKeyResolver(rules) {
  const r = normalizeImportRules(rules);
  if (r.planKey.compositeFields.length) return true;
  return r.planKey.strategies.some((s) => s === 'composite' || s === 'tierUa');
}

/** Vendor product id from file (Product_ID etc.) when productSource.mode = fields. */
function productIdKeyFromImportRules(row, rules) {
  const r = normalizeImportRules(rules);
  const ps = r.planKey.productSource;
  if (!ps || ps.mode !== 'fields') return '';
  const raw = firstRowValueByFieldsCsv(row, ps.fields);
  return String(raw || '').trim().replace(/\.0+$/, '');
}

function planKeyFromImportRules(row, rules) {
  const r = normalizeImportRules(rules);
  const strategies = r.planKey.tierSource?.strategies?.length
    ? r.planKey.tierSource.strategies
    : r.planKey.strategies;
  for (const strategy of strategies) {
    const key = tryPlanKeyStrategy(row, r, strategy);
    if (key) return key;
  }
  return '';
}

function relabelUaForRules(ua, rules) {
  let out = String(ua || '').trim().replace(/\.0+$/, '');
  if (!out || !rules?.planKey?.uaRelabel?.length) return out;
  for (const { from, to } of rules.planKey.uaRelabel) {
    if (out === from) {
      out = to;
      break;
    }
  }
  return out;
}

function tobaccoStatusFromImportRow(row, rules) {
  const r = normalizeImportRules(rules);
  let raw = '';
  for (const col of r.tobacco.columns) {
    const v = row[col];
    if (v != null && String(v).trim() !== '') {
      raw = String(v).trim();
      break;
    }
  }
  if (!raw) return 'No';

  const lower = raw.toLowerCase();
  if (r.tobacco.yesValues.some((y) => lower === String(y).toLowerCase())) return 'Yes';
  if (r.tobacco.yesTextPatterns.includes(lower)) return 'Yes';

  const num = Number(raw.replace(/[^0-9.-]/g, ''));
  if (Number.isFinite(num) && num > (r.tobacco.yesWhenNumericGreaterThan ?? 0)) return 'Yes';

  return 'No';
}

function importRowDedupeKey(row, planKey, rules) {
  const pk = String(planKey || '').trim();
  if (!pk) return '';
  return `${pk}|${tobaccoStatusFromImportRow(row, rules)}`;
}

function deriveTierUaImportKeyFromPlanCodeWithRules(planCode, rules) {
  const { deriveTierUaImportKeyFromPlanCode } = require('./vendorImportPricingKey');
  const raw = String(planCode || '').trim();
  if (!raw) return null;

  const r = normalizeImportRules(rules);
  const upper = raw.toUpperCase();

  try {
    const re = new RegExp(r.planKey.tierUaSuffixRegex, 'i');
    const suffix = upper.match(re);
    if (suffix) {
      let ua = suffix[1].replace(/\.0+$/, '');
      const tier = suffix[2].toUpperCase();
      ua = relabelUaForRules(ua, r);
      return `${tier}_${ua}`;
    }
  } catch {
    /* invalid regex — fall through */
  }

  const derived = deriveTierUaImportKeyFromPlanCode(planCode);
  if (!derived) return null;

  const uaMatch = derived.match(/^([A-Z]+)_([0-9.]+)$/);
  if (uaMatch) {
    const ua = relabelUaForRules(uaMatch[2], r);
    return `${uaMatch[1]}_${ua}`;
  }
  return derived;
}

function coerceImportRulesPatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};
  if (patch.importRules !== undefined) {
    out.importRules = normalizeImportRules(
      typeof patch.importRules === 'string' ? parseImportRulesJson(patch.importRules) : patch.importRules,
    );
  }
  return out;
}

function parseTobaccoYesValues(raw) {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (raw == null || raw === '') return [];
  return String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Merge first-class tobacco columns on format preset with plan-key rules in ImportRulesJson.
 */
function buildEffectiveImportRules(preset) {
  const base = normalizeImportRules(preset?.importRules);
  const column = String(preset?.tobaccoCsvColumn || '').trim();
  const yesValues = parseTobaccoYesValues(preset?.tobaccoYesValues);
  if (column) {
    const rest = base.tobacco.columns.filter((c) => c !== column);
    base.tobacco.columns = [column, ...rest];
  }
  if (yesValues.length) base.tobacco.yesValues = yesValues;
  return base;
}

/** Persist plan-key rules only — tobacco lives in TobaccoCsvColumn / TobaccoYesValues. */
function importRulesForStorage(raw) {
  const r = normalizeImportRules(raw);
  r.tobacco = { ...DEFAULT_IMPORT_RULES.tobacco };
  return r;
}

function validateImportRulesPatch(patch) {
  const warnings = [];
  const cleaned = coerceImportRulesPatch(patch);
  if (cleaned.importRules?.rowGrain && !VALID_ROW_GRAINS.includes(cleaned.importRules.rowGrain)) {
    warnings.push(`rowGrain must be one of: ${VALID_ROW_GRAINS.join(', ')}`);
  }
  for (const p of cleaned.importRules?.products || []) {
    if (!p.label) warnings.push('Each product needs a label');
    if (p.match?.mode !== 'always' && !p.match?.field) {
      warnings.push(`Product "${p.label || p.id}": match field required`);
    }
    if (!['planCode', 'composite', 'codedMap', 'householdTier'].includes(p.keyStrategy?.type)) {
      warnings.push(`Product "${p.label || p.id}": invalid keyStrategy.type`);
    }
  }
  if (cleaned.importRules?.planKey?.tierUaSuffixRegex) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(cleaned.importRules.planKey.tierUaSuffixRegex, 'i');
    } catch {
      warnings.push('planKey.tierUaSuffixRegex is not a valid regular expression');
    }
  }
  if (cleaned.importRules?.planKey?.tierPattern) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(cleaned.importRules.planKey.tierPattern, 'i');
    } catch {
      warnings.push('planKey.tierPattern is not a valid regular expression');
    }
  }
  for (const raw of cleaned.importRules?.householdMemberId?.suffixStripPatterns || []) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(String(raw), 'i');
    } catch {
      warnings.push(`householdMemberId.suffixStripPatterns: invalid regex "${raw}"`);
    }
  }
  return { patch: cleaned, warnings };
}

module.exports = {
  DEFAULT_IMPORT_RULES,
  VALID_ROW_GRAINS,
  normalizeImportRules,
  parseImportRulesJson,
  parseTobaccoYesValues,
  buildEffectiveImportRules,
  importRulesForStorage,
  tobaccoStatusFromImportRow,
  importRowDedupeKey,
  planKeyFromImportRules,
  productIdKeyFromImportRules,
  importRulesUsePlanKeyResolver,
  firstRowValueByFieldsCsv,
  deriveTierUaImportKeyFromPlanCodeWithRules,
  relabelUaForRules,
  coerceImportRulesPatch,
  validateImportRulesPatch,
  usesMultiProductResolver,
  evalProductMatch,
  planKeyFromKeyStrategy,
  resolveProductsForRow,
  inferHouseholdTierFromContext,
  normalizeKeyStrategyConfig,
  normalizeProductMatch,
  normalizeHouseholdMemberIdForGrouping,
};
