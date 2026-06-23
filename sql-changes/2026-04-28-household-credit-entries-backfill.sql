-- Phase 1b: Backfill historical overpayments into oe.HouseholdCreditEntries.
--
-- Run AFTER:
--   1. 2026-04-28-household-credit-entries-schema.sql
--   2. 2026-04-28-invoices-credit-amount.sql
--
-- For every payment whose amount > linked invoice TotalAmount, create one
-- 'OverpaymentRecognized' ledger entry and cap the invoice's PaidAmount at
-- TotalAmount. The CreditAmount column is left at 0 — the nightly applier
-- (Phase 1c+1d) will allocate the credit to the household's oldest unpaid
-- invoice on the first run after deploy.
--
-- Filters (mirror Phase 1c detector):
--   * payment is linked to an invoice (InvoiceId IS NOT NULL)
--   * payment amount > invoice TotalAmount (positive surplus)
--   * payment.Status NOT IN ('Refunded') AND no refund payment row exists
--   * payment.TransactionType NOT IN ('Refund','Chargeback','Reversal')
--   * works for BOTH individual (GroupId IS NULL) and group payments
--
-- Idempotent via the filtered unique index (SourcePaymentId, SourceInvoiceId)
-- on EntryType='OverpaymentRecognized'.
--
-- Reference: /Users/jeremyfrancis/.cursor/plans/credits_and_clawback_ledger_0655b4cc.plan.md
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- =============================================================================
-- PREFLIGHT REPORT (read-only)
-- =============================================================================
PRINT '=== PREFLIGHT: candidate overpayments ===';

;WITH cand AS (
    SELECT
        p.PaymentId,
        p.HouseholdId,
        p.TenantId,
        p.GroupId,
        p.Amount AS PaymentAmount,
        i.InvoiceId,
        i.TotalAmount AS InvoiceTotal,
        i.PaidAmount AS InvoicePaid,
        (p.Amount - i.TotalAmount) AS Surplus
    FROM oe.Payments p
    INNER JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.HouseholdId IS NOT NULL
      AND p.Amount > i.TotalAmount
      AND p.Amount IS NOT NULL
      AND i.TotalAmount IS NOT NULL
      AND COALESCE(p.Status, '') NOT IN ('Refunded', 'Voided', 'Failed', 'Cancelled')
      AND COALESCE(p.TransactionType, 'Payment') NOT IN ('Refund', 'Chargeback', 'Reversal', 'ACH_Return')
      AND NOT EXISTS (
          SELECT 1 FROM oe.Payments r
          WHERE r.OriginalPaymentId = p.PaymentId
            AND r.TransactionType IN ('Refund', 'Reversal')
      )
      AND NOT EXISTS (
          -- already backfilled
          SELECT 1 FROM oe.HouseholdCreditEntries e
          WHERE e.SourcePaymentId = p.PaymentId
            AND e.SourceInvoiceId = p.InvoiceId
            AND e.EntryType = N'OverpaymentRecognized'
      )
)
SELECT
    COUNT(*) AS CandidateCount,
    SUM(Surplus) AS TotalSurplus,
    COUNT(DISTINCT HouseholdId) AS DistinctHouseholds,
    SUM(CASE WHEN GroupId IS NULL THEN 1 ELSE 0 END) AS IndividualPayments,
    SUM(CASE WHEN GroupId IS NOT NULL THEN 1 ELSE 0 END) AS GroupPayments,
    MIN(Surplus) AS MinSurplus,
    MAX(Surplus) AS MaxSurplus
FROM cand;

PRINT '=== PREFLIGHT: top 20 by surplus ===';

;WITH cand AS (
    SELECT
        p.PaymentId,
        p.HouseholdId,
        p.TenantId,
        p.GroupId,
        p.Amount AS PaymentAmount,
        i.InvoiceId,
        i.TotalAmount AS InvoiceTotal,
        i.PaidAmount AS InvoicePaid,
        (p.Amount - i.TotalAmount) AS Surplus,
        p.PaymentDate
    FROM oe.Payments p
    INNER JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.HouseholdId IS NOT NULL
      AND p.Amount > i.TotalAmount
      AND COALESCE(p.Status, '') NOT IN ('Refunded', 'Voided', 'Failed', 'Cancelled')
      AND COALESCE(p.TransactionType, 'Payment') NOT IN ('Refund', 'Chargeback', 'Reversal', 'ACH_Return')
      AND NOT EXISTS (
          SELECT 1 FROM oe.Payments r
          WHERE r.OriginalPaymentId = p.PaymentId
            AND r.TransactionType IN ('Refund', 'Reversal')
      )
      AND NOT EXISTS (
          SELECT 1 FROM oe.HouseholdCreditEntries e
          WHERE e.SourcePaymentId = p.PaymentId
            AND e.SourceInvoiceId = p.InvoiceId
            AND e.EntryType = N'OverpaymentRecognized'
      )
)
SELECT TOP 20
    PaymentId, HouseholdId, GroupId, PaymentAmount, InvoiceTotal, InvoicePaid, Surplus, PaymentDate
FROM cand
ORDER BY Surplus DESC;

-- =============================================================================
-- BACKFILL (transactional)
-- =============================================================================
PRINT '=== BACKFILL: inserting OverpaymentRecognized entries + capping PaidAmount ===';

BEGIN TRANSACTION;
BEGIN TRY

    DECLARE @inserted TABLE (
        EntryId UNIQUEIDENTIFIER,
        InvoiceId UNIQUEIDENTIFIER,
        Surplus DECIMAL(10, 2),
        InvoiceTotal DECIMAL(10, 2)
    );

    -- Insert credit entries
    INSERT INTO oe.HouseholdCreditEntries (
        EntryId, TenantId, HouseholdId, EntryType, Amount,
        SourcePaymentId, SourceInvoiceId, Notes, CreatedDate
    )
    OUTPUT INSERTED.EntryId, INSERTED.SourceInvoiceId, INSERTED.Amount, NULL INTO @inserted (EntryId, InvoiceId, Surplus, InvoiceTotal)
    SELECT
        NEWID(),
        p.TenantId,
        p.HouseholdId,
        N'OverpaymentRecognized',
        CONVERT(DECIMAL(10, 2), p.Amount - i.TotalAmount),
        p.PaymentId,
        p.InvoiceId,
        N'Backfill 2026-04-28: historical overpayment captured as credit',
        GETUTCDATE()
    FROM oe.Payments p
    INNER JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.HouseholdId IS NOT NULL
      AND p.Amount > i.TotalAmount
      AND COALESCE(p.Status, '') NOT IN ('Refunded', 'Voided', 'Failed', 'Cancelled')
      AND COALESCE(p.TransactionType, 'Payment') NOT IN ('Refund', 'Chargeback', 'Reversal', 'ACH_Return')
      AND NOT EXISTS (
          SELECT 1 FROM oe.Payments r
          WHERE r.OriginalPaymentId = p.PaymentId
            AND r.TransactionType IN ('Refund', 'Reversal')
      )
      AND NOT EXISTS (
          SELECT 1 FROM oe.HouseholdCreditEntries e
          WHERE e.SourcePaymentId = p.PaymentId
            AND e.SourceInvoiceId = p.InvoiceId
            AND e.EntryType = N'OverpaymentRecognized'
      );

    DECLARE @insertedCount INT = (SELECT COUNT(*) FROM @inserted);
    DECLARE @insertedSurplus DECIMAL(18, 2) = (SELECT COALESCE(SUM(Surplus), 0) FROM @inserted);
    PRINT CONCAT('Inserted ', @insertedCount, ' OverpaymentRecognized entries totalling $', @insertedSurplus);

    -- Cap PaidAmount on every distinct invoice that just received a backfilled credit.
    -- Any invoice whose PaidAmount currently exceeds TotalAmount is capped at TotalAmount.
    UPDATE i
    SET PaidAmount = i.TotalAmount,
        ModifiedDate = GETUTCDATE()
    FROM oe.Invoices i
    INNER JOIN (SELECT DISTINCT InvoiceId FROM @inserted) ins ON ins.InvoiceId = i.InvoiceId
    WHERE i.PaidAmount > i.TotalAmount;

    PRINT CONCAT('Capped PaidAmount on ', @@ROWCOUNT, ' invoices.');

    COMMIT TRANSACTION;
    PRINT 'Backfill committed.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    PRINT CONCAT('Backfill rolled back: ', ERROR_MESSAGE());
    THROW;
END CATCH
GO

-- =============================================================================
-- POST-FLIGHT REPORT
-- =============================================================================
PRINT '=== POST-FLIGHT: ledger summary by household ===';

SELECT TOP 20
    e.HouseholdId,
    COUNT(*) AS EntryCount,
    SUM(e.Amount) AS NetCredit
FROM oe.HouseholdCreditEntries e
GROUP BY e.HouseholdId
HAVING SUM(e.Amount) > 0
ORDER BY NetCredit DESC;

PRINT 'Phase 1b backfill complete.';
