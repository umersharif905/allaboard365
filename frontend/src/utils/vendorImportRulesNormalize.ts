import {
  DEFAULT_VENDOR_IMPORT_RULES,
  type ImportProduct,
  type KeyStrategy,
  type PlanKeyTierSource,
  type ProductMatch,
  type UaRelabelRule,
  type VendorImportRules,
} from '../types/vendor/vendorImportRules.types';
import {
  buildTierSourceFromPlanKey,
  inferTierModeFromStrategies,
} from './planKeySourceConfig';
import {
  keyStrategyFromPlanKey,
  legacyImportProductFromRules,
  normalizeRowGrain,
} from './importProductRules';

function deepMerge<T extends object>(base: T, overlay: Partial<T> | null): T {
  if (!overlay || typeof overlay !== 'object') return { ...base };
  const out = { ...base } as T;
  for (const key of Object.keys(overlay) as Array<keyof T>) {
    const v = overlay[key];
    const b = base[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[key] = deepMerge(b as object, v as object) as T[keyof T];
    } else if (v !== undefined) {
      out[key] = v as T[keyof T];
    }
  }
  return out;
}

export function normalizeVendorImportRules(raw?: Partial<VendorImportRules> | null): VendorImportRules {
  const merged = deepMerge(DEFAULT_VENDOR_IMPORT_RULES, raw || {});
  merged.tobacco.columns = (merged.tobacco.columns || []).map((c) => c.trim()).filter(Boolean);
  merged.tobacco.yesValues = (merged.tobacco.yesValues || []).map((v) => v.trim()).filter(Boolean);
  merged.planKey.uaRelabel = (merged.planKey.uaRelabel || [])
    .map((r: UaRelabelRule) => ({
      from: String(r.from ?? '').trim().replace(/\.0+$/, ''),
      to: String(r.to ?? '').trim().replace(/\.0+$/, ''),
    }))
    .filter((r) => r.from && r.to);
  const pmc = merged.productMapping.defaultProductNameContains;
  merged.productMapping.defaultProductNameContains = pmc ? String(pmc).trim() : null;
  merged.productMapping.planCodePrefixes = (merged.productMapping.planCodePrefixes || [])
    .map((p) => p.trim())
    .filter(Boolean);
  const includeRe = merged.planKey.sourceKeyIncludeRegex;
  merged.planKey.sourceKeyIncludeRegex = includeRe ? String(includeRe).trim() : null;
  merged.planKey.strategies = (merged.planKey.strategies || []).map((s) => s.trim()).filter(Boolean);
  if (!merged.planKey.strategies.length) {
    merged.planKey.strategies = merged.planKey.compositeFields?.length
      ? ['planCode', 'composite', 'tierUa']
      : ['planCode', 'tierUa'];
  }
  merged.planKey.compositeFields = (merged.planKey.compositeFields || [])
    .map((v) => String(v).trim())
    .filter(Boolean);
  merged.planKey.compositeSeparator = (merged.planKey.compositeSeparator || '_').trim() || '_';
  merged.planKey.tierFields = (merged.planKey.tierFields || '').trim() || DEFAULT_VENDOR_IMPORT_RULES.planKey.tierFields;
  merged.planKey.tierPattern = (merged.planKey.tierPattern || '').trim() || DEFAULT_VENDOR_IMPORT_RULES.planKey.tierPattern;
  merged.planKey.uaFields = (merged.planKey.uaFields || '').trim() || DEFAULT_VENDOR_IMPORT_RULES.planKey.uaFields;
  merged.planKey.planCodeFields = (merged.planKey.planCodeFields || '').trim()
    || DEFAULT_VENDOR_IMPORT_RULES.planKey.planCodeFields;

  const ps = merged.planKey.productSource;
  merged.planKey.productSource = {
    mode: ps.mode === 'fields' ? 'fields' : 'none',
    fields: String(ps.fields ?? 'Product_ID').trim()
      || DEFAULT_VENDOR_IMPORT_RULES.planKey.productSource.fields,
  };

  const tierSource: PlanKeyTierSource = {
    ...buildTierSourceFromPlanKey(merged.planKey),
    ...(merged.planKey.tierSource || {}),
    strategies: merged.planKey.tierSource?.strategies?.length
      ? merged.planKey.tierSource.strategies.map((s) => s.trim()).filter(Boolean)
      : merged.planKey.strategies,
    compositeFields: merged.planKey.tierSource?.compositeFields?.length
      ? merged.planKey.tierSource.compositeFields
      : merged.planKey.compositeFields,
    uaRelabel: merged.planKey.tierSource?.uaRelabel ?? merged.planKey.uaRelabel,
  };
  if (!tierSource.mode) {
    tierSource.mode = inferTierModeFromStrategies(tierSource.strategies);
  }
  merged.planKey.tierSource = tierSource;
  merged.planKey.strategies = tierSource.strategies;
  merged.planKey.compositeFields = tierSource.compositeFields;
  merged.planKey.compositeSeparator = tierSource.compositeSeparator;
  merged.planKey.tierFields = tierSource.tierFields;
  merged.planKey.tierPattern = tierSource.tierPattern;
  merged.planKey.uaFields = tierSource.uaFields;
  merged.planKey.planCodeFields = tierSource.planCodeFields;
  merged.planKey.tierUaSuffixRegex = tierSource.tierUaSuffixRegex;
  merged.planKey.uaRelabel = tierSource.uaRelabel;

  const assumed = merged.productMapping.assumedProductId;
  merged.productMapping.assumedProductId = assumed ? String(assumed).trim() : null;

  merged.rowGrain = normalizeRowGrain(merged.rowGrain);

  const hadExplicitProducts = Array.isArray((raw || {})?.products);
  if (hadExplicitProducts) {
    merged.products = normalizeImportProductsList(merged.products, merged);
  } else if (hasLegacyPlanKeyConfig(merged.planKey)) {
    merged.products = [legacyImportProductFromRules(merged)];
  } else {
    merged.products = [];
  }

  if (merged.products.length) {
    syncPlanKeyFromFirstProduct(merged);
  }

  merged.householdMemberId = {
    suffixStripPatterns: (merged.householdMemberId?.suffixStripPatterns || [])
      .map((p) => String(p).trim())
      .filter(Boolean),
  };

  return merged;
}

function hasLegacyPlanKeyConfig(planKey: VendorImportRules['planKey']): boolean {
  return !!(
    planKey.compositeFields?.length
    || planKey.strategies?.length
    || planKey.productSource?.mode === 'fields'
    || planKey.tierSource?.compositeFields?.length
  );
}

function normalizeProductMatch(raw?: ProductMatch | null): ProductMatch {
  const mode = raw?.mode || 'always';
  const field = raw?.field ? String(raw.field).trim() : undefined;
  const values = (raw?.values || []).map((v) => String(v).trim()).filter(Boolean);
  if (mode === 'fieldEquals') return { mode, field, values };
  if (mode === 'fieldTruthy' || mode === 'fieldNonBlank') return { mode, field };
  return { mode: 'always' };
}

function normalizeKeyStrategy(raw?: KeyStrategy | null, fallback?: KeyStrategy): KeyStrategy {
  const base = fallback || keyStrategyFromPlanKey(DEFAULT_VENDOR_IMPORT_RULES.planKey);
  const ks = { ...base, ...(raw || {}) };
  ks.type = ['planCode', 'composite', 'codedMap', 'householdTier'].includes(ks.type)
    ? ks.type
    : 'planCode';
  ks.strategies = (ks.strategies || base.strategies || []).map((s) => s.trim()).filter(Boolean);
  if (!ks.strategies.length) {
    ks.strategies = ks.type === 'composite' ? ['planCode', 'composite', 'tierUa'] : ['planCode', 'tierUa'];
  }
  ks.compositeFields = (ks.compositeFields || []).map((v) => String(v).trim()).filter(Boolean);
  ks.compositeSeparator = (ks.compositeSeparator || '_').trim() || '_';
  ks.tierFields = (ks.tierFields || base.tierFields || '').trim();
  ks.tierPattern = (ks.tierPattern || base.tierPattern || '').trim();
  ks.uaFields = (ks.uaFields || base.uaFields || '').trim();
  ks.planCodeFields = (ks.planCodeFields || base.planCodeFields || '').trim();
  ks.tierUaSuffixRegex = (ks.tierUaSuffixRegex || base.tierUaSuffixRegex || '').trim();
  ks.uaRelabel = (ks.uaRelabel || [])
    .map((r) => ({
      from: String(r.from ?? '').trim().replace(/\.0+$/, ''),
      to: String(r.to ?? '').trim().replace(/\.0+$/, ''),
    }))
    .filter((r) => r.from && r.to);
  if (ks.valueMap && typeof ks.valueMap === 'object') {
    const vm: Record<string, string> = {};
    for (const [k, v] of Object.entries(ks.valueMap)) {
      const fk = String(k).trim().toUpperCase();
      const fv = String(v).trim().toUpperCase();
      if (fk && fv) vm[fk] = fv;
    }
    ks.valueMap = vm;
  }
  return ks;
}

function normalizeImportProductsList(
  raw: ImportProduct[] | undefined,
  merged: VendorImportRules,
): ImportProduct[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  const fallbackKs = keyStrategyFromPlanKey(merged.planKey);
  return raw.map((p, i) => ({
    id: String(p.id || `prod_${i}`).trim() || `prod_${i}`,
    label: String(p.label || `Product ${i + 1}`).trim() || `Product ${i + 1}`,
    targetProductId: p.targetProductId ? String(p.targetProductId).trim() : null,
    match: normalizeProductMatch(p.match),
    keyStrategy: normalizeKeyStrategy(p.keyStrategy, fallbackKs),
  }));
}

/** Keep legacy planKey in sync with first product for APIs that still read planKey. */
function syncPlanKeyFromFirstProduct(merged: VendorImportRules): void {
  const first = merged.products?.[0];
  if (!first) return;
  const ks = first.keyStrategy;
  merged.planKey.strategies = ks.strategies || merged.planKey.strategies;
  merged.planKey.compositeFields = ks.compositeFields || [];
  merged.planKey.compositeSeparator = ks.compositeSeparator || '_';
  merged.planKey.tierFields = ks.tierFields || merged.planKey.tierFields;
  merged.planKey.tierPattern = ks.tierPattern || merged.planKey.tierPattern;
  merged.planKey.uaFields = ks.uaFields || merged.planKey.uaFields;
  merged.planKey.planCodeFields = ks.planCodeFields || merged.planKey.planCodeFields;
  merged.planKey.tierUaSuffixRegex = ks.tierUaSuffixRegex || merged.planKey.tierUaSuffixRegex;
  merged.planKey.uaRelabel = ks.uaRelabel || [];
  merged.planKey.tierSource = {
    ...buildTierSourceFromPlanKey(merged.planKey),
    strategies: ks.strategies || [],
    compositeFields: ks.compositeFields || [],
    compositeSeparator: ks.compositeSeparator || '_',
    tierFields: ks.tierFields,
    tierPattern: ks.tierPattern,
    uaFields: ks.uaFields,
    planCodeFields: ks.planCodeFields,
    tierUaSuffixRegex: ks.tierUaSuffixRegex,
    uaRelabel: ks.uaRelabel || [],
  };
  if (first.targetProductId) {
    merged.productMapping.assumedProductId = first.targetProductId;
  }
}

/** True when import rules use the multi-product engine (explicit products[] in stored JSON). */
export function usesMultiProductRules(rules?: VendorImportRules | null): boolean {
  return Array.isArray(rules?.products) && rules!.products!.length > 0;
}

export function buildEffectiveImportRulesFromPreset(preset: {
  importRules?: VendorImportRules | null;
  tobaccoCsvColumn?: string;
  tobaccoYesValues?: string[];
}): VendorImportRules {
  const base = normalizeVendorImportRules(preset.importRules);
  const column = preset.tobaccoCsvColumn?.trim();
  if (column) {
    const rest = base.tobacco.columns.filter((c) => c !== column);
    base.tobacco.columns = [column, ...rest];
  }
  if (preset.tobaccoYesValues?.length) {
    base.tobacco.yesValues = preset.tobaccoYesValues;
  }
  return base;
}

export function relabelUaForRules(ua: string, rules?: VendorImportRules | null): string {
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
