'use strict';

/**
 * Inner CASE only (no column alias). Same order as group members list.
 * Requires: m = oe.Members, u = oe.Users
 */
const MEMBER_ENROLLMENT_STATUS_CASE_BODY = `CASE 
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))) AND u.PasswordHash IS NULL THEN 'Pending Login'
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))) THEN 'Enrolled'
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending') THEN 'Pending Approval'
                    WHEN EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active') THEN 'Declined Coverage'
                    WHEN m.IsPendingMigration = 1
                        OR EXISTS (
                            SELECT 1 FROM oe.Enrollments e
                            WHERE e.MemberId = m.MemberId AND ISNULL(e.IsPendingMigration, 0) = 1
                        ) THEN 'Pending Migration'
                    WHEN m.Status = 'Terminated' THEN 'Terminated'
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId)
                        AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE())))
                        AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending') THEN 'Terminated'
                    WHEN EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE()))
                        AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))) THEN 'Enrollment Link Sent'
                    WHEN EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount > 0 AND el.IsActive = 1) THEN 'Enrollment Link Used'
                    ELSE 'Not Enrolled'
                END`;

const MEMBER_LIST_ENROLLMENT_STATUS_SQL = `
                ${MEMBER_ENROLLMENT_STATUS_CASE_BODY} AS EnrollmentStatus`;

/**
 * Latest active unused enrollment link CreatedDate (matches "Enrollment Link Sent" link pick).
 * Requires: m = oe.Members
 */
/**
 * Roster line amount — keep in sync with backend/utils/enrollmentRosterPremium.js
 * (product base + rolled-in fees; fee rows use PremiumAmount only).
 */
const ENROLLMENT_ROSTER_LINE_AMOUNT_SQL = `(
  COALESCE(e.PremiumAmount, 0)
  + CASE
      WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType IN (N'Product', N'Bundle'))
        AND e.ProductId IS NOT NULL
        AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
      THEN COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) + COALESCE(e.IncludedSystemFeeAmount, 0)
      ELSE 0
    END
)`;

/** Active rows + staging migration product rows only (not migration SystemFee staging). */
const MEMBER_LIST_PREMIUM_ENROLLMENT_WHERE_SQL = `(
  e.Status = N'Active'
  OR (
    ISNULL(e.IsPendingMigration, 0) = 1
    AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN (N'Product', N'Bundle'))
    AND e.ProductId IS NOT NULL
    AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
  )
)`;

/**
 * Member row is E123 migration staging — exclude from header stats / platform totals.
 * Requires alias m = oe.Members.
 */
const IS_PENDING_MIGRATION_MEMBER_SQL = `(
  m.IsPendingMigration = 1
  OR EXISTS (
    SELECT 1 FROM oe.Enrollments epm
    WHERE epm.MemberId = m.MemberId AND ISNULL(epm.IsPendingMigration, 0) = 1
  )
)`;

/** AND fragment: skip pending-migration households in aggregate stats. */
const EXCLUDE_PENDING_MIGRATION_MEMBER_SQL = `AND NOT ${IS_PENDING_MIGRATION_MEMBER_SQL}`;

/**
 * Live enrolled (non-staging) enrollment exists — for enrolled-household stats.
 * Requires alias m = oe.Members.
 */
const MEMBER_STATS_ACTIVE_ENROLLMENT_EXISTS_SQL = `EXISTS (
  SELECT 1 FROM oe.Enrollments e
  WHERE e.MemberId = m.MemberId
    AND e.Status = N'Active'
    AND ISNULL(e.IsPendingMigration, 0) = 0
    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
)`;

/** Premium rows for header stats — live Active only (no migration staging). Requires e = oe.Enrollments. */
const MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL = `(
  e.Status = N'Active'
  AND ISNULL(e.IsPendingMigration, 0) = 0
  AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
)`;

/** Per-member roster aggregates — monthly due is SUM(PremiumAmount) only. */
const MEMBER_ROSTER_AGG_SELECT_SQL = `
      SUM(COALESCE(e.PremiumAmount, 0)) AS PremiumSum`;

/** Roster premium: live Active rows plus staging migration product enrollments. */
const MEMBER_LIST_MONTHLY_PREMIUM_SQL = `ISNULL((
  SELECT agg.PremiumSum
  FROM (
    SELECT ${MEMBER_ROSTER_AGG_SELECT_SQL}
    FROM oe.Enrollments e
    WHERE e.MemberId = m.MemberId
      AND ${MEMBER_LIST_PREMIUM_ENROLLMENT_WHERE_SQL}
  ) agg
), 0) as MonthlyPremium`;

/** SUM expression for list summary totals (join e to filtered members). */
const MEMBER_LIST_MONTHLY_PREMIUM_SUM_SQL = `ISNULL(SUM(hhAgg.PremiumSum), 0)`;

const MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL = `
                (SELECT TOP 1 el.CreatedDate
                 FROM oe.EnrollmentLinks el
                 WHERE el.MemberId = m.MemberId
                   AND el.UsageCount = 0
                   AND el.IsActive = 1
                   AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE())
                 ORDER BY el.CreatedDate DESC) AS EnrollmentLinkSentAt`;

/**
 * EXISTS subquery for login-eligible enrollment on member m.
 * Includes PaymentHold / Pending Payment for app access parity with member enrollments API.
 */
const HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL = `
  EXISTS (
    SELECT 1 FROM oe.Enrollments e
    WHERE e.MemberId = m.MemberId
      AND e.Status IN ('Active', 'Pending', 'PaymentHold', 'Pending Payment')
      AND (
        (e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))
        OR (e.EffectiveDate > GETUTCDATE())
      )
  )
`;

/**
 * Primary member still on E123 migration staging with no live AB365 go-live enrollment.
 * Mobile OTP should defer to legacy ShareWELL login so plans/ID cards load from ShareWELLPartners SQL.
 * Requires alias m = oe.Members (primary row).
 */
const DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL = `
  m.RelationshipType = N'P'
  AND (m.Status IS NULL OR m.Status != N'Terminated')
  AND ${IS_PENDING_MIGRATION_MEMBER_SQL}
  AND NOT EXISTS (
    SELECT 1 FROM oe.Enrollments e
    WHERE e.MemberId = m.MemberId
      AND e.Status = N'Active'
      AND ISNULL(e.IsPendingMigration, 0) = 0
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
  )
`;

module.exports = {
  MEMBER_ENROLLMENT_STATUS_CASE_BODY,
  MEMBER_LIST_ENROLLMENT_STATUS_SQL,
  ENROLLMENT_ROSTER_LINE_AMOUNT_SQL,
  MEMBER_LIST_PREMIUM_ENROLLMENT_WHERE_SQL,
  IS_PENDING_MIGRATION_MEMBER_SQL,
  EXCLUDE_PENDING_MIGRATION_MEMBER_SQL,
  MEMBER_STATS_ACTIVE_ENROLLMENT_EXISTS_SQL,
  MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL,
  MEMBER_LIST_MONTHLY_PREMIUM_SQL,
  MEMBER_LIST_MONTHLY_PREMIUM_SUM_SQL,
  MEMBER_ROSTER_AGG_SELECT_SQL,
  MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL,
  HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL,
  DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL,
};

