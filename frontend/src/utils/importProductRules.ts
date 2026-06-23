import type {
  ImportProduct,
  KeyStrategy,
  ProductMatch,
  RowGrain,
  VendorImportRules,
} from '../types/vendor/vendorImportRules.types';
import { DEFAULT_VENDOR_IMPORT_RULES } from '../types/vendor/vendorImportRules.types';
import { buildTierSourceFromPlanKey, strategiesForTierMode } from './planKeySourceConfig';

export function newImportProductId(): string {
  return `prod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultProductMatch(): ProductMatch {
  return { mode: 'always' };
}

export function keyStrategyFromPlanKey(planKey: VendorImportRules['planKey']): KeyStrategy {
  const ts = buildTierSourceFromPlanKey(planKey);
  let type: KeyStrategy['type'] = 'planCode';
  if (ts.mode === 'composite' || ts.mode === 'composite_then_tier') {
    type = ts.compositeFields.length ? 'composite' : 'planCode';
  } else if (ts.mode === 'tierUa') {
    type = 'planCode';
  }
  return {
    type,
    strategies: ts.strategies.length ? ts.strategies : strategiesForTierMode(ts.mode),
    compositeFields: ts.compositeFields,
    compositeSeparator: ts.compositeSeparator,
    tierFields: ts.tierFields,
    tierPattern: ts.tierPattern,
    uaFields: ts.uaFields,
    planCodeFields: ts.planCodeFields,
    tierUaSuffixRegex: ts.tierUaSuffixRegex,
    uaRelabel: ts.uaRelabel,
  };
}

/** Build a single legacy-style product entry from flat planKey (for migration). */
export function legacyImportProductFromRules(rules: VendorImportRules): ImportProduct {
  const assumed = rules.productMapping.assumedProductId;
  const ps = rules.planKey.productSource;
  let match: ProductMatch = { mode: 'always' };
  if (ps?.mode === 'fields' && ps.fields) {
    match = { mode: 'fieldNonBlank', field: ps.fields.split(',')[0]?.trim() };
  }
  return {
    id: newImportProductId(),
    label: 'Default product',
    targetProductId: assumed,
    match,
    keyStrategy: keyStrategyFromPlanKey(rules.planKey),
  };
}

export function normalizeRowGrain(raw?: string | null): RowGrain {
  const v = String(raw || '').trim();
  if (v === 'perProduct' || v === 'perMember') return v;
  return 'perPrimary';
}

export function emptyProductsRulesPatch(): Pick<VendorImportRules, 'products' | 'rowGrain'> {
  return {
    rowGrain: DEFAULT_VENDOR_IMPORT_RULES.rowGrain,
    products: [],
  };
}
