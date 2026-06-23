-- Migration: Rhonda Floyd — June invoice incorrectly marked Paid before Pending ACH settled
-- Date: 2026-06-09
-- Author: Jeremy Francis
--
-- SITUATION (verified prod):
--   INV-202604-1139 (April period): Failed 4/6 ACH, then Completed 6/4 ACH $851.99 → correctly Paid.
--   INV-202606-1495 (June period):   Only Pending 6/8 ACH $851.99 linked — must NOT be Paid yet.
--
-- FIX:
--   Leave April invoice Paid (PaidAmount = TotalAmount, payment 717 / txn Completed).
--   Reset June invoice to Unpaid (PaidAmount = 0, clear PaymentReceivedDate).
--   When Pending ACH 776 settles, webhook will mark June Paid automatically.
--
-- Household: Rhonda Floyd  7DC2A3AB-F6CC-49F6-A4A0-D8788FB95477

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @Now DATETIME2 = GETUTCDATE();
DECLARE @HouseholdId UNIQUEIDENTIFIER = '7DC2A3AB-F6CC-49F6-A4A0-D8788FB95477';
DECLARE @AprilInvoiceId UNIQUEIDENTIFIER = '89E1DD22-2C49-4591-B5CB-56686B5EF7D7';  -- INV-202604-1139
DECLARE @JuneInvoiceId UNIQUEIDENTIFIER = '1783E95C-AD8B-4BE7-9F02-0C6DC0ED2B5C';   -- INV-202606-1495
DECLARE @CompletedPaymentId UNIQUEIDENTIFIER = '6CEBECCC-222C-4021-B1B9-B57EE22FCE17'; -- txn 717
DECLARE @PendingPaymentId UNIQUEIDENTIFIER = '5F31D94F-C487-414F-A5F1-4873FC736A05';   -- txn 776

BEGIN TRY
    BEGIN TRANSACTION;

    ------------------------------------------------------------------
    -- Preview: invoices + payments for this household
    ------------------------------------------------------------------
    SELECT
        i.InvoiceNumber,
        CONVERT(VARCHAR(10), i.InvoiceDate, 120) AS InvDate,
        i.TotalAmount,
        i.PaidAmount,
        i.Status AS CurrentStatus,
        CASE
            WHEN i.InvoiceId = @AprilInvoiceId THEN N'KEEP Paid (Completed 6/4 ACH)'
            WHEN i.InvoiceId = @JuneInvoiceId THEN N'RESET → Unpaid (Pending ACH only)'
            ELSE N'—'
        END AS PlannedAction
    FROM oe.Invoices i
    WHERE i.HouseholdId = @HouseholdId
    ORDER BY i.InvoiceDate;

    SELECT
        CONVERT(VARCHAR(10), p.PaymentDate, 120) AS PayDate,
        p.Amount,
        p.Status,
        p.ProcessorTransactionId,
        i.InvoiceNumber
    FROM oe.Payments p
    LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.HouseholdId = @HouseholdId
    ORDER BY p.PaymentDate;

    ------------------------------------------------------------------
    -- Safety: abort if data no longer matches expected shape
    ------------------------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM oe.Invoices
        WHERE InvoiceId = @AprilInvoiceId AND HouseholdId = @HouseholdId
          AND Status = N'Paid' AND ABS(TotalAmount - 851.99) < 0.01
    )
    BEGIN
        RAISERROR('April invoice 89E1DD22 not in expected Paid state — aborting.', 16, 1);
    END

    IF NOT EXISTS (
        SELECT 1 FROM oe.Payments
        WHERE PaymentId = @CompletedPaymentId AND InvoiceId = @AprilInvoiceId
          AND Status = N'Completed' AND ABS(Amount - 851.99) < 0.01
    )
    BEGIN
        RAISERROR('Completed payment 6CEBECCC not linked to April invoice — aborting.', 16, 1);
    END

    IF NOT EXISTS (
        SELECT 1 FROM oe.Invoices
        WHERE InvoiceId = @JuneInvoiceId AND HouseholdId = @HouseholdId
          AND Status = N'Paid' AND ABS(TotalAmount - 851.99) < 0.01
    )
    BEGIN
        RAISERROR('June invoice 1783E95C not in expected incorrectly-Paid state — aborting.', 16, 1);
    END

    IF NOT EXISTS (
        SELECT 1 FROM oe.Payments
        WHERE PaymentId = @PendingPaymentId AND InvoiceId = @JuneInvoiceId
          AND Status = N'Pending' AND ABS(Amount - 851.99) < 0.01
    )
    BEGIN
        RAISERROR('Pending payment 5F31D94F not linked to June invoice — aborting.', 16, 1);
    END

    IF @DryRun = 1
    BEGIN
        PRINT 'DRY RUN — June invoice would reset to Unpaid. April invoice unchanged. Set @DryRun = 0 to apply.';
        ROLLBACK TRANSACTION;
        RETURN;
    END

    ------------------------------------------------------------------
    -- April: affirm Paid (idempotent — ensures PaidAmount matches Completed payment)
    ------------------------------------------------------------------
    UPDATE oe.Invoices
    SET Status = N'Paid',
        PaidAmount = TotalAmount,
        PaymentReceivedDate = COALESCE(PaymentReceivedDate, '2026-06-04'),
        ModifiedDate = @Now
    WHERE InvoiceId = @AprilInvoiceId
      AND HouseholdId = @HouseholdId;

    PRINT CONCAT('April invoice affirmed Paid: ', @@ROWCOUNT, ' row(s)');

    ------------------------------------------------------------------
    -- June: reset to Unpaid until Pending ACH settles
    ------------------------------------------------------------------
    UPDATE oe.Invoices
    SET Status = N'Unpaid',
        PaidAmount = 0,
        PaymentReceivedDate = NULL,
        ModifiedDate = @Now
    WHERE InvoiceId = @JuneInvoiceId
      AND HouseholdId = @HouseholdId
      AND Status = N'Paid';

    PRINT CONCAT('June invoice reset to Unpaid: ', @@ROWCOUNT, ' row(s)');

    COMMIT TRANSACTION;
    PRINT 'Committed. June will auto-mark Paid when Pending ACH txn 776 completes.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
