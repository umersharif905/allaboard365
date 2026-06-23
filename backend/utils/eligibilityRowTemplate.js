/**
 * Eligibility row template parsing and validation (shared with frontend eligibilityRowTemplate.ts).
 */

const ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS = new Set([
  'VendorGroupID', 'NetworkTitle', 'LocationNumber', 'BillType', 'Bill_Type', 'EmployeeOrDependent', 'EmployeeSSN', 'DependentSSN', 'RestrictSSN',
  'AlternateID', 'HouseholdMemberID', 'MemberID', 'AlternateIDBase', 'HouseholdMemberIDBase', 'MemberIDBase', 'RestrictedEmployee', 'LastName', 'FirstName', 'MiddleInitial', 'NameSuffix',
  'Gender', 'Relationship', 'RelationshipCode', 'RelationshipCodeARM', 'EmployeeDateOfBirth', 'DependentDateOfBirth', 'DateOfBirth', 'DOB', 'AgeIndependent', 'DateOfHire',
  'EnrollmentDate', 'TerminationDate', 'EffectiveDate', 'TerminateDate', 'EligibilityChangeEffectiveDate', 'AddressLine1', 'AddressLine2', 'Address1', 'Address2',
  'InternationalAddressFlag', 'City', 'State', 'ZipCode', 'Country', 'CountryCode', 'Language',
  'HomePhone', 'WorkPhone', 'Phone1', 'Phone2', 'CellPhone', 'FaxNumber', 'PhoneDigitsOnly', 'Email', 'RecordType', 'ProductName', 'PlanName', 'PlanTier', 'FamilySizeTier', 'CalStarInsuredType', 'CalStarFamilySize', 'CalStarCoverageCode', 'Age', 'Blank', 'PlanPrice', 'UA', 'TobaccoSurcharge',
  'IntegrationPartner',
  'Retiree', 'DisabilityEmployee', 'COBRAEmployee', 'DependentLifeCoverage', 'MarriageStatus', 'MarriageDate', 'DomesticPartner',
  'MedicalEligibility', 'MedicalCOB', 'DentalEligibility', 'DentalCOB', 'VisionEligibility', 'VisionCOB',
  'DrugEligibility', 'DrugCOB', 'MiscellaneousEligibility', 'MiscellaneousCOB', 'LifeEligibility', 'LifeCOB',
  'LTDEligibility', 'STDEligibility',
  'PrimarySSN', 'EmployeeSSNNoDashes', 'DependentSSNNoDashes', 'DependentSuffixTT', 'RelationshipCodeTT',
  'LastNameUpper', 'FirstNameUpper', 'StateUpper', 'CityUpper', 'AddressNoPunctuation', 'GroupName', 'VendorIndividualGroupId',
  'MEDCoverageType', 'DENCoverageType', 'VISCoverageType', 'MedicalOption', 'MedicalEffectiveDate',
  'DentalOption', 'DentalEffectiveDate', 'VisionOption', 'Vision', 'VisionEffectiveDate',
  'ABProductID', 'ABBenefitIdOverride', 'RelationshipFullText', 'ABPolicyNumber', 'ABDependentID',
  'AllAboardMasterGroupId', 'AllAboardGroupId',
  'Premium', 'PaidThroughStart', 'PaidThroughEnd', 'CoveragePeriod', 'RespectiveBillingDate', 'NACHASentDate', 'NACHASentDateMDY', 'NACHASentMonthFirstMDY', 'AgentName', 'PolicyNumber', 'ProductID', 'MemberState',
]);

const SHAREWELL_24_COLUMN_TEMPLATE =
  '{IntegrationPartner:Integration Partner},{BillType:Bill Type},{Relationship:Relationship},{FirstName:First Name},{LastName:Last Name},{MiddleInitial:Middle Name},{Phone1:Phone1},{Phone2:Phone2},{Email:Email},{Address1:Address1},{Address2:Address2},{City:City},{State:State},{ZipCode:Zip},{DOB:DoB},{Gender:Gender},{PlanName:Plan Name},{PlanTier:Plan Tier},{EffectiveDate:Effective Date},{TerminateDate:Terminate Date},{PlanPrice:Plan Price},{UA:UA},{TobaccoSurcharge:Tobacco Surcharge},{MemberIDBase:Member ID}';

/** ShareWELL 35-column eligibility export (Self/Spouse/Child + Subscribe ID + Product_ID/Benefit_ID). */
const SHAREWELL_FULL_ELIGIBILITY_TEMPLATE =
  '{IntegrationPartner:Integration Partner},{BillType:List Bill},{Relationship:Relationship},{PrimarySSN:Subscribe ID},{MemberIDBase:Member ID},' +
  '{FirstName:First Name},{LastName:Last Name},{MiddleInitial:Middle Name},{Phone1:Primary Phone},{Phone2:Alternate Phone},{Email:Email Address},' +
  '{AddressLine1:Mail Address 1},{AddressLine2:Mail Address 2},{City:Mail City},{State:Mail State},{ZipCode:Mail Zip},{DOB:Date of Birth},{Gender:Gender},' +
  '{PlanName:Plan Name},{PlanTier:Coverage Tier},{EffectiveDate:Plan Start},{TerminateDate:Terminate Date},' +
  '{PlanPrice:Plan Base},{UA:Deductible IUA},{TobaccoSurcharge:Tobacco Surcharge},' +
  '{ABProductID:Product_ID},{ABBenefitIdOverride:Benefit_ID}';

const AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE = `${SHAREWELL_24_COLUMN_TEMPLATE},{ABProductID:AB_ProductID},{ABBenefitIdOverride:AB_BenefitID},{RelationshipFullText:RelationshipFullText},{ABPolicyNumber:ABPolicyNumber},{ABDependentID:ABDependentID}`;

function stripEligibilityPlaceholderModifiersFromNamesStr(nameStr) {
  let s = String(nameStr || '');
  for (;;) {
    const prev = s;
    s = s
      .replace(/\(replace=[^)]*\)$/, '')
      .replace(/\(nocomma\)$/, '')
      .replace(/\(dateOffset=[^)]*\)$/, '')
      .trim();
    if (s === prev) break;
  }
  return s;
}

function extractModifiers(nameStr) {
  const mods = [];
  let s = nameStr;
  const rep = s.match(/\(replace=([^,)]+),([^)]*)\)$/);
  if (rep) {
    mods.push(`replace=${rep[1]},${rep[2]}`);
    s = s.slice(0, rep.index).trim();
  }
  if (s.endsWith('(nocomma)')) mods.push('nocomma');
  const dOff = s.match(/\(dateOffset=([^)]+)\)$/);
  if (dOff) mods.push(`dateOffset=${dOff[1]}`);
  return mods;
}

function isTemplateLiteralPlaceholder(name) {
  return name.length >= 2 && name.startsWith('[') && name.endsWith(']');
}

function parseEligibilityTemplateColumns(template) {
  const trimmed = (template || '').trim();
  if (!trimmed) return [];

  const regex = /\{([^}]+)\}/g;
  const columns = [];
  let m;
  let index = 0;

  while ((m = regex.exec(trimmed)) !== null) {
    const content = m[1].trim();
    const lastColon = content.lastIndexOf(':');
    const nameStr = lastColon >= 0 ? content.slice(0, lastColon).trim() : content;
    const label =
      (lastColon >= 0 ? content.slice(lastColon + 1).trim() : nameStr.split(',')[0].trim()) ||
      nameStr.split(',')[0].trim();
    const base = stripEligibilityPlaceholderModifiersFromNamesStr(nameStr);
    const placeholders = base.split(',').map((p) => p.trim()).filter(Boolean);
    const modifiers = extractModifiers(nameStr);

    columns.push({
      index: index++,
      placeholders,
      headerLabel: label,
      modifiers,
      rawToken: m[0],
    });
  }

  return columns;
}

function validateTemplatePlaceholders(template) {
  const trimmed = (template || '').trim();
  if (!trimmed) return [];

  const regex = /\{([^}]+)\}/g;
  const names = new Set();
  let m;

  while ((m = regex.exec(trimmed)) !== null) {
    const content = m[1].trim();
    const lastColon = content.lastIndexOf(':');
    const nameStr = lastColon >= 0 ? content.slice(0, lastColon).trim() : content;
    const base = stripEligibilityPlaceholderModifiersFromNamesStr(nameStr);
    base.split(',').forEach((part) => names.add(part.trim()));
  }

  return Array.from(names)
    .filter(
      (name) =>
        name &&
        !isTemplateLiteralPlaceholder(name) &&
        !ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS.has(name)
    )
    .sort();
}

function normalizeEligibilityRowTemplateValue(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean).join(',');
  }
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function coerceEligibilityFormatPatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};
  if (patch.eligibilityRowTemplate !== undefined) {
    const t = normalizeEligibilityRowTemplateValue(patch.eligibilityRowTemplate);
    if (t !== undefined) out.eligibilityRowTemplate = t;
  }
  if (patch.eligibilityDateFormat != null && String(patch.eligibilityDateFormat).trim()) {
    out.eligibilityDateFormat = String(patch.eligibilityDateFormat).trim();
  }
  if (patch.eligibilityIntegrationPartner != null) {
    out.eligibilityIntegrationPartner = String(patch.eligibilityIntegrationPartner).trim();
  }
  return out;
}

function validateProposalPatch(patch) {
  const cleaned = coerceEligibilityFormatPatch(patch);
  const warnings = [];
  if (cleaned.eligibilityRowTemplate !== undefined) {
    const invalid = validateTemplatePlaceholders(cleaned.eligibilityRowTemplate);
    if (invalid.length) {
      warnings.push(`Invalid placeholders: ${invalid.join(', ')}`);
    }
  }
  const validDateFormats = new Set(['ARM', 'Padded', 'TwoDigitYear', 'Compact']);
  if (cleaned.eligibilityDateFormat && !validDateFormats.has(cleaned.eligibilityDateFormat)) {
    warnings.push(`Unknown eligibilityDateFormat: ${cleaned.eligibilityDateFormat}`);
  }
  return { patch: cleaned, warnings };
}

module.exports = {
  ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS,
  SHAREWELL_24_COLUMN_TEMPLATE,
  SHAREWELL_FULL_ELIGIBILITY_TEMPLATE,
  AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE,
  stripEligibilityPlaceholderModifiersFromNamesStr,
  parseEligibilityTemplateColumns,
  validateTemplatePlaceholders,
  normalizeEligibilityRowTemplateValue,
  coerceEligibilityFormatPatch,
  validateProposalPatch,
};
