const {
  resolveIncludedProcessingFee,
  calculateIncludedProcessingFeeForDisplay,
  resolveCatalogBasePremiumFromPricingRow,
  resolveCatalogRetailAndBaseFromPricingRow
} = require('../includedProcessingFee');

const tenantSettings = {
  chargeFeeToMember: true,
  activeProcessor: 'openenroll',
  processors: {
    openenroll: {
      fees: {
        ach: { percentageFee: 0.5, flatFee: 0.3 },
        creditCard: { percentageFee: 3, flatFee: 0.3 }
      }
    }
  }
};

describe('resolveIncludedProcessingFee', () => {
  test('P1: product flag + stored row uses stored amount', () => {
    const fee = resolveIncludedProcessingFee({
      basePremium: 100,
      paymentProcessorSettings: tenantSettings,
      chargeFeeToMemberEnabled: true,
      productFeeFlags: { includeProcessingFeeFromProduct: true },
      storedIncludedProcessingFee: 4
    });
    expect(fee).toBe(4);
  });

  test('P2: product catalog stored fee wins over dynamic calc', () => {
    const dynamic = calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, {
      paymentMethod: 'Highest'
    });
    expect(dynamic).toBeGreaterThan(0);
    const stored = resolveIncludedProcessingFee({
      basePremium: 100,
      paymentProcessorSettings: tenantSettings,
      chargeFeeToMemberEnabled: true,
      productFeeFlags: { includeProcessingFeeFromProduct: true },
      storedIncludedProcessingFee: 4
    });
    expect(stored).toBe(4);
    expect(stored).not.toBe(dynamic);
  });

  test('P2b: subscription-only ignores tier stored IncludedProcessingFee', () => {
    const fee = resolveIncludedProcessingFee({
      basePremium: 100,
      paymentProcessorSettings: tenantSettings,
      chargeFeeToMemberEnabled: true,
      productFeeFlags: { includeProcessingFeeFromSubscription: true },
      storedIncludedProcessingFee: 4
    });
    expect(fee).toBeGreaterThan(0);
    expect(fee).not.toBe(4);
  });

  test('P3: subscription-only uses dynamic calc', () => {
    const fee = resolveIncludedProcessingFee({
      basePremium: 100,
      paymentProcessorSettings: tenantSettings,
      chargeFeeToMemberEnabled: true,
      productFeeFlags: { includeProcessingFeeFromSubscription: true },
      storedIncludedProcessingFee: 0
    });
    expect(fee).toBeGreaterThan(0);
  });

  test('P5: chargeFeeToMember false returns 0', () => {
    const fee = resolveIncludedProcessingFee({
      basePremium: 100,
      paymentProcessorSettings: tenantSettings,
      chargeFeeToMemberEnabled: false,
      productFeeFlags: { includeProcessingFee: true },
      storedIncludedProcessingFee: 4
    });
    expect(fee).toBe(0);
  });
});

describe('resolveCatalogBasePremiumFromPricingRow', () => {
  test('legacy base-only MSRPRate returns msrp as base', () => {
    expect(
      resolveCatalogBasePremiumFromPricingRow({
        MSRPRate: 100,
        NetRate: 100,
        IncludedProcessingFee: 3
      })
    ).toBe(100);
  });

  test('retail MSRPRate returns component sum as base', () => {
    expect(
      resolveCatalogBasePremiumFromPricingRow({
        MSRPRate: 141,
        NetRate: 75,
        OverrideRate: 10.75,
        VendorCommission: 50,
        IncludedProcessingFee: 5.25
      })
    ).toBe(135.75);
  });

  test('agent API field names (VendorNetRate / TenantOverride)', () => {
    expect(
      resolveCatalogBasePremiumFromPricingRow({
        MSRPRate: 103,
        VendorNetRate: 100,
        TenantOverride: 0,
        VendorCommission: 0,
        IncludedProcessingFee: 3
      })
    ).toBe(100);
  });
});

describe('resolveCatalogRetailAndBaseFromPricingRow', () => {
  test('retail MSRPRate returns retail without stacking stored fee twice', () => {
    expect(
      resolveCatalogRetailAndBaseFromPricingRow({
        MSRPRate: 141,
        NetRate: 75,
        OverrideRate: 10.75,
        VendorCommission: 50,
        IncludedProcessingFee: 5.25
      })
    ).toEqual({
      baseAmount: 135.75,
      retailAmount: 141,
      includedProcessingFee: 5.25
    });
  });
});
