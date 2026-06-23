-- =============================================================================
-- ListBill groups: reassign group-prefix HouseholdMemberIDs → individual prefix
-- =============================================================================
-- Problem:
--   Members in oe.Groups with GroupType = 'ListBill' are functionally individual
--   but often still have HouseholdMemberID using MemberIDPrefix (e.g. MW…)
--   instead of IndividualMemberIDPrefix (e.g. SW…). New enrollments are fixed
--   via oe.GenerateHouseholdMemberID (2026-04-29-listbill-individual-prefix.sql);
--   this script repairs existing data.
--
-- Rules (match 2026-05-27-www-sarette-listbill-sw-member-ids.sql):
--   * Scope: primaries only (RelationshipType = 'P').
--   * Must already have a group-prefix HouseholdMemberID (not NULL).
--   * Must have >= 1 Active oe.Enrollments row (avoids duplicate/orphan accounts).
--   * Assign next GLOBAL individual-prefix sequence per tenant prefix pair
--     (NOT a naive MW→SW suffix swap — SW15990826+ may already be taken).
--   * Dependents are not updated (eligibility exports use primary ID).
--
-- Tall Tree export cross-check:
--   2026-05-27: 39 EMP rows still MW… vs 28 SW…
--   2026-06-01: 6 EMP rows MW… (includes NEW ids MW15990852–55 → proc likely
--     not deployed on prod, and/or groups still Standard not ListBill)
--   Eligibility exports read oe.Members.HouseholdMemberID as-is — no ListBill
--   prefix transform in vendorExportService. DB must be fixed, then re-export.
--   See #CsvMwIds temp table below.
--
-- Run order:
--   1) Run PART 1 audit only (no transaction) — review counts by group/tenant.
--   2) @DryRun = 1 (default) — preview proposed IDs + conflicts; ROLLBACK.
--   3) Set @DryRun = 0 only with explicit approval.
--
-- Optional filters:
--   @TenantId = NULL  → all tenants with distinct group/individual prefixes
--   @TenantId = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826' → MightyWELL only
--   @GroupId   = NULL  → all ListBill groups (or set one GroupId to scope)
--
-- Deploy: run against allaboard-prod (oe schema).
-- =============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @TenantId UNIQUEIDENTIFIER = NULL;  -- MightyWELL: 1CD92AF7-B6F2-4E48-A8F3-EC6316158826
DECLARE @GroupId UNIQUEIDENTIFIER = NULL;     -- e.g. single group scope

-- =============================================================================
-- PART 1 — AUDIT (safe anytime; no writes)
-- =============================================================================
PRINT N'========== PART 0: Is oe.GenerateHouseholdMemberID deployed with ListBill fix? ==========';
SELECT
  CASE
    WHEN OBJECT_DEFINITION(OBJECT_ID(N'oe.GenerateHouseholdMemberID')) LIKE N'%@GroupType%ListBill%'
      OR OBJECT_DEFINITION(OBJECT_ID(N'oe.GenerateHouseholdMemberID')) LIKE N'%GroupType = N''ListBill''%'
    THEN N'YES — proc includes ListBill → individual prefix logic'
    ELSE N'NO — deploy sql-changes/2026-04-29-listbill-individual-prefix.sql first'
  END AS ProcListBillFixDeployed;

PRINT N'--- Recent primaries with MW IDs in ListBill groups (post–Apr 2026 enrollments) ---';
SELECT TOP 50
  m.HouseholdMemberID,
  m.CreatedDate,
  g.Name AS GroupName,
  g.GroupType,
  u.Email,
  u.FirstName,
  u.LastName
FROM oe.Members m
INNER JOIN oe.Groups g ON g.GroupId = m.GroupId
LEFT JOIN oe.Users u ON u.UserId = m.UserId
INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
WHERE g.GroupType = N'ListBill'
  AND m.RelationshipType = N'P'
  AND m.HouseholdMemberID IS NOT NULL
  AND m.CreatedDate >= '2026-04-01'
  AND LEN(m.HouseholdMemberID) > LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
  AND UPPER(LEFT(m.HouseholdMemberID, LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))))
    = UPPER(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
  AND (@TenantId IS NULL OR m.TenantId = @TenantId)
ORDER BY m.CreatedDate DESC;

PRINT N'========== PART 1: ListBill members with group-prefix HouseholdMemberID ==========';

SELECT
  t.TenantId,
  t.Name AS TenantName,
  t.MemberIDPrefix AS GroupPrefix,
  t.IndividualMemberIDPrefix AS IndividualPrefix,
  g.GroupId,
  g.Name AS GroupName,
  g.GroupType,
  COUNT(*) AS MembersInGroup,
  SUM(CASE
    WHEN m.RelationshipType = N'P'
      AND m.HouseholdMemberID IS NOT NULL
      AND LEN(m.HouseholdMemberID) > LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
      AND UPPER(LEFT(m.HouseholdMemberID, LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))))
        = UPPER(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
    THEN 1 ELSE 0
  END) AS PrimariesWithGroupPrefixId,
  SUM(CASE
    WHEN m.RelationshipType = N'P'
      AND m.HouseholdMemberID IS NOT NULL
      AND t.IndividualMemberIDPrefix IS NOT NULL
      AND LEN(m.HouseholdMemberID) > LEN(NULLIF(LTRIM(RTRIM(t.IndividualMemberIDPrefix)), N''))
      AND UPPER(LEFT(m.HouseholdMemberID, LEN(NULLIF(LTRIM(RTRIM(t.IndividualMemberIDPrefix)), N''))))
        = UPPER(NULLIF(LTRIM(RTRIM(t.IndividualMemberIDPrefix)), N''))
    THEN 1 ELSE 0
  END) AS PrimariesWithIndividualPrefixId
FROM oe.Groups g
INNER JOIN oe.Tenants t ON t.TenantId = g.TenantId
INNER JOIN oe.Members m ON m.GroupId = g.GroupId
WHERE g.GroupType = N'ListBill'
  AND (@TenantId IS NULL OR g.TenantId = @TenantId)
  AND (@GroupId IS NULL OR g.GroupId = @GroupId)
  AND t.IndividualMemberIDPrefix IS NOT NULL
  AND NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N'') IS NOT NULL
  AND UPPER(LTRIM(RTRIM(t.MemberIDPrefix))) <> UPPER(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
GROUP BY
  t.TenantId, t.Name, t.MemberIDPrefix, t.IndividualMemberIDPrefix,
  g.GroupId, g.Name, g.GroupType
HAVING SUM(CASE
  WHEN m.RelationshipType = N'P'
    AND m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))))
      = UPPER(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
  THEN 1 ELSE 0
END) > 0
ORDER BY t.Name, g.Name;

PRINT N'--- Primaries eligible for re-ID (MW→new SW sequence) ---';

SELECT
  t.Name AS TenantName,
  g.Name AS GroupName,
  g.GroupId,
  m.MemberId,
  m.HouseholdMemberID AS CurrentHouseholdMemberID,
  u.FirstName,
  u.LastName,
  u.Email,
  ISNULL(ae.ActiveEnrollmentCount, 0) AS ActiveEnrollmentCount
FROM oe.Members m
INNER JOIN oe.Groups g ON g.GroupId = m.GroupId
INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
LEFT JOIN oe.Users u ON u.UserId = m.UserId
OUTER APPLY (
  SELECT COUNT(*) AS ActiveEnrollmentCount
  FROM oe.Enrollments e
  WHERE e.MemberId = m.MemberId
    AND e.Status = N'Active'
) ae
WHERE g.GroupType = N'ListBill'
  AND m.RelationshipType = N'P'
  AND m.HouseholdMemberID IS NOT NULL
  AND t.IndividualMemberIDPrefix IS NOT NULL
  AND NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N'') IS NOT NULL
  AND UPPER(LTRIM(RTRIM(t.MemberIDPrefix))) <> UPPER(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
  AND LEN(m.HouseholdMemberID) > LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
  AND UPPER(LEFT(m.HouseholdMemberID, LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))))
    = UPPER(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
  AND (@TenantId IS NULL OR m.TenantId = @TenantId)
  AND (@GroupId IS NULL OR m.GroupId = @GroupId)
ORDER BY t.Name, g.Name, m.HouseholdMemberID;

-- Tall Tree export snapshots (union of 5-27 + 6-1 eligibility MW primaries)
IF OBJECT_ID('tempdb..#CsvMwIds') IS NOT NULL DROP TABLE #CsvMwIds;
CREATE TABLE #CsvMwIds (HouseholdMemberID NVARCHAR(50) NOT NULL PRIMARY KEY);
INSERT INTO #CsvMwIds (HouseholdMemberID) VALUES
  (N'MW15990544'),(N'MW15990553'),(N'MW15990564'),(N'MW15990570'),(N'MW15990571'),
  (N'MW15990574'),(N'MW15990581'),(N'MW15990583'),(N'MW15990584'),(N'MW15990586'),
  (N'MW15990597'),(N'MW15990601'),(N'MW15990604'),(N'MW15990613'),(N'MW15990724'),
  (N'MW15990759'),(N'MW15990769'),(N'MW15990770'),(N'MW15990783'),(N'MW15990787'),
  (N'MW15990794'),(N'MW15990799'),(N'MW15990800'),(N'MW15990803'),(N'MW15990812'),
  (N'MW15990815'),(N'MW15990816'),(N'MW15990817'),(N'MW15990818'),(N'MW15990819'),
  (N'MW15990820'),(N'MW15990821'),(N'MW15990824'),(N'MW15990825'),(N'MW15990844'),
  (N'MW15990845'),(N'MW15990846'),(N'MW15990847'),(N'MW15990850'),
  (N'MW15990852'),(N'MW15990853'),(N'MW15990854'),(N'MW15990855');

PRINT N'--- CSV cross-check: export MW IDs vs DB ListBill state ---';
SELECT
  c.HouseholdMemberID AS CsvMwId,
  m.MemberId,
  m.RelationshipType,
  g.Name AS GroupName,
  g.GroupType,
  t.Name AS TenantName,
  CASE
    WHEN m.MemberId IS NULL THEN N'NOT IN DB'
    WHEN g.GroupType <> N'ListBill' THEN N'IN DB — group not ListBill'
    WHEN m.RelationshipType <> N'P' THEN N'IN DB — not primary'
    WHEN ISNULL(ae.ActiveEnrollmentCount, 0) = 0 THEN N'IN DB ListBill primary — no active enrollment (excluded from fix)'
    ELSE N'ELIGIBLE for fix'
  END AS MatchStatus
FROM #CsvMwIds c
LEFT JOIN oe.Members m ON m.HouseholdMemberID = c.HouseholdMemberID
LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
LEFT JOIN oe.Tenants t ON t.TenantId = m.TenantId
OUTER APPLY (
  SELECT COUNT(*) AS ActiveEnrollmentCount
  FROM oe.Enrollments e
  WHERE e.MemberId = m.MemberId AND e.Status = N'Active'
) ae
ORDER BY MatchStatus, c.HouseholdMemberID;

DROP TABLE #CsvMwIds;

-- =============================================================================
-- PART 2 — APPLY (dry-run by default)
-- =============================================================================
IF OBJECT_ID('tempdb..#LbScoped') IS NOT NULL DROP TABLE #LbScoped;
IF OBJECT_ID('tempdb..#LbProposed') IS NOT NULL DROP TABLE #LbProposed;

CREATE TABLE #LbScoped (
  MemberId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
  TenantId UNIQUEIDENTIFIER NOT NULL,
  GroupId UNIQUEIDENTIFIER NOT NULL,
  GroupName NVARCHAR(255) NULL,
  TenantName NVARCHAR(255) NULL,
  GroupPrefix NVARCHAR(10) NOT NULL,
  IndividualPrefix NVARCHAR(10) NOT NULL,
  HouseholdId UNIQUEIDENTIFIER NULL,
  current_household_member_id NVARCHAR(50) NOT NULL,
  member_name NVARCHAR(255) NULL,
  Email NVARCHAR(255) NULL,
  ActiveEnrollmentCount INT NOT NULL
);

INSERT INTO #LbScoped (
  MemberId, TenantId, GroupId, GroupName, TenantName,
  GroupPrefix, IndividualPrefix, HouseholdId,
  current_household_member_id, member_name, Email, ActiveEnrollmentCount
)
SELECT
  m.MemberId,
  m.TenantId,
  g.GroupId,
  g.Name,
  t.Name,
  NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''),
  NULLIF(LTRIM(RTRIM(t.IndividualMemberIDPrefix)), N''),
  m.HouseholdId,
  m.HouseholdMemberID,
  LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))),
  u.Email,
  ISNULL(ae.ActiveEnrollmentCount, 0)
FROM oe.Members m
INNER JOIN oe.Groups g ON g.GroupId = m.GroupId
INNER JOIN oe.Tenants t ON t.TenantId = m.TenantId
LEFT JOIN oe.Users u ON u.UserId = m.UserId
OUTER APPLY (
  SELECT COUNT(*) AS ActiveEnrollmentCount
  FROM oe.Enrollments e
  WHERE e.MemberId = m.MemberId AND e.Status = N'Active'
) ae
WHERE g.GroupType = N'ListBill'
  AND m.RelationshipType = N'P'
  AND m.HouseholdMemberID IS NOT NULL
  AND t.IndividualMemberIDPrefix IS NOT NULL
  AND NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N'') IS NOT NULL
  AND UPPER(LTRIM(RTRIM(t.MemberIDPrefix))) <> UPPER(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
  AND LEN(m.HouseholdMemberID) > LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
  AND UPPER(LEFT(m.HouseholdMemberID, LEN(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))))
    = UPPER(NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N''))
  AND (@TenantId IS NULL OR m.TenantId = @TenantId)
  AND (@GroupId IS NULL OR m.GroupId = @GroupId);

DECLARE @EligibleCount INT = (
  SELECT COUNT(*) FROM #LbScoped WHERE ActiveEnrollmentCount > 0
);

IF @EligibleCount = 0
BEGIN
  RAISERROR(N'No eligible ListBill primaries with group-prefix IDs and active enrollments. Nothing to do.', 16, 1);
  RETURN;
END;

-- Global max suffix per individual prefix (same rule as oe.GenerateHouseholdMemberID)
CREATE TABLE #LbProposed (
  MemberId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
  TenantId UNIQUEIDENTIFIER NOT NULL,
  GroupId UNIQUEIDENTIFIER NOT NULL,
  GroupName NVARCHAR(255) NULL,
  TenantName NVARCHAR(255) NULL,
  IndividualPrefix NVARCHAR(10) NOT NULL,
  current_household_member_id NVARCHAR(50) NOT NULL,
  naive_prefix_swap_id NVARCHAR(50) NULL,
  proposed_household_member_id NVARCHAR(50) NOT NULL,
  member_name NVARCHAR(255) NULL,
  Email NVARCHAR(255) NULL
);

;WITH prefix_max AS (
  SELECT
    s.IndividualPrefix,
    MAX(
      TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(s.IndividualPrefix) + 1, 50) AS BIGINT)
    ) AS max_suffix
  FROM (SELECT DISTINCT IndividualPrefix FROM #LbScoped) s
  CROSS JOIN oe.Members m
  WHERE m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(s.IndividualPrefix)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(s.IndividualPrefix))) = UPPER(s.IndividualPrefix)
    AND TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(s.IndividualPrefix) + 1, 50) AS BIGINT) IS NOT NULL
  GROUP BY s.IndividualPrefix
),
eligible AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      PARTITION BY s.IndividualPrefix
      ORDER BY s.current_household_member_id, s.MemberId
    ) AS rn
  FROM #LbScoped s
  WHERE s.ActiveEnrollmentCount > 0
)
INSERT INTO #LbProposed (
  MemberId, TenantId, GroupId, GroupName, TenantName, IndividualPrefix,
  current_household_member_id, naive_prefix_swap_id, proposed_household_member_id,
  member_name, Email
)
SELECT
  e.MemberId,
  e.TenantId,
  e.GroupId,
  e.GroupName,
  e.TenantName,
  e.IndividualPrefix,
  e.current_household_member_id,
  e.IndividualPrefix + SUBSTRING(e.current_household_member_id, LEN(e.GroupPrefix) + 1, 50),
  e.IndividualPrefix + CAST(ISNULL(pm.max_suffix, 0) + e.rn AS NVARCHAR(30)),
  e.member_name,
  e.Email
FROM eligible e
LEFT JOIN prefix_max pm ON pm.IndividualPrefix = e.IndividualPrefix;

BEGIN TRY
  BEGIN TRANSACTION;

  PRINT N'';
  PRINT N'========== PART 2: Proposed ListBill HouseholdMemberID fixes ==========';

  SELECT
    @DryRun AS DryRunFlag,
    @TenantId AS FilterTenantId,
    @GroupId AS FilterGroupId,
    (SELECT COUNT(*) FROM #LbScoped) AS ScopedPrimariesWithMwPrefix,
    @EligibleCount AS EligibleToReId,
    (SELECT COUNT(*) FROM #LbScoped WHERE ActiveEnrollmentCount = 0) AS ExcludedNoActiveEnrollment;

  PRINT N'--- Summary by group ---';
  SELECT
    p.TenantName,
    p.GroupName,
    p.GroupId,
    COUNT(*) AS PrimariesToUpdate
  FROM #LbProposed p
  GROUP BY p.TenantName, p.GroupName, p.GroupId
  ORDER BY p.TenantName, p.GroupName;

  PRINT N'--- Excluded: ListBill primary with MW ID but no active enrollment ---';
  SELECT
    s.GroupName,
    s.member_name,
    s.Email,
    s.current_household_member_id,
    s.ActiveEnrollmentCount
  FROM #LbScoped s
  WHERE s.ActiveEnrollmentCount = 0
  ORDER BY s.GroupName, s.current_household_member_id;

  PRINT N'--- Naive prefix swap collisions (why we assign new sequence) ---';
  SELECT
    p.current_household_member_id,
    p.naive_prefix_swap_id,
    p.proposed_household_member_id,
    p.member_name,
    p.GroupName,
    existing_u.Email AS conflicting_email
  FROM #LbProposed p
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

  PRINT N'--- Proposed updates (review before @DryRun = 0) ---';
  SELECT
    p.TenantName,
    p.GroupName,
    p.member_name,
    p.Email,
    p.current_household_member_id,
    p.proposed_household_member_id,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM oe.Members m
        WHERE m.HouseholdMemberID = p.proposed_household_member_id
          AND m.MemberId <> p.MemberId
      ) THEN N'CONFLICT'
      ELSE N'OK'
    END AS proposed_id_status
  FROM #LbProposed p
  ORDER BY p.TenantName, p.GroupName, p.proposed_household_member_id;

  IF EXISTS (
    SELECT 1 FROM #LbProposed p
    WHERE EXISTS (
      SELECT 1 FROM oe.Members m
      WHERE m.HouseholdMemberID = p.proposed_household_member_id
        AND m.MemberId <> p.MemberId
    )
  )
  BEGIN
    RAISERROR(N'Proposed individual-prefix IDs collide with existing members. Aborting.', 16, 1);
  END;

  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN complete — no changes applied. Set @DryRun = 0 to apply.' AS [Status];
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  PRINT N'--- Applying HouseholdMemberID updates ---';
  UPDATE m
  SET
    m.HouseholdMemberID = p.proposed_household_member_id,
    m.ModifiedDate = SYSUTCDATETIME()
  FROM oe.Members m
  INNER JOIN #LbProposed p ON p.MemberId = m.MemberId;

  IF @@ROWCOUNT <> @EligibleCount
  BEGIN
    RAISERROR(N'Member ID update affected unexpected row count (%d expected %d). Aborting.', 16, 1, @@ROWCOUNT, @EligibleCount);
  END;

  COMMIT TRANSACTION;

  SELECT
    N'Changes applied successfully' AS [Status],
    @EligibleCount AS primaries_re_ided;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;

  SELECT
    ERROR_MESSAGE() AS [Error],
    ERROR_LINE() AS [Line],
    ERROR_NUMBER() AS [Number];
END CATCH;

IF OBJECT_ID('tempdb..#LbProposed') IS NOT NULL DROP TABLE #LbProposed;
IF OBJECT_ID('tempdb..#LbScoped') IS NOT NULL DROP TABLE #LbScoped;
