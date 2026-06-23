/*
  Backfill AttemptNumber / ConsecutiveFailureCount / OriginalPaymentId / LastFailureDate for the
  three $3,074.40 recurring rows (ProcessorTransactionId 57, 96, 106) after they were set to Failed.

  What we know:
  - DIME sent three separate transaction records ≈8 days apart (retries), each mis-recorded as Completed then corrected to Failed.
  - We do NOT have a separate "retry count" from DIME in oe.Payments for those events unless we infer it from row count + dates.

  This script encodes that inference in the same shape as createFailedRecurringPaymentRecord / card webhook:
  - Earliest payment (Mar 5, txn 57): attempt 1, consecutive 0, no OriginalPaymentId
  - Mar 13 (txn 96): attempt 2, consecutive 1, OriginalPaymentId = first
  - Mar 21 (txn 106): attempt 3, consecutive 2, OriginalPaymentId = first

  After this, Tenant Billing will show:
  - "Failed" on the first row
  - "Retry failed (2)" and "Retry failed (3)" on the second and third (formatBillingPaymentStatusLabel)

  Run only if those PaymentIds still exist and Status = 'Failed'. Safe to re-run if values already match.
*/

SET NOCOUNT ON;

DECLARE @P1 UNIQUEIDENTIFIER = '0B7828B6-0606-4256-B9A3-E5AE671948C0'; -- 57, earliest
DECLARE @P2 UNIQUEIDENTIFIER = 'E9DBB78C-91BD-4D86-97D5-FC8A1D5F0FD0'; -- 96
DECLARE @P3 UNIQUEIDENTIFIER = '7E73DED9-4EBD-461C-9753-956C384ED7F9'; -- 106, latest

BEGIN TRANSACTION;

UPDATE oe.Payments
SET
  AttemptNumber = 1,
  ConsecutiveFailureCount = 0,
  OriginalPaymentId = NULL,
  LastFailureDate = PaymentDate,
  ModifiedDate = SYSUTCDATETIME()
WHERE PaymentId = @P1
  AND Status = N'Failed'
  AND ABS(Amount - 3074.40) < 0.01;

IF @@ROWCOUNT <> 1
BEGIN
  RAISERROR('Expected 1 row for P1 (check PaymentId / Status / Amount).', 16, 1);
  ROLLBACK TRANSACTION;
  RETURN;
END;

UPDATE oe.Payments
SET
  AttemptNumber = 2,
  ConsecutiveFailureCount = 1,
  OriginalPaymentId = @P1,
  LastFailureDate = PaymentDate,
  ModifiedDate = SYSUTCDATETIME()
WHERE PaymentId = @P2
  AND Status = N'Failed'
  AND ABS(Amount - 3074.40) < 0.01;

IF @@ROWCOUNT <> 1
BEGIN
  RAISERROR('Expected 1 row for P2.', 16, 1);
  ROLLBACK TRANSACTION;
  RETURN;
END;

UPDATE oe.Payments
SET
  AttemptNumber = 3,
  ConsecutiveFailureCount = 2,
  OriginalPaymentId = @P1,
  LastFailureDate = PaymentDate,
  ModifiedDate = SYSUTCDATETIME()
WHERE PaymentId = @P3
  AND Status = N'Failed'
  AND ABS(Amount - 3074.40) < 0.01;

IF @@ROWCOUNT <> 1
BEGIN
  RAISERROR('Expected 1 row for P3.', 16, 1);
  ROLLBACK TRANSACTION;
  RETURN;
END;

COMMIT TRANSACTION;
PRINT 'Backfill complete: attempts 1–3 set for $3,074.40 recurring failure chain.';
