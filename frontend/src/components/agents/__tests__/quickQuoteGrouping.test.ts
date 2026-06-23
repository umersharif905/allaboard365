import { describe, expect, test } from 'vitest';
import { groupBreakdownByProduct } from '../quickQuoteGrouping';

const item = (productId: string, productName: string, value: string, premium: number) => ({
  quoteItemId: `${productId}__${value}`,
  productId,
  productName,
  isBundle: false,
  basePremium: premium,
  includedProcessingFee: 0,
  premiumWithIncludedFee: premium,
  selectedConfigValues: { 1: value },
  selectedConfigDetails: [{ key: '1', label: 'Unshared Amount', value }]
});

describe('groupBreakdownByProduct', () => {
  test('groups consecutive amount options under each product, preserving order', () => {
    const breakdown = [
      item('A', 'CoPay', '5000', 265.25),
      item('A', 'CoPay', '2500', 315.25),
      item('A', 'CoPay', '1500', 360.25),
      item('B', 'Concierge', '5000', 315.0),
      item('B', 'Concierge', '2500', 360.0)
    ];

    const groups = groupBreakdownByProduct(breakdown);

    expect(groups).toHaveLength(2);
    expect(groups[0].productId).toBe('A');
    expect(groups[0].productName).toBe('CoPay');
    expect(groups[0].items.map((i) => i.premiumWithIncludedFee)).toEqual([265.25, 315.25, 360.25]);
    expect(groups[1].productId).toBe('B');
    expect(groups[1].items).toHaveLength(2);
  });

  test('keeps a product as one group even if its items are interleaved', () => {
    const breakdown = [
      item('A', 'CoPay', '5000', 265.25),
      item('B', 'Concierge', '5000', 315.0),
      item('A', 'CoPay', '2500', 315.25)
    ];

    const groups = groupBreakdownByProduct(breakdown);

    expect(groups.map((g) => g.productId)).toEqual(['A', 'B']);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });

  test('returns an empty array for empty breakdown', () => {
    expect(groupBreakdownByProduct([])).toEqual([]);
  });
});
