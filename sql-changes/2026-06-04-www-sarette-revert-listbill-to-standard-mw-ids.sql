-- =============================================================================
-- W.W.W. Sarette Brothers Inc — revert ListBill → Standard and re-ID primaries to MW
-- =============================================================================
-- Reverses: sql-changes/2026-05-27-www-sarette-listbill-sw-member-ids.sql
--
-- Group:  W.W.W. Sarette Brothers Inc
-- GroupId: 7CE2E221-20EA-477B-8368-5532853D04A4
-- Tenant: MightyWELL Health (1CD92AF7-B6F2-4E48-A8F3-EC6316158826)
--
-- Changes:
--   * Set GroupType = Standard.
--   * Update HouseholdMemberID only (SW → MW) for 16 primaries currently on
--     SW15990962–SW15990977. No member records added/removed; enrollments untouched.
--   * Dependents and duplicate primary (NULL ID) stay as-is.
--
-- Mapping verified against allaboard-prod export 2026-05-22 (pre-ListBill state).
--
-- Run order:
--   1) @DryRun = 1 (default) — preview only; ROLLBACK, no data changes.
--   2) Review proposed IDs + conflict check.
--   3) Set @DryRun = 0 only with explicit approval.
--
-- Deploy: run against allaboard-prod (oe schema).
--   cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-04-www-sarette-revert-listbill-to-standard-mw-ids.sql
-- =============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @GroupId UNIQUEIDENTIFIER = '7CE2E221-20EA-477B-8368-5532853D04A4';
DECLARE @TenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
DECLARE @GroupName NVARCHAR(255) = N'W.W.W. Sarette Brothers Inc';

DECLARE @GroupPrefix NVARCHAR(10);
DECLARE @IndividualPrefix NVARCHAR(10);
DECLARE @MemberCount INT;
DECLARE @EligibleCount INT;

SELECT
  @GroupPrefix = NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''),
  @IndividualPrefix = NULLIF(LTRIM(RTRIM(t.IndividualMemberIDPrefix)), N'')
FROM oe.Tenants t
WHERE t.TenantId = @TenantId;

IF @GroupPrefix IS NULL OR @IndividualPrefix IS NULL
BEGIN
  RAISERROR(N'Tenant MemberIDPrefix / IndividualMemberIDPrefix missing. Aborting.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM oe.Groups g
  WHERE g.GroupId = @GroupId
    AND g.TenantId = @TenantId
    AND g.Name = @GroupName
)
BEGIN
  RAISERROR(N'Expected group not found (GroupId / TenantId / Name mismatch). Aborting.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM oe.Groups g
  WHERE g.GroupId = @GroupId
    AND g.GroupType = N'ListBill'
)
BEGIN
  RAISERROR(N'Group is not ListBill — already reverted or unexpected state. Aborting.', 16, 1);
  RETURN;
END;

SELECT @MemberCount = COUNT(*)
FROM oe.Members m
WHERE m.GroupId = @GroupId;

IF @MemberCount <> 32
BEGIN
  RAISERROR(N'Expected 32 members in group; found %d. Aborting.', 16, 1, @MemberCount);
  RETURN;
END;

IF OBJECT_ID('tempdb..#WwwSaretteReIdMap') IS NOT NULL DROP TABLE #WwwSaretteReIdMap;
IF OBJECT_ID('tempdb..#WwwRevertMap') IS NOT NULL DROP TABLE #WwwRevertMap;  -- stale from earlier draft runs

CREATE TABLE #WwwSaretteReIdMap (
  MemberId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
  current_household_member_id NVARCHAR(50) NOT NULL,
  proposed_mw_id NVARCHAR(50) NOT NULL
);

INSERT INTO #WwwSaretteReIdMap (MemberId, current_household_member_id, proposed_mw_id)
VALUES
  ('1F525D7F-7693-4C84-BF24-FC4D3DAF6198', N'SW15990962', N'MW15990826'),
  ('FC8E4C15-1199-4907-BF12-952056E6D578', N'SW15990963', N'MW15990827'),
  ('CF418879-A9BE-4D71-AE92-9461D02D8DFB', N'SW15990964', N'MW15990828'),
  ('37F62610-9AB4-4B45-9718-891092436375', N'SW15990965', N'MW15990829'),
  ('9A2F59AC-F1D6-47F8-8D18-3CDEB26CABA1', N'SW15990966', N'MW15990830'),
  ('40040D97-517F-42F2-8C60-0D35E2E8C23E', N'SW15990967', N'MW15990831'),
  ('B27AB757-1956-4173-821F-47D78A752479', N'SW15990968', N'MW15990832'),
  ('AF65F1F4-BC30-4AF0-A117-FFA800D2E87B', N'SW15990969', N'MW15990833'),
  ('85181BF7-7E7A-432A-972E-28B140037CC5', N'SW15990970', N'MW15990834'),
  ('100E06CA-FB3F-413C-9F61-AE3CC82F3BFA', N'SW15990971', N'MW15990835'),
  ('23091C5D-7896-4F87-A68D-B14685689CD6', N'SW15990972', N'MW15990836'),
  ('35BBD83F-9203-4170-882C-6C2B849D95DC', N'SW15990973', N'MW15990837'),
  ('35C00CCA-21C2-4427-BC6D-3F8C9BB15105', N'SW15990974', N'MW15990838'),
  ('4DD7DB0A-A491-476F-8A0D-2E82A120B841', N'SW15990975', N'MW15990839'),
  ('63DF3614-9C69-47FE-9EBA-1825725026D4', N'SW15990976', N'MW15990840'),
  ('D8B60FC6-AE9F-4032-A9B9-1839029903D7', N'SW15990977', N'MW15990841');

SELECT @EligibleCount = COUNT(*) FROM #WwwSaretteReIdMap;

BEGIN TRY
  BEGIN TRANSACTION;

  PRINT N'';
  PRINT N'========== DRY RUN: W.W.W. Sarette Brothers Inc → Standard + MW member IDs ==========';

  SELECT
    @DryRun AS DryRunFlag,
    @GroupId AS GroupId,
    @GroupName AS GroupName,
    @TenantId AS TenantId,
    @GroupPrefix AS GroupPrefix,
    @IndividualPrefix AS IndividualPrefix,
    @MemberCount AS MembersInGroup,
    @EligibleCount AS PrimariesToReId;

  PRINT N'--- Group change preview ---';
  SELECT
    g.GroupId,
    g.Name,
    g.GroupType AS current_group_type,
    N'Standard' AS proposed_group_type
  FROM oe.Groups g
  WHERE g.GroupId = @GroupId;

  PRINT N'--- Current SW IDs must match mapping (abort if mismatch) ---';
  SELECT
    r.MemberId,
    m.HouseholdMemberID AS actual_current_id,
    r.current_household_member_id AS expected_current_id,
    r.proposed_mw_id,
    CASE
      WHEN m.MemberId IS NULL THEN N'MEMBER NOT IN GROUP'
      WHEN m.HouseholdMemberID <> r.current_household_member_id THEN N'CURRENT ID MISMATCH'
      WHEN EXISTS (
        SELECT 1
        FROM oe.Members x
        WHERE x.HouseholdMemberID = r.proposed_mw_id
          AND x.MemberId <> r.MemberId
      ) THEN N'MW ID CONFLICT'
      ELSE N'OK'
    END AS status,
    LTRIM(RTRIM(CONCAT(u.FirstName, N' ', u.LastName))) AS member_name,
    u.Email
  FROM #WwwSaretteReIdMap r
  LEFT JOIN oe.Members m ON m.MemberId = r.MemberId AND m.GroupId = @GroupId
  LEFT JOIN oe.Users u ON u.UserId = m.UserId
  ORDER BY r.proposed_mw_id;

  IF EXISTS (
    SELECT 1
    FROM #WwwSaretteReIdMap r
    LEFT JOIN oe.Members m ON m.MemberId = r.MemberId AND m.GroupId = @GroupId
    WHERE m.MemberId IS NULL
       OR m.HouseholdMemberID <> r.current_household_member_id
  )
  BEGIN
    RAISERROR(N'One or more primaries have unexpected current SW IDs. Aborting.', 16, 1);
  END;

  IF EXISTS (
    SELECT 1
    FROM #WwwSaretteReIdMap r
    WHERE EXISTS (
      SELECT 1
      FROM oe.Members x
      WHERE x.HouseholdMemberID = r.proposed_mw_id
        AND x.MemberId <> r.MemberId
    )
  )
  BEGIN
    RAISERROR(N'Proposed MW IDs collide with existing members. Aborting.', 16, 1);
  END;

  PRINT N'--- No ID change (NULL — dependents / duplicate primary) ---';
  SELECT
    m.MemberId,
    m.RelationshipType,
    m.HouseholdMemberID,
    LTRIM(RTRIM(CONCAT(u.FirstName, N' ', u.LastName))) AS member_name,
    u.Email
  FROM oe.Members m
  LEFT JOIN oe.Users u ON u.UserId = m.UserId
  WHERE m.GroupId = @GroupId
    AND NOT EXISTS (SELECT 1 FROM #WwwSaretteReIdMap r WHERE r.MemberId = m.MemberId)
  ORDER BY m.RelationshipType DESC, member_name;

  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN complete — no changes applied. Set @DryRun = 0 to apply.' AS [Status];
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  PRINT N'--- Applying group type change ---';
  UPDATE oe.Groups
  SET
    GroupType = N'Standard',
    ModifiedDate = GETUTCDATE()
  WHERE GroupId = @GroupId
    AND GroupType = N'ListBill';

  IF @@ROWCOUNT <> 1
  BEGIN
    RAISERROR(N'GroupType update affected unexpected row count. Aborting.', 16, 1);
  END;

  PRINT N'--- Updating HouseholdMemberID SW → MW ---';
  UPDATE m
  SET
    m.HouseholdMemberID = r.proposed_mw_id,
    m.ModifiedDate = GETUTCDATE()
  FROM oe.Members m
  INNER JOIN #WwwSaretteReIdMap r ON r.MemberId = m.MemberId
  WHERE m.GroupId = @GroupId;

  IF @@ROWCOUNT <> @EligibleCount
  BEGIN
    RAISERROR(N'Member ID update affected unexpected row count. Aborting.', 16, 1);
  END;

  COMMIT TRANSACTION;

  SELECT
    N'Changes applied successfully' AS [Status],
    @EligibleCount AS primaries_re_ided,
    @MemberCount - @EligibleCount AS members_unchanged;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;

  SELECT
    ERROR_MESSAGE() AS [Error],
    ERROR_LINE() AS [Line],
    ERROR_NUMBER() AS [Number];
END CATCH;

IF OBJECT_ID('tempdb..#WwwSaretteReIdMap') IS NOT NULL DROP TABLE #WwwSaretteReIdMap;
