-- =====================================================================================
-- 2026-04-27-create-missing-monthly-invoices.sql
-- One-off fallback to create the 4 missing monthly invoices currently flagged
-- in the System Audit > Billing Integrity > "Missing monthly invoices" panel,
-- since the UI button has been failing for these specific rows.
--
-- Households + missing month (from screenshot 2026-04-27):
--   E6343574-CAA7-4FAA-AFA1-141C113BF23C  Mark Whitesides    Mar 2026
--   04F4C52C-D3ED-4B22-8DD8-1CFAD94D37FF  Paul Yurt          Mar 2026
--   594729B7-ABDF-4457-AC8A-81493AC41293  Michael McCracken  Mar 2026
--   8BFCAB63-D286-4859-B0A8-BED3AE36E3AD  Brian Schoening    Apr 2026
--
-- Each invoice's TotalAmount is derived from oe.Enrollments using the SAME query
-- as invoiceService.computeTotalFromEnrollments. Breakdown columns are left
-- NULL — the standard nightly invoice/audit pipeline will populate them, OR
-- the user can run the existing "Recompute fees" auto-fixer afterward.
--
-- Status defaults to N'Unpaid'. PaidAmount=0. No payment linkage attempted by
-- this script; the next pass of selfHealInvoice / linkOrphanPayments will pick
-- up any matching prepay payments.
--
-- USAGE:
--   1. Run as-is for BEFORE/AFTER preview (rolled back).
--   2. Set @COMMIT = 1 and re-run to apply.
-- =====================================================================================

DECLARE @COMMIT BIT = 0;  -- 0 = dry run, 1 = real

-- Target rows (HouseholdId / TenantId / BillingPeriodStart / BillingPeriodEnd)
DECLARE @rows TABLE (
    HouseholdId        UNIQUEIDENTIFIER,
    TenantId           UNIQUEIDENTIFIER,
    BillingPeriodStart DATE,
    BillingPeriodEnd   DATE
);

INSERT INTO @rows (HouseholdId, TenantId, BillingPeriodStart, BillingPeriodEnd)
VALUES
    -- Mark Whitesides – missing March 2026
    ('E6343574-CAA7-4FAA-AFA1-141C113BF23C', '1CD92AF7-B6F2-4E48-A8F3-EC6316158826',
     '2026-03-01', '2026-03-31'),
    -- Paul Yurt – missing March 2026
    ('04F4C52C-D3ED-4B22-8DD8-1CFAD94D37FF', '1CD92AF7-B6F2-4E48-A8F3-EC6316158826',
     '2026-03-01', '2026-03-31'),
    -- Michael McCracken – missing March 2026
    ('594729B7-ABDF-4457-AC8A-81493AC41293', '1CD92AF7-B6F2-4E48-A8F3-EC6316158826',
     '2026-03-01', '2026-03-31'),
    -- Brian Schoening – missing April 2026
    ('8BFCAB63-D286-4859-B0A8-BED3AE36E3AD', '1CD92AF7-B6F2-4E48-A8F3-EC6316158826',
     '2026-04-01', '2026-04-30');

BEGIN TRY
    BEGIN TRANSACTION;

    -- BEFORE: show what we plan to insert (totals derived from enrollments).
    SELECT 'BEFORE - planned inserts' AS Step,
           r.HouseholdId,
           r.BillingPeriodStart,
           r.BillingPeriodEnd,
           tot.ProjectedTotal,
           tot.ActiveEnrollmentCount,
           CASE
               WHEN EXISTS (
                   SELECT 1 FROM oe.Invoices i
                   WHERE i.HouseholdId = r.HouseholdId
                     AND i.InvoiceType = N'Individual'
                     AND i.BillingPeriodStart = r.BillingPeriodStart
                     AND i.BillingPeriodEnd   = r.BillingPeriodEnd
                     AND i.Status NOT IN (N'Cancelled', N'Voided')
               ) THEN 'SKIP - already exists'
               WHEN tot.ProjectedTotal <= 0 THEN 'SKIP - $0 enrollments'
               ELSE 'WILL CREATE'
           END AS Action_
      FROM @rows r
 OUTER APPLY (
        SELECT
            COALESCE(SUM(COALESCE(e.PremiumAmount, 0)), 0) AS ProjectedTotal,
            COUNT(*) AS ActiveEnrollmentCount
          FROM oe.Enrollments e
         WHERE e.HouseholdId = r.HouseholdId
           AND e.EffectiveDate <= r.BillingPeriodEnd
           AND (e.TerminationDate IS NULL OR e.TerminationDate > r.BillingPeriodStart)
           AND e.Status NOT IN ('Cancelled', 'Declined')
      ) tot
     ORDER BY r.HouseholdId;

    -- Walk each row and INSERT if it doesn't already exist and total > 0.
    DECLARE @HouseholdId UNIQUEIDENTIFIER;
    DECLARE @TenantId    UNIQUEIDENTIFIER;
    DECLARE @bpStart     DATE;
    DECLARE @bpEnd       DATE;

    DECLARE row_cursor CURSOR LOCAL FAST_FORWARD FOR
        SELECT HouseholdId, TenantId, BillingPeriodStart, BillingPeriodEnd FROM @rows;
    OPEN row_cursor;
    FETCH NEXT FROM row_cursor INTO @HouseholdId, @TenantId, @bpStart, @bpEnd;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM oe.Invoices i
            WHERE i.HouseholdId = @HouseholdId
              AND i.InvoiceType = N'Individual'
              AND i.BillingPeriodStart = @bpStart
              AND i.BillingPeriodEnd   = @bpEnd
              AND i.Status NOT IN (N'Cancelled', N'Voided')
        )
        BEGIN
            DECLARE @TotalAmount DECIMAL(12,2);
            SELECT @TotalAmount = COALESCE(SUM(COALESCE(e.PremiumAmount, 0)), 0)
              FROM oe.Enrollments e
             WHERE e.HouseholdId = @HouseholdId
               AND e.EffectiveDate <= @bpEnd
               AND (e.TerminationDate IS NULL OR e.TerminationDate > @bpStart)
               AND e.Status NOT IN ('Cancelled', 'Declined');

            IF @TotalAmount IS NOT NULL AND @TotalAmount > 0
            BEGIN
                -- Prefer the same numbering source the app uses (sp_GetNextInvoiceNumber);
                -- fall back to a max+1 in same month bucket if the proc isn't available.
                DECLARE @InvoiceNumber NVARCHAR(50) = NULL;
                BEGIN TRY
                    EXEC oe.sp_GetNextInvoiceNumber @InvoiceNumber = @InvoiceNumber OUTPUT;
                END TRY
                BEGIN CATCH
                    SET @InvoiceNumber = NULL;
                END CATCH

                IF @InvoiceNumber IS NULL OR LTRIM(RTRIM(@InvoiceNumber)) = ''
                BEGIN
                    DECLARE @ymBucket NVARCHAR(8) = CONVERT(varchar(6), GETUTCDATE(), 112); -- yyyymm
                    DECLARE @nextSeq  INT;
                    SELECT @nextSeq = ISNULL(MAX(CAST(SUBSTRING(InvoiceNumber, 13, 10) AS INT)), 1000) + 1
                      FROM oe.Invoices
                     WHERE InvoiceNumber LIKE 'INV-' + @ymBucket + '-%'
                       AND ISNUMERIC(SUBSTRING(InvoiceNumber, 13, 10)) = 1;
                    SET @InvoiceNumber = CONCAT('INV-', @ymBucket, '-', @nextSeq);
                END

                INSERT INTO oe.Invoices
                    (InvoiceId, HouseholdId, TenantId, InvoiceType, InvoiceNumber,
                     InvoiceDate, DueDate, BillingPeriodStart, BillingPeriodEnd,
                     SubTotal, TaxAmount, TotalAmount, PaidAmount, Status,
                     PaymentDueDate, CreatedDate, ModifiedDate)
                VALUES
                    (NEWID(), @HouseholdId, @TenantId, N'Individual', @InvoiceNumber,
                     @bpStart, @bpStart, @bpStart, @bpEnd,
                     @TotalAmount, 0, @TotalAmount, 0, N'Unpaid',
                     @bpStart, SYSUTCDATETIME(), SYSUTCDATETIME());

                PRINT CONCAT('Inserted ', @InvoiceNumber, ' for ', @HouseholdId,
                             ' (', @bpStart, ' .. ', @bpEnd, ') total ', @TotalAmount);
            END
            ELSE
            BEGIN
                PRINT CONCAT('Skipped ', @HouseholdId, ' (', @bpStart,
                             ') - projected total is $0 / NULL');
            END
        END
        ELSE
        BEGIN
            PRINT CONCAT('Skipped ', @HouseholdId, ' (', @bpStart,
                         ') - invoice already exists for this period');
        END

        FETCH NEXT FROM row_cursor INTO @HouseholdId, @TenantId, @bpStart, @bpEnd;
    END
    CLOSE row_cursor;
    DEALLOCATE row_cursor;

    -- AFTER: show the resulting invoices in the target periods.
    SELECT 'AFTER - target rows' AS Step,
           i.InvoiceNumber, i.Status, i.TotalAmount, i.PaidAmount,
           CONVERT(varchar(10), i.BillingPeriodStart, 120) AS Start_,
           CONVERT(varchar(10), i.BillingPeriodEnd, 120)   AS End_,
           i.HouseholdId,
           CONVERT(varchar(19), i.CreatedDate, 120) AS Created
      FROM oe.Invoices i
INNER JOIN @rows r
        ON r.HouseholdId        = i.HouseholdId
       AND r.BillingPeriodStart = i.BillingPeriodStart
       AND r.BillingPeriodEnd   = i.BillingPeriodEnd
     WHERE i.InvoiceType = N'Individual'
     ORDER BY i.HouseholdId, i.BillingPeriodStart;

    IF @COMMIT = 1
    BEGIN
        COMMIT TRANSACTION;
        PRINT 'COMMITTED.';
    END
    ELSE
    BEGIN
        ROLLBACK TRANSACTION;
        PRINT 'DRY RUN - rolled back. Set @COMMIT = 1 and re-run to apply.';
    END
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    DECLARE @errMsg NVARCHAR(MAX) = ERROR_MESSAGE();
    PRINT CONCAT('ERROR: ', @errMsg);
    THROW;
END CATCH;
