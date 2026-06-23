/*
  Fix: Make oe.GenerateHouseholdMemberID treat ListBill members as individuals.

  Problem: The procedure picked the prefix based solely on whether the member
  has a GroupId. ListBill groups are billing aggregations of functionally-
  individual members, but they ARE rows in oe.Groups, so members in them have
  a GroupId — and were getting the group prefix (e.g. MW) instead of the
  individual prefix (e.g. SW). That wrong prefix flowed downstream into ID
  cards, eligibility exports, and member portals, where it tells consumers
  "employer-sponsored employee" when the member is actually individually
  enrolled.

  Fix: Treat GroupType = 'ListBill' the same as "no group" for prefix purposes.
  Tenant-configured prefixes (oe.Tenants.MemberIDPrefix /
  IndividualMemberIDPrefix) are still the source of truth — nothing is hard-
  coded.

  No caller signature changes: GroupType is derived from oe.Groups inside the
  proc, same way GroupId is derived from oe.Members.

  Idempotent (CREATE OR ALTER).

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
  DECLARE @GroupType NVARCHAR(50);
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

  -- Derive both GroupId and the GroupType so we can recognize ListBill groups.
  SELECT
    @GroupId = m.GroupId,
    @GroupType = g.GroupType
  FROM oe.Members AS m WITH (NOLOCK)
  LEFT JOIN oe.Groups AS g WITH (NOLOCK) ON g.GroupId = m.GroupId
  WHERE m.MemberId = @MemberId;

  -- ListBill members are functionally individual: bill-aggregation only, no
  -- employer sponsorship. They get the individual prefix just like a member
  -- with no GroupId at all.
  SET @EffectivePrefix = CASE
    WHEN @GroupId IS NULL OR @GroupType = N'ListBill'
      THEN COALESCE(@IndividualMemberIDPrefix, @MemberIDPrefix)
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
