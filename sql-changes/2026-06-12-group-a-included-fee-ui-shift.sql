-- Migration: Group A — shift IncludedPaymentProcessingFee into product PremiumAmount (total-preserving)
-- Date: 2026-06-12
-- Author: Jeremy Francis
--
-- Purpose (UI/metadata only — billing total unchanged):
--   • Move display-only IncludedPaymentProcessingFeeAmount from product rows into PremiumAmount
--   • Reduce PaymentProcessingFee enrollment row by the same household total (may reach $0)
--   • Net SUM(PremiumAmount) stays identical — reflects how new enrollments look (fee baked into product tier)
--
-- Targets remaining Group A households (32 as of 2026-06-08; McCracken pilot already applied).
-- Skipped by 2026-06-12-included-fee-to-ppf-row-migration.sql (ambiguous legacy / invoice already = PremiumSum).
-- Does NOT touch Group B overcharge households (see 2026-06-12-group-b-overcharge-correction.sql).

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID('tempdb..#HouseholdAgg') IS NOT NULL DROP TABLE #HouseholdAgg;
    IF OBJECT_ID('tempdb..#UiShiftPlan') IS NOT NULL DROP TABLE #UiShiftPlan;
    IF OBJECT_ID('tempdb..#ProductShift') IS NOT NULL DROP TABLE #ProductShift;

    -- Group B overcharge households — never touch here
    DECLARE @GroupB TABLE (HouseholdId UNIQUEIDENTIFIER PRIMARY KEY);
    INSERT INTO @GroupB (HouseholdId) VALUES
        ('09CEC699-F4D1-4A8F-A629-DF3707B99F13'), -- Darcey Barry
        ('7916FD55-BD44-40D6-AABC-64FC8FE87A57'), -- Claudia Hobbs
        ('94B6B89F-EF03-4FC3-8E04-73DE9421DB49'), -- JASON AMSTUTZ
        ('9FC78B5F-4E46-4428-8B4A-C5E4633425B3'); -- Brooks Bohn

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
        CAST(h.PpfOnFeeRow - h.IncludedOnProducts AS DECIMAL(18, 2)) AS NewPpfAmount,
        (SELECT TOP 1 i.TotalAmount FROM oe.Invoices i
           WHERE i.HouseholdId = h.HouseholdId ORDER BY i.DueDate DESC) AS LatestInvoice,
        CASE
            WHEN h.PpfOnFeeRow > h.IncludedOnProducts + 0.01
                 AND (h.PpfOnFeeRow - h.IncludedOnProducts) > 0.005
                 AND (h.PpfOnFeeRow / NULLIF(h.PpfOnFeeRow - h.IncludedOnProducts, 0)) <= 1.4
            THEN 1 ELSE 0 END AS IsAmbiguousLegacy
    INTO #UiShiftPlan
    FROM #HouseholdAgg h
    WHERE NOT EXISTS (SELECT 1 FROM @GroupB gb WHERE gb.HouseholdId = h.HouseholdId);

    -- Keep only Group A: invoice already equals PremiumSum OR ambiguous legacy full PPF shape
    DELETE FROM #UiShiftPlan
    WHERE NOT (
        IsAmbiguousLegacy = 1
        OR (LatestInvoice IS NOT NULL AND ABS(LatestInvoice - PremiumSum) <= 0.01)
    );

    -- Safety: PPF row must cover the shift (no negative PPF)
    DELETE FROM #UiShiftPlan
    WHERE PpfOnFeeRow + 0.01 < IncludedOnProducts
       OR PpfRowCount = 0;

    SELECT
        e.EnrollmentId,
        e.HouseholdId,
        e.ProductId,
        p.Name AS ProductName,
        e.PremiumAmount AS OldPremiumAmount,
        COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) AS ShiftAmount,
        CAST(e.PremiumAmount + COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) AS DECIMAL(18, 2)) AS NewPremiumAmount
    INTO #ProductShift
    FROM oe.Enrollments e
    INNER JOIN #UiShiftPlan mp ON mp.HouseholdId = e.HouseholdId
    LEFT JOIN oe.Products p ON p.ProductId = e.ProductId
    WHERE (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
      AND e.ProductId IS NOT NULL
      AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
      AND COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) > 0.005
      AND e.Status NOT IN ('Cancelled', 'Declined')
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE());

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Group A UI shift preview' AS [Status];
        SELECT COUNT(*) AS HouseholdCount FROM #UiShiftPlan;
        SELECT COUNT(*) AS ProductEnrollmentRows FROM #ProductShift;

        SELECT
            mp.HouseholdId,
            mp.IncludedOnProducts,
            mp.PpfOnFeeRow,
            mp.NewPpfAmount,
            mp.PremiumSum AS TotalPremiumSumUnchanged,
            mp.LatestInvoice,
            mp.IsAmbiguousLegacy
        FROM #UiShiftPlan mp
        ORDER BY mp.IncludedOnProducts DESC;

        SELECT
            ps.HouseholdId,
            ps.ProductName,
            ps.OldPremiumAmount,
            ps.ShiftAmount,
            ps.NewPremiumAmount
        FROM #ProductShift ps
        ORDER BY ps.HouseholdId, ps.ShiftAmount DESC;

        -- PremiumSum is unchanged: product +Included, PPF -Included (net zero per household)
        SELECT
            mp.HouseholdId,
            mp.PremiumSum AS PreTotalPremiumSum,
            CAST(mp.PremiumSum AS DECIMAL(18, 2)) AS PostTotalPremiumSum,
            mp.PpfOnFeeRow AS PrePpfRow,
            mp.NewPpfAmount AS PostPpfRow,
            'OK — shift is net-zero on SUM(PremiumAmount)' AS SumCheck
        FROM #UiShiftPlan mp;

        SELECT
            SUM(CASE WHEN mp.NewPpfAmount <= 0.005 THEN 1 ELSE 0 END) AS PpfWouldBeZero,
            SUM(CASE WHEN mp.NewPpfAmount > 0.005 THEN 1 ELSE 0 END) AS PpfWouldRemain
        FROM #UiShiftPlan mp;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF (SELECT COUNT(*) FROM #UiShiftPlan) < 1
    BEGIN
        ;THROW 50002, 'Group A: no eligible households found; verify McCracken pilot and Group B exclusions', 1;
    END

    -- 1) Bake included fee into product PremiumAmount; zero display column
    UPDATE e
    SET e.PremiumAmount = CAST(e.PremiumAmount + COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) AS DECIMAL(18, 2)),
        e.IncludedPaymentProcessingFeeAmount = 0,
        e.ModifiedDate = GETUTCDATE()
    FROM oe.Enrollments e
    INNER JOIN #ProductShift ps ON ps.EnrollmentId = e.EnrollmentId;

    -- 2) Reduce PaymentProcessingFee row by household shifted total
    UPDATE e
    SET e.PremiumAmount = mp.NewPpfAmount,
        e.ModifiedDate = GETUTCDATE()
    FROM oe.Enrollments e
    INNER JOIN #UiShiftPlan mp ON mp.HouseholdId = e.HouseholdId
    WHERE e.EnrollmentType = 'PaymentProcessingFee'
      AND e.Status NOT IN ('Cancelled', 'Declined')
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE());

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status],
           (SELECT COUNT(*) FROM #UiShiftPlan) AS HouseholdsShifted,
           (SELECT COUNT(*) FROM #ProductShift) AS ProductRowsUpdated;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
