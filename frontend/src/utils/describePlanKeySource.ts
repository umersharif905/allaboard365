import type { VendorImportRules } from '../types/vendor/vendorImportRules.types';
import { normalizeVendorImportRules } from './vendorImportRulesNormalize';
import { buildTierSourceFromPlanKey } from './planKeySourceConfig';

export function describePlanKeySourceFromRules(rules?: VendorImportRules | null): string {
  const r = normalizeVendorImportRules(rules ?? undefined);
  const ps = r.planKey.productSource;
  const ts = buildTierSourceFromPlanKey(r.planKey);
  const parts: string[] = [];

  if (ps?.mode === 'fields' && ps.fields) {
    parts.push(`product column(s): ${ps.fields}`);
  } else if (r.productMapping.assumedProductId) {
    parts.push('single assumed product (configured below)');
  } else if (r.productMapping.defaultProductNameContains) {
    parts.push(`default product name contains “${r.productMapping.defaultProductNameContains}”`);
  } else {
    parts.push('product not read from file (map tiers only)');
  }

  if (ts.mode === 'tierUa') {
    parts.push(`pricing tier: ${ts.tierFields} + ${ts.uaFields}`);
  } else if (ts.mode === 'composite') {
    const segs = ts.compositeFields.map((s) => s.replace(/,/g, ' + ')).join('; ');
    parts.push(`pricing tier: composite ${segs}`);
  } else if (ts.mode === 'planCode') {
    parts.push(`pricing tier: ${ts.planCodeFields}`);
  } else {
    parts.push(`pricing tier: ${ts.strategies.join(' → ')} (composite / tier+UA / plan label)`);
  }

  return parts.join(' · ');
}

export function planKeyFileColumnHint(rules?: VendorImportRules | null): string {
  const r = normalizeVendorImportRules(rules ?? undefined);
  const ts = buildTierSourceFromPlanKey(r.planKey);
  if (ts.mode === 'composite' || ts.mode === 'composite_then_tier') {
    if (ts.compositeFields.length) {
      return ts.compositeFields.map((s) => s.replace(/,/g, ' + ')).join('; ');
    }
  }
  if (ts.mode === 'tierUa' || ts.mode === 'composite_then_tier') {
    return `${ts.tierFields} + ${ts.uaFields}`;
  }
  if (ts.planCodeFields) {
    const first = ts.planCodeFields.split(',')[0]?.trim();
    return first || 'Plan Name';
  }
  return 'plan code columns';
}

export function productIdColumnHint(rules?: VendorImportRules | null): string | null {
  const r = normalizeVendorImportRules(rules ?? undefined);
  if (r.planKey.productSource?.mode !== 'fields') return null;
  return r.planKey.productSource.fields || null;
}
