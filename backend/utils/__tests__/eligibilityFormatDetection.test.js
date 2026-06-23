'use strict';

const { parseEligibilityTemplateColumns, SHAREWELL_24_COLUMN_TEMPLATE } = require('../eligibilityRowTemplate');
const {
  suggestEligibilityFormat,
  detectSharewell24Layout,
  detectNativeAlignLayout,
  detectAlignHealthInboundLayout,
} = require('../eligibilityFormatDetection');

const PRESETS = [
  {
    slug: 'sharewell_default',
    label: 'ShareWELL Standard (24-col)',
    template: SHAREWELL_24_COLUMN_TEMPLATE,
  },
  {
    slug: 'sharewell_align_sha',
    label: 'Align Health SHA (ShareWELL 24-col)',
    template: SHAREWELL_24_COLUMN_TEMPLATE,
  },
  {
    slug: 'sharewell_align',
    label: 'Align Health (native SFTP)',
    template:
      '{MemberIDBase:Member ID},{Relationship:Relationship},{FirstName:First Name},{LastName:Last Name},'
      + '{DOB:Date of Birth},{AddressLine1:Mail Address 1},{EffectiveDate:Plan Start},{ABProductID:Product_ID},'
      + '{ABBenefitIdOverride:Benefit_ID},{PlanName:Plan Name}',
  },
];

const SHAREWELL_HEADERS = parseEligibilityTemplateColumns(SHAREWELL_24_COLUMN_TEMPLATE)
  .map((c) => c.headerLabel);

describe('eligibilityFormatDetection', () => {
  test('detectSharewell24Layout for export-style headers', () => {
    const fileSet = new Set(SHAREWELL_HEADERS.map((h) => h.toLowerCase()));
    expect(detectSharewell24Layout(fileSet)).toBe(true);
  });

  test('suggests align_sha for 24-col file with 11321_AH plan names', () => {
    const suggestion = suggestEligibilityFormat({
      headers: SHAREWELL_HEADERS,
      presets: PRESETS,
      selectedSlug: 'sharewell_align',
      rawRows: [{ 'Plan Name': '11321_AH1500EE', 'Member ID': 'SWFIR9006' }],
    });
    expect(suggestion.suggestedSlug).toBe('sharewell_align_sha');
    expect(suggestion.matchesSelected).toBe(false);
    expect(suggestion.message).toMatch(/fits/i);
  });

  test('matches selected when native align headers and align slug', () => {
    const headers = [
      'Member ID', 'Relationship', 'First Name', 'Last Name', 'Date of Birth',
      'Mail Address 1', 'Plan Start', 'Product_ID', 'Benefit_ID', 'Plan Base',
    ];
    const suggestion = suggestEligibilityFormat({
      headers,
      presets: PRESETS,
      selectedSlug: 'sharewell_align',
      rawRows: [],
    });
    expect(suggestion.suggestedSlug).toBe('sharewell_align');
    expect(suggestion.matchesSelected).toBe(true);
  });

  test('suggests sharewell_default for standard file without align codes', () => {
    const suggestion = suggestEligibilityFormat({
      headers: SHAREWELL_HEADERS,
      presets: PRESETS,
      selectedSlug: 'sharewell_default',
      rawRows: [{ 'Plan Name': 'EE_1500', 'Plan Tier': 'EE', UA: '1500' }],
    });
    expect(suggestion.matchesSelected).toBe(true);
    expect(['sharewell_default', 'sharewell_align_sha']).toContain(suggestion.suggestedSlug);
  });

  test('detectAlignHealthInboundLayout allows Integration Partner column', () => {
    const headers = [
      'Integration Partner', 'Mail Address 1', 'Plan Start', 'Product_ID', 'Benefit_ID', 'Coverage Tier',
    ];
    const fileSet = new Set(headers.map((h) => h.toLowerCase()));
    expect(detectAlignHealthInboundLayout(fileSet)).toBe(true);
    expect(detectNativeAlignLayout(fileSet)).toBe(true);
  });

  test('Align Health inbound file suggests sharewell_align off sharewell_default', () => {
    const headers = [
      'Integration Partner', 'List Bill', 'Payer Name', 'Relationship', 'Subscribe ID', 'Member Number',
      'Last Name', 'First Name', 'Mail Address 1', 'Mail City', 'Mail State', 'Mail Zip', 'Date of Birth',
      'Gender', 'Plan Name', 'Coverage Tier', 'Plan Start', 'Terminate Date', 'Plan Base', 'Deductible IUA',
      'Tobacco Surcharge', 'Member ID', 'Product_ID', 'Benefit_ID',
    ];
    const suggestion = suggestEligibilityFormat({
      headers,
      presets: PRESETS,
      selectedSlug: 'sharewell_default',
      rawRows: [{ Product_ID: '11321', Benefit_ID: 'AH1500EE', 'Plan Name': 'SW-HealthShare 1500' }],
    });
    expect(suggestion.suggestedSlug).toBe('sharewell_align');
    expect(suggestion.matchesSelected).toBe(false);
    expect(suggestion.autoApply).toBe(false);
    expect(suggestion.layoutHint).toBe('align_health_inbound');
    expect(suggestion.message).toMatch(/Product_ID/i);
    expect(suggestion.ranked[0].slug).toBe('sharewell_align');
    expect(suggestion.ranked[0].score).toBeGreaterThan(suggestion.ranked.find((r) => r.slug === 'sharewell_default').score);
  });
});
