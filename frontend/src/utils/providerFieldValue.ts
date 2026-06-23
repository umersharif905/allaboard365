// frontend/src/utils/providerFieldValue.ts
// Type guard + human-readable formatter for a stored provider_search field value.

import type { ProviderFieldValue } from '../types/providerSearch';

export function isProviderValue(v: unknown): v is ProviderFieldValue {
  if (!v || typeof v !== 'object') return false;
  const o = v as { name?: unknown; source?: unknown };
  return (
    typeof o.name === 'string' &&
    (o.source === 'registry' || o.source === 'manual')
  );
}

export function formatProviderValue(v: ProviderFieldValue): string {
  const segments: string[] = [v.name];
  if (v.source === 'registry' && v.npi) segments.push(`NPI ${v.npi}`);
  const addr = [v.address1, [v.city, v.state].filter(Boolean).join(', '), v.zip]
    .filter(Boolean)
    .join(' ');
  if (addr) segments.push(addr);
  segments.push(v.source === 'registry' ? '(registry-verified)' : '(manually entered)');
  return segments.filter(Boolean).join(' — ');
}
