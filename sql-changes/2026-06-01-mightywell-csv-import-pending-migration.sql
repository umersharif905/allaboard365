/*
  Flag MightyWELL Health eligibility CSV import (2026-06-01) as pending migration.

  Scope:
    - Tenant MightyWELL Health only
    - Primary households imported via csv_import / sharewell_csv enrollments
      or sharewell MemberSourceKeys on 2026-06-01 (~10 primaries from bad batch)
    - Sets IsPendingMigration = 1 on primary + dependents in those households
    - Sets IsPendingMigration = 1 on their enrollments (staging for billing/finalize)
    - Does NOT set MigrationSourceSystem (stays NULL — not an E123 import)

  Run dry-run (default) on OpenEnroll prod:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-01-mightywell-csv-import-pending-migration.sql

  Apply (only after reviewing dry-run output):
    Edit @DryRun = 0, re-run with explicit approval.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @TenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
DECLARE @ImportDate DATE = '2026-06-01';
DECLARE @ImportDateText NVARCHAR(10) = CONVERT(NVARCHAR(10), @ImportDate, 23);
DECLARE @ExpectedTenantName NVARCHAR(200) = N'MightyWELL Health';
DECLARE @DbName SYSNAME = DB_NAME();

BEGIN TRY
  ---------------------------------------------------------------------------
  -- Database guard
  ---------------------------------------------------------------------------
  IF OBJECT_ID(N'oe.Members', N'U') IS NULL OR OBJECT_ID(N'oe.Tenants', N'U') IS NULL
  BEGIN
    RAISERROR(
      N'Wrong database: oe.Members / oe.Tenants not found (connected to %s). Run on OpenEnroll allaboard-prod.',
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
  -- Tenant guard
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
    RAISERROR(N'Abort: tenant name mismatch (expected MightyWELL Health, got %s).', 16, 1, @ActualTenantName);
    RETURN;
  END

  ---------------------------------------------------------------------------
  -- Target primaries: CSV eligibility import on @ImportDate
  ---------------------------------------------------------------------------
  IF OBJECT_ID('tempdb..#CsvImportPrimaries') IS NOT NULL DROP TABLE #CsvImportPrimaries;

  SELECT
    m.MemberId,
    m.HouseholdId,
    m.HouseholdMemberID,
    m.AgentId,
    m.IsPendingMigration,
    m.MigrationSourceSystem,
    m.CreatedDate,
    u.FirstName + N' ' + u.LastName AS PrimaryName
  INTO #CsvImportPrimaries
  FROM oe.Members m
  INNER JOIN oe.Users u ON u.UserId = m.UserId
  WHERE m.TenantId = @TenantId
    AND m.RelationshipType = N'P'
    AND CAST(m.CreatedDate AS DATE) = @ImportDate
    AND (
      EXISTS (
        SELECT 1
        FROM oe.Enrollments e
        WHERE e.MemberId = m.MemberId
          AND JSON_VALUE(e.EnrollmentDetails, '$.importSource') IN (N'csv_import', N'sharewell_csv')
      )
      OR EXISTS (
        SELECT 1
        FROM oe.MemberSourceKeys msk
        WHERE msk.MemberId = m.MemberId
          AND msk.SourceSystem = N'sharewell'
      )
    );

  DECLARE @PrimaryCount INT = (SELECT COUNT(*) FROM #CsvImportPrimaries);

  IF @PrimaryCount = 0
  BEGIN
    RAISERROR(N'Abort: no CSV-import primaries found for %s on %s.', 16, 1, @ExpectedTenantName, @ImportDateText);
    RETURN;
  END

  IF @PrimaryCount > 20
  BEGIN
    RAISERROR(N'Abort: expected ~10 primaries, found %d — refuse bulk update.', 16, 1, @PrimaryCount);
    RETURN;
  END

  ---------------------------------------------------------------------------
  -- Household members (primary + dependents)
  ---------------------------------------------------------------------------
  IF OBJECT_ID('tempdb..#HouseholdMembers') IS NOT NULL DROP TABLE #HouseholdMembers;

  SELECT
    m.MemberId,
    m.HouseholdId,
    m.RelationshipType,
    m.IsPendingMigration,
    m.MigrationSourceSystem,
    m.HouseholdMemberID,
    u.FirstName + N' ' + u.LastName AS MemberName
  INTO #HouseholdMembers
  FROM oe.Members m
  INNER JOIN oe.Users u ON u.UserId = m.UserId
  WHERE m.TenantId = @TenantId
    AND m.HouseholdId IN (SELECT HouseholdId FROM #CsvImportPrimaries);

  ---------------------------------------------------------------------------
  -- Enrollments for those members
  ---------------------------------------------------------------------------
  IF OBJECT_ID('tempdb..#TargetEnrollments') IS NOT NULL DROP TABLE #TargetEnrollments;

  SELECT
    e.EnrollmentId,
    e.MemberId,
    e.ProductId,
    e.IsPendingMigration,
    e.Status,
    JSON_VALUE(e.EnrollmentDetails, '$.importSource') AS ImportSource
  INTO #TargetEnrollments
  FROM oe.Enrollments e
  WHERE e.MemberId IN (SELECT MemberId FROM #HouseholdMembers);

  ---------------------------------------------------------------------------
  -- Dry-run preview
  ---------------------------------------------------------------------------
  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN — primaries to flag pending migration' AS [Section];
    SELECT
      p.HouseholdMemberID,
      p.PrimaryName,
      p.AgentId,
      p.IsPendingMigration AS CurrentIsPendingMigration,
      p.MigrationSourceSystem,
      p.CreatedDate
    FROM #CsvImportPrimaries p
    ORDER BY p.PrimaryName;

    SELECT N'DRY RUN — household members (will set IsPendingMigration = 1)' AS [Section];
    SELECT
      hm.HouseholdMemberID,
      hm.RelationshipType,
      hm.MemberName,
      hm.IsPendingMigration AS CurrentIsPendingMigration,
      hm.MigrationSourceSystem
    FROM #HouseholdMembers hm
    ORDER BY hm.HouseholdId, hm.RelationshipType, hm.MemberName;

    SELECT N'DRY RUN — enrollments (will set IsPendingMigration = 1)' AS [Section];
    SELECT
      te.EnrollmentId,
      hm.HouseholdMemberID,
      hm.MemberName,
      te.Status,
      te.ImportSource,
      te.IsPendingMigration AS CurrentIsPendingMigration
    FROM #TargetEnrollments te
    INNER JOIN #HouseholdMembers hm ON hm.MemberId = te.MemberId
    ORDER BY hm.HouseholdMemberID, te.EnrollmentId;

    SELECT N'DRY RUN — counts' AS [Section];
    SELECT
      @PrimaryCount AS PrimaryCount,
      (SELECT COUNT(*) FROM #HouseholdMembers) AS HouseholdMemberCount,
      (SELECT COUNT(*) FROM #TargetEnrollments) AS EnrollmentCount,
      (SELECT COUNT(*) FROM #HouseholdMembers WHERE ISNULL(IsPendingMigration, 0) = 1) AS MembersAlreadyPending,
      (SELECT COUNT(*) FROM #TargetEnrollments WHERE ISNULL(IsPendingMigration, 0) = 1) AS EnrollmentsAlreadyPending;

    SELECT N'DRY RUN complete — set @DryRun = 0 to apply' AS [Status];
    RETURN;
  END

  ---------------------------------------------------------------------------
  -- Apply
  ---------------------------------------------------------------------------
  BEGIN TRANSACTION;

  UPDATE m
  SET
    m.IsPendingMigration = 1,
    m.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Members m
  INNER JOIN #HouseholdMembers hm ON hm.MemberId = m.MemberId
  WHERE ISNULL(m.IsPendingMigration, 0) = 0;

  DECLARE @MembersUpdated INT = @@ROWCOUNT;

  UPDATE e
  SET
    e.IsPendingMigration = 1,
    e.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Enrollments e
  INNER JOIN #TargetEnrollments te ON te.EnrollmentId = e.EnrollmentId
  WHERE ISNULL(e.IsPendingMigration, 0) = 0;

  DECLARE @EnrollmentsUpdated INT = @@ROWCOUNT;

  COMMIT TRANSACTION;

  SELECT
    N'Changes applied successfully' AS [Status],
    @MembersUpdated AS MembersUpdated,
    @EnrollmentsUpdated AS EnrollmentsUpdated,
    @PrimaryCount AS PrimaryHouseholds;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
