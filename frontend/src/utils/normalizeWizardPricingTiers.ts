/**
 * Normalize product pricing from API/list payloads into AddProductWizard tier shape:
 * { tierType, label, ageBands: [...] }
 */
export function normalizeWizardPricingTiers(raw: unknown): Array<{
  id?: string;
  tierType: string;
  label: string;
  ageBands: Record<string, unknown>[];
}> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }

  const first = raw[0] as Record<string, unknown>;
  const hasGroupedBands =
    Array.isArray(first?.ageBands) || Array.isArray(first?.AgeBands);

  if (hasGroupedBands) {
    return raw.map((tierRaw) => {
      const tier = tierRaw as Record<string, unknown>;
      return {
        id: (tier.id as string) || undefined,
        tierType: String(tier.tierType || tier.TierType || '').trim(),
        label: String(tier.label ?? tier.Label ?? '').trim(),
        ageBands: (tier.ageBands || tier.AgeBands || []) as Record<string, unknown>[],
      };
    });
  }

  // Flat rows (e.g. tenant product list): one record per age band
  const tierMap = new Map<
    string,
    { id: string; tierType: string; label: string; ageBands: Record<string, unknown>[] }
  >();

  for (const rowRaw of raw) {
    const row = rowRaw as Record<string, unknown>;
    const tierType = String(row.tierType || row.TierType || 'EE').trim();
    const label = String(row.label ?? row.Label ?? '').trim();
    const key = `${tierType}_${label || 'default'}`;

    if (!tierMap.has(key)) {
      tierMap.set(key, {
        id: String(row.id || row.ProductPricingId || `${Date.now()}-${Math.random()}`),
        tierType,
        label,
        ageBands: [],
      });
    }

    tierMap.get(key)!.ageBands.push(row);
  }

  return [...tierMap.values()];
}
