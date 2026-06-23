'use strict';

const sharewellDefaults = require('../sharewellDefaultImportPresets');
const alignPresets = require('../sharewellDefaultImportPresets');
const {
  normalizeImportRules,
  tobaccoStatusFromImportRow,
  deriveTierUaImportKeyFromPlanCodeWithRules,
  planKeyFromImportRules,
  productIdKeyFromImportRules,
  buildEffectiveImportRules,
  evalProductMatch,
  resolveProductsForRow,
  usesMultiProductResolver,
  normalizeHouseholdMemberIdForGrouping,
} = require('../vendorImportRules');

describe('vendorImportRules', () => {
  const alignRules = sharewellDefaults.ALIGN_IMPORT_RULES;

  test('tobacco yesValues from format rules (Align 100)', () => {
    expect(tobaccoStatusFromImportRow({ 'Tobacco Surcharge': '100' }, alignRules)).toBe('Yes');
    expect(tobaccoStatusFromImportRow({ 'Tobacco Surcharge': '' }, alignRules)).toBe('No');
  });

  test('uaRelabel applies only when rules configured', () => {
    expect(
      deriveTierUaImportKeyFromPlanCodeWithRules('11321_AH3000ES', alignRules),
    ).toBe('ES_2500');
    expect(
      deriveTierUaImportKeyFromPlanCodeWithRules('11321_AH3000ES', null),
    ).toBe('ES_3000');
  });

  test('buildEffectiveImportRules uses first-class tobacco columns on preset', () => {
    const rules = buildEffectiveImportRules({
      importRules: normalizeImportRules({ planKey: { uaRelabel: [] } }),
      tobaccoCsvColumn: 'Tobacco Surcharge',
      tobaccoYesValues: ['100'],
    });
    expect(tobaccoStatusFromImportRow({ 'Tobacco Surcharge': '100' }, rules)).toBe('Yes');
  });

  test('normalizeImportRules merges defaults', () => {
    const r = normalizeImportRules({ tobacco: { yesValues: ['100'] } });
    expect(r.tobacco.yesValues).toEqual(['100']);
    expect(r.tobacco.columns.length).toBeGreaterThan(0);
  });

  test('planKeyFromImportRules uses composite strategy without bare product id fallback', () => {
    expect(
      planKeyFromImportRules(
        { ABProductID: '11321', ABBenefitIdOverride: 'AH1500FM', 'Coverage Tier': 'FM' },
        alignRules,
      ),
    ).toBe('11321_AH1500FM');
    expect(
      planKeyFromImportRules(
        { Product_ID: '11321', Benefit_ID: 'AH1500EE', 'Coverage Tier': 'EE', 'Deductible IUA': '1500' },
        alignRules,
      ),
    ).toBe('EE_1500');
  });

  test('planKeyFromImportRules does not return product id when composite segment missing', () => {
    expect(
      planKeyFromImportRules({ ABProductID: '11321', 'Coverage Tier': 'EE', UA: '1500' }, alignRules),
    ).toBe('EE_1500');
    expect(planKeyFromImportRules({ ABProductID: '11321' }, alignRules)).toBe('');
  });

  test('productIdKeyFromImportRules reads Product_ID when productSource.mode is fields', () => {
    expect(
      productIdKeyFromImportRules(
        { Product_ID: '46521', Benefit_ID: '9376' },
        alignRules,
      ),
    ).toBe('46521');
  });

  test('productIdKeyFromImportRules empty when productSource.mode is none', () => {
    const rules = normalizeImportRules({
      planKey: { productSource: { mode: 'none', fields: 'Product_ID' } },
    });
    expect(productIdKeyFromImportRules({ Product_ID: '11321' }, rules)).toBe('');
  });

  test('evalProductMatch fieldNonBlank', () => {
    expect(
      evalProductMatch({ 'Medical Option': 'MightyWELL Health' }, { mode: 'fieldNonBlank', field: 'Medical Option' }),
    ).toBe(true);
    expect(
      evalProductMatch({ 'Medical Option': '' }, { mode: 'fieldNonBlank', field: 'Medical Option' }),
    ).toBe(false);
  });

  test('resolveProductsForRow multi-product MightyWELL-style', () => {
    const rules = normalizeImportRules({
      products: [
        {
          id: 'med',
          label: 'Medical',
          targetProductId: null,
          match: { mode: 'fieldNonBlank', field: 'Medical Option' },
          keyStrategy: { type: 'planCode', strategies: ['planCode'], planCodeFields: 'Medical Option' },
        },
        {
          id: 'den',
          label: 'Dental',
          targetProductId: null,
          match: { mode: 'fieldNonBlank', field: 'Dental Option' },
          keyStrategy: { type: 'planCode', strategies: ['planCode'], planCodeFields: 'Dental Option' },
        },
      ],
    });
    expect(usesMultiProductResolver(rules)).toBe(true);
    const row = {
      'Medical Option': 'EE_1500',
      'Dental Option': 'ES_2500',
    };
    const hits = resolveProductsForRow(row, rules);
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.label)).toEqual(expect.arrayContaining(['Medical', 'Dental']));
  });

  test('resolveProductsForRow uses align preset products', () => {
    const rules = alignPresets.ALIGN_IMPORT_RULES;
    expect(usesMultiProductResolver(rules)).toBe(true);
    const key = resolveProductsForRow(
      {
        Product_ID: '11321',
        Benefit_ID: 'AH1500EE',
        'Coverage Tier': 'EE',
        'Deductible IUA': '1500',
      },
      rules,
    );
    expect(key.length).toBe(1);
    expect(key[0].key).toBe('EE_1500');
  });

  test('legacy path when products array empty', () => {
    const rules = normalizeImportRules({ products: [] });
    expect(usesMultiProductResolver(rules)).toBe(false);
    expect(
      planKeyFromImportRules(
        { 'Plan Tier': 'EE', UA: '1500', 'Plan Name': 'EE_1500' },
        rules,
      ),
    ).toBe('EE_1500');
  });

  test('resolveProductsForRow MPB combines Plan_Tier and UA when plan code is tier-only', () => {
    const rules = sharewellDefaults.MPB_IMPORT_RULES;
    const hits = resolveProductsForRow(
      {
        'Product Name': 'EF',
        Plan_Tier: 'EF',
        UA: '1500',
        Tobacco_Surcharge: 'No',
      },
      rules,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('EF_1500');
    expect(hits[0].targetProductId).toBe(sharewellDefaults.ESSENTIAL_2025_PRODUCT_ID);
  });

  test('normalizeHouseholdMemberIdForGrouping uses suffixStripPatterns from import rules', () => {
    const rules = sharewellDefaults.MPB_IMPORT_RULES;
    expect(normalizeHouseholdMemberIdForGrouping('87499409D1', rules)).toBe('87499409');
    expect(normalizeHouseholdMemberIdForGrouping('MPB73291609A', rules)).toBe('MPB73291609');
    expect(normalizeHouseholdMemberIdForGrouping('T685410196', rules)).toBe('T685410196');
  });

  test('MPB tobacco Yes/No from Tobacco_Surcharge column', () => {
    const rules = buildEffectiveImportRules({
      importRules: sharewellDefaults.MPB_IMPORT_RULES,
      tobaccoCsvColumn: 'Tobacco_Surcharge',
      tobaccoYesValues: ['Yes'],
    });
    expect(tobaccoStatusFromImportRow({ Tobacco_Surcharge: 'Yes' }, rules)).toBe('Yes');
    expect(tobaccoStatusFromImportRow({ Tobacco_Surcharge: 'No' }, rules)).toBe('No');
  });
});
