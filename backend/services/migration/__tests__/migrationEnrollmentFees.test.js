'use strict';

jest.mock('../../pricing/pricingAuthority.service', () => ({
  computePricing: jest.fn()
}));

jest.mock('../../../utils/productProcessingFees', () => ({
  loadSubscriptionFeeSettingsByProductId: jest.fn().mockResolvedValue(new Map()),
  calculateSystemFeeAmount: jest.fn().mockReturnValue(0)
}));

jest.mock('../../enrollments/enrollmentWriter.service', () => ({
  insertNonProductEnrollmentRow: jest.fn().mockResolvedValue(undefined)
}));

const pricingAuthority = require('../../pricing/pricingAuthority.service');
const { insertNonProductEnrollmentRow } = require('../../enrollments/enrollmentWriter.service');
const {
  computeMigrationExpectedFees,
  insertMigrationFeeEnrollments
} = require('../migrationEnrollmentFees.service');

const pool = { request: () => ({ input: jest.fn().mockReturnThis(), query: jest.fn().mockResolvedValue({ recordset: [{ PaymentProcessorSettings: null, SystemFees: null }] }) }) };

describe('migrationEnrollmentFees (PPF remainder-only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('all included-fee product lines → no PaymentProcessingFee row', async () => {
    const result = await insertMigrationFeeEnrollments({
      poolOrTransaction: pool,
      tenantId: '00000000-0000-0000-0000-000000000001',
      primaryMemberId: '00000000-0000-0000-0000-000000000002',
      householdId: '00000000-0000-0000-0000-000000000002',
      productLines: [{ productId: 'p1', basePremium: 278.75, includedPaymentProcessingFeeAmount: 10.25 }],
      createdBy: '00000000-0000-0000-0000-000000000003',
      effectiveDate: new Date()
    });
    expect(result.expectedPaymentProcessingFeeRemainder).toBe(0);
    expect(result.expectedProcessingFeeTotal).toBe(10.25);
    expect(result.created).not.toContain('PaymentProcessingFee');
    expect(insertNonProductEnrollmentRow).not.toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentType: 'PaymentProcessingFee' })
    );
  });

  test('mixed included + non-included → PPF row = authority nonIncludedFeeTotal only', async () => {
    pricingAuthority.computePricing.mockResolvedValue({
      totals: { nonIncludedFeeTotal: 4.5 }
    });
    const fees = await computeMigrationExpectedFees({
      poolOrTransaction: {
        request: () => ({
          input: jest.fn().mockReturnThis(),
          query: jest.fn().mockResolvedValue({
            recordset: [{
              PaymentProcessorSettings: JSON.stringify({ chargeFeeToMember: true, processingFeePercentage: 3 }),
              SystemFees: null
            }]
          })
        })
      },
      tenantId: 't1',
      productLines: [
        { productId: 'p1', basePremium: 278.75, includedPaymentProcessingFeeAmount: 10.25 },
        { productId: 'p2', basePremium: 100, includedPaymentProcessingFeeAmount: 0 }
      ],
      paymentMethod: { paymentMethodType: 'Card' }
    });
    expect(fees.expectedPaymentProcessingFeeRemainder).toBe(4.5);
    expect(fees.expectedProcessingFeeTotal).toBe(14.75);
    expect(fees.expectedIncludedProcessingFeeTotal).toBe(10.25);
  });

  test('non-included only → PPF remainder equals full dynamic fee', async () => {
    pricingAuthority.computePricing.mockResolvedValue({
      totals: { nonIncludedFeeTotal: 7.0 }
    });
    const fees = await computeMigrationExpectedFees({
      poolOrTransaction: {
        request: () => ({
          input: jest.fn().mockReturnThis(),
          query: jest.fn().mockResolvedValue({
            recordset: [{
              PaymentProcessorSettings: JSON.stringify({ chargeFeeToMember: true }),
              SystemFees: null
            }]
          })
        })
      },
      tenantId: 't1',
      productLines: [{ productId: 'p2', basePremium: 100, includedPaymentProcessingFeeAmount: 0 }],
      paymentMethod: { paymentMethodType: 'ACH' }
    });
    expect(fees.expectedPaymentProcessingFeeRemainder).toBe(7);
    expect(fees.expectedProcessingFeeTotal).toBe(7);
  });
});
