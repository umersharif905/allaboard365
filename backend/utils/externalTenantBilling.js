'use strict';

/**
 * Phase 5 hook: external tenants skip member-level billing/commission pipelines.
 * Use when Tenants.IsExternal = 1.
 */
function isExternalTenantBillingSuppressed(tenantRow) {
  if (!tenantRow) return false;
  return tenantRow.IsExternal === true || tenantRow.IsExternal === 1;
}

module.exports = { isExternalTenantBillingSuppressed };
