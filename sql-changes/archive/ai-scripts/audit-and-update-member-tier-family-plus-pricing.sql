/*
Audit + optional update for oe.Members.Tier with backup.

Intent:
1) Do NOT derive tier from dependent enrollments.
2) Derive household family-size tier from active household members (P/S/C existence).
3) Only auto-update when active charged ProductPricing tiers agree with family-size tier.
4) Backup all changed rows to dbo.MemberTierChangeBackup before update.

Usage:
- Dry run (default): set @DoUpdate = 0
- Apply updates:      set @DoUpdate = 1

Optional scope:
- Set @ScopeGroupId to a specific group to limit changes.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @AsOfDate date = CAST(GETUTCDATE() AS date);
DECLARE @DoUpdate bit = 0;              -- 0 = dry run, 1 = backup + update
DECLARE @RequirePricingAgreement bit = 1; -- 1 = only update when pricing tier matches family tier
DECLARE @ScopeGroupId uniqueidentifier = NULL; -- e.g. '824603B6-A4E3-4238-8152-ECEF455E5945'
DECLARE @RunId uniqueidentifier = NEWID();

IF OBJECT_ID('tempdb..#TierCandidates') IS NOT NULL DROP TABLE #TierCandidates;

;WITH ActiveMembers AS (
    SELECT
        m.MemberId,
        m.HouseholdId,
        m.RelationshipType,
        m.GroupId
    FROM oe.Members m
    WHERE m.Status = 'Active'
      AND (m.TerminationDate IS NULL OR m.TerminationDate > @AsOfDate)
      AND m.RelationshipType IN ('P', 'S', 'C')
      AND (@ScopeGroupId IS NULL OR m.GroupId = @ScopeGroupId)
),
HouseholdFamilyTier AS (
    SELECT
        am.HouseholdId,
        MAX(CASE WHEN am.RelationshipType = 'P' THEN 1 ELSE 0 END) AS HasPrimary,
        MAX(CASE WHEN am.RelationshipType = 'S' THEN 1 ELSE 0 END) AS HasSpouse,
        MAX(CASE WHEN am.RelationshipType = 'C' THEN 1 ELSE 0 END) AS HasChild,
        SUM(CASE WHEN am.RelationshipType = 'S' THEN 1 ELSE 0 END) AS SpouseCount,
        SUM(CASE WHEN am.RelationshipType = 'C' THEN 1 ELSE 0 END) AS ChildCount
    FROM ActiveMembers am
    GROUP BY am.HouseholdId
),
FamilyTierResolved AS (
    SELECT
        hft.HouseholdId,
        hft.SpouseCount,
        hft.ChildCount,
        CASE
            WHEN hft.HasSpouse = 1 AND hft.HasChild = 1 THEN 'EF'
            WHEN hft.HasSpouse = 1 AND hft.HasChild = 0 THEN 'ES'
            WHEN hft.HasSpouse = 0 AND hft.HasChild = 1 THEN 'EC'
            ELSE 'EE'
        END AS FamilyTier
    FROM HouseholdFamilyTier hft
    WHERE hft.HasPrimary = 1
),
PrimaryMembers AS (
    SELECT
        m.MemberId AS PrimaryMemberId,
        m.HouseholdId,
        m.GroupId,
        m.Tier AS CurrentTier,
        m.ModifiedDate,
        u.FirstName,
        u.LastName
    FROM oe.Members m
    LEFT JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.RelationshipType = 'P'
      AND m.Status = 'Active'
      AND (@ScopeGroupId IS NULL OR m.GroupId = @ScopeGroupId)
),
ActiveChargedPricingTiers AS (
    SELECT DISTINCT
        e.HouseholdId,
        pp.TierType
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
    LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
    WHERE e.EnrollmentType = 'Product'
      AND e.Status NOT IN ('Pending', 'Cancelled', 'Denied', 'Inactive')
      AND e.EffectiveDate <= @AsOfDate
      AND (e.TerminationDate IS NULL OR e.TerminationDate > @AsOfDate)
      AND COALESCE(e.PremiumAmount, 0) > 0
      AND pp.TierType IN ('EE', 'ES', 'EC', 'EF')
      AND (@ScopeGroupId IS NULL OR e.GroupId = @ScopeGroupId OR m.GroupId = @ScopeGroupId)
),
PricingTierByHousehold AS (
    SELECT
        act.HouseholdId,
        COUNT(DISTINCT act.TierType) AS DistinctPricingTierCount,
        MIN(act.TierType) AS MinTierType,
        MAX(act.TierType) AS MaxTierType,
        CASE
            WHEN COUNT(DISTINCT act.TierType) = 1 THEN MIN(act.TierType)
            ELSE NULL
        END AS PricingTier
    FROM ActiveChargedPricingTiers act
    GROUP BY act.HouseholdId
)
SELECT
    pm.PrimaryMemberId,
    pm.HouseholdId,
    pm.GroupId,
    pm.FirstName,
    pm.LastName,
    pm.CurrentTier,
    ftr.FamilyTier AS ComputedFamilyTier,
    pth.PricingTier,
    pth.DistinctPricingTierCount,
    ftr.SpouseCount,
    ftr.ChildCount,
    pm.ModifiedDate,
    CAST(CASE WHEN ISNULL(pm.CurrentTier, '') <> ISNULL(ftr.FamilyTier, '') THEN 1 ELSE 0 END AS bit) AS TierWouldChange,
    CAST(CASE WHEN pth.PricingTier IS NOT NULL AND pth.PricingTier = ftr.FamilyTier THEN 1 ELSE 0 END AS bit) AS PricingAgreesWithFamilyTier,
    CAST(CASE
            WHEN ISNULL(pm.CurrentTier, '') <> ISNULL(ftr.FamilyTier, '')
             AND (
                    @RequirePricingAgreement = 0
                    OR (pth.PricingTier IS NOT NULL AND pth.PricingTier = ftr.FamilyTier)
                 )
            THEN 1 ELSE 0
         END AS bit) AS EligibleForUpdate
INTO #TierCandidates
FROM PrimaryMembers pm
INNER JOIN FamilyTierResolved ftr ON ftr.HouseholdId = pm.HouseholdId
LEFT JOIN PricingTierByHousehold pth ON pth.HouseholdId = pm.HouseholdId;

-- Preview all mismatches (regardless of eligibility)
SELECT
    PrimaryMemberId,
    HouseholdId,
    GroupId,
    FirstName,
    LastName,
    CurrentTier,
    ComputedFamilyTier,
    PricingTier,
    DistinctPricingTierCount,
    SpouseCount,
    ChildCount,
    TierWouldChange,
    PricingAgreesWithFamilyTier,
    EligibleForUpdate
FROM #TierCandidates
WHERE TierWouldChange = 1
ORDER BY LastName, FirstName;

-- Summary counts
SELECT
    COUNT(*) AS TotalPrimariesEvaluated,
    SUM(CASE WHEN TierWouldChange = 1 THEN 1 ELSE 0 END) AS TotalTierMismatches,
    SUM(CASE WHEN TierWouldChange = 1 AND PricingAgreesWithFamilyTier = 1 THEN 1 ELSE 0 END) AS MismatchesWithPricingAgreement,
    SUM(CASE WHEN EligibleForUpdate = 1 THEN 1 ELSE 0 END) AS TotalEligibleForUpdate
FROM #TierCandidates;

IF (@DoUpdate = 1)
BEGIN
    BEGIN TRANSACTION;

    IF OBJECT_ID('dbo.MemberTierChangeBackup', 'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MemberTierChangeBackup (
            BackupId bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
            RunId uniqueidentifier NOT NULL,
            BackedUpAt datetime2(7) NOT NULL,
            AsOfDate date NOT NULL,
            MemberId uniqueidentifier NOT NULL,
            HouseholdId uniqueidentifier NULL,
            GroupId uniqueidentifier NULL,
            FirstName nvarchar(256) NULL,
            LastName nvarchar(256) NULL,
            OldTier nvarchar(10) NULL,
            NewTier nvarchar(10) NULL,
            ComputedFamilyTier nvarchar(10) NULL,
            PricingTier nvarchar(10) NULL,
            DistinctPricingTierCount int NULL,
            SpouseCount int NULL,
            ChildCount int NULL
        );
    END;

    INSERT INTO dbo.MemberTierChangeBackup (
        RunId,
        BackedUpAt,
        AsOfDate,
        MemberId,
        HouseholdId,
        GroupId,
        FirstName,
        LastName,
        OldTier,
        NewTier,
        ComputedFamilyTier,
        PricingTier,
        DistinctPricingTierCount,
        SpouseCount,
        ChildCount
    )
    SELECT
        @RunId,
        SYSUTCDATETIME(),
        @AsOfDate,
        tc.PrimaryMemberId,
        tc.HouseholdId,
        tc.GroupId,
        tc.FirstName,
        tc.LastName,
        tc.CurrentTier,
        tc.ComputedFamilyTier,
        tc.ComputedFamilyTier,
        tc.PricingTier,
        tc.DistinctPricingTierCount,
        tc.SpouseCount,
        tc.ChildCount
    FROM #TierCandidates tc
    WHERE tc.EligibleForUpdate = 1;

    UPDATE m
    SET
        m.Tier = tc.ComputedFamilyTier,
        m.ModifiedDate = SYSUTCDATETIME()
    FROM oe.Members m
    INNER JOIN #TierCandidates tc ON tc.PrimaryMemberId = m.MemberId
    WHERE tc.EligibleForUpdate = 1;

    -- Show exactly what was changed in this run.
    SELECT
        b.RunId,
        b.BackedUpAt,
        b.MemberId,
        b.HouseholdId,
        b.GroupId,
        b.FirstName,
        b.LastName,
        b.OldTier,
        b.NewTier,
        b.ComputedFamilyTier,
        b.PricingTier,
        b.DistinctPricingTierCount
    FROM dbo.MemberTierChangeBackup b
    WHERE b.RunId = @RunId
    ORDER BY b.LastName, b.FirstName;

    COMMIT TRANSACTION;
END;

