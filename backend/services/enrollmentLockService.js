'use strict';

/**
 * enrollmentLockService
 *
 * Provides the T-5 vendor-minimum lock check for the enrollment-link resolver.
 *
 * A group is "locked for new enrollment" when ALL of the following are true:
 *   1. The group is a Standard group (not ListBill).
 *   2. At least one vendor on the group has a MinimumEmployeesPerGroup set.
 *   3. The effective date (first of next month) is ≤5 days away.
 *   4. The current pending/active enrollment count is below the minimum.
 *   5. The specific member does NOT already have an in-flight enrollment on this
 *      group (mid-flow exception allows them to continue).
 */

const { getPool } = require('../config/database');
const { computeApplicableMinimum } = require('./vendorMinimumService');

/**
 * Returns the first day of the month following `today` (UTC).
 * Duplicated from belowMinimumCheckService to avoid cross-service coupling.
 *
 * TODO (Task 4.2): When PR #90 (groupEnrollmentCutoff.js) is merged, replace
 *   this with a call that resolves the tenant's adjusted 1st-of-month via
 *   `adjustFixedDateForGroupEnrollmentCutoff`.
 * @param {Date} today
 * @returns {Date}
 */
function firstOfNextMonth(today) {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
}

/**
 * Determine whether a group is locked for new enrollments due to the T-5
 * vendor-minimum window.
 *
 * @param {string|null} groupId
 * @param {string|null} memberId  – pass null for Agent-Static / Marketing links
 * @param {Date} [_now]  – injectable clock for testing; defaults to new Date()
 * @returns {Promise<{ locked: boolean, reason?: string, minimum?: number, currentCount?: number }>}
 */
async function isGroupLockedForNewEnrollment(groupId, memberId, _now) {
  if (!groupId) return { locked: false };

  const pool = await getPool();

  // Step 1: Check GroupType — ListBill groups never lock.
  const groupTypeResult = await pool.request()
    .input('GroupId', groupId)
    .query(`SELECT GroupType FROM oe.Groups WHERE GroupId = @GroupId`);

  if (!groupTypeResult.recordset.length) return { locked: false };
  if (groupTypeResult.recordset[0].GroupType === 'ListBill') return { locked: false };

  // Step 2: Check if there is a vendor minimum.
  const minimum = await computeApplicableMinimum(groupId);
  if (!minimum) return { locked: false };

  // Step 3: Check if we are within the T-5 window.
  const now = _now || new Date();
  const effectiveDate = firstOfNextMonth(now);
  const daysRemaining = Math.floor((effectiveDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (daysRemaining > 5) return { locked: false };

  // Step 4: Count current members with active/pending enrollments on this effective date.
  const countResult = await pool.request()
    .input('GroupId', groupId)
    .input('EffectiveDate', effectiveDate)
    .query(`
      SELECT COUNT(DISTINCT m.MemberId) AS Cnt
      FROM oe.Members m
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
      WHERE m.GroupId = @GroupId
        AND e.Status IN ('Active', 'Pending', 'Pending Payment')
        AND e.EffectiveDate = @EffectiveDate
    `);
  const currentCount = countResult.recordset[0].Cnt || 0;

  if (currentCount >= minimum) return { locked: false };

  // Step 5: Mid-flow exception — if this member already has a Pending/InFlight
  // enrollment on this group, allow them to continue.
  if (memberId) {
    const midFlowResult = await pool.request()
      .input('MemberId', memberId)
      .input('GroupId', groupId)
      .query(`
        SELECT COUNT(*) AS EnrollmentCount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE e.MemberId = @MemberId
          AND m.GroupId = @GroupId
          AND e.Status IN ('Pending', 'Pending Payment', 'Active')
      `);
    if ((midFlowResult.recordset[0].EnrollmentCount || 0) > 0) {
      return { locked: false };
    }
  }

  return {
    locked: true,
    reason: 'GROUP_BELOW_MINIMUM_LOCKED',
    minimum,
    currentCount
  };
}

module.exports = { isGroupLockedForNewEnrollment };
