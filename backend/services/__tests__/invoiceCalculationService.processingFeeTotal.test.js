'use strict';

const { requireShared } = require('../../config/shared-modules');
const { resolveProcessingFeeTotalFromParts } = requireShared('payment-product-snapshots');

/**
 * Mirrors post-query mapping in calculateLocationPremiums.
 */
function mapLocationPremiumRow(row) {
  const ppf = resolveProcessingFeeTotalFromParts(
    row.IncludedProcessingFeeOnProducts,
    row.PpfRemainderOnFeeRows
  );
  return { ...row, PaymentProcessingFeeAmount: ppf.total };
}

describe('calculateLocationPremiums processing fee total', () => {
  test('legacy flat portfolio does not double-count included + PPF row', () => {
    const row = mapLocationPremiumRow({
      BasePremium: 1550,
      PpfRemainderOnFeeRows: 48,
      IncludedProcessingFeeOnProducts: 48
    });
    expect(row.PaymentProcessingFeeAmount).toBe(48);
    expect(row.BasePremium + row.PaymentProcessingFeeAmount).toBe(1598);
  });

  test('post-backfill sums included + remainder when remainder is larger', () => {
    const row = mapLocationPremiumRow({
      BasePremium: 100,
      PpfRemainderOnFeeRows: 8.14,
      IncludedProcessingFeeOnProducts: 2.7
    });
    expect(row.PaymentProcessingFeeAmount).toBe(10.84);
  });
});
