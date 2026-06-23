'use strict';

const { MEMBER_ENROLLMENT_STATUS_CASE_BODY } = require('./memberEnrollmentStatusSql');

/**
 * AND … fragment for GET member list when query param enrollmentLifecycleStatus is set.
 * Values: paymentHold | enrollmentLinkSent | notEnrolled | noLinkSent
 * Requires same joins as list query (m, u).
 */
function getEnrollmentLifecycleFilterSql(enrollmentLifecycleStatus) {
  if (!enrollmentLifecycleStatus || typeof enrollmentLifecycleStatus !== 'string') {
    return '';
  }
  switch (enrollmentLifecycleStatus) {
    case 'paymentHold':
      return ` AND EXISTS (
                SELECT 1 FROM oe.Enrollments e
                WHERE e.MemberId = m.MemberId AND e.Status = N'PaymentHold'
            )`;
    case 'pendingMigration':
      return ` AND (
                m.IsPendingMigration = 1
                OR EXISTS (
                    SELECT 1 FROM oe.Enrollments e
                    WHERE e.MemberId = m.MemberId AND ISNULL(e.IsPendingMigration, 0) = 1
                )
            )`;
    case 'enrollmentLinkSent':
      return ` AND EXISTS (
                SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE())
            )
            AND NOT EXISTS (
                SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))
            )`;
    case 'notEnrolled':
      return ` AND (${MEMBER_ENROLLMENT_STATUS_CASE_BODY}) = N'Not Enrolled'`;
    case 'noLinkSent':
      return ` AND NOT EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId)`;
    default:
      return '';
  }
}

module.exports = { getEnrollmentLifecycleFilterSql };
