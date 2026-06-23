/*
  Sync OE to E123-terminated state for CSV-import cohort (2026-06-01).

  Scope: primaries where E123 probe showed in-system with NO active products
  (cancelled-only / terminated in E123). Excludes households still active in E123.

  Per household:
    1. DELETE staging enrollments (IsPendingMigration = 1) for all members
    2. INACTIVATE open enrollments (Active / Pending Payment) with TerminationDate
    3. Terminate all household members; clear IsPendingMigration

  Does NOT touch E123-active households (SW1862558, SW3005942, SW9180326, SW9589478,
  675516766, 686265847, 683018423).

  Run audit first:
    ./ai_scripts/db-execute.sh sql-changes/2026-06-03-csv-import-e123-termination-audit.sql

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-03-csv-import-sync-e123-terminated-households.sql

  Apply: @DryRun = 0
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @DefaultTermDate DATE = '2025-11-30';
DECLARE @DbName SYSNAME = DB_NAME();

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'oe.Members', N'U') IS NULL
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

  IF OBJECT_ID('tempdb..#E123TerminatedHmids') IS NOT NULL DROP TABLE #E123TerminatedHmids;
  CREATE TABLE #E123TerminatedHmids (
    HouseholdMemberID NVARCHAR(50) NOT NULL PRIMARY KEY,
    Note NVARCHAR(100) NULL
  );

  INSERT INTO #E123TerminatedHmids (HouseholdMemberID, Note) VALUES
    (N'SW0127585', N'MW'), (N'SW0927390', N'MW'), (N'SW1496784', N'MW'), (N'SW2996055', N'MW'),
    (N'SW3057692', N'MW'), (N'SW4619326', N'MW'), (N'SW5386000', N'MW'), (N'SW6018911', N'MW'),
    (N'SW7122476', N'MW'), (N'SW7149470', N'MW'), (N'SW7404742', N'MW'), (N'SW7838000', N'MW'),
    (N'SW8783162', N'MW'), (N'SW9578123', N'MW'), (N'SWP1352407', N'MW'), (N'SWP1352444', N'MW'),
    (N'SWP1352625', N'MW'), (N'SWP1352711', N'MW'),
    (N'SW0636646', N'SW'), (N'SW0724874', N'SW'), (N'SW0948770', N'SW'), (N'SW0954546', N'SW'),
    (N'SW1392815', N'SW'), (N'SW1612624', N'SW'), (N'SW3607023', N'SW'), (N'SW3720539', N'SW'),
    (N'SW4234301', N'SW'), (N'SW4826142', N'SW'), (N'SW4900666', N'SW'), (N'SW5638145', N'SW'),
    (N'SW6372518', N'SW'), (N'SW7436890', N'SW'), (N'SW9882202', N'SW'), (N'SWP1352454', N'SW'),
    (N'SWP1352507', N'SW'), (N'SWP1352520', N'SW'), (N'SWP1352525', N'SW'), (N'SWP1352526', N'SW'),
    (N'SWP1352533', N'SW');

  IF OBJECT_ID('tempdb..#Scope') IS NOT NULL DROP TABLE #Scope;

  SELECT
    th.HouseholdMemberID,
    th.Note,
    p.MemberId AS PrimaryMemberId,
    p.HouseholdId,
    p.Status AS PrimaryStatus,
    p.IsPendingMigration,
    p.TerminationDate AS PrimaryTerminationDate,
    t.Name AS TenantName
  INTO #Scope
  FROM #E123TerminatedHmids th
  INNER JOIN oe.Members p
    ON p.HouseholdMemberID = th.HouseholdMemberID
   AND p.RelationshipType = N'P'
  LEFT JOIN oe.Tenants t ON t.TenantId = p.TenantId;

  IF OBJECT_ID('tempdb..#MemberScope') IS NOT NULL DROP TABLE #MemberScope;

  SELECT m.MemberId, m.HouseholdId, m.RelationshipType, m.HouseholdMemberID, m.Status, m.IsPendingMigration
  INTO #MemberScope
  FROM #Scope s
  INNER JOIN oe.Members m ON m.HouseholdId = s.HouseholdId;

  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN — E123-terminated household sync preview' AS [Status];

    SELECT
      s.HouseholdMemberID,
      s.TenantName,
      s.Note,
      s.PrimaryStatus,
      s.IsPendingMigration,
      (SELECT COUNT(*) FROM #MemberScope ms WHERE ms.HouseholdId = s.HouseholdId AND ms.Status <> N'Terminated') AS MembersToTerminate,
      (SELECT COUNT(*)
       FROM oe.Enrollments e
       INNER JOIN #MemberScope ms ON ms.MemberId = e.MemberId
       WHERE ms.HouseholdId = s.HouseholdId AND ISNULL(e.IsPendingMigration, 0) = 1) AS StagingEnrollmentsToDelete,
      (SELECT COUNT(*)
       FROM oe.Enrollments e
       INNER JOIN #MemberScope ms ON ms.MemberId = e.MemberId
       WHERE ms.HouseholdId = s.HouseholdId
         AND e.Status IN (N'Active', N'Pending Payment')
         AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())) AS OpenEnrollmentsToInactivate
    FROM #Scope s
    ORDER BY s.TenantName, s.HouseholdMemberID;

    SELECT
      N'Summary' AS Section,
      COUNT(*) AS Households,
      SUM(CASE WHEN PrimaryStatus <> N'Terminated' OR IsPendingMigration = 1 THEN 1 ELSE 0 END) AS HouseholdsNeedingMemberFix
    FROM #Scope;

    ROLLBACK TRANSACTION;
    RETURN;
  END

  IF NOT EXISTS (SELECT 1 FROM #Scope)
  BEGIN
    RAISERROR(N'No scoped households found — check HMID list.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
  END

  DELETE e
  FROM oe.Enrollments e
  INNER JOIN #MemberScope ms ON ms.MemberId = e.MemberId
  WHERE ISNULL(e.IsPendingMigration, 0) = 1;

  DECLARE @StagingDeleted INT = @@ROWCOUNT;

  UPDATE e
  SET
    e.Status = N'Inactive',
    e.TerminationDate = COALESCE(CAST(e.TerminationDate AS DATE), @DefaultTermDate),
    e.IsPendingMigration = 0,
    e.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Enrollments e
  INNER JOIN #MemberScope ms ON ms.MemberId = e.MemberId
  WHERE e.Status IN (N'Active', N'Pending Payment')
    AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME());

  DECLARE @EnrollmentsInactivated INT = @@ROWCOUNT;

  UPDATE m
  SET
    m.Status = N'Terminated',
    m.IsPendingMigration = 0,
    m.TerminationDate = COALESCE(CAST(m.TerminationDate AS DATE), @DefaultTermDate),
    m.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Members m
  INNER JOIN #Scope s ON s.HouseholdId = m.HouseholdId;

  DECLARE @MembersTerminated INT = @@ROWCOUNT;

  SELECT
    N'Applied' AS [Status],
    (SELECT COUNT(*) FROM #Scope) AS Households,
    @StagingDeleted AS StagingEnrollmentsDeleted,
    @EnrollmentsInactivated AS OpenEnrollmentsInactivated,
    @MembersTerminated AS MembersTerminated;

  COMMIT TRANSACTION;
  SELECT N'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
