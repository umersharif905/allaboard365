-- Migration: MightyWELL — Darcey Barry: clean duplicate fee, record real May payment, unwind duplicate charge
-- Date: 2026-06-04
-- Tenant: 1CD92AF7-B6F2-4E48-A8F3-EC6316158826 (MightyWELL Health)
-- Household: 09CEC699-F4D1-4A8F-A629-DF3707B99F13
--
-- TRUE MONTHLY = $799  (base premiums $431 + $344 + standalone PaymentProcessingFee row $24).
--   Confirmed by: (a) frontend util memberContributionTotals.ts — "matches billing (sum
--   PremiumAmount only); IncludedPaymentProcessingFee/IncludedSystemFee ... must not be added
--   on top"; and (b) DIME charged exactly $799 in May (#462).
--
-- ROOT-CAUSE (code, not data): invoiceCalculationService.js computes PaymentProcessingFeeAmount as
--   (standalone PaymentProcessingFee row PremiumAmount) + (sum of product IncludedPaymentProcessingFeeAmount).
--   For Darcey that is $24 (standalone) + $24 ($13+$11 rolled-in) = $48, so BasePremium $775 + $48
--   = $823 — the same $24 fee counted twice. IncludedPaymentProcessingFeeAmount is a legitimate
--   UI/logic allocation and is LEFT UNTOUCHED. The durable calc/data decision is tracked separately;
--   this migration only corrects Darcey's already-charged invoices/payments to her true $799.
--   (NOTE: ~28 households tenant-wide share this exact-duplicate pattern.)
--
-- PAYMENT MESS (DIME ground truth):
--   • May  #462 $799 SETTLED — never recorded in our DB (only a $799 RecurringScheduled placeholder).
--   • Jun  #706 $823 SETTLED  (15:02:38)
--   • Jun  #707 $823 SETTLED  (15:03:40, 1 min later = DUPLICATE)
--   DIME took $2,445; she owes $1,598 (May $799 + June $799); OVERPAID $847 = $823 duplicate
--   (#707) + $24 June over-charge (#706 billed $823 vs correct $799).
--
-- THIS MIGRATION (no money moves in SQL; IncludedPaymentProcessingFeeAmount left untouched):
--   1. Refund/unapply duplicate #707
--   2. Record real May #462 $799 (reuse the $799 placeholder) → May invoice
--   3. May invoice  → $799 Paid by #462
--   4. June invoice → corrected to $799; #706 ($823) leaves $24 OVERPAID (credit) — see refund note
--
-- REFUND (manual at DIME, AFTER this is reviewed):
--   • Refund full $823 duplicate (#707). Then $24 remains over-collected on June (#706) — either
--     refund that $24 too (total $847) or carry it as a $24 credit toward July. June invoice below
--     is set to $799 so the $24 shows as overpaid until you pick.
--   • Correct her DIME recurring from $823 → $799 (our recurring resync will push $799 once the
--     included-fee data is cleaned) so future months bill correctly.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL (and after the $823 DIME refund settles)

DECLARE @Tenant      UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
DECLARE @HH          UNIQUEIDENTIFIER = '09CEC699-F4D1-4A8F-A629-DF3707B99F13';
DECLARE @MayInvoice  UNIQUEIDENTIFIER = '0654D436-B679-4832-A5EC-33FF806511C5';  -- INV-202605-1358
DECLARE @JuneInvoice UNIQUEIDENTIFIER = '7BE2F53D-ED44-4D46-97C5-B510F89E85A8';  -- INV-202606-1480
DECLARE @Placeholder UNIQUEIDENTIFIER = '3629D4D1-A6DD-4A70-B17D-E1F2BB7E1814';  -- $799 RecurringScheduled

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN — no changes committed' AS [Status];

        SELECT '--- Payments now ---' AS [Step];
        SELECT ProcessorTransactionId, Status, Amount, PaymentMethod, InvoiceId, PaymentDate
        FROM oe.Payments WHERE HouseholdId = @HH ORDER BY PaymentDate;

        SELECT '--- Invoices now (both 823/823, both will become 799) ---' AS [Step];
        SELECT InvoiceNumber, Status, TotalAmount, PaidAmount, BalanceDue
        FROM oe.Invoices WHERE HouseholdId = @HH ORDER BY DueDate;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    -- NOTE: IncludedPaymentProcessingFeeAmount on the Product rows is INTENTIONALLY LEFT ALONE —
    -- it is a real allocation field used by UI + logic. The double-count lives in the premium calc
    -- (invoiceCalculationService.js), not in this field. The durable fix is a code/data decision
    -- tracked separately; this migration only corrects Darcey's already-charged invoices/payments.

    -- ─────────────── (1) Refund/unapply the duplicate #707 ───────────────
    UPDATE oe.Payments
    SET Status = 'Refunded',
        InvoiceId = NULL,
        ModifiedDate = GETUTCDATE()
    WHERE TenantId = @Tenant AND HouseholdId = @HH
      AND ProcessorTransactionId = '707' AND Status = 'Completed' AND Amount = 823;

    IF @@ROWCOUNT <> 1
    BEGIN
        ;THROW 50002, 'Darcey: expected exactly 1 Completed $823 #707 row to refund/unapply', 1;
    END

    -- ─────────────── (2) Record real May payment #462 (reuse $799 placeholder) ───────────────
    UPDATE p
    SET p.ProcessorTransactionId = '462',
        p.Status = 'Completed',
        p.PaymentMethod = 'ACH',
        p.Processor = 'DIME',
        p.TransactionType = 'Payment',
        p.InvoiceId = @MayInvoice,
        p.PaymentDate = '2026-05-09T00:00:00.000Z',
        p.CommissionAmount       = src.CommissionAmount,
        p.CommissionPaid         = src.CommissionPaid,
        p.OverrideAmount         = src.OverrideAmount,
        p.OverridePaid           = src.OverridePaid,
        p.VendorCommissionPaid   = src.VendorCommissionPaid,
        p.VendorCommissionAmount = src.VendorCommissionAmount,
        p.NetRate                = src.NetRate,
        p.SystemFees             = src.SystemFees,
        p.OverrideRate           = src.OverrideRate,
        p.Commission             = src.Commission,
        p.ProcessingFeeAmount    = src.ProcessingFeeAmount,
        p.ProductCommissions     = src.ProductCommissions,
        p.ProductVendorAmounts   = src.ProductVendorAmounts,
        p.ProductOwnerAmounts    = src.ProductOwnerAmounts,
        p.ModifiedDate = GETUTCDATE()
    FROM oe.Payments p
    CROSS JOIN (
        SELECT TOP 1 CommissionAmount, CommissionPaid, OverrideAmount, OverridePaid,
               VendorCommissionPaid, VendorCommissionAmount, NetRate, SystemFees, OverrideRate,
               Commission, ProcessingFeeAmount, ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts
        FROM oe.Payments
        WHERE TenantId = @Tenant AND HouseholdId = @HH AND ProcessorTransactionId = '706'
    ) src
    WHERE p.PaymentId = @Placeholder AND p.Status = 'RecurringScheduled' AND p.Amount = 799;

    IF @@ROWCOUNT <> 1
    BEGIN
        ;THROW 50003, 'Darcey: expected exactly 1 $799 RecurringScheduled placeholder to convert to #462', 1;
    END

    -- ─────────────── (3) May invoice → $799 Paid by #462 ───────────────
    UPDATE oe.Invoices
    SET TotalAmount = 799, PaidAmount = 799, Status = N'Paid', ModifiedDate = GETUTCDATE()
    WHERE InvoiceId = @MayInvoice;

    IF @@ROWCOUNT <> 1
    BEGIN
        ;THROW 50004, 'Darcey: expected exactly 1 May invoice to correct to $799', 1;
    END

    -- ─────────────── (4) June invoice → $799 (paid $823 by #706 → $24 overpaid/credit) ───────────────
    -- PaidAmount left at 823 (the real #706 settlement) so BalanceDue shows -$24 until the $24 is
    -- refunded or carried as credit. Status stays Paid.
    UPDATE oe.Invoices
    SET TotalAmount = 799, Status = N'Paid', ModifiedDate = GETUTCDATE()
    WHERE InvoiceId = @JuneInvoice;

    IF @@ROWCOUNT <> 1
    BEGIN
        ;THROW 50005, 'Darcey: expected exactly 1 June invoice to correct to $799', 1;
    END

    -- ─────────────── Verify ───────────────
    SELECT 'Enrollments (IncludedPPF preserved as-is)' AS [Check], EnrollmentType, PremiumAmount, IncludedPaymentProcessingFeeAmount
    FROM oe.Enrollments WHERE HouseholdId = @HH AND Status = 'Active' AND PremiumAmount <> 0 ORDER BY EnrollmentType;

    SELECT 'Payments after' AS [Check], ProcessorTransactionId, Status, Amount, PaymentMethod, InvoiceId, PaymentDate
    FROM oe.Payments WHERE HouseholdId = @HH ORDER BY PaymentDate;

    SELECT 'Invoices after (May 799 Paid by #462; June 799, paid 823 → $24 credit)' AS [Check], InvoiceNumber, Status, TotalAmount, PaidAmount, BalanceDue
    FROM oe.Invoices WHERE HouseholdId = @HH ORDER BY DueDate;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
