/**
 * CALCULATION INPUT REQUIREMENTS
 *
 * Maps each calculationType key (as placed on PDF template fields) to the
 * set of form inputs it requires. When an agent checks documents to generate,
 * the form scans the templates' calculation fields, unions the required inputs,
 * and dynamically shows only the relevant sections.
 *
 * Input field names match the shared input table in PROPOSAL_INPUTS_AND_CALCULATIONS.md.
 */

import type { ProposalField } from '../services/proposal.service';

// ---------------------------------------------------------------------------
// Input field groups — makes it easy to require a whole group at once
// ---------------------------------------------------------------------------

const COMPANY_INPUTS = ['companyName', 'companyAddress'] as const;
const WORKFORCE_INPUTS = ['totalEmployees'] as const;
const CURRENT_COVERAGE_INPUTS = [
  'hasExistingCoverage',
  'currentCountEE', 'currentCountE1', 'currentCountEF',
  'currentPremiumEE', 'currentPremiumE1', 'currentPremiumEF',
  'currentContributionType', 'currentContributionValueType', 'currentContributionValue',
  'currentContributionValueEE', 'currentContributionValueE1', 'currentContributionValueEF'
] as const;
const CURRENT_TIER_COUNTS = ['currentCountEE', 'currentCountE1', 'currentCountEF'] as const;
const CURRENT_TIER_PREMIUMS = ['currentPremiumEE', 'currentPremiumE1', 'currentPremiumEF'] as const;
const CURRENT_CONTRIBUTION_INPUTS = [
  'currentContributionType', 'currentContributionValueType', 'currentContributionValue',
  'currentContributionValueEE', 'currentContributionValueE1', 'currentContributionValueEF'
] as const;
const OOP_INPUTS = ['oopLevel'] as const;
const MW_TIER_COUNTS = ['mwCountEE', 'mwCountE1', 'mwCountEF'] as const;
const CONTRIBUTION_INPUTS = [
  'contributionType', 'contributionValueType', 'contributionValue',
  'contributionValueEE', 'contributionValueE1', 'contributionValueEF'
] as const;
const ENROLLMENT_DATE_INPUTS = ['enrollmentDate'] as const;
const PARTIAL_SWITCH_INPUTS = ['currentRemainCountEE', 'currentRemainCountE1', 'currentRemainCountEF'] as const;

// All shared inputs (everything except currentRemainCount)
const ALL_SHARED = [
  ...COMPANY_INPUTS, ...WORKFORCE_INPUTS, ...CURRENT_COVERAGE_INPUTS,
  ...OOP_INPUTS, ...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...ENROLLMENT_DATE_INPUTS
] as const;

// ---------------------------------------------------------------------------
// Every calculation type → required input fields
// ---------------------------------------------------------------------------

export const CALC_INPUT_REQUIREMENTS: Record<string, readonly string[]> = {
  // -- Company info (text fields, always needed) --
  companyName: COMPANY_INPUTS,
  companyAddress: COMPANY_INPUTS,

  // -- S1: Total MW Enrollees --
  calcTotalMwEnrollees: MW_TIER_COUNTS,
  calcMwTierCountDisplay_EE: ['mwCountEE'],
  calcMwTierCountDisplay_E1: ['mwCountE1'],
  calcMwTierCountDisplay_EF: ['mwCountEF'],

  // -- S2: Tier Mix Pct (per tier) --
  calcTierMixPct_EE: MW_TIER_COUNTS,
  calcTierMixPct_E1: MW_TIER_COUNTS,
  calcTierMixPct_EF: MW_TIER_COUNTS,

  // -- S3: MW Enrollment Pct --
  calcMwEnrollmentPct: [...MW_TIER_COUNTS, ...WORKFORCE_INPUTS],

  // -- S4: Current Enrollment Pct --
  // Participation percentage only needs how many are enrolled per tier + total employees.
  // Premiums and employer contribution are not inputs to a count ratio.
  calcCurrentEnrollmentPct: ['hasExistingCoverage', ...CURRENT_TIER_COUNTS, ...WORKFORCE_INPUTS],

  // -- S5: Not Enrolled Count --
  calcNotEnrolledCount: [...WORKFORCE_INPUTS, ...MW_TIER_COUNTS],
  calcNotEnrolledCountGeneric: [...WORKFORCE_INPUTS, ...MW_TIER_COUNTS],

  // -- S6: MW Tier Price (per tier — needs product slot + oopLevel) --
  calcMwTierPrice_EE: [...OOP_INPUTS],
  calcMwTierPrice_E1: [...OOP_INPUTS],
  calcMwTierPrice_EF: [...OOP_INPUTS],

  // -- S7: MW Tier Cost (per tier) --
  calcMwTierCost_EE: [...MW_TIER_COUNTS, ...OOP_INPUTS],
  calcMwTierCost_E1: [...MW_TIER_COUNTS, ...OOP_INPUTS],
  calcMwTierCost_EF: [...MW_TIER_COUNTS, ...OOP_INPUTS],

  // -- S8: MW Total Monthly --
  calcMwTotalMonthly: [...MW_TIER_COUNTS, ...OOP_INPUTS],

  // -- S9: MW Total Yearly --
  calcMwTotalYearly: [...MW_TIER_COUNTS, ...OOP_INPUTS],

  // -- S10: Unshared Amount Display --
  calcUnsharedAmountDisplay: [...OOP_INPUTS],

  // -- S11: Employer Contribution (per tier) --
  calcEmployerContrib_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerContrib_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerContrib_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],

  // -- S12: Employee Cost (per tier) --
  calcEmployeeCost_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeCost_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeCost_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],

  // -- S13: Total Employer MW Monthly --
  calcTotalEmployerMwMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS],

  // -- S14: Total Employer MW Yearly --
  calcTotalEmployerMwYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS],

  // -- S15: Total Employee Cost Monthly --
  calcTotalEmployeeCostMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS],

  // -- S16: Current Premium Yearly --
  calcCurrentPremiumYearly: [...CURRENT_COVERAGE_INPUTS],

  // -- S17–S20: Net Change / Savings --
  calcNetCostChangeMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcNetCostChangeYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcNetCostChangeMonthly_partial: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcNetCostChangeYearly_partial: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcNetCostChangeMonthly_generic: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcNetCostChangeYearly_generic: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcSavingsMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcSavingsYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcSavingsMonthly_partial: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcSavingsYearly_partial: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcSavingsMonthly_generic: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcSavingsYearly_generic: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcEmployerCostReductionPct_partial: [...CONTRIBUTION_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcEmployeeCostReductionPct_partial: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],

  // -- S21–S22: Net Enrollment Change --
  calcNetEnrollmentChangeCount: [...MW_TIER_COUNTS, ...CURRENT_COVERAGE_INPUTS, ...WORKFORCE_INPUTS],
  calcNetEnrollmentChangePct: [...MW_TIER_COUNTS, ...CURRENT_COVERAGE_INPUTS, ...WORKFORCE_INPUTS],

  // -- S23–S25: Calculation Steps --
  calcStepTierAlloc_EE: [...MW_TIER_COUNTS],
  calcStepTierAlloc_E1: [...MW_TIER_COUNTS],
  calcStepTierAlloc_EF: [...MW_TIER_COUNTS],
  calcStepTierCost_EE: [...MW_TIER_COUNTS, ...OOP_INPUTS],
  calcStepTierCost_E1: [...MW_TIER_COUNTS, ...OOP_INPUTS],
  calcStepTierCost_EF: [...MW_TIER_COUNTS, ...OOP_INPUTS],
  calcStepTotalCost: [...MW_TIER_COUNTS, ...OOP_INPUTS],

  // -- S26: Enrollment Dates --
  calcEnrollmentDatesDisplay: [...ENROLLMENT_DATE_INPUTS],

  // -- S27: Total Employees Display --
  calcTotalEmployeesDisplay: [...WORKFORCE_INPUTS],

  // -- S28: Current Premium Monthly --
  calcCurrentPremiumMonthly: [...CURRENT_COVERAGE_INPUTS],

  // -- S29: Net Change Premium Monthly (full plan cost comparison, before split) --
  calcNetChangePremiumMonthly: [...MW_TIER_COUNTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],

  // -- S30: Net Change Premium Yearly --
  calcNetChangePremiumYearly: [...MW_TIER_COUNTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcOverallSavingsYearly_partial_beforeContrib: [...MW_TIER_COUNTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],

  // -- S31: Current Remain Count Display --
  calcCurrentRemainCountDisplay: [...PARTIAL_SWITCH_INPUTS],

  // -- S32: Avg Current Per-Employee Cost --
  calcAvgCurrentPerEmployee: [...CURRENT_COVERAGE_INPUTS],

  // ========== PARTIAL SWITCH (P3–P13) ==========
  calcCurrentRemainMonthly: [...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcCurrentRemainYearly: [...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcTotalProjectedEnrolled: [...MW_TIER_COUNTS, ...PARTIAL_SWITCH_INPUTS],
  calcProjectedEnrollmentPct: [...MW_TIER_COUNTS, ...WORKFORCE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcMixedEmployerMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcMixedEmployerYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcBlendedEmployerMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcBlendedEmployerYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcHeadlinePartialSwitch: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS, ...PARTIAL_SWITCH_INPUTS],
  calcPartMixMwCount: [...MW_TIER_COUNTS],
  calcPartMixRemainCount: [...PARTIAL_SWITCH_INPUTS],
  calcPartMixNotEnrolled: [...WORKFORCE_INPUTS, ...MW_TIER_COUNTS],
  calcNetBusinessImpact: [...MW_TIER_COUNTS, ...CURRENT_COVERAGE_INPUTS, ...WORKFORCE_INPUTS],

  // ========== GENERIC QUOTE (G3, G8) ==========

  calcHeadlineGenericQuote: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcStepEnrollment: [...MW_TIER_COUNTS, ...WORKFORCE_INPUTS],

  // ========== EMPLOYEE PROPOSAL (E1–E6) ==========

  calcEmployerContribDisplay_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerContribDisplay_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerContribDisplay_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerSharePct_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerSharePct_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerSharePct_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeSharePct_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeSharePct_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeSharePct_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeMonthlyCost_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeMonthlyCost_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeMonthlyCost_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeAnnualCost_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeAnnualCost_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployeeAnnualCost_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerAnnualContrib_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerAnnualContrib_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcEmployerAnnualContrib_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS],

  // ========== EMPLOYEE PROPOSAL — SAVINGS BY SWITCHING (E7–E8) ==========

  calcEmployeeSavingsMonthly_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcEmployeeSavingsMonthly_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcEmployeeSavingsMonthly_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcEmployeeSavingsYearly_EE: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcEmployeeSavingsYearly_E1: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcEmployeeSavingsYearly_EF: [...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],

  // ========== CURRENT PLAN DETAIL CALCULATIONS ==========

  calcCurrentTotalEnrolled: [...CURRENT_TIER_COUNTS],
  calcCurrentTierPriceDisplay_EE: [...CURRENT_TIER_PREMIUMS],
  calcCurrentTierPriceDisplay_E1: [...CURRENT_TIER_PREMIUMS],
  calcCurrentTierPriceDisplay_EF: [...CURRENT_TIER_PREMIUMS],
  calcCurrentTierCountDisplay_EE: [...CURRENT_TIER_COUNTS],
  calcCurrentTierCountDisplay_E1: [...CURRENT_TIER_COUNTS],
  calcCurrentTierCountDisplay_EF: [...CURRENT_TIER_COUNTS],
  calcCurrentTierCost_EE: [...CURRENT_TIER_COUNTS, ...CURRENT_TIER_PREMIUMS],
  calcCurrentTierCost_E1: [...CURRENT_TIER_COUNTS, ...CURRENT_TIER_PREMIUMS],
  calcCurrentTierCost_EF: [...CURRENT_TIER_COUNTS, ...CURRENT_TIER_PREMIUMS],
  calcCurrentTotalMonthly: [...CURRENT_TIER_COUNTS, ...CURRENT_TIER_PREMIUMS],
  calcCurrentTotalYearly: [...CURRENT_TIER_COUNTS, ...CURRENT_TIER_PREMIUMS],
  calcCurrentNotEnrolledCount: [...CURRENT_TIER_COUNTS, ...WORKFORCE_INPUTS],
  calcCurrentEmployerContrib_EE: [...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentEmployerContrib_E1: [...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentEmployerContrib_EF: [...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentEmployeeCost_EE: [...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentEmployeeCost_E1: [...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentEmployeeCost_EF: [...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentTotalEmployerMonthly: [...CURRENT_TIER_COUNTS, ...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentTotalEmployerYearly: [...CURRENT_TIER_COUNTS, ...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentTotalEmployeeCostMonthly: [...CURRENT_TIER_COUNTS, ...CURRENT_TIER_PREMIUMS, ...CURRENT_CONTRIBUTION_INPUTS],
  calcCurrentTierMixPct_EE: [...CURRENT_TIER_COUNTS],
  calcCurrentTierMixPct_E1: [...CURRENT_TIER_COUNTS],
  calcCurrentTierMixPct_EF: [...CURRENT_TIER_COUNTS],
  calcCurrentRemainEnrollmentPct: [...PARTIAL_SWITCH_INPUTS, ...WORKFORCE_INPUTS],

  // ========== PER-TIER REMAIN ON CURRENT PLAN (DISPLAY) ==========

  calcCurrentRemainTierCountDisplay_EE: ['currentRemainCountEE'],
  calcCurrentRemainTierCountDisplay_E1: ['currentRemainCountE1'],
  calcCurrentRemainTierCountDisplay_EF: ['currentRemainCountEF'],

  // ========== COMBINED COST (MW + REMAINING ON CURRENT) ==========

  calcCombinedPremiumMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...PARTIAL_SWITCH_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcCombinedPremiumYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...PARTIAL_SWITCH_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcCombinedEmployerMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...PARTIAL_SWITCH_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcCombinedEmployerYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...PARTIAL_SWITCH_INPUTS, ...CURRENT_COVERAGE_INPUTS],

  // ========== MW EMPLOYEE AGGREGATES ==========

  calcTotalEmployeeCostYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcAvgEmployeeCostMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS],
  calcAvgEmployeeCostYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS],

  // ========== NET EMPLOYEE COST CHANGE ==========

  calcAvgCurrentEmployeeCostMonthly: [...CURRENT_COVERAGE_INPUTS],
  calcAvgEmployeeCostChangeMonthly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
  calcAvgEmployeeCostChangeYearly: [...MW_TIER_COUNTS, ...CONTRIBUTION_INPUTS, ...OOP_INPUTS, ...CURRENT_COVERAGE_INPUTS],
};

// ---------------------------------------------------------------------------
// Calculation types that depend on product-slot pricing
// (these get _slot_N suffixes in multi-slot scenarios)
// ---------------------------------------------------------------------------

export const PRICING_DEPENDENT_CALC_TYPES = new Set([
  'calcMwTierPrice_EE', 'calcMwTierPrice_E1', 'calcMwTierPrice_EF',
  'calcMwTierCost_EE', 'calcMwTierCost_E1', 'calcMwTierCost_EF',
  'calcMwTotalMonthly', 'calcMwTotalYearly',
  'calcUnsharedAmountDisplay',
  'calcEmployerContrib_EE', 'calcEmployerContrib_E1', 'calcEmployerContrib_EF',
  'calcEmployeeCost_EE', 'calcEmployeeCost_E1', 'calcEmployeeCost_EF',
  'calcTotalEmployerMwMonthly', 'calcTotalEmployerMwYearly',
  'calcTotalEmployeeCostMonthly',
  'calcNetCostChangeMonthly', 'calcNetCostChangeYearly',
  'calcNetCostChangeMonthly_generic', 'calcNetCostChangeYearly_generic',
  'calcSavingsMonthly', 'calcSavingsYearly',
  'calcSavingsMonthly_generic', 'calcSavingsYearly_generic',
  'calcHeadlineGenericQuote',
  'calcStepTierCost_EE', 'calcStepTierCost_E1', 'calcStepTierCost_EF',
  'calcStepTotalCost',
  'calcEmployerContribDisplay_EE', 'calcEmployerContribDisplay_E1', 'calcEmployerContribDisplay_EF',
  'calcEmployerSharePct_EE', 'calcEmployerSharePct_E1', 'calcEmployerSharePct_EF',
  'calcEmployeeSharePct_EE', 'calcEmployeeSharePct_E1', 'calcEmployeeSharePct_EF',
  'calcEmployeeMonthlyCost_EE', 'calcEmployeeMonthlyCost_E1', 'calcEmployeeMonthlyCost_EF',
  'calcEmployeeAnnualCost_EE', 'calcEmployeeAnnualCost_E1', 'calcEmployeeAnnualCost_EF',
  'calcEmployerAnnualContrib_EE', 'calcEmployerAnnualContrib_E1', 'calcEmployerAnnualContrib_EF',
  'calcEmployeeSavingsMonthly_EE', 'calcEmployeeSavingsMonthly_E1', 'calcEmployeeSavingsMonthly_EF',
  'calcEmployeeSavingsYearly_EE', 'calcEmployeeSavingsYearly_E1', 'calcEmployeeSavingsYearly_EF',
  'calcNetChangePremiumMonthly', 'calcNetChangePremiumYearly',
  'calcOverallSavingsYearly_partial_beforeContrib',
  'calcMixedEmployerMonthly', 'calcMixedEmployerYearly',
  'calcBlendedEmployerMonthly', 'calcBlendedEmployerYearly',
]);

// ---------------------------------------------------------------------------
// Calculation types that need a tier config selector in the editor
// ---------------------------------------------------------------------------

export const TIER_SPECIFIC_CALC_TYPES = new Set([
  'calcTierMixPct', 'calcMwTierPrice', 'calcMwTierCost',
  'calcEmployerContrib', 'calcEmployeeCost',
  'calcStepTierAlloc', 'calcStepTierCost',
  'calcEmployerContribDisplay', 'calcEmployerSharePct',
  'calcEmployeeSharePct', 'calcEmployeeMonthlyCost',
  'calcEmployeeAnnualCost', 'calcEmployerAnnualContrib',
  'calcEmployeeSavingsMonthly', 'calcEmployeeSavingsYearly',
]);

// ---------------------------------------------------------------------------
// Form section groupings for the modal
// ---------------------------------------------------------------------------

export type FormSection =
  | 'company'
  | 'workforce'
  | 'currentCoverage'
  | 'planConfig'
  | 'mwTierCounts'
  | 'partialSwitch'
  | 'contribution'
  | 'enrollmentDates';

const INPUT_TO_SECTION: Record<string, FormSection> = {
  companyName: 'company',
  companyAddress: 'company',
  totalEmployees: 'workforce',
  hasExistingCoverage: 'currentCoverage',
  currentCountEE: 'currentCoverage',
  currentCountE1: 'currentCoverage',
  currentCountEF: 'currentCoverage',
  currentPremiumEE: 'currentCoverage',
  currentPremiumE1: 'currentCoverage',
  currentPremiumEF: 'currentCoverage',
  currentContributionType: 'currentCoverage',
  currentContributionValueType: 'currentCoverage',
  currentContributionValue: 'currentCoverage',
  currentContributionValueEE: 'currentCoverage',
  currentContributionValueE1: 'currentCoverage',
  currentContributionValueEF: 'currentCoverage',
  oopLevel: 'planConfig',
  mwCountEE: 'mwTierCounts',
  mwCountE1: 'mwTierCounts',
  mwCountEF: 'mwTierCounts',
  currentRemainCountEE: 'partialSwitch',
  currentRemainCountE1: 'partialSwitch',
  currentRemainCountEF: 'partialSwitch',
  contributionType: 'contribution',
  contributionValueType: 'contribution',
  contributionValue: 'contribution',
  contributionValueEE: 'contribution',
  contributionValueE1: 'contribution',
  contributionValueEF: 'contribution',
  enrollmentDate: 'enrollmentDates',
};

// ---------------------------------------------------------------------------
// Helper: derive required inputs from a set of ProposalFields
// ---------------------------------------------------------------------------

/**
 * Given the fields from one or more selected templates, return the set of
 * input field names the form must collect, and the set of form sections to show.
 */
export function deriveRequiredInputs(fields: ProposalField[]): {
  requiredInputs: Set<string>;
  requiredSections: Set<FormSection>;
} {
  const requiredInputs = new Set<string>();
  const requiredSections = new Set<FormSection>();

  // Company name and address are always required (text auto-fill fields)
  for (const input of COMPANY_INPUTS) {
    requiredInputs.add(input);
  }
  requiredSections.add('company');

  for (const field of fields) {
    // Calculation fields
    if (field.fieldType === 'calculation' && field.fieldName) {
      const calcType = field.fieldName;
      const inputs = CALC_INPUT_REQUIREMENTS[calcType];
      if (inputs) {
        for (const input of inputs) {
          requiredInputs.add(input);
        }
      }
    }

    // Auto-fill text fields for company name / address
    if (field.autoFillType === 'ClientName') {
      requiredInputs.add('companyName');
      requiredSections.add('company');
    }
    if (field.autoFillType === 'ClientAddress') {
      requiredInputs.add('companyAddress');
      requiredSections.add('company');
    }
  }

  // Derive sections from inputs
  for (const input of requiredInputs) {
    const section = INPUT_TO_SECTION[input];
    if (section) {
      requiredSections.add(section);
    }
  }

  return { requiredInputs, requiredSections };
}
