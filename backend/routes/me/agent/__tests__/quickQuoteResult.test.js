const { classifyQuoteMode, buildQuickQuoteResult } = require('../quickQuoteResult');

const zeroTotals = { subtotalPremium: 0, processingFee: 0, systemFees: 0, totalPremium: 0 };

const item = (productId, value, premium) => ({
  quoteItemId: `${productId}__${value}`,
  productId,
  productName: `Product ${productId}`,
  isBundle: false,
  basePremium: premium,
  includedProcessingFee: 0,
  premiumWithIncludedFee: premium,
  selectedConfigValues: { 1: String(value) },
  selectedConfigDetails: [{ key: '1', label: 'Unshared Amount', value: String(value) }]
});

describe('classifyQuoteMode', () => {
  test('single product with a single amount is a determinate basket', () => {
    const breakdown = [item('A', 5000, 265.25)];
    expect(classifyQuoteMode(breakdown)).toBe('basket');
  });

  test('multiple products each with a single amount is a determinate basket', () => {
    const breakdown = [item('A', 5000, 265.25), item('B', 5000, 315.0)];
    expect(classifyQuoteMode(breakdown)).toBe('basket');
  });

  test('a single product with multiple amounts is comparison mode', () => {
    const breakdown = [item('A', 5000, 265.25), item('A', 2500, 315.25)];
    expect(classifyQuoteMode(breakdown)).toBe('comparison');
  });

  test('multiple products where any product has multiple amounts is comparison mode', () => {
    const breakdown = [
      item('A', 5000, 265.25),
      item('A', 2500, 315.25),
      item('A', 1500, 360.25),
      item('B', 5000, 315.0),
      item('B', 2500, 360.0)
    ];
    expect(classifyQuoteMode(breakdown)).toBe('comparison');
  });

  test('empty breakdown is a determinate basket', () => {
    expect(classifyQuoteMode([])).toBe('basket');
  });
});

describe('buildQuickQuoteResult', () => {
  test('comparison mode returns the full breakdown, no cartesian options, no combined total', () => {
    const breakdown = [
      item('A', 5000, 265.25),
      item('A', 2500, 315.25),
      item('B', 5000, 315.0),
      item('B', 2500, 360.0)
    ];
    const result = buildQuickQuoteResult({
      breakdown,
      mode: 'comparison',
      basketTotals: { subtotalPremium: 999, processingFee: 1, systemFees: 1, totalPremium: 999 }
    });

    expect(result.comparison).toBe(true);
    // every priced item is present, not just the first scenario
    expect(result.breakdown).toHaveLength(4);
    // no cartesian "Totals by option" boxes
    expect(result.quoteOptions).toEqual([]);
    // no combined total in comparison mode
    expect(result.totals).toEqual(zeroTotals);
  });

  test('determinate basket returns a single option and the combined total', () => {
    const breakdown = [item('A', 5000, 265.25), item('B', 5000, 315.0)];
    const basketTotals = { subtotalPremium: 580.25, processingFee: 0, systemFees: 0.03, totalPremium: 580.28 };
    const result = buildQuickQuoteResult({ breakdown, mode: 'basket', basketTotals });

    expect(result.comparison).toBe(false);
    expect(result.breakdown).toHaveLength(2);
    expect(result.totals).toEqual(basketTotals);
    // a single option keeps the existing single-quote rendering path working
    expect(result.quoteOptions).toHaveLength(1);
    expect(result.quoteOptions[0].totals).toEqual(basketTotals);
    expect(result.quoteOptions[0].breakdown).toHaveLength(2);
  });
});
