'use strict';

const {
  tobaccoStatusFromImportRow,
  importRowDedupeKey,
  pickDefaultNonTobaccoPricingTier,
  pickPricingTierForTobacco,
} = require('../vendorImportTobacco');

const alignRules = require('../sharewellDefaultImportPresets').ALIGN_IMPORT_RULES;

describe('vendorImportTobacco', () => {
  test('tobaccoStatusFromImportRow matches legacy Align (100 = Yes) when rules say so', () => {
    expect(tobaccoStatusFromImportRow({ 'Tobacco Surcharge': '100' }, alignRules)).toBe('Yes');
    expect(tobaccoStatusFromImportRow({ 'Tobacco Surcharge': '100' })).toBe('Yes');
    expect(tobaccoStatusFromImportRow({ 'Tobacco Surcharge': '' })).toBe('No');
    expect(tobaccoStatusFromImportRow({ 'Tobacco Surcharge': '0' })).toBe('No');
  });

  test('importRowDedupeKey splits same plan code by tobacco', () => {
    const pk = 'ES_2500';
    expect(importRowDedupeKey({ 'Tobacco Surcharge': '100' }, pk)).toBe('ES_2500|Yes');
    expect(importRowDedupeKey({ 'Tobacco Surcharge': '' }, pk)).toBe('ES_2500|No');
  });

  test('pickDefaultNonTobaccoPricingTier prefers Tobacco No over Yes', () => {
    const candidates = [
      { productPricingId: 'yes', tobaccoStatus: 'Yes' },
      { productPricingId: 'no', tobaccoStatus: 'No' },
    ];
    expect(pickDefaultNonTobaccoPricingTier(candidates).productPricingId).toBe('no');
  });

  test('pickPricingTierForTobacco uses No tier when row has no tobacco signal', () => {
    const candidates = [
      { productPricingId: 'yes', tobaccoStatus: 'Yes' },
      { productPricingId: 'no', tobaccoStatus: 'No' },
    ];
    expect(pickPricingTierForTobacco(candidates, 'No').productPricingId).toBe('no');
    expect(pickPricingTierForTobacco(candidates, '').productPricingId).toBe('no');
  });

  test('pickPricingTierForTobacco uses Yes tier when row is tobacco Yes', () => {
    const candidates = [
      { productPricingId: 'yes', tobaccoStatus: 'Yes' },
      { productPricingId: 'no', tobaccoStatus: 'No' },
    ];
    expect(pickPricingTierForTobacco(candidates, 'Yes').productPricingId).toBe('yes');
  });
});
