-- Migration: Move IncludedPaymentProcessingFee into PaymentProcessingFee row (total-preserving)
-- Date: 2026-06-12
-- Author: Jeremy Francis
-- SAFE households only: excludes ambiguous legacy PPF shapes and invoice mismatches.
-- Run audit first: node ai_scripts/audit-included-fee-migration.cjs

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID('tempdb..#HouseholdAgg') IS NOT NULL DROP TABLE #HouseholdAgg;
    IF OBJECT_ID('tempdb..#MigrationPlan') IS NOT NULL DROP TABLE #MigrationPlan;

    SELECT
        e.HouseholdId,
        SUM(COALESCE(e.PremiumAmount, 0)) AS PremiumSum,
        SUM(CASE
            WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
              AND e.ProductId IS NOT NULL
              AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
            THEN COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) ELSE 0 END) AS IncludedOnProducts,
        SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee'
            THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS PpfOnFeeRow,
        SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN 1 ELSE 0 END) AS PpfRowCount
    INTO #HouseholdAgg
    FROM oe.Enrollments e
    WHERE e.Status NOT IN ('Cancelled', 'Declined')
      AND ISNULL(e.IsPendingMigration, 0) = 0
      AND e.EffectiveDate <= GETUTCDATE()
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    GROUP BY e.HouseholdId
    HAVING SUM(CASE
        WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
          AND e.ProductId IS NOT NULL
          AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
        THEN COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) ELSE 0 END) > 0.005;

    SELECT
        h.HouseholdId,
        h.PremiumSum,
        h.IncludedOnProducts,
        h.PpfOnFeeRow,
        h.PpfRowCount,
        CAST(CASE
            WHEN h.IncludedOnProducts <= 0.005 THEN h.PpfOnFeeRow
            WHEN h.IncludedOnProducts > h.PpfOnFeeRow + 0.01 THEN h.IncludedOnProducts + h.PpfOnFeeRow
            WHEN ABS(h.PpfOnFeeRow - h.IncludedOnProducts) <= 0.01 THEN h.PpfOnFeeRow
            WHEN h.PpfOnFeeRow > h.IncludedOnProducts + 0.01 THEN
                CASE WHEN (h.PpfOnFeeRow - h.IncludedOnProducts) > 0.005
                      AND (h.PpfOnFeeRow / NULLIF(h.PpfOnFeeRow - h.IncludedOnProducts, 0)) <= 1.4
                     THEN h.PpfOnFeeRow
                     ELSE h.IncludedOnProducts + h.PpfOnFeeRow END
            ELSE h.IncludedOnProducts + h.PpfOnFeeRow
        END AS DECIMAL(18,2)) AS NewPpfAmount,
        CAST(h.PremiumSum - h.PpfOnFeeRow + CASE
            WHEN h.IncludedOnProducts <= 0.005 THEN h.PpfOnFeeRow
            WHEN h.IncludedOnProducts > h.PpfOnFeeRow + 0.01 THEN h.IncludedOnProducts + h.PpfOnFeeRow
            WHEN ABS(h.PpfOnFeeRow - h.IncludedOnProducts) <= 0.01 THEN h.PpfOnFeeRow
            WHEN h.PpfOnFeeRow > h.IncludedOnProducts + 0.01 THEN
                CASE WHEN (h.PpfOnFeeRow - h.IncludedOnProducts) > 0.005
                      AND (h.PpfOnFeeRow / NULLIF(h.PpfOnFeeRow - h.IncludedOnProducts, 0)) <= 1.4
                     THEN h.PpfOnFeeRow
                     ELSE h.IncludedOnProducts + h.PpfOnFeeRow END
            ELSE h.IncludedOnProducts + h.PpfOnFeeRow
        END AS DECIMAL(18,2)) AS CurrentDue,
        CAST(h.PremiumSum - h.PpfOnFeeRow + CASE
            WHEN h.IncludedOnProducts <= 0.005 THEN h.PpfOnFeeRow
            WHEN h.IncludedOnProducts > h.PpfOnFeeRow + 0.01 THEN h.IncludedOnProducts + h.PpfOnFeeRow
            WHEN ABS(h.PpfOnFeeRow - h.IncludedOnProducts) <= 0.01 THEN h.PpfOnFeeRow
            WHEN h.PpfOnFeeRow > h.IncludedOnProducts + 0.01 THEN
                CASE WHEN (h.PpfOnFeeRow - h.IncludedOnProducts) > 0.005
                      AND (h.PpfOnFeeRow / NULLIF(h.PpfOnFeeRow - h.IncludedOnProducts, 0)) <= 1.4
                     THEN h.PpfOnFeeRow
                     ELSE h.IncludedOnProducts + h.PpfOnFeeRow END
            ELSE h.IncludedOnProducts + h.PpfOnFeeRow
        END AS DECIMAL(18,2)) AS PostMigrationDue,
        (SELECT TOP 1 i.TotalAmount FROM oe.Invoices i
           WHERE i.HouseholdId = h.HouseholdId ORDER BY i.DueDate DESC) AS LatestInvoice,
        CASE
            WHEN h.PpfOnFeeRow > h.IncludedOnProducts + 0.01
                 AND (h.PpfOnFeeRow - h.IncludedOnProducts) > 0.005
                 AND (h.PpfOnFeeRow / NULLIF(h.PpfOnFeeRow - h.IncludedOnProducts, 0)) <= 1.4
            THEN 1 ELSE 0 END AS IsAmbiguousLegacy,
        (SELECT TOP 1 pm.MemberId FROM oe.Members pm
           WHERE pm.HouseholdId = h.HouseholdId AND pm.RelationshipType = 'P') AS PrimaryMemberId,
        (SELECT TOP 1 pm.AgentId FROM oe.Members pm
           WHERE pm.HouseholdId = h.HouseholdId AND pm.RelationshipType = 'P') AS AgentId
    INTO #MigrationPlan
    FROM #HouseholdAgg h;

    -- SAFE = not ambiguous legacy AND invoice matches current due (or no invoice)
    DELETE FROM #MigrationPlan
    WHERE IsAmbiguousLegacy = 1
       OR (LatestInvoice IS NOT NULL
           AND ABS(LatestInvoice - CurrentDue) > 0.01);

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - migration preview' AS [Status];
        SELECT COUNT(*) AS SafeHouseholdCount FROM #MigrationPlan;
        SELECT TOP 25
            mp.HouseholdId,
            mp.IncludedOnProducts,
            mp.PpfOnFeeRow,
            mp.NewPpfAmount,
            mp.CurrentDue,
            mp.PostMigrationDue,
            mp.LatestInvoice,
            mp.PpfRowCount
        FROM #MigrationPlan mp
        ORDER BY mp.IncludedOnProducts DESC;

        SELECT 'Would zero IncludedPaymentProcessingFee on product enrollments' AS Action,
               COUNT(*) AS ProductEnrollmentRows
        FROM oe.Enrollments e
        INNER JOIN #MigrationPlan mp ON mp.HouseholdId = e.HouseholdId
        WHERE (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
          AND e.ProductId IS NOT NULL
          AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
          AND COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) > 0;

        SELECT 'Would UPDATE existing PPF rows' AS Action, COUNT(*) AS Cnt
        FROM #MigrationPlan mp
        WHERE mp.PpfRowCount > 0;

        SELECT 'Would INSERT new PPF rows' AS Action, COUNT(*) AS Cnt
        FROM #MigrationPlan mp
        WHERE mp.PpfRowCount = 0;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    -- 1) Update existing PaymentProcessingFee rows
    UPDATE e
    SET e.PremiumAmount = mp.NewPpfAmount,
        e.ModifiedDate = GETUTCDATE()
    FROM oe.Enrollments e
    INNER JOIN #MigrationPlan mp ON mp.HouseholdId = e.HouseholdId
    WHERE e.EnrollmentType = 'PaymentProcessingFee'
      AND e.Status NOT IN ('Cancelled', 'Declined')
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE());

    -- 2) Insert PaymentProcessingFee row where missing
    INSERT INTO oe.Enrollments (
        EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
        PremiumAmount, PaymentFrequency, CreatedDate, ModifiedDate, HouseholdId,
        EnrollmentType, IncludedPaymentProcessingFeeAmount, IncludedSystemFeeAmount, IsPendingMigration
    )
    SELECT
        NEWID(),
        mp.PrimaryMemberId,
        '00000000-0000-0000-0000-000000000000',
        mp.AgentId,
        'Active',
        CAST(GETUTCDATE() AS DATE),
        mp.NewPpfAmount,
        'Monthly',
        GETUTCDATE(),
        GETUTCDATE(),
        mp.HouseholdId,
        'PaymentProcessingFee',
        0,
        0,
        0
    FROM #MigrationPlan mp
    WHERE mp.PpfRowCount = 0
      AND mp.PrimaryMemberId IS NOT NULL
      AND mp.NewPpfAmount > 0;

    -- 3) Zero display-only included fee on product rows
    UPDATE e
    SET e.IncludedPaymentProcessingFeeAmount = 0,
        e.ModifiedDate = GETUTCDATE()
    FROM oe.Enrollments e
    INNER JOIN #MigrationPlan mp ON mp.HouseholdId = e.HouseholdId
    WHERE (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
      AND e.ProductId IS NOT NULL
      AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
      AND COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) > 0;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status], (SELECT COUNT(*) FROM #MigrationPlan) AS HouseholdsMigrated;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
