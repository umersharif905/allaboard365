'use strict';

const {
  buildTierContext,
  computeTierInference,
  extractFeeMetadata,
  parseE123TobaccoUse,
  parseTierFromLabel,
  scorePricingMatch,
  suggestPricingMatch,
  suggestPricingMatchWithMeta,
  computeTobaccoInference,
  comparePremiumMatch,
  getSourcePremiumAmount,
  pricingRowDisplayAmount,
  resolveMigrationProductEnrollmentAmounts
} = require('../e123TierInference');

describe('e123TierInference', () => {
  test('parseTierFromLabel maps common benefit names', () => {
    expect(parseTierFromLabel('Employee + Spouse')).toBe('ES');
    expect(parseTierFromLabel('Single')).toBe('EE');
    expect(parseTierFromLabel('Family')).toBe('EF');
    expect(parseTierFromLabel('Monthly')).toBeNull();
  });

  test('computeTierInference picks dominant household tier', () => {
    const inference = computeTierInference({ EE: 1, ES: 6, EC: 0, EF: 0 });
    expect(inference.inferredMemberTier).toBe('ES');
    expect(inference.tierBreakdownLabel).toBe('EE 1, ES 6');
  });

  test('extractFeeMetadata reads unshared amount fields', () => {
    const meta = extractFeeMetadata({ label: 'UA 1500', unsharedamount: '1500', periodlabel: 'Monthly' });
    expect(meta.unsharedAmount).toBe(1500);
    expect(meta.periodLabel).toBe('Monthly');
  });

  test('parseE123TobaccoUse normalizes common values', () => {
    expect(parseE123TobaccoUse('Y')).toBe('Yes');
    expect(parseE123TobaccoUse('no')).toBe('No');
    expect(parseE123TobaccoUse('1')).toBe('Yes');
    expect(parseE123TobaccoUse('')).toBeNull();
  });

  test('computeTobaccoInference picks dominant tobacco status', () => {
    const inference = computeTobaccoInference({ yes: 12, no: 285, unknown: 0 });
    expect(inference.inferredTobaccoUse).toBe('No');
    expect(inference.tobaccoBreakdownLabel).toContain('non-tobacco 285');
  });

  test('scorePricingMatch prefers matching tobacco surcharge tier', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9392',
      sourceBenefitLabel: 'Monthly',
      memberTierCounts: { EE: 297, ES: 0, EC: 0, EF: 0 },
      inferredMemberTier: 'EE',
      tierConfidence: 1,
      tierBreakdownLabel: 'EE 297',
      memberAgeRange: null,
      feeHints: { amount: 220, unsharedAmount: 1500 },
      feeAmountStats: { min: 220, max: 220, median: 220, average: 220, sampleSize: 297 },
      catalogTier: 'EE',
      catalogBenefitName: null,
      catalogUnsharedAmount: 1500,
      tobaccoCounts: { yes: 0, no: 297, unknown: 0 },
      inferredTobaccoUse: 'No',
      tobaccoConfidence: 1,
      tobaccoBreakdownLabel: 'non-tobacco 297'
    });

    const pricingRows = [
      { productPricingId: 'non-tob', tierType: 'EE', configValue1: '1500', netRate: 220, tobaccoStatus: 'No' },
      { productPricingId: 'tob', tierType: 'EE', configValue1: '1500', netRate: 294, tobaccoStatus: 'Yes' }
    ];

    const nonTobScore = scorePricingMatch(tierContext, pricingRows[0]);
    const tobScore = scorePricingMatch(tierContext, pricingRows[1]);
    expect(nonTobScore.score).toBeGreaterThan(tobScore.score);

    const suggestion = suggestPricingMatch(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('non-tob');
  });

  test('scorePricingMatch prefers tier and UA matches', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9402',
      sourceBenefitLabel: 'Monthly',
      memberTierCounts: { EE: 0, ES: 6, EC: 0, EF: 0 },
      inferredMemberTier: 'ES',
      tierConfidence: 1,
      tierBreakdownLabel: 'ES 6',
      memberAgeRange: { min: 34, max: 52, median: 41, sampleSize: 6 },
      feeHints: { unsharedAmount: 1500 },
      catalogTier: null,
      catalogBenefitName: null,
      catalogUnsharedAmount: null
    });

    const pricingRows = [
      { productPricingId: 'a', tierType: 'EE', configValue1: '1500', label: 'EE 1500', minAge: 18, maxAge: 64 },
      { productPricingId: 'b', tierType: 'ES', configValue1: '1500', label: 'ES 1500', minAge: 18, maxAge: 64 }
    ];

    const esScore = scorePricingMatch(tierContext, pricingRows[1]);
    const eeScore = scorePricingMatch(tierContext, pricingRows[0]);
    expect(esScore.score).toBeGreaterThan(eeScore.score);

    const suggestion = suggestPricingMatch(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('b');
    expect(suggestion.suggestReason).toContain('Tier ES');
  });

  test('scoreAmountMatch prefers closest premium', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9375',
      sourceBenefitLabel: 'Monthly',
      memberTierCounts: { EE: 1, ES: 0, EC: 0, EF: 0 },
      inferredMemberTier: 'EE',
      tierConfidence: 1,
      tierBreakdownLabel: 'EE 1',
      memberAgeRange: null,
      feeHints: { amount: 312.45 },
      feeAmountStats: { min: 312.45, max: 312.45, median: 312.45, average: 312.45, sampleSize: 1 },
      catalogTier: 'EE',
      catalogBenefitName: null,
      catalogUnsharedAmount: 1500
    });

    const pricingRows = [
      { productPricingId: 'a', tierType: 'EE', configValue1: '1500', netRate: 300, overrideRate: 10, label: 'EE 1500' },
      { productPricingId: 'b', tierType: 'EE', configValue1: '3000', netRate: 400, overrideRate: 0, label: 'EE 3000' }
    ];

    const suggestion = suggestPricingMatch(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('a');
    expect(suggestion.suggestReason).toMatch(/\$312\.45/);
  });

  test('suggestPricingMatch picks exact premium before tier-only matches', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9403',
      sourceBenefitLabel: 'Monthly',
      memberTierCounts: { EE: 0, ES: 0, EC: 0, EF: 4 },
      inferredMemberTier: 'EF',
      tierConfidence: 1,
      tierBreakdownLabel: 'EF 4',
      memberAgeRange: { min: 44, max: 60, median: 52, sampleSize: 4 },
      feeHints: { unsharedAmount: 6000 },
      feeAmountStats: { min: 385, max: 385, median: 385, average: 385, sampleSize: 4 },
      catalogTier: 'EF',
      catalogBenefitName: 'Employee + Family (EF)',
      catalogUnsharedAmount: 6000,
      tobaccoCounts: { yes: 0, no: 0, unknown: 4 },
      inferredTobaccoUse: null,
      tobaccoConfidence: 0,
      tobaccoBreakdownLabel: '4 unknown'
    });

    const pricingRows = [
      {
        productPricingId: 'es-wrong-amount',
        tierType: 'ES',
        configValue1: '6000',
        label: 'ES 6000',
        minAge: 18,
        maxAge: 64,
        netRate: 300,
        msrpRate: 300
      },
      {
        productPricingId: 'ef-exact',
        tierType: 'EF',
        configValue1: '6000',
        label: 'EF 6000',
        minAge: 18,
        maxAge: 64,
        netRate: 359,
        overrideRate: 26,
        msrpRate: 385
      },
      {
        productPricingId: 'ee-exact',
        tierType: 'EE',
        configValue1: '6000',
        label: 'EE 6000',
        minAge: 18,
        maxAge: 64,
        netRate: 359,
        overrideRate: 26,
        msrpRate: 385
      }
    ];

    const suggestion = suggestPricingMatch(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('ef-exact');
    expect(suggestion.suggestReason).toContain('$385.00 exact');
    expect(suggestion.suggestReason).toContain('Tier EF');
  });

  test('suggestPricingMatch falls back to closest premium when tier signals are weak', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: null,
      sourceBenefitLabel: 'Monthly',
      memberTierCounts: { EE: 0, ES: 0, EC: 0, EF: 0 },
      inferredMemberTier: null,
      tierConfidence: 0,
      tierBreakdownLabel: null,
      memberAgeRange: null,
      feeHints: { amount: 200 },
      feeAmountStats: { min: 200, max: 200, median: 200, average: 200, sampleSize: 1 },
      catalogTier: null,
      catalogBenefitName: null,
      catalogUnsharedAmount: null
    });

    const pricingRows = [
      { productPricingId: 'closest', netRate: 170, label: 'Tier A' },
      { productPricingId: 'mid', netRate: 235, label: 'Tier B' },
      { productPricingId: 'far', netRate: 280, label: 'Tier C' }
    ];

    const suggestion = suggestPricingMatch(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('closest');
    expect(suggestion.suggestReason).toContain('Closest premium');
  });

  test('suggestPricingMatch picks EC 3000 at 315 over EC 5000 at 350', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9404',
      sourceBenefitLabel: 'Monthly',
      memberTierCounts: { EE: 0, ES: 0, EC: 26, EF: 0 },
      inferredMemberTier: 'EC',
      tierConfidence: 1,
      tierBreakdownLabel: 'EC 26',
      memberAgeRange: { min: 18, max: 64, median: 41, sampleSize: 26 },
      feeHints: { unsharedAmount: 3000 },
      feeAmountStats: { min: 315, max: 315, median: 315, average: 315, sampleSize: 26 },
      catalogTier: 'EC',
      catalogBenefitName: 'Employee + Children (EC)',
      catalogUnsharedAmount: 3000,
      tobaccoCounts: { yes: 0, no: 0, unknown: 26 },
      inferredTobaccoUse: null,
      tobaccoConfidence: 0,
      tobaccoBreakdownLabel: '26 unknown'
    });

    const pricingRows = [
      {
        productPricingId: 'ec-3000',
        tierType: 'EC',
        configValue1: '3000',
        label: 'EC 3000',
        minAge: 18,
        maxAge: 64,
        msrpRate: 315
      },
      {
        productPricingId: 'ec-5000',
        tierType: 'EC',
        configValue1: '5000',
        label: 'EC 5000',
        minAge: 18,
        maxAge: 64,
        msrpRate: 350
      },
      {
        productPricingId: 'es-5000',
        tierType: 'ES',
        configValue1: '5000',
        label: 'ES 5000',
        minAge: 18,
        maxAge: 64,
        msrpRate: 350
      }
    ];

    const suggestion = suggestPricingMatch(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('ec-3000');
    expect(suggestion.suggestReason).toContain('$315.00 exact');
    expect(suggestion.suggestReason).toContain('UA 3000');
  });

  test('suggestPricingMatch picks ES 3000 at 315 when ES and EC share the same premium', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9405',
      sourceBenefitLabel: 'Monthly',
      memberTierCounts: { EE: 0, ES: 27, EC: 0, EF: 0 },
      inferredMemberTier: 'ES',
      tierConfidence: 1,
      tierBreakdownLabel: 'ES 27',
      memberAgeRange: { min: 18, max: 64, median: 41, sampleSize: 27 },
      feeHints: { unsharedAmount: 3000 },
      feeAmountStats: { min: 315, max: 315, median: 315, average: 315, sampleSize: 27 },
      catalogTier: 'ES',
      catalogBenefitName: 'Employee + Spouse (ES)',
      catalogUnsharedAmount: 3000,
      tobaccoCounts: { yes: 0, no: 0, unknown: 27 },
      inferredTobaccoUse: null,
      tobaccoConfidence: 0,
      tobaccoBreakdownLabel: '27 unknown'
    });

    const pricingRows = [
      { productPricingId: 'ec-3000', tierType: 'EC', configValue1: '3000', msrpRate: 315 },
      { productPricingId: 'es-3000', tierType: 'ES', configValue1: '3000', msrpRate: 315 },
      { productPricingId: 'es-5000', tierType: 'ES', configValue1: '5000', msrpRate: 350 }
    ];

    const suggestion = suggestPricingMatch(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('es-3000');
    expect(suggestion.suggestReason).toContain('$315.00 exact');
  });

  test('suggestPricingMatchWithMeta validates non-tobacco only when AB365 has paired tobacco rows', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9392',
      inferredMemberTier: 'EE',
      feeAmountStats: { min: 220, max: 294, median: 220, average: 235, sampleSize: 50 },
      tobaccoCounts: { yes: 0, no: 0, unknown: 50 }
    });
    const pricingRows = [
      { productPricingId: 'no-ee', tierType: 'EE', configValue1: '1500', msrpRate: 220, tobaccoStatus: 'No' },
      { productPricingId: 'yes-ee', tierType: 'EE', configValue1: '1500', msrpRate: 320, tobaccoStatus: 'Yes' }
    ];

    const suggestion = suggestPricingMatchWithMeta(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('no-ee');
    expect(suggestion.productPricingIdTobacco).toBe('yes-ee');
    expect(suggestion.premiumMatch.status).toBe('exact');
    expect(suggestion.tobaccoPremiumMatch).toBeNull();
  });

  test('suggestPricingMatchWithMeta suggests tobacco row when AB365 has paired bands even without E123 tobacco spread', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9392',
      inferredMemberTier: 'EE',
      feeAmountStats: { min: 175, max: 175, median: 175, average: 175, sampleSize: 20 },
      tobaccoCounts: { yes: 0, no: 0, unknown: 20 }
    });
    const pricingRows = [
      { productPricingId: 'no-ee', tierType: 'EE', configValue1: '2500', msrpRate: 175, tobaccoStatus: 'No' },
      { productPricingId: 'yes-ee', tierType: 'EE', configValue1: '2500', msrpRate: 250, tobaccoStatus: 'Yes' }
    ];

    const suggestion = suggestPricingMatchWithMeta(tierContext, pricingRows, null);
    expect(suggestion.productPricingId).toBe('no-ee');
    expect(suggestion.productPricingIdTobacco).toBe('yes-ee');
    expect(suggestion.premiumMatch.status).toBe('exact');
  });

  test('pricingRowDisplayAmount adds stored included processing fee for member-facing compare', () => {
    const row = {
      msrpRate: 278.75,
      includeProcessingFee: true,
      includedProcessingFee: 10.25
    };
    expect(pricingRowDisplayAmount(row)).toBe(289);
    expect(comparePremiumMatch(289, row).status).toBe('exact');
    expect(comparePremiumMatch(289, { msrpRate: 278.75, includeProcessingFee: false }).status).toBe('mismatch');
  });

  test('pricingRowDisplayAmount does not double-count fee when MSRPRate is already retail total', () => {
    const row = {
      msrpRate: 289,
      netRate: 200,
      overrideRate: 50,
      commission: 28.75,
      includeProcessingFee: true,
      includedProcessingFee: 10.25
    };
    expect(pricingRowDisplayAmount(row)).toBe(289);
    expect(comparePremiumMatch(289, row).status).toBe('exact');
  });

  test('comparePremiumMatch uses E123 catalog amount for matching AB365 age band', () => {
    const tierContext = buildTierContext({
      sourceBenefitKey: '9375',
      inferredMemberTier: 'EE',
      catalogPricingRows: [
        { benefitId: '9375', amount: 141, memberAgeMin: 18, memberAgeMax: 39 },
        { benefitId: '9375', amount: 180, memberAgeMin: 40, memberAgeMax: 67 }
      ],
      feeAmountStats: { min: 141, max: 181, median: 180, average: 170, sampleSize: 321 },
      memberAgeRange: { min: 18, max: 64, median: 45, sampleSize: 321 }
    });
    const pricingRow = {
      productPricingId: 'ee-40-64',
      tierType: 'EE',
      minAge: 40,
      maxAge: 64,
      msrpRate: 180,
      includeProcessingFee: false
    };
    const match = comparePremiumMatch(getSourcePremiumAmount(tierContext), pricingRow, tierContext);
    expect(match.status).toBe('exact');
    expect(match.e123Amount).toBe(180);
    expect(match.ab365Amount).toBe(180);
  });

  test('resolveMigrationProductEnrollmentAmounts splits base premium and included fee', () => {
    const row = {
      msrpRate: 278.75,
      netRate: 200,
      overrideRate: 50,
      commission: 28.75,
      includeProcessingFee: true,
      includedProcessingFee: 10.25
    };
    expect(resolveMigrationProductEnrollmentAmounts(row, 289)).toEqual({
      premiumAmount: 278.75,
      includedPaymentProcessingFeeAmount: 10.25,
      netRate: 200,
      overrideRate: 50,
      commission: 28.75
    });
  });

  test('resolveMigrationProductEnrollmentAmounts uses component base when MSRPRate is retail total', () => {
    const row = {
      msrpRate: 289,
      netRate: 200,
      overrideRate: 50,
      commission: 28.75,
      includeProcessingFee: true,
      includedProcessingFee: 10.25
    };
    expect(resolveMigrationProductEnrollmentAmounts(row, 289)).toEqual({
      premiumAmount: 278.75,
      includedPaymentProcessingFeeAmount: 10.25,
      netRate: 200,
      overrideRate: 50,
      commission: 28.75
    });
  });
});
