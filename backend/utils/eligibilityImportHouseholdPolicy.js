'use strict';

function householdHasUnmappedPlans(plans) {
  return (plans || []).some((p) => p.action === 'skip_unmapped');
}

/**
 * Decide whether to skip committing a household during SFTP/manual import.
 *
 * @returns {{ skip: boolean, reason?: 'unmapped_plans'|'tenant_mismatch' }}
 */
function resolveImportHouseholdSkipPolicy({
  allowTenantMove = false,
  skipHouseholdWithUnmappedPlans = true,
  plans,
  existing,
  tenantId,
}) {
  if (skipHouseholdWithUnmappedPlans !== false && householdHasUnmappedPlans(plans)) {
    return { skip: true, reason: 'unmapped_plans' };
  }

  const tenantMismatch = Boolean(
    existing
    && tenantId
    && existing.TenantId
    && String(existing.TenantId).toLowerCase() !== String(tenantId).toLowerCase()
  );

  if (tenantMismatch && !allowTenantMove) {
    return { skip: true, reason: 'tenant_mismatch' };
  }

  return { skip: false };
}

const SKIP_REASON_LABELS = {
  missing_dependents: 'Skipped — plan tier requires dependents not present in file',
  unmapped_plans: 'Skipped — unmapped product/plan in file',
  tenant_mismatch: 'Skipped — member exists under a different tenant (tenant move disabled)',
};

module.exports = {
  householdHasUnmappedPlans,
  resolveImportHouseholdSkipPolicy,
  SKIP_REASON_LABELS,
};
