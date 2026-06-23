import type {
  PlanKeyTierSource,
  ProductSourceMode,
  TierSourceMode,
  VendorImportRules,
} from '../types/vendor/vendorImportRules.types';
import { DEFAULT_VENDOR_IMPORT_RULES } from '../types/vendor/vendorImportRules.types';

export function strategiesForTierMode(mode: TierSourceMode): string[] {
  switch (mode) {
    case 'tierUa':
      return ['tierUa', 'planCode'];
    case 'composite':
      return ['composite'];
    case 'planCode':
      return ['planCode', 'tierUa'];
    case 'composite_then_tier':
    default:
      return ['planCode', 'composite', 'tierUa'];
  }
}

export function inferTierModeFromStrategies(strategies: string[]): TierSourceMode {
  const s = strategies || [];
  if (s.includes('composite') && s.includes('tierUa')) return 'composite_then_tier';
  if (s[0] === 'composite' && s.length === 1) return 'composite';
  if (s[0] === 'tierUa' && !s.includes('composite')) return 'tierUa';
  if (s[0] === 'planCode' && !s.includes('composite')) return 'planCode';
  return 'composite_then_tier';
}

export function buildTierSourceFromPlanKey(planKey: VendorImportRules['planKey']): PlanKeyTierSource {
  const strategies = planKey.strategies?.length
    ? planKey.strategies
    : DEFAULT_VENDOR_IMPORT_RULES.planKey.tierSource.strategies;
  return {
    mode: planKey.tierSource?.mode ?? inferTierModeFromStrategies(strategies),
    strategies,
    compositeFields: planKey.tierSource?.compositeFields?.length
      ? planKey.tierSource.compositeFields
      : planKey.compositeFields || [],
    compositeSeparator: planKey.tierSource?.compositeSeparator
      ?? planKey.compositeSeparator
      ?? '_',
    tierFields: planKey.tierSource?.tierFields ?? planKey.tierFields,
    tierPattern: planKey.tierSource?.tierPattern ?? planKey.tierPattern,
    uaFields: planKey.tierSource?.uaFields ?? planKey.uaFields,
    planCodeFields: planKey.tierSource?.planCodeFields ?? planKey.planCodeFields,
    tierUaSuffixRegex: planKey.tierSource?.tierUaSuffixRegex ?? planKey.tierUaSuffixRegex,
    uaRelabel: planKey.tierSource?.uaRelabel ?? planKey.uaRelabel ?? [],
  };
}

export function applyTierSourceToPlanKey(
  planKey: VendorImportRules['planKey'],
  tierSource: PlanKeyTierSource,
): VendorImportRules['planKey'] {
  const strategies = tierSource.strategies?.length
    ? tierSource.strategies
    : strategiesForTierMode(tierSource.mode);
  return {
    ...planKey,
    tierSource: { ...tierSource, strategies },
    strategies,
    compositeFields: tierSource.compositeFields,
    compositeSeparator: tierSource.compositeSeparator,
    tierFields: tierSource.tierFields,
    tierPattern: tierSource.tierPattern,
    uaFields: tierSource.uaFields,
    planCodeFields: tierSource.planCodeFields,
    tierUaSuffixRegex: tierSource.tierUaSuffixRegex,
    uaRelabel: tierSource.uaRelabel,
  };
}

export function patchProductSourceMode(
  rules: VendorImportRules,
  mode: ProductSourceMode,
): VendorImportRules {
  return {
    ...rules,
    planKey: {
      ...rules.planKey,
      productSource: {
        ...rules.planKey.productSource,
        mode,
        fields: rules.planKey.productSource?.fields
          || DEFAULT_VENDOR_IMPORT_RULES.planKey.productSource.fields,
      },
    },
  };
}

export function patchTierSourceMode(
  rules: VendorImportRules,
  mode: TierSourceMode,
): VendorImportRules {
  const tierSource = buildTierSourceFromPlanKey(rules.planKey);
  tierSource.mode = mode;
  tierSource.strategies = strategiesForTierMode(mode);
  return {
    ...rules,
    planKey: applyTierSourceToPlanKey(rules.planKey, tierSource),
  };
}
