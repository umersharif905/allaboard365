-- Rollback for Taylor Hutchinson's April-effective enrollments.
--
-- Background: An earlier ad-hoc data fix incorrectly cleared TerminationDate
-- on her 5 April-effective enrollments treating "TerminationDate < EffectiveDate"
-- as a bug. It is NOT a bug -- it is a legitimate cancel-before-effective
-- pattern (member signed up for an April plan and cancelled before 4/1).
--
-- Original values verified from allaboard-testing snapshot:
--   All 5 enrollments had TerminationDate = '2026-03-31', ModifiedDate = '2026-03-31 19:46:12.326'
--
-- This script restores TerminationDate so she correctly drops off the
-- vendor "Covered but Unpaid" list for April and is not flagged as actively
-- enrolled.
--
-- Member: B2859D04-5220-4B65-8DB5-C59504BCCE15 (Taylor Hutchinson)
-- Household: 6A2B0F28-53AD-47DB-B87E-CB919C70C675
--
-- The 2 stale RecurringScheduled placeholder Payments
-- (AEE25936-D701-402A-BE1A-66E7E4A8EB6E, 9D0163B8-3E8D-440A-B047-17312EFC50C7)
-- are intentionally left alone -- DIME's underlying recurring schedule was
-- already cancelled when she terminated 3/31, no charge fired on 4/1, and
-- those rows are inert placeholders that cannot trigger a charge themselves.

-- ============================================================
-- PRE-VERIFICATION: confirm current incorrect state
-- ============================================================
SELECT EnrollmentId, EnrollmentType, EffectiveDate, TerminationDate, ModifiedDate
FROM oe.Enrollments
WHERE EnrollmentId IN (
  'CBF549DB-3D54-4A67-9211-339DF2323A7D',
  '34782998-DF3F-47EF-97F0-35A0AA6EA0DE',
  '68BEB1B3-DA15-4AB1-B8A2-4E8656BED86A',
  '623535ED-F2AB-491D-A6FB-58A4AB378769',
  '8DC0FEEB-6520-4F18-B4F2-487AE241F014'
);
-- Expect: 5 rows, all with TerminationDate IS NULL (the bad state to fix)

-- ============================================================
-- ROLLBACK: restore TerminationDate = 2026-03-31
-- ============================================================
UPDATE oe.Enrollments
SET TerminationDate = '2026-03-31',
    ModifiedDate = SYSUTCDATETIME()
WHERE EnrollmentId IN (
  'CBF549DB-3D54-4A67-9211-339DF2323A7D',
  '34782998-DF3F-47EF-97F0-35A0AA6EA0DE',
  '68BEB1B3-DA15-4AB1-B8A2-4E8656BED86A',
  '623535ED-F2AB-491D-A6FB-58A4AB378769',
  '8DC0FEEB-6520-4F18-B4F2-487AE241F014'
);
-- Expect: (5 rows affected)

-- ============================================================
-- POST-VERIFICATION: confirm corrected state
-- ============================================================
SELECT EnrollmentId, EnrollmentType, EffectiveDate, TerminationDate, ModifiedDate
FROM oe.Enrollments
WHERE EnrollmentId IN (
  'CBF549DB-3D54-4A67-9211-339DF2323A7D',
  '34782998-DF3F-47EF-97F0-35A0AA6EA0DE',
  '68BEB1B3-DA15-4AB1-B8A2-4E8656BED86A',
  '623535ED-F2AB-491D-A6FB-58A4AB378769',
  '8DC0FEEB-6520-4F18-B4F2-487AE241F014'
);
-- Expect: 5 rows, all with TerminationDate = '2026-03-31'
