/*
  Move Ideal Health copy (E123 broker 782233 / MEMBER COPIES subtree) CSV-import households
  from ShareWELL Health → Ideal Health tenant.

  Target tenant already exists: "Ideal Health" (33F97472-A8DB-4471-9346-E519CC316673 on prod).

  Scope: 2 primary households from sharewell-skipped CSV import (2026-06-01):
    - 683018423 Allen Jackson
    - 683910487 Erich Halberg

  On apply: moves oe.Users + oe.Members; sets IsPendingMigration = 1 on all household members
  and their enrollments.

  Dry-run (default):
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-02-ideal-health-csv-import-tenant-move.sql

  Apply: @DryRun = 0
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @TargetTenantId UNIQUEIDENTIFIER = NULL;
DECLARE @ResolveTargetByName BIT = 1;
DECLARE @ExpectedTargetTenantName NVARCHAR(200) = N'Ideal Health';

DECLARE @SourceTenantId UNIQUEIDENTIFIER = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6';
DECLARE @ExpectedSourceTenantName NVARCHAR(200) = N'ShareWELL Health';
DECLARE @DbName SYSNAME = DB_NAME();

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'oe.Members', N'U') IS NULL OR OBJECT_ID(N'oe.Tenants', N'U') IS NULL
  BEGIN
    RAISERROR(N'Wrong database (connected to %s).', 16, 1, @DbName);
    ROLLBACK TRANSACTION;
    RETURN;
  END

  IF @DbName NOT IN (N'allaboard-prod', N'allaboard-testing')
  BEGIN
    RAISERROR(N'Unexpected database %s.', 16, 1, @DbName);
    ROLLBACK TRANSACTION;
    RETURN;
  END

  DECLARE @ActualSourceName NVARCHAR(200);
  SELECT @ActualSourceName = Name FROM oe.Tenants WHERE TenantId = @SourceTenantId;
  IF @ActualSourceName <> @ExpectedSourceTenantName
  BEGIN
    RAISERROR(N'Source tenant mismatch: expected %s, got %s.', 16, 1, @ExpectedSourceTenantName, @ActualSourceName);
    ROLLBACK TRANSACTION;
    RETURN;
  END

  IF @TargetTenantId IS NULL AND @ResolveTargetByName = 1
    SELECT @TargetTenantId = TenantId FROM oe.Tenants WHERE Name = @ExpectedTargetTenantName;

  IF @TargetTenantId IS NULL
  BEGIN
    RAISERROR(N'Target tenant "Ideal Health" not found.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
  END

  DECLARE @ActualTargetName NVARCHAR(200);
  SELECT @ActualTargetName = Name FROM oe.Tenants WHERE TenantId = @TargetTenantId;
  IF @ActualTargetName <> @ExpectedTargetTenantName
  BEGIN
    RAISERROR(N'Target tenant name mismatch: expected %s, got %s.', 16, 1, @ExpectedTargetTenantName, @ActualTargetName);
    ROLLBACK TRANSACTION;
    RETURN;
  END

  IF OBJECT_ID('tempdb..#IdealHealthHmids') IS NOT NULL DROP TABLE #IdealHealthHmids;
  CREATE TABLE #IdealHealthHmids (
    HouseholdMemberID NVARCHAR(50) NOT NULL PRIMARY KEY,
    Note NVARCHAR(200) NULL
  );

  INSERT INTO #IdealHealthHmids (HouseholdMemberID, Note) VALUES
    (N'683018423', N'Ideal Health copy — Allen Jackson'),
    (N'683910487', N'Ideal Health copy — Erich Halberg');

  IF OBJECT_ID('tempdb..#HouseholdScope') IS NOT NULL DROP TABLE #HouseholdScope;

  SELECT
    ih.HouseholdMemberID,
    ih.Note,
    p.MemberId AS PrimaryMemberId,
    p.HouseholdId,
    p.TenantId AS CurrentTenantId,
    p.Status AS PrimaryStatus,
    p.IsPendingMigration
  INTO #HouseholdScope
  FROM #IdealHealthHmids ih
  INNER JOIN oe.Members p
    ON p.HouseholdMemberID = ih.HouseholdMemberID
   AND p.RelationshipType = N'P';

  IF OBJECT_ID('tempdb..#MemberScope') IS NOT NULL DROP TABLE #MemberScope;

  SELECT
    m.MemberId,
    m.UserId,
    m.HouseholdId,
    m.RelationshipType,
    m.HouseholdMemberID,
    m.Status,
    m.IsPendingMigration
  INTO #MemberScope
  FROM #HouseholdScope hs
  INNER JOIN oe.Members m ON m.HouseholdId = hs.HouseholdId;

  IF OBJECT_ID('tempdb..#EnrollmentScope') IS NOT NULL DROP TABLE #EnrollmentScope;

  SELECT
    e.EnrollmentId,
    e.MemberId,
    e.IsPendingMigration,
    e.Status
  INTO #EnrollmentScope
  FROM oe.Enrollments e
  WHERE e.MemberId IN (SELECT MemberId FROM #MemberScope);

  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN — Ideal Health tenant move preview' AS [Status];

    SELECT
      ih.HouseholdMemberID,
      ih.Note,
      CASE WHEN hs.PrimaryMemberId IS NULL THEN N'MISSING in OE' ELSE N'found' END AS OeMatch,
      st.Name AS CurrentTenantName,
      tt.Name AS TargetTenantName,
      @TargetTenantId AS TargetTenantId,
      CASE
        WHEN hs.CurrentTenantId = @TargetTenantId THEN N'already on Ideal Health'
        WHEN hs.CurrentTenantId = @SourceTenantId THEN N'will move ShareWELL Health → Ideal Health'
        ELSE N'review — unexpected current tenant'
      END AS PlannedAction,
      hs.IsPendingMigration AS PrimaryPendingMigration
    FROM #IdealHealthHmids ih
    LEFT JOIN #HouseholdScope hs ON hs.HouseholdMemberID = ih.HouseholdMemberID
    LEFT JOIN oe.Tenants st ON st.TenantId = hs.CurrentTenantId
    CROSS JOIN (SELECT Name FROM oe.Tenants WHERE TenantId = @TargetTenantId) tt
    ORDER BY ih.HouseholdMemberID;

    SELECT
      ms.HouseholdMemberID,
      ms.RelationshipType,
      ms.Status,
      ms.IsPendingMigration,
      u.Email
    FROM #MemberScope ms
    INNER JOIN oe.Users u ON u.UserId = ms.UserId
    ORDER BY ms.HouseholdMemberID, ms.RelationshipType;

    SELECT
      N'Would set IsPendingMigration = 1' AS Section,
      SUM(CASE WHEN ISNULL(ms.IsPendingMigration, 0) = 0 THEN 1 ELSE 0 END) AS MembersNeedingFlag,
      SUM(CASE WHEN ISNULL(es.IsPendingMigration, 0) = 0 THEN 1 ELSE 0 END) AS EnrollmentsNeedingFlag
    FROM #MemberScope ms
    LEFT JOIN #EnrollmentScope es ON es.MemberId = ms.MemberId;

    SELECT
      N'Would move from ShareWELL Health' AS Section,
      COUNT(DISTINCT ms.UserId) AS UsersToUpdate,
      COUNT(DISTINCT ms.MemberId) AS MembersToUpdate
    FROM #MemberScope ms
    INNER JOIN #HouseholdScope hs ON hs.HouseholdId = ms.HouseholdId
    WHERE hs.CurrentTenantId = @SourceTenantId;

    ROLLBACK TRANSACTION;
    RETURN;
  END

  UPDATE u
  SET
    u.TenantId = @TargetTenantId,
    u.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Users u
  INNER JOIN #MemberScope ms ON ms.UserId = u.UserId
  INNER JOIN #HouseholdScope hs ON hs.HouseholdId = ms.HouseholdId
  WHERE hs.CurrentTenantId = @SourceTenantId;

  DECLARE @UsersUpdated INT = @@ROWCOUNT;

  UPDATE m
  SET
    m.TenantId = @TargetTenantId,
    m.IsPendingMigration = 1,
    m.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Members m
  INNER JOIN #HouseholdScope hs ON hs.HouseholdId = m.HouseholdId;

  DECLARE @MembersUpdated INT = @@ROWCOUNT;

  UPDATE e
  SET
    e.IsPendingMigration = 1,
    e.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Enrollments e
  INNER JOIN #EnrollmentScope es ON es.EnrollmentId = e.EnrollmentId;

  DECLARE @EnrollmentsUpdated INT = @@ROWCOUNT;

  SELECT
    N'Applied' AS [Status],
    @UsersUpdated AS UsersUpdated,
    @MembersUpdated AS MembersUpdated,
    @EnrollmentsUpdated AS EnrollmentsPendingMigrationUpdated,
    @TargetTenantId AS TargetTenantId,
    @ExpectedTargetTenantName AS TargetTenantName;

  COMMIT TRANSACTION;
  SELECT N'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
