-- ============================================================================
-- Link orphan prepay payments to their corresponding invoices
--
-- Problem: Some individual payments are made BEFORE the BillingPeriodStart
-- of the invoice they are intended to pay (e.g., a member signs up March 25
-- for April 1 coverage and pays on March 25). The current
-- invoiceService.selfHealInvoice only matches payments where
-- PaymentDate >= BillingPeriodStart, so prepayments sit orphaned
-- (InvoiceId IS NULL) while the corresponding April invoice is Unpaid.
--
-- The DB readiness check for the Invoice-Sourced Payouts project identified
-- 7 such orphans. This script links them using the same rules the widened
-- self-heal will use going forward:
--
--   - Payment has InvoiceId IS NULL
--   - Payment status is Completed / succeeded / Success
--   - Payment is for an individual (HouseholdId NOT NULL, GroupId IS NULL)
--   - Matching invoice: same HouseholdId, InvoiceType = 'Individual',
--     Status IN ('Unpaid', 'Partial', 'Overdue')
--   - Payment made within 0..45 days BEFORE invoice BillingPeriodStart
--   - Exactly ONE candidate invoice exists for that payment
--     (ambiguous matches are skipped for safety)
--   - Payment Amount is within $0.50 of the invoice remaining balance
--     (TotalAmount - COALESCE(PaidAmount, 0))
--
-- After linking, invoice PaidAmount and Status are updated using the same
-- fulfillment math as selfHealInvoice.
--
-- Safe to run multiple times — only touches payments that are still orphans.
-- ============================================================================

BEGIN TRANSACTION;

DECLARE @PrepayWindowDays INT = 45;
DECLARE @AmountToleranceCents DECIMAL(12, 2) = 0.50;

-- Build candidate set: orphan payment -> unambiguous unpaid invoice within window
IF OBJECT_ID('tempdb..#Candidates') IS NOT NULL DROP TABLE #Candidates;
CREATE TABLE #Candidates (
    PaymentId        UNIQUEIDENTIFIER NOT NULL,
    PaymentDate      DATETIME2 NOT NULL,
    PaymentAmount    DECIMAL(12, 2) NOT NULL,
    HouseholdId      UNIQUEIDENTIFIER NOT NULL,
    InvoiceId        UNIQUEIDENTIFIER NOT NULL,
    InvoiceNumber    NVARCHAR(50) NULL,
    InvoiceStatus    NVARCHAR(50) NULL,
    BillingPeriodStart DATETIME2 NOT NULL,
    BillingPeriodEnd   DATETIME2 NOT NULL,
    TotalAmount      DECIMAL(12, 2) NOT NULL,
    PriorPaidAmount  DECIMAL(12, 2) NOT NULL,
    RemainingBalance AS (TotalAmount - PriorPaidAmount) PERSISTED
);

INSERT INTO #Candidates (
    PaymentId, PaymentDate, PaymentAmount, HouseholdId,
    InvoiceId, InvoiceNumber, InvoiceStatus,
    BillingPeriodStart, BillingPeriodEnd,
    TotalAmount, PriorPaidAmount
)
SELECT
    p.PaymentId,
    p.PaymentDate,
    p.Amount,
    p.HouseholdId,
    i.InvoiceId,
    i.InvoiceNumber,
    i.Status,
    i.BillingPeriodStart,
    i.BillingPeriodEnd,
    i.TotalAmount,
    COALESCE(i.PaidAmount, 0)
FROM oe.Payments p
INNER JOIN oe.Invoices i
    ON  i.HouseholdId = p.HouseholdId
    AND i.InvoiceType = N'Individual'
    AND i.Status IN (N'Unpaid', N'Partial', N'Overdue')
    AND DATEDIFF(day, p.PaymentDate, i.BillingPeriodStart) BETWEEN 0 AND @PrepayWindowDays
WHERE p.InvoiceId IS NULL
  AND p.HouseholdId IS NOT NULL
  AND p.GroupId IS NULL
  AND p.Status IN (N'Completed', N'succeeded', N'Success')
  AND (p.TransactionType IS NULL OR p.TransactionType = N'Payment')
  -- Amount must land within tolerance of the invoice remaining balance
  AND ABS(p.Amount - (i.TotalAmount - COALESCE(i.PaidAmount, 0))) <= @AmountToleranceCents
  -- Unambiguous: payment must match exactly one candidate invoice
  AND (
      SELECT COUNT(*)
      FROM oe.Invoices i2
      WHERE i2.HouseholdId = p.HouseholdId
        AND i2.InvoiceType = N'Individual'
        AND i2.Status IN (N'Unpaid', N'Partial', N'Overdue')
        AND DATEDIFF(day, p.PaymentDate, i2.BillingPeriodStart) BETWEEN 0 AND @PrepayWindowDays
        AND ABS(p.Amount - (i2.TotalAmount - COALESCE(i2.PaidAmount, 0))) <= @AmountToleranceCents
  ) = 1;

-- Preview the candidates before applying
SELECT 'Prepay orphans to link' AS Label, COUNT(*) AS CandidateCount FROM #Candidates;

SELECT
    c.PaymentId,
    c.PaymentDate,
    c.PaymentAmount,
    c.HouseholdId,
    c.InvoiceNumber,
    c.InvoiceStatus,
    c.BillingPeriodStart,
    c.BillingPeriodEnd,
    c.TotalAmount,
    c.PriorPaidAmount,
    c.RemainingBalance,
    DATEDIFF(day, c.PaymentDate, c.BillingPeriodStart) AS DaysBeforePeriodStart
FROM #Candidates c
ORDER BY c.PaymentDate;

-- Link each orphan payment to its invoice
UPDATE p
SET p.InvoiceId = c.InvoiceId,
    p.ModifiedDate = GETUTCDATE()
FROM oe.Payments p
INNER JOIN #Candidates c ON c.PaymentId = p.PaymentId
WHERE p.InvoiceId IS NULL;

SELECT @@ROWCOUNT AS PaymentsLinked;

-- Update invoice PaidAmount and Status to reflect newly linked payments
;WITH LinkedSums AS (
    SELECT
        c.InvoiceId,
        SUM(c.PaymentAmount) AS AddedAmount
    FROM #Candidates c
    GROUP BY c.InvoiceId
)
UPDATE i
SET i.PaidAmount = COALESCE(i.PaidAmount, 0) + ls.AddedAmount,
    i.Status = CASE
        WHEN COALESCE(i.PaidAmount, 0) + ls.AddedAmount >= i.TotalAmount THEN N'Paid'
        WHEN COALESCE(i.PaidAmount, 0) + ls.AddedAmount > 0 THEN N'Partial'
        ELSE i.Status
    END,
    i.PaymentReceivedDate = CASE
        WHEN COALESCE(i.PaidAmount, 0) + ls.AddedAmount >= i.TotalAmount THEN GETUTCDATE()
        ELSE i.PaymentReceivedDate
    END,
    i.ModifiedDate = GETUTCDATE()
FROM oe.Invoices i
INNER JOIN LinkedSums ls ON ls.InvoiceId = i.InvoiceId;

SELECT @@ROWCOUNT AS InvoicesUpdated;

-- Post-state: confirm the candidate payments are now linked and invoices reflect payment
SELECT
    'After' AS Label,
    p.PaymentId,
    p.Amount,
    p.InvoiceId,
    i.InvoiceNumber,
    i.Status,
    i.TotalAmount,
    i.PaidAmount
FROM oe.Payments p
INNER JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
WHERE p.PaymentId IN (SELECT PaymentId FROM #Candidates)
ORDER BY p.PaymentDate;

-- Remaining orphans: any individual payments still unlinked that look like
-- they should be (for operator review — not auto-linked because ambiguous
-- or out of tolerance)
SELECT
    'Remaining unlinked prepay candidates' AS Label,
    p.PaymentId, p.PaymentDate, p.Amount, p.HouseholdId
FROM oe.Payments p
WHERE p.InvoiceId IS NULL
  AND p.HouseholdId IS NOT NULL
  AND p.GroupId IS NULL
  AND p.Status IN (N'Completed', N'succeeded', N'Success')
  AND (p.TransactionType IS NULL OR p.TransactionType = N'Payment')
  AND EXISTS (
      SELECT 1 FROM oe.Invoices i2
      WHERE i2.HouseholdId = p.HouseholdId
        AND i2.InvoiceType = N'Individual'
        AND i2.Status IN (N'Unpaid', N'Partial', N'Overdue')
        AND DATEDIFF(day, p.PaymentDate, i2.BillingPeriodStart) BETWEEN 0 AND @PrepayWindowDays
  )
ORDER BY p.PaymentDate;

DROP TABLE #Candidates;

-- Review output above before committing
-- COMMIT;
ROLLBACK;
