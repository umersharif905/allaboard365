-- Phase 2 schema migration for invoice-anchored NACHA payouts.
--
-- Adds InvoiceId to oe.NACHAPaymentDetails and makes PaymentId nullable so
-- credit-funded payouts (where there's no oe.Payments row, only a Paid
-- oe.Invoices row settled via credit) can be tracked in the same ledger as
-- payment-funded ones.
--
-- App-level invariant: every row must have at least one of (PaymentId,
-- InvoiceId) non-null. Enforced both via CHECK constraint here and in code.
--
-- Backward compatibility: all existing rows have PaymentId set; the new
-- column defaults to NULL and is filled only by new code paths that anchor
-- on invoices.
--
-- Idempotent: re-running this script is a no-op once the schema is in place.

SET XACT_ABORT ON;
BEGIN TRY
BEGIN TRAN;

-- 1) Drop the FK so we can alter PaymentId to nullable.
IF EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = 'FK_NACHAPaymentDetails_Payments'
    AND parent_object_id = OBJECT_ID('oe.NACHAPaymentDetails')
)
BEGIN
  ALTER TABLE oe.NACHAPaymentDetails
    DROP CONSTRAINT FK_NACHAPaymentDetails_Payments;
  PRINT 'Dropped FK_NACHAPaymentDetails_Payments.';
END;

-- 2) Make PaymentId nullable.
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.NACHAPaymentDetails')
    AND name = 'PaymentId'
    AND is_nullable = 0
)
BEGIN
  ALTER TABLE oe.NACHAPaymentDetails
    ALTER COLUMN PaymentId UNIQUEIDENTIFIER NULL;
  PRINT 'PaymentId is now NULLABLE.';
END;

-- 3) Recreate the FK (it tolerates NULL automatically).
IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = 'FK_NACHAPaymentDetails_Payments'
    AND parent_object_id = OBJECT_ID('oe.NACHAPaymentDetails')
)
BEGIN
  ALTER TABLE oe.NACHAPaymentDetails
    ADD CONSTRAINT FK_NACHAPaymentDetails_Payments
    FOREIGN KEY (PaymentId) REFERENCES oe.Payments(PaymentId);
  PRINT 'Re-added FK_NACHAPaymentDetails_Payments.';
END;

-- 4) Add InvoiceId column.
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.NACHAPaymentDetails')
    AND name = 'InvoiceId'
)
BEGIN
  ALTER TABLE oe.NACHAPaymentDetails
    ADD InvoiceId UNIQUEIDENTIFIER NULL;
  PRINT 'Added InvoiceId column to oe.NACHAPaymentDetails.';
END;

COMMIT TRAN;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;
GO

-- 5) Add FK to oe.Invoices (separate batch so the column is committed first).
IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = 'FK_NACHAPaymentDetails_Invoices'
    AND parent_object_id = OBJECT_ID('oe.NACHAPaymentDetails')
)
BEGIN
  ALTER TABLE oe.NACHAPaymentDetails
    ADD CONSTRAINT FK_NACHAPaymentDetails_Invoices
    FOREIGN KEY (InvoiceId) REFERENCES oe.Invoices(InvoiceId);
  PRINT 'Added FK_NACHAPaymentDetails_Invoices.';
END;
GO

-- 6) Filtered non-unique index on InvoiceId for fast dedup lookups.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_NACHAPaymentDetails_InvoiceId'
    AND object_id = OBJECT_ID('oe.NACHAPaymentDetails')
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_NACHAPaymentDetails_InvoiceId
    ON oe.NACHAPaymentDetails(InvoiceId)
    WHERE InvoiceId IS NOT NULL;
  PRINT 'Created IX_NACHAPaymentDetails_InvoiceId.';
END;
GO

-- 7) CHECK constraint: at least one of (PaymentId, InvoiceId) must be non-null.
IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_NACHAPaymentDetails_AnchorRequired'
    AND parent_object_id = OBJECT_ID('oe.NACHAPaymentDetails')
)
BEGIN
  ALTER TABLE oe.NACHAPaymentDetails
    ADD CONSTRAINT CK_NACHAPaymentDetails_AnchorRequired
    CHECK (PaymentId IS NOT NULL OR InvoiceId IS NOT NULL);
  PRINT 'Added CK_NACHAPaymentDetails_AnchorRequired.';
END;
GO

-- ============================================================
-- oe.Commissions: also gain an InvoiceId column so commissions
-- generated from credit-funded invoices (PaymentId IS NULL) can be tracked
-- and re-queried by getEligibleCommissions' invoice-anchored branch.
-- ============================================================
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Commissions')
    AND name = 'InvoiceId'
)
BEGIN
  ALTER TABLE oe.Commissions
    ADD InvoiceId UNIQUEIDENTIFIER NULL;
  PRINT 'Added InvoiceId column to oe.Commissions.';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = 'FK_Commissions_Invoices'
    AND parent_object_id = OBJECT_ID('oe.Commissions')
)
BEGIN
  ALTER TABLE oe.Commissions
    ADD CONSTRAINT FK_Commissions_Invoices
    FOREIGN KEY (InvoiceId) REFERENCES oe.Invoices(InvoiceId);
  PRINT 'Added FK_Commissions_Invoices.';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Commissions_InvoiceId'
    AND object_id = OBJECT_ID('oe.Commissions')
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_Commissions_InvoiceId
    ON oe.Commissions(InvoiceId)
    WHERE InvoiceId IS NOT NULL;
  PRINT 'Created IX_Commissions_InvoiceId.';
END;
GO

-- ============================================================
-- VERIFICATION
-- ============================================================
SELECT
  c.name AS ColumnName,
  TYPE_NAME(c.system_type_id) AS DataType,
  c.is_nullable
FROM sys.columns c
WHERE c.object_id = OBJECT_ID('oe.NACHAPaymentDetails')
  AND c.name IN ('PaymentId', 'InvoiceId')
ORDER BY c.column_id;

SELECT name AS Constraint_or_Index
FROM sys.foreign_keys
WHERE parent_object_id = OBJECT_ID('oe.NACHAPaymentDetails')
UNION ALL
SELECT name FROM sys.check_constraints
WHERE parent_object_id = OBJECT_ID('oe.NACHAPaymentDetails')
UNION ALL
SELECT name FROM sys.indexes
WHERE object_id = OBJECT_ID('oe.NACHAPaymentDetails');
