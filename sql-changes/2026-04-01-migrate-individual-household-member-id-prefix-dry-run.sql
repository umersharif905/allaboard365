/*
  One-time data fix: set individual members (GroupId IS NULL) to the individual household ID prefix
  while keeping the same numeric suffix as the group prefix (e.g. MW15990123 -> SW15990123).

  Prefixes are read from oe.Tenants (MemberIDPrefix = group, IndividualMemberIDPrefix = individual).
  Run @DryRun = 1 first to review.

  Requires: column oe.Tenants.IndividualMemberIDPrefix populated and different from MemberIDPrefix
  for tenants where this applies.

  Deploy: run against the Open Enroll (oe) database after 2026-04-01-individual-member-id-prefix.sql.
*/

DECLARE @DryRun BIT = 1;  -- set to 0 to apply
DECLARE @TenantId UNIQUEIDENTIFIER = NULL;  -- optional: set to one tenant, or leave NULL for all tenants that qualify

DECLARE @Candidates TABLE (
  TenantId UNIQUEIDENTIFIER NOT NULL,
  GroupPrefix NVARCHAR(10) NOT NULL,
  IndividualPrefix NVARCHAR(10) NOT NULL
);

INSERT INTO @Candidates (TenantId, GroupPrefix, IndividualPrefix)
SELECT
  t.TenantId,
  NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N'') AS GroupPrefix,
  NULLIF(LTRIM(RTRIM(t.IndividualMemberIDPrefix)), N'') AS IndividualPrefix
FROM oe.Tenants AS t
WHERE t.IndividualMemberIDPrefix IS NOT NULL
  AND LTRIM(RTRIM(t.IndividualMemberIDPrefix)) <> N''
  AND NULLIF(LTRIM(RTRIM(t.MemberIDPrefix)), N'') IS NOT NULL
  AND UPPER(LTRIM(RTRIM(t.MemberIDPrefix))) <> UPPER(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
  AND (@TenantId IS NULL OR t.TenantId = @TenantId);

IF @DryRun = 1
BEGIN
  SELECT
    m.MemberId,
    m.TenantId,
    m.GroupId,
    m.HouseholdMemberID AS current_household_member_id,
    c.GroupPrefix,
    c.IndividualPrefix,
    c.IndividualPrefix
      + SUBSTRING(m.HouseholdMemberID, LEN(c.GroupPrefix) + 1, 50) AS proposed_household_member_id
  FROM oe.Members AS m
  INNER JOIN @Candidates AS c ON c.TenantId = m.TenantId
  WHERE m.GroupId IS NULL
    AND m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(c.GroupPrefix)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(c.GroupPrefix))) = UPPER(c.GroupPrefix)
  ORDER BY m.TenantId, m.HouseholdMemberID;
END
ELSE
BEGIN
  BEGIN TRANSACTION;

  UPDATE m
  SET
    HouseholdMemberID = c.IndividualPrefix
      + SUBSTRING(m.HouseholdMemberID, LEN(c.GroupPrefix) + 1, 50),
    ModifiedDate = GETDATE()
  FROM oe.Members AS m
  INNER JOIN @Candidates AS c ON c.TenantId = m.TenantId
  WHERE m.GroupId IS NULL
    AND m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(c.GroupPrefix)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(c.GroupPrefix))) = UPPER(c.GroupPrefix);

  DECLARE @Rows INT = @@ROWCOUNT;
  COMMIT TRANSACTION;

  PRINT N'Updated rows: ' + CAST(@Rows AS NVARCHAR(20));
END
