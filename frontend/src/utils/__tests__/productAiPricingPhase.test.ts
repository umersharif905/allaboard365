import { describe, expect, it } from 'vitest';
import { buildProductAiPricingPhaseContext, pickSourceBandsForTier } from '../productAiPricingPhase';
import type { PricingTier } from '../../types/sysadmin/addproductswizard.types';

const band = (
  id: string,
  opts: { effectiveDate?: string; terminationDate?: string; minAge?: number; maxAge?: number } = {}
) => ({
  id,
  tobaccoStatus: 'N/A',
  minAge: opts.minAge ?? 18,
  maxAge: opts.maxAge ?? 65,
  netRate: 100,
  overrideRate: 0,
  commission: 0,
  systemFees: 0,
  msrpRate: 100,
  affiliateRate: 0,
  effectiveDate: opts.effectiveDate ?? null,
  terminationDate: opts.terminationDate ?? null,
});

describe('productAiPricingPhase', () => {
  it('prefers open-ended bands over terminated cohort', () => {
    const tier: PricingTier = {
      id: 'old-tier',
      tierType: 'EE',
      ageBands: [
        band('b1', { effectiveDate: '2024-01-01', terminationDate: '2026-05-28' }),
        band('b2', { effectiveDate: '2026-05-29', terminationDate: null }),
      ],
    };
    const source = pickSourceBandsForTier(tier);
    expect(source.map((b) => b.id)).toEqual(['b2']);
  });

  it('lists phased-out bands separately from active targets', () => {
    const ctx = buildProductAiPricingPhaseContext([
      {
        id: 'tier-a',
        tierType: 'EE',
        label: 'EE',
        ageBands: [
          band('old', { effectiveDate: '2024-01-01', terminationDate: '2026-05-28' }),
          band('new', { effectiveDate: '2026-05-29' }),
        ],
      },
    ]);
    expect(ctx.phasedOutBands).toHaveLength(1);
    expect(ctx.phasedOutBands[0].bandId).toBe('old');
    expect(ctx.activePricingTargets[0].openBandIds).toEqual(['new']);
    expect(ctx.snapshotSource).toBe('live_wizard_form');
  });

  it('recommends newer effective-date tier when duplicate tierType rows exist', () => {
    const ctx = buildProductAiPricingPhaseContext([
      {
        id: 'tier-old-row',
        tierType: 'EE',
        ageBands: [band('x', { effectiveDate: '2024-01-01' })],
      },
      {
        id: 'tier-new-row',
        tierType: 'EE',
        ageBands: [band('y', { effectiveDate: '2026-05-29' })],
      },
    ]);
    expect(ctx.duplicateTierTypes).toHaveLength(1);
    expect(ctx.duplicateTierTypes[0].recommendedActiveTierId).toBe('tier-new-row');
  });
});
