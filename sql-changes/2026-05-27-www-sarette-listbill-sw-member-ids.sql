-- =============================================================================
-- W.W.W. Sarette Brothers Inc — convert Standard group to ListBill and reassign
-- SW-prefixed HouseholdMemberIDs for primaries that already have MW IDs.
-- =============================================================================
-- Group:  W.W.W. Sarette Brothers Inc
-- GroupId: 7CE2E221-20EA-477B-8368-5532853D04A4
-- Tenant: MightyWELL Health (1CD92AF7-B6F2-4E48-A8F3-EC6316158826)
--
-- Rules:
--   * Set GroupType = ListBill.
--   * Only update members who ALREADY have a group-prefix HouseholdMemberID (MW…).
--   * Never assign a new ID to a member whose HouseholdMemberID is currently NULL
--     (dependents stay NULL; orphan/duplicate primaries stay NULL).
--   * Member must have at least one Active oe.Enrollments row (picks the real
--     primary when duplicate accounts exist — e.g. Noelle Rohde w/ enrollments).
--
-- IMPORTANT — suffix collision:
--   SW15990826–SW15990841 are already assigned to other individual members.
--   A naive MW→SW prefix swap would violate uniqueness. This script assigns
--   the next global SW sequence values (same rule as oe.GenerateHouseholdMemberID)
--   only to the 16 eligible primaries, ordered by current MW ID.
--
-- Run order:
--   1) @DryRun = 1 (default) — preview only; ROLLBACK, no data changes.
--   2) Review collision note + proposed IDs + excluded members.
--   3) Set @DryRun = 0 only with explicit approval.
--
-- Deploy: run against allaboard-prod (oe schema).
-- =============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @GroupId UNIQUEIDENTIFIER = '7CE2E221-20EA-477B-8368-5532853D04A4';
DECLARE @TenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
DECLARE @GroupName NVARCHAR(255) = N'W.W.W. Sarette Brothers Inc';

DECLARE @GroupPrefix NVARCHAR(10);
DECLARE @IndividualPrefix NVARCHAR(10);
DECLARE @MaxSuffix BIGINT;
DECLARE @MemberCount INT;
DECLARE @EligibleCount INT;

SELECT
  @GroupPrefix = NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''),
  @IndividualPrefix = NULLIF(LTRIM(RTRIM(t.IndividualMemberIDPrefix)), N'')
FROM oe.Tenants t
WHERE t.TenantId = @TenantId;

IF @IndividualPrefix IS NULL OR @GroupPrefix IS NULL
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

IF EXISTS (
  SELECT 1
  FROM oe.Groups g
  WHERE g.GroupId = @GroupId
    AND g.GroupType = N'ListBill'
)
BEGIN
  RAISERROR(N'Group is already ListBill. Inspect member IDs separately before re-running.', 16, 1);
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

SELECT @MaxSuffix = MAX(
  TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(@IndividualPrefix) + 1, 50) AS BIGINT)
)
FROM oe.Members m
WHERE m.HouseholdMemberID IS NOT NULL
  AND LEN(m.HouseholdMemberID) > LEN(@IndividualPrefix)
  AND UPPER(LEFT(m.HouseholdMemberID, LEN(@IndividualPrefix))) = UPPER(@IndividualPrefix)
  AND TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(@IndividualPrefix) + 1, 50) AS BIGINT) IS NOT NULL;

SET @MaxSuffix = ISNULL(@MaxSuffix, 0);

IF OBJECT_ID('tempdb..#WwwScoped') IS NOT NULL DROP TABLE #WwwScoped;
IF OBJECT_ID('tempdb..#WwwProposedIds') IS NOT NULL DROP TABLE #WwwProposedIds;

CREATE TABLE #WwwScoped (
  MemberId UNIQUEIDENTIFIER NOT NULL,
  HouseholdId UNIQUEIDENTIFIER NULL,
  RelationshipType NVARCHAR(10) NULL,
  current_household_member_id NVARCHAR(50) NULL,
  CreatedDate DATETIME2 NULL,
  member_name NVARCHAR(255) NULL,
  Email NVARCHAR(255) NULL,
  ActiveEnrollmentCount INT NOT NULL
);

INSERT INTO #WwwScoped (
  MemberId,
  HouseholdId,
  RelationshipType,
  current_household_member_id,
  CreatedDate,
  member_name,
  Email,
  ActiveEnrollmentCount
)
SELECT
  m.MemberId,
  m.HouseholdId,
  m.RelationshipType,
  m.HouseholdMemberID,
  m.CreatedDate,
  LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))),
  u.Email,
  ISNULL(active_enrollments.ActiveEnrollmentCount, 0)
FROM oe.Members m
LEFT JOIN oe.Users u ON u.UserId = m.UserId
OUTER APPLY (
  SELECT COUNT(*) AS ActiveEnrollmentCount
  FROM oe.Enrollments e
  WHERE e.MemberId = m.MemberId
    AND e.Status = N'Active'
) active_enrollments
WHERE m.GroupId = @GroupId;

CREATE TABLE #WwwProposedIds (
  MemberId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
  HouseholdId UNIQUEIDENTIFIER NULL,
  RelationshipType NVARCHAR(10) NULL,
  member_name NVARCHAR(255) NULL,
  Email NVARCHAR(255) NULL,
  current_household_member_id NVARCHAR(50) NULL,
  naive_prefix_swap_id NVARCHAR(50) NULL,
  proposed_household_member_id NVARCHAR(50) NOT NULL
);

;WITH eligible AS (
  SELECT
    s.MemberId,
    s.HouseholdId,
    s.RelationshipType,
    s.current_household_member_id,
    s.CreatedDate,
    s.member_name,
    s.Email,
    s.ActiveEnrollmentCount,
    ROW_NUMBER() OVER (
      ORDER BY s.current_household_member_id, s.CreatedDate, s.MemberId
    ) AS rn
  FROM #WwwScoped s
  WHERE s.current_household_member_id IS NOT NULL
    AND LEN(s.current_household_member_id) > LEN(@GroupPrefix)
    AND UPPER(LEFT(s.current_household_member_id, LEN(@GroupPrefix))) = UPPER(@GroupPrefix)
    AND s.ActiveEnrollmentCount > 0
)
INSERT INTO #WwwProposedIds (
  MemberId,
  HouseholdId,
  RelationshipType,
  member_name,
  Email,
  current_household_member_id,
  naive_prefix_swap_id,
  proposed_household_member_id
)
SELECT
  e.MemberId,
  e.HouseholdId,
  e.RelationshipType,
  e.member_name,
  e.Email,
  e.current_household_member_id,
  @IndividualPrefix
    + SUBSTRING(e.current_household_member_id, LEN(@GroupPrefix) + 1, 50),
  @IndividualPrefix + CAST(@MaxSuffix + e.rn AS NVARCHAR(30))
FROM eligible e;

SELECT @EligibleCount = COUNT(*) FROM #WwwProposedIds;

IF @EligibleCount <> 16
BEGIN
  RAISERROR(N'Expected 16 eligible primaries with MW IDs + active enrollments; found %d. Aborting.', 16, 1, @EligibleCount);
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  PRINT N'';
  PRINT N'========== DRY RUN: W.W.W. Sarette Brothers Inc → ListBill + SW member IDs ==========';

  SELECT
    @DryRun AS DryRunFlag,
    @GroupId AS GroupId,
    @GroupName AS GroupName,
    @TenantId AS TenantId,
    @GroupPrefix AS GroupPrefix,
    @IndividualPrefix AS IndividualPrefix,
    @MaxSuffix AS CurrentMaxSWSuffix,
    @MemberCount AS MembersInGroup,
    @EligibleCount AS PrimariesToReId;

  PRINT N'--- Group change preview ---';
  SELECT
    g.GroupId,
    g.Name,
    g.GroupType AS current_group_type,
    N'ListBill' AS proposed_group_type
  FROM oe.Groups g
  WHERE g.GroupId = @GroupId;

  PRINT N'--- Excluded members (NULL ID and/or no active enrollments — no change) ---';
  SELECT
    s.HouseholdId,
    s.RelationshipType,
    s.member_name,
    s.Email,
    s.current_household_member_id,
    s.ActiveEnrollmentCount,
    CASE
      WHEN s.current_household_member_id IS NULL THEN N'NULL HouseholdMemberID — skip'
      WHEN s.ActiveEnrollmentCount = 0 THEN N'No active enrollments — skip'
      ELSE N'Unexpected — review'
    END AS exclusion_reason
  FROM #WwwScoped s
  WHERE NOT EXISTS (
    SELECT 1 FROM #WwwProposedIds p WHERE p.MemberId = s.MemberId
  )
  ORDER BY s.member_name, s.Email;

  PRINT N'--- Suffix collision: naive MW→SW swap vs existing SW IDs (expect 16 conflicts) ---';
  SELECT
    p.MemberId,
    p.member_name,
    p.current_household_member_id,
    p.naive_prefix_swap_id,
    existing.MemberId AS conflicting_member_id,
    existing_u.Email AS conflicting_member_email
  FROM #WwwProposedIds p
  OUTER APPLY (
    SELECT TOP 1 m.MemberId
    FROM oe.Members m
    WHERE m.HouseholdMemberID = p.naive_prefix_swap_id
      AND m.MemberId <> p.MemberId
  ) existing
  LEFT JOIN oe.Members existing_m ON existing_m.MemberId = existing.MemberId
  LEFT JOIN oe.Users existing_u ON existing_u.UserId = existing_m.UserId
  WHERE existing.MemberId IS NOT NULL
  ORDER BY p.naive_prefix_swap_id;

  PRINT N'--- Proposed HouseholdMemberID updates (16 primaries only) ---';
  SELECT
    p.HouseholdId,
    p.RelationshipType,
    p.member_name,
    p.Email,
    p.current_household_member_id,
    p.proposed_household_member_id,
    s.ActiveEnrollmentCount,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM oe.Members m
        WHERE m.HouseholdMemberID = p.proposed_household_member_id
          AND m.MemberId <> p.MemberId
      ) THEN N'CONFLICT'
      ELSE N'OK'
    END AS proposed_id_status
  FROM #WwwProposedIds p
  INNER JOIN #WwwScoped s ON s.MemberId = p.MemberId
  ORDER BY p.proposed_household_member_id;

  IF EXISTS (
    SELECT 1
    FROM #WwwProposedIds p
    WHERE EXISTS (
      SELECT 1
      FROM oe.Members m
      WHERE m.HouseholdMemberID = p.proposed_household_member_id
        AND m.MemberId <> p.MemberId
    )
  )
  BEGIN
    RAISERROR(N'Proposed SW IDs collide with existing members. Aborting.', 16, 1);
  END;

  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN complete — no changes applied. Set @DryRun = 0 to apply.' AS [Status];
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  PRINT N'--- Applying group type change ---';
  UPDATE oe.Groups
  SET
    GroupType = N'ListBill',
    ModifiedDate = GETUTCDATE()
  WHERE GroupId = @GroupId
    AND GroupType = N'Standard';

  IF @@ROWCOUNT <> 1
  BEGIN
    RAISERROR(N'GroupType update affected unexpected row count. Aborting.', 16, 1);
  END;

  PRINT N'--- Applying HouseholdMemberID updates ---';
  UPDATE m
  SET
    m.HouseholdMemberID = p.proposed_household_member_id,
    m.ModifiedDate = GETUTCDATE()
  FROM oe.Members m
  INNER JOIN #WwwProposedIds p ON p.MemberId = m.MemberId
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

IF OBJECT_ID('tempdb..#WwwProposedIds') IS NOT NULL DROP TABLE #WwwProposedIds;
IF OBJECT_ID('tempdb..#WwwScoped') IS NOT NULL DROP TABLE #WwwScoped;
