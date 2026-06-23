-- ============================================================================
-- Backfill invoice breakdown columns from linked payments
-- 
-- Problem: Invoices created by the backfill script have NULL breakdown columns
-- (NetRate, OverrideRate, Commission, SystemFees, ProcessingFeeAmount, SetupFee,
--  ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts).
--
-- Strategy:
--   1. For invoices with exactly ONE linked payment that has breakdowns populated,
--      copy the breakdown columns from that payment.
--   2. Invoices with 0 or 2+ linked payments are skipped (use the backend
--      POST /api/invoices/backfill-breakdowns endpoint for those).
--
-- Safe to run multiple times — only updates rows where all 6 scalar breakdown
-- columns are still NULL.
-- ============================================================================

BEGIN TRANSACTION;

-- Preview: how many invoices need backfill?
SELECT
    COUNT(*) AS TotalInvoicesMissingBreakdowns,
    SUM(CASE WHEN pc.PaymentCount = 1 THEN 1 ELSE 0 END) AS CanCopyFromSinglePayment,
    SUM(CASE WHEN pc.PaymentCount = 0 THEN 1 ELSE 0 END) AS NoLinkedPayments,
    SUM(CASE WHEN pc.PaymentCount > 1 THEN 1 ELSE 0 END) AS MultipleLinkedPayments
FROM oe.Invoices i
OUTER APPLY (
    SELECT COUNT(*) AS PaymentCount
    FROM oe.Payments p
    WHERE p.InvoiceId = i.InvoiceId
      AND p.TransactionType = 'Payment'
) pc
WHERE i.NetRate IS NULL
  AND i.OverrideRate IS NULL
  AND i.Commission IS NULL
  AND i.SystemFees IS NULL
  AND i.ProcessingFeeAmount IS NULL
  AND i.SetupFee IS NULL;

-- Copy breakdowns from the single linked payment
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
WHERE i.NetRate IS NULL
  AND i.OverrideRate IS NULL
  AND i.Commission IS NULL
  AND i.SystemFees IS NULL
  AND i.ProcessingFeeAmount IS NULL
  AND i.SetupFee IS NULL
  -- Only copy when there is exactly 1 payment linked
  AND (
      SELECT COUNT(*)
      FROM oe.Payments p2
      WHERE p2.InvoiceId = i.InvoiceId
        AND p2.TransactionType = 'Payment'
  ) = 1
  -- Only copy when the payment actually has breakdowns
  AND p.NetRate IS NOT NULL;

SELECT @@ROWCOUNT AS InvoicesUpdatedFromPayments;

-- Check how many still need backfill (0 or 2+ payments, or payment had no breakdowns)
SELECT COUNT(*) AS RemainingInvoicesMissingBreakdowns
FROM oe.Invoices
WHERE NetRate IS NULL
  AND OverrideRate IS NULL
  AND Commission IS NULL
  AND SystemFees IS NULL
  AND ProcessingFeeAmount IS NULL
  AND SetupFee IS NULL;

-- Review before committing: change to COMMIT when satisfied
-- COMMIT;
ROLLBACK;
