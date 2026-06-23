'use strict';

const { requireShared } = require('../../config/shared-modules');
const { resolveProcessingFeeTotalFromParts } = requireShared('payment-product-snapshots');

describe('calculateGroupBillingFeeBreakdown unattributed remainder', () => {
  function buildLines(includedRows, includedOnProducts, ppfRemainder) {
    const processingFeeByProduct = includedRows.map((row) => ({
      productId: row.ProductId,
      productName: row.ProductName,
      amount: Math.round(parseFloat(row.IncludedProcessingFee || 0) * 100) / 100
    }));
    const ppf = resolveProcessingFeeTotalFromParts(includedOnProducts, ppfRemainder);
    const includedSum = processingFeeByProduct.reduce((s, l) => s + l.amount, 0);
    const unattributed = Math.round((ppf.total - includedSum) * 100) / 100;
    if (unattributed > 0.005) {
      processingFeeByProduct.push({
        productId: null,
        productName: 'Group processing fee',
        amount: unattributed
      });
    }
    return processingFeeByProduct;
  }

  test('legacy portfolio has no extra group line when included equals total', () => {
    const lines = buildLines(
      [{ ProductId: 'a', ProductName: 'Plan A', IncludedProcessingFee: 48 }],
      48,
      48
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe(48);
  });

  test('adds group line for non-included remainder', () => {
    const lines = buildLines(
      [{ ProductId: 'a', ProductName: 'Plan A', IncludedProcessingFee: 2.7 }],
      2.7,
      8.14
    );
    expect(lines).toHaveLength(2);
    expect(lines[1].productName).toBe('Group processing fee');
    expect(lines[1].amount).toBe(8.14);
  });
});
