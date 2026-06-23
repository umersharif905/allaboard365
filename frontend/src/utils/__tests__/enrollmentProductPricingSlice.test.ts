import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  resolveEnrollmentWizardProductPricingSlice,
  syncBundleDefaultConfigIntoSelectedConfigs,
  buildIndividualFrontendPricingSubmitRows,
  traceIndividualFrontendPricingSubmit,
  sumFrontendPricingMonthlyRounded,
  productNameMapFromEnrollmentSections,
  type EnrollmentPricingProductRow,
} from '../enrollmentProductPricingSlice';

const BUNDLE_ID = 'bundle-1';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveEnrollmentWizardProductPricingSlice — bundles', () => {
  it('sums displayPremium across included lines for explicit selectedConfigs (no nondeterministic config pick)', () => {
    const product: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      tierType: 'ES',
      isBundle: true,
      includedProducts: [
        {
          productId: 'a',
          pricingVariations: [
            { configValue: 'EmpOnly', displayPremium: 100 },
            { configValue: 'EmpSpouse', displayPremium: 200 },
          ],
        },
        {
          productId: 'b',
          pricingVariations: [
            { configValue: 'EmpOnly', monthlyPremium: 50.505 },
            { configValue: 'EmpSpouse', monthlyPremium: 99 },
          ],
        },
      ],
    };
    const r = resolveEnrollmentWizardProductPricingSlice(
      BUNDLE_ID,
      { [BUNDLE_ID]: 'EmpOnly' },
      product,
    );
    expect(r?.monthlyPremium).toBe(150.51);
    expect(r?.configValue).toBe('EmpOnly');
  });

  it('uses backend defaultConfig when wizard has no selection for bundle', () => {
    const product: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      isBundle: true,
      defaultConfig: 'EmpSpouse',
      includedProducts: [
        {
          pricingVariations: [{ configValue: 'EmpSpouse', displayPremium: 100 }],
        },
      ],
    };
    const r = resolveEnrollmentWizardProductPricingSlice(BUNDLE_ID, {}, product);
    expect(r?.configValue).toBe('EmpSpouse');
    expect(r?.monthlyPremium).toBe(100);
  });

  it('returns null (and warns) when bundle has no configurable path and no default', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const product: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      isBundle: true,
      includedProducts: [
        {
          pricingVariations: [{ configValue: 'A', displayPremium: 1 }],
        },
      ],
    };
    expect(resolveEnrollmentWizardProductPricingSlice(BUNDLE_ID, {}, product)).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it('returns null (and warns) when a child has no UA match and no server flat premium on the row', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const product: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      isBundle: true,
      includedProducts: [
        {
          productId: 'child-1',
          pricingVariations: [{ configValue: 'wrong', displayPremium: 1 }],
        },
      ],
    };
    expect(
      resolveEnrollmentWizardProductPricingSlice(BUNDLE_ID, { [BUNDLE_ID]: 'want-this' }, product),
    ).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it('included child with mismatched variation keys but server flat monthlyPremium sums (Lyric-style in MightyWELL bundle)', () => {
    const product: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      isBundle: true,
      defaultConfig: '2500',
      includedProducts: [
        {
          productId: 'mighty',
          pricingVariations: [{ configValue: '2500', monthlyPremium: 223 }],
        },
        {
          productId: 'lyric',
          pricingVariations: [{ configValue: 'EE', monthlyPremium: 0 }],
          monthlyPremium: 0,
        },
        {
          productId: 'sharewell',
          pricingVariations: [
            { configValue: '2500', displayPremium: 126 },
            { configValue: '5000', displayPremium: 82 },
          ],
        },
      ],
    };
    const r = resolveEnrollmentWizardProductPricingSlice(BUNDLE_ID, {}, product);
    expect(r?.monthlyPremium).toBe(349);
    expect(r?.configValue).toBe('2500');
  });

  it('uses flat child displayPremium when child has no pricingVariations array', () => {
    const product: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      isBundle: true,
      defaultConfig: 'X',
      includedProducts: [
        { pricingVariations: [{ configValue: 'X', displayPremium: 10 }] },
        { displayPremium: 5 },
      ],
    };
    const r = resolveEnrollmentWizardProductPricingSlice(BUNDLE_ID, {}, product);
    expect(r?.monthlyPremium).toBe(15);
  });
});

describe('resolveEnrollmentWizardProductPricingSlice — non-bundles', () => {
  it('falls back to the first pricing variation when wizard has no config (legacy wizard behavior)', () => {
    const product: EnrollmentPricingProductRow = {
      productId: 'p1',
      pricingVariations: [
        { configValue: 'first', monthlyPremium: 42 },
        { configValue: 'second', monthlyPremium: 999 },
      ],
    };
    const r = resolveEnrollmentWizardProductPricingSlice('p1', {}, product);
    expect(r?.monthlyPremium).toBe(42);
    expect(r?.configValue).toBe('first');
  });

  it('respects wizard selectedConfigs over first variation order', () => {
    const product: EnrollmentPricingProductRow = {
      productId: 'p1',
      pricingVariations: [
        { configValue: 'first', monthlyPremium: 42 },
        { configValue: 'second', displayPremium: 77 },
      ],
    };
    const r = resolveEnrollmentWizardProductPricingSlice('p1', { p1: 'second' }, product);
    expect(r?.monthlyPremium).toBe(77);
  });

  it('falls back to product.displayPremium when selected variation token does not match any row', () => {
    const product: EnrollmentPricingProductRow = {
      productId: 'p1',
      displayPremium: 300,
      monthlyPremium: 1,
      pricingVariations: [{ configValue: 'only-this', monthlyPremium: 50 }],
    };
    const r = resolveEnrollmentWizardProductPricingSlice('p1', { p1: 'bogus' }, product);
    expect(r?.monthlyPremium).toBe(300);
    expect(r?.configValue).toBeUndefined();
  });

  it('uses product.displayPremium when there are no pricingVariations', () => {
    const product: EnrollmentPricingProductRow = {
      productId: 'p1',
      displayPremium: 88,
    };
    expect(resolveEnrollmentWizardProductPricingSlice('p1', {}, product)?.monthlyPremium).toBe(88);
  });

  it('bundle with zero includedProducts is not bundled as multi-line — pricingVariations still apply', () => {
    const product: EnrollmentPricingProductRow = {
      productId: 'weird-bundle',
      isBundle: true,
      includedProducts: [],
      pricingVariations: [{ configValue: 'A', displayPremium: 9 },
        { configValue: 'B', displayPremium: 11 }],
    };
    const r = resolveEnrollmentWizardProductPricingSlice('weird-bundle', {}, product);
    expect(r?.monthlyPremium).toBe(9);
  });
});

describe('syncBundleDefaultConfigIntoSelectedConfigs', () => {
  it('copies resolver configValue into empty selectedConfigs for bundle-with-included-products', () => {
    const product: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      isBundle: true,
      defaultConfig: 'D',
      includedProducts: [{ pricingVariations: [{ configValue: 'D', displayPremium: 1 }] }],
    };
    const slice = resolveEnrollmentWizardProductPricingSlice(BUNDLE_ID, {}, product);
    const configs: Record<string, string> = {};
    syncBundleDefaultConfigIntoSelectedConfigs(configs, BUNDLE_ID, slice, product);
    expect(configs[BUNDLE_ID]).toBe('D');
  });

  it('does nothing when wizard already chose a bundle config', () => {
    const product: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      isBundle: true,
      includedProducts: [{ pricingVariations: [{ configValue: 'D', displayPremium: 1 }] }],
    };
    const slice = resolveEnrollmentWizardProductPricingSlice(BUNDLE_ID, { [BUNDLE_ID]: 'D' }, product);
    const configs: Record<string, string> = { [BUNDLE_ID]: 'D' };
    syncBundleDefaultConfigIntoSelectedConfigs(configs, BUNDLE_ID, slice, product);
    expect(configs[BUNDLE_ID]).toBe('D');
  });
});

describe('submit payload helpers', () => {
  it('buildIndividualFrontendPricingSubmitRows aligns monthlyPremium sum with iterative resolver', () => {
    const bundle: EnrollmentPricingProductRow = {
      productId: BUNDLE_ID,
      isBundle: true,
      defaultConfig: 'EmpOnly',
      includedProducts: [
        { pricingVariations: [{ configValue: 'EmpOnly', displayPremium: 10 }] },
      ],
    };
    const stand: EnrollmentPricingProductRow = {
      productId: 'stand',
      pricingVariations: [{ configValue: 'x', displayPremium: 5 }],
    };
    const selected: Record<string, string> = {};
    const rows = buildIndividualFrontendPricingSubmitRows([BUNDLE_ID, 'stand'], selected, [bundle, stand], {
      [BUNDLE_ID]: 'Test Bundle',
      stand: 'Solo',
    });
    expect(selected[BUNDLE_ID]).toBe('EmpOnly');
    expect(rows.map((x) => x.monthlyPremium).reduce((a, b) => a + b, 0)).toBe(15);
    expect(sumFrontendPricingMonthlyRounded(rows)).toBe(15);
  });

  it('productNameMapFromEnrollmentSections merges section products', () => {
    expect(
      productNameMapFromEnrollmentSections([
        { products: [{ productId: 'a', productName: 'A' }] },
        { products: [{ productId: 'b', productName: 'B' }] },
      ]),
    ).toEqual({ a: 'A', b: 'B' });
  });

  it('traceIndividualFrontendPricingSubmit records failure when pricing row missing (GUID casing)', () => {
    const pid = '8941BEE7-FAD0-4027-B234-D3331603E053';
    const product: EnrollmentPricingProductRow = {
      productId: pid.toLowerCase(),
      pricingVariations: [{ configValue: '5000', displayPremium: 299.25 }],
    };
    const { rows, traces } = traceIndividualFrontendPricingSubmit(
      [pid],
      { [pid]: '5000' },
      [product],
      { [pid]: 'CoPay' },
    );
    expect(rows[0].monthlyPremium).toBe(299.25);
    expect(traces[0].pricingRowMatchedBy).toBe('caseInsensitive');
    expect(traces[0].failureReason).toBeNull();
  });

  it('traceIndividualFrontendPricingSubmit records failure when config variation missing', () => {
    const pid = 'prod-1';
    const product: EnrollmentPricingProductRow = {
      productId: pid,
      pricingVariations: [{ configValue: '1500', displayPremium: 100 }],
    };
    const { rows, traces } = traceIndividualFrontendPricingSubmit(
      [pid],
      { [pid]: '5000' },
      [product],
      {},
    );
    expect(rows[0].monthlyPremium).toBe(0);
    expect(traces[0].failureReason).toContain('no_pricing_variation_for_config_5000');
  });
});

/**
 * Regression: MightyWELL Health Concierge Membership Bundle (production 2026-05-13).
 *
 * `PRICING_VALIDATION_FAILED`: Frontend **$501.00** vs Backend **$503.00** at complete-enrollment
 * when frontend used a mismatched bundle UA vs backend-aligned Silver line items.
 *
 * Fixture numbers illustrate the observed **$2** gap (Bronze sums 249+252, Silver sums 251+252).
 */
describe('Regression: duplicate internal pricing rows without wizard config (GetWell Dental EE)', () => {
  const GETWELL_DENTAL_ID = '1D5DA922-31E6-401D-8346-D3340FDC4294';

  it('uses top-level displayPremium when hasConfigurationFields is false', () => {
    const product: EnrollmentPricingProductRow = {
      productId: GETWELL_DENTAL_ID,
      tierType: 'EE',
      hasConfigurationFields: false,
      availableConfigs: [],
      displayPremium: 42.08,
      monthlyPremium: 42.08,
      pricingVariations: [
        { configValue: 'Default', displayPremium: 40.72, monthlyPremium: 42.08 },
        { configValue: 'Default', displayPremium: 40.72, monthlyPremium: 40.72 },
      ],
    };
    const r = resolveEnrollmentWizardProductPricingSlice(GETWELL_DENTAL_ID, {}, product);
    expect(r?.monthlyPremium).toBe(42.08);
  });
});

describe('Regression: MightyWELL Health Concierge Membership Bundle IDs + amounts', () => {
  const MIGHTYWELL_CONCIERGE_BUNDLE_ID = '96EB6D03-79AA-438D-B0BD-BB49E26A1D50';

  function conciergeBundleLikeProduct(): EnrollmentPricingProductRow {
    return {
      productId: MIGHTYWELL_CONCIERGE_BUNDLE_ID,
      isBundle: true,
      tierType: 'ES',
      defaultConfig: 'Silver',
      includedProducts: [
        {
          productId: 'included-a',
          pricingVariations: [
            { configValue: 'Bronze', displayPremium: 249 },
            { configValue: 'Silver', displayPremium: 251 },
          ],
        },
        {
          productId: 'included-b',
          pricingVariations: [
            { configValue: 'Bronze', displayPremium: 252 },
            { configValue: 'Silver', displayPremium: 252 },
          ],
        },
      ],
    };
  }

  it('Silver via defaultConfig matches backend-style total ($503)', () => {
    const r = resolveEnrollmentWizardProductPricingSlice(MIGHTYWELL_CONCIERGE_BUNDLE_ID, {}, conciergeBundleLikeProduct());
    expect(r?.monthlyPremium).toBe(503);
    expect(r?.configValue).toBe('Silver');
  });

  it('Bronze selection yields $501 — documents the drift class from the incident', () => {
    const r = resolveEnrollmentWizardProductPricingSlice(
      MIGHTYWELL_CONCIERGE_BUNDLE_ID,
      { [MIGHTYWELL_CONCIERGE_BUNDLE_ID]: 'Bronze' },
      conciergeBundleLikeProduct(),
    );
    expect(r?.monthlyPremium).toBe(501);
  });

  it('individual submit row syncs Silver into selectedConfigs and sends $503 monthlyPremium', () => {
    const selected: Record<string, string> = {};
    const rows = buildIndividualFrontendPricingSubmitRows(
      [MIGHTYWELL_CONCIERGE_BUNDLE_ID],
      selected,
      [conciergeBundleLikeProduct()],
      { [MIGHTYWELL_CONCIERGE_BUNDLE_ID]: 'MightyWELL Health Concierge Membership Bundle' },
    );
    expect(selected[MIGHTYWELL_CONCIERGE_BUNDLE_ID]).toBe('Silver');
    expect(rows[0]?.monthlyPremium).toBe(503);
    expect(rows[0]?.selectedConfig).toBe('Silver');
  });
});
