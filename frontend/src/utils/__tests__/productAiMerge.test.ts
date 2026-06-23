import { describe, expect, it } from 'vitest';
import type { ProductFormData } from '../../types/sysadmin/addproductswizard.types';
import {
  getChangedFields,
  isPricingPatchApplyable,
  isProductPatchApplyable,
  normalizeProductAiPatch,
  applyAiAgeBands,
  expandCombinedSpreadsheetTiers,
  splitStackedEsEcAgeBands,
  stripStraySingletonAgeBands,
  applyProductAiPatch,
} from '../productAiMerge';

const baseForm = {
  pricingTiers: [
    {
      id: 'tier-ec',
      tierType: 'EC',
      label: 'Employee + Child',
      ageBands: [{ id: '1', minAge: 18, maxAge: 65, tobaccoStatus: 'N/A', netRate: 50, msrpRate: 80 } as never],
    },
  ],
} as unknown as ProductFormData;

describe('productAiMerge pricing patches', () => {
  it('strips pricingTierIds from patch', () => {
    const normalized = normalizeProductAiPatch({
      pricingTierIds: [{ id: 'tier-ec', tierType: 'EC' }],
    } as never);
    expect(normalized.pricingTierIds).toBeUndefined();
  });

  it('getChangedFields ignores pricingTierIds', () => {
    const changes = getChangedFields(baseForm, {
      pricingTierIds: [{ id: 'tier-ec', tierType: 'EC', index: 1 }],
    } as never);
    expect(changes.some((c) => c.field === 'pricingTierIds')).toBe(false);
  });

  it('isPricingPatchApplyable rejects empty age band amounts', () => {
    expect(
      isPricingPatchApplyable({
        pricingTiers: [{ id: 'tier-ec', tierType: 'EC', ageBands: [{ minAge: 18, maxAge: 39 }] }],
      } as never)
    ).toBe(false);
  });

  it('isPricingPatchApplyable accepts tiers with net/msrp', () => {
    expect(
      isPricingPatchApplyable({
        pricingTiers: [
          {
            id: 'tier-ec',
            tierType: 'EC',
            ageBands: [{ minAge: 18, maxAge: 39, netRate: 106, overrideRate: 3.25, commission: 50, msrpRate: 159.25 }],
          },
        ],
      } as never)
    ).toBe(true);
  });

  it('isPricingPatchApplyable accepts net-only tiers (override/commission 0)', () => {
    // Net-only pricing is a valid configuration the user can explicitly request — must be applyable.
    expect(
      isPricingPatchApplyable({
        pricingTiers: [
          {
            id: 'tier-ec',
            tierType: 'EC',
            ageBands: [{ minAge: 18, maxAge: 39, netRate: 75, msrpRate: 75 }],
          },
        ],
      } as never)
    ).toBe(true);
  });

  it('normalizes string dollar amounts on age bands', () => {
    const normalized = normalizeProductAiPatch({
      pricingTiers: [
        {
          tierType: 'EE',
          ageBands: [
            { minAge: 18, maxAge: 39, netRate: '$75', overrideRate: '3.25', commission: '50', msrpRate: '141' },
          ],
        },
      ],
    } as never);
    expect(normalized.pricingTiers?.[0].ageBands[0].netRate).toBe(75);
    expect(normalized.pricingTiers?.[0].ageBands[0].overrideRate).toBe(3.25);
    expect(normalized.pricingTiers?.[0].ageBands[0].commission).toBe(50);
    expect(normalized.pricingTiers?.[0].ageBands[0].msrpRate).toBe(128.25);
  });

  it('isProductPatchApplyable accepts processing fee only patch', () => {
    expect(
      isProductPatchApplyable(baseForm, {
        includeProcessingFee: true,
        roundUpProcessingFee: true,
        processingFeePercentage: 3,
      } as never)
    ).toBe(true);
  });

  it('applyAiAgeBands replaces omitted bands (removes stray 48-48)', () => {
    const existing = [
      { id: 'b1', minAge: 48, maxAge: 48, tobaccoStatus: 'N/A', netRate: 272, msrpRate: 289 } as never,
      { id: 'b2', minAge: 18, maxAge: 39, tobaccoStatus: 'N/A', netRate: 169, msrpRate: 250 } as never,
      { id: 'b3', minAge: 40, maxAge: 65, tobaccoStatus: 'N/A', netRate: 209, msrpRate: 289 } as never,
    ];
    const result = applyAiAgeBands(existing, [
      { minAge: 18, maxAge: 39, netRate: 169, msrpRate: 250 },
      { minAge: 40, maxAge: 65, netRate: 209, msrpRate: 289 },
    ]);
    expect(result).toHaveLength(2);
    expect(result.some((b) => b.minAge === 48 && b.maxAge === 48)).toBe(false);
  });

  it('expandCombinedSpreadsheetTiers splits ES/EC row into ES and EC', () => {
    const bands = [
      { minAge: 18, maxAge: 39, netRate: 169, msrpRate: 250 },
      { minAge: 40, maxAge: 65, netRate: 209, msrpRate: 289 },
    ];
    const expanded = expandCombinedSpreadsheetTiers([
      { tierType: 'ES/EC', label: 'ES/EC', ageBands: bands },
    ] as never);
    expect(expanded).toHaveLength(2);
    expect(expanded[0].tierType).toBe('ES');
    expect(expanded[1].tierType).toBe('EC');
    expect(expanded[0].ageBands).toHaveLength(2);
    expect(expanded[1].ageBands).toHaveLength(2);
  });

  it('splitStackedEsEcAgeBands repairs four duplicate-range bands in EC', () => {
    const split = splitStackedEsEcAgeBands([
      {
        tierType: 'EC',
        ageBands: [
          { minAge: 18, maxAge: 39, netRate: 169, msrpRate: 232 },
          { minAge: 40, maxAge: 65, netRate: 209, msrpRate: 272 },
          { minAge: 18, maxAge: 39, netRate: 211, msrpRate: 250 },
          { minAge: 40, maxAge: 65, netRate: 250, msrpRate: 289 },
        ],
      },
    ] as never);
    expect(split).toHaveLength(2);
    expect(split[0].tierType).toBe('ES');
    expect(split[1].tierType).toBe('EC');
    expect(split[0].ageBands![0].msrpRate).toBe(232);
    expect(split[1].ageBands![0].msrpRate).toBe(250);
  });

  it('stripStraySingletonAgeBands removes 48-48 when wide bands exist', () => {
    const out = stripStraySingletonAgeBands([
      { minAge: 48, maxAge: 48, netRate: 272, msrpRate: 289 },
      { minAge: 18, maxAge: 39, netRate: 169, msrpRate: 250 },
      { minAge: 40, maxAge: 65, netRate: 209, msrpRate: 289 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.some((b) => b.minAge === 48)).toBe(false);
  });

  it('applyAiAgeBands strips 48-48 even when AI mistakenly includes it', () => {
    const existing = [
      { id: 'b1', minAge: 48, maxAge: 48, tobaccoStatus: 'N/A', netRate: 272, msrpRate: 289 } as never,
      { id: 'b2', minAge: 18, maxAge: 39, tobaccoStatus: 'N/A', netRate: 169, msrpRate: 250 } as never,
      { id: 'b3', minAge: 40, maxAge: 65, tobaccoStatus: 'N/A', netRate: 209, msrpRate: 289 } as never,
    ];
    const result = applyAiAgeBands(existing, [
      { minAge: 48, maxAge: 48, netRate: 272, msrpRate: 289 },
      { minAge: 18, maxAge: 39, netRate: 169, overrideRate: 3.25, commission: 60, msrpRate: 232.65 },
      { minAge: 40, maxAge: 65, netRate: 209.5, overrideRate: 3.25, commission: 60, msrpRate: 272.75 },
    ]);
    expect(result).toHaveLength(2);
    expect(result.some((b) => b.minAge === 48 && b.maxAge === 48)).toBe(false);
  });

  it('mergePricingTiers keeps EE/ES/EF when patch only updates EC', () => {
    const form = {
      pricingTiers: [
        { id: 'tier-ee', tierType: 'EE', label: 'EE', ageBands: [{ id: '1', minAge: 18, maxAge: 39, tobaccoStatus: 'N/A', netRate: 75, msrpRate: 141 } as never] },
        { id: 'tier-ec', tierType: 'EC', label: 'EC', ageBands: [
          { id: 'stray', minAge: 48, maxAge: 48, tobaccoStatus: 'N/A', netRate: 272, msrpRate: 289 } as never,
          { id: 'u40', minAge: 18, maxAge: 39, tobaccoStatus: 'N/A', netRate: 169, msrpRate: 250 } as never,
        ] },
      ],
    } as unknown as ProductFormData;

    const patch = normalizeProductAiPatch({
      pricingTiers: [
        {
          id: 'tier-ec',
          tierType: 'EC',
          ageBands: [
            { minAge: 48, maxAge: 48, netRate: 272, msrpRate: 289 },
            { minAge: 18, maxAge: 39, netRate: 169, overrideRate: 3.25, commission: 60, msrpRate: 232.65 },
            { minAge: 40, maxAge: 65, netRate: 209.5, overrideRate: 3.25, commission: 60, msrpRate: 272.75 },
          ],
        },
      ],
    } as never);

    const applied = applyProductAiPatch(form, patch);
    expect(applied.pricingTiers).toHaveLength(2);
    expect(applied.pricingTiers.find((t) => t.tierType === 'EE')).toBeTruthy();
    const ec = applied.pricingTiers.find((t) => t.tierType === 'EC')!;
    expect(ec.ageBands.find((b) => b.minAge === 18 && b.maxAge === 39)!.netRate).toBe(169);
    expect(ec.ageBands.some((b) => b.minAge === 48 && b.maxAge === 48)).toBe(true);
  });

  it('mergePricingTiers keeps phased-out EE when patch updates active EE cohort', () => {
    const form = {
      pricingTiers: [
        {
          id: 'ee-old',
          tierType: 'EE',
          label: 'Employee (2026-01-01)',
          ageBands: [
            {
              id: 'old-band',
              minAge: 18,
              maxAge: 65,
              tobaccoStatus: 'N/A',
              effectiveDate: '2026-01-01',
              terminationDate: '2026-05-29',
              netRate: 100,
              msrpRate: 150,
              configValue1: 'PlanA',
            } as never,
          ],
        },
        {
          id: 'ee-new',
          tierType: 'EE',
          label: 'Employee (2026-05-30)',
          ageBands: [
            {
              id: 'new-band',
              minAge: 18,
              maxAge: 65,
              tobaccoStatus: 'N/A',
              effectiveDate: '2026-05-30',
              terminationDate: null,
              netRate: 200,
              msrpRate: 250,
              configValue1: 'PlanB',
            } as never,
          ],
        },
      ],
    } as unknown as ProductFormData;

    const patch = normalizeProductAiPatch({
      pricingTiers: [
        {
          tierType: 'EE',
          label: 'Tier 1',
          ageBands: [{ minAge: 18, maxAge: 65, netRate: 193, overrideRate: 10, commission: 50, msrpRate: 253 }],
        },
      ],
    } as never);

    const applied = applyProductAiPatch(form, patch);
    expect(applied.pricingTiers).toHaveLength(2);
    const active = applied.pricingTiers.find((t) => t.id === 'ee-new')!;
    const legacy = applied.pricingTiers.find((t) => t.id === 'ee-old')!;
    expect(active.label).toBe('Employee (2026-05-30)');
    expect(active.ageBands[0].netRate).toBe(193);
    expect(active.ageBands[0].configValue1).toBe('PlanB');
    expect(legacy.ageBands[0].netRate).toBe(100);
    expect(legacy.ageBands[0].configValue1).toBe('PlanA');
  });

  it('adds config-value variations instead of overwriting same age/tobacco band', () => {
    const form = {
      pricingTiers: [
        {
          id: 't1',
          tierType: 'EE',
          label: 'Employee Only',
          ageBands: [
            {
              id: 'b-2000',
              minAge: 40,
              maxAge: 50,
              tobaccoStatus: 'N/A',
              netRate: 100,
              overrideRate: 0,
              commission: 0,
              msrpRate: 100,
              configValue1: '2000',
            } as never,
          ],
        },
      ],
    } as unknown as ProductFormData;

    const patch = normalizeProductAiPatch({
      pricingTiers: [
        {
          id: 't1',
          tierType: 'EE',
          ageBands: [
            { minAge: 40, maxAge: 50, tobaccoStatus: 'N/A', netRate: 100, overrideRate: 0, commission: 0, msrpRate: 100, configValue1: '2000' },
            { minAge: 40, maxAge: 50, tobaccoStatus: 'N/A', netRate: 130, overrideRate: 0, commission: 0, msrpRate: 130, configValue1: '3500' },
            { minAge: 40, maxAge: 50, tobaccoStatus: 'N/A', netRate: 160, overrideRate: 0, commission: 0, msrpRate: 160, configValue1: '6000' },
          ],
        },
      ],
    } as never);

    const applied = applyProductAiPatch(form, patch);
    const bands = applied.pricingTiers[0].ageBands;
    expect(bands).toHaveLength(3);
    expect(bands.map((b) => b.configValue1).sort()).toEqual(['2000', '3500', '6000']);
    // existing 2000 band keeps its id (updated in place), not duplicated
    expect(bands.filter((b) => b.configValue1 === '2000')).toHaveLength(1);
    expect(bands.find((b) => b.configValue1 === '2000')!.id).toBe('b-2000');
  });

  it('updates a single config variation by configValue without touching siblings', () => {
    const form = {
      pricingTiers: [
        {
          id: 't1',
          tierType: 'EE',
          label: 'Employee Only',
          ageBands: [
            { id: 'b-2000', minAge: 40, maxAge: 50, tobaccoStatus: 'N/A', netRate: 100, overrideRate: 0, commission: 0, msrpRate: 100, configValue1: '2000' } as never,
            { id: 'b-3500', minAge: 40, maxAge: 50, tobaccoStatus: 'N/A', netRate: 130, overrideRate: 0, commission: 0, msrpRate: 130, configValue1: '3500' } as never,
          ],
        },
      ],
    } as unknown as ProductFormData;

    const patch = normalizeProductAiPatch({
      pricingTiers: [
        {
          id: 't1',
          tierType: 'EE',
          ageBands: [
            { minAge: 40, maxAge: 50, tobaccoStatus: 'N/A', netRate: 145, overrideRate: 0, commission: 0, msrpRate: 145, configValue1: '3500' },
          ],
        },
      ],
    } as never);

    const applied = applyProductAiPatch(form, patch);
    const bands = applied.pricingTiers[0].ageBands;
    expect(bands).toHaveLength(2);
    expect(bands.find((b) => b.configValue1 === '3500')!.netRate).toBe(145);
    expect(bands.find((b) => b.configValue1 === '2000')!.netRate).toBe(100);
  });

  it('normalizeAgeBand preserves config values when AI omits them', () => {
    const existing = {
      id: 'b1',
      minAge: 18,
      maxAge: 65,
      tobaccoStatus: 'N/A',
      netRate: 100,
      configValue1: 'KeepMe',
      configValue2: 'AlsoKeep',
    } as never;
    const merged = applyProductAiPatch(
      { pricingTiers: [{ id: 't1', tierType: 'EE', label: 'EE', ageBands: [existing] }] } as never,
      normalizeProductAiPatch({
        pricingTiers: [
          {
            id: 't1',
            tierType: 'EE',
            ageBands: [{ minAge: 18, maxAge: 65, netRate: 90, overrideRate: 0, commission: 0, msrpRate: 90 }],
          },
        ],
      } as never)
    );
    expect(merged.pricingTiers[0].ageBands[0].configValue1).toBe('KeepMe');
    expect(merged.pricingTiers[0].ageBands[0].configValue2).toBe('AlsoKeep');
  });
});
