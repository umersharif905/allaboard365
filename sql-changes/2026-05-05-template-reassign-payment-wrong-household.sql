/*
  OPERATIONS — one-off correction when a recurring success was booked to wrong HouseholdId
  (duplicate Shared ProcessorCustomerId + ambiguous customer_uuid resolution).

  PREREQs: Identify correct HouseholdId vs wrong HouseholdId, PaymentId OR ProcessorTransactionId,
  invoice/commission impact reviewed with finance.

  This file is NOT auto-run; uncomment and substitute GUIDs explicitly after review.

  Typical pattern:
  1. SELECT PaymentId, HouseholdId, InvoiceId FROM oe.Payments WHERE ProcessorTransactionId = N'XXX';
  2. SELECT HouseholdId FROM oe.Members WHERE RelationshipType=N'P' AND HouseholdMemberID=N'SWxxxx';
  3. If payment should move household: UPDATE oe.Payments SET HouseholdId = @Correct... (and reconcile InvoiceId!)
*/

/*
BEGIN TRAN;

DECLARE @PaymentId UNIQUEIDENTIFIER = NULL;           -- oe.Payments.PaymentId
DECLARE @CorrectHouseholdId UNIQUEIDENTIFIER = NULL;
DECLARE @CorrectInvoiceId UNIQUEIDENTIFIER = NULL;    -- nullable if unlink

-- UPDATE oe.Payments
-- SET HouseholdId = @CorrectHouseholdId,
--     InvoiceId = @CorrectInvoiceId,
--     ModifiedDate = GETUTCDATE()
-- WHERE PaymentId = @PaymentId;

-- Rerun invoice sync / admin tools as needed after household move.

COMMIT;
-- ROLLBACK;
*/
