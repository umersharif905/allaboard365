-- Migration: Correct MightyWELL ACH payments overstated as Completed when DIME rejected/returned them
-- Date: 2026-06-03
-- Author: Jeremy Francis
--
-- CONTEXT
--   A DIME-ledger sweep (GET /api/transactions per customer_uuid) found ACH payments marked
--   Status='Completed' in oe.Payments whose DIME transaction is ACH_PAYMENT_CREDIT_REJECTED and
--   later ACH_PAYMENT_RETURNED — i.e. the ACH never settled. These falsely show invoices as Paid.
--   Root cause: the live DIME webhook (DimeWebhookHandler.handleACHPaymentReturn) never flips the
--   original payment to Failed nor un-fulfills the invoice (and mis-routes typeless returns as
--   ach_charge), so a bounce after a brief provisional credit is silently dropped.
--
--   Each flagged payment was VERIFIED against the member's FULL DIME ledger (not a single-txn
--   lookup) to avoid false positives where a later RETRY actually settled:
--     - Annette Willey  #485  $712.92  -> Apr invoice; ledger: every attempt bounced, $0 settled
--     - Aleksandr Shalun #459 $305.15  -> May invoice; ledger: #459 bounced, only #609 (June) settled
--     - Timothy Heinrich #129 $400.91  -> Apr invoice; ledger: bounced, no retry
--     - Timothy Heinrich #318 $400.91  -> May invoice; ledger: bounced, no retry
--     - Timothy Heinrich #493 $400.91  -> Jun invoice; ledger: bounced BUT #511 retry settled
--                                          => flip payment only; invoice STAYS Paid via #511
--     - brandi baldwin   #234 $718.93  -> Apr invoice; ledger: bounced, no retry
--     - Drew/Rhonda Floyd #215 $851.99 -> invoice; ledger: bounced, no retry
--   EXCLUDED: Makala Beckner #393 $290.11 — her May invoice was genuinely PAID by retry #453
--             (a DIME success we never recorded). Leaving her invoice and rows untouched.
--
-- ACTION
--   1. Flip the 7 verified payments Completed -> Failed with an explanatory ACH return reason.
--   2. Recompute every affected invoice's PaidAmount from its REMAINING Completed payments and
--      reset Status via the app's exact rule (recalcStatusFromAmounts): covered>=total -> Paid,
--      >0 -> Partial, else Overdue(if past due)/Unpaid. This self-heals Timothy's June (kept Paid).
--   BalanceDue is a computed column (app fulfill/unfulfill never set it) — not touched here.

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @Now DATETIME2 = GETUTCDATE();

BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @Flips TABLE (PaymentId UNIQUEIDENTIFIER PRIMARY KEY, Who NVARCHAR(60), DimeTxn NVARCHAR(20));
    INSERT INTO @Flips (PaymentId, Who, DimeTxn) VALUES
        ('E34A13DE-31B2-4DCA-B178-B03F6624D1CB', N'Annette Willey',  N'485'),
        ('9F598CED-3EB0-4849-90AA-E03109AFAC73', N'Aleksandr Shalun',N'459'),
        ('FC195FB9-7EE7-423B-ABA5-6A25FD55F8C8', N'Timothy Heinrich',N'129'),
        ('EC940D9D-8A45-4B6F-895B-5735141C575D', N'Timothy Heinrich',N'318'),
        ('B41C33B9-34A8-4012-B192-C37D7865A256', N'Timothy Heinrich',N'493'),
        ('72DD13B8-AFDC-48EA-982C-37C808E06D7C', N'brandi baldwin',  N'234'),
        ('97BE79BD-AB6B-4DD0-8911-C62C904A5968', N'Drew/Rhonda Floyd',N'215');

    -- Guard: only act on rows that are still Completed Payment rows for the expected DIME txn.
    DECLARE @Valid TABLE (PaymentId UNIQUEIDENTIFIER PRIMARY KEY, InvoiceId UNIQUEIDENTIFIER, Amount DECIMAL(18,2));
    INSERT INTO @Valid (PaymentId, InvoiceId, Amount)
    SELECT p.PaymentId, p.InvoiceId, p.Amount
    FROM oe.Payments p
    INNER JOIN @Flips f ON f.PaymentId = p.PaymentId
    WHERE p.Status = 'Completed'
      AND p.TransactionType = 'Payment'
      AND LTRIM(RTRIM(ISNULL(CAST(p.ProcessorTransactionId AS NVARCHAR(40)), N''))) = f.DimeTxn;

    -- Affected invoices (distinct) for recompute after the flip.
    DECLARE @Invoices TABLE (InvoiceId UNIQUEIDENTIFIER PRIMARY KEY);
    INSERT INTO @Invoices (InvoiceId)
    SELECT DISTINCT InvoiceId FROM @Valid WHERE InvoiceId IS NOT NULL;

    ---------------------------------------------------------------------------
    -- DRY-RUN PREVIEW
    ---------------------------------------------------------------------------
    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN — payments that WOULD flip Completed -> Failed' AS [Section];
        SELECT f.Who, f.DimeTxn, p.PaymentId, p.Amount, p.Status AS CurrentStatus,
               CASE WHEN v.PaymentId IS NULL THEN N'SKIP (not Completed / txn mismatch)' ELSE N'Failed' END AS NewStatus,
               CAST(p.InvoiceId AS NVARCHAR(40)) AS InvoiceId
        FROM @Flips f
        INNER JOIN oe.Payments p ON p.PaymentId = f.PaymentId
        LEFT JOIN @Valid v ON v.PaymentId = f.PaymentId
        ORDER BY f.Who, f.DimeTxn;

        SELECT 'DRY RUN — invoices that WOULD recompute' AS [Section];
        SELECT inv.InvoiceNumber, CAST(inv.InvoiceId AS NVARCHAR(40)) AS InvoiceId,
               inv.TotalAmount, inv.PaidAmount AS CurrentPaid, inv.CreditAmount, inv.Status AS CurrentStatus,
               recomputed.NewPaid,
               CASE
                   WHEN (recomputed.NewPaid + ISNULL(inv.CreditAmount,0)) >= inv.TotalAmount - 0.005 THEN N'Paid'
                   WHEN (recomputed.NewPaid + ISNULL(inv.CreditAmount,0)) > 0.005 THEN N'Partial'
                   WHEN inv.DueDate < @Now THEN N'Overdue'
                   ELSE N'Unpaid'
               END AS NewStatus
        FROM @Invoices ai
        INNER JOIN oe.Invoices inv ON inv.InvoiceId = ai.InvoiceId
        CROSS APPLY (
            SELECT ISNULL(SUM(p2.Amount),0) AS NewPaid
            FROM oe.Payments p2
            WHERE p2.InvoiceId = ai.InvoiceId
              AND p2.TransactionType = 'Payment'
              AND p2.Status = 'Completed'
              AND p2.PaymentId NOT IN (SELECT PaymentId FROM @Valid)  -- exclude the rows we're about to fail
        ) recomputed
        ORDER BY inv.InvoiceNumber;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    ---------------------------------------------------------------------------
    -- APPLY
    ---------------------------------------------------------------------------
    UPDATE p
        SET p.Status = 'Failed',
            p.ACHReturnReason = COALESCE(p.ACHReturnReason,
                N'DIME ACH_PAYMENT_CREDIT_REJECTED / ACH_PAYMENT_RETURNED — ACH did not settle (bank returned).'),
            p.FailureReason = COALESCE(p.FailureReason,
                N'Reconciled 2026-06-03 from DIME ledger: ACH rejected/returned, never settled; was incorrectly marked Completed by legacy webhook return-handling gap.'),
            p.LastFailureDate = @Now,
            p.ModifiedDate = @Now
    FROM oe.Payments p
    INNER JOIN @Valid v ON v.PaymentId = p.PaymentId;

    DECLARE @PaymentsFlipped INT = @@ROWCOUNT;

    -- Recompute affected invoices from remaining Completed payments (post-flip).
    UPDATE inv
        SET inv.PaidAmount = r.NewPaid,
            inv.Status = CASE
                WHEN (r.NewPaid + ISNULL(inv.CreditAmount,0)) >= inv.TotalAmount - 0.005 THEN N'Paid'
                WHEN (r.NewPaid + ISNULL(inv.CreditAmount,0)) > 0.005 THEN N'Partial'
                WHEN inv.DueDate < @Now THEN N'Overdue'
                ELSE N'Unpaid'
            END,
            inv.PaymentReceivedDate = CASE
                WHEN (r.NewPaid + ISNULL(inv.CreditAmount,0)) >= inv.TotalAmount - 0.005 THEN inv.PaymentReceivedDate
                ELSE NULL
            END,
            inv.ModifiedDate = @Now
    FROM oe.Invoices inv
    INNER JOIN @Invoices ai ON ai.InvoiceId = inv.InvoiceId
    CROSS APPLY (
        SELECT ISNULL(SUM(p2.Amount),0) AS NewPaid
        FROM oe.Payments p2
        WHERE p2.InvoiceId = ai.InvoiceId
          AND p2.TransactionType = 'Payment'
          AND p2.Status = 'Completed'
    ) r;

    DECLARE @InvoicesRecomputed INT = @@ROWCOUNT;

    COMMIT TRANSACTION;

    SELECT 'Applied' AS [Status], @PaymentsFlipped AS PaymentsFlipped, @InvoicesRecomputed AS InvoicesRecomputed;

    SELECT f.Who, f.DimeTxn, p.Status AS PaymentStatus, inv.InvoiceNumber, inv.TotalAmount,
           inv.PaidAmount, inv.BalanceDue, inv.Status AS InvoiceStatus
    FROM @Flips f
    INNER JOIN oe.Payments p ON p.PaymentId = f.PaymentId
    LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
    ORDER BY f.Who, f.DimeTxn;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
