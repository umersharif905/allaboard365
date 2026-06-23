'use strict';

const {
  isTierUaPlanKey,
  isGenericProductPlanName,
  buildEligibilityImportValidation,
  detectAlignShaFormatMismatch,
  peekPlanKeysFromRawRows,
} = require('../eligibilityImportValidation');

describe('eligibilityImportValidation', () => {
  test('isTierUaPlanKey accepts EE_1500', () => {
    expect(isTierUaPlanKey('EE_1500')).toBe(true);
    expect(isTierUaPlanKey('EF_3000')).toBe(true);
  });

  test('isGenericProductPlanName flags Essential', () => {
    expect(isGenericProductPlanName('Essential')).toBe(true);
    expect(isGenericProductPlanName('Essential (Sharewell)')).toBe(true);
    expect(isGenericProductPlanName('EE_1500')).toBe(false);
  });

  test('buildEligibilityImportValidation detects generic unmapped plan names', () => {
    const productKeyFromRow = (row) => {
      const tier = String(row['Plan Tier'] || '').trim();
      const ua = String(row.UA || '').trim();
      if (tier && ua) return `${tier}_${ua}`;
      return String(row['Plan Name'] || '').trim();
    };
    const validation = buildEligibilityImportValidation({
      exportRows: [{ 'Plan Name': 'Essential', 'Plan Tier': '', UA: '' }],
      distinctProducts: ['Essential'],
      productMap: new Map(),
      formatSlug: 'sharewell_default',
      headers: ['Plan Name', 'Plan Tier', 'UA', 'Member ID'],
      productKeyFromRow,
    });
    expect(validation.unmappedProducts).toEqual(['Essential']);
    expect(validation.weakPlanCodes[0].reason).toBe('generic_plan_name');
    expect(validation.rowsWithGenericPlanNameOnly).toBe(1);
    expect(validation.hasBlockingIssues).toBe(true);
  });

  test('buildEligibilityImportValidation passes when tier+ua mapped', () => {
    const productKeyFromRow = (row) => `${row['Plan Tier']}_${row.UA}`;
    const validation = buildEligibilityImportValidation({
      exportRows: [{ 'Plan Name': '', 'Plan Tier': 'EE', UA: '2500' }],
      distinctProducts: ['EE_2500'],
      productMap: new Map([['EE_2500', { ProductId: 'x', ProductPricingId: 'y' }]]),
      formatSlug: 'sharewell_default',
      headers: ['Plan Tier', 'UA', 'Member ID'],
      productKeyFromRow,
    });
    expect(validation.hasBlockingIssues).toBe(false);
    expect(validation.unmappedProducts).toEqual([]);
  });

  test('UA-only plan keys are not flagged as weak', () => {
    const validation = buildEligibilityImportValidation({
      exportRows: [{ UA: '6000', 'Calstar Bento Coverage': 'I' }],
      distinctProducts: ['6000'],
      productMap: new Map(),
      formatSlug: 'sharewell_calstar',
      headers: ['UA'],
      productKeyFromRow: () => '6000',
    });
    expect(validation.weakPlanCodes).toEqual([]);
  });

  test('peekPlanKeysFromRawRows derives ES_3000 from Align SHA plan name', () => {
    const keys = peekPlanKeysFromRawRows([
      { 'Plan Name': '11321_AH3000ES', 'Plan Tier': '', UA: '3000' },
    ]);
    expect(keys).toEqual(['ES_3000']);
  });

  test('detectAlignShaFormatMismatch when align slug misses Plan Name mapping', () => {
    const issue = detectAlignShaFormatMismatch({
      formatSlug: 'sharewell_align',
      headers: ['Plan Name', 'Member ID', 'Relationship'],
      distinctProducts: [],
      rawRows: [{ 'Plan Name': '11321_AH1500EE' }],
    });
    expect(issue?.code).toBe('align_sha_layout');
    expect(issue.message).toMatch(/Align Health SHA/i);
  });

  test('buildEligibilityImportValidation blocks when align SHA layout undetected', () => {
    const validation = buildEligibilityImportValidation({
      exportRows: [],
      rawRows: [{ 'Plan Name': '11321_AH3000ES' }],
      distinctProducts: [],
      productMap: new Map(),
      formatSlug: 'sharewell_align',
      headers: ['Plan Name', 'Member ID'],
      productKeyFromRow: () => '',
    });
    expect(validation.formatIssues.some((f) => f.code === 'align_sha_layout')).toBe(true);
    expect(validation.hasBlockingIssues).toBe(true);
  });

  test('tier-only plan keys suggest adding UA', () => {
    const validation = buildEligibilityImportValidation({
      exportRows: [{ 'Plan Tier': 'EE', UA: '' }],
      distinctProducts: ['EE'],
      productMap: new Map(),
      formatSlug: 'sharewell_default',
      headers: ['Plan Tier', 'UA'],
      productKeyFromRow: () => 'EE',
    });
    expect(validation.weakPlanCodes[0].reason).toBe('tier_without_ua');
  });
});
