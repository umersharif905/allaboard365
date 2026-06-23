/*
  Verify ShareWELL Partners (E123 broker 783390) CSV-import households are on ShareWELL Health.

  Policy: ShareWELL Partners downline → ShareWELL Health (no tenant move expected).

  Scope: 5 primary households from sharewell-skipped CSV import (2026-06-01).
  Excludes Ideal Health copy households (683018423, 683910487) — see ideal-health tenant move script.

  Read-only — @DryRun must stay 1 (no apply path).

  Run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-02-sharewell-partners-csv-import-tenant-verify.sql
*/

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;  -- read-only script; do not set to 0

DECLARE @ExpectedTenantId UNIQUEIDENTIFIER = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6';
DECLARE @ExpectedTenantName NVARCHAR(200) = N'ShareWELL Health';
DECLARE @DbName SYSNAME = DB_NAME();

IF @DryRun <> 1
BEGIN
  RAISERROR(N'This script is verify-only. Keep @DryRun = 1.', 16, 1);
  RETURN;
END

IF OBJECT_ID(N'oe.Members', N'U') IS NULL
BEGIN
  RAISERROR(N'Wrong database (connected to %s).', 16, 1, @DbName);
  RETURN;
END

DECLARE @ActualTenantName NVARCHAR(200);
SELECT @ActualTenantName = Name FROM oe.Tenants WHERE TenantId = @ExpectedTenantId;
IF @ActualTenantName <> @ExpectedTenantName
BEGIN
  RAISERROR(N'Tenant guard failed: expected %s, got %s.', 16, 1, @ExpectedTenantName, @ActualTenantName);
  RETURN;
END

IF OBJECT_ID('tempdb..#PartnersHmids') IS NOT NULL DROP TABLE #PartnersHmids;
CREATE TABLE #PartnersHmids (
  HouseholdMemberID NVARCHAR(50) NOT NULL PRIMARY KEY,
  Note NVARCHAR(200) NULL
);

INSERT INTO #PartnersHmids (HouseholdMemberID, Note) VALUES
  (N'SW1862558', N'ShareWELL Partners — active E123'),
  (N'SW9180326', N'ShareWELL Partners — active E123'),
  (N'SW3005942', N'ShareWELL Partners — active E123'),
  (N'SW9589478', N'ShareWELL Partners — active E123'),
  (N'SW0724874', N'ShareWELL Partners — phased-out E123 products');

SELECT N'DRY RUN — ShareWELL Partners tenant verify (read-only)' AS [Status];

SELECT
  ph.HouseholdMemberID,
  ph.Note,
  CASE WHEN p.MemberId IS NULL THEN N'MISSING in OE' ELSE N'found' END AS OeMatch,
  t.Name AS CurrentTenantName,
  p.TenantId AS CurrentTenantId,
  CASE
    WHEN p.MemberId IS NULL THEN N'missing'
    WHEN p.TenantId = @ExpectedTenantId THEN N'OK — ShareWELL Health'
    ELSE N'WRONG TENANT — needs move to ShareWELL Health'
  END AS TenantCheck,
  p.Status AS PrimaryStatus,
  p.IsPendingMigration,
  (SELECT COUNT(*) FROM oe.Members m2 WHERE m2.HouseholdId = p.HouseholdId) AS HouseholdMemberCount
FROM #PartnersHmids ph
LEFT JOIN oe.Members p
  ON p.HouseholdMemberID = ph.HouseholdMemberID
 AND p.RelationshipType = N'P'
LEFT JOIN oe.Tenants t ON t.TenantId = p.TenantId
ORDER BY ph.HouseholdMemberID;

SELECT
  N'Summary' AS Section,
  SUM(CASE WHEN p.TenantId = @ExpectedTenantId THEN 1 ELSE 0 END) AS OnSharewellHealth,
  SUM(CASE WHEN p.MemberId IS NOT NULL AND p.TenantId <> @ExpectedTenantId THEN 1 ELSE 0 END) AS WrongTenant,
  SUM(CASE WHEN p.MemberId IS NULL THEN 1 ELSE 0 END) AS MissingInOe,
  SUM(CASE WHEN p.IsPendingMigration = 1 THEN 1 ELSE 0 END) AS PendingMigrationSet,
  SUM(CASE WHEN p.MemberId IS NOT NULL AND ISNULL(p.IsPendingMigration, 0) = 0 THEN 1 ELSE 0 END) AS PendingMigrationMissing
FROM #PartnersHmids ph
LEFT JOIN oe.Members p
  ON p.HouseholdMemberID = ph.HouseholdMemberID
 AND p.RelationshipType = N'P';
