/** Normalize GUID strings for case-insensitive tenant comparisons. */
function normTenantId(id) {
  return String(id || '').replace(/[{}]/gi, '').toLowerCase();
}

function tenantIdsMatch(a, b) {
  const na = normTenantId(a);
  const nb = normTenantId(b);
  return na !== '' && na === nb;
}

/** True when requested tenant is the user's primary or listed in AdditionalTenants. */
function userHasTenantAccess(requestedId, primaryId, additionalTenants) {
  if (tenantIdsMatch(requestedId, primaryId)) {
    return true;
  }
  if (!Array.isArray(additionalTenants)) {
    return false;
  }
  return additionalTenants.some((id) => tenantIdsMatch(id, requestedId));
}

module.exports = {
  normTenantId,
  tenantIdsMatch,
  userHasTenantAccess,
};
