-- Migration: Paul Yurt — insert missing settled DIME payment #465 and apply it to his June invoice
-- Date: 2026-06-10
-- Author: Jeremy Francis
--
-- SOURCE: DIME → DB ledger audit (customer 76ba1aab-8178-4ac6-ab99-7d45fefc6526).
-- DIME txn 465: $327.95 ACH, settled 2026-05-11 (info_id 1280812912) — his May recurring draft.
-- The webhook never arrived, so no oe.Payments row exists. He was then ALSO charged $327.95
-- by card on 5/26 (txn 832843194) for the same May invoice INV-202604-1209 → double-paid May.
--
-- RESOLUTION (credit forward): insert the #465 row as Completed and apply it to his open
-- June invoice INV-202606-1587 ($327.95, Unpaid) — squares him exactly with no refund needed.
-- (Alternative considered: refund $327.95 at DIME; rejected since June is open for the same amount.)
--
-- Pricing/commission fields are cloned from his 4/11 recurring payment (0D4205CD, txn 1965425821,
-- same $327.95 schedule #835). CommissionPaid flags cloned as-is to avoid double payout.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @Now DATETIME2 = GETUTCDATE();

DECLARE @YurtHouseholdId UNIQUEIDENTIFIER = '04F4C52C-D3ED-4B22-8DD8-1CFAD94D37FF';
DECLARE @YurtJuneInvoiceId UNIQUEIDENTIFIER = 'E92635F6-C478-4D51-A128-27BBEC75CCDF';   -- INV-202606-1587
DECLARE @YurtTemplatePaymentId UNIQUEIDENTIFIER = '0D4205CD-519F-4CE0-8C1B-DC8F1A3DA425'; -- 4/11 recurring, txn 1965425821
DECLARE @YurtNewPaymentId UNIQUEIDENTIFIER = NEWID();

BEGIN TRY
    BEGIN TRANSACTION;

    ------------------------------------------------------------------
    -- Preview
    ------------------------------------------------------------------
    SELECT
        CONVERT(VARCHAR(19), p.PaymentDate, 120) AS PayDate,
        p.Amount, p.Status, p.PaymentMethod,
        CAST(p.ProcessorTransactionId AS NVARCHAR(40)) AS Txn,
        i.InvoiceNumber AS LinkedInvoice,
        CASE WHEN p.PaymentId = @YurtTemplatePaymentId THEN N'TEMPLATE for new #465 row' ELSE N'—' END AS Note
    FROM oe.Payments p
    LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.HouseholdId = @YurtHouseholdId
    ORDER BY p.PaymentDate;

    SELECT i.InvoiceNumber, i.Status, i.TotalAmount, i.PaidAmount, COALESCE(i.CreditAmount, 0) AS CreditAmount,
        CASE WHEN i.InvoiceId = @YurtJuneInvoiceId
             THEN N'PAY via inserted #465: PaidAmount → 327.95, Status → Paid, PaymentReceivedDate → 2026-05-11'
             ELSE N'—' END AS PlannedAction
    FROM oe.Invoices i
    WHERE i.HouseholdId = @YurtHouseholdId
    ORDER BY i.BillingPeriodStart;

    ------------------------------------------------------------------
    -- Safety: abort if data no longer matches the audited shape
    ------------------------------------------------------------------
    IF EXISTS (
        SELECT 1 FROM oe.Payments
        WHERE HouseholdId = @YurtHouseholdId
          AND CAST(ProcessorTransactionId AS NVARCHAR(40)) = N'465'
    )
        RAISERROR('Yurt txn 465 already has a payment row — aborting (would duplicate).', 16, 1);

    IF NOT EXISTS (
        SELECT 1 FROM oe.Payments
        WHERE PaymentId = @YurtTemplatePaymentId AND HouseholdId = @YurtHouseholdId
          AND Status = N'Completed' AND ABS(Amount - 327.95) < 0.01
    )
        RAISERROR('Yurt template payment (0D4205CD) not in expected state — aborting.', 16, 1);

    IF NOT EXISTS (
        SELECT 1 FROM oe.Invoices
        WHERE InvoiceId = @YurtJuneInvoiceId AND HouseholdId = @YurtHouseholdId
          AND Status = N'Unpaid' AND ABS(TotalAmount - 327.95) < 0.01 AND PaidAmount = 0
    )
        RAISERROR('Yurt June invoice (INV-202606-1587) not in expected Unpaid state — aborting.', 16, 1);

    IF @DryRun = 1
    BEGIN
        PRINT 'DRY RUN — no changes. Would insert settled DIME txn 465 ($327.95, 2026-05-11) as Completed and mark June invoice INV-202606-1587 Paid (credit-forward for the May double-charge). Set @DryRun = 0 to apply.';
        ROLLBACK TRANSACTION;
        RETURN;
    END

    ------------------------------------------------------------------
    -- 1 — Insert the missing #465 payment, linked to the June invoice
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
        @YurtNewPaymentId, p.TenantId, p.HouseholdId, p.GroupId, @YurtJuneInvoiceId, p.EnrollmentId,
        327.95, N'Completed', p.PaymentMethod, N'Payment', p.Processor,
        N'465', N'1280812912',
        '2026-05-11T15:09:56', p.RecurringScheduleId, 1,
        p.AgentId, p.LocationId,
        p.NetRate, p.SystemFees, p.OverrideRate, p.Commission, p.ProcessingFeeAmount, p.SetupFee,
        p.ProductCommissions, p.ProductVendorAmounts, p.ProductOwnerAmounts,
        p.CommissionAmount, p.CommissionPaid, p.OverrideAmount, p.OverridePaid,
        p.VendorCommissionAmount, p.VendorCommissionPaid,
        @Now, @Now, p.CreatedBy
    FROM oe.Payments p
    WHERE p.PaymentId = @YurtTemplatePaymentId;

    PRINT CONCAT('Yurt txn 465 inserted (Completed $327.95 → INV-202606-1587): ', @@ROWCOUNT, ' row(s)');

    ------------------------------------------------------------------
    -- 2 — June invoice: Unpaid → Paid via the settled May overpayment
    ------------------------------------------------------------------
    UPDATE oe.Invoices
    SET PaidAmount = 327.95,
        Status = N'Paid',
        PaymentReceivedDate = '2026-05-11',
        ModifiedDate = @Now
    WHERE InvoiceId = @YurtJuneInvoiceId;

    PRINT CONCAT('Yurt June invoice → Paid $327.95: ', @@ROWCOUNT, ' row(s)');

    ------------------------------------------------------------------
    -- Post-change verification
    ------------------------------------------------------------------
    SELECT CAST(p.ProcessorTransactionId AS NVARCHAR(40)) AS Txn, p.Status, p.Amount,
        i.InvoiceNumber, i.Status AS InvStatus, i.PaidAmount, i.BalanceDue
    FROM oe.Payments p
    LEFT JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.PaymentId = @YurtNewPaymentId;

    COMMIT TRANSACTION;
    PRINT 'Committed. Yurt: 5 settled payments (Feb/Mar/Apr/May ×2) now cover all 5 invoices Feb–Jun. Net even with DIME.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
