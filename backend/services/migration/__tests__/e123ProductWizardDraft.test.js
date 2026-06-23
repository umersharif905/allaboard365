'use strict';

const {
  inferProductType,
  inferSalesType,
  inferAllowedStates,
  resolveVendorId,
  buildPricingTiers,
  buildPricingTiersFromSnapshot,
  mergePricingTiers,
  mergeCatalogEntries,
  allocationFromSnapshotDerivedRow,
  dedupeDerivedTierRows,
  prepareDerivedTiersForWizard,
  dedupeSnapshotAgeBands,
  resolveSnapshotTierCode,
  resolveBenefitTierCode,
  collectUnsharedAmounts,
  requiresTobaccoFromTiers,
  shouldUseTobaccoPricing,
  inferE123TobaccoPricingRecommendation,
  inferDefaultEffectiveDate,
  splitTobaccoRates,
  buildConfigurationFields,
  buildProductDescription,
  buildE123DraftOverrides,
  mergeWizardDraftFormData,
  buildMigrationAiChunks,
  stripHtmlForText,
  detectE123ProductComposition
} = require('../e123ProductWizardDraft.service');
const { parseTierFromLabel } = require('../e123TierInference');
const { parseRateRows } = require('../e123Rates.service');

describe('e123ProductWizardDraft', () => {
  test('inferProductType maps ShareWELL labels to Healthcare', () => {
    expect(inferProductType('Essential (ShareWELL)', 'Health Share')).toBe('Healthcare');
    expect(inferProductType('GetWell Dental', null)).toBe('Dental');
  });

  test('resolveVendorId prefers underwriter name match', () => {
    const result = resolveVendorId([
      { vendorId: 'a', vendorName: 'ShareWELL Partners' },
      { vendorId: 'b', vendorName: 'Other Vendor' }
    ], { underwriter: 'ShareWELL', label: 'Essential (ShareWELL)' });
    expect(result.vendorId).toBe('a');
  });

  test('collectUnsharedAmounts merges catalog and migration hints', () => {
    const catalog = new Map([
      ['1', { benefitId: '1', tier: 'EE', unsharedAmount: 1500 }],
      ['2', { benefitId: '2', tier: 'EE', unsharedAmount: 3000 }]
    ]);
    const tiers = [{ feeHints: { unsharedAmount: 6000 } }];
    expect(collectUnsharedAmounts(catalog, tiers)).toEqual(['1500', '3000', '6000']);
  });

  test('shouldUseTobaccoPricing requires both tobacco and non-tobacco members', () => {
    expect(shouldUseTobaccoPricing([
      { tobaccoCounts: { yes: 2, no: 3, unknown: 0 } }
    ], null)).toBe(true);
    expect(shouldUseTobaccoPricing([
      { tobaccoCounts: { yes: 2, no: 0, unknown: 0 } }
    ], null)).toBe(false);
    expect(shouldUseTobaccoPricing([], {
      rows: [{ nonTobaccoRate: 220, tobaccoRate: 294 }]
    })).toBe(true);
  });

  test('shouldUseTobaccoPricing detects premium spread on same E123 benefit', () => {
    expect(shouldUseTobaccoPricing([
      {
        tobaccoCounts: { yes: 0, no: 0, unknown: 50 },
        feeAmountStats: { min: 220, max: 294, median: 220, sampleSize: 50 }
      }
    ], null)).toBe(true);
    expect(shouldUseTobaccoPricing([
      {
        tobaccoCounts: { yes: 0, no: 0, unknown: 297 },
        feeAmountStats: { min: 220, max: 220, median: 220, sampleSize: 297 }
      }
    ], null)).toBe(false);
  });

  test('requiresTobaccoFromTiers delegates to shouldUseTobaccoPricing', () => {
    expect(requiresTobaccoFromTiers([{ tobaccoCounts: { yes: 1, no: 1, unknown: 0 } }])).toBe(true);
    expect(requiresTobaccoFromTiers([{ tobaccoCounts: { yes: 1, no: 0, unknown: 0 } }])).toBe(false);
  });

  test('inferE123TobaccoPricingRecommendation uses GetRates tobacco surcharge', () => {
    const rec = inferE123TobaccoPricingRecommendation([], {
      rows: [{ benefitLabel: 'Member Only', nonTobaccoRate: 220, tobaccoRate: 294 }]
    });
    expect(rec.recommended).toBe(true);
    expect(rec.confidence).toBe('high');
    expect(rec.rateGridTobaccoPairs).toBe(1);
    expect(rec.summary).toMatch(/GetRates/i);
  });

  test('inferE123TobaccoPricingRecommendation recommends skip when rates match', () => {
    const rec = inferE123TobaccoPricingRecommendation(
      [{ tobaccoCounts: { yes: 0, no: 12, unknown: 0 } }],
      { rows: [{ benefitLabel: 'Member Only', nonTobaccoRate: 220, tobaccoRate: 220 }] }
    );
    expect(rec.recommended).toBe(false);
    expect(rec.reasonsAgainst.some((reason) => /same premium/i.test(reason))).toBe(true);
  });

  test('inferDefaultEffectiveDate uses enrollment stats then household dates', () => {
    expect(inferDefaultEffectiveDate([], { sourceProductKey: '1' }, {
      enrollmentStats: { effectiveDateRange: { min: '2024-03-01' } }
    })).toBe('2024-03-01');

    expect(inferDefaultEffectiveDate([
      { products: [{ pdid: '45315', dteffective: '2023-06-15' }] }
    ], '45315', {})).toBe('2023-06-15');
  });

  test('splitTobaccoRates prefers E123 rate API values', () => {
    expect(splitTobaccoRates(null, { nonTobaccoRate: 220, tobaccoRate: 294 })).toEqual({
      no: 220,
      yes: 294
    });
  });

  test('buildConfigurationFields preserves template field name when UA options exist', () => {
    const fields = buildConfigurationFields(['1500', '3000'], [{
      id: 'abc',
      fieldName: 'Unshared Amount $',
      fieldOptions: ['9999'],
      isDeductible: true
    }]);
    expect(fields[0].fieldName).toBe('Unshared Amount $');
    expect(fields[0].fieldOptions).toEqual(['1500', '3000']);
  });

  test('buildPricingTiers uses N/A tobacco and effective date when tobacco not used', () => {
    const catalog = new Map([
      ['9392', { benefitId: '9392', tier: 'EE', unsharedAmount: 1500, benefitName: 'EE 1500' }]
    ]);
    const migrationTiers = [{
      sourceBenefitKey: '9392',
      resolvedTier: 'EE',
      feeAmountStats: { median: 220, sampleSize: 10 },
      feeHints: { unsharedAmount: 1500 },
      tobaccoCounts: { yes: 0, no: 10, unknown: 0 }
    }];
    const { pricingTiers: tiers } = buildPricingTiers({
      catalogBenefits: catalog,
      migrationTiers,
      useTobaccoPricing: false,
      ageRange: { min: 33, max: 51 },
      configFieldName: 'Unshared Amount $',
      unsharedAmounts: ['1500'],
      rateGrid: { byBenefit: new Map(), rows: [] },
      defaultEffectiveDate: '2022-01-01',
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Healthcare' }
    });
    expect(tiers).toHaveLength(1);
    expect(tiers[0].ageBands).toHaveLength(1);
    expect(tiers[0].ageBands[0].tobaccoStatus).toBe('N/A');
    expect(tiers[0].ageBands[0].effectiveDate).toBe('2022-01-01');
    expect(tiers[0].ageBands[0].minAge).toBe(33);
    expect(tiers[0].ageBands[0].maxAge).toBe(51);
  });

  test('buildPricingTiers creates paired No/Yes rows when tobacco pricing is used', () => {
    const catalog = new Map([
      ['9392', { benefitId: '9392', tier: 'EE', unsharedAmount: 1500, benefitName: 'EE 1500' }]
    ]);
    const migrationTiers = [{
      sourceBenefitKey: '9392',
      resolvedTier: 'EE',
      feeAmountStats: { median: 220, sampleSize: 10 },
      tobaccoCounts: { yes: 2, no: 8, unknown: 0 }
    }];
    const { pricingTiers: tiers } = buildPricingTiers({
      catalogBenefits: catalog,
      migrationTiers,
      useTobaccoPricing: true,
      ageRange: { min: 18, max: 64 },
      configFieldName: 'Unshared Amount $',
      unsharedAmounts: ['1500'],
      rateGrid: {
        byBenefit: new Map([
          ['9392', { benefitId: '9392', nonTobaccoRate: 225, tobaccoRate: 300 }]
        ]),
        rows: [{ nonTobaccoRate: 225, tobaccoRate: 300 }]
      },
      defaultEffectiveDate: '2024-01-01',
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Healthcare' }
    });
    expect(tiers[0].ageBands).toHaveLength(2);
    expect(tiers[0].ageBands.map((b) => b.tobaccoStatus).sort()).toEqual(['No', 'Yes']);
    expect(tiers[0].ageBands.every((b) => b.effectiveDate === '2024-01-01')).toBe(true);
  });

  test('inferSalesType maps E123 catalog category', () => {
    expect(inferSalesType('Group Product')).toBe('Group');
    expect(inferSalesType('Individual Product')).toBe('Individual');
    expect(inferSalesType('Health Share')).toBe('Both');
  });

  test('inferAllowedStates selects all states when no no-sale list', () => {
    expect(inferAllowedStates(null)).toHaveLength(50);
    expect(inferAllowedStates({})).toHaveLength(50);
  });

  test('inferAllowedStates excludes E123 no-sale states', () => {
    const states = inferAllowedStates({ noSaleStates: 'VT,WA' });
    expect(states).not.toContain('VT');
    expect(states).not.toContain('WA');
    expect(states).toContain('FL');
  });

  test('parseTierFromLabel maps BCS benefit labels', () => {
    expect(parseTierFromLabel('Member Only')).toBe('EE');
    expect(parseTierFromLabel('Member + Spouse')).toBe('ES');
    expect(parseTierFromLabel('Member + Child(ren)')).toBe('EC');
    expect(parseTierFromLabel('Family ')).toBe('EF');
  });

  test('buildPricingTiers creates all catalog tiers for BCS Accident benefits', () => {
    const catalog = new Map([
      ['9375', { benefitId: '9375', benefitName: 'Member Only', tier: 'EE', unsharedAmount: null }],
      ['9376', { benefitId: '9376', benefitName: 'Member + Spouse', tier: 'ES', unsharedAmount: null }],
      ['9377', { benefitId: '9377', benefitName: 'Member + Child(ren)', tier: 'EC', unsharedAmount: null }],
      ['9378', { benefitId: '9378', benefitName: 'Family ', tier: 'EF', unsharedAmount: null }]
    ]);
    const migrationTiers = [{
      sourceBenefitKey: '9375',
      sourceBenefitLabel: 'Member Only',
      feeAmountStats: { median: 20, sampleSize: 5 },
      tobaccoCounts: { yes: 0, no: 5, unknown: 0 }
    }, {
      sourceBenefitKey: '9378',
      sourceBenefitLabel: 'Family ',
      feeAmountStats: { median: 35, sampleSize: 3 },
      tobaccoCounts: { yes: 0, no: 3, unknown: 0 }
    }];
    const { pricingTiers: tiers } = buildPricingTiers({
      catalogBenefits: catalog,
      migrationTiers,
      useTobaccoPricing: false,
      ageRange: { min: 18, max: 64 },
      configFieldName: '',
      unsharedAmounts: [],
      rateGrid: { byBenefit: new Map(), rows: [] },
      defaultEffectiveDate: '2024-01-01',
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Accident' }
    });
    expect(tiers.map((tier) => tier.tierType)).toEqual(['EE', 'ES', 'EC', 'EF']);
  });

  test('buildPricingTiers maps migration benefit labels without catalog', () => {
    const { pricingTiers: tiers } = buildPricingTiers({
      catalogBenefits: new Map(),
      migrationTiers: [{
        sourceBenefitKey: '9375',
        sourceBenefitLabel: 'Member Only',
        inferredMemberTier: 'EF',
        feeAmountStats: { median: 20, sampleSize: 2 },
        tobaccoCounts: { yes: 0, no: 2, unknown: 0 }
      }, {
        sourceBenefitKey: '9376',
        sourceBenefitLabel: 'Member + Spouse',
        inferredMemberTier: 'EF',
        feeAmountStats: { median: 28, sampleSize: 1 },
        tobaccoCounts: { yes: 0, no: 1, unknown: 0 }
      }],
      useTobaccoPricing: false,
      ageRange: { min: 18, max: 64 },
      configFieldName: '',
      unsharedAmounts: [],
      rateGrid: { byBenefit: new Map(), rows: [] },
      defaultEffectiveDate: '2024-01-01',
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Accident' }
    });
    expect(tiers.map((tier) => tier.tierType).sort()).toEqual(['EE', 'ES']);
    expect(resolveBenefitTierCode({
      sourceBenefitLabel: 'Member + Spouse',
      inferredMemberTier: 'EF'
    })).toBe('ES');
  });

  test('stripHtmlForText converts catalog HTML to plain text', () => {
    expect(stripHtmlForText('<p>Health Share<br><strong>Important</strong></p>'))
      .toBe('Health Share\nImportant');
  });

  test('buildProductDescription uses template copy and strips migration notes from user-facing text', () => {
    expect(buildProductDescription({
      catalogEntry: { description: '<p>Catalog text</p>' },
      template: { formData: { description: 'Member-facing plan overview from AB365.' } }
    })).toBe('Member-facing plan overview from AB365.');

    expect(buildProductDescription({
      catalogEntry: { description: '<p>Catalog text</p>' },
      template: null
    })).toBe('Catalog text');

    expect(buildProductDescription({
      catalogEntry: null,
      template: null
    })).toBe('');
  });

  test('mergeWizardDraftFormData preserves step 1 and 2 fields when copying a template', () => {
    const templateForm = {
      vendorId: 'apex-vendor',
      isVendorPricing: true,
      vendorCommission: 12.5,
      vendorGroupIdProductType: '1',
      eligibilityIndividualVendorGroupId: '90500',
      eligibilityVendorGroupFallbackProductId: 'fallback-product',
      showGroupIdOnIDCard: true,
      description: 'Member-facing copay overview.',
      productType: 'Healthcare',
      salesType: 'Group',
      minAge: 18,
      maxAge: 64,
      allowedStates: ['FL', 'GA'],
      effectiveDateLogic: 'FirstOfMonth',
      maxEffectiveDateDays: 90,
      terminationLogic: 'EndOfMonth',
      requiredLicenses: ['Life'],
      isSSNRequired: true,
      premiumReportingCategory: 'NonProfit',
      includeProcessingFee: true,
      roundUpProcessingFee: false,
      processingFeePercentage: 3,
      requiresTobaccoInfo: false,
      pricingTiers: [{ id: 'old-tier', tierType: 'EE', ageBands: [] }],
      aiChunks: [{ id: 'chunk-1', chunk_text: 'Template chunk', created_at: '2026-01-01T00:00:00.000Z' }]
    };

    const e123Overrides = buildE123DraftOverrides({
      sourceProductKey: '45173',
      label: 'eBenefits Copay MEC',
      tenantId: 'tenant-id',
      pricingTiers: [{ id: 'new-tier', tierType: 'EE', ageBands: [] }],
      configurationFields: [{ id: 'cfg', fieldName: 'Unshared Amount $', fieldOptions: ['1500'], isDeductible: true }],
      useTobaccoPricing: true,
      template: { formData: templateForm },
      migrationAiChunks: [{ id: 'chunk-2', chunk_text: 'Migration meta', created_at: '2026-01-02T00:00:00.000Z' }]
    });

    const merged = mergeWizardDraftFormData({
      template: { formData: templateForm },
      e123Overrides,
      emptyWizardDefaults: { salesType: 'Both', vendorGroupIdProductType: '' }
    });

    expect(merged.name).toBe('eBenefits Copay MEC');
    expect(merged.partNumber).toBe('E123-45173');
    expect(merged.pricingTiers).toEqual([{ id: 'new-tier', tierType: 'EE', ageBands: [] }]);
    expect(merged.isHidden).toBe(true);
    expect(merged.requiresTobaccoInfo).toBe(false);
    expect(merged.vendorId).toBe('apex-vendor');
    expect(merged.vendorGroupIdProductType).toBe('1');
    expect(merged.eligibilityIndividualVendorGroupId).toBe('90500');
    expect(merged.eligibilityVendorGroupFallbackProductId).toBe('fallback-product');
    expect(merged.showGroupIdOnIDCard).toBe(true);
    expect(merged.isVendorPricing).toBe(true);
    expect(merged.vendorCommission).toBe(12.5);
    expect(merged.salesType).toBe('Group');
    expect(merged.description).toBe('Member-facing copay overview.');
    expect(merged.productType).toBe('Healthcare');
    expect(merged.allowedStates).toEqual(['FL', 'GA']);
    expect(merged.effectiveDateLogic).toBe('FirstOfMonth');
    expect(merged.maxEffectiveDateDays).toBe(90);
    expect(merged.premiumReportingCategory).toBe('NonProfit');
    expect(merged.includeProcessingFee).toBe(true);
    expect(merged.aiChunks).toHaveLength(2);
  });

  test('buildMigrationAiChunks keeps migration metadata out of product description', () => {
    const chunks = buildMigrationAiChunks({
      label: 'Essential (Sharewell)',
      sourceProductKey: '45042',
      catalogEntry: {
        underwriter: 'Sharewell',
        description: '<p>A membership with a Non-profit Health Share.</p>'
      },
      category: 'Individual Product',
      group: {
        memberCount: 120,
        enrollmentStats: { enrollmentSummaryLabel: 'Enrolled Dec 10, 2025 · Effective Jan 1, 2026 · 1 active' }
      },
      migrationTiers: [{ resolvedTier: 'EE' }],
      templateName: 'MightyWELL CoPay',
      rateGrid: { rows: [] }
    });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((chunk) => typeof chunk.chunk_text === 'string')).toBe(true);
    expect(chunks[0].chunk_text).toContain('Essential (Sharewell)');
    expect(chunks[0].chunk_text).toContain('Non-profit Health Share');
    expect(chunks[1].chunk_text).toContain('E123 pdid: 45042');
    expect(chunks[1].chunk_text).toContain('Enrolled Dec 10, 2025');
    expect(chunks[1].chunk_text).not.toContain('Review notes');
  });

  test('buildPricingTiers copies net and commission from MSRP reference match', () => {
    const catalog = new Map([
      ['9392', { benefitId: '9392', tier: 'EE', unsharedAmount: 1500, benefitName: 'Member Only $1500 UA' }]
    ]);
    const migrationTiers = [{
      sourceBenefitKey: '9392',
      resolvedTier: 'EE',
      feeAmountStats: { median: 220, sampleSize: 10 },
      tobaccoCounts: { yes: 0, no: 10, unknown: 0 }
    }];
    const { pricingTiers: tiers } = buildPricingTiers({
      catalogBenefits: catalog,
      migrationTiers,
      useTobaccoPricing: false,
      ageRange: { min: 18, max: 64 },
      configFieldName: 'Unshared Amount $',
      unsharedAmounts: ['1500'],
      rateGrid: { byBenefit: new Map(), rows: [] },
      defaultEffectiveDate: '2024-01-01',
      pricingContext: {
        referenceRows: [{
          tierType: 'EE',
          configValue1: '1500',
          tobaccoStatus: 'No',
          netRate: 194,
          overrideRate: 0,
          commission: 26,
          msrpRate: 220
        }],
        templateRows: [],
        productType: 'Healthcare'
      }
    });
    expect(tiers[0].ageBands[0].msrpRate).toBe(220);
    expect(tiers[0].ageBands[0].netRate).toBe(194);
    expect(tiers[0].ageBands[0].commission).toBe(26);
  });

  test('parseRateRows filters enrollment fees', () => {
    const rows = parseRateRows({
      RATES: [
        { BENEFITID: 1, BENEFITLABEL: 'EE', RATE: 220, TYPE: 'Product' },
        { BENEFITID: '', BENEFITLABEL: '', RATE: 50, TYPE: 'Enrollment' }
      ]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].rate).toBe(220);
  });

  test('mergeCatalogEntries prefers CSV snapshot label and category', () => {
    const merged = mergeCatalogEntries(
      { label: 'Essential ShareWELL', category: 'Health Share', noSaleStates: 'NY,CA' },
      { label: 'Legacy Label', category: 'Old', underwriter: 'ShareWELL', active: true }
    );
    expect(merged.label).toBe('Essential ShareWELL');
    expect(merged.category).toBe('Health Share');
    expect(merged.underwriter).toBe('ShareWELL');
    expect(merged.noSaleStates).toBe('NY,CA');
  });

  test('buildPricingTiersFromSnapshot uses CSV net override commission splits', () => {
    const snapshot = {
      derivedTiers: [{
        tierCode: 'EE',
        benefitLabel: 'Member Only 1500',
        benefitId: 9392,
        memberAgeMin: 18,
        memberAgeMax: 64,
        msrpRate: 220,
        netRate: 168,
        overrideRate: 26,
        commission: 26,
        otherFees: 0,
        displayStart: '01/01/2026',
        vendorBreakdown: [
          { bucket: 'net', amount: 168 },
          { bucket: 'override', amount: 26 }
        ]
      }],
      pricingMatrix: [{ benefitId: 9392, commissionableAmount: 26 }]
    };
    const { pricingTiers } = buildPricingTiersFromSnapshot({
      snapshot,
      useTobaccoPricing: false,
      defaultEffectiveDate: '2026-01-01',
      configFieldName: 'Unshared Amount $',
      migrationTiers: [],
      rateGrid: { rows: [] },
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Healthcare' }
    });
    expect(pricingTiers).toHaveLength(1);
    expect(pricingTiers[0].tierType).toBe('EE');
    expect(pricingTiers[0].ageBands[0].netRate).toBe(168);
    expect(pricingTiers[0].ageBands[0].overrideRate).toBe(26);
    expect(pricingTiers[0].ageBands[0].commission).toBe(26);
    expect(pricingTiers[0].ageBands[0].configValue1).toBe('1500');
  });

  test('mergePricingTiers keeps richer tier data and fills missing codes', () => {
    const csvTiers = [{ tierType: 'EE', label: 'EE', ageBands: [{ minAge: 18, maxAge: 64, commission: 26 }] }];
    const apiTiers = [
      { tierType: 'EE', label: 'EE', ageBands: [{ minAge: 18, maxAge: 64, netRate: 168, overrideRate: 26, commission: 26, msrpRate: 220 }] },
      { tierType: 'EF', label: 'EF', ageBands: [{ minAge: 18, maxAge: 64, netRate: 2 }] }
    ];
    const merged = mergePricingTiers(csvTiers, apiTiers);
    expect(merged.map((t) => t.tierType)).toEqual(['EE', 'EF']);
    expect(merged[0].ageBands[0].netRate).toBe(168);
    expect(merged[1].ageBands[0].netRate).toBe(2);
  });

  test('allocationFromSnapshotDerivedRow remaps legacy Lyric and Sharewell vendor costs', () => {
    const allocation = allocationFromSnapshotDerivedRow({
      msrpRate: 180,
      netRate: 0,
      overrideRate: 0,
      commission: 0,
      otherFees: 0,
      vendorBreakdown: [
        { vendorName: 'Sharewell', bucket: 'other', amount: 20.48 },
        { vendorName: 'Sharewell Partners', bucket: 'other', amount: 11.02 },
        { vendorName: 'Lyric', bucket: 'other', amount: 3.25 }
      ]
    }, {});
    expect(allocation.netRate).toBe(20.48);
    expect(allocation.overrideRate).toBe(14.27);
    expect(allocation.commission).toBe(145.25);
  });

  test('allocationFromSnapshotDerivedRow prefers vendorBreakdown over stored net splits', () => {
    const allocation = allocationFromSnapshotDerivedRow({
      msrpRate: 535,
      netRate: 503,
      overrideRate: 0,
      commission: 32,
      otherFees: 3.25,
      vendorBreakdown: [
        { vendorName: 'Sharewell', bucket: 'other', amount: 343 },
        { vendorName: 'Sharewell Partners', bucket: 'other', amount: 11.02 },
        { vendorName: 'Lyric', bucket: 'other', amount: 3.25 }
      ]
    }, {});
    expect(allocation.netRate).toBe(343);
    expect(allocation.overrideRate).toBe(14.27);
    expect(allocation.commission).toBe(177.73);
  });

  test('dedupeSnapshotAgeBands collapses duplicate age windows with different net amounts', () => {
    const bands = dedupeSnapshotAgeBands([
      {
        minAge: 50,
        maxAge: 64,
        tobaccoStatus: 'N/A',
        configValue1: '6000',
        effectiveDate: '2026-03-01',
        terminationDate: null,
        netRate: 343,
        msrpRate: 535
      },
      {
        minAge: 50,
        maxAge: 64,
        tobaccoStatus: 'N/A',
        configValue1: '6000',
        effectiveDate: '2026-03-01',
        terminationDate: null,
        netRate: 503,
        msrpRate: 535
      }
    ], [{ resolvedTier: 'EE', feeAmountStats: { median: 535 } }], 'EE');

    expect(bands).toHaveLength(1);
    expect(bands[0].netRate).toBe(503);
  });

  test('allocationFromSnapshotDerivedRow rebuilds vendor and override splits from vendorBreakdown', () => {
    const allocation = allocationFromSnapshotDerivedRow({
      benefitId: 9392,
      msrpRate: 220,
      netRate: 0,
      overrideRate: 0,
      commission: 26,
      otherFees: 0,
      vendorBreakdown: [
        { bucket: 'net', amount: 168 },
        { bucket: 'override', amount: 26 }
      ]
    }, { pricingMatrix: [{ benefitId: 9392, commissionableAmount: 26 }] });
    expect(allocation.netRate).toBe(168);
    expect(allocation.overrideRate).toBe(26);
    expect(allocation.commission).toBe(26);
    expect(allocation.msrpRate).toBe(220);
  });

  test('dedupeDerivedTierRows keeps separate rows when effective dates differ', () => {
    const rows = dedupeDerivedTierRows([
      { tierCode: null, memberAgeMin: 18, memberAgeMax: 29, msrpRate: 12.17, displayStart: '01/01/2025' },
      { tierCode: null, memberAgeMin: 18, memberAgeMax: 29, msrpRate: 14.29, displayStart: '01/01/2026' },
      { tierCode: null, memberAgeMin: 30, memberAgeMax: 39, msrpRate: 25.25, displayStart: '01/01/2025' },
      { tierCode: null, memberAgeMin: 30, memberAgeMax: 39, msrpRate: 36.76, displayStart: '01/01/2026' }
    ], [], 'Critical Illness', 'BCS Critical Illness $20,000');

    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.memberAgeMin === 18)).toHaveLength(2);
    expect(rows.every((row) => row.tierCode === 'EE')).toBe(true);
  });

  test('detectE123ProductComposition surfaces vendor components and Lyric signals', () => {
    const composition = detectE123ProductComposition({
      label: 'Connected Wellness',
      setup: { bundleWithOtherProducts: true },
      vendorCosts: [
        { vendorName: 'Lyric' },
        { vendorName: 'ARM' }
      ],
      pricingMatrix: [
        { benefitId: 9392, benefitLabel: 'Member Only' },
        { benefitId: 9402, benefitLabel: 'Member + Spouse' }
      ],
      content: {
        documents: [{ 'Content Label': 'Lyric Telemedicine' }],
        fulfillment: [{ 'Display Label': 'Eligibility File', 'Agent ID': '782797' }]
      }
    });

    expect(composition.likelyComposite).toBe(true);
    expect(composition.hasLyricSignal).toBe(true);
    expect(composition.vendorComponents).toEqual(['Lyric', 'ARM']);
    expect(composition.benefitTiers).toHaveLength(2);
    expect(composition.bundleWithOtherProducts).toBe(true);
  });

  test('prepareDerivedTiersForWizard collapses age bands to one row per family tier and UA', () => {
    const snapshot = {
      label: 'Essential ShareWELL',
      setup: { priceByAge: false },
      vendorCosts: [
        { vendorName: 'Sharewell', amount: 126.1, benefitId: 9392, isCurrent: true },
        { vendorName: 'Sharewell Partners', amount: 67.9, benefitId: 9392, isCurrent: true }
      ],
      derivedTiers: [
        {
          tierCode: 'EE',
          benefitLabel: 'Member Only $1500 UA',
          benefitId: 9392,
          memberAgeMin: 18,
          memberAgeMax: 39,
          msrpRate: 0,
          netRate: 126.1,
          overrideRate: 67.9,
          commission: 0,
          displayStart: '01/01/2026'
        },
        {
          tierCode: 'EE',
          benefitLabel: 'Member Only $1500 UA',
          benefitId: 9393,
          memberAgeMin: 40,
          memberAgeMax: 64,
          msrpRate: 0,
          netRate: 130,
          overrideRate: 70,
          commission: 0,
          displayStart: '01/01/2026'
        },
        {
          tierCode: 'ES',
          benefitLabel: 'Member + Spouse $1500 UA',
          benefitId: 9396,
          memberAgeMin: 18,
          memberAgeMax: 64,
          msrpRate: 0,
          netRate: 200,
          overrideRate: 90,
          commission: 0,
          displayStart: '01/01/2026'
        }
      ]
    };
    const rows = prepareDerivedTiersForWizard({
      derivedTiers: snapshot.derivedTiers,
      snapshot,
      migrationTiers: [{ resolvedTier: 'EE', feeHints: { unsharedAmount: '1500' }, memberCount: 5 }],
      productType: 'Healthcare',
      snapshotLabel: snapshot.label,
      ageRange: { min: 18, max: 64 }
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tierCode).sort()).toEqual(['EE', 'ES']);
    expect(rows.every((row) => row.memberAgeMin === 18 && row.memberAgeMax === 64)).toBe(true);
  });

  test('buildPricingTiersFromSnapshot creates separate left-hand tiers per unshared amount', () => {
    const snapshot = {
      label: 'Essential ShareWELL',
      setup: { priceByAge: false },
      vendorCosts: [
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 126.1,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        },
        {
          vendorName: 'Sharewell Partners',
          vendorId: 782735,
          amount: 67.9,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        },
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 150,
          benefitId: 9400,
          benefitLabel: 'Member Only $3000 UA',
          priceTypes: 'Product',
          isCurrent: true
        },
        {
          vendorName: 'Sharewell Partners',
          vendorId: 782735,
          amount: 80,
          benefitId: 9400,
          benefitLabel: 'Member Only $3000 UA',
          priceTypes: 'Product',
          isCurrent: true
        }
      ],
      derivedTiers: [
        {
          tierCode: 'EE',
          benefitLabel: 'Member Only $1500 UA',
          benefitId: 9392,
          memberAgeMin: 18,
          memberAgeMax: 64,
          msrpRate: 0,
          netRate: 126.1,
          overrideRate: 67.9,
          commission: 0,
          displayStart: '01/01/2026'
        },
        {
          tierCode: 'EE',
          benefitLabel: 'Member Only $3000 UA',
          benefitId: 9400,
          memberAgeMin: 18,
          memberAgeMax: 64,
          msrpRate: 0,
          netRate: 150,
          overrideRate: 80,
          commission: 0,
          displayStart: '01/01/2026'
        }
      ]
    };
    const { pricingTiers } = buildPricingTiersFromSnapshot({
      snapshot,
      productType: 'Healthcare',
      useTobaccoPricing: false,
      defaultEffectiveDate: '2026-01-01',
      configFieldName: 'Unshared Amount $',
      migrationTiers: [],
      rateGrid: {
        byBenefit: new Map([
          ['9392', { benefitId: '9392', nonTobaccoRate: 218.5 }],
          ['9400', { benefitId: '9400', nonTobaccoRate: 260 }]
        ]),
        rows: [
          { benefitId: '9392', nonTobaccoRate: 218.5 },
          { benefitId: '9400', nonTobaccoRate: 260 }
        ]
      },
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Healthcare' },
      ageRange: { min: 18, max: 64 }
    });
    expect(pricingTiers).toHaveLength(2);
    expect(pricingTiers.every((tier) => tier.ageBands.length === 1)).toBe(true);
    expect(pricingTiers.map((tier) => tier.label)).toEqual([
      'Employee Only (EE) — Unshared Amount $ 1500',
      'Employee Only (EE) — Unshared Amount $ 3000'
    ]);
  });

  test('buildPricingTiersFromSnapshot applies tobacco rates with vendor splits and commission residual', () => {
    const snapshot = {
      label: 'Essential ShareWELL',
      setup: { priceByAge: false },
      vendorCosts: [
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 126.1,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        },
        {
          vendorName: 'Sharewell Partners',
          vendorId: 782735,
          amount: 67.9,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        }
      ],
      derivedTiers: [{
        tierCode: 'EE',
        benefitLabel: 'Member Only $1500 UA',
        benefitId: 9392,
        memberAgeMin: 18,
        memberAgeMax: 64,
        msrpRate: 0,
        netRate: 126.1,
        overrideRate: 67.9,
        commission: 0,
        displayStart: '01/01/2026',
        vendorBreakdown: [
          { vendorName: 'Sharewell', bucket: 'net', amount: 126.1 },
          { vendorName: 'Sharewell Partners', bucket: 'override', amount: 67.9 }
        ]
      }]
    };
    const { pricingTiers } = buildPricingTiersFromSnapshot({
      snapshot,
      productType: 'Healthcare',
      useTobaccoPricing: true,
      defaultEffectiveDate: '2026-01-01',
      configFieldName: 'Unshared Amount $',
      migrationTiers: [{ resolvedTier: 'EE', feeHints: { unsharedAmount: '1500' }, memberCount: 3 }],
      rateGrid: {
        byBenefit: new Map([
          ['9392', { benefitId: '9392', nonTobaccoRate: 218.5, tobaccoRate: 175 }]
        ]),
        rows: [{ benefitId: '9392', nonTobaccoRate: 218.5, tobaccoRate: 175 }]
      },
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Healthcare' },
      ageRange: { min: 18, max: 64 }
    });
    const noBand = pricingTiers[0].ageBands.find((band) => band.tobaccoStatus === 'No');
    const yesBand = pricingTiers[0].ageBands.find((band) => band.tobaccoStatus === 'Yes');
    expect(noBand?.netRate).toBe(126.1);
    expect(noBand?.overrideRate).toBe(67.9);
    expect(noBand?.commission).toBe(24.5);
    expect(yesBand).toBeTruthy();
    expect(yesBand.netRate).toBeGreaterThan(0);
    expect(yesBand.overrideRate).toBeGreaterThan(0);
    expect(yesBand.msrpRate).toBe(175);
    expect(yesBand.commission).toBeGreaterThanOrEqual(0);
    const componentTotal = Math.round((yesBand.netRate + yesBand.overrideRate + yesBand.commission) * 100) / 100;
    expect(componentTotal).toBe(175);
  });

  test('buildPricingTiersFromSnapshot fills net override commission for zero-msrp Sharewell rows', () => {
    const snapshot = {
      label: 'Essential ShareWELL',
      setup: { priceByAge: false },
      vendorCosts: [
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 126.1,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        },
        {
          vendorName: 'Sharewell Partners',
          vendorId: 782735,
          amount: 67.9,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        }
      ],
      derivedTiers: [{
        tierCode: 'EE',
        benefitLabel: 'Member Only $1500 UA',
        benefitId: 9392,
        memberAgeMin: 18,
        memberAgeMax: 39,
        msrpRate: 0,
        netRate: 126.1,
        overrideRate: 67.9,
        commission: 0,
        displayStart: '01/01/2026'
      }]
    };
    const { pricingTiers } = buildPricingTiersFromSnapshot({
      snapshot,
      productType: 'Healthcare',
      useTobaccoPricing: false,
      defaultEffectiveDate: '2026-01-01',
      configFieldName: 'Unshared Amount $',
      migrationTiers: [{ resolvedTier: 'EE', feeHints: { unsharedAmount: '1500' }, memberCount: 3 }],
      rateGrid: {
        byBenefit: new Map([
          ['9392', { benefitId: '9392', nonTobaccoRate: 218.5 }]
        ]),
        rows: [{ benefitId: '9392', nonTobaccoRate: 218.5 }]
      },
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Healthcare' },
      ageRange: { min: 18, max: 64 }
    });
    expect(pricingTiers).toHaveLength(1);
    expect(pricingTiers[0].ageBands).toHaveLength(1);
    const band = pricingTiers[0].ageBands[0];
    expect(band.netRate).toBe(126.1);
    expect(band.overrideRate).toBe(67.9);
    expect(band.msrpRate).toBe(218.5);
    expect(band.commission).toBe(24.5);
  });

  test('buildPricingTiersFromSnapshot collapses duplicate composite wellness age bands', () => {
    const snapshot = {
      label: 'Connected Wellness',
      vendorCosts: [{ vendorName: 'Lyric' }, { vendorName: 'ARM' }],
      derivedTiers: [
        {
          tierCode: 'EE',
          benefitLabel: 'Member Only',
          benefitId: 9392,
          memberAgeMin: 50,
          memberAgeMax: 64,
          msrpRate: 180,
          netRate: 120,
          overrideRate: 10,
          commission: 50,
          displayStart: '01/01/2025'
        },
        {
          tierCode: 'EE',
          benefitLabel: 'Member Only (Copy)',
          benefitId: 9394,
          memberAgeMin: 50,
          memberAgeMax: 64,
          msrpRate: 180,
          netRate: 120,
          overrideRate: 10,
          commission: 50,
          displayStart: '01/01/2025'
        }
      ],
      pricingMatrix: []
    };
    const { pricingTiers } = buildPricingTiersFromSnapshot({
      snapshot,
      productType: 'Medical',
      useTobaccoPricing: false,
      defaultEffectiveDate: '2026-01-01',
      configFieldName: '',
      migrationTiers: [],
      rateGrid: { rows: [] },
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Medical' }
    });

    const eeTier = pricingTiers.find((tier) => tier.tierType === 'EE');
    expect(eeTier?.ageBands).toHaveLength(1);
    expect(eeTier?.ageBands[0].minAge).toBe(50);
    expect(eeTier?.ageBands[0].maxAge).toBe(64);
  });

  test('allocationFromSnapshotDerivedRow uses member premium when catalog and GetRates are zero', () => {
    const allocation = allocationFromSnapshotDerivedRow({
      benefitId: 9392,
      benefitLabel: 'Member Only $1500 UA',
      msrpRate: 0,
      netRate: 126.1,
      overrideRate: 67.9,
      commission: 0
    }, {
      vendorCosts: [
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 126.1,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        },
        {
          vendorName: 'Sharewell Partners',
          vendorId: 782735,
          amount: 67.9,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        }
      ]
    }, {}, 'EE', null, {
      feeAmountStats: { median: 218.5, min: 175, max: 218.5, average: 210, sampleSize: 25 },
      feeHints: { amount: 218.5, unsharedAmount: '1500' }
    });
    expect(allocation.msrpRate).toBe(218.5);
    expect(allocation.netRate).toBe(126.1);
    expect(allocation.overrideRate).toBe(67.9);
    expect(allocation.commission).toBe(24.5);
    expect(allocation.allocationSource).toBe('member_premium');
  });

  test('allocationFromSnapshotDerivedRow applies GetRates MSRP and commission residual', () => {
    const { allocationFromSnapshotDerivedRow } = require('../e123ProductWizardDraft.service');
    const allocation = allocationFromSnapshotDerivedRow({
      benefitId: 9392,
      benefitLabel: 'Member Only $1500 UA',
      msrpRate: 0,
      netRate: 0,
      overrideRate: 0,
      commission: 0
    }, {
      vendorCosts: [
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 126.1,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        },
        {
          vendorName: 'Sharewell Partners',
          vendorId: 782735,
          amount: 67.9,
          benefitId: 9392,
          benefitLabel: 'Member Only $1500 UA',
          priceTypes: 'Product',
          isCurrent: true
        }
      ]
    }, {}, 'EE', { nonTobaccoRate: 218.5, tobaccoRate: null });
    expect(allocation.msrpRate).toBe(218.5);
    expect(allocation.netRate).toBe(126.1);
    expect(allocation.overrideRate).toBe(67.9);
    expect(allocation.commission).toBe(24.5);
    expect(allocation.allocationSource).toBe('e123_getrates');
  });

  test('allocationFromSnapshotDerivedRow rebuilds Sharewell net from snapshot vendorCosts', () => {
    const allocation = allocationFromSnapshotDerivedRow({
      benefitId: 9392,
      benefitLabel: 'Member Only',
      memberAgeMin: 18,
      memberAgeMax: 64,
      msrpRate: 200,
      netRate: 0,
      overrideRate: 0,
      commission: 196.75,
      vendorBreakdown: [
        { vendorName: 'Lyric', vendorId: 883564, bucket: 'other', amount: 3.25 }
      ]
    }, {
      vendorCosts: [
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 20.48,
          benefitId: null,
          benefitLabel: 'Member Only',
          priceTypes: 'Product',
          isCurrent: false
        },
        {
          vendorName: 'Sharewell Partners',
          vendorId: 782735,
          amount: 11.02,
          benefitId: null,
          benefitLabel: 'Member Only',
          priceTypes: 'Product',
          isCurrent: false
        },
        {
          vendorName: 'Lyric',
          vendorId: 883564,
          amount: 3.25,
          priceTypes: 'Product',
          isCurrent: true
        }
      ]
    }, {}, 'EE');
    expect(allocation.netRate).toBe(20.48);
    expect(allocation.overrideRate).toBe(14.27);
    expect(allocation.commission).toBe(165.25);
  });

  test('buildE123VendorRoutingPreview groups vendors once per label', () => {
    const { buildE123VendorRoutingPreview } = require('../e123ProductWizardDraft.service');
    const preview = buildE123VendorRoutingPreview({
      vendorCosts: [
        { vendorName: 'Sharewell', vendorId: 782734, amount: 20.48, benefitId: 9392, benefitLabel: 'Member Only', priceTypes: 'Product', isCurrent: false },
        { vendorName: 'Sharewell', vendorId: 782734, amount: 42.25, benefitId: 9402, benefitLabel: 'Member + Spouse', priceTypes: 'Product', isCurrent: false },
        { vendorName: 'Lyric', vendorId: 883564, amount: 3.25, priceTypes: 'Product', isCurrent: true },
        { vendorName: 'Merchant Fee', vendorId: 780686, amount: 0.23, priceTypes: 'Product', isCurrent: true }
      ]
    });
    expect(preview.hasRouting).toBe(true);
    expect(preview.vendors).toHaveLength(3);
    expect(preview.vendors.find((row) => row.vendorName === 'Lyric')?.selectedBucket).toBe('override');
    expect(preview.vendors.find((row) => row.vendorName === 'Merchant Fee')?.selectedBucket).toBe('exclude');
    expect(preview.vendors.find((row) => row.vendorName === 'Merchant Fee')?.isMerchantFee).toBe(true);
    expect(preview.vendors.find((row) => row.vendorName === 'Sharewell')?.amountLabel).toBe('$20.48–$42.25');
  });

  test('allocationFromSnapshotDerivedRow excludes merchant fee when routed to exclude', () => {
    const allocation = allocationFromSnapshotDerivedRow({
      msrpRate: 100,
      vendorBreakdown: [
        { vendorName: 'Sharewell', vendorId: 782734, bucket: 'other', amount: 60 },
        { vendorName: 'Merchant Fee', vendorId: 780686, bucket: 'other', amount: 3.5 }
      ]
    }, {}, { '780686': 'exclude' });
    expect(allocation.netRate).toBe(60);
    expect(allocation.overrideRate).toBe(0);
  });

  test('allocationFromSnapshotDerivedRow applies vendorBucketOverrides across tiers', () => {
    const allocation = allocationFromSnapshotDerivedRow({
      msrpRate: 180,
      vendorBreakdown: [
        { vendorName: 'Sharewell', vendorId: 782734, bucket: 'other', amount: 20.48 },
        { vendorName: 'Lyric', vendorId: 883564, bucket: 'other', amount: 3.25 }
      ]
    }, {}, { lyric: 'net', '883564': 'override' });
    expect(allocation.netRate).toBe(20.48);
    expect(allocation.overrideRate).toBe(3.25);
  });

  test('allocationFromSnapshotDerivedRow prefers tier-scoped Sharewell over flat fee for EC', () => {
    const allocation = allocationFromSnapshotDerivedRow({
      benefitId: 9400,
      benefitLabel: 'Member + Child(ren)',
      memberAgeMin: 18,
      memberAgeMax: 64,
      msrpRate: 375,
      netRate: 65,
      overrideRate: 3.25,
      commission: 306.75,
      vendorBreakdown: [
        { vendorName: 'Sharewell', vendorId: 782734, bucket: 'other', amount: 65 },
        { vendorName: 'Sharewell Partners', vendorId: 782735, bucket: 'other', amount: 11.02 },
        { vendorName: 'Lyric', vendorId: 883564, bucket: 'other', amount: 3.25 }
      ]
    }, {
      vendorCosts: [
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 65,
          benefitId: null,
          benefitLabel: '',
          priceTypes: 'Product',
          isCurrent: true
        },
        {
          vendorName: 'Sharewell',
          vendorId: 782734,
          amount: 343,
          benefitId: 9400,
          benefitLabel: 'Member + Child(ren)',
          priceTypes: 'Product',
          coverageStart: '01/01/2026',
          isCurrent: false
        },
        {
          vendorName: 'Sharewell Partners',
          vendorId: 782735,
          amount: 11.02,
          benefitId: null,
          benefitLabel: '',
          priceTypes: 'Product',
          transactionStart: '01/01/2026',
          isCurrent: true
        },
        {
          vendorName: 'Lyric',
          vendorId: 883564,
          amount: 3.25,
          priceTypes: 'Product',
          transactionStart: '10/01/2025',
          isCurrent: true
        }
      ]
    }, {}, 'EC');
    expect(allocation.netRate).toBe(343);
    expect(allocation.overrideRate).toBe(14.27);
    expect(allocation.commission).toBe(17.73);
  });

  test('buildPricingTiersFromSnapshot keeps phased pricing by effective date for critical illness', () => {
    const snapshot = {
      label: 'BCS Critical Illness $20,000',
      derivedTiers: [
        { tierCode: null, benefitLabel: 'CI 20k', benefitId: 1, memberAgeMin: 18, memberAgeMax: 29, msrpRate: 12.17, netRate: 0, overrideRate: 0.69, commission: 11.48, displayStart: '01/01/2025', displayStop: '12/31/2025' },
        { tierCode: null, benefitLabel: 'CI 20k', benefitId: 2, memberAgeMin: 18, memberAgeMax: 29, msrpRate: 14.29, netRate: 0, overrideRate: 2.81, commission: 11.48, displayStart: '01/01/2026' },
        { tierCode: null, benefitLabel: 'CI 20k', benefitId: 3, memberAgeMin: 30, memberAgeMax: 39, msrpRate: 25.25, netRate: 0, overrideRate: 13.77, commission: 11.48, displayStart: '01/01/2025', displayStop: '12/31/2025' },
        { tierCode: null, benefitLabel: 'CI 20k', benefitId: 4, memberAgeMin: 30, memberAgeMax: 39, msrpRate: 36.76, netRate: 0, overrideRate: 25.28, commission: 11.48, displayStart: '01/01/2026' }
      ],
      pricingMatrix: []
    };
    const { pricingTiers } = buildPricingTiersFromSnapshot({
      snapshot,
      productType: 'Critical Illness',
      useTobaccoPricing: false,
      defaultEffectiveDate: '2026-01-01',
      configFieldName: '',
      migrationTiers: [],
      rateGrid: { rows: [] },
      pricingContext: { referenceRows: [], templateRows: [], productType: 'Critical Illness' }
    });
    expect(pricingTiers).toHaveLength(1);
    expect(pricingTiers[0].tierType).toBe('EE');
    expect(pricingTiers[0].ageBands).toHaveLength(4);
    expect(pricingTiers[0].ageBands.map((band) => band.effectiveDate)).toEqual([
      '2025-01-01',
      '2025-01-01',
      '2026-01-01',
      '2026-01-01'
    ]);
    expect(pricingTiers[0].ageBands[0].terminationDate).toBe('2025-12-31');
    const band2026 = pricingTiers[0].ageBands.find((band) => band.effectiveDate === '2026-01-01');
    expect(band2026?.terminationDate).toBeNull();
  });
});
