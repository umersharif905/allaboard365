'use strict';

const {
  buildPricingImportKey,
  formatPricingTierLabel,
  normalizeSourceProductKey,
  deriveTierUaImportKeyFromPlanCode,
  resolveVendorImportProductMapping,
} = require('../../utils/vendorImportPricingKey');

describe('vendorImportPricingKey', () => {
  test('buildPricingImportKey builds EE_6000 from tier and UA config', () => {
    const key = buildPricingImportKey({
      ProductName: 'Essential (ShareWELL)',
      TierType: 'EE',
      ConfigField1: 'UA',
      ConfigValue1: '6000',
    });
    expect(key).toBe('EE_6000');
  });

  test('formatPricingTierLabel includes product and tier details', () => {
    const label = formatPricingTierLabel({
      ProductName: 'Essential (ShareWELL)',
      TierType: 'EE',
      ConfigValue1: '6000',
    });
    expect(label).toContain('Essential');
    expect(label).toContain('EE');
    expect(label).toContain('6000');
  });

  test('normalizeSourceProductKey strips trailing decimals', () => {
    expect(normalizeSourceProductKey('ee_6000.0')).toBe('EE_6000');
    expect(normalizeSourceProductKey('EE_6000')).toBe('EE_6000');
  });

  test('deriveTierUaImportKeyFromPlanCode normalizes composite export codes', () => {
    expect(deriveTierUaImportKeyFromPlanCode('11321_AH1500EE')).toBe('EE_1500');
    expect(deriveTierUaImportKeyFromPlanCode('11321_AH3000ES')).toBe('ES_3000');
    expect(deriveTierUaImportKeyFromPlanCode('EE_1500')).toBe('EE_1500');
    expect(deriveTierUaImportKeyFromPlanCode('46520_9376')).toBeNull();
  });

  test('resolveVendorImportProductMapping matches derived key against map', () => {
    const productMap = new Map([
      ['EE_1500', { ProductId: 'p1', ProductPricingId: 'pp1' }],
    ]);
    const hit = resolveVendorImportProductMapping(productMap, '11321_AH1500EE');
    expect(hit?.resolvedKey).toBe('EE_1500');
    expect(hit?.mapping.ProductPricingId).toBe('pp1');
  });

  test('resolveVendorImportProductMapping relabels legacy UA keys (3000→2500)', () => {
    const { normalizeImportRules } = require('../vendorImportRules');
    const rules = normalizeImportRules({
      planKey: { uaRelabel: [{ from: '3000', to: '2500' }, { from: '6000', to: '5000' }] },
    });
    const productMap = new Map([
      ['ES_2500', { ProductId: 'p1', ProductPricingId: 'pp-es' }],
    ]);
    const hit = resolveVendorImportProductMapping(productMap, 'ES_3000', rules);
    expect(hit?.resolvedKey).toBe('ES_2500');
    expect(hit?.mapping.ProductPricingId).toBe('pp-es');
  });
});
