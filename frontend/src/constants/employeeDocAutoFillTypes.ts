export const EMPLOYEE_AUTOFILL_TYPES = [
  'GroupContributionEE', 'GroupContributionES', 'GroupContributionEC', 'GroupContributionEF',
  'EmployeeCostEE', 'EmployeeCostES', 'EmployeeCostEC', 'EmployeeCostEF',
] as const;

export type EmployeeAutoFillType = typeof EMPLOYEE_AUTOFILL_TYPES[number];

/**
 * AutoFillTypes allowed on templates with Category='Employee'.
 * Includes shared identity/branding types, plus the 8 new group-scoped ones.
 * Excludes business-scenario types that depend on form inputs the employee flow doesn't collect.
 */
export const EMPLOYEE_ALLOWED_AUTOFILL_TYPES = new Set<string>([
  // shared identity/branding (present in the base union)
  'AgentName', 'AgentAddress', 'AgentPhone', 'AgentEmail', 'AgentPhoto',
  'ClientName', 'ClientAddress', 'AgencyName',
  'TierDescription', 'TodaysDate', 'TodaysDateNumeric', 'CustomText',
  // new employee-specific
  ...EMPLOYEE_AUTOFILL_TYPES,
]);

/** Returns true when a given autoFillType value is allowed under the given Category. */
export function isAutoFillTypeAllowed(autoFillType: string, category: string | undefined): boolean {
  if (category !== 'Employee') return true; // General & Business retain full list
  return EMPLOYEE_ALLOWED_AUTOFILL_TYPES.has(autoFillType);
}
