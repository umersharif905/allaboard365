-- Backfill oe.Payments.SystemFees + oe.Payments.ProcessingFeeAmount from fee enrollment rows.
-- Scope: payment rows that look "missing" fee buckets (NULLs or both 0).
-- Fee source of truth:
--   - Household context: oe.Enrollments where HouseholdId matches and as-of date is end of next month after PaymentDate.
--   - Group context: oe.Enrollments joined to oe.Members by GroupId using invoice billing period (if present), else payment month.
--
-- Usage:
--   1) Run as-is (DryRun=1) to preview row counts/samples.
--   2) Set @DryRun = 0 and run again to apply.

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1; -- set to 0 to apply

IF OBJECT_ID('tempdb..#FeeBackfill') IS NOT NULL
    DROP TABLE #FeeBackfill;

;WITH PaymentCandidates AS (
    SELECT
        p.PaymentId,
        p.TenantId,
        p.GroupId,
        p.HouseholdId,
        p.EnrollmentId,
        p.InvoiceId,
        p.Amount,
        p.SystemFees AS CurrentSystemFees,
        p.ProcessingFeeAmount AS CurrentProcessingFeeAmount,
        p.PaymentDate,
        p.CreatedDate,
        p.ModifiedDate,
        p.TransactionType,
        p.Processor,
        i.BillingPeriodStart,
        i.BillingPeriodEnd,
        -- Household as-of date: end of month after payment month (same as householdAsOfDate).
        EOMONTH(DATEADD(MONTH, 1, COALESCE(p.PaymentDate, p.CreatedDate, SYSUTCDATETIME()))) AS HouseholdAsOfDate,
        -- Group fallback period when no invoice period exists.
        DATEFROMPARTS(
            YEAR(COALESCE(p.PaymentDate, p.CreatedDate, SYSUTCDATETIME())),
            MONTH(COALESCE(p.PaymentDate, p.CreatedDate, SYSUTCDATETIME())),
            1
        ) AS GroupPeriodStartFallback,
        EOMONTH(COALESCE(p.PaymentDate, p.CreatedDate, SYSUTCDATETIME())) AS GroupPeriodEndFallback
    FROM oe.Payments p
    LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE
        (p.TransactionType IS NULL OR p.TransactionType = N'Payment')
        AND (
            p.SystemFees IS NULL
            OR p.ProcessingFeeAmount IS NULL
            OR (ISNULL(p.SystemFees, 0) = 0 AND ISNULL(p.ProcessingFeeAmount, 0) = 0)
        )
),
Calculated AS (
    SELECT
        c.PaymentId,
        c.TenantId,
        c.GroupId,
        c.HouseholdId,
        c.EnrollmentId,
        c.InvoiceId,
        c.Amount,
        c.TransactionType,
        c.Processor,
        c.PaymentDate,
        c.CreatedDate,
        c.ModifiedDate,
        c.CurrentSystemFees,
        c.CurrentProcessingFeeAmount,
        -- Choose context matching payment audit / write logic:
        -- 1) Invoice-linked group rows use group period
        -- 2) Household rows (common individual/complete-enrollment) use household as-of
        -- 3) Group rows without invoice use group month fallback
        CAST(
            CASE
                WHEN c.GroupId IS NOT NULL AND c.InvoiceId IS NOT NULL THEN ISNULL(gf.SystemFees, 0)
                WHEN c.HouseholdId IS NOT NULL THEN ISNULL(hf.SystemFees, 0)
                WHEN c.GroupId IS NOT NULL THEN ISNULL(gf.SystemFees, 0)
                ELSE 0
            END
        AS DECIMAL(10, 2)) AS CalculatedSystemFees,
        CAST(
            CASE
                WHEN c.GroupId IS NOT NULL AND c.InvoiceId IS NOT NULL THEN ISNULL(gf.ProcessingFeeAmount, 0)
                WHEN c.HouseholdId IS NOT NULL THEN ISNULL(hf.ProcessingFeeAmount, 0)
                WHEN c.GroupId IS NOT NULL THEN ISNULL(gf.ProcessingFeeAmount, 0)
                ELSE 0
            END
        AS DECIMAL(10, 2)) AS CalculatedProcessingFeeAmount,
        CASE
            WHEN c.GroupId IS NOT NULL AND c.InvoiceId IS NOT NULL THEN N'group_invoice_period'
            WHEN c.HouseholdId IS NOT NULL THEN N'household_asof_next_month_end'
            WHEN c.GroupId IS NOT NULL THEN N'group_payment_month'
            ELSE N'no_context'
        END AS BackfillContext
    FROM PaymentCandidates c
    OUTER APPLY (
        SELECT
            SUM(CASE WHEN e.EnrollmentType = N'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS SystemFees,
            SUM(CASE WHEN e.EnrollmentType = N'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS ProcessingFeeAmount
        FROM oe.Enrollments e
        WHERE e.HouseholdId = c.HouseholdId
          AND e.EffectiveDate <= c.HouseholdAsOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > c.HouseholdAsOfDate)
          AND e.EnrollmentType IN (N'SystemFee', N'PaymentProcessingFee')
    ) hf
    OUTER APPLY (
        SELECT
            SUM(CASE WHEN e.EnrollmentType = N'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS SystemFees,
            SUM(CASE WHEN e.EnrollmentType = N'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS ProcessingFeeAmount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = c.GroupId
          AND CAST(e.EffectiveDate AS DATE) <= COALESCE(c.BillingPeriodEnd, c.GroupPeriodEndFallback)
          AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(c.BillingPeriodStart, c.GroupPeriodStartFallback))
          AND e.EnrollmentType IN (N'SystemFee', N'PaymentProcessingFee')
    ) gf
)
SELECT
    z.PaymentId,
    z.TenantId,
    z.GroupId,
    z.HouseholdId,
    z.EnrollmentId,
    z.InvoiceId,
    z.Amount,
    z.TransactionType,
    z.Processor,
    z.PaymentDate,
    z.CreatedDate,
    z.ModifiedDate,
    z.CurrentSystemFees,
    z.CurrentProcessingFeeAmount,
    z.CalculatedSystemFees,
    z.CalculatedProcessingFeeAmount,
    z.BackfillContext
INTO #FeeBackfill
FROM Calculated z
WHERE
    ISNULL(z.CurrentSystemFees, 0) <> ISNULL(z.CalculatedSystemFees, 0)
    OR ISNULL(z.CurrentProcessingFeeAmount, 0) <> ISNULL(z.CalculatedProcessingFeeAmount, 0);

SELECT
    COUNT(*) AS RowsToUpdate,
    SUM(CASE WHEN BackfillContext = N'household_asof_next_month_end' THEN 1 ELSE 0 END) AS HouseholdRows,
    SUM(CASE WHEN BackfillContext = N'group_invoice_period' THEN 1 ELSE 0 END) AS GroupInvoiceRows,
    SUM(CASE WHEN BackfillContext = N'group_payment_month' THEN 1 ELSE 0 END) AS GroupMonthRows
FROM #FeeBackfill;

SELECT TOP (200)
    PaymentId,
    Amount,
    BackfillContext,
    CurrentSystemFees,
    CalculatedSystemFees,
    CurrentProcessingFeeAmount,
    CalculatedProcessingFeeAmount,
    PaymentDate,
    ModifiedDate
FROM #FeeBackfill
ORDER BY ModifiedDate DESC;

IF @DryRun = 1
BEGIN
    PRINT N'DRY RUN ONLY. Set @DryRun = 0 to apply updates.';
    RETURN;
END;

BEGIN TRANSACTION;

UPDATE p
SET
    p.SystemFees = b.CalculatedSystemFees,
    p.ProcessingFeeAmount = b.CalculatedProcessingFeeAmount,
    p.ModifiedDate = GETUTCDATE()
FROM oe.Payments p
INNER JOIN #FeeBackfill b ON b.PaymentId = p.PaymentId;

SELECT @@ROWCOUNT AS RowsUpdated;

COMMIT TRANSACTION;

PRINT N'Backfill applied: oe.Payments.SystemFees and oe.Payments.ProcessingFeeAmount.';
