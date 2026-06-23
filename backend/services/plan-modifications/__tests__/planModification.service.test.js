/**
 * Tests for planModification.computeNewPlanCost — Phase 3 pricing authority delegation.
 */

jest.mock('../../../config/database');
jest.mock('../../pricing/pricingAuthority.service');

const pricingAuthority = require('../../pricing/pricingAuthority.service');
const { getPool } = require('../../../config/database');

const planMod = require('../planModification.service');

describe('planModification.computeNewPlanCost', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockResolvedValue({ request: () => ({ input: jest.fn().mockReturnThis(), query: jest.fn().mockResolvedValue({ recordset: [] }) }) });
  });

  test('delegates to pricingAuthority.computePricing and returns fingerprint + display', async () => {
    pricingAuthority.computePricing.mockResolvedValue({
      products: [{ productId: 'p1', displayPremium: 257, basePremium: 250, includedFee: 7 }],
      totals: { basePremiumTotal: 250, includedFeeTotal: 7, nonIncludedFeeTotal: 0, systemFees: 0, displayPremiumTotal: 257, monthlyContribution: 257 },
      display: { lineItems: [{ productId: 'p1', label: 'Plan', amount: '$257.00' }], summary: { rows: [] }, policies: {} },
      pricingFingerprint: 'sha256:plan-change-test'
    });

    const result = await planMod.computeNewPlanCost({
      tenantId: '00000000-0000-0000-0000-000000000001',
      pricingProducts: [{ productId: 'p1', monthlyPremium: 250, isBundle: false }],
      paymentMethodType: 'ACH'
    });

    expect(result.pricingFingerprint).toBe('sha256:plan-change-test');
    expect(result.monthlyContribution).toBe(257);
    expect(result.display.lineItems).toHaveLength(1);
    expect(result.totals.includedFeeTotal).toBe(7);
  });

  test('accepts caller-provided pool / transaction', async () => {
    pricingAuthority.computePricing.mockResolvedValue({
      products: [], totals: { monthlyContribution: 0, includedFeeTotal: 0, nonIncludedFeeTotal: 0, systemFees: 0, basePremiumTotal: 0, displayPremiumTotal: 0 },
      display: { lineItems: [], summary: { rows: [] }, policies: {} },
      pricingFingerprint: 'sha256:zero'
    });
    const fakeTxn = { __txn: true };
    await planMod.computeNewPlanCost({
      tenantId: 't',
      pricingProducts: [],
      paymentMethodType: 'Card',
      poolOrTransaction: fakeTxn
    });
    expect(pricingAuthority.computePricing).toHaveBeenCalledWith(expect.objectContaining({ poolOrTransaction: fakeTxn }));
  });
});
