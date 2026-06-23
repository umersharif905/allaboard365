/** Valid eligibility row template placeholders (must match backend getPlaceholderToFieldMap keys). */
export const ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS = new Set([
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
  'Premium', 'VendorNetRate', 'ContractAmount', 'PaidAmount', 'Variance', 'Underpaid', 'Overpaid',
  'Health', 'Dental', 'AllApplicableProducts', 'ProductType',
  'PaidThroughStart', 'PaidThroughEnd', 'CoveragePeriod', 'RespectiveBillingDate', 'NACHASentDate', 'NACHASentDateMDY', 'NACHASentMonthFirstMDY', 'AgentName', 'PolicyNumber', 'ProductID', 'MemberState',
  'CoveragePeriodStart', 'CoveragePeriodEnd',
]);

export const SHAREWELL_24_COLUMN_TEMPLATE =
  '{IntegrationPartner:Integration Partner},{BillType:Bill Type},{Relationship:Relationship},{FirstName:First Name},{LastName:Last Name},{MiddleInitial:Middle Name},{Phone1:Phone1},{Phone2:Phone2},{Email:Email},{Address1:Address1},{Address2:Address2},{City:City},{State:State},{ZipCode:Zip},{DOB:DoB},{Gender:Gender},{PlanName:Plan Name},{PlanTier:Plan Tier},{EffectiveDate:Effective Date},{TerminateDate:Terminate Date},{PlanPrice:Plan Price},{UA:UA},{TobaccoSurcharge:Tobacco Surcharge},{MemberIDBase:Member ID}';

export const AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE = `${SHAREWELL_24_COLUMN_TEMPLATE},{ABProductID:AB_ProductID},{ABBenefitIdOverride:AB_BenefitID},{RelationshipFullText:RelationshipFullText},{ABPolicyNumber:ABPolicyNumber},{ABDependentID:ABDependentID}`;

export type EligibilityTemplateColumn = {
  index: number;
  placeholders: string[];
  headerLabel: string;
  modifiers: string[];
  optional: boolean;
  rawToken: string;
};

/** Strips optional-column prefix and suffix modifiers (matches backend). */
export function stripEligibilityPlaceholderModifiersFromNamesStr(nameStr: string): string {
  let s = nameStr.trim();
  if (s.startsWith('?')) s = s.slice(1).trim();
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

export function isOptionalTemplatePlaceholderName(name: string): boolean {
  return String(name || '').trim().startsWith('?');
}

function extractModifiers(nameStr: string): string[] {
  const mods: string[] = [];
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

export function isTemplateLiteralPlaceholder(name: string): boolean {
  return name.length >= 2 && name.startsWith('[') && name.endsWith(']');
}

/** Parse template into columns (matches backend formatAsCSVFromTemplate). */
export function parseEligibilityTemplateColumns(template: string): EligibilityTemplateColumn[] {
  const trimmed = (template || '').trim();
  if (!trimmed) return [];

  const regex = /\{([^}]+)\}/g;
  const columns: EligibilityTemplateColumn[] = [];
  let m: RegExpExecArray | null;
  let index = 0;

  while ((m = regex.exec(trimmed)) !== null) {
    const content = m[1].trim();
    const lastColon = content.lastIndexOf(':');
    const nameStr = lastColon >= 0 ? content.slice(0, lastColon).trim() : content;
    const label =
      (lastColon >= 0 ? content.slice(lastColon + 1).trim() : nameStr.split(',')[0].trim()) ||
      nameStr.split(',')[0].trim();
    const optional = isOptionalTemplatePlaceholderName(nameStr);
    const base = stripEligibilityPlaceholderModifiersFromNamesStr(nameStr);
    const placeholders = base.split(',').map((p) => p.trim()).filter(Boolean);
    const modifiers = extractModifiers(nameStr);

    columns.push({
      index: index++,
      placeholders,
      headerLabel: label,
      modifiers,
      optional,
      rawToken: m[0],
    });
  }

  return columns;
}

/** Collect invalid placeholder names (excludes bracket literals). */
export function validateTemplatePlaceholders(template: string): string[] {
  const trimmed = (template || '').trim();
  if (!trimmed) return [];

  const regex = /\{([^}]+)\}/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = regex.exec(trimmed)) !== null) {
    const content = m[1].trim();
    const lastColon = content.lastIndexOf(':');
    const nameStr = lastColon >= 0 ? content.slice(0, lastColon).trim() : content;
    const base = stripEligibilityPlaceholderModifiersFromNamesStr(nameStr);
    base.split(',').forEach((part) => {
      const n = part.trim();
      if (n.startsWith('?')) names.add(n.slice(1).trim());
      else names.add(n);
    });
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

export function getEligibilityTemplateErrors(template: string | undefined | null): string[] {
  return validateTemplatePlaceholders(template?.trim() || '');
}
