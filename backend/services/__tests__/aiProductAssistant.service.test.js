const {
  stripSnapshotAndForbiddenKeys,
  normalizePatchPricingTiers,
  validatePricingPatchQuality,
  expandCombinedSpreadsheetTiers,
  splitStackedEsEcAgeBands,
} = require('../../utils/productAiPatch');

describe('productAiPatch', () => {
  test('stripSnapshotAndForbiddenKeys removes pricingTierIds', () => {
    const out = stripSnapshotAndForbiddenKeys({
      pricingTierIds: [{ id: '1', tierType: 'EE' }],
      pricingTiers: [{ tierType: 'EE', ageBands: [{ minAge: 18, maxAge: 65, netRate: 100, msrpRate: 120 }] }],
      currentStep: 5,
    });
    expect(out.pricingTierIds).toBeUndefined();
    expect(out.currentStep).toBeUndefined();
    expect(out.pricingTiers).toHaveLength(1);
  });

  test('normalizePatchPricingTiers coerces string amounts', () => {
    const out = normalizePatchPricingTiers({
      pricingTiers: [
        {
          tierType: 'EE',
          ageBands: [
            {
              minAge: '18',
              maxAge: '39',
              netRate: '$75',
              overrideRate: '3.25',
              commission: '50',
              msrpRate: '141',
            },
          ],
        },
      ],
    });
    expect(out.pricingTiers[0].ageBands[0].netRate).toBe(75);
    expect(out.pricingTiers[0].ageBands[0].overrideRate).toBe(3.25);
    expect(out.pricingTiers[0].ageBands[0].commission).toBe(50);
    expect(out.pricingTiers[0].ageBands[0].msrpRate).toBe(128.25);
  });

  test('validatePricingPatchQuality rejects pricingTierIds-only style empty bands', () => {
    const bad = validatePricingPatchQuality({
      pricingTiers: [{ id: 'abc', tierType: 'EC', ageBands: [] }],
    });
    expect(bad.ok).toBe(false);
  });

  test('validatePricingPatchQuality accepts tiers with rates', () => {
    const good = validatePricingPatchQuality({
      pricingTiers: [
        {
          id: 'abc',
          tierType: 'EE',
          ageBands: [
            { minAge: 18, maxAge: 39, netRate: 75, overrideRate: 3.25, commission: 50, msrpRate: 128.25 },
            { minAge: 40, maxAge: 65, netRate: 109.5, overrideRate: 3.25, commission: 50, msrpRate: 162.75 },
          ],
        },
      ],
    });
    expect(good.ok).toBe(true);
    expect(good.tierSummaries).toHaveLength(1);
  });

  test('validatePricingPatchQuality accepts net-only tiers (override/commission 0) with a warning', () => {
    const result = validatePricingPatchQuality({
      pricingTiers: [
        {
          tierType: 'EE',
          ageBands: [{ minAge: 18, maxAge: 39, netRate: 75, msrpRate: 75 }],
        },
      ],
    });
    // Net-only pricing is a valid, applicable configuration — must NOT hard-block,
    // otherwise the assistant loops re-asking and can never fulfill the request.
    expect(result.ok).toBe(true);
    expect(result.structureWarnings.some((w) => /Net Rate/i.test(w))).toBe(true);
  });

  test('expandCombinedSpreadsheetTiers splits ES/EC combined row', () => {
    const out = expandCombinedSpreadsheetTiers([
      {
        tierType: 'ES/EC',
        ageBands: [
          { minAge: 18, maxAge: 39, netRate: 169, msrpRate: 250 },
          { minAge: 40, maxAge: 65, netRate: 209, msrpRate: 289 },
        ],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].tierType).toBe('ES');
    expect(out[1].tierType).toBe('EC');
  });

  test('splitStackedEsEcAgeBands splits duplicate age ranges in EC', () => {
    const out = splitStackedEsEcAgeBands([
      {
        tierType: 'EC',
        ageBands: [
          { minAge: 18, maxAge: 39, netRate: 1, msrpRate: 10 },
          { minAge: 40, maxAge: 65, netRate: 2, msrpRate: 20 },
          { minAge: 18, maxAge: 39, netRate: 3, msrpRate: 30 },
          { minAge: 40, maxAge: 65, netRate: 4, msrpRate: 40 },
        ],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].tierType).toBe('ES');
    expect(out[1].tierType).toBe('EC');
  });

  test('validatePricingPatchQuality warns on duplicate age ranges in one tier', () => {
    const result = validatePricingPatchQuality({
      pricingTiers: [
        {
          tierType: 'EC',
          ageBands: [
            { minAge: 18, maxAge: 39, netRate: 100, overrideRate: 3.25, commission: 50, msrpRate: 153.25 },
            { minAge: 40, maxAge: 65, netRate: 110, overrideRate: 3.25, commission: 50, msrpRate: 163.25 },
            { minAge: 18, maxAge: 39, netRate: 105, overrideRate: 3.25, commission: 50, msrpRate: 158.25 },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.structureWarnings.some((w) => w.includes('duplicate age range'))).toBe(true);
  });

  test('normalizePatchPricingTiers applies ES/EC expansion', () => {
    const out = normalizePatchPricingTiers({
      pricingTiers: [{ tierType: 'ES/EC', ageBands: [{ minAge: 18, maxAge: 39, netRate: 75, overrideRate: 3.25, commission: 50, msrpRate: 128.25 }] }],
    });
    expect(out.pricingTiers).toHaveLength(2);
  });

  test('stripStraySingletonAgeBands removes 48-48 when wide bands present', () => {
    const { stripStraySingletonAgeBands } = require('../../utils/productAiPatch');
    const out = stripStraySingletonAgeBands([
      { minAge: 48, maxAge: 48, netRate: 272, msrpRate: 289 },
      { minAge: 18, maxAge: 39, netRate: 169, msrpRate: 250 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].minAge).toBe(18);
  });
});
