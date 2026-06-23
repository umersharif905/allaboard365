-- Migration: Group B — correct 4 households billed PremiumSum + Included (double-add overcharge)
-- Date: 2026-06-12
-- Author: Jeremy Francis
--
-- Root cause: legacy billing added IncludedPaymentProcessingFeeAmount on top of enrollment PremiumAmount
-- when invoice already reflected the full premium stack. These 4 households were overcharged monthly.
--
-- Fix (going forward):
--   • Zero IncludedPaymentProcessingFeeAmount on product rows (display metadata only)
--   • Set IndividualRecurringSchedules.MonthlyAmount = SUM(PremiumAmount)
--   • Billing total becomes PremiumSum (matches deployed invoiceService logic)
--
-- Historical June invoices already Paid at inflated amounts — dry-run shows overcharge audit.
-- Refunds/credits for past months are out of scope here; handle separately if needed.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID('tempdb..#GroupB') IS NOT NULL DROP TABLE #GroupB;
    IF OBJECT_ID('tempdb..#GroupBPlan') IS NOT NULL DROP TABLE #GroupBPlan;

    CREATE TABLE #GroupB (
        HouseholdId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        MemberLabel NVARCHAR(100) NOT NULL
    );
    INSERT INTO #GroupB (HouseholdId, MemberLabel) VALUES
        ('09CEC699-F4D1-4A8F-A629-DF3707B99F13', N'Darcey Barry'),
        ('7916FD55-BD44-40D6-AABC-64FC8FE87A57', N'Claudia Hobbs'),
        ('94B6B89F-EF03-4FC3-8E04-73DE9421DB49', N'JASON AMSTUTZ'),
        ('9FC78B5F-4E46-4428-8B4A-C5E4633425B3', N'Brooks Bohn');

    SELECT
        gb.HouseholdId,
        gb.MemberLabel,
        SUM(COALESCE(e.PremiumAmount, 0)) AS PremiumSum,
        SUM(CASE
            WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
              AND e.ProductId IS NOT NULL
              AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
            THEN COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) ELSE 0 END) AS IncludedOnProducts,
        (SELECT TOP 1 i.InvoiceNumber FROM oe.Invoices i
           WHERE i.HouseholdId = gb.HouseholdId ORDER BY i.DueDate DESC) AS LatestInvoiceNumber,
        (SELECT TOP 1 i.TotalAmount FROM oe.Invoices i
           WHERE i.HouseholdId = gb.HouseholdId ORDER BY i.DueDate DESC) AS LatestInvoiceTotal,
        (SELECT TOP 1 irs.ScheduleId FROM oe.IndividualRecurringSchedules irs
           WHERE irs.HouseholdId = gb.HouseholdId AND irs.IsActive = 1
           ORDER BY irs.ModifiedDate DESC) AS ActiveScheduleId,
        (SELECT TOP 1 irs.MonthlyAmount FROM oe.IndividualRecurringSchedules irs
           WHERE irs.HouseholdId = gb.HouseholdId AND irs.IsActive = 1
           ORDER BY irs.ModifiedDate DESC) AS CurrentRecurringAmount
    INTO #GroupBPlan
    FROM #GroupB gb
    INNER JOIN oe.Enrollments e ON e.HouseholdId = gb.HouseholdId
    WHERE e.Status NOT IN ('Cancelled', 'Declined')
      AND ISNULL(e.IsPendingMigration, 0) = 0
      AND e.EffectiveDate <= GETUTCDATE()
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    GROUP BY gb.HouseholdId, gb.MemberLabel;

    -- Verify all 4 still match overcharge signature before applying
    DELETE FROM #GroupBPlan
    WHERE ABS(LatestInvoiceTotal - (PremiumSum + IncludedOnProducts)) > 0.02
       OR IncludedOnProducts <= 0.005;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Group B overcharge correction preview' AS [Status];
        SELECT COUNT(*) AS EligibleHouseholdCount FROM #GroupBPlan;

        SELECT
            p.MemberLabel,
            p.HouseholdId,
            p.PremiumSum AS CorrectMonthlyTotal,
            p.IncludedOnProducts AS IncludedToZero,
            p.LatestInvoiceNumber,
            p.LatestInvoiceTotal AS LastInvoiceOvercharged,
            CAST(p.LatestInvoiceTotal - p.PremiumSum AS DECIMAL(18, 2)) AS MonthlyOvercharge,
            p.CurrentRecurringAmount,
            p.PremiumSum AS NewRecurringAmount,
            CASE
                WHEN p.CurrentRecurringAmount IS NULL THEN 'NO_ACTIVE_SCHEDULE'
                WHEN ABS(p.CurrentRecurringAmount - p.PremiumSum) <= 0.01 THEN 'RECURRING_ALREADY_OK'
                ELSE 'RECURRING_WILL_UPDATE'
            END AS RecurringAction
        FROM #GroupBPlan p
        ORDER BY p.MemberLabel;

        SELECT
            p.MemberLabel,
            e.EnrollmentId,
            pr.Name AS ProductName,
            e.PremiumAmount,
            e.IncludedPaymentProcessingFeeAmount AS IncludedToZero
        FROM #GroupBPlan p
        INNER JOIN oe.Enrollments e ON e.HouseholdId = p.HouseholdId
        LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
        WHERE (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
          AND e.ProductId IS NOT NULL
          AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
          AND COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) > 0.005
          AND e.Status NOT IN ('Cancelled', 'Declined')
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        ORDER BY p.MemberLabel, pr.Name;

        SELECT
            p.MemberLabel,
            i.InvoiceNumber,
            i.DueDate,
            i.TotalAmount,
            p.PremiumSum AS CorrectTotal,
            CAST(i.TotalAmount - p.PremiumSum AS DECIMAL(18, 2)) AS HistoricalOvercharge,
            i.Status
        FROM #GroupBPlan p
        INNER JOIN oe.Invoices i ON i.HouseholdId = p.HouseholdId
        WHERE ABS(i.TotalAmount - (p.PremiumSum + p.IncludedOnProducts)) <= 0.02
        ORDER BY p.MemberLabel, i.DueDate DESC;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF (SELECT COUNT(*) FROM #GroupBPlan) <> 4
    BEGIN
        ;THROW 50001, 'Group B: expected exactly 4 eligible households; re-run dry-run and verify signatures', 1;
    END

    -- 1) Zero display-only included fee on product rows (PremiumAmount unchanged)
    UPDATE e
    SET e.IncludedPaymentProcessingFeeAmount = 0,
        e.ModifiedDate = GETUTCDATE()
    FROM oe.Enrollments e
    INNER JOIN #GroupBPlan p ON p.HouseholdId = e.HouseholdId
    WHERE (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
      AND e.ProductId IS NOT NULL
      AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
      AND COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) > 0.005
      AND e.Status NOT IN ('Cancelled', 'Declined')
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE());

    -- 2) Align active recurring schedule to PremiumSum (DIME resync handled by backend on next heal)
    UPDATE irs
    SET irs.MonthlyAmount = p.PremiumSum,
        irs.ModifiedDate = GETUTCDATE()
    FROM oe.IndividualRecurringSchedules irs
    INNER JOIN #GroupBPlan p ON p.HouseholdId = irs.HouseholdId
    WHERE irs.IsActive = 1
      AND ABS(COALESCE(irs.MonthlyAmount, 0) - p.PremiumSum) > 0.01;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status],
           (SELECT COUNT(*) FROM #GroupBPlan) AS HouseholdsCorrected;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
