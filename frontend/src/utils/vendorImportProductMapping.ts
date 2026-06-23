export interface PricingTierOption {
  productPricingId: string;
  productId: string;
  productName: string;
  tierType: string | null;
  importKey: string | null;
  tobaccoStatus?: string | null;
  minAge?: number | null;
  maxAge?: number | null;
  displayLabel: string;
  netRate: number;
  msrpRate: number;
}

import {
  relabelUaForRules,
  normalizeVendorImportRules,
} from './vendorImportRulesNormalize';
import type { VendorImportRules } from '../types/vendor/vendorImportRules.types';

export interface PlanCodeGroup {
  lookupKey: string;
  filePlanCodes: string[];
  /** Vendor product id from file when productSource.mode = fields (e.g. 11321, 46521). */
  productIdKey?: string | null;
  /** Configured import product id (multi-product rules). */
  importProductId?: string | null;
  importProductLabel?: string | null;
  targetProductId?: string | null;
}

export function allKeysForPlanGroup(group: PlanCodeGroup): string[] {
  const keys = new Set<string>([group.lookupKey, ...group.filePlanCodes]);
  return [...keys];
}

/** Prefer vendor composite codes (11321_AH*, 46521_9376) for the left-column label. */
export function primaryPlanCodeLabel(group: PlanCodeGroup): string {
  const composite = group.filePlanCodes.filter(
    (k) => /^11321_AH/i.test(k) || /^\d{4,6}_/i.test(k),
  );
  if (composite.length) return composite.join(', ');
  if (group.filePlanCodes.length) return group.filePlanCodes.join(', ');
  return group.lookupKey;
}

export function shouldShowCatalogKeyHint(group: PlanCodeGroup): boolean {
  if (!group.lookupKey) return false;
  const label = primaryPlanCodeLabel(group);
  return label !== group.lookupKey && !group.filePlanCodes.every((c) => c === group.lookupKey);
}

/**
 * Group raw map keys so Align file codes (11321_AH*) display with normalized catalog lookup keys.
 */
export function buildPlanGroupsFromImportKeys(
  keys: string[],
  importRules?: VendorImportRules | null,
): PlanCodeGroup[] {
  const groups = new Map<string, { lookupKey: string; filePlanCodes: Set<string> }>();

  for (const raw of keys) {
    const key = raw.trim();
    if (!key) continue;
    const derived = deriveTierUaFromPlanCode(key, importRules);
    const lookupKey = derived || key;
    if (!groups.has(lookupKey)) {
      groups.set(lookupKey, { lookupKey, filePlanCodes: new Set() });
    }
    groups.get(lookupKey)!.filePlanCodes.add(key);
  }

  return [...groups.values()]
    .map((g) => ({
      lookupKey: g.lookupKey,
      filePlanCodes: [...g.filePlanCodes].filter((c) => c !== g.lookupKey).sort(),
    }))
    .sort((a, b) => primaryPlanCodeLabel(a).localeCompare(primaryPlanCodeLabel(b)));
}

export function resolvedPricingIdForGroup(
  group: PlanCodeGroup,
  mappings: Record<string, string>,
): string {
  for (const key of allKeysForPlanGroup(group)) {
    if (mappings[key]) return mappings[key];
  }
  return '';
}

export function formatTierDropdownLabel(tier: PricingTierOption, rateLabel: string): string {
  const extras: string[] = [];
  if (tier.tobaccoStatus) extras.push(`Tobacco: ${tier.tobaccoStatus}`);
  if (tier.minAge != null || tier.maxAge != null) {
    extras.push(`Ages ${tier.minAge ?? '?'}-${tier.maxAge ?? '?'}`);
  }
  const suffix = extras.length ? ` · ${extras.join(' · ')}` : '';
  return `${tier.displayLabel}${suffix} (${rateLabel})`;
}

/** Composite plan codes → catalog tier_UA key; uaRelabel comes from format importRules. */
export function deriveTierUaFromPlanCode(
  planCode: string,
  importRules?: VendorImportRules | null,
): string | null {
  const raw = planCode.trim().toUpperCase();
  if (!raw) return null;
  const rules = importRules ? normalizeVendorImportRules(importRules) : null;

  const canonical = raw.match(/^([A-Z]+)_([0-9.]+)$/);
  if (canonical) {
    const ua = relabelUaForRules(canonical[2].replace(/\.0+$/, ''), rules);
    return `${canonical[1]}_${ua}`;
  }

  if (rules?.planKey?.tierUaSuffixRegex) {
    try {
      const re = new RegExp(rules.planKey.tierUaSuffixRegex, 'i');
      const suffix = raw.match(re);
      if (suffix) {
        let ua = suffix[1].replace(/\.0+$/, '');
        const tier = suffix[2].toUpperCase();
        ua = relabelUaForRules(ua, rules);
        return `${tier}_${ua}`;
      }
    } catch {
      /* invalid regex */
    }
  }

  const suffix = raw.match(/(\d{3,6})(EE|ES|EC|EF)$/);
  if (suffix) {
    let ua = relabelUaForRules(suffix[1].replace(/\.0+$/, ''), rules);
    return `${suffix[2]}_${ua}`;
  }

  return null;
}

export function importKeyMatchCandidates(
  sourceKey: string,
  importRules?: VendorImportRules | null,
): string[] {
  const raw = sourceKey.trim();
  if (!raw) return [];
  const out: string[] = [];
  const add = (k: string) => {
    if (k && !out.includes(k)) out.push(k);
  };
  add(raw);
  const upper = raw.toUpperCase();
  add(upper);
  const derived = deriveTierUaFromPlanCode(raw, importRules);
  if (derived) add(derived);
  const uaMatch = upper.match(/^([A-Z]+)_([0-9.]+)$/);
  if (uaMatch) {
    const tier = uaMatch[1];
    const ua = uaMatch[2].replace(/\.0+$/, '');
    add(`${tier}_${ua}`);
    const relabeled = relabelUaForRules(ua, importRules);
    if (relabeled !== ua) add(`${tier}_${relabeled}`);
  }
  return out;
}

function tobaccoRankForAutoMap(tobaccoStatus: string | null | undefined): number {
  const s = String(tobaccoStatus || '').trim().toLowerCase();
  if (s === 'no' || s === 'n/a' || s === '') return 0;
  if (s !== 'yes') return 1;
  return 2;
}

/** Auto-map defaults to non-tobacco tier; tobacco Yes is chosen per row at import. */
export function pickDefaultAutoMapTier(matches: PricingTierOption[]): PricingTierOption | null {
  if (!matches.length) return null;
  const sorted = [...matches].sort(
    (a, b) => tobaccoRankForAutoMap(a.tobaccoStatus) - tobaccoRankForAutoMap(b.tobaccoStatus),
  );
  return sorted[0];
}

/** Use persisted VendorImportProductMap rows (file codes + catalog keys). */
export function matchTierFromSavedMap(
  group: PlanCodeGroup,
  tiers: PricingTierOption[],
  savedMappings: Record<string, string>,
  productId?: string,
): PricingTierOption | null {
  for (const key of allKeysForPlanGroup(group)) {
    const pricingId = savedMappings[key];
    if (!pricingId) continue;
    const tier = tiers.find(
      (t) => t.productPricingId === pricingId
        && (!productId || t.productId === productId),
    );
    if (tier) return tier;
  }
  return null;
}

/** Match one plan group to a catalog tier (same logic as the Auto-map button). */
export function matchPlanGroupToTier(
  group: PlanCodeGroup,
  tiers: PricingTierOption[],
  productId?: string,
  importRules?: VendorImportRules | null,
  savedMappings?: Record<string, string>,
): PricingTierOption | null {
  const fromCatalog = autoMatchTier(group.lookupKey, tiers, productId, importRules)
    || group.filePlanCodes
      .map((code) => autoMatchTier(code, tiers, productId, importRules))
      .find(Boolean)
    || null;
  if (fromCatalog) return fromCatalog;
  if (savedMappings && Object.keys(savedMappings).length) {
    return matchTierFromSavedMap(group, tiers, savedMappings, productId);
  }
  return null;
}

/** Apply auto-map to every group; syncs all alias keys in the group to the same pricing id. */
export function applyAutoMapForPlanGroups(
  groups: PlanCodeGroup[],
  tiers: PricingTierOption[],
  productId: string | undefined,
  importRules: VendorImportRules | null | undefined,
  baseMappings: Record<string, string> = {},
): Record<string, string> {
  const next = { ...baseMappings };
  for (const group of groups) {
    const match = matchPlanGroupToTier(group, tiers, productId, importRules, baseMappings);
    if (!match) continue;
    for (const k of allKeysForPlanGroup(group)) {
      next[k] = match.productPricingId;
    }
  }
  return syncPlanGroupMappingKeys(groups, next);
}

/** Ensure lookupKey + every file alias shares the same pricing id (dropdown reads lookupKey). */
export function syncPlanGroupMappingKeys(
  groups: PlanCodeGroup[],
  mappings: Record<string, string>,
): Record<string, string> {
  const next = { ...mappings };
  for (const group of groups) {
    const pricingId = resolvedPricingIdForGroup(group, next);
    if (!pricingId) continue;
    for (const k of allKeysForPlanGroup(group)) {
      next[k] = pricingId;
    }
  }
  return next;
}

export function autoMatchTier(
  sourceKey: string,
  tiers: PricingTierOption[],
  productId?: string,
  importRules?: VendorImportRules | null,
): PricingTierOption | null {
  const pool = productId ? tiers.filter((t) => t.productId === productId) : tiers;

  for (const candidate of importKeyMatchCandidates(sourceKey, importRules)) {
    const normalized = candidate.trim().toUpperCase();
    const matches = pool.filter((t) => {
      if (!t.importKey) return false;
      const tierKey = t.importKey.trim().toUpperCase();
      return tierKey === normalized;
    });
    const picked = pickDefaultAutoMapTier(matches);
    if (picked) return picked;
  }

  return null;
}

export function filterTiersForProduct(
  tiers: PricingTierOption[],
  productId: string,
): PricingTierOption[] {
  if (!productId) return tiers;
  return tiers.filter((t) => t.productId === productId);
}

export function inferDefaultAutoMapProductIdFromRules(
  distinctProducts: string[],
  tierRows: PricingTierOption[],
  importRules?: VendorImportRules | null,
): string {
  const rules = importRules ? normalizeVendorImportRules(importRules) : null;
  const fromProduct = rules?.products?.find((p) => p.targetProductId)?.targetProductId;
  if (fromProduct) return fromProduct;
  const assumed = rules?.productMapping?.assumedProductId;
  if (assumed) return assumed;
  const nameHint = rules?.productMapping?.defaultProductNameContains;
  if (nameHint) {
    const match = tierRows.find((t) => t.productName.toLowerCase().includes(nameHint.toLowerCase()));
    if (match) return match.productId;
  }
  const prefixes = rules?.productMapping?.planCodePrefixes || [];
  if (prefixes.length) {
    const hasPrefix = distinctProducts.some((k) =>
      prefixes.some((p) => k.toUpperCase().startsWith(p.toUpperCase())),
    );
    if (hasPrefix && nameHint) {
      const match = tierRows.find((t) => t.productName.toLowerCase().includes(nameHint.toLowerCase()));
      if (match) return match.productId;
    }
  }
  return '';
}

export function inferDefaultAutoMapProductId(
  distinctProducts: string[],
  tierRows: PricingTierOption[],
  merged: Record<string, string>,
  importRules?: VendorImportRules | null,
): string {
  const fromRules = inferDefaultAutoMapProductIdFromRules(distinctProducts, tierRows, importRules);
  if (fromRules) return fromRules;
  const counts = new Map<string, number>();
  for (const key of distinctProducts) {
    const pricingId = merged[key];
    if (!pricingId) continue;
    const tier = tierRows.find((t) => t.productPricingId === pricingId);
    if (tier) counts.set(tier.productId, (counts.get(tier.productId) || 0) + 1);
  }

  let best = '';
  let max = 0;
  for (const [productId, count] of counts) {
    if (count > max) {
      max = count;
      best = productId;
    }
  }
  if (best) return best;

  const uniqueProducts = new Set(tierRows.map((t) => t.productId));
  if (uniqueProducts.size === 1) return tierRows[0]?.productId || '';
  return '';
}
