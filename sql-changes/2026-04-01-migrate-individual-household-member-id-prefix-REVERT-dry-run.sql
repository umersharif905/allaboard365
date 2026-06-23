/*
  REVERT: Change individual members (GroupId IS NULL) FROM individual prefix BACK TO group prefix,
  keeping the same numeric suffix (e.g. SW15990123 -> MW15990123).

  Use when integrations (e.g. Lyric telemedicine) expect the group-style member ID (MW).

  This is the inverse direction of 2026-04-01-migrate-individual-household-member-id-prefix-dry-run.sql.

  Set @FromPrefix = current prefix on members (e.g. SW) and @ToPrefix = desired prefix (e.g. MW).
  Optionally scope @TenantId. Run @DryRun = 1 first.

  After data is fixed, set oe.Tenants so MemberIDPrefix / IndividualMemberIDPrefix match your desired
  ongoing behavior (e.g. clear IndividualMemberIDPrefix or set both to MW if everyone should use MW).
*/

DECLARE @DryRun BIT = 1;  -- set to 0 to apply
DECLARE @TenantId UNIQUEIDENTIFIER = NULL;  -- optional: one tenant only
DECLARE @FromPrefix NVARCHAR(10) = N'SW';  -- prefix currently on rows (individual)
DECLARE @ToPrefix NVARCHAR(10) = N'MW';    -- prefix to restore (group / Lyric)

IF @FromPrefix IS NULL OR LTRIM(RTRIM(@FromPrefix)) = N''
   OR @ToPrefix IS NULL OR LTRIM(RTRIM(@ToPrefix)) = N''
BEGIN
  RAISERROR(N'Set @FromPrefix and @ToPrefix.', 16, 1);
  RETURN;
END

IF UPPER(LTRIM(RTRIM(@FromPrefix))) = UPPER(LTRIM(RTRIM(@ToPrefix)))
BEGIN
  RAISERROR(N'@FromPrefix and @ToPrefix must differ.', 16, 1);
  RETURN;
END

SET @FromPrefix = LTRIM(RTRIM(@FromPrefix));
SET @ToPrefix = LTRIM(RTRIM(@ToPrefix));

IF @DryRun = 1
BEGIN
  SELECT
    m.MemberId,
    m.TenantId,
    m.GroupId,
    m.HouseholdMemberID AS current_household_member_id,
    @ToPrefix + SUBSTRING(m.HouseholdMemberID, LEN(@FromPrefix) + 1, 50) AS proposed_household_member_id
  FROM oe.Members AS m
  WHERE m.GroupId IS NULL
    AND m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(@FromPrefix)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(@FromPrefix))) = UPPER(@FromPrefix)
    AND (@TenantId IS NULL OR m.TenantId = @TenantId)
  ORDER BY m.TenantId, m.HouseholdMemberID;
END
ELSE
BEGIN
  BEGIN TRANSACTION;

  UPDATE m
  SET
    HouseholdMemberID = @ToPrefix + SUBSTRING(m.HouseholdMemberID, LEN(@FromPrefix) + 1, 50),
    ModifiedDate = GETDATE()
  FROM oe.Members AS m
  WHERE m.GroupId IS NULL
    AND m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(@FromPrefix)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(@FromPrefix))) = UPPER(@FromPrefix)
    AND (@TenantId IS NULL OR m.TenantId = @TenantId);

  DECLARE @Rows INT = @@ROWCOUNT;
  COMMIT TRANSACTION;

  PRINT N'Updated rows: ' + CAST(@Rows AS NVARCHAR(20));
END
