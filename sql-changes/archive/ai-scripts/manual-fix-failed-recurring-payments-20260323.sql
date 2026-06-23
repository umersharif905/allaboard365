/*
  Manual correction: three DIME recurring webhook rows were stored as Completed
  though charges did not succeed (see oe_payment_manager recurring handler fix).

  Verified in DB (ProcessorTransactionId 57, 96, 106; Amount 3074.40; same InvoiceId).

  Status convention in this codebase:
  - Failed payments: oe.Payments.Status = 'Failed' (Title case; matches webhooks / createFailedRecurringPaymentRecord)
  - Successful captures: 'Completed', 'APPROVAL', 'SUCCESS', 'succeeded', etc. (legacy mixed case exists in old rows)
  - If you see 'FAILED' all-caps on payments, normalize to 'Failed' for consistency (rare; invoice duplicate check used uppercase for display only)

  Run in SSMS / sqlcmd against the correct database after backup.
  Review the invoice section — only safe because these are the ONLY payments on this invoice.
*/

SET NOCOUNT ON;

BEGIN TRANSACTION;

DECLARE @Reason NVARCHAR(500) = N'Manual correction: recurring charge was declined/retried; previously mis-recorded as Completed.';

-- Explicit PaymentIds (from prod query 2026-03-23)
UPDATE oe.Payments
SET
  Status = N'Failed',
  FailureReason = @Reason,
  ModifiedDate = SYSUTCDATETIME()
WHERE PaymentId IN (
  '7E73DED9-4EBD-461C-9753-956C384ED7F9', -- ProcessorTransactionId 106, 2026-03-21
  '0B7828B6-0606-4256-B9A3-E5AE671948C0', -- ProcessorTransactionId 57,  2026-03-05
  'E9DBB78C-91BD-4D86-97D5-FC8A1D5F0FD0'  -- ProcessorTransactionId 96,  2026-03-13
);

IF @@ROWCOUNT <> 3
BEGIN
  RAISERROR('Expected 3 payment rows updated; aborting.', 16, 1);
  ROLLBACK TRANSACTION;
  RETURN;
END;

-- Invoice 426047E9-4ED6-4F21-A7DB-064E22429325: only the three rows above reference it.
-- Reset to unpaid so totals match reality.
DECLARE @InvoiceId UNIQUEIDENTIFIER = '426047E9-4ED6-4F21-A7DB-064E22429325';

IF EXISTS (
  SELECT 1
  FROM oe.Payments
  WHERE InvoiceId = @InvoiceId
    AND Status IN (N'Completed', N'APPROVAL', N'SUCCESS', N'COMPLETED', N'succeeded', N'Approved', N'PAID')
)
BEGIN
  RAISERROR('Invoice still has a non-failed payment in success-like status; review before updating invoice.', 16, 1);
  ROLLBACK TRANSACTION;
  RETURN;
END;

-- BalanceDue is a computed column on oe.Invoices — do not SET it; PaidAmount drives it.
UPDATE oe.Invoices
SET
  Status = N'Unpaid',
  PaidAmount = 0,
  PaymentReceivedDate = NULL,
  ModifiedDate = SYSUTCDATETIME()
WHERE InvoiceId = @InvoiceId;

COMMIT TRANSACTION;

PRINT 'Done: 3 payments set to Failed; invoice reset to Unpaid.';
