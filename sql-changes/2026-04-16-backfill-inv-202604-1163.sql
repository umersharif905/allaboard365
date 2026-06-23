-- ============================================================================
-- Backfill breakdowns on invoice INV-202604-1163
--
-- Problem: During the DB readiness check for the Invoice-Sourced Payouts
-- project, INV-202604-1163 was identified as the single straggler invoice
-- (out of 153 over the last 30 days) whose breakdown columns are all NULL.
--
-- Strategy:
--   1. If exactly one Payment is linked to this invoice with breakdowns
--      populated, copy the breakdowns from that payment (same pattern as
--      2026-04-16-backfill-invoice-breakdowns.sql).
--   2. Otherwise, leave the invoice NULL and use the backend endpoint
--      POST /api/invoices/backfill-breakdowns which calls
--      paymentAudit.service.js computeInvoiceAllocation to recompute
--      breakdowns from enrollments + commission rules.
--
-- Safe to run multiple times — only updates when all 6 scalar breakdown
-- columns are still NULL on the invoice.
-- ============================================================================

BEGIN TRANSACTION;

DECLARE @InvoiceNumber NVARCHAR(50) = N'INV-202604-1163';

-- Preview: show current state of the invoice and its linked payments
SELECT
    'Invoice (before)' AS Label,
    i.InvoiceId,
    i.InvoiceNumber,
    i.Status,
    i.TotalAmount,
    i.PaidAmount,
    i.NetRate,
    i.OverrideRate,
    i.Commission,
    i.SystemFees,
    i.ProcessingFeeAmount,
    i.SetupFee,
    CASE WHEN i.ProductCommissions IS NULL THEN 'NULL' ELSE 'populated' END AS ProductCommissions,
    CASE WHEN i.ProductVendorAmounts IS NULL THEN 'NULL' ELSE 'populated' END AS ProductVendorAmounts,
    CASE WHEN i.ProductOwnerAmounts IS NULL THEN 'NULL' ELSE 'populated' END AS ProductOwnerAmounts
FROM oe.Invoices i
WHERE i.InvoiceNumber = @InvoiceNumber;

SELECT
    'Linked Payments' AS Label,
    p.PaymentId,
    p.PaymentDate,
    p.Amount,
    p.Status,
    p.TransactionType,
    p.NetRate,
    p.OverrideRate,
    p.Commission,
    p.SystemFees,
    p.ProcessingFeeAmount,
    p.SetupFee
FROM oe.Payments p
INNER JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
WHERE i.InvoiceNumber = @InvoiceNumber
ORDER BY p.PaymentDate;

-- Attempt: copy breakdowns from the single linked payment (if there is one
-- with breakdowns populated)
UPDATE i
SET
    i.NetRate               = p.NetRate,
    i.OverrideRate          = p.OverrideRate,
    i.Commission            = p.Commission,
    i.SystemFees            = p.SystemFees,
    i.ProcessingFeeAmount   = p.ProcessingFeeAmount,
    i.SetupFee              = COALESCE(p.SetupFee, 0),
    i.ProductCommissions    = p.ProductCommissions,
    i.ProductVendorAmounts  = p.ProductVendorAmounts,
    i.ProductOwnerAmounts   = p.ProductOwnerAmounts,
    i.ModifiedDate          = GETUTCDATE()
FROM oe.Invoices i
INNER JOIN oe.Payments p ON p.InvoiceId = i.InvoiceId
    AND p.TransactionType = 'Payment'
WHERE i.InvoiceNumber = @InvoiceNumber
  AND i.NetRate IS NULL
  AND i.OverrideRate IS NULL
  AND i.Commission IS NULL
  AND i.SystemFees IS NULL
  AND i.ProcessingFeeAmount IS NULL
  AND i.SetupFee IS NULL
  AND (
      SELECT COUNT(*)
      FROM oe.Payments p2
      WHERE p2.InvoiceId = i.InvoiceId
        AND p2.TransactionType = 'Payment'
  ) = 1
  AND p.NetRate IS NOT NULL;

SELECT @@ROWCOUNT AS InvoicesUpdatedFromSinglePayment;

-- After state
SELECT
    'Invoice (after)' AS Label,
    i.InvoiceId,
    i.InvoiceNumber,
    i.Status,
    i.NetRate,
    i.OverrideRate,
    i.Commission,
    i.SystemFees,
    i.ProcessingFeeAmount,
    i.SetupFee,
    CASE WHEN i.ProductCommissions IS NULL THEN 'NULL' ELSE 'populated' END AS ProductCommissions,
    CASE WHEN i.ProductVendorAmounts IS NULL THEN 'NULL' ELSE 'populated' END AS ProductVendorAmounts,
    CASE WHEN i.ProductOwnerAmounts IS NULL THEN 'NULL' ELSE 'populated' END AS ProductOwnerAmounts,
    CASE
        WHEN i.NetRate IS NOT NULL THEN 'OK — ready for invoice-sourced payouts'
        ELSE 'Still NULL — call POST /api/invoices/backfill-breakdowns to recompute'
    END AS NextStep
FROM oe.Invoices i
WHERE i.InvoiceNumber = @InvoiceNumber;

-- Review output above before committing
-- COMMIT;
ROLLBACK;
