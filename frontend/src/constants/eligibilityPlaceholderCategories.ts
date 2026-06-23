/**
 * Eligibility row template placeholders for UI (grouped + searchable).
 * Must stay in sync with ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS in eligibilityRowTemplate.ts.
 */
import { ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS } from '../utils/eligibilityRowTemplate';

export type EligibilityPlaceholderEntry = string | { ph: string; hint?: string };

export type PlaceholderGuideSection = 'core' | 'extras';

export type EligibilityPlaceholderCategory = {
  section: PlaceholderGuideSection;
  label: string;
  subtitle?: string;
  placeholders: EligibilityPlaceholderEntry[];
};

/** Fixed literals / modifier patterns — typed in template, not validated as placeholder names. */
export type EligibilitySyntaxExtra = {
  label: string;
  insert: string;
  hint?: string;
  /** Only applied when generating eligibility CSV export — not on SFTP/member import. */
  exportOnly?: boolean;
};

export const ELIGIBILITY_PLACEHOLDER_SECTION_META: Record<
  PlaceholderGuideSection,
  { title: string; description: string }
> = {
  core: {
    title: 'Common fields',
    description: 'Typical eligibility import & ShareWELL-style layouts',
  },
  extras: {
    title: 'Extras & integrations',
    description: 'Carrier-specific, legacy export, payables, and format variants',
  },
};

export const ELIGIBILITY_PLACEHOLDER_CATEGORIES: EligibilityPlaceholderCategory[] = [
  // —— Core ——
  {
    section: 'core',
    label: 'Member & identity',
    subtitle: 'Names, IDs, relationship, dates of birth',
    placeholders: [
      { ph: 'LastName', hint: 'Last name' },
      { ph: 'FirstName', hint: 'First name' },
      { ph: 'MiddleInitial', hint: 'Middle name / initial' },
      { ph: 'NameSuffix', hint: 'Suffix' },
      { ph: 'Gender', hint: 'M / F' },
      { ph: 'Relationship', hint: 'Relationship text (e.g. Employee)' },
      { ph: 'RelationshipCode', hint: 'Relationship code' },
      { ph: 'DOB', hint: 'Date of birth' },
      { ph: 'DateOfBirth', hint: 'Alias for DOB' },
      { ph: 'EmployeeDateOfBirth', hint: 'Employee DOB' },
      { ph: 'DependentDateOfBirth', hint: 'Dependent DOB' },
      'MemberID',
      'MemberIDBase',
      'HouseholdMemberID',
      'HouseholdMemberIDBase',
      'AlternateID',
      'AlternateIDBase',
      'EmployeeSSN',
      'DependentSSN',
      'RestrictSSN',
      'EmployeeOrDependent',
      'RestrictedEmployee',
      'Age',
      'AgeIndependent',
      'DateOfHire',
    ],
  },
  {
    section: 'core',
    label: 'Address & contact',
    placeholders: [
      'AddressLine1',
      'AddressLine2',
      'City',
      'State',
      'ZipCode',
      'Phone1',
      'Phone2',
      'Email',
      'HomePhone',
      'WorkPhone',
      'CellPhone',
    ],
  },
  {
    section: 'core',
    label: 'Plans, groups & enrollment dates',
    subtitle: 'Bill type, vendor group ID, plan columns, effective/term dates',
    placeholders: [
      { ph: 'VendorGroupID', hint: 'Vendor group ID for group+product' },
      { ph: 'BillType', hint: 'LB list-bill / SB self-bill' },
      { ph: 'IntegrationPartner', hint: 'Partner label (e.g. AB365)' },
      { ph: 'ProductName', hint: 'Product name from enrollment' },
      { ph: 'PlanName', hint: 'Plan name (ShareWELL templates)' },
      { ph: 'PlanTier', hint: 'EE / ES / EC / EF' },
      { ph: 'UA', hint: 'Unshared amount / IUA' },
      { ph: 'PlanPrice', hint: 'Premium from enrollment or file' },
      { ph: 'TobaccoSurcharge', hint: 'Tobacco surcharge column' },
      { ph: 'EnrollmentDate', hint: 'Enrollment date' },
      { ph: 'EffectiveDate', hint: 'Coverage effective date' },
      { ph: 'TerminationDate', hint: 'Termination date' },
      { ph: 'TerminateDate', hint: 'Terminate date (ShareWELL)' },
      { ph: 'EligibilityChangeEffectiveDate', hint: 'Eligibility change effective' },
    ],
  },
  // —— Extras ——
  {
    section: 'extras',
    label: 'AB365 / Align',
    placeholders: [
      'ABProductID',
      'ABBenefitIdOverride',
      'RelationshipFullText',
      'ABPolicyNumber',
      'ABDependentID',
    ],
  },
  {
    section: 'extras',
    label: 'AllAboard group IDs',
    placeholders: ['AllAboardMasterGroupId', 'AllAboardGroupId'],
  },
  {
    section: 'extras',
    label: 'CalStar',
    placeholders: ['CalStarInsuredType', 'CalStarFamilySize', 'CalStarCoverageCode'],
  },
  {
    section: 'extras',
    label: 'Vendor / export metadata',
    placeholders: [
      'NetworkTitle',
      'LocationNumber',
      'GroupName',
      'VendorIndividualGroupId',
      'RecordType',
      'ProductID',
      'FamilySizeTier',
      'Premium',
    ],
  },
  {
    section: 'extras',
    label: 'Legacy benefit eligibility flags',
    placeholders: [
      'MedicalEligibility', 'MedicalCOB', 'DentalEligibility', 'DentalCOB',
      'VisionEligibility', 'VisionCOB', 'DrugEligibility', 'DrugCOB',
      'MiscellaneousEligibility', 'MiscellaneousCOB', 'LifeEligibility', 'LifeCOB',
      'LTDEligibility', 'STDEligibility',
    ],
  },
  {
    section: 'extras',
    label: 'Employment & dependent status',
    placeholders: [
      'Retiree', 'DisabilityEmployee', 'COBRAEmployee', 'DependentLifeCoverage',
      'MarriageStatus', 'MarriageDate', 'DomesticPartner',
    ],
  },
  {
    section: 'extras',
    label: 'Medical / dental / vision options',
    placeholders: [
      'MEDCoverageType', 'DENCoverageType', 'VISCoverageType',
      'MedicalOption', 'MedicalEffectiveDate',
      'DentalOption', 'DentalEffectiveDate',
      'VisionOption', 'Vision', 'VisionEffectiveDate',
    ],
  },
  {
    section: 'extras',
    label: 'Payables & NACHA export',
    subtitle: 'Mostly used on payables export templates',
    placeholders: [
      'PaidThroughStart', 'PaidThroughEnd', 'RespectiveBillingDate',
      'NACHASentDate', 'NACHASentDateMDY', 'NACHASentMonthFirstMDY',
      'AgentName', 'PolicyNumber', 'MemberState',
    ],
  },
  {
    section: 'extras',
    label: 'Template utilities',
    placeholders: [{ ph: 'Blank', hint: 'Empty CSV cell' }],
  },
  {
    section: 'extras',
    label: 'Aliases & format variants',
    subtitle: 'Alternate column names / transforms',
    placeholders: [
      'Bill_Type',
      'Address1',
      'Address2',
      'RelationshipCodeARM',
      'RelationshipCodeTT',
      'PrimarySSN',
      'EmployeeSSNNoDashes',
      'DependentSSNNoDashes',
      'DependentSuffixTT',
      'LastNameUpper',
      'FirstNameUpper',
      'StateUpper',
      'CityUpper',
      'AddressNoPunctuation',
      'InternationalAddressFlag',
      'Country',
      'CountryCode',
      'Language',
      'FaxNumber',
      'PhoneDigitsOnly',
    ],
  },
];

/** Literals and modifier snippets (insert as-is). */
export const ELIGIBILITY_TEMPLATE_SYNTAX_EXTRAS: EligibilitySyntaxExtra[] = [
  {
    label: 'Literal column',
    insert: '[Column label]',
    hint: 'Import + export: fixed cell value; edit text inside brackets',
  },
  {
    label: 'Custom header',
    insert: '{LastName:Last Name}',
    hint: 'Import + export: maps column by header label after colon',
  },
  {
    label: 'No trailing comma',
    insert: '{Email(nocomma)}',
    hint: 'Export only: strip commas from exported value',
    exportOnly: true,
  },
  {
    label: 'Date offset',
    insert: '{EffectiveDate(dateOffset=_/1/_)}',
    hint: 'Export only: shift date on export (_ keeps source part)',
    exportOnly: true,
  },
  {
    label: 'Value replace',
    insert: '{Gender(replace=M,Male)}',
    hint: 'Export only: replace substring in exported value (from,to)',
    exportOnly: true,
  },
];

export function placeholderEntryName(entry: EligibilityPlaceholderEntry): string {
  return typeof entry === 'string' ? entry : entry.ph;
}

export function placeholderEntryHint(entry: EligibilityPlaceholderEntry): string | undefined {
  return typeof entry === 'string' ? undefined : entry.hint;
}

function flattenCategoryPlaceholders(cats: EligibilityPlaceholderCategory[]): string[] {
  return cats.flatMap((cat) => cat.placeholders.map(placeholderEntryName));
}

/** Dev-time guard: every valid placeholder appears exactly once in categories. */
export function assertPlaceholderGuideComplete(): void {
  const listed = new Set(flattenCategoryPlaceholders(ELIGIBILITY_PLACEHOLDER_CATEGORIES));
  const missing = [...ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS].filter((p) => !listed.has(p)).sort();
  const extra = [...listed].filter((p) => !ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS.has(p)).sort();
  if (missing.length || extra.length) {
    throw new Error(
      `eligibilityPlaceholderCategories out of sync. missing=${missing.join(',')} extra=${extra.join(',')}`
    );
  }
}

if (import.meta.env?.DEV) {
  try {
    assertPlaceholderGuideComplete();
  } catch (e) {
    console.error(e);
  }
}
