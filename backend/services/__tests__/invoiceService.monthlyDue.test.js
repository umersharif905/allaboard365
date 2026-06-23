'use strict';

const { monthlyDueFromEnrollmentSums } = require('../invoiceService');

describe('monthlyDueFromEnrollmentSums', () => {
  test('returns SUM(PremiumAmount) rounded to cents', () => {
    expect(monthlyDueFromEnrollmentSums({ premiumSum: 423.84 })).toBe(423.84);
    expect(monthlyDueFromEnrollmentSums({ premiumSum: 850 })).toBe(850);
    expect(monthlyDueFromEnrollmentSums({ premiumSum: 718.92 })).toBe(718.92);
  });

  test('ignores legacy included/ppf args (premium sum is authoritative)', () => {
    expect(
      monthlyDueFromEnrollmentSums({
        premiumSum: 798.57,
        includedOnProducts: 2.7,
        ppfOnFeeRow: 10.84,
      })
    ).toBe(798.57);
  });
});
