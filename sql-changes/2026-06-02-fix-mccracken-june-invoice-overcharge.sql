-- Migration: Fix INV-202606-1534 overcharge for Michael McCracken (MW15990299)
-- Date: 2026-06-02
-- Root cause: invoice TotalAmount double-counted IncludedPaymentProcessingFeeAmount ($2.70)
-- when PaymentProcessingFee enrollment already stores the full processing fee ($10.84).
-- Member was correctly charged $798.57 via DIME recurring.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Preview of changes:' AS [Status];
        SELECT
            i.InvoiceNumber,
            i.TotalAmount AS CurrentTotal,
            CAST(798.57 AS DECIMAL(12, 2)) AS CorrectTotal,
            i.PaidAmount,
            i.BalanceDue AS CurrentBalanceDue,
            CAST(0 AS DECIMAL(12, 2)) AS CorrectBalanceDue,
            i.Status AS CurrentStatus,
            N'Paid' AS CorrectStatus
        FROM oe.Invoices i
        WHERE i.InvoiceNumber = N'INV-202606-1534'
          AND i.HouseholdId = '594729B7-ABDF-4457-AC8A-81493AC41293';
        ROLLBACK TRANSACTION;
        RETURN;
    END

    UPDATE oe.Invoices
    SET TotalAmount = 798.57,
        SubTotal = 798.57,
        Status = N'Paid',
        ModifiedDate = GETUTCDATE()
    WHERE InvoiceNumber = N'INV-202606-1534'
      AND HouseholdId = '594729B7-ABDF-4457-AC8A-81493AC41293';

    -- BalanceDue is computed (TotalAmount - PaidAmount - CreditAmount); verify after update
    SELECT InvoiceNumber, TotalAmount, PaidAmount, CreditAmount, BalanceDue, Status
    FROM oe.Invoices
    WHERE InvoiceNumber = N'INV-202606-1534';

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
