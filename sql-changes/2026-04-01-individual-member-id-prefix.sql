/*
  Individual vs group household member ID prefixes (OpenEnroll)

  1) Adds oe.Tenants.IndividualMemberIDPrefix (optional; NULL = use MemberIDPrefix for everyone).
  2) Replaces oe.GenerateHouseholdMemberID (see note below).

  Current procedure: sql-changes/2026-04-03-generate-household-member-id-individual-prefix-in-db.sql
  — individuals get IndividualMemberIDPrefix in DB; groups get MemberIDPrefix; UI masks legacy MW… only.

  If your database already has a customized GenerateHouseholdMemberID, compare OBJECT_DEFINITION
  and merge only the MAX-suffix logic, or restore from backup after review.

  Deploy: run against the Open Enroll (oe) database.
*/

IF COL_LENGTH('oe.Tenants', 'IndividualMemberIDPrefix') IS NULL
BEGIN
  ALTER TABLE oe.Tenants ADD IndividualMemberIDPrefix NVARCHAR(10) NULL;
END
GO

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
