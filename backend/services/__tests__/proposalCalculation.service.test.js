/**
 * Tests that proposalCalculation.applyQuoteFeesToParts delegates to
 * pricingAuthority.computePricing (Phase 3 migration).
 */

jest.mock('../../config/database');
jest.mock('../pricing/pricingAuthority.service');

const pricingAuthority = require('../pricing/pricingAuthority.service');
const { getPool } = require('../../config/database');
const { applyQuoteFeesToParts } = require('../proposalCalculation.service');

describe('proposalCalculation.applyQuoteFeesToParts — pricingAuthority delegation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockResolvedValue({ request: () => ({ input: jest.fn().mockReturnThis(), query: jest.fn().mockResolvedValue({ recordset: [] }) }) });
  });

  test('calls pricingAuthority.computePricing with tenantId + pricingProducts + paymentMethod', async () => {
    pricingAuthority.computePricing.mockResolvedValue({
      products: [{ productId: 'p1', displayPremium: 104, basePremium: 100, includedFee: 4 }],
      totals: { basePremiumTotal: 100, includedFeeTotal: 4, nonIncludedFeeTotal: 0, systemFees: 0, displayPremiumTotal: 104, monthlyContribution: 104 },
      display: { lineItems: [], summary: { rows: [] }, policies: {} },
      pricingFingerprint: 'sha256:test'
    });

    const parts = [{ productId: 'p1', basePremium: 100 }];
    const feeCtx = {
      tenantId: '00000000-0000-0000-0000-000000000001',
      chargeFeeToMember: true,
      paymentProcessorSettings: { chargeFeeToMember: true },
      systemFeesSettings: null,
      feesByProductId: { p1: { includeProcessingFee: true, roundUpProcessingFee: true, zeroFeeForACH: false, customSystemFeeEnabled: false, customSystemFeeAmount: null } }
    };

    const result = await applyQuoteFeesToParts(parts, feeCtx, 'ACH');

    expect(pricingAuthority.computePricing).toHaveBeenCalledTimes(1);
    const call = pricingAuthority.computePricing.mock.calls[0][0];
    expect(call.tenantId).toBe(feeCtx.tenantId);
    expect(call.paymentMethodType).toBe('ACH');
    expect(call.pricingProducts).toHaveLength(1);
    expect(call.pricingProducts[0]).toMatchObject({ productId: 'p1', monthlyPremium: 100, isBundle: false });
  });

  test('returns legacy shape (basePremium, processingFee, systemFees, totalPremium) plus authority', async () => {
    pricingAuthority.computePricing.mockResolvedValue({
      products: [],
      totals: { basePremiumTotal: 100, includedFeeTotal: 4, nonIncludedFeeTotal: 0.75, systemFees: 3.5, displayPremiumTotal: 104, monthlyContribution: 108.25 },
      display: { lineItems: [], summary: { rows: [] }, policies: {} },
      pricingFingerprint: 'sha256:abc'
    });

    const parts = [{ productId: 'p1', basePremium: 100 }];
    const feeCtx = { tenantId: 't', chargeFeeToMember: true, paymentProcessorSettings: {}, systemFeesSettings: null, feesByProductId: {} };

    const result = await applyQuoteFeesToParts(parts, feeCtx, 'ACH');

    expect(result.basePremium).toBe(100);
    expect(result.processingFee).toBe(0.75);
    expect(result.systemFees).toBe(3.5);
    expect(result.totalPremium).toBe(108.25);
    expect(result.authority.pricingFingerprint).toBe('sha256:abc');
  });

  test('empty parts short-circuits to zero without calling authority', async () => {
    const result = await applyQuoteFeesToParts([], {}, 'ACH');
    expect(pricingAuthority.computePricing).not.toHaveBeenCalled();
    expect(result).toEqual({ basePremium: 0, processingFee: 0, systemFees: 0, totalPremium: 0, authority: null });
  });
});
