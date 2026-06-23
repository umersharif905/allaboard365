'use strict';

const sql = require('mssql');
const { getCohortFromDate } = require('../utils/billingCohort');

/**
 * Look up a household's billing cohort from its currently-active enrollments.
 *
 * Returns 'FIRST', 'FIFTEENTH', or null. A null result means the household
 * has no active enrollments — callers should fall back to the group's
 * AllowMidMonthEffective flag for cohort selection.
 *
 * Households are required to be single-cohort: every active enrollment in
 * the household must share the same cohort so the family has one bill per
 * period. The API validator (`isValidEarliestEffectiveDate`) enforces this
 * on insert. We trust that constraint and read the cohort from any active
 * enrollment.
 *
 * Legacy enrollments with EffectiveDates that aren't day 1 or 15 (pre-cohort
 * data) return null so callers don't accidentally lock the household to a
 * non-cohort date.
 */
async function getHouseholdCohort(pool, householdId) {
  if (!householdId) return null;
  const result = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 EffectiveDate
      FROM oe.Enrollments
      WHERE HouseholdId = @householdId
        AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
        AND Status IN ('Active', 'Pending', 'Pending Payment')
      ORDER BY EffectiveDate DESC, CreatedDate DESC
    `);
  if (!result.recordset.length) return null;
  try {
    return getCohortFromDate(new Date(result.recordset[0].EffectiveDate));
  } catch {
    return null;
  }
}

/**
 * Resolve a member's household cohort. Convenience wrapper that joins through
 * oe.Members so callers don't need the HouseholdId in hand.
 */
async function getHouseholdCohortByMemberId(pool, memberId) {
  if (!memberId) return null;
  const result = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      SELECT TOP 1 e.EffectiveDate
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON m.MemberId = @memberId
      WHERE e.HouseholdId = m.HouseholdId
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.Status IN ('Active', 'Pending', 'Pending Payment')
      ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
    `);
  if (!result.recordset.length) return null;
  try {
    return getCohortFromDate(new Date(result.recordset[0].EffectiveDate));
  } catch {
    return null;
  }
}

const BATCH_CHUNK = 80;

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} householdIds
 * @returns {Promise<Map<string, 'FIRST'|'FIFTEENTH'|null>>}
 */
async function batchGetHouseholdCohortMap(pool, householdIdsRaw) {
  const map = new Map();
  const householdIds = [...new Set((householdIdsRaw || []).filter(Boolean).map((x) => String(x)))];
  if (householdIds.length === 0) return map;

  for (let i = 0; i < householdIds.length; i += BATCH_CHUNK) {
    const chunk = householdIds.slice(i, i + BATCH_CHUNK);
    const req = pool.request();
    chunk.forEach((id, idx) => req.input(`h${idx}`, sql.UniqueIdentifier, id));
    const inList = chunk.map((_, idx) => `@h${idx}`).join(', ');
    const result = await req.query(`
      WITH ranked AS (
        SELECT e.HouseholdId, e.EffectiveDate,
          ROW_NUMBER() OVER (
            PARTITION BY e.HouseholdId
            ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
          ) AS rn
        FROM oe.Enrollments e
        WHERE e.HouseholdId IN (${inList})
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.Status IN ('Active', 'Pending', 'Pending Payment')
      )
      SELECT HouseholdId, EffectiveDate FROM ranked WHERE rn = 1
    `);
    for (const r of result.recordset || []) {
      const hid = String(r.HouseholdId);
      try {
        map.set(hid, getCohortFromDate(new Date(r.EffectiveDate)));
      } catch {
        map.set(hid, null);
      }
    }
  }
  return map;
}

module.exports = {
  getHouseholdCohort,
  getHouseholdCohortByMemberId,
  batchGetHouseholdCohortMap
};
