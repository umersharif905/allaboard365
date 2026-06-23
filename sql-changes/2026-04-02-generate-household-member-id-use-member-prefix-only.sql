/*
  Hotfix (superseded): oe.GenerateHouseholdMemberID always used MemberIDPrefix.

  Superseded by: sql-changes/2026-04-03-generate-household-member-id-individual-prefix-in-db.sql
  — individuals use IndividualMemberIDPrefix in the DB; UI masking covers legacy MW-only rows.

  Deploy: skip if you will deploy 2026-04-03 instead; otherwise run against oe for interim MW-only gen.
*/

CREATE OR ALTER PROCEDURE oe.GenerateHouseholdMemberID
  @TenantId UNIQUEIDENTIFIER,
  @MemberId UNIQUEIDENTIFIER,
  @HouseholdMemberID NVARCHAR(50) OUTPUT
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @MemberIDPrefix NVARCHAR(10);
  DECLARE @EffectivePrefix NVARCHAR(10);
  DECLARE @MaxSuffix BIGINT;
  DECLARE @Next BIGINT;

  SELECT
    @MemberIDPrefix = NULLIF(LTRIM(RTRIM(MemberIDPrefix)), N'')
  FROM oe.Tenants WITH (NOLOCK)
  WHERE TenantId = @TenantId;

  IF @MemberIDPrefix IS NULL
    SET @MemberIDPrefix = N'OED';

  -- Always use MemberIDPrefix for the stored ID (e.g. MW for Lyric).
  -- IndividualMemberIDPrefix is UI-only; do not generate SW1/SW2 in the database.
  SET @EffectivePrefix = @MemberIDPrefix;

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

/*
  Optional — preview members whose stored ID uses IndividualMemberIDPrefix (e.g. SW%)
  while the tenant’s MemberIDPrefix is different (e.g. MW). These may need manual
  correction after Lyric/external sync rules are agreed.

  SELECT m.MemberId, u.Email, m.HouseholdMemberID, t.MemberIDPrefix, t.IndividualMemberIDPrefix
  FROM oe.Members m
  JOIN oe.Users u ON u.UserId = m.UserId
  JOIN oe.Tenants t ON t.TenantId = m.TenantId
  WHERE m.HouseholdMemberID IS NOT NULL
    AND t.IndividualMemberIDPrefix IS NOT NULL
    AND LTRIM(RTRIM(t.MemberIDPrefix)) <> LTRIM(RTRIM(t.IndividualMemberIDPrefix))
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))))
      = UPPER(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
  ORDER BY m.CreatedDate DESC;
*/
