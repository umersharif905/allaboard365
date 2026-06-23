const { analyzeZeroFrontendMismatch } = require('../enrollmentSubmitForensics');

describe('analyzeZeroFrontendMismatch', () => {
  it('lists trace failure reasons and pricing fetch state', () => {
    const hints = analyzeZeroFrontendMismatch({
      clientForensics: {
        pricingSource: 'individual-pricing-builder',
        pricingFetch: { loading: true, fetching: false, isError: false },
        submitDerived: {
          calculatedAmount: 0,
          individualTraces: [
            {
              productId: '8941BEE7-FAD0-4027-B234-D3331603E053',
              failureReason: 'no_pricing_variation_for_config_5000',
              pricingRowFound: true
            }
          ]
        }
      },
      serverReplay: {
        products: [{ productId: '8941BEE7-FAD0-4027-B234-D3331603E053', monthlyPremium: 299.25 }]
      },
      amountValidation: { frontendAmount: 0, backendAmount: 305.25 }
    });
    expect(hints.some((h) => h.includes('no_pricing_variation_for_config_5000'))).toBe(true);
    expect(hints.some((h) => h.includes('still loading'))).toBe(true);
    expect(hints.some((h) => h.includes('classic submit payload'))).toBe(true);
  });
});
