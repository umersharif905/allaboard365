/*
  Read-only audit: CSV-import cohort vs E123 termination expectation.
  @DryRun must stay 1 (verify-only).

  Run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-03-csv-import-e123-termination-audit.sql
*/
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;
IF @DryRun <> 1 BEGIN RAISERROR(N'Read-only audit — keep @DryRun = 1.', 16, 1); RETURN; END

DECLARE @DbName SYSNAME = DB_NAME();
IF OBJECT_ID(N'oe.Members', N'U') IS NULL BEGIN RAISERROR(N'Wrong database %s.', 16, 1, @DbName); RETURN; END

IF OBJECT_ID('tempdb..#E123Class') IS NOT NULL DROP TABLE #E123Class;
CREATE TABLE #E123Class (HouseholdMemberID NVARCHAR(50) NOT NULL PRIMARY KEY, E123InSystem BIT NOT NULL, E123ActiveProducts BIT NULL, Note NVARCHAR(200) NULL);

INSERT INTO #E123Class VALUES
(N'SW0127585',1,0,N'MW'),(N'SW0927390',1,0,N'MW'),(N'SW1496784',1,0,N'MW'),(N'SW2996055',1,0,N'MW'),(N'SW3057692',1,0,N'MW'),
(N'SW4619326',1,0,N'MW'),(N'SW5386000',1,0,N'MW'),(N'SW6018911',1,0,N'MW'),(N'SW7122476',1,0,N'MW'),(N'SW7149470',1,0,N'MW'),
(N'SW7404742',1,0,N'MW'),(N'SW7838000',1,0,N'MW'),(N'SW8783162',1,0,N'MW'),(N'SW9578123',1,0,N'MW'),(N'SWP1352407',1,0,N'MW'),
(N'SWP1352444',1,0,N'MW'),(N'SWP1352625',1,0,N'MW'),(N'SWP1352711',1,0,N'MW'),
(N'SW0636646',1,0,N'SW'),(N'SW0724874',1,0,N'SW'),(N'SW0948770',1,0,N'SW'),(N'SW0954546',1,0,N'SW'),(N'SW1392815',1,0,N'SW'),
(N'SW1612624',1,0,N'SW'),(N'SW1862558',1,1,N'SW active'),(N'SW3005942',1,1,N'SW active'),(N'SW3607023',1,0,N'SW'),(N'SW3720539',1,0,N'SW'),
(N'SW4234301',1,0,N'SW'),(N'SW4826142',1,0,N'SW'),(N'SW4900666',1,0,N'SW'),(N'SW5638145',1,0,N'SW'),(N'SW6372518',1,0,N'SW'),
(N'SW7436890',1,0,N'SW'),(N'SW9180326',1,1,N'SW active'),(N'SW9589478',1,1,N'SW active'),(N'SW9882202',1,0,N'SW'),(N'SWP1352454',1,0,N'SW'),
(N'SWP1352507',1,0,N'SW'),(N'SWP1352520',1,0,N'SW'),(N'SWP1352525',1,0,N'SW'),(N'SWP1352526',1,0,N'SW'),(N'SWP1352533',1,0,N'SW'),
(N'683018423',1,1,N'Ideal active'),(N'675516766',1,1,N'eBenefits active'),(N'686265847',1,1,N'eBenefits active');

IF OBJECT_ID('tempdb..#HouseholdAudit') IS NOT NULL DROP TABLE #HouseholdAudit;
SELECT c.*, p.MemberId PrimaryMemberId, p.HouseholdId, p.Status PrimaryStatus, p.IsPendingMigration PrimaryPendingMigration, t.Name TenantName,
  (SELECT COUNT(*) FROM oe.Members m2 WHERE m2.HouseholdId=p.HouseholdId AND m2.Status<>N'Terminated') NonTerminatedMembers,
  (SELECT COUNT(*) FROM oe.Members m2 WHERE m2.HouseholdId=p.HouseholdId AND ISNULL(m2.IsPendingMigration,0)=1) PendingMigrationMembers,
  (SELECT COUNT(*) FROM oe.Enrollments e INNER JOIN oe.Members m2 ON m2.MemberId=e.MemberId WHERE m2.HouseholdId=p.HouseholdId AND e.Status IN (N'Active',N'Pending Payment') AND (e.TerminationDate IS NULL OR e.TerminationDate>SYSUTCDATETIME())) OpenEnrollments,
  (SELECT COUNT(*) FROM oe.Enrollments e INNER JOIN oe.Members m2 ON m2.MemberId=e.MemberId WHERE m2.HouseholdId=p.HouseholdId AND ISNULL(e.IsPendingMigration,0)=1) StagingEnrollments
INTO #HouseholdAudit
FROM #E123Class c
LEFT JOIN oe.Members p ON p.HouseholdMemberID=c.HouseholdMemberID AND p.RelationshipType=N'P'
LEFT JOIN oe.Tenants t ON t.TenantId=p.TenantId;

SELECT N'CSV import E123 termination audit' AS Report;
SELECT
  SUM(CASE WHEN PrimaryMemberId IS NULL THEN 1 ELSE 0 END) MissingInOe,
  SUM(CASE WHEN E123InSystem=1 AND ISNULL(E123ActiveProducts,0)=0 AND PrimaryStatus=N'Terminated' AND ISNULL(PrimaryPendingMigration,0)=0 AND OpenEnrollments=0 AND StagingEnrollments=0 AND PendingMigrationMembers=0 THEN 1 ELSE 0 END) E123Terminated_FullyAligned,
  SUM(CASE WHEN E123InSystem=1 AND ISNULL(E123ActiveProducts,0)=0 AND NOT (PrimaryStatus=N'Terminated' AND ISNULL(PrimaryPendingMigration,0)=0 AND OpenEnrollments=0 AND StagingEnrollments=0 AND PendingMigrationMembers=0) THEN 1 ELSE 0 END) E123Terminated_NeedsSync,
  SUM(CASE WHEN E123InSystem=1 AND E123ActiveProducts=1 AND PrimaryStatus=N'Active' THEN 1 ELSE 0 END) E123Active_OeActive
FROM #HouseholdAudit;

SELECT N'MISALIGNED' AS Section, * FROM #HouseholdAudit
WHERE E123InSystem=1 AND ISNULL(E123ActiveProducts,0)=0 AND PrimaryMemberId IS NOT NULL
  AND NOT (PrimaryStatus=N'Terminated' AND ISNULL(PrimaryPendingMigration,0)=0 AND OpenEnrollments=0 AND StagingEnrollments=0 AND PendingMigrationMembers=0)
ORDER BY TenantName, HouseholdMemberID;
