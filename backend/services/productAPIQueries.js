/**
 * Shared Product API query logic - single source of truth for:
 * - Pending activations (households needing sync)
 * - Synced households (eligible for update)
 * - Pending deactivations
 *
 * Used by api-pending (counts), run-api (batch), api-pending-deactivations (list).
 * No Status filter - EnrollmentType = 'Product' OR NULL only.
 */
const { sql } = require('../config/database');

// --- Base criteria (single source of truth) ---
const BASE_ENROLLMENT_TYPE = '(e.EnrollmentType = \'Product\' OR e.EnrollmentType IS NULL)';
const BASE_PRIMARY = 'm.RelationshipType = \'P\'';
const BASE_ACTIVE_TERM = '(e.TerminationDate IS NULL OR e.TerminationDate > @today)';
const BASE_TERMINATED = 'e.TerminationDate IS NOT NULL AND e.TerminationDate <= @today';
const NOT_EXISTS_ACTIVE_ENROLLMENT = `NOT EXISTS (
  SELECT 1 FROM oe.Enrollments e2
  WHERE e2.MemberId = e.MemberId
    AND e2.ProductId = e.ProductId
    AND e2.EnrollmentId != e.EnrollmentId
    AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @today)
    AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL)
)`;

/** Config filter fragment for api-pending counts (joins ProductAPIConfigs) */
const JOIN_CONFIG = 'JOIN oe.ProductAPIConfigs pac ON pac.ProductId = e.ProductId';
const FILTER_ENROLLMENT_ENABLED = "AND JSON_VALUE(pac.ConfigJson, '$.enrollment.enabled') = 'true'";
const FILTER_DEACTIVATION_ENABLED = "AND JSON_VALUE(pac.ConfigJson, '$.deactivation.enabled') = 'true'";

/**
 * Get Run Status counts for api-pending endpoint.
 * Respects enrollment.enabled and deactivation.enabled from config.
 */
async function getApiPendingCounts(pool, productId, today) {
  const req = (query) =>
    pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .input('today', sql.Date, today)
      .query(query);

  const [pendingHouseholds, pendingDeactivations, syncedHouseholds] = await Promise.all([
    req(`
      SELECT COUNT(DISTINCT m.HouseholdId) as cnt
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      ${JOIN_CONFIG}
      WHERE e.ProductId = @productId
        AND ${BASE_PRIMARY}
        AND ${BASE_ACTIVE_TERM}
        AND e.ExternalAPISyncedAt IS NULL
        AND ${BASE_ENROLLMENT_TYPE}
        ${FILTER_ENROLLMENT_ENABLED}
    `),
    req(`
      SELECT COUNT(*) as cnt
      FROM oe.Enrollments e
      ${JOIN_CONFIG}
      WHERE e.ProductId = @productId
        AND ${BASE_TERMINATED}
        AND e.ExternalAPISyncedAt IS NOT NULL
        AND e.ExternalAPIDeactivatedAt IS NULL
        ${FILTER_DEACTIVATION_ENABLED}
        AND ${NOT_EXISTS_ACTIVE_ENROLLMENT}
    `),
    req(`
      SELECT COUNT(DISTINCT m.HouseholdId) as cnt
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      ${JOIN_CONFIG}
      WHERE e.ProductId = @productId
        AND ${BASE_PRIMARY}
        AND ${BASE_ACTIVE_TERM}
        AND e.ExternalAPISyncedAt IS NOT NULL
        AND ${BASE_ENROLLMENT_TYPE}
        ${FILTER_ENROLLMENT_ENABLED}
    `)
  ]);

  return {
    pendingHouseholds: pendingHouseholds.recordset[0]?.cnt ?? 0,
    pendingDeactivations: pendingDeactivations.recordset[0]?.cnt ?? 0,
    syncedHouseholds: syncedHouseholds.recordset[0]?.cnt ?? 0
  };
}

/**
 * Enrollments needing activation (ExternalAPISyncedAt NULL, active).
 * Caller must ensure config.enrollment?.enabled.
 */
async function getActivationsToProcess(pool, productId, today) {
  const r = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .input('today', sql.Date, today)
    .query(`
      SELECT e.EnrollmentId, e.MemberId, e.HouseholdId, e.TerminationDate
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE e.ProductId = @productId
        AND ${BASE_PRIMARY}
        AND ${BASE_ACTIVE_TERM}
        AND e.ExternalAPISyncedAt IS NULL
        AND ${BASE_ENROLLMENT_TYPE}
    `);
  return r.recordset;
}

/**
 * Synced enrollments eligible for update (ExternalAPISyncedAt NOT NULL, active).
 * Caller must ensure config.update?.enabled.
 */
async function getUpdatesToProcess(pool, productId, today) {
  const r = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .input('today', sql.Date, today)
    .query(`
      SELECT e.EnrollmentId, e.MemberId, e.HouseholdId, e.TerminationDate
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE e.ProductId = @productId
        AND ${BASE_PRIMARY}
        AND ${BASE_ACTIVE_TERM}
        AND e.ExternalAPISyncedAt IS NOT NULL
        AND ${BASE_ENROLLMENT_TYPE}
    `);
  return r.recordset;
}

/**
 * Enrollments needing deactivation.
 * Caller must ensure config.deactivation?.enabled.
 */
async function getDeactivationsToProcess(pool, productId, today) {
  const r = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .input('today', sql.Date, today)
    .query(`
      SELECT e.EnrollmentId, e.MemberId, e.HouseholdId
      FROM oe.Enrollments e
      WHERE e.ProductId = @productId
        AND ${BASE_TERMINATED}
        AND e.ExternalAPISyncedAt IS NOT NULL
        AND e.ExternalAPIDeactivatedAt IS NULL
        AND ${NOT_EXISTS_ACTIVE_ENROLLMENT}
    `);
  return r.recordset;
}

/**
 * List of pending deactivations for modal (limited, with member names).
 * Respects deactivation.enabled from config.
 */
async function getPendingDeactivationsList(pool, productId, today, limit = 50) {
  const r = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .input('today', sql.Date, today)
    .input('limit', sql.Int, Math.min(Math.max(limit, 1), 200))
    .query(`
      SELECT TOP (@limit) e.EnrollmentId, e.MemberId, e.TerminationDate,
             u.FirstName, u.LastName
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      JOIN oe.Users u ON m.UserId = u.UserId
      ${JOIN_CONFIG}
      WHERE e.ProductId = @productId
        AND ${BASE_TERMINATED}
        AND e.ExternalAPISyncedAt IS NOT NULL
        AND e.ExternalAPIDeactivatedAt IS NULL
        ${FILTER_DEACTIVATION_ENABLED}
        AND ${NOT_EXISTS_ACTIVE_ENROLLMENT}
      ORDER BY e.TerminationDate ASC
    `);
  return r.recordset;
}

module.exports = {
  getApiPendingCounts,
  getActivationsToProcess,
  getUpdatesToProcess,
  getDeactivationsToProcess,
  getPendingDeactivationsList
};
