-- Migration: MightyWELL ledger-reconcile corrections — Makala Beckner & Paul Yurt
-- Date: 2026-06-04
-- Tenant: 1CD92AF7-B6F2-4E48-A8F3-EC6316158826 (MightyWELL Health)
--
-- Source: weekly DIME full-ledger reconcile (dimeLedgerReconcile.service) dry-run.
-- Each finding was confirmed by hand against the DIME customer ledger + our invoices.
--
-- (1) Makala Beckner — hh 4A47938F-9D9B-46C6-B002-506930510D3B
--     May invoice EB996523 ($402.42) is Paid in our books via txn #393 ($290.11) + #401
--     ($112.31). DIME shows #393 BOUNCED (CREDIT_REJECTED 05-01 → RETURNED 05-05, R01) and
--     the retry #453 ($290.11) SETTLED 05-07. The #393 row is even already annotated with the
--     return (ACHReturnCode R01, "No funds settled") but was left Status=Completed.
--     Fix: REPOINT the existing #393 row to the settled retry txn #453 and clear the bogus
--     return metadata. Row stays Completed; invoice PaidAmount stays $402.42 / Paid. No money
--     moves — this only corrects which DIME txn the (real, settled) payment is attributed to.
--
-- (2) Paul Yurt — hh 04F4C52C-D3ED-4B22-8DD8-1CFAD94D37FF
--     DIME settled BOTH #465 ($327.95 ACH, 05-11) and #832843194 ($327.95 Card, 05-26) in May.
--     The recurring ACH #465 settled but was never recorded; the May invoice was then cleared by
--     the card payment. The orphaned ACH #465 is real money we hold, and his June invoice
--     E92635F6 is Unpaid. Per decision: record #465 as a Completed payment applied to the June
--     invoice (makes him whole, clears the false-unpaid). Commission/product fields are cloned
--     from his April recurring payment (#1965425821) so agent payouts stay consistent for this
--     genuinely-settled month.
--
-- NOTE: Darcey Barry (#462) is intentionally NOT in this migration — she is entangled with the
--       June duplicate-charge ($823 x2) and a May $799-vs-$823 mismatch; handled separately.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @Tenant UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';

-- Makala
DECLARE @MakalaHH UNIQUEIDENTIFIER = '4A47938F-9D9B-46C6-B002-506930510D3B';
DECLARE @MakalaInvoice UNIQUEIDENTIFIER = 'EB996523-929C-416C-B7C8-5F082B990EFE';

-- Paul
DECLARE @PaulHH UNIQUEIDENTIFIER = '04F4C52C-D3ED-4B22-8DD8-1CFAD94D37FF';
DECLARE @PaulJuneInvoice UNIQUEIDENTIFIER = 'E92635F6-C478-4D51-A128-27BBEC75CCDF';

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN — no changes committed' AS [Status];

        SELECT '--- Makala: current #393 row (will repoint to #453, clear return meta) ---' AS [Step];
        SELECT ProcessorTransactionId, Status, Amount, PaymentDate, ACHReturnCode, FailureReason, InvoiceId
        FROM oe.Payments
        WHERE TenantId = @Tenant AND HouseholdId = @MakalaHH AND ProcessorTransactionId = '393';

        SELECT '--- Makala: invoice EB996523 (expect unchanged: Paid $402.42) ---' AS [Step];
        SELECT InvoiceNumber, Status, TotalAmount, PaidAmount, BalanceDue
        FROM oe.Invoices WHERE InvoiceId = @MakalaInvoice;

        SELECT '--- Paul: confirm #465 absent (expect 0 rows) ---' AS [Step];
        SELECT ProcessorTransactionId, Status FROM oe.Payments
        WHERE TenantId = @Tenant AND ProcessorTransactionId = '465';

        SELECT '--- Paul: June invoice E92635F6 (will become Paid $327.95) ---' AS [Step];
        SELECT InvoiceNumber, Status, TotalAmount, PaidAmount, BalanceDue
        FROM oe.Invoices WHERE InvoiceId = @PaulJuneInvoice;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    -- ───────────────────────── (1) Makala: repoint #393 → #453 ─────────────────────────
    UPDATE oe.Payments
    SET ProcessorTransactionId = '453',
        Status = 'Completed',          -- already Completed; assert it
        PaymentDate = '2026-05-07T00:00:00.000Z',  -- DIME settle date of the retry
        ACHReturnCode = NULL,
        ACHReturnReason = NULL,
        FailureReason = NULL,
        LastFailureDate = NULL,
        ConsecutiveFailureCount = NULL,
        ModifiedDate = GETUTCDATE()
    WHERE TenantId = @Tenant
      AND HouseholdId = @MakalaHH
      AND ProcessorTransactionId = '393'
      AND Status = 'Completed';

    IF @@ROWCOUNT <> 1
    BEGIN
        ;THROW 50001, 'Makala: expected exactly 1 #393 Completed row to repoint', 1;
    END

    -- ───────────────────────── (2) Paul: record #465 → June invoice ─────────────────────
    INSERT INTO oe.Payments (
        PaymentId, Amount, Status, PaymentMethod, ProcessorTransactionId, PaymentDate,
        CreatedDate, ModifiedDate, HouseholdId, TransactionType, Processor, TenantId, InvoiceId,
        AgentId, RecurringScheduleId,
        CommissionAmount, CommissionPaid, OverrideAmount, OverridePaid,
        VendorCommissionPaid, VendorCommissionAmount, NetRate, SystemFees, OverrideRate,
        Commission, ProcessingFeeAmount,
        ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts
    )
    SELECT
        NEWID(), 327.95, 'Completed', 'ACH', '465', '2026-05-11T00:00:00.000Z',
        GETUTCDATE(), GETUTCDATE(), @PaulHH, 'Payment', 'DIME', @Tenant, @PaulJuneInvoice,
        AgentId, RecurringScheduleId,
        CommissionAmount, CommissionPaid, OverrideAmount, OverridePaid,
        VendorCommissionPaid, VendorCommissionAmount, NetRate, SystemFees, OverrideRate,
        Commission, ProcessingFeeAmount,
        ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts
    FROM oe.Payments
    WHERE TenantId = @Tenant AND ProcessorTransactionId = '1965425821';  -- clone April recurring

    IF @@ROWCOUNT <> 1
    BEGIN
        ;THROW 50002, 'Paul: expected exactly 1 cloned row inserted for #465', 1;
    END

    UPDATE oe.Invoices
    SET PaidAmount = 327.95,
        Status = N'Paid',
        ModifiedDate = GETUTCDATE()
    WHERE InvoiceId = @PaulJuneInvoice
      AND Status = N'Unpaid';

    IF @@ROWCOUNT <> 1
    BEGIN
        ;THROW 50003, 'Paul: expected exactly 1 Unpaid June invoice to mark Paid', 1;
    END

    -- ───────────────────────── Verify ─────────────────────────
    SELECT 'Makala #393→#453 (Completed, no return meta)' AS [Check], ProcessorTransactionId, Status, PaymentDate, ACHReturnCode, FailureReason
    FROM oe.Payments WHERE TenantId = @Tenant AND HouseholdId = @MakalaHH AND ProcessorTransactionId = '453';

    SELECT 'Makala invoice (expect Paid $402.42)' AS [Check], InvoiceNumber, Status, TotalAmount, PaidAmount, BalanceDue
    FROM oe.Invoices WHERE InvoiceId = @MakalaInvoice;

    SELECT 'Paul #465 (expect Completed $327.95 → June)' AS [Check], ProcessorTransactionId, Status, Amount, InvoiceId
    FROM oe.Payments WHERE TenantId = @Tenant AND ProcessorTransactionId = '465';

    SELECT 'Paul June invoice (expect Paid)' AS [Check], InvoiceNumber, Status, TotalAmount, PaidAmount, BalanceDue
    FROM oe.Invoices WHERE InvoiceId = @PaulJuneInvoice;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
