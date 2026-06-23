// Validates GrantTierLevel against tenant oe.CommissionLevels (and optional agency whitelist).
const sql = require('mssql');
const { getPool } = require('../config/database');

const TIER_MATCH_EPSILON = 1e-4;

function tierLevelsMatch(a, b) {
  return Math.abs(Number(a) - Number(b)) < TIER_MATCH_EPSILON;
}

function parseEnabledCommissionLevelIds(settingsRaw) {
  if (!settingsRaw) return null;
  let settings = {};
  try {
    settings = typeof settingsRaw === 'string' ? JSON.parse(settingsRaw) : settingsRaw;
  } catch (_) {
    return null;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const ids = settings.enabledCommissionLevelIds;
  if (!Array.isArray(ids)) return null;
  const normalized = ids
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim().toUpperCase());
  return normalized.length ? normalized : null;
}

/**
 * Load allowed SortOrder values for onboarding link grant tiers.
 * @param {import('mssql').ConnectionPool | import('mssql').Transaction} poolOrTx
 * @param {{ tenantId: string; agencyId?: string | null }} opts
 * @returns {Promise<number[]>}
 */
async function loadAllowedGrantTierSortOrders(poolOrTx, { tenantId, agencyId = null }) {
  const mk = () => new sql.Request(poolOrTx);
  const levelsRes = await mk()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT CommissionLevelId, SortOrder
      FROM oe.CommissionLevels
      WHERE TenantId = @tenantId AND IsActive = 1
      ORDER BY SortOrder
    `);

  let tiers = (levelsRes.recordset || []).map((r) => ({
    commissionLevelId: r.CommissionLevelId ? String(r.CommissionLevelId) : null,
    sortOrder: Number(r.SortOrder)
  }));

  if (agencyId) {
    const sRes = await mk()
      .input('agencyId', sql.UniqueIdentifier, agencyId)
      .query(`SELECT Settings FROM oe.Agencies WHERE AgencyId = @agencyId`);
    const whitelistIdsUpper = parseEnabledCommissionLevelIds(sRes.recordset[0]?.Settings ?? null);
    if (whitelistIdsUpper && whitelistIdsUpper.length) {
      const allow = new Set(whitelistIdsUpper.map((x) => String(x).toUpperCase()));
      tiers = tiers.filter(
        (t) => t.commissionLevelId && allow.has(String(t.commissionLevelId).toUpperCase())
      );
    }
  }

  return tiers.map((t) => t.sortOrder);
}

/**
 * @param {number | null | undefined} grantTierLevel
 * @param {number[]} allowedSortOrders
 * @returns {{ valid: boolean; message?: string }}
 */
function validateGrantTierAgainstSortOrders(grantTierLevel, allowedSortOrders) {
  if (grantTierLevel === undefined || grantTierLevel === null || grantTierLevel === '') {
    return { valid: true };
  }
  const requested = Number(grantTierLevel);
  if (!Number.isFinite(requested)) {
    return { valid: false, message: 'Invalid grant tier level.' };
  }
  if (!allowedSortOrders.length) {
    return {
      valid: false,
      message: 'No commission tiers are configured for this tenant. Contact your administrator.'
    };
  }
  const match = allowedSortOrders.some((s) => tierLevelsMatch(s, requested));
  if (!match) {
    return {
      valid: false,
      message:
        'Grant tier level is not a valid commission tier for this organization. Choose a tier from your tenant configuration.'
    };
  }
  return { valid: true };
}

/**
 * @param {import('mssql').ConnectionPool | import('mssql').Transaction} poolOrTx
 * @param {{ tenantId: string; agencyId?: string | null; grantTierLevel?: number | null }} opts
 */
async function assertGrantTierAllowed(poolOrTx, opts) {
  const { tenantId, agencyId, grantTierLevel } = opts;
  if (grantTierLevel === undefined || grantTierLevel === null || grantTierLevel === '') {
    return { valid: true };
  }
  const allowed = await loadAllowedGrantTierSortOrders(poolOrTx, { tenantId, agencyId });
  return validateGrantTierAgainstSortOrders(grantTierLevel, allowed);
}

/**
 * Standalone check for public onboarding (pool).
 */
async function isGrantTierValidForTenant(tenantId, grantTierLevel, agencyId = null) {
  const pool = await getPool();
  const result = await assertGrantTierAllowed(pool, { tenantId, agencyId, grantTierLevel });
  return result.valid;
}

module.exports = {
  TIER_MATCH_EPSILON,
  tierLevelsMatch,
  loadAllowedGrantTierSortOrders,
  validateGrantTierAgainstSortOrders,
  assertGrantTierAllowed,
  isGrantTierValidForTenant
};
