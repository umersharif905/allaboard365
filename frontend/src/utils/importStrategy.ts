import type { ImportProduct, KeyStrategy, ProductMatch, VendorImportRules } from '../types/vendor/vendorImportRules.types';
import { normalizeVendorImportRules } from './vendorImportRulesNormalize';

export type CsvRow = Record<string, string | undefined>;

function firstCell(row: CsvRow, fieldsCsv: string): string {
  const names = String(fieldsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    const v = row[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function isTruthyCell(raw: string): boolean {
  const s = String(raw || '').trim();
  if (!s) return false;
  const upper = s.toUpperCase();
  if (['YES', 'Y', 'TRUE', '1', '100'].includes(upper)) return true;
  const num = Number(s.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(num) && num > 0;
}

export function evalProductMatch(row: CsvRow, match: ProductMatch): boolean {
  const mode = match.mode || 'always';
  if (mode === 'always') return true;
  const field = match.field?.trim();
  if (!field) return false;
  const raw = firstCell(row, field);
  if (mode === 'fieldNonBlank') return !!raw;
  if (mode === 'fieldTruthy') return isTruthyCell(raw);
  if (mode === 'fieldEquals') {
    const val = raw.toUpperCase();
    const allowed = (match.values || []).map((v) => v.trim().toUpperCase()).filter(Boolean);
    if (!allowed.length) return !!val;
    return allowed.includes(val);
  }
  return false;
}

function normalizeUa(ua: string): string {
  return String(ua || '').trim().replace(/[$,]/g, '').replace(/\.0+$/, '');
}

function tierFromHousehold(ctx?: { hasPrimary?: boolean; hasSpouse?: boolean; hasChild?: boolean }): string {
  const hasPrimary = !!ctx?.hasPrimary;
  const hasSpouse = !!ctx?.hasSpouse;
  const hasChild = !!ctx?.hasChild;
  if (hasPrimary && !hasSpouse && !hasChild) return 'EE';
  if (hasPrimary && hasSpouse && !hasChild) return 'ES';
  if (hasPrimary && !hasSpouse && hasChild) return 'EC';
  if (hasPrimary && hasSpouse && hasChild) return 'EF';
  return 'EE';
}

/** Preview catalog key for one product on a sample row (client-side mirror of backend). */
export function previewKeyForProduct(
  row: CsvRow,
  product: ImportProduct,
  rules?: VendorImportRules | null,
  ctx?: { hasPrimary?: boolean; hasSpouse?: boolean; hasChild?: boolean },
): string {
  if (!evalProductMatch(row, product.match)) return '';
  const ks = product.keyStrategy;
  const r = normalizeVendorImportRules(rules ?? undefined);

  if (ks.type === 'householdTier') {
    const tier = tierFromHousehold(ctx);
    const ua = normalizeUa(firstCell(row, ks.uaFields || r.planKey.uaFields));
    return tier && ua ? `${tier}_${ua}` : tier;
  }
  if (ks.type === 'codedMap') {
    const code = firstCell(row, ks.tierFields || '').toUpperCase();
    const mapped = (ks.valueMap && ks.valueMap[code]) || code;
    const ua = normalizeUa(firstCell(row, ks.uaFields || r.planKey.uaFields));
    return mapped && ua ? `${mapped}_${ua}` : mapped;
  }
  if (ks.type === 'composite' && ks.compositeFields?.length) {
    const parts = ks.compositeFields.map((seg) => firstCell(row, seg));
    if (parts.some((p) => !p)) return '';
    return parts.join(ks.compositeSeparator || '_');
  }
  const tier = firstCell(row, ks.tierFields || r.planKey.tierFields).toUpperCase();
  const ua = normalizeUa(firstCell(row, ks.uaFields || r.planKey.uaFields));
  if (tier && ua && /^(EE|ES|EC|EF)$/i.test(tier)) return `${tier}_${ua}`;
  const plan = firstCell(row, ks.planCodeFields || r.planKey.planCodeFields);
  return plan || '';
}

export function previewKeysForRow(
  row: CsvRow,
  rules?: VendorImportRules | null,
  ctx?: { hasPrimary?: boolean; hasSpouse?: boolean; hasChild?: boolean },
): Array<{ productId: string; label: string; key: string }> {
  const r = normalizeVendorImportRules(rules ?? undefined);
  if (!r.products?.length) return [];
  const out: Array<{ productId: string; label: string; key: string }> = [];
  for (const p of r.products) {
    const key = previewKeyForProduct(row, p, r, ctx);
    if (key) out.push({ productId: p.id, label: p.label, key });
  }
  return out;
}

export const KEY_STRATEGY_LABELS: Record<KeyStrategy['type'], string> = {
  planCode: 'Plan name / code column',
  composite: 'Composite code (Product_ID + Benefit_ID)',
  codedMap: 'Coded value → tier map + UA',
  householdTier: 'Household size (EE/ES/EC/EF) + UA',
};

export const MATCH_MODE_LABELS: Record<ProductMatch['mode'], string> = {
  always: 'Every row',
  fieldEquals: 'When column equals…',
  fieldTruthy: 'When column is checked / yes',
  fieldNonBlank: 'When column has a value',
};
