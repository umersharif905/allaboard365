/*
  Purge corrupted 2026-05-29 Align Health eligibility import (wrong household merges).

  Scope: ONLY tenant "Align Health" (7D5040ED-1105-4940-A352-FF85483B2C3C)
         AND members created on 2026-05-29 (the bad import batch; tenant had 0 members before).

  Does NOT touch any other tenant. Aborts if pre-import members exist on this tenant.

  Run dry-run (default) on OpenEnroll prod:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-05-30-align-health-purge-bad-import.sql

  REQUIRED DATABASE: allaboard-prod (OpenEnroll). Do NOT run against Sharewell.

  Apply (only after reviewing dry-run output):
    Edit @DryRun = 0, re-run with explicit approval.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @TenantId UNIQUEIDENTIFIER = '7D5040ED-1105-4940-A352-FF85483B2C3C';
DECLARE @ImportDate DATE = '2026-05-29';
DECLARE @ImportDateText NVARCHAR(10) = CONVERT(NVARCHAR(10), @ImportDate, 23);
DECLARE @ExpectedTenantName NVARCHAR(200) = N'Align Health';
DECLARE @DbName SYSNAME = DB_NAME();

BEGIN TRY
  ---------------------------------------------------------------------------
  -- Database guard (oe.Tenants exists on allaboard-prod / allaboard-testing only)
  ---------------------------------------------------------------------------
  IF OBJECT_ID(N'oe.Members', N'U') IS NULL OR OBJECT_ID(N'oe.Tenants', N'U') IS NULL
  BEGIN
    RAISERROR(
      N'Wrong database: oe.Members / oe.Tenants not found (connected to %s). Run on OpenEnroll allaboard-prod, NOT Sharewell.',
      16, 1, @DbName
    );
    RETURN;
  END

  IF @DbName NOT IN (N'allaboard-prod', N'allaboard-testing')
  BEGIN
    RAISERROR(
      N'Unexpected database %s. Expected allaboard-prod or allaboard-testing.',
      16, 1, @DbName
    );
    RETURN;
  END

  ---------------------------------------------------------------------------
  -- Safety guards
  ---------------------------------------------------------------------------
  DECLARE @ActualTenantName NVARCHAR(200);
  SELECT @ActualTenantName = Name FROM oe.Tenants WHERE TenantId = @TenantId;

  IF @ActualTenantName IS NULL
  BEGIN
    RAISERROR(N'Abort: tenant id not found.', 16, 1);
    RETURN;
  END

  IF @ActualTenantName <> @ExpectedTenantName
  BEGIN
    RAISERROR(N'Abort: tenant name mismatch (expected Align Health, got %s).', 16, 1, @ActualTenantName);
    RETURN;
  END

  DECLARE @PreImportMembers INT;
  SELECT @PreImportMembers = COUNT(*)
  FROM oe.Members m
  WHERE m.TenantId = @TenantId
    AND CAST(m.CreatedDate AS DATE) < @ImportDate;

  IF @PreImportMembers > 0
  BEGIN
    RAISERROR(N'Abort: %d member(s) on Align Health pre-date %s — refuse bulk delete.', 16, 1, @PreImportMembers, @ImportDateText);
    RETURN;
  END

  IF OBJECT_ID('tempdb..#TargetMembers') IS NOT NULL DROP TABLE #TargetMembers;
  CREATE TABLE #TargetMembers (
    MemberId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    UserId UNIQUEIDENTIFIER NOT NULL,
    HouseholdId UNIQUEIDENTIFIER NOT NULL
  );

  INSERT INTO #TargetMembers (MemberId, UserId, HouseholdId)
  SELECT m.MemberId, m.UserId, m.HouseholdId
  FROM oe.Members m
  WHERE m.TenantId = @TenantId
    AND CAST(m.CreatedDate AS DATE) = @ImportDate;

  IF NOT EXISTS (SELECT 1 FROM #TargetMembers)
  BEGIN
    RAISERROR(N'Abort: no import-batch members found for Align Health on %s.', 16, 1, @ImportDateText);
    RETURN;
  END

  IF OBJECT_ID('tempdb..#TargetUsers') IS NOT NULL DROP TABLE #TargetUsers;
  CREATE TABLE #TargetUsers (UserId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY);
  INSERT INTO #TargetUsers (UserId)
  SELECT DISTINCT UserId FROM #TargetMembers;

  ---------------------------------------------------------------------------
  -- Dry-run preview
  ---------------------------------------------------------------------------
  SELECT N'PREVIEW: tenant' AS Section, @ActualTenantName AS TenantName, @TenantId AS TenantId;

  SELECT N'PREVIEW: import batch counts' AS Section,
    (SELECT COUNT(*) FROM #TargetMembers) AS members_to_delete,
    (SELECT COUNT(DISTINCT HouseholdId) FROM #TargetMembers) AS households,
    (SELECT COUNT(*) FROM #TargetUsers) AS users_to_delete,
    (SELECT COUNT(*) FROM oe.MemberSourceKeys msk
      WHERE EXISTS (SELECT 1 FROM #TargetMembers t WHERE t.MemberId = msk.MemberId)) AS source_keys_to_delete,
    (SELECT COUNT(*) FROM oe.Enrollments e
      WHERE EXISTS (SELECT 1 FROM #TargetMembers t WHERE t.MemberId = e.MemberId)) AS enrollments_to_delete;

  SELECT N'PREVIEW: other tenants untouched (must be 0)' AS Section,
    COUNT(*) AS members_outside_tenant_in_target
  FROM #TargetMembers t
  INNER JOIN oe.Members m ON m.MemberId = t.MemberId
  WHERE m.TenantId <> @TenantId;

  SELECT N'PREVIEW: sample bad households (multi-primary)' AS Section;
  SELECT TOP 15
    p.HouseholdMemberID,
    u_p.FirstName + N' ' + u_p.LastName AS primary_name,
    SUM(CASE WHEN m.RelationshipType = N'P' THEN 1 ELSE 0 END) AS primary_count,
    SUM(CASE WHEN m.RelationshipType <> N'P' THEN 1 ELSE 0 END) AS dep_count
  FROM oe.Members m
  INNER JOIN #TargetMembers t ON t.MemberId = m.MemberId
  INNER JOIN oe.Members p ON p.MemberId = m.HouseholdId AND p.RelationshipType = N'P'
  INNER JOIN oe.Users u_p ON u_p.UserId = p.UserId
  GROUP BY m.HouseholdId, p.HouseholdMemberID, u_p.FirstName, u_p.LastName
  HAVING SUM(CASE WHEN m.RelationshipType = N'P' THEN 1 ELSE 0 END) > 1
  ORDER BY primary_count DESC;

  SELECT N'PREVIEW: total members on OTHER tenants (unchanged after script)' AS Section,
    COUNT(*) AS other_tenant_member_count
  FROM oe.Members m
  WHERE m.TenantId <> @TenantId;

  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN — no changes applied. Set @DryRun = 0 to purge Align import batch only.' AS Status;
    RETURN;
  END

  ---------------------------------------------------------------------------
  -- Apply deletes (child tables first)
  ---------------------------------------------------------------------------
  BEGIN TRAN;

  IF OBJECT_ID(N'oe.PaymentAttempts', N'U') IS NOT NULL
  BEGIN
    DELETE pa
    FROM oe.PaymentAttempts pa
    WHERE pa.MemberId IN (SELECT MemberId FROM #TargetMembers)
       OR pa.HouseholdId IN (SELECT DISTINCT HouseholdId FROM #TargetMembers);
  END

  IF OBJECT_ID(N'oe.Payments', N'U') IS NOT NULL
  BEGIN
    DELETE p
    FROM oe.Payments p
    WHERE p.HouseholdId IN (SELECT DISTINCT HouseholdId FROM #TargetMembers)
       OR (p.EnrollmentId IS NOT NULL AND EXISTS (
         SELECT 1 FROM oe.Enrollments e
         INNER JOIN #TargetMembers t ON t.MemberId = e.MemberId
         WHERE e.EnrollmentId = p.EnrollmentId
       ));
  END

  IF OBJECT_ID(N'oe.EnrollmentAcknowledgements', N'U') IS NOT NULL
    DELETE ea FROM oe.EnrollmentAcknowledgements ea
    WHERE ea.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.CommissionLogs', N'U') IS NOT NULL
  BEGIN
    IF COL_LENGTH(N'oe.CommissionLogs', N'MemberId') IS NOT NULL
      DELETE cl FROM oe.CommissionLogs cl WHERE cl.MemberId IN (SELECT MemberId FROM #TargetMembers);
    IF COL_LENGTH(N'oe.CommissionLogs', N'EnrollmentId') IS NOT NULL
      DELETE cl FROM oe.CommissionLogs cl
      WHERE cl.EnrollmentId IN (
        SELECT e.EnrollmentId FROM oe.Enrollments e
        INNER JOIN #TargetMembers t ON t.MemberId = e.MemberId
      );
  END

  IF OBJECT_ID(N'oe.GroupActivityLogs', N'U') IS NOT NULL
    AND COL_LENGTH(N'oe.GroupActivityLogs', N'MemberId') IS NOT NULL
    DELETE gal FROM oe.GroupActivityLogs gal
    WHERE gal.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.DeclineAcknowledgements', N'U') IS NOT NULL
    DELETE da FROM oe.DeclineAcknowledgements da
    WHERE da.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.EnrollmentLinks', N'U') IS NOT NULL
    DELETE el FROM oe.EnrollmentLinks el
    WHERE el.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.TrainingCompletions', N'U') IS NOT NULL
    AND COL_LENGTH(N'oe.TrainingCompletions', N'MemberId') IS NOT NULL
    DELETE tc FROM oe.TrainingCompletions tc
    WHERE tc.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.ShareRequestMembers', N'U') IS NOT NULL
    DELETE srm FROM oe.ShareRequestMembers srm
    WHERE srm.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.VendorCallLogs', N'U') IS NOT NULL
    DELETE vcl FROM oe.VendorCallLogs vcl
    WHERE vcl.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.VendorSmsMessages', N'U') IS NOT NULL
    DELETE vsm FROM oe.VendorSmsMessages vsm
    WHERE vsm.MemberId IN (SELECT MemberId FROM #TargetMembers);

  DELETE e
  FROM oe.Enrollments e
  WHERE e.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.MemberPaymentMethods', N'U') IS NOT NULL
    DELETE mpm FROM oe.MemberPaymentMethods mpm
    WHERE mpm.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.MemberIDIncrement', N'U') IS NOT NULL
    DELETE mii FROM oe.MemberIDIncrement mii
    WHERE mii.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID(N'oe.UserActivityLog', N'U') IS NOT NULL
    AND COL_LENGTH(N'oe.UserActivityLog', N'MemberId') IS NOT NULL
    DELETE ual FROM oe.UserActivityLog ual
    WHERE ual.MemberId IN (SELECT MemberId FROM #TargetMembers);

  DELETE msk
  FROM oe.MemberSourceKeys msk
  WHERE msk.MemberId IN (SELECT MemberId FROM #TargetMembers);

  DELETE ur
  FROM oe.UserRoles ur
  WHERE ur.UserId IN (SELECT UserId FROM #TargetUsers);

  DELETE m
  FROM oe.Members m
  WHERE m.MemberId IN (SELECT MemberId FROM #TargetMembers);

  DELETE u
  FROM oe.Users u
  WHERE u.UserId IN (SELECT UserId FROM #TargetUsers)
    AND NOT EXISTS (SELECT 1 FROM oe.Members m WHERE m.UserId = u.UserId);

  COMMIT TRAN;

  SELECT N'Applied: Align Health import batch purged.' AS Status,
    (SELECT COUNT(*) FROM oe.Members WHERE TenantId = @TenantId) AS remaining_align_members,
    (SELECT COUNT(*) FROM oe.Members WHERE TenantId <> @TenantId) AS other_tenant_members_unchanged;

END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  SELECT ERROR_MESSAGE() AS Error, ERROR_LINE() AS Line;
END CATCH;
