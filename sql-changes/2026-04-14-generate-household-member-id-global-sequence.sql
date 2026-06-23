/*
  Fix: Make HouseholdMemberID sequence GLOBAL per prefix, not per-tenant.

  Problem: The stored procedure scoped MAX(suffix) by TenantId, so two tenants
  sharing the same prefix (e.g. SW) could generate colliding IDs (SW1, SW2, etc.
  in both tenants independently).

  Fix: Remove the TenantId filter from the MAX suffix query so the sequence is
  shared across ALL tenants using the same effective prefix. This guarantees
  global uniqueness and means new tenants continue from where the highest
  existing ID left off.

  Example: MightyWELL has SW15990840, Pinnacle's next SW member gets SW15990841.

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

  -- Global sequence: find MAX suffix across ALL tenants using the same prefix.
  -- This guarantees HouseholdMemberID is unique across the entire system.
  SELECT @MaxSuffix = MAX(
    TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(@EffectivePrefix) + 1, 50) AS BIGINT)
  )
  FROM oe.Members AS m WITH (NOLOCK)
  WHERE m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(@EffectivePrefix)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(@EffectivePrefix))) = UPPER(@EffectivePrefix)
    AND TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(@EffectivePrefix) + 1, 50) AS BIGINT) IS NOT NULL;

  SET @Next = ISNULL(@MaxSuffix, 0) + 1;
  SET @HouseholdMemberID = @EffectivePrefix + CAST(@Next AS NVARCHAR(30));
END
