'use strict';

const {
  DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL,
  IS_PENDING_MIGRATION_MEMBER_SQL,
} = require('../memberEnrollmentStatusSql');

describe('DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL', () => {
  it('requires primary member pending migration staging', () => {
    expect(DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL).toContain("m.RelationshipType = N'P'");
    expect(DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL).toContain(IS_PENDING_MIGRATION_MEMBER_SQL.trim());
  });

  it('defers until a live non-staging Active enrollment exists', () => {
    expect(DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL).toContain("e.Status = N'Active'");
    expect(DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL).toContain('ISNULL(e.IsPendingMigration, 0) = 0');
    expect(DEFER_MOBILE_LOGIN_TO_LEGACY_WHERE_SQL).toContain('NOT EXISTS');
  });
});
