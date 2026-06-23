-- Migration: Void 11 NULL-tenant orphan payments stuck in Pending
-- Date: 2026-06-03
-- Author: Jeremy Francis
--
-- Context
-- -------
-- 11 rows in oe.Payments have no TenantId / HouseholdId / InvoiceId and have sat
-- in Status='Pending' indefinitely. Investigation (DIME lookups under MightyWELL's
-- config + duplicate-twin analysis) showed NONE of them represent a receivable or
-- affect any member's displayed balance:
--
--   * 4x $855.01 (DIME ACH txns 252-255)  -> ACH_PAYMENT_REFUND, owner Andrew
--     Sheehe (MW household 9886EA22). Money OUT; charge+refund net to zero. His
--     real position (May paid, June overdue) is already correct in our DB.
--   * 1x $363.23 (DIME ACH txn 489)       -> ACH_PAYMENT_REFUND, owner Dawn Taylor
--     (MW household 245BF0BD). Refund already reflected there (-363.23 row +
--     txn 366 Refunded, invoice Cancelled).
--   * $112.31 (txn 401) and $409.58 (txn 1941291226) -> duplicates of payments
--     ALREADY linked + Completed on households 4A47938F / 55A53467 (same DIME txn).
--   * 4x $3.50 (txns 412 / 541606367 / 1957558831 / 1860907161) -> micro/test
--     charges, abandoned per ops.
--
-- These never cleaned themselves up because the DIME->Payments status mapper had no
-- rule for ACH_PAYMENT_REFUND (mapped to Unknown -> stored as Pending). That mapper
-- gap is fixed separately in shared/payment-status. Here we just retire the rows.
--
-- Action: flip the 11 from Pending -> Voided with an explanatory FailureReason.
-- Guarded so it only ever touches still-Pending, truly-orphan rows (idempotent).

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @OrphanIds TABLE (PaymentId UNIQUEIDENTIFIER PRIMARY KEY);
    INSERT INTO @OrphanIds (PaymentId) VALUES
        ('9FC4450D-6E0A-4D1A-82EF-1383C5224FB2'),  -- $363.23 refund (Dawn Taylor)
        ('2D411A81-E70E-4A61-9E0F-125564BEF46D'),  -- $855.01 refund (Andrew Sheehe)
        ('89FA80C0-C253-420A-8DE3-AD3A0222C6C0'),  -- $855.01 refund (Andrew Sheehe)
        ('3744303E-176B-40FC-A824-D6E3F62593C5'),  -- $855.01 refund (Andrew Sheehe)
        ('315A5ABC-77B5-41DC-BD12-83AE1AF34BD0'),  -- $855.01 refund (Andrew Sheehe)
        ('E58605CA-8485-4084-B690-2929907A3FF0'),  -- $112.31 duplicate of linked Completed (4A47938F)
        ('649FC604-4108-497A-A471-8CD92B062C2E'),  -- $409.58 duplicate of linked Completed (55A53467)
        ('A96FFB0E-4FBD-46B0-AE0C-6424A6EDEC65'),  -- $3.50 micro/test
        ('D76908E6-D0EA-4149-91BB-01F8395D9633'),  -- $3.50 micro/test
        ('7384EFC8-FA6C-4166-964E-FA71197DC838'),  -- $3.50 micro/test
        ('9D225CCC-5BE6-4568-9E12-761A002E0E03');  -- $3.50 micro/test

    -- Resolve which orphan rows are still eligible (Pending + truly unlinked) and the
    -- FailureReason note each will get. Table variable (not a CTE) so both the dry-run
    -- preview and the UPDATE can reference the same eligible set.
    DECLARE @Classified TABLE (
        PaymentId UNIQUEIDENTIFIER PRIMARY KEY,
        Amount DECIMAL(18,2),
        PaymentMethod NVARCHAR(64),
        DimeTxn NVARCHAR(64),
        NewFailureReason NVARCHAR(400)
    );

    INSERT INTO @Classified (PaymentId, Amount, PaymentMethod, DimeTxn, NewFailureReason)
    SELECT p.PaymentId, p.Amount, p.PaymentMethod, CAST(p.ProcessorTransactionId AS NVARCHAR(64)),
        CASE
            WHEN p.PaymentId IN (
                '2D411A81-E70E-4A61-9E0F-125564BEF46D','89FA80C0-C253-420A-8DE3-AD3A0222C6C0',
                '3744303E-176B-40FC-A824-D6E3F62593C5','315A5ABC-77B5-41DC-BD12-83AE1AF34BD0')
                THEN N'Voided orphan: DIME ACH_PAYMENT_REFUND (Andrew Sheehe), mis-recorded as Pending payment; unlinked, net-zero, no balance impact.'
            WHEN p.PaymentId = '9FC4450D-6E0A-4D1A-82EF-1383C5224FB2'
                THEN N'Voided orphan: DIME ACH_PAYMENT_REFUND (Dawn Taylor); refund already reflected on household 245BF0BD; no balance impact.'
            WHEN p.PaymentId IN ('E58605CA-8485-4084-B690-2929907A3FF0','649FC604-4108-497A-A471-8CD92B062C2E')
                THEN N'Voided orphan: duplicate of already-attributed Completed payment (same DIME txn); no balance impact.'
            ELSE N'Voided orphan: $3.50 micro/test charge, abandoned per ops.'
        END
    FROM oe.Payments p
    INNER JOIN @OrphanIds o ON o.PaymentId = p.PaymentId
    WHERE p.Status = 'Pending'
      AND p.TenantId IS NULL
      AND p.HouseholdId IS NULL
      AND p.InvoiceId IS NULL;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Preview of changes:' AS [Status];
        SELECT c.PaymentId, c.Amount, c.PaymentMethod, c.DimeTxn,
               N'Pending' AS CurrentStatus, N'Voided' AS NewStatus, c.NewFailureReason
        FROM @Classified c
        ORDER BY c.Amount DESC;
        ROLLBACK TRANSACTION;
        RETURN;
    END

    UPDATE p
        SET p.Status = 'Voided',
            p.FailureReason = c.NewFailureReason
    FROM oe.Payments p
    INNER JOIN @Classified c ON c.PaymentId = p.PaymentId;

    DECLARE @Affected INT = @@ROWCOUNT;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status], @Affected AS RowsVoided;

    -- Post-change verification
    SELECT p.PaymentId, p.Amount, p.PaymentMethod, p.ProcessorTransactionId AS DimeTxn,
           p.Status, p.FailureReason
    FROM oe.Payments p
    INNER JOIN @OrphanIds o ON o.PaymentId = p.PaymentId
    ORDER BY p.Amount DESC;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
