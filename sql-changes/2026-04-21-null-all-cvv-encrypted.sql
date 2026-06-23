-- 2026-04-21-null-all-cvv-encrypted.sql
--
-- PCI DSS 3.3.1 compliance cleanup.
--
-- Sensitive Authentication Data (CVV/CVC/CID) MUST NOT be stored after
-- authorization, even when encrypted. We previously persisted CvvEncrypted on
-- oe.MemberPaymentMethods and oe.GroupPaymentMethods during DIME vaulting and
-- individual enrollment recurring setup. All write paths have been removed;
-- this script scrubs any legacy ciphertext so no stored CVV ever round-trips
-- through a backup, read replica, or ops query.
--
-- Safe to re-run: the WHERE clause filters to non-NULL rows only.

SET NOCOUNT ON;

BEGIN TRANSACTION;

DECLARE @MemberRowsUpdated INT = 0;
DECLARE @GroupRowsUpdated  INT = 0;

IF COL_LENGTH('oe.MemberPaymentMethods', 'CvvEncrypted') IS NOT NULL
BEGIN
    UPDATE oe.MemberPaymentMethods
        SET CvvEncrypted = NULL,
            ModifiedDate = GETUTCDATE()
    WHERE CvvEncrypted IS NOT NULL;

    SET @MemberRowsUpdated = @@ROWCOUNT;
END

IF COL_LENGTH('oe.GroupPaymentMethods', 'CvvEncrypted') IS NOT NULL
BEGIN
    UPDATE oe.GroupPaymentMethods
        SET CvvEncrypted = NULL,
            ModifiedDate = GETUTCDATE()
    WHERE CvvEncrypted IS NOT NULL;

    SET @GroupRowsUpdated = @@ROWCOUNT;
END

PRINT CONCAT(
    'Nulled CvvEncrypted on ',
    @MemberRowsUpdated,
    ' oe.MemberPaymentMethods row(s) and ',
    @GroupRowsUpdated,
    ' oe.GroupPaymentMethods row(s).'
);

COMMIT TRANSACTION;

-- NOTE: The CvvEncrypted columns themselves are intentionally left in place for
-- now so older deploys do not blow up on INSERTs that still mention them while
-- this change rolls out. A follow-up migration should DROP them once all
-- running code has been confirmed to no longer reference the column.
