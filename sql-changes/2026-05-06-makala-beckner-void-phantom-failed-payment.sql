/**********************************************************************************
 * Retro-fix for Makala Beckner (SW15990909, MemberId 4A47938F-9D9B-46C6-B002-506930510D3B)
 *
 * Background (DIME dashboard is source of truth)
 * ----------------------------------------------
 *   Two $290.11 attempts on Makala's Robins Financial checking account (****9706):
 *
 *     2026-05-01 09:04 UTC   ACH_PAYMENT_CREDIT_REJECTED ($290.11)
 *                            DIME issued recurring_payment_success (webhook 511, txn 393)
 *                            then recurring_payment_failed (webhook 512, error 69
 *                            "Duplicate invoice number"). DIME later flagged the txn
 *                            as Refunded / credit-rejected — money never left bank.
 *
 *     2026-05-05 18:09 UTC   ACH_PAYMENT_RETURNED ($290.11)
 *                            Second attempt (DIME's recurring scheduler retried) went
 *                            into the ACH network and was returned by Makala's bank.
 *                            DIME never sent us a webhook for this attempt or for
 *                            its return.
 *
 *   Net result: the original $290.11 charge NEVER successfully landed. Our DB
 *   incorrectly shows it Completed, and Invoice EB996523 (INV-202604-1305) is
 *   incorrectly Paid 402.42 / 402.42 — should be 112.31 / 402.42 (Partial).
 *
 * What this script does (single transaction)
 * ------------------------------------------
 *   1. Flip Payment 8AF42BE0 (the bogus "success") to Status='Failed' and
 *      annotate ACHReturnCode/Reason from DIME dashboard.
 *   2. Insert an ACH_Return ledger row (negative amount) linked to 8AF42BE0
 *      via OriginalPaymentId so the audit trail matches what the new bounce
 *      handler would have written if DIME's webhook had reached us.
 *   3. Recompute Invoice EB996523:
 *        PaidAmount: 402.42 → 112.31
 *        Status:     Paid   → Partial   (recalcStatusFromAmounts logic)
 *        PaymentReceivedDate: cleared (no longer fully paid)
 *   4. Void phantom Payment B387A839 (the same-second "Duplicate invoice number"
 *      twin), since it's noise and we already represent the failure on 8AF42BE0.
 *
 *   Default mode is DryRun (preview only). Set @DryRun = 0 to apply.
 **********************************************************************************/

DECLARE @DryRun BIT = 1;  -- set to 0 to actually apply the writes

DECLARE @SuccessPaymentId       UNIQUEIDENTIFIER = '8AF42BE0-5BE4-449E-83C9-7A3E84A40554'; -- bogus "success" $290.11
DECLARE @PhantomFailedPaymentId UNIQUEIDENTIFIER = 'B387A839-DE00-496D-950B-440E28CD7353'; -- same-second dup-block twin
DECLARE @InvoiceId              UNIQUEIDENTIFIER = 'EB996523-929C-416C-B7C8-5F082B990EFE'; -- INV-202604-1305
DECLARE @BounceAmount           DECIMAL(10,2)    = 290.11;

DECLARE @TotalAmount  DECIMAL(12,2);
DECLARE @PaidAmount   DECIMAL(12,2);
DECLARE @CreditAmount DECIMAL(12,2);
DECLARE @NewPaid      DECIMAL(12,2);
DECLARE @NewStatus    NVARCHAR(50);

SELECT @TotalAmount  = TotalAmount,
       @PaidAmount   = PaidAmount,
       @CreditAmount = ISNULL(CreditAmount, 0)
FROM oe.Invoices
WHERE InvoiceId = @InvoiceId;

SET @NewPaid = CASE WHEN @PaidAmount - @BounceAmount < 0 THEN 0 ELSE @PaidAmount - @BounceAmount END;
SET @NewStatus = CASE
                    WHEN (@NewPaid + @CreditAmount) >= (@TotalAmount - 0.005) THEN N'Paid'
                    WHEN (@NewPaid + @CreditAmount) >  0.005                  THEN N'Partial'
                    ELSE                                                            N'Unpaid'
                 END;

PRINT '=== Pre-state: bogus "success" $290.11 row ===';
SELECT PaymentId, Amount, Status, ProcessorTransactionId, InvoiceId,
       RecurringScheduleId, WebhookEventId, ACHReturnCode, ACHReturnReason,
       FailureReason, ModifiedDate
FROM oe.Payments
WHERE PaymentId = @SuccessPaymentId;

PRINT '=== Pre-state: phantom Failed twin row ===';
SELECT PaymentId, Amount, Status, FailureReason, ProcessorTransactionId,
       OriginalPaymentId, WebhookEventId, ModifiedDate
FROM oe.Payments
WHERE PaymentId = @PhantomFailedPaymentId;

PRINT '=== Pre-state: invoice (currently Paid 402.42) ===';
SELECT InvoiceId, InvoiceNumber, TotalAmount, PaidAmount, CreditAmount, Status, PaymentReceivedDate
FROM oe.Invoices
WHERE InvoiceId = @InvoiceId;

PRINT '=== Computed new invoice state ===';
SELECT @TotalAmount AS TotalAmount,
       @PaidAmount  AS OldPaidAmount,
       @NewPaid     AS NewPaidAmount,
       @NewStatus   AS NewStatus,
       @BounceAmount AS BounceAmount;

IF @DryRun = 1
BEGIN
    PRINT '@DryRun = 1 — no writes performed. Re-run with @DryRun = 0 to apply.';
END
ELSE
BEGIN
    BEGIN TRY
        BEGIN TRAN;

        -- 1. Flip the bogus success row to Failed
        UPDATE oe.Payments
        SET Status          = N'Failed',
            ACHReturnCode   = COALESCE(ACHReturnCode, N'R01'),
            ACHReturnReason = COALESCE(ACHReturnReason,
                              N'ACH_PAYMENT_RETURNED 2026-05-05 per DIME dashboard. '
                            + N'Original 2026-05-01 submission was ACH_PAYMENT_CREDIT_REJECTED. '
                            + N'No funds settled. Backfilled 2026-05-06 (DIME never delivered '
                            + N'a webhook for the return).'),
            FailureReason   = COALESCE(FailureReason,
                              N'ACH return — DIME dashboard truth (no webhook delivered).'),
            LastFailureDate = GETUTCDATE(),
            ModifiedDate    = GETUTCDATE()
        WHERE PaymentId = @SuccessPaymentId
          AND Status <> N'Failed';

        IF @@ROWCOUNT <> 1
        BEGIN
            ROLLBACK TRAN;
            RAISERROR('Expected to update exactly 1 success row, got 0/many. Rolled back.', 16, 1);
            RETURN;
        END

        -- 2. Insert ACH_Return ledger row linked to original (matches new bounce handler shape)
        INSERT INTO oe.Payments (
            PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor,
            ProcessorTransactionId, PaymentMethod, OriginalPaymentId,
            ACHReturnCode, ACHReturnReason, InvoiceId,
            PaymentDate, GroupId, TenantId, CreatedDate, ModifiedDate
        )
        SELECT NEWID(), p.EnrollmentId, p.HouseholdId, N'ACH_Return', -@BounceAmount, N'Open', N'DIME',
               p.ProcessorTransactionId, N'ACH', p.PaymentId,
               N'R01',
               N'Backfilled 2026-05-06 from DIME dashboard ACH_PAYMENT_RETURNED 2026-05-05.',
               p.InvoiceId,
               GETUTCDATE(), p.GroupId, p.TenantId, GETUTCDATE(), GETUTCDATE()
        FROM oe.Payments p
        WHERE p.PaymentId = @SuccessPaymentId;

        IF @@ROWCOUNT <> 1
        BEGIN
            ROLLBACK TRAN;
            RAISERROR('Failed to insert ACH_Return ledger row. Rolled back.', 16, 1);
            RETURN;
        END

        -- 3. Recompute invoice — back out the $290.11 from PaidAmount, recompute Status
        UPDATE oe.Invoices
        SET PaidAmount          = @NewPaid,
            Status              = @NewStatus,
            PaymentReceivedDate = CASE WHEN @NewStatus <> N'Paid' THEN NULL ELSE PaymentReceivedDate END,
            ModifiedDate        = GETUTCDATE()
        WHERE InvoiceId = @InvoiceId;

        IF @@ROWCOUNT <> 1
        BEGIN
            ROLLBACK TRAN;
            RAISERROR('Expected to update exactly 1 invoice, got 0/many. Rolled back.', 16, 1);
            RETURN;
        END

        -- 4. Void the phantom dup-block twin row
        UPDATE oe.Payments
        SET Status        = N'Voided',
            FailureReason = N'[Voided 2026-05-06] DIME recurring duplicate-submission twin '
                          + N'of PaymentId 8AF42BE0… (which is the canonical bounce row, '
                          + N'flipped Failed in same script). Original FailureReason: '
                          + ISNULL(FailureReason, N'(null)'),
            ModifiedDate  = GETUTCDATE()
        WHERE PaymentId = @PhantomFailedPaymentId
          AND Status = N'Failed';

        COMMIT TRAN;
        PRINT 'Retro-fix applied successfully.';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRAN;
        DECLARE @msg NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR('Retro-fix failed: %s', 16, 1, @msg);
    END CATCH;

    PRINT '=== Post-state: success row ===';
    SELECT PaymentId, Amount, Status, ACHReturnCode, ACHReturnReason, FailureReason, ModifiedDate
    FROM oe.Payments WHERE PaymentId = @SuccessPaymentId;

    PRINT '=== Post-state: ACH_Return ledger rows for this original ===';
    SELECT PaymentId, Amount, Status, TransactionType, OriginalPaymentId, ACHReturnCode, ACHReturnReason, CreatedDate
    FROM oe.Payments WHERE OriginalPaymentId = @SuccessPaymentId AND TransactionType = N'ACH_Return';

    PRINT '=== Post-state: invoice ===';
    SELECT InvoiceId, InvoiceNumber, TotalAmount, PaidAmount, CreditAmount, Status, PaymentReceivedDate
    FROM oe.Invoices WHERE InvoiceId = @InvoiceId;

    PRINT '=== Post-state: phantom twin row ===';
    SELECT PaymentId, Amount, Status, FailureReason, ModifiedDate
    FROM oe.Payments WHERE PaymentId = @PhantomFailedPaymentId;
END;
