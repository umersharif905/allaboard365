'use strict';

const {
  normalizeCatalogPricingRows,
  buildEffectiveCatalogPricingRows,
  resolveCatalogPremiumForPricingRow,
  catalogPremiumStats,
  formatCatalogPremiumHint
} = require('../e123CatalogPricing');

describe('e123CatalogPricing', () => {
  test('normalizeCatalogPricingRows keeps zero-amount matrix rows', () => {
    const rows = normalizeCatalogPricingRows({
      pricingMatrix: [
        {
          benefitId: 9392,
          amount: 0,
          benefitLabel: 'Member Only $1500 UA'
        }
      ]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(0);
    expect(rows[0].source).toBeNull();
  });

  test('buildEffectiveCatalogPricingRows fills zero matrix prices from GetRates', () => {
    const raw = normalizeCatalogPricingRows({
      pricingMatrix: [
        { benefitId: 9392, amount: 0, benefitLabel: 'Member Only $1500 UA' },
        { benefitId: 9396, amount: 220, benefitLabel: 'Member + Spouse $1500 UA' }
      ]
    });
    const rateGrid = {
      byBenefit: new Map([
        ['9392', { benefitId: '9392', benefitLabel: 'Member Only $1500 UA', nonTobaccoRate: 218.5, tobaccoRate: null }]
      ]),
      rows: [
        { benefitId: '9392', benefitLabel: 'Member Only $1500 UA', nonTobaccoRate: 218.5, tobaccoRate: null }
      ]
    };
    const effective = buildEffectiveCatalogPricingRows(raw, rateGrid);
    expect(effective).toHaveLength(2);
    const ee = effective.find((row) => row.benefitId === '9392');
    expect(ee.amount).toBe(218.5);
    expect(ee.source).toBe('getrates');
    const es = effective.find((row) => row.benefitId === '9396');
    expect(es.amount).toBe(220);
    expect(es.source).toBe('catalog');
  });

  test('resolveCatalogPremiumForPricingRow uses effective catalog rows', () => {
    const rows = buildEffectiveCatalogPricingRows(
      normalizeCatalogPricingRows({
        pricingMatrix: [{ benefitId: 9392, amount: 0, benefitLabel: 'Member Only $1500 UA' }]
      }),
      {
        byBenefit: new Map([
          ['9392', { benefitId: '9392', nonTobaccoRate: 218.5 }]
        ]),
        rows: [{ benefitId: '9392', nonTobaccoRate: 218.5 }]
      }
    );
    const amount = resolveCatalogPremiumForPricingRow(rows, '9392', { minAge: 18, maxAge: 64, msrpRate: 218.5 });
    expect(amount).toBe(218.5);
  });

  test('formatCatalogPremiumHint labels GetRates source', () => {
    const stats = catalogPremiumStats([
      { benefitId: '9392', amount: 218.5, source: 'getrates' }
    ], '9392');
    expect(formatCatalogPremiumHint(stats)).toContain('E123 GetRates');
    expect(formatCatalogPremiumHint(stats)).toContain('$218.50/mo');
  });
});
