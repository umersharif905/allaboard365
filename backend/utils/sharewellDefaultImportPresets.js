'use strict';

/**
 * ShareWELL-only fallback presets when oe.VendorImportFormatPresets is not seeded yet.
 * Production source of truth is DB (seeded for vendor D2A84803-... only).
 */
const { SHAREWELL_24_COLUMN_TEMPLATE, SHAREWELL_FULL_ELIGIBILITY_TEMPLATE } = require('./eligibilityRowTemplate');
const { normalizeImportRules } = require('./vendorImportRules');

const SHAREWELL_VENDOR_ID = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

const ESSENTIAL_PRODUCT_ID = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';
/** Align Health billable product — partner_invoice_pricing amounts. */
const ESSENTIAL_AH_PRODUCT_ID = '5F9E2FD9-C817-48A6-ADF6-3D44021F6250';
/** MPB enrollments bill Essential (Sharewell) - 2025 tiers (UA 1500/3000/6000). */
const ESSENTIAL_2025_PRODUCT_ID = '941C7833-D3D7-4411-8407-B43F2A42F2D1';
const MPB_PRODUCT_ID = ESSENTIAL_2025_PRODUCT_ID;

const ALIGN_KEY_STRATEGY = {
  type: 'composite',
  strategies: ['planCode', 'composite', 'tierUa'],
  compositeFields: ['ABProductID,Product_ID', 'ABBenefitIdOverride,Benefit_ID'],
  compositeSeparator: '_',
  tierFields: 'PlanTier,Family Size Tier,Plan Tier,Coverage Tier',
  tierPattern: '^(EE|ES|EC|EF|FM)$',
  uaFields: 'UA,Deductible IUA,Plan Base',
  planCodeFields: 'Plan Name,Product Name',
  tierUaSuffixRegex: '(\\d{3,6})(EE|ES|EC|EF)$',
  uaRelabel: [{ from: '3000', to: '2500' }, { from: '6000', to: '5000' }],
};

/** Fallback when DB ImportRulesJson is not seeded — production values live in sql-changes seeds. */
const ALIGN_IMPORT_RULES = normalizeImportRules({
  rowGrain: 'perProduct',
  products: [
    {
      id: 'align-essential',
      label: 'Essential - AH',
      targetProductId: ESSENTIAL_AH_PRODUCT_ID,
      match: { mode: 'always' },
      keyStrategy: ALIGN_KEY_STRATEGY,
    },
  ],
  planKey: {
    productSource: { mode: 'fields', fields: 'Product_ID' },
    tierSource: {
      mode: 'composite_then_tier',
      strategies: ALIGN_KEY_STRATEGY.strategies,
      compositeFields: ALIGN_KEY_STRATEGY.compositeFields,
      compositeSeparator: ALIGN_KEY_STRATEGY.compositeSeparator,
      tierFields: ALIGN_KEY_STRATEGY.tierFields,
      tierPattern: ALIGN_KEY_STRATEGY.tierPattern,
      uaFields: ALIGN_KEY_STRATEGY.uaFields,
      planCodeFields: ALIGN_KEY_STRATEGY.planCodeFields,
      tierUaSuffixRegex: ALIGN_KEY_STRATEGY.tierUaSuffixRegex,
      uaRelabel: ALIGN_KEY_STRATEGY.uaRelabel,
    },
    strategies: ALIGN_KEY_STRATEGY.strategies,
    compositeFields: ALIGN_KEY_STRATEGY.compositeFields,
    compositeSeparator: ALIGN_KEY_STRATEGY.compositeSeparator,
    tierFields: ALIGN_KEY_STRATEGY.tierFields,
    tierPattern: ALIGN_KEY_STRATEGY.tierPattern,
    uaFields: ALIGN_KEY_STRATEGY.uaFields,
    planCodeFields: ALIGN_KEY_STRATEGY.planCodeFields,
    tierUaSuffixRegex: ALIGN_KEY_STRATEGY.tierUaSuffixRegex,
    uaRelabel: ALIGN_KEY_STRATEGY.uaRelabel,
    sourceKeyIncludeRegex: null,
  },
  productMapping: { defaultProductNameContains: 'Essential - AH', assumedProductId: ESSENTIAL_AH_PRODUCT_ID },
});

const MPB_HOUSEHOLD_MEMBER_ID = {
  suffixStripPatterns: [
    '^(\\d+)(D\\d+)$',
    '^(MPB\\d+)([A-Z])$',
  ],
};

const MPB_IMPORT_RULES = normalizeImportRules({
  rowGrain: 'perPrimary',
  householdMemberId: MPB_HOUSEHOLD_MEMBER_ID,
  products: [
    {
      id: 'mpb-main',
      label: 'MPowering Benefits',
      targetProductId: MPB_PRODUCT_ID,
      match: { mode: 'always' },
      keyStrategy: {
        type: 'planCode',
        strategies: ['planCode', 'tierUa'],
        tierFields: 'Plan_Tier,Plan Tier,Family Size Tier',
        tierPattern: '^(EE|ES|EC|EF)$',
        uaFields: 'UA',
        planCodeFields: 'Plan Name,Product Name',
        tierUaSuffixRegex: '(\\d{3,6})(EE|ES|EC|EF)$',
        uaRelabel: [],
      },
    },
  ],
  planKey: {
    strategies: ['planCode', 'tierUa'],
    planCodeFields: 'Plan Name,Product Name',
    tierFields: 'Plan_Tier,Plan Tier,Family Size Tier',
    uaFields: 'UA',
  },
  productMapping: { defaultProductNameContains: null, assumedProductId: MPB_PRODUCT_ID },
});

const MIGHTYWELL_IMPORT_RULES = normalizeImportRules({
  rowGrain: 'perPrimary',
  products: [
    {
      id: 'mw-medical',
      label: 'Medical',
      targetProductId: null,
      match: { mode: 'fieldNonBlank', field: 'Medical Option' },
      keyStrategy: {
        type: 'planCode',
        strategies: ['planCode'],
        planCodeFields: 'Medical Option,Plan Name',
        tierFields: 'MED coverage type',
        uaFields: 'UA',
      },
    },
    {
      id: 'mw-dental',
      label: 'Dental',
      targetProductId: null,
      match: { mode: 'fieldNonBlank', field: 'Dental Option' },
      keyStrategy: {
        type: 'planCode',
        strategies: ['planCode'],
        planCodeFields: 'Dental Option',
      },
    },
    {
      id: 'mw-vision',
      label: 'Vision',
      targetProductId: null,
      match: { mode: 'fieldNonBlank', field: 'Vision' },
      keyStrategy: {
        type: 'planCode',
        strategies: ['planCode'],
        planCodeFields: 'Vision',
      },
    },
  ],
});

const SHAREWELL_DEFAULT_RULES = normalizeImportRules({
  planKey: {
    strategies: ['planCode', 'tierUa'],
    planCodeFields: 'Plan Name,Product Name',
    tierFields: 'Plan Tier,Family Size Tier',
    uaFields: 'UA',
    tierUaSuffixRegex: '(\\d{3,6})(EE|ES|EC|EF)$',
    uaRelabel: [],
  },
});

const DEFAULT_TOBACCO_COLUMN = 'Tobacco Surcharge';
const ALIGN_TOBACCO_YES = ['100'];

const PRESETS = {
  sharewell_default: {
    slug: 'sharewell_default',
    label: 'ShareWELL Standard (24-col)',
    template: SHAREWELL_24_COLUMN_TEMPLATE,
    sortOrder: 10,
    importRules: SHAREWELL_DEFAULT_RULES,
    tobaccoCsvColumn: DEFAULT_TOBACCO_COLUMN,
    tobaccoYesValues: [],
  },
  sharewell_calstar: {
    slug: 'sharewell_calstar',
    label: 'Calstar (native SFTP)',
    template:
      '{PrimarySSN:Primary SSN},{CalStarInsuredType:Insured Type},{LastName:Last Name},{FirstName:First Name},{MiddleInitial:MI},' +
      '{DOB:Date Of Birth},{Gender:Sex},{Phone1:Phone Number},{Email:Email Address},' +
      '{AddressLine1:Address},{AddressLine2:Address2},{City:City},{State:State},{ZipCode:Zip Code},' +
      '{EffectiveDate:Benefit Start Date},{TerminateDate:Benefit Term Date},' +
      '{UA:Plan Selected.1},{CalStarCoverageCode:Coverage.1},{TobaccoSurcharge:Nicotine use in last 36 months}',
    sortOrder: 20,
    importRules: SHAREWELL_DEFAULT_RULES,
    tobaccoCsvColumn: 'Nicotine use in last 36 months',
    tobaccoYesValues: [],
  },
  sharewell_align: {
    slug: 'sharewell_align',
    label: 'Align Health (native SFTP)',
    template:
      '{MemberIDBase:Member ID},{Relationship:Relationship},{FirstName:First Name},{MiddleInitial:Middle Name},{LastName:Last Name},' +
      '{DOB:Date of Birth},{Gender:Gender},{Phone1:Primary Phone},{Phone2:Alternate Phone},{Email:Email Address},' +
      '{AddressLine1:Mail Address 1},{AddressLine2:Mail Address 2},{City:Mail City},{State:Mail State},{ZipCode:Mail Zip},' +
      '{EffectiveDate:Plan Start},{TerminateDate:Terminate Date},{PlanTier:Coverage Tier},{UA:Deductible IUA},' +
      '{PlanPrice:Plan Base},{TobaccoSurcharge:Tobacco Surcharge},' +
      '{ABProductID:Product_ID},{ABBenefitIdOverride:Benefit_ID},' +
      '{PlanName:Plan Name},{PlanTier:Plan Tier}',
    sortOrder: 30,
    importRules: ALIGN_IMPORT_RULES,
    tobaccoCsvColumn: 'Tobacco Surcharge',
    tobaccoYesValues: ALIGN_TOBACCO_YES,
  },
  sharewell_align_sha: {
    slug: 'sharewell_align_sha',
    label: 'Align Health SHA (ShareWELL full eligibility)',
    template: SHAREWELL_FULL_ELIGIBILITY_TEMPLATE,
    sortOrder: 25,
    importRules: ALIGN_IMPORT_RULES,
    tobaccoCsvColumn: DEFAULT_TOBACCO_COLUMN,
    tobaccoYesValues: ALIGN_TOBACCO_YES,
  },
  sharewell_mpb: {
    slug: 'sharewell_mpb',
    label: 'MPowering Benefits (native SFTP)',
    template:
      '{AlternateID:Member_ID},{Relationship:Relationship},{FirstName:First_Name},{LastName:Last_Name},' +
      '{DOB:DOB},{Gender:Gender},{Phone1:Personal_Phone},{Email:Email},' +
      '{AddressLine1:Mailing_Street_1},{AddressLine2:Mailing_Street_2},{City:Mailing_City},{State:Mailing_State},{ZipCode:Mailing_Zip},' +
      '{EffectiveDate:Start_Date},{TerminateDate:Cancellation_Date},' +
      '{PlanName:Plan_Tier},{UA:UA},{TobaccoSurcharge:Tobacco_Surcharge}',
    sortOrder: 40,
    importRules: MPB_IMPORT_RULES,
    tobaccoCsvColumn: 'Tobacco_Surcharge',
    tobaccoYesValues: ['Yes'],
  },
};

function isSharewellVendorId(vendorId) {
  return String(vendorId || '').toLowerCase() === SHAREWELL_VENDOR_ID.toLowerCase();
}

function getPreset(slug) {
  if (!slug) return PRESETS.sharewell_default;
  return PRESETS[slug] || PRESETS.sharewell_default;
}

function listOptions() {
  return Object.values(PRESETS)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ slug, label, template, sortOrder, importRules, tobaccoCsvColumn, tobaccoYesValues }) => ({
      slug,
      label,
      template,
      sortOrder,
      importRules,
      tobaccoCsvColumn,
      tobaccoYesValues,
    }));
}

function hasSlug(slug) {
  return !!PRESETS[slug];
}

module.exports = {
  SHAREWELL_VENDOR_ID,
  ESSENTIAL_PRODUCT_ID,
  ESSENTIAL_2025_PRODUCT_ID,
  MPB_PRODUCT_ID,
  ALIGN_IMPORT_RULES,
  MPB_IMPORT_RULES,
  MIGHTYWELL_IMPORT_RULES,
  SHAREWELL_DEFAULT_RULES,
  PRESETS,
  isSharewellVendorId,
  getPreset,
  listOptions,
  hasSlug,
};
