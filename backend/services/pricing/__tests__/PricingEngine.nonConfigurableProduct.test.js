/**
 * Non-configurable products must not expose synthetic pricingVariations (configValue "Default").
 */

const PricingEngine = require('../PricingEngine');

describe('PricingEngine.calculateProductPricing — non-configurable products', () => {
  const GETWELL_DENTAL_ID = '1D5DA922-31E6-401D-8346-D3340FDC4294';

  test('GetWell Dental EE omits pricingVariations; single monthlyPremium only', async () => {
    const r = await PricingEngine.calculateProductPricing(
      GETWELL_DENTAL_ID,
      { age: 30, tobaccoUse: 'No', tier: 'EE' },
      {},
      '2026-07-01'
    );

    expect(r.hasConfigurationFields).toBe(false);
    expect(r.availableConfigs).toEqual([]);
    expect(r.pricingVariations).toEqual([]);
    expect(r.monthlyPremium).toBe(40.72);
  });
});
