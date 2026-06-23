-- Migration: Alexander + Bohn GetWell overlapping enrollment rows (payables contract rate)
-- Date: 2026-06-10
--
-- Problem: May ARM Dental payables show $61.92 (old ES net) instead of $66.30 (current tier).
-- Cause: inactive/overlapping GetWell rows still span 5/1-5/31 at the old net; payables picks them.
--
-- Fix: close old-rate rows before May billing; single active row per member at $66.30 from 5/1.
-- PremiumAmount is NOT updated — member billing/all-in premium unchanged.
--
-- Alexander (MW15990622): C4466879 old May row -> term 4/30; 6E0ED047 new row eff 6/1 -> 5/1.
-- Bohn (MW15990733):     close all old-rate May overlaps -> term 4/30; 382FA234 eff 6/1 -> 5/1 if needed.
-- (If sabba-bohn B3 moved new row to 6/1, May payables had zero enrollments — member dropped off file.)

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @GetWellProductId UNIQUEIDENTIFIER = '1D5DA922-31E6-401D-8346-D3340FDC4294';

DECLARE @AlexanderHouseholdId UNIQUEIDENTIFIER = (
    SELECT TOP 1 m.HouseholdId
    FROM oe.Members m
    WHERE m.HouseholdMemberID = N'MW15990622' AND m.RelationshipType = N'P'
);
DECLARE @BohnHouseholdId UNIQUEIDENTIFIER = (
    SELECT TOP 1 m.HouseholdId
    FROM oe.Members m
    WHERE m.HouseholdMemberID = N'MW15990733' AND m.RelationshipType = N'P'
);

-- Alexander
DECLARE @AlexOldMayRow UNIQUEIDENTIFIER = 'C4466879-37E2-42C3-9D58-3DEA91912E5C';
DECLARE @AlexNewRow     UNIQUEIDENTIFIER = '6E0ED047-A8D2-40AB-A93C-4A573DD12284';

-- Bohn
DECLARE @BohnOldMayRow UNIQUEIDENTIFIER = '2A8346DC-F1E4-4DC5-817A-BC64A4C49984';
DECLARE @BohnNewRow    UNIQUEIDENTIFIER = '382FA234-E8E8-4AD8-BCBE-B48BFCE49B4F';

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Preview of changes:' AS [Status];

        SELECT
            'Alexander + Bohn GetWell rows' AS [Fix],
            m.HouseholdMemberID,
            CAST(e.EnrollmentId AS NVARCHAR(36)) AS EnrollmentId,
            e.Status,
            CONVERT(VARCHAR(10), e.EffectiveDate, 120) AS [Eff_Before],
            CASE
                WHEN e.EnrollmentId IN (@AlexNewRow, @BohnNewRow)
                     AND CAST(e.EffectiveDate AS DATE) IN ('2026-05-01', '2026-06-01')
                THEN '2026-05-01'
                ELSE CONVERT(VARCHAR(10), e.EffectiveDate, 120)
            END AS [Eff_After],
            CONVERT(VARCHAR(10), e.TerminationDate, 120) AS [Term_Before],
            CASE
                WHEN e.EnrollmentId = @AlexOldMayRow THEN '2026-04-30'
                WHEN e.HouseholdId = @BohnHouseholdId
                     AND CAST(COALESCE(NULLIF(e.NetRate, 0), pp.NetRate) AS DECIMAL(10, 2)) < 66.30
                     AND CAST(e.EffectiveDate AS DATE) <= '2026-05-31'
                     AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > '2026-05-01')
                THEN '2026-04-30'
                ELSE CONVERT(VARCHAR(10), e.TerminationDate, 120)
            END AS [Term_After],
            CAST(e.PremiumAmount AS DECIMAL(10, 2)) AS PremiumAmount,
            CAST(COALESCE(NULLIF(e.NetRate, 0), pp.NetRate) AS DECIMAL(10, 2)) AS NetRate
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = N'P'
        LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
        WHERE e.ProductId = @GetWellProductId
          AND e.EnrollmentId IN (@AlexOldMayRow, @AlexNewRow, @BohnOldMayRow, @BohnNewRow)
        ORDER BY m.HouseholdMemberID, e.EffectiveDate;

        SELECT
            'May payables overlap check (should be 0 rows after apply)' AS [Check],
            m.HouseholdMemberID,
            CAST(e.EnrollmentId AS NVARCHAR(36)) AS EnrollmentId,
            CONVERT(VARCHAR(10), e.EffectiveDate, 120) AS Eff,
            CONVERT(VARCHAR(10), e.TerminationDate, 120) AS Term,
            CAST(COALESCE(NULLIF(e.NetRate, 0), pp.NetRate) AS DECIMAL(10, 2)) AS NetRate
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = N'P'
        LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
        WHERE e.ProductId = @GetWellProductId
          AND m.HouseholdMemberID IN (N'MW15990622', N'MW15990733')
          AND CAST(e.EffectiveDate AS DATE) <= '2026-05-31'
          AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > '2026-05-01')
          AND CAST(COALESCE(NULLIF(e.NetRate, 0), pp.NetRate) AS DECIMAL(10, 2)) < 66.30
        ORDER BY m.HouseholdMemberID;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    ------------------------------------------------------------------
    -- Alexander: close old May row; backdate new-rate row to 5/1
    ------------------------------------------------------------------
    UPDATE oe.Enrollments
    SET TerminationDate = '2026-04-30',
        ModifiedDate = SYSUTCDATETIME()
    WHERE EnrollmentId = @AlexOldMayRow
      AND HouseholdId = @AlexanderHouseholdId
      AND ProductId = @GetWellProductId
      AND CAST(EffectiveDate AS DATE) = '2026-05-01'
      AND (TerminationDate IS NULL OR CAST(TerminationDate AS DATE) >= '2026-05-01');

    IF @@ROWCOUNT <> 1
        THROW 50001, 'Alexander: expected exactly 1 old May row to close', 1;

    UPDATE oe.Enrollments
    SET EffectiveDate = '2026-05-01',
        ModifiedDate = SYSUTCDATETIME()
    WHERE EnrollmentId = @AlexNewRow
      AND HouseholdId = @AlexanderHouseholdId
      AND ProductId = @GetWellProductId
      AND CAST(EffectiveDate AS DATE) = '2026-06-01'
      AND TerminationDate IS NULL
      AND Status = N'Active';

    IF @@ROWCOUNT <> 1
        THROW 50002, 'Alexander: expected exactly 1 new-rate row to backdate to 5/1', 1;

    ------------------------------------------------------------------
    -- Bohn: close every old-rate row still spanning May (not only 2A8346DC)
    ------------------------------------------------------------------
    UPDATE oe.Enrollments
    SET TerminationDate = '2026-04-30',
        ModifiedDate = SYSUTCDATETIME()
    WHERE HouseholdId = @BohnHouseholdId
      AND ProductId = @GetWellProductId
      AND CAST(COALESCE(NULLIF(NetRate, 0), 0) AS DECIMAL(10, 2)) < 66.30
      AND CAST(EffectiveDate AS DATE) <= '2026-05-31'
      AND (TerminationDate IS NULL OR CAST(TerminationDate AS DATE) > '2026-05-01');

    IF @@ROWCOUNT < 1
        THROW 50003, 'Bohn: expected at least 1 old-rate May overlap row to close', 1;

    ------------------------------------------------------------------
    -- Bohn: ensure active new-rate row covers May (backdate 6/1 -> 5/1 when needed)
    ------------------------------------------------------------------
    UPDATE oe.Enrollments
    SET EffectiveDate = '2026-05-01',
        ModifiedDate = SYSUTCDATETIME()
    WHERE EnrollmentId = @BohnNewRow
      AND HouseholdId = @BohnHouseholdId
      AND ProductId = @GetWellProductId
      AND Status = N'Active'
      AND TerminationDate IS NULL
      AND CAST(EffectiveDate AS DATE) IN ('2026-05-01', '2026-06-01');

    IF @@ROWCOUNT <> 1
        THROW 50004, 'Bohn: expected exactly 1 active new-rate row to cover May from 5/1', 1;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];

    SELECT
        'Verify' AS [Check],
        m.HouseholdMemberID,
        CAST(e.EnrollmentId AS NVARCHAR(36)) AS EnrollmentId,
        e.Status,
        CONVERT(VARCHAR(10), e.EffectiveDate, 120) AS Eff,
        CONVERT(VARCHAR(10), e.TerminationDate, 120) AS Term,
        CAST(e.PremiumAmount AS DECIMAL(10, 2)) AS PremiumAmount,
        CAST(COALESCE(NULLIF(e.NetRate, 0), pp.NetRate) AS DECIMAL(10, 2)) AS NetRate
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = N'P'
    LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
    WHERE e.ProductId = @GetWellProductId
      AND m.HouseholdMemberID IN (N'MW15990622', N'MW15990733')
    ORDER BY m.HouseholdMemberID, e.EffectiveDate;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH;
