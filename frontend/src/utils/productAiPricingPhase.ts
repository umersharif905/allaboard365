import type { PricingTier } from '../types/sysadmin/addproductswizard.types';

export type ProductAiActivePricingTarget = {
  tierId: string;
  tierType: string;
  label: string;
  /** Open-ended bands (no terminationDate) — default patch targets */
  openBandIds: string[];
  effectiveDates: string[];
  bandCount: number;
};

export type ProductAiPhasedOutBand = {
  tierId: string;
  tierType: string;
  label: string;
  bandId: string;
  effectiveDate: string | null;
  terminationDate: string | null;
  minAge: number;
  maxAge: number;
  tobaccoStatus: string;
};

export type ProductAiDuplicateTierType = {
  tierType: string;
  tierIds: string[];
  /** Tier row the assistant should prefer for patches unless user names another */
  recommendedActiveTierId: string;
};

export type ProductAiPricingPhaseContext = {
  /** Snapshot is built from live wizard form state on each send — includes unsaved edits */
  snapshotSource: 'live_wizard_form';
  activePricingTargets: ProductAiActivePricingTarget[];
  phasedOutBands: ProductAiPhasedOutBand[];
  duplicateTierTypes: ProductAiDuplicateTierType[];
  guidance: string;
};

function trimDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  return t || null;
}

function latestEffectiveDate(bands: PricingTier['ageBands']): string | null {
  const dates = bands
    .map((b) => trimDate(b.effectiveDate))
    .filter((d): d is string => Boolean(d))
    .sort((a, b) => b.localeCompare(a));
  return dates[0] || null;
}

/** Mirrors Pricing step logic: open bands first; else latest effective-date cohort. */
export function pickSourceBandsForTier(tier: PricingTier): PricingTier['ageBands'] {
  const openEnded = tier.ageBands.filter((band) => !trimDate(band.terminationDate));
  if (openEnded.length > 0) return openEnded;

  const latest = latestEffectiveDate(tier.ageBands);
  if (!latest) return [];

  return tier.ageBands.filter((band) => trimDate(band.effectiveDate) === latest);
}

export function buildProductAiPricingPhaseContext(
  pricingTiers: PricingTier[] | undefined
): ProductAiPricingPhaseContext {
  const tiers = pricingTiers || [];
  const activePricingTargets: ProductAiActivePricingTarget[] = [];
  const phasedOutBands: ProductAiPhasedOutBand[] = [];

  for (const tier of tiers) {
    for (const band of tier.ageBands) {
      if (trimDate(band.terminationDate)) {
        phasedOutBands.push({
          tierId: tier.id,
          tierType: tier.tierType,
          label: tier.label || '',
          bandId: band.id,
          effectiveDate: trimDate(band.effectiveDate),
          terminationDate: trimDate(band.terminationDate),
          minAge: band.minAge,
          maxAge: band.maxAge,
          tobaccoStatus: band.tobaccoStatus || 'N/A',
        });
      }
    }

    const sourceBands = pickSourceBandsForTier(tier);
    if (sourceBands.length === 0) continue;

    const effectiveDates = [
      ...new Set(
        sourceBands.map((b) => trimDate(b.effectiveDate)).filter((d): d is string => Boolean(d))
      ),
    ];

    activePricingTargets.push({
      tierId: tier.id,
      tierType: tier.tierType,
      label: tier.label || '',
      openBandIds: sourceBands.map((b) => b.id),
      effectiveDates,
      bandCount: sourceBands.length,
    });
  }

  const byType = new Map<string, ProductAiActivePricingTarget[]>();
  for (const target of activePricingTargets) {
    const key = (target.tierType || '').trim() || 'unknown';
    const list = byType.get(key) || [];
    list.push(target);
    byType.set(key, list);
  }

  const duplicateTierTypes: ProductAiDuplicateTierType[] = [];
  for (const [tierType, targets] of byType.entries()) {
    if (targets.length <= 1) continue;
    const sorted = [...targets].sort((a, b) => {
      const aMax = a.effectiveDates.sort().slice(-1)[0] || '';
      const bMax = b.effectiveDates.sort().slice(-1)[0] || '';
      if (aMax !== bMax) return bMax.localeCompare(aMax);
      return b.tierId.localeCompare(a.tierId);
    });
    duplicateTierTypes.push({
      tierType,
      tierIds: targets.map((t) => t.tierId),
      recommendedActiveTierId: sorted[0].tierId,
    });
  }

  const guidance =
    'Default patch targets: activePricingTargets (bands without terminationDate, or latest phase if none open). ' +
    'phasedOutBands are context only — do not change unless the user asks. ' +
    'When duplicate tier rows share a tierType (phase-in), use recommendedActiveTierId. ' +
    'Snapshot reflects the current wizard form including unsaved end dates — not last-saved DB only.';

  return {
    snapshotSource: 'live_wizard_form',
    activePricingTargets,
    phasedOutBands,
    duplicateTierTypes,
    guidance,
  };
}
