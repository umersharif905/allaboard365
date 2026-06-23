/*
  oe.GenerateHouseholdMemberID — individual vs group prefix (current product rule)

  - Group members (GroupId IS NOT NULL): stored ID uses Tenants.MemberIDPrefix (e.g. MW).
  - Individuals (GroupId IS NULL): stored ID uses COALESCE(IndividualMemberIDPrefix, MemberIDPrefix)
    so new individuals get the individual prefix in the database for real (e.g. SW…).

  Numeric suffix is MAX(existing suffix for that tenant among IDs with the *same effective prefix*) + 1.
  SW… and MW… sequences are independent.

  UI: resolveHouseholdMemberIdForDisplay still maps legacy MW… individuals to SW… for display only
  when the stored ID still starts with MemberIDPrefix but the member has no GroupId; new SW…
  stored IDs are shown as-is.

  Supersedes: sql-changes/2026-04-02-generate-household-member-id-use-member-prefix-only.sql

  Deploy: run against the Open Enroll (oe) database.
*/

CREATE OR ALTER PROCEDURE oe.GenerateHouseholdMemberID
  @TenantId UNIQUEIDENTIFIER,
  @MemberId UNIQUEIDENTIFIER,
  @HouseholdMemberID NVARCHAR(50) OUTPUT
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @MemberIDPrefix NVARCHAR(10);
  DECLARE @IndividualMemberIDPrefix NVARCHAR(10);
  DECLARE @GroupId UNIQUEIDENTIFIER;
  DECLARE @EffectivePrefix NVARCHAR(10);
  DECLARE @MaxSuffix BIGINT;
  DECLARE @Next BIGINT;

  SELECT
    @MemberIDPrefix = NULLIF(LTRIM(RTRIM(MemberIDPrefix)), N''),
    @IndividualMemberIDPrefix = NULLIF(LTRIM(RTRIM(IndividualMemberIDPrefix)), N'')
  FROM oe.Tenants WITH (NOLOCK)
  WHERE TenantId = @TenantId;

  IF @MemberIDPrefix IS NULL
    SET @MemberIDPrefix = N'OED';

  SELECT @GroupId = GroupId
  FROM oe.Members WITH (NOLOCK)
  WHERE MemberId = @MemberId;

  SET @EffectivePrefix = CASE
    WHEN @GroupId IS NULL THEN COALESCE(@IndividualMemberIDPrefix, @MemberIDPrefix)
    ELSE @MemberIDPrefix
  END;

  SELECT @MaxSuffix = MAX(
    TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(@EffectivePrefix) + 1, 50) AS BIGINT)
  )
  FROM oe.Members AS m WITH (NOLOCK)
  WHERE m.TenantId = @TenantId
    AND m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(@EffectivePrefix)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(@EffectivePrefix))) = UPPER(@EffectivePrefix)
    AND TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(@EffectivePrefix) + 1, 50) AS BIGINT) IS NOT NULL;

  SET @Next = ISNULL(@MaxSuffix, 0) + 1;
  SET @HouseholdMemberID = @EffectivePrefix + CAST(@Next AS NVARCHAR(30));
END
GO
