'use strict';

/**
 * Shared SQL for enrolled-household counts and monthly roster premium totals.
 * Keep in sync with members page header stats (/api/metrics/members) and tenant dashboard.
 *
 * Requires member-row alias m = oe.Members; most callers also join u = oe.Users.
 */
const {
  MEMBER_LIST_MONTHLY_PREMIUM_SUM_SQL,
  MEMBER_ROSTER_AGG_SELECT_SQL,
  EXCLUDE_PENDING_MIGRATION_MEMBER_SQL,
  MEMBER_STATS_ACTIVE_ENROLLMENT_EXISTS_SQL,
  MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL,
} = require('./memberEnrollmentStatusSql');

/** AND fragments appended to member WHERE — primary with live (non-staging) enrollment. */
const ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL = `
  AND m.RelationshipType = N'P'
  AND m.HouseholdId IS NOT NULL
  ${EXCLUDE_PENDING_MIGRATION_MEMBER_SQL}
  AND ${MEMBER_STATS_ACTIVE_ENROLLMENT_EXISTS_SQL}`;

const DEFAULT_MEMBER_JOINS_SQL = `JOIN oe.Users u ON m.UserId = u.UserId`;

/** Joins commonly needed when list filters reference group/agent columns. */
const MEMBER_LIST_SUMMARY_JOINS_SQL = `
  JOIN oe.Users u ON m.UserId = u.UserId
  LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
  LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId`;

/**
 * @param {'all'|'group'|'individual'} [billType]
 * @returns {string}
 */
function buildBillTypeMemberSql(billType) {
  if (billType === 'group') return 'AND m.GroupId IS NOT NULL';
  if (billType === 'individual') return 'AND m.GroupId IS NULL';
  return '';
}

/**
 * Scalar subquery: enrolled primary households.
 * @param {{ memberWhereClause: string, billType?: 'all'|'group'|'individual', joinsSql?: string }} opts
 */
function buildEnrolledHouseholdCountSubquery({
  memberWhereClause,
  billType = 'all',
  joinsSql = DEFAULT_MEMBER_JOINS_SQL,
}) {
  return `(SELECT COUNT(DISTINCT m.HouseholdId)
    FROM oe.Members m
    ${joinsSql}
    WHERE ${memberWhereClause}
    ${ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL}
    ${buildBillTypeMemberSql(billType)})`;
}

/**
 * Scalar subquery: monthly roster premium (products + fee rows + rolled-in fees).
 * @param {{ memberWhereClause: string, joinsSql?: string }} opts
 */
function buildMonthlyRosterPremiumSubquery({
  memberWhereClause,
  joinsSql = DEFAULT_MEMBER_JOINS_SQL,
}) {
  return `(SELECT ${MEMBER_LIST_MONTHLY_PREMIUM_SUM_SQL}
    FROM (
      SELECT ${MEMBER_ROSTER_AGG_SELECT_SQL}
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      ${joinsSql}
      WHERE ${MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL}
      AND ${memberWhereClause}
      ${EXCLUDE_PENDING_MIGRATION_MEMBER_SQL}
      GROUP BY e.MemberId
    ) hhAgg)`;
}

/**
 * SELECT for tenant-scoped monthly / quarterly / annual roster premium.
 * @param {{ memberWhereClause: string }} opts
 */
function buildMonthlyRosterPremiumPeriodsQuery({ memberWhereClause }) {
  return `
    WITH MonthlyRoster AS (
      SELECT ${MEMBER_LIST_MONTHLY_PREMIUM_SUM_SQL} as monthlyRevenue
      FROM (
        SELECT ${MEMBER_ROSTER_AGG_SELECT_SQL}
        FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE ${MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL}
        AND ${memberWhereClause}
        ${EXCLUDE_PENDING_MIGRATION_MEMBER_SQL}
        GROUP BY e.MemberId
      ) hhAgg
    )
    SELECT
      monthlyRevenue,
      monthlyRevenue * 3 as quarterlyRevenue,
      monthlyRevenue * 12 as annualRevenue
    FROM MonthlyRoster`;
}

/**
 * Active groups with at least one enrolled primary household.
 * @param {{ tenantIdParam?: string }} [opts]
 */
function buildEnrolledGroupsCountSubquery({ tenantIdParam = '@tenantId' } = {}) {
  return `(SELECT COUNT(DISTINCT g.GroupId)
    FROM oe.Groups g
    INNER JOIN oe.Members m ON m.GroupId = g.GroupId
    INNER JOIN oe.Users u ON m.UserId = u.UserId
    WHERE g.TenantId = ${tenantIdParam}
      AND g.Status = 'Active'
      AND m.Status = 'Active'
      ${ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL})`;
}

/**
 * CTE body: distinct enrolled primary household ids (tenant or filtered scope).
 * @param {{ memberWhereClause: string }} opts
 */
function buildEnrolledPrimaryHouseholdsCte({ memberWhereClause }) {
  return `ActiveHouseholds AS (
    SELECT DISTINCT m.HouseholdId
    FROM oe.Members m
    INNER JOIN oe.Users u ON m.UserId = u.UserId
    WHERE ${memberWhereClause}
      ${ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL}
  )`;
}

/**
 * Members-page header metrics (role/agent/group scoped via memberWhereClause).
 * @param {{ memberWhereClause: string, joinsSql?: string }} opts
 */
function buildMemberMetricsSelectSql({
  memberWhereClause,
  joinsSql = DEFAULT_MEMBER_JOINS_SQL,
}) {
  return `
    SELECT
      (SELECT COUNT(*) FROM oe.Members m ${joinsSql} WHERE ${memberWhereClause}) as totalMembers,
      (SELECT COUNT(DISTINCT m.HouseholdId) FROM oe.Members m ${joinsSql}
        WHERE m.HouseholdId IS NOT NULL AND ${memberWhereClause}) as householdCount,
      ${buildEnrolledHouseholdCountSubquery({ memberWhereClause, joinsSql })} as enrolledHouseholdCount,
      (SELECT COUNT(*) FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId ${joinsSql}
        WHERE (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND ${memberWhereClause}) as activeEnrollments,
      ${buildMonthlyRosterPremiumSubquery({ memberWhereClause, joinsSql })} as monthlyPremiums,
      (SELECT ISNULL(AVG(e.PremiumAmount), 0) FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId ${joinsSql}
        WHERE (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND ${memberWhereClause}) as avgPremium`;
}

/**
 * List-table summary row (same enrolled-household + roster premium rules as header stats).
 * @param {{ memberWhereClause: string, joinsSql?: string }} opts
 */
function buildMemberListSummarySelectSql({
  memberWhereClause,
  joinsSql = MEMBER_LIST_SUMMARY_JOINS_SQL,
}) {
  return `
    SELECT
      ${buildEnrolledHouseholdCountSubquery({ memberWhereClause, joinsSql })} AS householdCount,
      ${buildMonthlyRosterPremiumSubquery({ memberWhereClause, joinsSql })} AS monthlyPremiums`;
}

/**
 * Tenant dashboard enrolled-household + premium snapshot.
 * @param {{ tenantIdParam?: string }} [opts]
 */
function buildTenantDashboardMetricsSelectSql({ tenantIdParam = '@tenantId' } = {}) {
  const memberWhere = `u.TenantId = ${tenantIdParam} AND m.Status = 'Active'`;
  return `
    SELECT
      ${buildEnrolledHouseholdCountSubquery({ memberWhereClause: memberWhere })} as activeHouseholds,
      ${buildEnrolledHouseholdCountSubquery({ memberWhereClause: memberWhere, billType: 'group' })} as groupHouseholds,
      ${buildEnrolledHouseholdCountSubquery({ memberWhereClause: memberWhere, billType: 'individual' })} as individualHouseholds,
      ${buildEnrolledGroupsCountSubquery({ tenantIdParam })} as groupCount,
      ${buildMonthlyRosterPremiumSubquery({ memberWhereClause: memberWhere })} as monthlyPremiumRevenue`;
}

/**
 * Month-over-month roster premium growth (current roster vs roster one month ago).
 * @param {{ memberWhereClause: string }} opts
 */
function buildMonthlyRosterPremiumGrowthQuery({ memberWhereClause }) {
  return `
    WITH CurrentMonthRevenue AS (
      SELECT ${MEMBER_LIST_MONTHLY_PREMIUM_SUM_SQL} as currentRevenue
      FROM (
        SELECT ${MEMBER_ROSTER_AGG_SELECT_SQL}
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        WHERE ${memberWhereClause}
          AND ${MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL}
          ${EXCLUDE_PENDING_MIGRATION_MEMBER_SQL}
        GROUP BY e.MemberId
      ) hhAgg
    ),
    LastMonthRevenue AS (
      SELECT ${MEMBER_LIST_MONTHLY_PREMIUM_SUM_SQL} as lastRevenue
      FROM (
        SELECT ${MEMBER_ROSTER_AGG_SELECT_SQL}
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        WHERE ${memberWhereClause}
          AND ${MEMBER_STATS_PREMIUM_ENROLLMENT_WHERE_SQL}
          ${EXCLUDE_PENDING_MIGRATION_MEMBER_SQL}
          AND e.CreatedDate < DATEADD(month, -1, GETUTCDATE())
          AND (e.TerminationDate IS NULL OR e.TerminationDate > DATEADD(month, -1, GETUTCDATE()))
        GROUP BY e.MemberId
      ) hhAgg
    )
    SELECT
      CASE
        WHEN l.lastRevenue = 0 THEN 0
        ELSE ROUND(((c.currentRevenue - l.lastRevenue) * 100.0) / l.lastRevenue, 2)
      END as quarterlyGrowth
    FROM CurrentMonthRevenue c, LastMonthRevenue l`;
}

module.exports = {
  ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL,
  DEFAULT_MEMBER_JOINS_SQL,
  MEMBER_LIST_SUMMARY_JOINS_SQL,
  buildBillTypeMemberSql,
  buildEnrolledHouseholdCountSubquery,
  buildMonthlyRosterPremiumSubquery,
  buildMonthlyRosterPremiumPeriodsQuery,
  buildEnrolledGroupsCountSubquery,
  buildEnrolledPrimaryHouseholdsCte,
  buildMemberMetricsSelectSql,
  buildMemberListSummarySelectSql,
  buildTenantDashboardMetricsSelectSql,
  buildMonthlyRosterPremiumGrowthQuery,
};
