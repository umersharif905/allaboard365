/*
  Terminate OE households from CSV import when E123 shows a fully cancelled,
  no-longer-billing household (NOT phased-out plan/benefit changes).

  Background (2026-06-02 E123 probe of 61 CSV primaries):
    - 38/46 in-E123 households: products show dtcancelled BUT bpaid=1 and/or future
      dtrecurring → plan/benefit/vendor change, still billing → DO NOT terminate.
    - 7/46: still have active migratable E123 products → keep Active.
    - 0/46 met strict "cancelled + unpaid + no recurring" at probe time.

  This script uses an explicit HMID allowlist. Default list is EMPTY — populate
  @TerminateHmids after manual review. SW3057692 was borderline (cancelled products
  but bpaid=1); excluded from default list.

  Actions per household:
    - Set TerminationDate on active enrollments (max dtcancelled from E123 or @DefaultTermDate)
    - Set enrollment Status = Inactive
    - Set primary + dependents Member Status = Terminated (only if ALL enrollments terminated)

  Run dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-02-csv-import-sync-e123-terminated-households.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @DefaultTermDate DATE = '2025-10-31';  -- fallback when EnrollmentDetails has no E123 cancel date
DECLARE @DbName SYSNAME = DB_NAME();

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'oe.Members', N'U') IS NULL
  BEGIN
    RAISERROR(N'Wrong database (connected to %s).', 16, 1, @DbName);
    ROLLBACK TRANSACTION;
    RETURN;
  END

  ---------------------------------------------------------------------------
  -- Explicit allowlist — add HMIDs only after E123 review confirms true termination
  ---------------------------------------------------------------------------
  IF OBJECT_ID('tempdb..#TerminateHmids') IS NOT NULL DROP TABLE #TerminateHmids;
  CREATE TABLE #TerminateHmids (HouseholdMemberID NVARCHAR(50) NOT NULL PRIMARY KEY, E123Note NVARCHAR(400) NULL);

  -- Example (commented — none confirmed fully terminated + unpaid at 2026-06-02 probe):
  -- INSERT INTO #TerminateHmids VALUES (N'SW3057692', N'Review: all E123 products cancelled; verify bpaid before apply');

  IF OBJECT_ID('tempdb..#Scope') IS NOT NULL DROP TABLE #Scope;

  SELECT
    p.HouseholdMemberID,
    p.MemberId AS PrimaryMemberId,
    p.HouseholdId,
    p.Status AS PrimaryStatus,
    t.Name AS TenantName
  INTO #Scope
  FROM #TerminateHmids th
  INNER JOIN oe.Members p
    ON p.HouseholdMemberID = th.HouseholdMemberID
   AND p.RelationshipType = N'P'
  LEFT JOIN oe.Tenants t ON t.TenantId = p.TenantId;

  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN — termination sync preview' AS [Status];

    SELECT
      th.HouseholdMemberID,
      th.E123Note,
      CASE WHEN s.PrimaryMemberId IS NULL THEN N'NOT FOUND' ELSE N'found' END AS OeMatch,
      s.TenantName,
      s.PrimaryStatus
    FROM #TerminateHmids th
    LEFT JOIN #Scope s ON s.HouseholdMemberID = th.HouseholdMemberID;

    SELECT
      s.HouseholdMemberID,
      e.EnrollmentId,
      e.Status,
      e.EffectiveDate,
      e.TerminationDate,
      pr.Name AS ProductName
    FROM #Scope s
    INNER JOIN oe.Enrollments e ON e.MemberId = s.PrimaryMemberId
    LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
    ORDER BY s.HouseholdMemberID;

    SELECT
      N'Allowlist empty — no changes until HMIDs added' AS Note,
      (SELECT COUNT(*) FROM #TerminateHmids) AS HmidCount;

    ROLLBACK TRANSACTION;
    RETURN;
  END

  IF NOT EXISTS (SELECT 1 FROM #TerminateHmids)
  BEGIN
    RAISERROR(N'Allowlist empty — add HMIDs to #TerminateHmids before apply.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
  END

  -- Terminate active enrollments for scoped primaries
  UPDATE e
  SET
    e.TerminationDate = COALESCE(CAST(e.TerminationDate AS DATE), @DefaultTermDate),
    e.Status = N'Inactive',
    e.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Enrollments e
  INNER JOIN #Scope s ON s.PrimaryMemberId = e.MemberId
  WHERE e.Status = N'Active'
    AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME());

  -- Terminate all household members when primary has no open enrollments
  UPDATE m
  SET
    m.Status = N'Terminated',
    m.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Members m
  INNER JOIN #Scope s ON s.HouseholdId = m.HouseholdId
  WHERE NOT EXISTS (
    SELECT 1
    FROM oe.Enrollments e
    WHERE e.MemberId = s.PrimaryMemberId
      AND e.Status = N'Active'
      AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
  );

  COMMIT TRANSACTION;
  SELECT N'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
GO
