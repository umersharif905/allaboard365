/**********************************************************************************
 * OBSOLETE — DO NOT RUN.
 *
 * Cleanup: drop the redundant ACH_Return ledger row created by the previous retro-fix
 * (2026-05-06-makala-beckner-void-phantom-failed-payment.sql).
 *
 * Verified post-deploy: the ACH_Return ledger row `4631D694…` does NOT exist in
 * production. The retro-fix's INSERT step either rolled back silently or never ran;
 * `SELECT COUNT(*) FROM oe.Payments WHERE TransactionType = N'ACH_Return'` returns 0
 * database-wide. Running this cleanup now will RAISERROR + rollback (the @@ROWCOUNT
 * <> 1 guard at line 40) — harmless but pointless.
 *
 * Kept in repo for audit / context only. Status: NO-OP / OBSOLETE 2026-05-06.
 **********************************************************************************/

DECLARE @DryRun BIT = 1;
DECLARE @LedgerPaymentId UNIQUEIDENTIFIER = '4631D694-7FDF-403D-8B94-AE8A14CD160C';
DECLARE @SuccessPaymentId UNIQUEIDENTIFIER = '8AF42BE0-5BE4-449E-83C9-7A3E84A40554';

PRINT '=== Pre-state: ledger row to delete ===';
SELECT PaymentId, Amount, Status, TransactionType, OriginalPaymentId,
       ACHReturnCode, ACHReturnReason, CreatedDate
FROM oe.Payments
WHERE PaymentId = @LedgerPaymentId;

PRINT '=== Pre-state: original (must remain Failed) ===';
SELECT PaymentId, Amount, Status, ACHReturnCode, ACHReturnReason, FailureReason
FROM oe.Payments
WHERE PaymentId = @SuccessPaymentId;

IF @DryRun = 1
BEGIN
    PRINT '@DryRun = 1 — no writes performed.';
END
ELSE
BEGIN
    BEGIN TRY
        BEGIN TRAN;

        DELETE FROM oe.Payments
        WHERE PaymentId = @LedgerPaymentId
          AND TransactionType = N'ACH_Return'
          AND OriginalPaymentId = @SuccessPaymentId;

        IF @@ROWCOUNT <> 1
        BEGIN
            ROLLBACK TRAN;
            RAISERROR('Expected to delete exactly 1 ledger row. Rolled back.', 16, 1);
            RETURN;
        END

        COMMIT TRAN;
        PRINT 'Deleted redundant ACH_Return ledger row.';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRAN;
        DECLARE @msg NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR('Cleanup failed: %s', 16, 1, @msg);
    END CATCH;
END;
