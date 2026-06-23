/*
  Move Align SHA households (SWFIR901x / SWVC80xx) to Align Health SHA tenant.
  DryRun = 1: preview only. Set @DryRun = 0 to apply.

  Members from manual import preview flagged "Move tenant" (May 2026 invoice cohort).
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;

-- Prod tenant ids (allaboard-prod); verify on other DBs before apply.
DECLARE @TenantAlignHealth UNIQUEIDENTIFIER = '7D5040ED-1105-4940-A352-FF85483B2C3C';
DECLARE @TenantAlignSha UNIQUEIDENTIFIER = 'AE932D1C-DA81-4BA4-A873-B0F299DC9E04';

IF NOT EXISTS (SELECT 1 FROM oe.Tenants WHERE TenantId = @TenantAlignSha AND Name = N'Align Health SHA')
BEGIN
  RAISERROR(N'Align Health SHA tenant id/name mismatch. Resolve TenantId before apply.', 16, 1);
  RETURN;
END;

IF OBJECT_ID('tempdb..#AlignShaMoveIds') IS NOT NULL DROP TABLE #AlignShaMoveIds;
CREATE TABLE #AlignShaMoveIds (HouseholdMemberID NVARCHAR(50) NOT NULL PRIMARY KEY);

INSERT INTO #AlignShaMoveIds (HouseholdMemberID) VALUES
  (N'SWFIR9009'),
  (N'SWFIR9010'),
  (N'SWFIR9011'),
  (N'SWFIR9012'),
  (N'SWFIR9013'),
  (N'SWFIR9014'),
  (N'SWFIR9015'),
  (N'SWFIR9016'),
  (N'SWVC8001'),
  (N'SWVC8002'),
  (N'SWVC8003'),
  (N'SWVC8004'),
  (N'SWVC8005');

IF OBJECT_ID('tempdb..#AlignShaPrimaries') IS NOT NULL DROP TABLE #AlignShaPrimaries;
SELECT
  p.MemberId AS PrimaryMemberId,
  p.HouseholdId,
  p.HouseholdMemberID,
  p.TenantId AS CurrentTenantId,
  t.Name AS CurrentTenantName,
  u.UserId,
  u.Email
INTO #AlignShaPrimaries
FROM #AlignShaMoveIds ids
INNER JOIN oe.Members p
  ON p.HouseholdMemberID = ids.HouseholdMemberID
 AND p.RelationshipType = N'P'
LEFT JOIN oe.Tenants t ON t.TenantId = p.TenantId
LEFT JOIN oe.Users u ON u.UserId = p.UserId;

PRINT '--- Primary members found ---';
SELECT
  HouseholdMemberID,
  PrimaryMemberId,
  CurrentTenantName,
  CurrentTenantId,
  Email,
  CASE
    WHEN CurrentTenantId = @TenantAlignSha THEN N'Already on Align Health SHA'
    WHEN CurrentTenantId IS NULL THEN N'Missing tenant'
    ELSE N'Will move to Align Health SHA'
  END AS Action
FROM #AlignShaPrimaries
ORDER BY HouseholdMemberID;

SELECT N'Missing primaries (not in oe.Members)' AS Note, ids.HouseholdMemberID
FROM #AlignShaMoveIds ids
LEFT JOIN #AlignShaPrimaries p ON p.HouseholdMemberID = ids.HouseholdMemberID
WHERE p.PrimaryMemberId IS NULL;

IF OBJECT_ID('tempdb..#AlignShaHouseholdMembers') IS NOT NULL DROP TABLE #AlignShaHouseholdMembers;
SELECT
  m.MemberId,
  m.UserId,
  m.HouseholdId,
  m.RelationshipType,
  m.TenantId AS CurrentTenantId,
  prim.HouseholdMemberID AS PrimaryHouseholdMemberID
INTO #AlignShaHouseholdMembers
FROM #AlignShaPrimaries prim
INNER JOIN oe.Members m
  ON m.HouseholdId = prim.HouseholdId OR m.MemberId = prim.PrimaryMemberId;

PRINT '--- Household members to update (count by primary) ---';
SELECT
  PrimaryHouseholdMemberID,
  COUNT(*) AS MemberCount,
  COUNT(DISTINCT CurrentTenantId) AS DistinctTenants
FROM #AlignShaHouseholdMembers
GROUP BY PrimaryHouseholdMemberID
ORDER BY PrimaryHouseholdMemberID;

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — set @DryRun = 0 to move households to Align Health SHA' AS Mode;
  SELECT
    COUNT(DISTINCT h.PrimaryMemberId) AS HouseholdsToMove,
    COUNT(*) AS MemberRowsToUpdate,
    COUNT(DISTINCT h.UserId) AS UserRowsToUpdate
  FROM #AlignShaHouseholdMembers h
  INNER JOIN #AlignShaPrimaries prim ON prim.PrimaryMemberId = h.MemberId
    OR h.HouseholdId = prim.HouseholdId
  WHERE prim.CurrentTenantId IS NOT NULL
    AND prim.CurrentTenantId <> @TenantAlignSha;
  RETURN;
END;

BEGIN TRANSACTION;

UPDATE u
SET
  u.TenantId = @TenantAlignSha,
  u.ModifiedDate = SYSUTCDATETIME()
FROM oe.Users u
INNER JOIN (
  SELECT DISTINCT UserId FROM #AlignShaHouseholdMembers WHERE UserId IS NOT NULL
) src ON src.UserId = u.UserId
WHERE u.TenantId <> @TenantAlignSha OR u.TenantId IS NULL;

UPDATE m
SET
  m.TenantId = @TenantAlignSha,
  m.GroupId = NULL,
  m.ModifiedDate = SYSUTCDATETIME()
FROM oe.Members m
INNER JOIN #AlignShaHouseholdMembers hm ON hm.MemberId = m.MemberId
INNER JOIN #AlignShaPrimaries prim
  ON prim.PrimaryMemberId = hm.MemberId OR hm.HouseholdId = prim.HouseholdId
WHERE m.TenantId <> @TenantAlignSha OR m.TenantId IS NULL;

COMMIT TRANSACTION;

PRINT 'Move complete.';

SELECT
  p.HouseholdMemberID,
  t.Name AS TenantName,
  p.ModifiedDate
FROM #AlignShaPrimaries prim
INNER JOIN oe.Members p ON p.MemberId = prim.PrimaryMemberId
INNER JOIN oe.Tenants t ON t.TenantId = p.TenantId
ORDER BY p.HouseholdMemberID;
