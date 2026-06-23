'use strict';

jest.mock('../../../config/database', () => ({
  sql: { UniqueIdentifier: jest.fn((v) => v) },
  getPool: jest.fn()
}));

jest.mock('../productMap.service', () => ({
  getProductMap: jest.fn()
}));

jest.mock('../migrationProductMapping.service', () => ({
  listProductPricingRows: jest.fn()
}));

jest.mock('../migrationBundleEnrollment.service', () => ({
  buildMigrationEnrollmentPlan: jest.fn(),
  resolveProductMapping: jest.fn(),
  isIgnoredProductMap: jest.fn()
}));

const { getPool } = require('../../../config/database');
const productMapService = require('../productMap.service');
const migrationProductMapping = require('../migrationProductMapping.service');
const {
  buildMigrationEnrollmentPlan,
  resolveProductMapping,
  isIgnoredProductMap
} = require('../migrationBundleEnrollment.service');
const { compareHouseholdPremiums } = require('../householdPremiumCompare.service');

describe('compareHouseholdPremiums', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockResolvedValue({
      request: () => ({
        input: () => ({
          query: async () => ({ recordset: [{ Name: 'Mapped AB365 Product' }] })
        })
      })
    });
  });

  test('includes stored included processing fee in AB365 household total', async () => {
    resolveProductMapping.mockResolvedValue({
      ProductId: 'prod-1',
      ProductPricingId: 'price-1',
      IgnoreImport: false
    });
    isIgnoredProductMap.mockReturnValue(false);
    migrationProductMapping.listProductPricingRows.mockResolvedValue([
      {
        productPricingId: 'price-1',
        msrpRate: 278.75,
        includeProcessingFee: true,
        includedProcessingFee: 10.25
      }
    ]);
    buildMigrationEnrollmentPlan.mockResolvedValue({
      productLines: [{ productId: 'prod-1', basePremium: 289, includedPaymentProcessingFeeAmount: 10.25 }],
      enrollmentItems: [{
        productId: 'prod-1',
        product: { pdid: 123, benefitId: null, label: 'eBenefits Copay MEC' },
        amounts: { premiumAmount: 289 },
        productPricingId: 'price-1',
        productBundleId: null,
        tobaccoUse: 'No'
      }],
      earliestEffectiveDate: new Date()
    });

    const household = {
      primary: { tier: 'EE', tobaccoUse: 'No' },
      products: [{
        pdid: 123,
        benefitId: null,
        label: 'eBenefits Copay MEC',
        productfees: [{ amount: 289 }]
      }]
    };

    const result = await compareHouseholdPremiums(household, 'instance-1');
    expect(result.e123PremiumTotal).toBe(289);
    expect(result.ab365PremiumTotal).toBe(289);
    expect(result.premiumMismatch).toBe(false);
    expect(result.premiumBreakdown[0].matchStatus).toBe('exact');
    expect(result.premiumBreakdown[0].ab365ProductName).toBe('Mapped AB365 Product');
    expect(result.premiumBreakdown[0].e123Label).toBe('eBenefits Copay MEC');
  });
});
