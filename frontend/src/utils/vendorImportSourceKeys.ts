import type { VendorImportRules } from '../types/vendor/vendorImportRules.types';
import { normalizeVendorImportRules } from './vendorImportRulesNormalize';

function includeRegexFromRules(rules?: VendorImportRules | null): RegExp | null {
  const normalized = rules ? normalizeVendorImportRules(rules) : null;
  const pattern = normalized?.planKey?.sourceKeyIncludeRegex?.trim();
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** When preset defines sourceKeyIncludeRegex, only matching keys are in scope for this format. */
export function sourceKeyIncludedByRules(
  key: string,
  rules?: VendorImportRules | null,
): boolean {
  const re = includeRegexFromRules(rules);
  if (!re) return true;
  return re.test(String(key || '').trim());
}

export function filterSourceKeysForImportRules(
  keys: string[],
  rules?: VendorImportRules | null,
): string[] {
  const re = includeRegexFromRules(rules);
  if (!re) return keys;
  return keys.filter((k) => re.test(String(k || '').trim()));
}

/** Saved map keys that do not match the format include regex (legacy catalog rows). */
export function staleSourceKeysForImportRules(
  savedKeys: string[],
  rules?: VendorImportRules | null,
): string[] {
  const re = includeRegexFromRules(rules);
  if (!re) return [];
  return savedKeys.filter((k) => !re.test(String(k || '').trim()));
}

export function formatUsesSourceKeyFilter(rules?: VendorImportRules | null): boolean {
  return !!includeRegexFromRules(rules);
}
