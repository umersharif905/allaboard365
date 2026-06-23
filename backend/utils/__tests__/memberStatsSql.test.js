'use strict';

const {
  ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL,
  buildEnrolledHouseholdCountSubquery,
  buildMonthlyRosterPremiumSubquery,
  buildMemberListSummarySelectSql,
  buildTenantDashboardMetricsSelectSql,
  buildMemberMetricsSelectSql,
} = require('../memberStatsSql');

describe('memberStatsSql', () => {
  const memberWhere = `m.Status = 'Active' AND u.TenantId = @tenantId`;

  it('enrolled household requires primary with live non-staging enrollment', () => {
    expect(ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL).toContain("m.RelationshipType = N'P'");
    expect(ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL).toContain('IsPendingMigration');
    expect(ENROLLED_PRIMARY_HOUSEHOLD_MEMBER_WHERE_SQL).toContain("e.Status = N'Active'");
  });

  it('buildEnrolledHouseholdCountSubquery supports bill type split', () => {
    const groupSql = buildEnrolledHouseholdCountSubquery({
      memberWhereClause: memberWhere,
      billType: 'group',
    });
    expect(groupSql).toContain('AND m.GroupId IS NOT NULL');
    expect(groupSql).toContain(memberWhere);

    const individualSql = buildEnrolledHouseholdCountSubquery({
      memberWhereClause: memberWhere,
      billType: 'individual',
    });
    expect(individualSql).toContain('AND m.GroupId IS NULL');
  });

  it('buildMonthlyRosterPremiumSubquery uses SUM(PremiumAmount) and excludes migration staging', () => {
    const sql = buildMonthlyRosterPremiumSubquery({ memberWhereClause: memberWhere });
    expect(sql).toContain('PremiumSum');
    expect(sql).toContain("e.Status = N'Active'");
    expect(sql).toContain('IsPendingMigration');
    expect(sql).toContain(memberWhere);
  });

  it('buildMemberListSummarySelectSql aligns household and premium definitions', () => {
    const sql = buildMemberListSummarySelectSql({ memberWhereClause: memberWhere });
    expect(sql).toContain('householdCount');
    expect(sql).toContain('monthlyPremiums');
    expect(sql).toContain("m.RelationshipType = N'P'");
    expect(sql).toContain('PremiumSum');
  });

  it('buildTenantDashboardMetricsSelectSql exposes group and individual household splits', () => {
    const sql = buildTenantDashboardMetricsSelectSql();
    expect(sql).toContain('groupHouseholds');
    expect(sql).toContain('individualHouseholds');
    expect(sql).toContain('monthlyPremiumRevenue');
    expect(sql).toContain('u.TenantId = @tenantId');
  });

  it('buildMemberMetricsSelectSql matches members page header fields', () => {
    const sql = buildMemberMetricsSelectSql({ memberWhereClause: memberWhere });
    expect(sql).toContain('enrolledHouseholdCount');
    expect(sql).toContain('monthlyPremiums');
    expect(sql).toContain('totalMembers');
  });
});
