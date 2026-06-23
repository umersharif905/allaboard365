-- ============================================================================
-- Backfill Missing First-Month Invoices for Individual Enrollments
--
-- Finds individual (non-group) households that have active enrollments but
-- NO invoice at all in oe.Invoices, and creates an Unpaid invoice for their
-- first effective-date billing period.
--
-- This covers members who enrolled before the enrollment-completion flow
-- began generating first-month invoices automatically.
--
-- SAFETY:
--   - Wrapped in a transaction with TRY/CATCH; rolls back on any error.
--   - Only creates invoices where zero exist for that household.
--   - Idempotent: safe to run multiple times.
--   - If a matching payment already exists, it will be linked and the
--     invoice will be marked Paid or Partial accordingly.
-- ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
BEGIN TRANSACTION;

-- Step 1: Find individual households with active enrollments but NO invoices
CREATE TABLE #MissingInvoiceHouseholds (
    HouseholdId      UNIQUEIDENTIFIER NOT NULL,
    TenantId         UNIQUEIDENTIFIER NOT NULL,
    EffectiveDate    DATE             NOT NULL,
    ExpectedAmount   DECIMAL(18,6)    NOT NULL DEFAULT 0,
    ActualPaid       DECIMAL(18,6)    NOT NULL DEFAULT 0,
    PRIMARY KEY (HouseholdId)
);

INSERT INTO #MissingInvoiceHouseholds (HouseholdId, TenantId, EffectiveDate)
SELECT
    m.HouseholdId,
    m.TenantId,
    MIN(e.EffectiveDate) AS EffectiveDate
FROM oe.Members m
INNER JOIN oe.Enrollments e
    ON e.MemberId = m.MemberId
    AND e.Status NOT IN ('Cancelled', 'Declined')
    AND e.EnrollmentType IN ('Product', 'SystemFee', 'PaymentProcessingFee')
WHERE m.GroupId IS NULL
  AND m.HouseholdId IS NOT NULL
  AND m.RelationshipType = 'P'
  AND m.Status NOT IN ('Cancelled', 'Declined')
  -- No invoices exist at all for this household
  AND NOT EXISTS (
      SELECT 1
      FROM oe.Invoices inv
      WHERE inv.HouseholdId = m.HouseholdId
        AND inv.InvoiceType = 'Individual'
  )
GROUP BY m.HouseholdId, m.TenantId;

-- Compute expected monthly amount from enrollments for the effective-date period
UPDATE mih
SET mih.ExpectedAmount = COALESCE(sub.Total, 0)
FROM #MissingInvoiceHouseholds mih
CROSS APPLY (
    SELECT SUM(COALESCE(e.PremiumAmount, 0)) AS Total
    FROM oe.Enrollments e
    WHERE e.HouseholdId = mih.HouseholdId
      AND e.EffectiveDate <= EOMONTH(mih.EffectiveDate)
      AND (e.TerminationDate IS NULL OR e.TerminationDate > mih.EffectiveDate)
      AND e.Status NOT IN ('Cancelled', 'Declined')
) sub;

-- Compute actual paid amount for the same billing period (if any payments exist)
UPDATE mih
SET mih.ActualPaid = COALESCE(sub.Total, 0)
FROM #MissingInvoiceHouseholds mih
CROSS APPLY (
    SELECT SUM(p.Amount) AS Total
    FROM oe.Payments p
    WHERE p.HouseholdId = mih.HouseholdId
      AND p.GroupId IS NULL
      AND p.Status IN ('Completed', 'APPROVAL', 'succeeded', 'Paid', 'Success')
      AND p.Amount > 0
      AND p.PaymentDate >= mih.EffectiveDate
      AND p.PaymentDate <= EOMONTH(mih.EffectiveDate)
) sub;

DECLARE @rowsToProcess INT = (SELECT COUNT(*) FROM #MissingInvoiceHouseholds);
PRINT 'Households missing first-month invoice: ' + CAST(@rowsToProcess AS VARCHAR(20));

-- Step 2: Create invoices
DECLARE @cur_HouseholdId  UNIQUEIDENTIFIER;
DECLARE @cur_TenantId     UNIQUEIDENTIFIER;
DECLARE @cur_EffDate      DATE;
DECLARE @cur_Expected     DECIMAL(18,6);
DECLARE @cur_Paid         DECIMAL(18,6);
DECLARE @billingStart     DATE;
DECLARE @billingEnd       DATE;
DECLARE @newInvoiceId     UNIQUEIDENTIFIER;
DECLARE @newInvoiceNumber NVARCHAR(50);
DECLARE @invoiceStatus    NVARCHAR(20);
DECLARE @invoicesCreated  INT = 0;
DECLARE @paymentsLinked   INT = 0;

DECLARE backfill_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT HouseholdId, TenantId, EffectiveDate, ExpectedAmount, ActualPaid
    FROM #MissingInvoiceHouseholds
    ORDER BY TenantId, HouseholdId;

OPEN backfill_cursor;
FETCH NEXT FROM backfill_cursor INTO @cur_HouseholdId, @cur_TenantId, @cur_EffDate, @cur_Expected, @cur_Paid;

WHILE @@FETCH_STATUS = 0
BEGIN
    SET @billingStart = DATEFROMPARTS(YEAR(@cur_EffDate), MONTH(@cur_EffDate), 1);
    SET @billingEnd = EOMONTH(@cur_EffDate);

    -- Use enrollment-based amount; fall back to paid amount if enrollments are $0
    IF @cur_Expected = 0 AND @cur_Paid > 0
        SET @cur_Expected = @cur_Paid;

    SET @invoiceStatus = CASE
        WHEN @cur_Paid >= @cur_Expected AND @cur_Expected > 0 THEN 'Paid'
        WHEN @cur_Paid > 0 THEN 'Partial'
        ELSE 'Unpaid'
    END;

    SET @newInvoiceId = NEWID();
    EXEC oe.sp_GetNextInvoiceNumber @InvoiceNumber = @newInvoiceNumber OUTPUT;
    IF @newInvoiceNumber IS NULL
        SET @newInvoiceNumber = 'INV-BF-' + LEFT(REPLACE(CAST(@newInvoiceId AS NVARCHAR(36)), '-', ''), 12);

    INSERT INTO oe.Invoices (
        InvoiceId, InvoiceNumber, HouseholdId, GroupId,
        InvoiceType, TenantId, Status,
        InvoiceDate, DueDate, PaymentDueDate,
        BillingPeriodStart, BillingPeriodEnd,
        SubTotal, TaxAmount, TotalAmount, PaidAmount,
        CreatedDate, ModifiedDate
    ) VALUES (
        @newInvoiceId, @newInvoiceNumber, @cur_HouseholdId, NULL,
        'Individual', @cur_TenantId, @invoiceStatus,
        @billingStart, @billingStart, @billingStart,
        @billingStart, @billingEnd,
        @cur_Expected, 0, @cur_Expected, @cur_Paid,
        GETUTCDATE(), GETUTCDATE()
    );

    SET @invoicesCreated = @invoicesCreated + 1;

    -- Link any orphaned payments for this household/period to the new invoice
    UPDATE p
    SET p.InvoiceId = @newInvoiceId,
        p.ModifiedDate = GETUTCDATE()
    FROM oe.Payments p
    WHERE p.HouseholdId = @cur_HouseholdId
      AND p.GroupId IS NULL
      AND p.InvoiceId IS NULL
      AND p.Status IN ('Completed', 'APPROVAL', 'succeeded', 'Paid', 'Success')
      AND p.Amount > 0
      AND p.PaymentDate >= @cur_EffDate
      AND p.PaymentDate <= DATEADD(day, 1, @billingEnd);

    SET @paymentsLinked = @paymentsLinked + @@ROWCOUNT;

    IF @invoicesCreated % 100 = 0
        PRINT 'Progress: ' + CAST(@invoicesCreated AS VARCHAR(20)) + ' invoices created...';

    FETCH NEXT FROM backfill_cursor INTO @cur_HouseholdId, @cur_TenantId, @cur_EffDate, @cur_Expected, @cur_Paid;
END;

CLOSE backfill_cursor;
DEALLOCATE backfill_cursor;

DROP TABLE #MissingInvoiceHouseholds;

PRINT '';
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

    IF OBJECT_ID('tempdb..#MissingInvoiceHouseholds') IS NOT NULL
        DROP TABLE #MissingInvoiceHouseholds;

    THROW;
END CATCH;
