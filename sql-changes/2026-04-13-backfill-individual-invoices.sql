-- ============================================================================
-- Backfill Individual Invoices
-- Generates one invoice per month per household for all historical individual
-- payments (GroupId IS NULL, HouseholdId IS NOT NULL), then links each
-- payment to the corresponding invoice and marks invoices fulfilled.
--
-- PREREQUISITES:
--   1. Run 2026-04-13-invoices-individual-support.sql first (schema migration).
--   2. oe.sp_GetNextInvoiceNumber must exist and return sequential numbers.
--
-- SAFETY:
--   - Wrapped in a transaction with TRY/CATCH; rolls back on any error.
--   - Only creates invoices where none exist for that household+period.
--   - Only links payments that have InvoiceId IS NULL.
--   - Idempotent: safe to run multiple times.
--
-- RUNTIME NOTE:
--   This may take several minutes on large databases. Run during off-peak.
-- ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
BEGIN TRANSACTION;

-- -------------------------------------------------------------------
-- Step 1: Identify distinct household-month combinations from payments
--         that do not already have an individual invoice.
-- -------------------------------------------------------------------

-- Temp table to hold household-month combinations needing invoices
CREATE TABLE #HouseholdMonths (
    HouseholdId    UNIQUEIDENTIFIER NOT NULL,
    TenantId       UNIQUEIDENTIFIER NOT NULL,
    BillingYear    INT              NOT NULL,
    BillingMonth   INT              NOT NULL,
    TotalPaid      DECIMAL(18,6)    NOT NULL,
    PaymentCount   INT              NOT NULL,
    MinPaymentDate DATETIME         NOT NULL,
    PRIMARY KEY (HouseholdId, BillingYear, BillingMonth)
);

-- For individual payments, the billing period is determined by the
-- enrollment's EffectiveDate month. If EffectiveDate is not available
-- on the enrollment, we fall back to using the PaymentDate month.
-- Most individual payments cover the month of their PaymentDate,
-- but some payments taken before EffectiveDate cover a future month.
-- We use the enrollment's EffectiveDate to determine the earliest
-- possible billing period, then group payments to months accordingly.

INSERT INTO #HouseholdMonths (HouseholdId, TenantId, BillingYear, BillingMonth, TotalPaid, PaymentCount, MinPaymentDate)
SELECT
    p.HouseholdId,
    p.TenantId,
    -- Determine billing month: use the enrollment effective date if available and payment
    -- was before effective date (pre-pay scenario), otherwise use payment date month
    CASE
        WHEN e.EffectiveDate IS NOT NULL AND p.PaymentDate < e.EffectiveDate
            THEN YEAR(e.EffectiveDate)
        ELSE YEAR(p.PaymentDate)
    END AS BillingYear,
    CASE
        WHEN e.EffectiveDate IS NOT NULL AND p.PaymentDate < e.EffectiveDate
            THEN MONTH(e.EffectiveDate)
        ELSE MONTH(p.PaymentDate)
    END AS BillingMonth,
    SUM(p.Amount) AS TotalPaid,
    COUNT(*) AS PaymentCount,
    MIN(p.PaymentDate) AS MinPaymentDate
FROM oe.Payments p
LEFT JOIN oe.Enrollments e ON e.EnrollmentId = p.EnrollmentId
WHERE p.HouseholdId IS NOT NULL
  AND p.GroupId IS NULL
  AND p.InvoiceId IS NULL
  AND p.Status IN ('Completed', 'APPROVAL', 'succeeded', 'Paid')
  AND p.Amount > 0
GROUP BY
    p.HouseholdId,
    p.TenantId,
    CASE
        WHEN e.EffectiveDate IS NOT NULL AND p.PaymentDate < e.EffectiveDate
            THEN YEAR(e.EffectiveDate)
        ELSE YEAR(p.PaymentDate)
    END,
    CASE
        WHEN e.EffectiveDate IS NOT NULL AND p.PaymentDate < e.EffectiveDate
            THEN MONTH(e.EffectiveDate)
        ELSE MONTH(p.PaymentDate)
    END;

-- Filter out household-months that already have an individual invoice
DELETE hm
FROM #HouseholdMonths hm
WHERE EXISTS (
    SELECT 1
    FROM oe.Invoices inv
    WHERE inv.HouseholdId = hm.HouseholdId
      AND inv.InvoiceType = 'Individual'
      AND YEAR(inv.BillingPeriodStart) = hm.BillingYear
      AND MONTH(inv.BillingPeriodStart) = hm.BillingMonth
);

DECLARE @rowsToProcess INT = (SELECT COUNT(*) FROM #HouseholdMonths);
PRINT 'Household-month combinations to backfill: ' + CAST(@rowsToProcess AS VARCHAR(20));

-- -------------------------------------------------------------------
-- Step 2: Create invoices for each household-month
-- -------------------------------------------------------------------

-- We compute TotalAmount from the enrollment pricing at time of billing
-- period. If no enrollment data is available, we use the actual payment
-- total as the invoice amount (best-effort).

DECLARE @cur_HouseholdId UNIQUEIDENTIFIER;
DECLARE @cur_TenantId UNIQUEIDENTIFIER;
DECLARE @cur_Year INT;
DECLARE @cur_Month INT;
DECLARE @cur_TotalPaid DECIMAL(18,6);
DECLARE @cur_MinPaymentDate DATETIME;
DECLARE @billingStart DATETIME;
DECLARE @billingEnd DATETIME;
DECLARE @expectedAmount DECIMAL(18,6);
DECLARE @newInvoiceId UNIQUEIDENTIFIER;
DECLARE @newInvoiceNumber NVARCHAR(50);
DECLARE @invoicesCreated INT = 0;
DECLARE @paymentsLinked INT = 0;

DECLARE backfill_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT HouseholdId, TenantId, BillingYear, BillingMonth, TotalPaid, MinPaymentDate
    FROM #HouseholdMonths
    ORDER BY TenantId, HouseholdId, BillingYear, BillingMonth;

OPEN backfill_cursor;
FETCH NEXT FROM backfill_cursor INTO @cur_HouseholdId, @cur_TenantId, @cur_Year, @cur_Month, @cur_TotalPaid, @cur_MinPaymentDate;

WHILE @@FETCH_STATUS = 0
BEGIN
    SET @billingStart = DATEFROMPARTS(@cur_Year, @cur_Month, 1);
    SET @billingEnd = EOMONTH(@billingStart);

    -- Compute expected amount from enrollments active during this period
    SELECT @expectedAmount = COALESCE(SUM(COALESCE(e.PremiumAmount, 0)), 0)
    FROM oe.Enrollments e
    WHERE e.HouseholdId = @cur_HouseholdId
      AND e.EffectiveDate <= @billingEnd
      AND (e.TerminationDate IS NULL OR e.TerminationDate > @billingStart)
      AND e.Status NOT IN ('Cancelled', 'Declined');

    -- If no enrollment-based amount found, fall back to actual paid amount
    IF @expectedAmount = 0 OR @expectedAmount IS NULL
        SET @expectedAmount = @cur_TotalPaid;

    -- Generate invoice number
    SET @newInvoiceId = NEWID();
    EXEC oe.sp_GetNextInvoiceNumber @InvoiceNumber = @newInvoiceNumber OUTPUT;
    IF @newInvoiceNumber IS NULL
        SET @newInvoiceNumber = 'INV-BF-' + REPLACE(CAST(@newInvoiceId AS NVARCHAR(36)), '-', '');

    -- Create the invoice
    INSERT INTO oe.Invoices (
        InvoiceId, InvoiceNumber, HouseholdId, GroupId,
        InvoiceType, TenantId, Status,
        InvoiceDate, DueDate, PaymentDueDate,
        BillingPeriodStart, BillingPeriodEnd,
        SubTotal, TaxAmount, TotalAmount, PaidAmount,
        CreatedDate, ModifiedDate
    ) VALUES (
        @newInvoiceId, @newInvoiceNumber, @cur_HouseholdId, NULL,
        'Individual', @cur_TenantId,
        CASE
            WHEN @cur_TotalPaid >= @expectedAmount THEN 'Paid'
            WHEN @cur_TotalPaid > 0 THEN 'Partial'
            ELSE 'Unpaid'
        END,
        @billingStart,   -- InvoiceDate
        @billingStart,   -- DueDate
        @billingStart,   -- PaymentDueDate
        @billingStart, @billingEnd,
        @expectedAmount, -- SubTotal
        0,               -- TaxAmount
        @expectedAmount, -- TotalAmount
        @cur_TotalPaid,  -- PaidAmount
        GETUTCDATE(), GETUTCDATE()
    );

    SET @invoicesCreated = @invoicesCreated + 1;

    -- -------------------------------------------------------------------
    -- Step 3: Link payments to the newly created invoice
    -- -------------------------------------------------------------------

    UPDATE p
    SET p.InvoiceId = @newInvoiceId,
        p.ModifiedDate = GETUTCDATE()
    FROM oe.Payments p
    LEFT JOIN oe.Enrollments e ON e.EnrollmentId = p.EnrollmentId
    WHERE p.HouseholdId = @cur_HouseholdId
      AND p.GroupId IS NULL
      AND p.InvoiceId IS NULL
      AND p.Status IN ('Completed', 'APPROVAL', 'succeeded', 'Paid')
      AND p.Amount > 0
      AND (
          -- Match by billing month using same logic as Step 1
          (e.EffectiveDate IS NOT NULL AND p.PaymentDate < e.EffectiveDate
              AND YEAR(e.EffectiveDate) = @cur_Year AND MONTH(e.EffectiveDate) = @cur_Month)
          OR
          (e.EffectiveDate IS NULL OR p.PaymentDate >= e.EffectiveDate)
              AND YEAR(p.PaymentDate) = @cur_Year AND MONTH(p.PaymentDate) = @cur_Month
      );

    SET @paymentsLinked = @paymentsLinked + @@ROWCOUNT;

    -- Progress logging every 500 invoices
    IF @invoicesCreated % 500 = 0
        PRINT 'Progress: ' + CAST(@invoicesCreated AS VARCHAR(20)) + ' invoices created, ' + CAST(@paymentsLinked AS VARCHAR(20)) + ' payments linked...';

    FETCH NEXT FROM backfill_cursor INTO @cur_HouseholdId, @cur_TenantId, @cur_Year, @cur_Month, @cur_TotalPaid, @cur_MinPaymentDate;
END;

CLOSE backfill_cursor;
DEALLOCATE backfill_cursor;

DROP TABLE #HouseholdMonths;

PRINT '=== BACKFILL COMPLETE ===';
PRINT 'Invoices created: ' + CAST(@invoicesCreated AS VARCHAR(20));
PRINT 'Payments linked:  ' + CAST(@paymentsLinked AS VARCHAR(20));

COMMIT TRANSACTION;

END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;

    PRINT 'ERROR during backfill:';
    PRINT ERROR_MESSAGE();
    PRINT 'Error at line: ' + CAST(ERROR_LINE() AS VARCHAR(20));

    -- Clean up temp table if it exists
    IF OBJECT_ID('tempdb..#HouseholdMonths') IS NOT NULL
        DROP TABLE #HouseholdMonths;

    THROW;
END CATCH;
