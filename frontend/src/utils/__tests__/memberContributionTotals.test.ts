import { describe, expect, it } from 'vitest';
import { computeMemberContributionTotals } from '../memberContributionTotals';

const alwaysActive = () => true;

describe('computeMemberContributionTotals', () => {
  it('does not add includedPaymentProcessingFeeAmount on top of fee enrollment rows', () => {
    const totals = computeMemberContributionTotals(
      [
        { enrollmentType: 'Product', premiumAmount: 620.75 },
        {
          enrollmentType: 'Product',
          premiumAmount: 133.03,
          includedPaymentProcessingFeeAmount: 4.97,
        } as never,
        { enrollmentType: 'PaymentProcessingFee', premiumAmount: 8.11 },
        { enrollmentType: 'SystemFee', premiumAmount: 3.5 },
      ],
      alwaysActive
    );

    expect(totals.totalProductPremium).toBeCloseTo(753.78, 2);
    expect(totals.processingFee).toBeCloseTo(11.61, 2);
    expect(totals.yourContribution).toBeCloseTo(765.39, 2);
  });

  it('matches Melissa Pell prod shape (product + fee rows, included fee is display-only)', () => {
    const totals = computeMemberContributionTotals(
      [
        { enrollmentType: 'Product', premiumAmount: 753.78 },
        { enrollmentType: 'PaymentProcessingFee', premiumAmount: 8.11 },
        { enrollmentType: 'SystemFee', premiumAmount: 3.5 },
      ],
      alwaysActive
    );

    expect(totals.totalProductPremium).toBe(753.78);
    expect(totals.processingFee).toBe(11.61);
    expect(totals.yourContribution).toBe(765.39);
  });

  it('subtracts employer contribution from product premium before adding fees', () => {
    const totals = computeMemberContributionTotals(
      [
        { enrollmentType: 'Product', premiumAmount: 500 },
        { enrollmentType: 'Contribution', employerContributionAmount: 100 },
        { enrollmentType: 'SystemFee', premiumAmount: 3.5 },
      ],
      alwaysActive
    );

    expect(totals.totalMonthlyContribution).toBe(400);
    expect(totals.yourContribution).toBe(403.5);
  });
});
