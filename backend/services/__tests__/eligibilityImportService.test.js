'use strict';

const {
  parseEligibilityTemplateColumns,
  SHAREWELL_24_COLUMN_TEMPLATE,
} = require('../../utils/eligibilityRowTemplate');

const sharewellDefaults = require('../../utils/sharewellDefaultImportPresets');
const { ALIGN_IMPORT_RULES } = sharewellDefaults;

jest.mock('../../services/vendorImportFormatPreset.service', () => {
  const defaults = require('../../utils/sharewellDefaultImportPresets');
  return {
    getFormatPreset: jest.fn(async (_vendorId, slug) => defaults.getPreset(slug)),
    listFormatPresets: jest.fn(async () => defaults.listOptions()),
    isValidFormatSlug: jest.fn(async (_vendorId, slug) => defaults.hasSlug(slug)),
    clearCache: jest.fn(),
  };
});
const {
  normalizeRelationshipCode,
  mapDbRowToStandard,
} = require('../../utils/sharewellExportMapping');
const VendorExportService = require('../vendorExportService');
const {
  parseCsvRows,
  productKeyFromRow,
  parseRelationship,
  rowHasTerminateDate,
  resolveImportTemplate,
  mapRowToExportFields,
  householdGroupKey,
  groupRowsIntoHouseholds,
  dependentDedupKey,
  householdCoverageTier,
  assessHouseholdCoverageTier,
  coverageTierDisplayLabel,
  tobaccoUseDbFromImportRow,
  formatPersonName,
  isTerminatedOnlyNewHousehold,
  calstarPlanKeyFromRow,
  mpbPlanKeyFromRow,
  mpbBaseMemberId,
  isPlausibleImportEmail,
  getImportEmailIssue,
  syntheticDependentEmail,
  syntheticImportEmail,
  buildCatalogMatchSummary,
  parseEligibilityImportDate,
  pricingIdsMatch,
  effectiveDateFromImportRow,
  enrollmentRowPriority,
  shouldPreferEnrollmentProductRow,
  selectEnrollmentProductRows,
} = require('../eligibilityImportService');

const ESSENTIAL_PRODUCT_ID = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';
const ESSENTIAL_AH_PRODUCT_ID = '5F9E2FD9-C817-48A6-ADF6-3D44021F6250';

describe('eligibilityImportService', () => {
  test('mapRowToExportFields passthrough keeps Subscribe ID from full ShareWELL eligibility CSV', () => {
    const headers = ['Relationship', 'Subscribe ID', 'Member ID', 'First Name', 'Last Name', 'Plan Name'];
    const raw = {
      Relationship: 'Spouse',
      'Subscribe ID': '550-81-7253',
      'Member ID': '',
      'First Name': 'Desra',
      'Last Name': 'Frantz',
      'Plan Name': 'SW-HealthShare 1500',
      _cells: ['Spouse', '550-81-7253', '', 'Desra', 'Frantz', 'SW-HealthShare 1500'],
    };
    const cols = parseEligibilityTemplateColumns(SHAREWELL_24_COLUMN_TEMPLATE);
    const mapped = mapRowToExportFields(raw, cols, headers);
    expect(mapped['Subscribe ID']).toBe('550-81-7253');
    expect(mapped.Relationship).toBe('Spouse');
  });

  test('mapRowToExportFields maps Email not Address1 when standard CSV uses sharewell_align preset', async () => {
    const stdCols = parseEligibilityTemplateColumns(SHAREWELL_24_COLUMN_TEMPLATE);
    const headers = stdCols.map((c) => c.headerLabel);
    const sample = {
      'Integration Partner': 'Align Health',
      'Bill Type': 'LB',
      Relationship: 'P',
      'First Name': 'Barry',
      'Last Name': 'Haitoff',
      'Middle Name': '',
      Phone1: '8454946596',
      Phone2: '',
      Email: 'bhaitoff@gmail.com',
      Address1: '21 Croton Lake Road Unit 15',
      Address2: '',
      City: 'Katonah',
      State: 'NY',
      Zip: '10536',
      'Member ID': 'SWAH HT0017',
    };
    const alignTemplate = await resolveImportTemplate({}, 'sharewell_align', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const mapped = mapRowToExportFields(
      { ...sample, _cells: headers.map((h) => sample[h]) },
      alignTemplate,
      headers
    );
    expect(mapped.Email).toBe('bhaitoff@gmail.com');
    expect(mapped['1st Address Line']).toBe('21 Croton Lake Road Unit 15');
    expect(getImportEmailIssue(mapped).invalid).toBe(false);
  });

  test('mapRowToExportFields maps Plan Start to Enrollment Date for align preset', async () => {
    const alignTemplate = await resolveImportTemplate({}, 'sharewell_align', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const headers = alignTemplate.map((c) => c.headerLabel);
    const mapped = mapRowToExportFields(
      {
        'Member ID': 'SWAH HT0017',
        Relationship: 'Self',
        'First Name': 'Barry',
        'Last Name': 'Haitoff',
        'Plan Start': '5/1/2026',
        'Terminate Date': '',
        _cells: headers.map((h) => {
          const row = {
            'Member ID': 'SWAH HT0017',
            Relationship: 'Self',
            'First Name': 'Barry',
            'Last Name': 'Haitoff',
            'Plan Start': '5/1/2026',
            'Terminate Date': '',
          };
          return row[h] ?? '';
        }),
      },
      alignTemplate,
      headers
    );
    expect(mapped['Enrollment Date']).toBe('5/1/2026');
    expect(parseEligibilityImportDate(mapped['Enrollment Date'])?.toISOString()).toBe(
      '2026-05-01T00:00:00.000Z'
    );
    expect(parseEligibilityImportDate('   ')).toBeNull();
  });

  test('mapRowToExportFields keeps positional mapping for native Align headers', async () => {
    const alignTemplate = await resolveImportTemplate({}, 'sharewell_align', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const headers = alignTemplate.map((c) => c.headerLabel);
    const sample = {
      'Member ID': 'SWAH HT0017',
      Relationship: 'Self',
      'First Name': 'Barry',
      'Last Name': 'Haitoff',
      'Email Address': 'bhaitoff@gmail.com',
      'Mail Address 1': '21 Croton Lake Road Unit 15',
    };
    const mapped = mapRowToExportFields(
      { ...sample, _cells: headers.map((h) => sample[h] ?? '') },
      alignTemplate,
      headers
    );
    expect(mapped.Email).toBe('bhaitoff@gmail.com');
    expect(mapped['1st Address Line']).toBe('21 Croton Lake Road Unit 15');
  });

  test('parseCsvRows splits quoted fields', () => {
    const csv = 'A,B\n"hello, world",2';
    const { headers, rows } = parseCsvRows(csv);
    expect(headers).toEqual(['A', 'B']);
    expect(rows[0].A).toBe('hello, world');
    expect(rows[0].B).toBe('2');
  });

  test('productKeyFromRow prefers tier+UA over generic Plan Name', () => {
    expect(productKeyFromRow({
      'Plan Name': 'Essential',
      'Plan Tier': 'EE',
      UA: '1500',
    })).toBe('EE_1500');
  });

  test('productKeyFromRow prefers Product Name', () => {
    expect(productKeyFromRow({ 'Product Name': 'EE_6000' })).toBe('EE_6000');
  });

  test('productKeyFromRow normalizes composite Plan Name to tier_UA import key', () => {
    expect(productKeyFromRow({
      'Plan Name': '11321_AH1500EE',
      UA: '1500',
    })).toBe('EE_1500');
    expect(productKeyFromRow({ 'Plan Name': '11321_AH3000ES' })).toBe('ES_3000');
    expect(productKeyFromRow({ 'Plan Name': '11321_AH3000ES' }, ALIGN_IMPORT_RULES)).toBe('ES_2500');
    expect(productKeyFromRow({ 'Plan Name': '46520_9376' })).toBe('46520_9376');
    expect(productKeyFromRow({
      'Plan Name': '46521_9377',
      UA: '1500',
    })).toBe('46521_9377');
    expect(productKeyFromRow({
      'Plan Name': '46521_9376',
      'Plan Tier': 'ES',
      UA: '1500',
    }, ALIGN_IMPORT_RULES)).toBe('46521_9376');
  });

  test('productKeyFromRow derives tier when AB Product ID is filled from Plan Name alias', () => {
    expect(productKeyFromRow({
      'AB Product ID': '11321_AH3000ES',
      'Product Name': '11321_AH3000ES',
      UA: '3000',
    }, ALIGN_IMPORT_RULES)).toBe('ES_2500');
  });

  test('productKeyFromRow resolves Align native SFTP Benefit_ID and tier+UA', () => {
    expect(productKeyFromRow({
      'Plan Name': 'SW-HealthShare 1500',
      ABBenefitIdOverride: 'AH1500EE',
      'Coverage Tier': 'EE',
      'Deductible IUA': '1500',
    }, ALIGN_IMPORT_RULES)).toBe('EE_1500');
    expect(productKeyFromRow({
      'Plan Name': 'SW-HealthShare 3000',
      ABProductID: '11321',
      ABBenefitIdOverride: 'AH3000EF',
    }, ALIGN_IMPORT_RULES)).toBe('EF_2500');
    expect(productKeyFromRow({
      ABProductID: '46521',
      ABBenefitIdOverride: '9375',
    }, ALIGN_IMPORT_RULES)).toBe('46521_9375');
  });

  test('enrollmentRowPriority prefers 11321 main plan over 46520/46521 addon rows', () => {
    expect(enrollmentRowPriority('11321_AH1500EE', { Product_ID: '11321' })).toBeGreaterThan(
      enrollmentRowPriority('46520_9375', { Product_ID: '46520' }),
    );
    expect(enrollmentRowPriority('11321_AH1500EE', { Product_ID: '11321' })).toBeGreaterThan(
      enrollmentRowPriority('46521_9375', { Product_ID: '46521' }),
    );
  });

  test('selectEnrollmentProductRows keeps one Essential row — 11321 not replaced by 46520/46521', () => {
    const productMap = new Map([
      ['11321_AH1500EE', {
        ProductId: ESSENTIAL_AH_PRODUCT_ID,
        ProductPricingId: '11111111-1111-1111-1111-111111111111',
        ProductName: 'Essential (ShareWELL)',
      }],
      ['EE_1500', {
        ProductId: ESSENTIAL_AH_PRODUCT_ID,
        ProductPricingId: '11111111-1111-1111-1111-111111111111',
        ProductName: 'Essential (ShareWELL)',
      }],
      ['46520_9375', {
        ProductId: ESSENTIAL_AH_PRODUCT_ID,
        ProductPricingId: '22222222-2222-2222-2222-222222222222',
        ProductName: 'Essential (ShareWELL)',
      }],
      ['46521_9375', {
        ProductId: ESSENTIAL_AH_PRODUCT_ID,
        ProductPricingId: '33333333-3333-3333-3333-333333333333',
        ProductName: 'Essential (ShareWELL)',
      }],
    ]);
    const households = groupRowsIntoHouseholds([
      {
        'Member ID': 'SWAHCLO0002',
        Relationship: 'Self',
        'First Name': 'Kay',
        'Last Name': 'Dalebout',
        'Plan Name': 'SW-HealthShare 1500',
        'Coverage Tier': 'EE',
        'Deductible IUA': '1500',
        Product_ID: '11321',
        Benefit_ID: 'AH1500EE',
      },
      {
        'Member ID': 'SWAHCLO0002',
        Relationship: 'Self',
        'First Name': 'Kay',
        'Last Name': 'Dalebout',
        'Coverage Tier': 'EE',
        Product_ID: '46520',
        Benefit_ID: '9375',
      },
      {
        'Member ID': 'SWAHCLO0002',
        Relationship: 'Self',
        'First Name': 'Kay',
        'Last Name': 'Dalebout',
        'Coverage Tier': 'EE',
        Product_ID: '46521',
        Benefit_ID: '9375',
      },
    ]);
    const selected = selectEnrollmentProductRows(households[0], productMap, [], ALIGN_IMPORT_RULES);
    expect(selected).toHaveLength(1);
    expect(selected[0].entry.planKey).toBe('EE_1500');
    expect(selected[0].prodRow.Product_ID).toBe('11321');
    expect(selected[0].entry.mapping.ProductPricingId).toBe('11111111-1111-1111-1111-111111111111');
  });

  test('shouldPreferEnrollmentProductRow prefers active row over termed row for same product', () => {
    const termed = {
      prodRow: { 'Termination Date': '20260228', 'Plan Start': '20250101', Product_ID: '11321' },
      entry: { planKey: 'ES_3000' },
      priority: 300,
    };
    const active = {
      prodRow: { 'Plan Start': '20260301', Product_ID: '11321', 'Coverage Tier': 'EE' },
      entry: { planKey: 'EE_3000' },
      priority: 300,
    };
    expect(shouldPreferEnrollmentProductRow(active, termed)).toBe(true);
    expect(shouldPreferEnrollmentProductRow(termed, active)).toBe(false);
  });

  test('selectEnrollmentProductRows prefers non-terminated plan when old termed row maps to same product', () => {
    const productMap = new Map([
      ['ES_2500', {
        ProductId: ESSENTIAL_AH_PRODUCT_ID,
        ProductPricingId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        ProductName: 'Essential (ShareWELL)',
      }],
      ['EE_2500', {
        ProductId: ESSENTIAL_AH_PRODUCT_ID,
        ProductPricingId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        ProductName: 'Essential (ShareWELL)',
      }],
    ]);
    const households = groupRowsIntoHouseholds([
      {
        'Member ID': 'SWFIR9022',
        Relationship: 'Self',
        'First Name': 'Monsrud',
        'Coverage Tier': 'ES',
        'Plan Start': '20250101',
        'Termination Date': '20260228',
        Product_ID: '11321',
        Benefit_ID: 'AH3000ES',
      },
      {
        'Member ID': 'SWFIR9022',
        Relationship: 'Self',
        'First Name': 'Monsrud',
        'Coverage Tier': 'EE',
        'Plan Start': '20260301',
        Product_ID: '11321',
        Benefit_ID: 'AH3000EE',
      },
    ]);
    const selected = selectEnrollmentProductRows(households[0], productMap, [], ALIGN_IMPORT_RULES);
    expect(selected).toHaveLength(1);
    expect(selected[0].entry.planKey).toBe('EE_2500');
    expect(selected[0].prodRow['Coverage Tier']).toBe('EE');
    expect(rowHasTerminateDate(selected[0].prodRow)).toBe(false);
  });

  test('selectEnrollmentProductRows skips 46520/46521 when 11321 row exists (tobacco Yes)', () => {
    const productMap = new Map([
      ['EE_1500', {
        ProductId: ESSENTIAL_AH_PRODUCT_ID,
        ProductPricingId: '11111111-1111-1111-1111-111111111111',
        ProductName: 'Essential (ShareWELL)',
      }],
      ['46520_9375', {
        ProductId: '779A4257-288E-47AA-91B3-49D5F1FE3D98',
        ProductPricingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        ProductName: 'Processing fee A',
      }],
      ['46521_9375', {
        ProductId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        ProductPricingId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        ProductName: 'Processing fee B',
      }],
    ]);
    const households = groupRowsIntoHouseholds([
      {
        'Member ID': 'SWAHAHP0040',
        Relationship: 'Self',
        'Tobacco Surcharge': '100',
        'Coverage Tier': 'EE',
        'Deductible IUA': '1500',
        Product_ID: '11321',
        Benefit_ID: 'AH1500EE',
      },
      {
        'Member ID': 'SWAHAHP0040',
        Relationship: 'Self',
        'Tobacco Surcharge': '100',
        'Coverage Tier': 'EE',
        Product_ID: '46520',
        Benefit_ID: '9375',
      },
      {
        'Member ID': 'SWAHAHP0040',
        Relationship: 'Self',
        'Tobacco Surcharge': '100',
        'Coverage Tier': 'EE',
        Product_ID: '46521',
        Benefit_ID: '9375',
      },
    ]);
    const selected = selectEnrollmentProductRows(households[0], productMap, [], ALIGN_IMPORT_RULES);
    expect(selected).toHaveLength(1);
    expect(selected[0].prodRow.Product_ID).toBe('11321');
    expect(selected[0].entry.planKey).toBe('EE_1500');
  });

  test('productKeyFromRow keeps Product_ID_Benefit_ID composite for FM family tier', () => {
    expect(productKeyFromRow({
      ABProductID: '11321',
      ABBenefitIdOverride: 'AH1500FM',
      'Coverage Tier': 'FM',
      'Deductible IUA': '1500',
    }, ALIGN_IMPORT_RULES)).toBe('11321_AH1500FM');
    expect(productKeyFromRow({
      Product_ID: '11321',
      Benefit_ID: 'AH3000FM',
    }, ALIGN_IMPORT_RULES)).toBe('11321_AH3000FM');
  });

  test('mapRowToExportFields maps Align Coverage Tier and Deductible IUA for plan keys', async () => {
    const alignTemplate = await resolveImportTemplate({}, 'sharewell_align', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const headers = [
      'Member ID', 'Relationship', 'First Name', 'Last Name', 'Coverage Tier', 'Deductible IUA',
      'Plan Name', 'Product_ID', 'Benefit_ID',
    ];
    const raw = {
      'Member ID': 'SWAHCLO0002',
      Relationship: 'Self',
      'First Name': 'KayLynn',
      'Last Name': 'Dalebout',
      'Coverage Tier': 'EE',
      'Deductible IUA': '1500',
      'Plan Name': 'SW-HealthShare 1500',
      Product_ID: '11321',
      Benefit_ID: 'AH1500EE',
    };
    const mapped = mapRowToExportFields({ ...raw, _cells: headers.map((h) => raw[h]) }, alignTemplate, headers);
    expect(productKeyFromRow(mapped, ALIGN_IMPORT_RULES)).toBe('EE_1500');
  });

  test('Sharewell template has expected column count', () => {
    const cols = parseEligibilityTemplateColumns(SHAREWELL_24_COLUMN_TEMPLATE);
    expect(cols.length).toBe(24);
  });

  test('sample export row includes Product Name field', () => {
    const sample = VendorExportService.getSampleDataRow();
    expect(sample['Product Name']).toBeTruthy();
    expect(sample['First Name']).toBe('Sample');
  });

  test('parseRelationship handles Calstar and Align codes', () => {
    expect(parseRelationship({ Relationship: 'I' })).toBe('P');
    expect(parseRelationship({ 'Calstar Insured Type': 'I' })).toBe('P');
    expect(parseRelationship({ 'Calstar Insured Type': 'S' })).toBe('S');
    expect(parseRelationship({ 'Calstar Insured Type': 'D' })).toBe('C');
    expect(parseRelationship({ Relationship: 'Self' })).toBe('P');
    expect(parseRelationship({ Relationship: 'Child' })).toBe('C');
    expect(parseRelationship({ Relationship: 'D' })).toBe('C');
  });

  test('householdGroupKey groups Calstar family by shared Primary SSN', () => {
    const ssn = '123456789';
    const primary = { 'Employee SSN': ssn, 'First Name': 'Mario', 'Last Name': 'Ongaro', 'Calstar Insured Type': 'I' };
    const spouse = { 'Employee SSN': ssn, 'First Name': 'Jane', 'Last Name': 'Ongaro', 'Calstar Insured Type': 'S' };
    const child = { 'Employee SSN': ssn, 'First Name': 'Ciro', 'Last Name': 'Ongaro', 'Calstar Insured Type': 'D' };
    expect(householdGroupKey(primary)).toBe(householdGroupKey(spouse));
    expect(householdGroupKey(primary)).toBe(householdGroupKey(child));
    expect(householdGroupKey({ 'First Name': 'Bob', 'Last Name': 'Smith' })).not.toBe(householdGroupKey(primary));
  });

  test('rowHasTerminateDate detects terminate column', () => {
    expect(rowHasTerminateDate({ 'Terminate Date': '1/1/2026' })).toBe(true);
    expect(rowHasTerminateDate({ 'Benefit Term Date': '20260115' })).toBe(true);
    expect(rowHasTerminateDate({ 'Effective Date': '1/1/2026' })).toBe(false);
  });

  test('calstarPlanKeyFromRow derives EE_1500 from coverage and UA (legacy helper only)', () => {
    expect(calstarPlanKeyFromRow({ UA: '1500', 'Calstar Bento Coverage': 'I' })).toBe('EE_1500');
  });

  test('mpbPlanKeyFromRow combines Plan_Tier and UA (EE_3000)', () => {
    expect(mpbPlanKeyFromRow({ 'Product Name': 'EE', UA: '3000' })).toBe('EE_3000');
    expect(mpbPlanKeyFromRow({ 'Plan Name': 'ES', UA: '$1,500' })).toBe('ES_1500');
    expect(mpbPlanKeyFromRow({ 'Plan Name': 'EE_6000', 'Plan Tier': 'EE' })).toBe('EE_6000');
    expect(productKeyFromRow({ 'Product Name': 'EF', UA: '6000' }, sharewellDefaults.SHAREWELL_DEFAULT_RULES)).toBe('EF_6000');
  });

  test('mapRowToExportFields builds MPB plan key from native Plan_Tier + UA columns', async () => {
    const cols = await resolveImportTemplate({}, 'sharewell_mpb', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const headers = cols.map((c) => c.headerLabel);
    const raw = {
      Member_ID: 'MPB001A',
      Relationship: 'P',
      First_Name: 'Jane',
      Last_Name: 'Doe',
      DOB: '1/1/1980',
      Gender: 'F',
      Personal_Phone: '5551234567',
      Email: 'jane@example.com',
      Mailing_Street_1: '1 Main',
      Mailing_City: 'Austin',
      Mailing_State: 'TX',
      Mailing_Zip: '78701',
      Start_Date: '1/1/2026',
      Cancellation_Date: '',
      Plan_Tier: 'EE',
      UA: '6000',
      Tobacco_Surcharge: 'No',
    };
    raw._cells = headers.map((h) => raw[h] ?? '');
    const mapped = mapRowToExportFields(raw, cols, headers);
    expect(productKeyFromRow(mapped, sharewellDefaults.PRESETS.sharewell_mpb.importRules)).toBe('EE_6000');
  });

  test('resolveImportTemplate uses format preset when slug provided', async () => {
    const cols = await resolveImportTemplate({}, 'sharewell_mpb', sharewellDefaults.SHAREWELL_VENDOR_ID);
    expect(cols.some((c) => c.headerLabel === 'Member_ID')).toBe(true);
  });

  test('resolveImportTemplate falls back to 24-col default when slug unknown', async () => {
    const cols = await resolveImportTemplate({}, 'unknown_slug', sharewellDefaults.SHAREWELL_VENDOR_ID);
    expect(cols.length).toBe(parseEligibilityTemplateColumns(SHAREWELL_24_COLUMN_TEMPLATE).length);
  });

  test('mpbBaseMemberId strips family suffix letter on MPB ids only', () => {
    expect(mpbBaseMemberId('MPB73291609A')).toBe('MPB73291609');
    expect(mpbBaseMemberId('MPB73291609B')).toBe('MPB73291609');
    expect(mpbBaseMemberId('87499409D1')).toBe('87499409');
    expect(mpbBaseMemberId('87499409D2')).toBe('87499409');
    expect(mpbBaseMemberId('SWAH HT0017')).toBe('SWAH HT0017');
  });

  test('MPB enrollments export groups numeric Member_ID D-suffix dependents', async () => {
    const csv = `Member_ID,First_Name,Last_Name,Email,Relationship,DOB,Gender,Personal_Phone,Plan_Tier,UA,Mailing_Street_1,Mailing_City,Mailing_State,Mailing_Zip,Product,Start_Date,Tobacco_Surcharge
87499409,Andre,Dayan,a@example.com,P,1969-09-26,Male,(979) 777-4226,EF,1500,3437 Settlement Dr.,College Station,TX,77845,2 Easy,2026-07-01,No
87499409D1,Janaina,Dayan,a@example.com,S,1985-07-29,Female,(979) 777-4226,EF,1500,3437 Settlement Dr.,College Station,TX,77845,2 Easy,2026-07-01,No
87499409D2,Maya,Dayan,a@example.com,D,2013-07-19,Female,(979) 777-4226,EF,1500,3437 Settlement Dr.,College Station,TX,77845,2 Easy,2026-07-01,No`;
    const { headers, rows } = parseCsvRows(csv);
    const templateColumns = await resolveImportTemplate({}, 'sharewell_mpb', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const exportRows = rows.map((raw) => {
      const withCells = { ...raw, _cells: headers.map((h) => raw[h]) };
      return mapRowToExportFields(withCells, templateColumns, headers);
    });
    const households = groupRowsIntoHouseholds(exportRows, {
      formatSlug: 'sharewell_mpb',
      importRules: sharewellDefaults.PRESETS.sharewell_mpb.importRules,
    });
    expect(households).toHaveLength(1);
    expect(households[0].dependents).toHaveLength(2);
    expect(
      productKeyFromRow(households[0].primary.row, sharewellDefaults.PRESETS.sharewell_mpb.importRules),
    ).toBe('EF_1500');
  });

  test('MPB native CSV maps names and groups families by base Member_ID', async () => {
    const csv = `Member_ID,Relationship,First_Name,Last_Name,DOB,Gender,Personal_Phone,Email,Mailing_Street_1,Mailing_Street_2,Mailing_City,Mailing_State,Mailing_Zip,Start_Date,Cancellation_Date,Plan_Tier,UA,Tobacco_Surcharge
MPB100001A,P,Jane,Smith,01/15/1980,F,5551112222,jane@example.com,1 Main St,,Austin,TX,78701,01/01/2026,,EE,6000,No
MPB100001B,S,John,Smith,02/20/1978,M,5551112223,,1 Main St,,Austin,TX,78701,01/01/2026,,EE,6000,No
MPB100001C,D,Joey,Smith,05/01/2010,M,,,1 Main St,,Austin,TX,78701,01/01/2026,,EE,6000,No
MPB100002A,P,Bob,Jones,03/01/1975,M,5552223333,bob@example.com,2 Oak Ave,,Dallas,TX,75201,01/01/2026,,ES,3000,No
MPB100003A,P,Alice,Brown,04/01/1985,F,5553334444,alice@example.com,3 Pine Rd,,Houston,TX,77001,01/01/2026,,EE,1500,No`;
    const { headers, rows } = parseCsvRows(csv);
    const templateColumns = await resolveImportTemplate({}, 'sharewell_mpb', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const exportRows = rows.map((raw) => {
      const withCells = { ...raw, _cells: headers.map((h) => raw[h]) };
      return mapRowToExportFields(withCells, templateColumns, headers);
    });
    expect(exportRows[0]['First Name']).toBe('Jane');
    expect(exportRows[0]['Alternate ID']).toBe('MPB100001A');
    const households = groupRowsIntoHouseholds(exportRows, {
      formatSlug: 'sharewell_mpb',
      importRules: sharewellDefaults.PRESETS.sharewell_mpb.importRules,
    });
    expect(households).toHaveLength(3);
    const smith = households.find((h) => formatPersonName(h.primary.row) === 'Jane Smith');
    expect(smith).toBeTruthy();
    expect(smith.dependents).toHaveLength(2);
    expect(householdCoverageTier(smith)).toBe('EF');
    expect(productKeyFromRow(smith.primary.row, sharewellDefaults.PRESETS.sharewell_mpb.importRules)).toBe('EE_6000');
  });

  test('MPB preset cross-maps standard 24-col export headers', async () => {
    const stdHeaders = parseEligibilityTemplateColumns(SHAREWELL_24_COLUMN_TEMPLATE).map((c) => c.headerLabel);
    const sample = {
      'Integration Partner': 'MPowering Benefits',
      'Bill Type': 'LB',
      Relationship: 'P',
      'First Name': 'Jane',
      'Last Name': 'Smith',
      Email: 'jane@example.com',
      'Member ID': 'MPB100001',
      'Plan Name': 'EE_6000',
      'Plan Tier': 'EE',
      UA: '6000',
      'Effective Date': '1/1/2026',
    };
    const mpbTemplate = await resolveImportTemplate({}, 'sharewell_mpb', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const mapped = mapRowToExportFields(
      { ...sample, _cells: stdHeaders.map((h) => sample[h] ?? '') },
      mpbTemplate,
      stdHeaders,
    );
    expect(mapped['First Name']).toBe('Jane');
    expect(mapped['Last Name']).toBe('Smith');
    expect(mapped['Alternate ID']).toBe('MPB100001');
    expect(productKeyFromRow(mapped, sharewellDefaults.PRESETS.sharewell_mpb.importRules)).toBe('EE_6000');
  });

  test('householdGroupKey uses full Align member id (distinct households)', () => {
    expect(householdGroupKey({ 'Member ID': 'SWAH HT0017' })).toBe('mid:swah ht0017');
    expect(householdGroupKey({ 'Member ID': 'SWAH HT0011' })).toBe('mid:swah ht0011');
    expect(householdGroupKey({ 'Member ID': 'SWAH HT0019' })).toBe('mid:swah ht0019');
    expect(householdGroupKey({ 'Member ID': 'SWAH HT0011' })).not.toBe(householdGroupKey({ 'Member ID': 'SWAH HT0017' }));
  });

  test('groupRowsIntoHouseholds keeps Align households separate by member id', () => {
    const heather = { Relationship: 'P', 'Member ID': 'SWAH HT0011', 'First Name': 'Heather', 'Last Name': 'Wall', 'Plan Name': 'A' };
    const jennifer = { Relationship: 'P', 'Member ID': 'SWAH HT0019', 'First Name': 'Jennifer', 'Last Name': 'Moore', 'Plan Name': 'A' };
    const child = { Relationship: 'C', 'Member ID': 'SWAH HT0019', 'First Name': 'Brynn', 'Last Name': 'Moore', 'Plan Name': 'A' };
    const households = groupRowsIntoHouseholds([heather, jennifer, child]);
    expect(households).toHaveLength(2);
    const moore = households.find((h) => h.primary.row['Last Name'] === 'Moore');
    expect(moore?.dependents).toHaveLength(1);
    const wall = households.find((h) => h.primary.row['Last Name'] === 'Wall');
    expect(wall?.dependents).toHaveLength(0);
  });

  test('groupRowsIntoHouseholds dedupes dependents across product rows', () => {
    const primary = {
      Relationship: 'P',
      'Member ID': 'SWAH HT0019',
      'First Name': 'Jennifer',
      'Last Name': 'Moore',
      'Plan Name': 'Plan A',
    };
    const childPlanA = {
      Relationship: 'C',
      'Member ID': 'SWAH HT0019',
      'First Name': 'Cienna',
      'Last Name': 'Wissert',
      'Plan Name': 'Plan A',
    };
    const childPlanB = {
      ...childPlanA,
      'Plan Name': 'Plan B',
      'First Name': ' "Cienna " ',
    };
    const households = groupRowsIntoHouseholds([primary, childPlanA, childPlanB]);
    expect(households).toHaveLength(1);
    expect(households[0].dependents).toHaveLength(1);
    expect(formatPersonName(households[0].dependents[0].row)).toBe('Cienna Wissert');
    expect(households[0].products).toHaveLength(3);
  });

  test('groupRowsIntoHouseholds does not duplicate primary on extra product rows', () => {
    const planA = {
      Relationship: 'P',
      'Member ID': 'BOB001',
      'First Name': 'Bob',
      'Last Name': 'Schilling',
      'Plan Name': 'Plan A',
    };
    const planB = {
      Relationship: 'P',
      'Member ID': 'BOB001',
      'First Name': 'Bob',
      'Last Name': 'Schilling',
      'Plan Name': 'Plan B',
    };
    const spouse = {
      Relationship: 'S',
      'Member ID': 'BOB001',
      'First Name': 'Arlyee',
      'Last Name': 'Schilling',
      'Plan Name': 'Plan A',
    };
    const households = groupRowsIntoHouseholds([planA, planB, spouse]);
    expect(households).toHaveLength(1);
    expect(households[0].dependents).toHaveLength(1);
    expect(formatPersonName(households[0].dependents[0].row)).toBe('Arlyee Schilling');
    expect(households[0].products).toHaveLength(3);
    expect(householdCoverageTier(households[0])).toBe('ES');
  });

  test('householdCoverageTier derives EF when spouse and children present', () => {
    expect(householdCoverageTier({
      dependents: [{ rel: 'S' }, { rel: 'C' }, { rel: 'C' }],
    })).toBe('EF');
  });

  test('assessHouseholdCoverageTier flags missing dependents when plan implies ES but file has no spouse row', () => {
    const hh = {
      primary: { row: { Relationship: 'P', 'Plan Name': '11321_AH1500ES', 'Plan Tier': 'EE' }, rel: 'P' },
      dependents: [],
      products: [{ Relationship: 'P', 'Plan Name': '11321_AH1500ES', UA: '1500' }],
    };
    expect(householdCoverageTier(hh)).toBe('EE');
    const a = assessHouseholdCoverageTier(hh, ALIGN_IMPORT_RULES);
    expect(a.missingDependents).toBe(true);
    expect(a.requiredTier).toBe('ES');
    expect(a.tier).toBe('EE');
  });

  test('assessHouseholdCoverageTier ignores terminated plan rows when inferring required tier', () => {
    const hh = {
      primary: { row: { 'Plan Name': '11321_AH1500EE', 'Plan Tier': 'EE' }, rel: 'P' },
      dependents: [],
      products: [
        { 'Plan Name': '11321_AH1500EE', 'Plan Tier': 'EE' },
        { 'Plan Name': '11321_AH1500EF', 'Plan Tier': 'EF', 'Terminate Date': '9/30/2025' },
      ],
    };
    expect(assessHouseholdCoverageTier(hh, ALIGN_IMPORT_RULES).missingDependents).toBe(false);
  });

  test('assessHouseholdCoverageTier allows EE primary-only and ES when spouse row present', () => {
    const solo = {
      primary: { row: { 'Plan Name': '11321_AH1500EE' }, rel: 'P' },
      dependents: [],
      products: [{ 'Plan Name': '11321_AH1500EE' }],
    };
    expect(assessHouseholdCoverageTier(solo, ALIGN_IMPORT_RULES).missingDependents).toBe(false);

    const withSpouse = {
      primary: { row: { 'Plan Name': '11321_AH1500ES' }, rel: 'P' },
      dependents: [{ row: { Relationship: 'S' }, rel: 'S' }],
      products: [{ 'Plan Name': '11321_AH1500ES' }],
    };
    const a = assessHouseholdCoverageTier(withSpouse, ALIGN_IMPORT_RULES);
    expect(a.missingDependents).toBe(false);
    expect(a.tier).toBe('ES');
  });

  test('tobaccoUseDbFromImportRow maps Align tobacco surcharge to Y/N', () => {
    expect(tobaccoUseDbFromImportRow({ 'Tobacco Surcharge': '100' }, ALIGN_IMPORT_RULES)).toBe('Y');
    expect(tobaccoUseDbFromImportRow({ 'Tobacco Surcharge': '' }, ALIGN_IMPORT_RULES)).toBe('N');
    expect(tobaccoUseDbFromImportRow({ 'Tobacco Surcharge': '0' }, ALIGN_IMPORT_RULES)).toBe('N');
  });

  test('mapRowToExportFields retains DOB gender and address for ShareWELL full eligibility rows', async () => {
    const { memberDemographicsFromImportRow } = require('../../utils/eligibilityImportDemographics');
    const alignTemplate = await resolveImportTemplate({}, 'sharewell_align', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const headers = alignTemplate.map((c) => c.headerLabel);
    const raw = {
      'Member ID': 'SWAHFIR0276',
      Relationship: 'Self',
      'First Name': 'Joshua',
      'Last Name': 'Peterson',
      'Date of Birth': '19660116',
      Gender: 'M',
      'Mail Address 1': '17197 Matinal Rd',
      'Mail City': 'San Diego',
      'Mail State': 'CA',
      'Mail Zip': '92127',
      'Primary Phone': '6196027454',
      _cells: [],
    };
    raw._cells = headers.map((h) => raw[h] ?? '');
    const mapped = mapRowToExportFields(raw, alignTemplate, headers);
    const demo = memberDemographicsFromImportRow(mapped);
    expect(demo.dateOfBirth?.toISOString()).toBe('1966-01-16T00:00:00.000Z');
    expect(demo.gender).toBe('M');
    expect(demo.address).toBe('17197 Matinal Rd');
    expect(demo.city).toBe('San Diego');
    expect(demo.state).toBe('CA');
    expect(demo.zip).toBe('92127');
    expect(demo.phone).toBe('6196027454');
  });

  test('pricingIdsMatch compares product pricing GUIDs case-insensitively', () => {
    expect(pricingIdsMatch('ABC-DEF', 'abc-def')).toBe(true);
    expect(pricingIdsMatch('ABC-DEF', 'ABC-EEE')).toBe(false);
  });

  test('effectiveDateFromImportRow reads Plan Start for Align native files', () => {
    const d = effectiveDateFromImportRow({ 'Plan Start': '1/1/2026' });
    expect(d?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('effectiveDateFromImportRow reads ShareWELL inbound Plan Start YYYYMMDD', () => {
    const d = effectiveDateFromImportRow({ 'Plan Start': '20240501' });
    expect(d?.toISOString()).toBe('2024-05-01T00:00:00.000Z');
  });

  test('mapRowToExportFields keeps Plan Start for inbound Align eligibility CSV', async () => {
    const alignTemplate = await resolveImportTemplate({}, 'sharewell_align', sharewellDefaults.SHAREWELL_VENDOR_ID);
    const headers = alignTemplate.map((c) => c.headerLabel);
    const raw = {
      'Member ID': 'SWAH HT0017',
      Relationship: 'Self',
      'First Name': 'Barry',
      'Last Name': 'Haitoff',
      'Plan Start': '20240501',
      'Product_ID': '11321',
      'Benefit_ID': 'AH1500EE',
      _cells: [],
    };
    raw._cells = headers.map((h) => raw[h] ?? '');
    const mapped = mapRowToExportFields(raw, alignTemplate, headers);
    expect(mapped['Enrollment Date']).toBe('20240501');
    expect(effectiveDateFromImportRow(mapped)?.toISOString()).toBe('2024-05-01T00:00:00.000Z');
  });

  test('groupRowsIntoHouseholds attaches ShareWELL spouse/child rows via Subscribe ID', () => {
    const rows = [
      {
        Relationship: 'Self',
        'Subscribe ID': '550-81-7253',
        'Member ID': 'SWVC8014',
        'First Name': 'Joshua',
        'Last Name': 'Frantz',
        'Plan Name': 'SW-HealthShare 1500',
        Product_ID: '11321',
        Benefit_ID: 'AH1500FM',
      },
      {
        Relationship: 'Spouse',
        'Subscribe ID': '550-81-7253',
        'First Name': 'Desra',
        'Last Name': 'Frantz',
      },
    ];
    const households = groupRowsIntoHouseholds(rows, { formatSlug: 'sharewell_align_sha' });
    expect(households).toHaveLength(1);
    expect(households[0].dependents).toHaveLength(1);
    expect(householdCoverageTier(households[0])).toBe('ES');
    expect(assessHouseholdCoverageTier(households[0], ALIGN_IMPORT_RULES).missingDependents).toBe(false);
  });

  test('groupRowsIntoHouseholds does not merge SWFIR9010–9016 into one mega-household (Denise Nelson regression)', () => {
    const rows = [
      { Relationship: 'P', 'Member ID': 'SWFIR9010', 'First Name': 'Denise', 'Last Name': 'Nelson', 'Plan Name': 'Plan A' },
      { Relationship: 'P', 'Member ID': 'SWFIR9011', 'First Name': 'Benjamin', 'Last Name': 'Villanueva', 'Plan Name': 'Plan A' },
      { Relationship: 'P', 'Member ID': 'SWFIR9012', 'First Name': 'Stephanie', 'Last Name': 'Valentine', 'Plan Name': 'Plan A' },
      { Relationship: 'P', 'Member ID': 'SWFIR9014', 'First Name': 'Travis', 'Last Name': 'Williams', 'Plan Name': 'Plan A' },
      { Relationship: 'S', 'Member ID': 'SWFIR9014', 'First Name': 'Koral', 'Last Name': 'Williams', 'Plan Name': 'Plan A' },
      { Relationship: 'C', 'Member ID': 'SWFIR9014', 'First Name': 'Kade', 'Last Name': 'Williams', 'Plan Name': 'Plan A' },
      { Relationship: 'P', 'Member ID': 'SWFIR9015', 'First Name': 'Mathew', 'Last Name': 'Leitner', 'Plan Name': 'Plan A' },
      { Relationship: 'C', 'Member ID': 'SWFIR9015', 'First Name': 'Tiernan', 'Last Name': 'Leitner', 'Plan Name': 'Plan A' },
      { Relationship: 'P', 'Member ID': 'SWFIR9016', 'First Name': 'Tammy', 'Last Name': 'Refro', 'Plan Name': 'Plan A' },
    ];
    const households = groupRowsIntoHouseholds(rows);
    expect(households).toHaveLength(6);

    const denise = households.find((h) => h.primary.row['Last Name'] === 'Nelson');
    expect(denise?.dependents).toHaveLength(0);
    expect(householdCoverageTier(denise)).toBe('EE');

    const villanueva = households.find((h) => h.primary.row['Last Name'] === 'Villanueva');
    expect(villanueva?.dependents).toHaveLength(0);

    const williams = households.find((h) => h.primary.row['Last Name'] === 'Williams');
    expect(williams?.dependents).toHaveLength(2);
    expect(householdCoverageTier(williams)).toBe('EF');

    const leitner = households.find((h) => h.primary.row['Last Name'] === 'Leitner');
    expect(leitner?.dependents).toHaveLength(1);
    expect(householdCoverageTier(leitner)).toBe('EC');

    const refro = households.find((h) => h.primary.row['Last Name'] === 'Refro');
    expect(refro?.dependents).toHaveLength(0);
    expect(householdCoverageTier(refro)).toBe('EE');

    for (const hh of households) {
      for (const dep of hh.dependents) {
        expect(dep.rel).not.toBe('P');
      }
    }
  });

  test('householdGroupKey would have incorrectly merged SWFIR901x before suffix fix', () => {
    const ids = ['SWFIR9010', 'SWFIR9011', 'SWFIR9012', 'SWFIR9014', 'SWFIR9015', 'SWFIR9016'];
    const keys = ids.map((id) => householdGroupKey({ 'Member ID': id }));
    expect(new Set(keys).size).toBe(ids.length);
  });

  test('dependentDedupKey uses person identity when member id is shared', () => {
    expect(dependentDedupKey({ 'Member ID': 'SWAH HT0019', 'First Name': 'A', 'Last Name': 'B' }, 'C'))
      .toBe('person:swah ht0019|C|a|b');
  });

  test('isTerminatedOnlyNewHousehold when all mapped plans are terminated pending', () => {
    expect(isTerminatedOnlyNewHousehold(null, [
      { action: 'terminate_pending', planKey: 'EE_1500' },
    ])).toBe(true);
    expect(isTerminatedOnlyNewHousehold(null, [
      { action: 'enroll_create', planKey: 'EE_1500' },
    ])).toBe(false);
    expect(isTerminatedOnlyNewHousehold({ MemberId: 'x' }, [
      { action: 'terminate_pending', planKey: 'EE_1500' },
    ])).toBe(false);
  });

  test('isPlausibleImportEmail rejects addresses and accepts real emails', () => {
    expect(isPlausibleImportEmail('3098 nw hidden ridge dr')).toBe(false);
    expect(isPlausibleImportEmail('user@example.com')).toBe(true);
    expect(isPlausibleImportEmail('')).toBe(false);
  });

  test('getImportEmailIssue flags missing and malformed emails', () => {
    expect(getImportEmailIssue({ Email: '' }).invalid).toBe(true);
    expect(getImportEmailIssue({ Email: '' }).reason).toBe('missing');
    expect(getImportEmailIssue({ Email: '3098 nw hidden ridge dr' }).reason).toBe('invalid_format');
    expect(getImportEmailIssue({ Email: 'user@example.com' }).invalid).toBe(false);
  });

  test('syntheticDependentEmail uses member name and guid', () => {
    const email = syntheticDependentEmail(
      { 'First Name': 'Jane', 'Last Name': 'Doe' },
      'abc-def-1234'
    );
    expect(email).toMatch(/^jane-doe-[a-f0-9]+@noemail\.com$/);
  });

  test('syntheticImportEmail produces unique noemail addresses', () => {
    const a = syntheticImportEmail('primary', 'abc-def-ghi');
    const b = syntheticImportEmail('primary', 'abc-def-ghi', 1);
    expect(a).toMatch(/@noemail\.com$/);
    expect(b).toMatch(/@noemail\.com$/);
    expect(a).not.toBe(b);
  });
});

describe('sharewellExportMapping', () => {
  test('normalizeRelationshipCode maps Calstar insured types', () => {
    expect(normalizeRelationshipCode('I')).toBe('P');
    expect(normalizeRelationshipCode('S')).toBe('S');
    expect(normalizeRelationshipCode('D')).toBe('C');
  });

  test('mapDbRowToStandard builds FMA Copy Over plan name from tier and ua', () => {
    const row = mapDbRowToStandard({
      member_id: 'T685409225',
      first_name: 'Jane',
      last_name: 'Doe',
      relationship: 'P',
      tier: 'EF',
      ua: '1500',
      effective_date: '2026-01-01',
      partner_price: 850,
    }, 'fma_copy_over');
    expect(row['Plan Name']).toBe('');
    expect(row['Plan Tier']).toBe('EF');
    expect(row.UA).toBe('1500');
    expect(row['Integration Partner']).toBe('FMA Copy Over');
  });

  test('mapDbRowToStandard builds Mutual Health LYR plan codes', () => {
    const row = mapDbRowToStandard({
      member_id: '685648583',
      first_name: 'Michael',
      last_name: 'Leb',
      relationship: 'P',
      tier: 'EE',
      ua: '6000',
      mp_tobacco: 'Yes',
    }, 'mutual_health');
    expect(row['Plan Name']).toBe('LYR6000');
    expect(row['Plan Tier']).toBe('EE');
    expect(row['Integration Partner']).toBe('LYR1552');
    expect(row['Tobacco Surcharge']).toBe('100');
  });

  test('mapDbRowToStandard builds MPB plan tier columns', () => {
    const row = mapDbRowToStandard({
      member_id: 'HH001',
      first_name: 'Bob',
      last_name: 'Smith',
      relationship: 'P',
      tier: 'EE',
      ua: '3000',
      mp_tobacco: 'Yes',
    }, 'mpb');
    expect(row['Plan Name']).toBe('');
    expect(row['Plan Tier']).toBe('EE');
    expect(row.UA).toBe('3000');
    expect(row['Tobacco Surcharge']).toBe('100');
  });

  test('buildCatalogMatchSummary lists mapped tiers and unmapped codes', () => {
    const summary = buildCatalogMatchSummary(
      [
        {
          action: 'enroll_create',
          planKey: '11321_AH1500EE',
          mappedTierLabel: 'Essential (Sharewell) - 2025 — Employee Only (EE) — Unshared Amount $ 1500',
          productName: 'Essential (Sharewell) - 2025',
        },
        { action: 'skip_unmapped', planKey: '46520_9376' },
      ],
      ['46520_9376'],
    );
    expect(summary).toContain('Essential (Sharewell) - 2025');
    expect(summary).toContain('Unmapped: 46520_9376');
  });
});
