'use strict';

const {
  resolvePricingAllocation,
  scalePricingRow,
  allocateFromCommissionableGap,
  inferTierCommissionDefault,
  pricingRowMsrp,
  flattenWizardPricingTiers
} = require('../e123PricingAllocation.service');

describe('e123PricingAllocation', () => {
  const essentialReference = {
    productPricingId: 'essential-ee-1500',
    tierType: 'EE',
    configValue1: '1500',
    tobaccoStatus: 'No',
    netRate: 194,
    overrideRate: 0,
    commission: 26,
    systemFees: 0,
    msrpRate: 220,
    overrides: [{
      OverrideId: 'ov-1',
      OverrideAmount: 5,
      IsActive: true
    }]
  };

  test('pricingRowMsrp uses stored msrp or component sum', () => {
    expect(pricingRowMsrp(essentialReference)).toBe(220);
    expect(pricingRowMsrp({ netRate: 100, overrideRate: 10, commission: 15 })).toBe(125);
  });

  test('resolvePricingAllocation copies exact MSRP match split', () => {
    const result = resolvePricingAllocation({
      msrp: 220,
      tierCode: 'EE',
      configValue1: '1500',
      tobaccoStatus: 'No',
      migrationTier: { feeAmountStats: { median: 220, sampleSize: 5 } },
      referenceRows: [essentialReference],
      templateRows: [],
      productType: 'Healthcare'
    });
    expect(result.msrpRate).toBe(220);
    expect(result.netRate).toBe(194);
    expect(result.commission).toBe(26);
    expect(result.overrideRate).toBe(0);
    expect(result.allocationSource).toBe('msrp_match');
    expect(result.overrides).toHaveLength(1);
  });

  test('resolvePricingAllocation scales template row for different UA MSRP', () => {
    const result = resolvePricingAllocation({
      msrp: 440,
      tierCode: 'EE',
      configValue1: '3000',
      tobaccoStatus: 'No',
      migrationTier: { feeAmountStats: { median: 440, sampleSize: 2 } },
      referenceRows: [],
      templateRows: [essentialReference],
      productType: 'Healthcare'
    });
    expect(result.msrpRate).toBe(440);
    expect(result.netRate).toBe(414);
    expect(result.commission).toBe(26);
    expect(result.allocationSource).toBe('template_scaled');
  });

  test('allocateFromCommissionableGap maps non-commissionable slice to override', () => {
    const result = allocateFromCommissionableGap(18.15, 17.12);
    expect(result.overrideRate).toBe(1.03);
    expect(result.commission).toBe(17.12);
    expect(result.msrpRate).toBe(18.15);
  });

  test('resolvePricingAllocation uses commissionable gap for BCS-like premiums', () => {
    const result = resolvePricingAllocation({
      msrp: 18.15,
      tierCode: 'EE',
      configValue1: '',
      tobaccoStatus: 'No',
      migrationTier: {
        feeAmountStats: { median: 18.15, sampleSize: 3 },
        commissionableAmountStats: { median: 17.12, sampleSize: 3 }
      },
      referenceRows: [],
      templateRows: [],
      productType: 'Accident'
    });
    expect(result.allocationSource).toBe('commissionable_gap');
    expect(result.overrideRate).toBe(1.03);
    expect(result.commission).toBe(17.12);
  });

  test('resolvePricingAllocation falls back to tier commission defaults', () => {
    const result = resolvePricingAllocation({
      msrp: 99,
      tierCode: 'EE',
      configValue1: '',
      tobaccoStatus: 'No',
      migrationTier: { feeAmountStats: { median: 99, sampleSize: 1 } },
      referenceRows: [],
      templateRows: [],
      productType: 'Healthcare'
    });
    expect(result.allocationSource).toBe('tier_commission_default');
    expect(result.commission).toBe(26);
    expect(result.netRate).toBe(73);
    expect(result.msrpRate).toBe(99);
  });

  test('inferTierCommissionDefault prefers reference row medians', () => {
    expect(inferTierCommissionDefault('EF', [essentialReference, {
      tierType: 'EF',
      commission: 38,
      msrpRate: 575
    }], 'Healthcare')).toBe(38);
  });

  test('scalePricingRow preserves flat commission when small', () => {
    const scaled = scalePricingRow(essentialReference, 220);
    expect(scaled.netRate).toBe(194);
    expect(scaled.commission).toBe(26);
  });

  test('flattenWizardPricingTiers expands nested wizard tiers', () => {
    const rows = flattenWizardPricingTiers([{
      tierType: 'EE',
      label: 'Employee Only (EE)',
      ageBands: [{
        tobaccoStatus: 'No',
        netRate: 194,
        overrideRate: 0,
        commission: 26,
        msrpRate: 220,
        configValue1: '1500',
        overrides: [{ OverrideId: 'x', OverrideAmount: 1, IsActive: true }]
      }]
    }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tierType).toBe('EE');
    expect(rows[0].msrpRate).toBe(220);
    expect(rows[0].overrides).toHaveLength(1);
  });
});
