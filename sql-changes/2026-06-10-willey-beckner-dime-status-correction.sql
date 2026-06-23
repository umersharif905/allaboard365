-- Migration: Willey + Beckner — payment statuses out of sync with DIME (2-month audit, CORRECTED)
-- Date: 2026-06-10 (rev 2 — after full DIME customer-ledger sweep)
-- Author: Jeremy Francis
--
-- WHY REV 2: the single-transaction DIME lookup is blind to post-settlement returns —
-- a returned ACH still reports ACH_PAYMENT_CREDIT on the original txn, with the return
-- showing only as separate ledger lines under the same transaction_number. A tenant-wide
-- customer-ledger sweep (Apr 1 – Jun 10) found exactly ONE settled-then-returned txn:
-- Willey #498. It also surfaced a settled DIME payment we have NO row for: Beckner #453.
-- The DIME dashboard was right: Willey has 0 successful payments, Beckner has 3.
--
-- CASE 1 — Annette Willey (household 4B8F6953-A476-4333-B0D3-053C425D2853)
--   DIME ledger truth: EVERY attempt bounced. $0.00 ever stayed settled.
--     3/31 CC declined; 5/1 #340, 5/9 #461, 5/17 #485 rejected+returned;
--     5/24 #498 settled 5/25 then RETURNED 6/1 (+$25 fee); 6/3 #711 rejected, returned 6/9.
--   DB today: #711 = Completed funding May invoice INV-202605-1339 (Paid). Both wrong.
--   FIX: #711 → Failed; #498 stays Failed (FailureReason updated to record the 6/1 return);
--        May invoice → Unpaid, PaidAmount 0. Willey truly owes Apr + May + Jun = $2,138.76.
--
-- CASE 2 — Makala Beckner (household 4A47938F-9D9B-46C6-B002-506930510D3B)
--   DIME ledger truth: 3 settled payments — #401 $112.31 (5/1), #453 $290.11 (settled 5/7,
--   verified ACH_PAYMENT_CREDIT, info_id 1279405357), #765 $290.11 (6/7). #393 bounced 5/5.
--   DB today: #393 = Completed on April invoice; #453 has NO oe.Payments row at all
--   (no webhook delivered). April invoice Paid $402.42 — NET-CORRECT ($112.31 + $290.11),
--   and its PaymentReceivedDate (2026-05-07) already matches #453's settle date.
--   FIX: #393 → Failed; INSERT the missing #453 row (cloned from #393's pricing/commission
--   fields so payout math carries over) linked to the April invoice. Invoice untouched.
--   Member's balance does not change — this is ledger bookkeeping only.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @Now DATETIME2 = GETUTCDATE();

-- Willey
DECLARE @WilleyHouseholdId UNIQUEIDENTIFIER = '4B8F6953-A476-4333-B0D3-053C425D2853';
DECLARE @WilleyMayInvoiceId UNIQUEIDENTIFIER = 'B2933DCC-89BD-4A7B-A9D4-9F03320E4881';  -- INV-202605-1339
DECLARE @WilleyReturnedPaymentId UNIQUEIDENTIFIER = 'F4317F1D-4743-4AFD-A497-AF666C0F32E6'; -- txn 498 (settled 5/25, RETURNED 6/1)
DECLARE @WilleyBouncedPaymentId UNIQUEIDENTIFIER = 'C15C6B0E-6AA3-4D34-98EE-A9BB04355420'; -- txn 711 (rejected, returned 6/9)

-- Beckner
DECLARE @BecknerHouseholdId UNIQUEIDENTIFIER = '4A47938F-9D9B-46C6-B002-506930510D3B';
DECLARE @BecknerAprilInvoiceId UNIQUEIDENTIFIER = 'EB996523-929C-416C-B7C8-5F082B990EFE'; -- INV-202604-1305
DECLARE @BecknerBouncedPaymentId UNIQUEIDENTIFIER = '8AF42BE0-5BE4-449E-83C9-7A3E84A40554'; -- txn 393 (rejected, returned 5/5)
DECLARE @BecknerNewPaymentId UNIQUEIDENTIFIER = NEWID();                                   -- new row for txn 453

BEGIN TRY
    BEGIN TRANSACTION;

    ------------------------------------------------------------------
    -- Preview: both households' payments + invoices with planned actions
    ------------------------------------------------------------------
    SELECT
        CASE WHEN p.HouseholdId = @WilleyHouseholdId THEN N'Willey' ELSE N'Beckner' END AS Who,
        CONVERT(VARCHAR(19), p.PaymentDate, 120) AS PayDate,
        p.Amount,
        p.Status AS CurrentStatus,
        CAST(p.ProcessorTransactionId AS NVARCHAR(40)) AS Txn,
        i.InvoiceNumber AS LinkedInvoice,
        CASE
            WHEN p.PaymentId = @WilleyBouncedPaymentId  THEN N'FLIP → Failed (DIME rejected; returned 6/9)'
            WHEN p.PaymentId = @WilleyReturnedPaymentId THEN N'KEEP Failed; FailureReason → settled 5/25 then RETURNED 6/1'
            WHEN p.PaymentId = @BecknerBouncedPaymentId THEN N'FLIP → Failed (DIME rejected; returned 5/5)'
            ELSE N'—'
        END AS PlannedAction
    FROM oe.Payments p
    LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.HouseholdId IN (@WilleyHouseholdId, @BecknerHouseholdId)
    ORDER BY Who, p.PaymentDate;

    SELECT
        CASE WHEN i.HouseholdId = @WilleyHouseholdId THEN N'Willey' ELSE N'Beckner' END AS Who,
        i.InvoiceNumber,
        i.Status AS CurrentStatus,
        i.TotalAmount,
        i.PaidAmount,
        COALESCE(i.CreditAmount, 0) AS CreditAmount,
        CASE
            WHEN i.InvoiceId = @WilleyMayInvoiceId    THEN N'UNWIND: Paid → Unpaid, PaidAmount 712.92 → 0 (funds returned 6/1)'
            WHEN i.InvoiceId = @BecknerAprilInvoiceId THEN N'KEEP Paid $402.42 (correct: #401 $112.31 + #453 $290.11); INSERT missing #453 row'
            ELSE N'—'
        END AS PlannedAction
    FROM oe.Invoices i
    WHERE i.HouseholdId IN (@WilleyHouseholdId, @BecknerHouseholdId)
    ORDER BY Who, i.BillingPeriodStart;

    ------------------------------------------------------------------
    -- Safety: abort if data no longer matches the audited shape
    ------------------------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM oe.Payments
        WHERE PaymentId = @WilleyBouncedPaymentId AND HouseholdId = @WilleyHouseholdId
          AND Status = N'Completed' AND InvoiceId = @WilleyMayInvoiceId AND ABS(Amount - 712.92) < 0.01
    )
        RAISERROR('Willey txn 711 (C15C6B0E) not in expected Completed/linked state — aborting.', 16, 1);

    IF NOT EXISTS (
        SELECT 1 FROM oe.Payments
        WHERE PaymentId = @WilleyReturnedPaymentId AND HouseholdId = @WilleyHouseholdId
          AND Status = N'Failed' AND ABS(Amount - 712.92) < 0.01
    )
        RAISERROR('Willey txn 498 (F4317F1D) not in expected Failed state — aborting.', 16, 1);

    IF NOT EXISTS (
        SELECT 1 FROM oe.Invoices
        WHERE InvoiceId = @WilleyMayInvoiceId AND HouseholdId = @WilleyHouseholdId
          AND Status = N'Paid' AND ABS(TotalAmount - 712.92) < 0.01 AND ABS(PaidAmount - 712.92) < 0.01
    )
        RAISERROR('Willey May invoice (INV-202605-1339) not in expected Paid state — aborting.', 16, 1);

    IF NOT EXISTS (
        SELECT 1 FROM oe.Payments
        WHERE PaymentId = @BecknerBouncedPaymentId AND HouseholdId = @BecknerHouseholdId
          AND Status = N'Completed' AND InvoiceId = @BecknerAprilInvoiceId AND ABS(Amount - 290.11) < 0.01
    )
        RAISERROR('Beckner txn 393 (8AF42BE0) not in expected Completed/linked state — aborting.', 16, 1);

    IF NOT EXISTS (
        SELECT 1 FROM oe.Invoices
        WHERE InvoiceId = @BecknerAprilInvoiceId AND HouseholdId = @BecknerHouseholdId
          AND Status = N'Paid' AND ABS(TotalAmount - 402.42) < 0.01 AND ABS(PaidAmount - 402.42) < 0.01
    )
        RAISERROR('Beckner April invoice (INV-202604-1305) not in expected Paid state — aborting.', 16, 1);

    IF EXISTS (
        SELECT 1 FROM oe.Payments
        WHERE HouseholdId = @BecknerHouseholdId
          AND CAST(ProcessorTransactionId AS NVARCHAR(40)) = N'453'
    )
        RAISERROR('Beckner txn 453 already has a payment row — aborting (would duplicate).', 16, 1);

    IF @DryRun = 1
    BEGIN
        PRINT 'DRY RUN — no changes. Willey: txn 711 → Failed, May invoice → Unpaid $0 (all 5 ACH attempts bounced, #498 returned 6/1). Beckner: txn 393 → Failed, INSERT missing settled txn 453 ($290.11), April invoice stays Paid. Set @DryRun = 0 to apply.';
        ROLLBACK TRANSACTION;
        RETURN;
    END

    ------------------------------------------------------------------
    -- CASE 1a — Willey txn 711: Completed → Failed (stays linked as failed attempt)
    ------------------------------------------------------------------
    UPDATE oe.Payments
    SET Status = N'Failed',
        FailureReason = N'ACH_PAYMENT_CREDIT_REJECTED per DIME ledger (rejected 6/3, principal returned 6/9 + $25 fee). Status corrected 2026-06-10 by DIME customer-ledger reconcile.',
        LastFailureDate = @Now,
        ModifiedDate = @Now
    WHERE PaymentId = @WilleyBouncedPaymentId;

    PRINT CONCAT('Willey txn 711 → Failed: ', @@ROWCOUNT, ' row(s)');

    ------------------------------------------------------------------
    -- CASE 1b — Willey txn 498: stays Failed; record the settled-then-returned truth
    ------------------------------------------------------------------
    UPDATE oe.Payments
    SET FailureReason = N'Settled at DIME 2026-05-25 then ACH_PAYMENT_RETURNED 2026-06-01 (+$25 reject fee) — funds clawed back, net $0. Documented 2026-06-10 by DIME customer-ledger reconcile.',
        LastFailureDate = COALESCE(LastFailureDate, @Now),
        ModifiedDate = @Now
    WHERE PaymentId = @WilleyReturnedPaymentId;

    PRINT CONCAT('Willey txn 498 FailureReason documented (stays Failed): ', @@ROWCOUNT, ' row(s)');

    ------------------------------------------------------------------
    -- CASE 1c — Willey May invoice: Paid → Unpaid (no settled funds exist)
    ------------------------------------------------------------------
    UPDATE oe.Invoices
    SET PaidAmount = 0,
        Status = N'Unpaid',
        PaymentReceivedDate = NULL,
        ModifiedDate = @Now
    WHERE InvoiceId = @WilleyMayInvoiceId;

    PRINT CONCAT('Willey May invoice → Unpaid, PaidAmount 0 ($712.92 balance restored): ', @@ROWCOUNT, ' row(s)');

    ------------------------------------------------------------------
    -- CASE 2a — Beckner txn 393: Completed → Failed
    ------------------------------------------------------------------
    UPDATE oe.Payments
    SET Status = N'Failed',
        FailureReason = N'ACH_PAYMENT_CREDIT_REJECTED per DIME ledger (rejected 5/1, principal returned 5/5 + $25 fee). Retry txn 453 settled 5/7 — see inserted row. Status corrected 2026-06-10 by DIME customer-ledger reconcile.',
        LastFailureDate = @Now,
        ModifiedDate = @Now
    WHERE PaymentId = @BecknerBouncedPaymentId;

    PRINT CONCAT('Beckner txn 393 → Failed: ', @@ROWCOUNT, ' row(s)');

    ------------------------------------------------------------------
    -- CASE 2b — Beckner txn 453: INSERT the missing settled payment (no webhook ever arrived).
    -- Clone pricing/commission fields from the bounced twin #393 (same $290.11 schedule) so
    -- payout math carries over; CommissionPaid flags copied as-is to avoid double payout.
    ------------------------------------------------------------------
    INSERT INTO oe.Payments (
        PaymentId, TenantId, HouseholdId, GroupId, InvoiceId, EnrollmentId,
        Amount, Status, PaymentMethod, TransactionType, Processor,
        ProcessorTransactionId, ProcessorTransactionInfoId,
        PaymentDate, RecurringScheduleId, AttemptNumber,
        AgentId, LocationId,
        NetRate, SystemFees, OverrideRate, Commission, ProcessingFeeAmount, SetupFee,
        ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
        CommissionAmount, CommissionPaid, OverrideAmount, OverridePaid,
        VendorCommissionAmount, VendorCommissionPaid,
        CreatedDate, ModifiedDate, CreatedBy
    )
    SELECT
        @BecknerNewPaymentId, p.TenantId, p.HouseholdId, p.GroupId, @BecknerAprilInvoiceId, p.EnrollmentId,
        290.11, N'Completed', p.PaymentMethod, N'Payment', p.Processor,
        N'453', N'1279405357',
        '2026-05-07T14:43:08', p.RecurringScheduleId, COALESCE(p.AttemptNumber, 1) + 1,
        p.AgentId, p.LocationId,
        p.NetRate, p.SystemFees, p.OverrideRate, p.Commission, p.ProcessingFeeAmount, p.SetupFee,
        p.ProductCommissions, p.ProductVendorAmounts, p.ProductOwnerAmounts,
        p.CommissionAmount, p.CommissionPaid, p.OverrideAmount, p.OverridePaid,
        p.VendorCommissionAmount, p.VendorCommissionPaid,
        @Now, @Now, p.CreatedBy
    FROM oe.Payments p
    WHERE p.PaymentId = @BecknerBouncedPaymentId;

    PRINT CONCAT('Beckner txn 453 inserted (Completed $290.11, linked INV-202604-1305): ', @@ROWCOUNT, ' row(s)');

    ------------------------------------------------------------------
    -- Post-change verification
    ------------------------------------------------------------------
    SELECT
        CASE WHEN p.HouseholdId = @WilleyHouseholdId THEN N'Willey' ELSE N'Beckner' END AS Who,
        CAST(p.ProcessorTransactionId AS NVARCHAR(40)) AS Txn,
        p.Status AS NewStatus,
        p.Amount,
        i.InvoiceNumber, i.Status AS InvStatus, i.PaidAmount, i.BalanceDue
    FROM oe.Payments p
    LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.PaymentId IN (@WilleyBouncedPaymentId, @WilleyReturnedPaymentId, @BecknerBouncedPaymentId, @BecknerNewPaymentId);

    COMMIT TRANSACTION;
    PRINT 'Committed. Willey: 0 settled payments, owes Apr+May+Jun. Beckner: 3 settled payments, balances unchanged.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
