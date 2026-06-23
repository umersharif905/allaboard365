-- Migration: Rockne + Benjamin GetWell May enrollment Status -> Active
-- Date: 2026-06-10
--
-- Problem: May payables export drops these members because their only May-spanning
-- GetWell row is Inactive (migration artifact). Payables query requires Status = Active.
--
-- Fix: activate the new-rate May row for each member. PremiumAmount unchanged.
--
-- Rockne (MW15990631): 571C33BE  5/1-5/31 @ $35.72 EE
-- Benjamin (SW15990867): E122912E 5/1-5/31 @ $35.72 EE

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @GetWellProductId UNIQUEIDENTIFIER = '1D5DA922-31E6-401D-8346-D3340FDC4294';

DECLARE @RockneMayRow UNIQUEIDENTIFIER = '571C33BE-3307-4505-A234-EE04218FCAFE';
DECLARE @BenjaminMayRow UNIQUEIDENTIFIER = 'E122912E-7EA0-4E3B-A228-33734E01F987';

DECLARE @RockneHouseholdId UNIQUEIDENTIFIER = (
    SELECT TOP 1 m.HouseholdId
    FROM oe.Members m
    WHERE m.HouseholdMemberID = N'MW15990631' AND m.RelationshipType = N'P'
);
DECLARE @BenjaminHouseholdId UNIQUEIDENTIFIER = (
    SELECT TOP 1 m.HouseholdId
    FROM oe.Members m
    WHERE m.HouseholdMemberID = N'SW15990867' AND m.RelationshipType = N'P'
);

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Preview of changes:' AS [Status];

        SELECT
            m.HouseholdMemberID,
            CAST(e.EnrollmentId AS NVARCHAR(36)) AS EnrollmentId,
            e.Status AS Status_Before,
            N'Active' AS Status_After,
            CONVERT(VARCHAR(10), e.EffectiveDate, 120) AS Eff,
            CONVERT(VARCHAR(10), e.TerminationDate, 120) AS Term,
            CAST(COALESCE(NULLIF(e.NetRate, 0), pp.NetRate) AS DECIMAL(10, 2)) AS NetRate
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = N'P'
        LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
        WHERE e.EnrollmentId IN (@RockneMayRow, @BenjaminMayRow)
        ORDER BY m.HouseholdMemberID;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    UPDATE oe.Enrollments
    SET Status = N'Active',
        ModifiedDate = SYSUTCDATETIME()
    WHERE EnrollmentId = @RockneMayRow
      AND HouseholdId = @RockneHouseholdId
      AND ProductId = @GetWellProductId
      AND Status = N'Inactive'
      AND CAST(EffectiveDate AS DATE) = '2026-05-01'
      AND CAST(TerminationDate AS DATE) = '2026-05-31';

    IF @@ROWCOUNT <> 1
        THROW 50001, 'Rockne: expected exactly 1 May row to activate', 1;

    UPDATE oe.Enrollments
    SET Status = N'Active',
        ModifiedDate = SYSUTCDATETIME()
    WHERE EnrollmentId = @BenjaminMayRow
      AND HouseholdId = @BenjaminHouseholdId
      AND ProductId = @GetWellProductId
      AND Status = N'Inactive'
      AND CAST(EffectiveDate AS DATE) = '2026-05-01'
      AND CAST(TerminationDate AS DATE) = '2026-05-31';

    IF @@ROWCOUNT <> 1
        THROW 50002, 'Benjamin: expected exactly 1 May row to activate', 1;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH;
