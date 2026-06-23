'use strict';

const {
  householdHasUnmappedPlans,
  resolveImportHouseholdSkipPolicy,
} = require('../eligibilityImportHouseholdPolicy');

describe('eligibilityImportHouseholdPolicy', () => {
  const alignTenant = '7D5040ED-1105-4940-A352-FF85483B2C3C';
  const otherTenant = '11111111-1111-1111-1111-111111111111';

  test('householdHasUnmappedPlans detects skip_unmapped plan rows', () => {
    expect(householdHasUnmappedPlans([
      { action: 'enroll_update', planKey: 'EE_1500' },
      { action: 'skip_unmapped', planKey: 'FM_1500' },
    ])).toBe(true);
    expect(householdHasUnmappedPlans([{ action: 'enroll_update', planKey: 'EE_1500' }])).toBe(false);
    expect(householdHasUnmappedPlans([
      { action: 'enroll_update', planKey: 'ES_1500' },
      { action: 'skip_unmapped_other_row', planKey: 'Plan A' },
    ])).toBe(false);
  });

  test('default policy skips household with any unmapped plan', () => {
    const result = resolveImportHouseholdSkipPolicy({
      plans: [{ action: 'skip_unmapped', planKey: 'FM_1500' }],
      existing: { TenantId: alignTenant },
      tenantId: alignTenant,
    });
    expect(result).toEqual({ skip: true, reason: 'unmapped_plans' });
  });

  test('does not skip unmapped when skipHouseholdWithUnmappedPlans is false', () => {
    const result = resolveImportHouseholdSkipPolicy({
      skipHouseholdWithUnmappedPlans: false,
      plans: [{ action: 'skip_unmapped', planKey: 'FM_1500' }],
      existing: { TenantId: alignTenant },
      tenantId: alignTenant,
    });
    expect(result.skip).toBe(false);
  });

  test('default policy skips tenant mismatch without allowTenantMove', () => {
    const result = resolveImportHouseholdSkipPolicy({
      plans: [{ action: 'enroll_update', planKey: 'EE_1500' }],
      existing: { TenantId: otherTenant },
      tenantId: alignTenant,
    });
    expect(result).toEqual({ skip: true, reason: 'tenant_mismatch' });
  });

  test('allows tenant mismatch when allowTenantMove is true', () => {
    const result = resolveImportHouseholdSkipPolicy({
      allowTenantMove: true,
      plans: [{ action: 'enroll_update', planKey: 'EE_1500' }],
      existing: { TenantId: otherTenant },
      tenantId: alignTenant,
    });
    expect(result.skip).toBe(false);
  });

  test('unmapped takes precedence over tenant mismatch when both apply', () => {
    const result = resolveImportHouseholdSkipPolicy({
      plans: [
        { action: 'enroll_update', planKey: 'EE_1500' },
        { action: 'skip_unmapped', planKey: 'FM_1500' },
      ],
      existing: { TenantId: otherTenant },
      tenantId: alignTenant,
    });
    expect(result.reason).toBe('unmapped_plans');
  });
});
