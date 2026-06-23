-- ============================================================================
-- Unified Invoice System: Individual Invoice Support
-- Extends oe.Invoices to support individual/household invoices alongside
-- the existing group invoices. Adds Phase 2 financial breakdown columns
-- (left NULL for now; populated in a future release).
--
-- NOTE: Uses GO batch separators so SQL Server can see newly added columns
--       in subsequent batches. Run in SSMS or Azure Data Studio.
-- ============================================================================

-- Batch 1: Make GroupId nullable (was NOT NULL for group-only invoices)
IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Invoices'
      AND COLUMN_NAME = 'GroupId' AND IS_NULLABLE = 'NO'
)
BEGIN
    ALTER TABLE oe.Invoices ALTER COLUMN GroupId UNIQUEIDENTIFIER NULL;
    PRINT 'Made GroupId nullable on oe.Invoices';
END;
GO

-- Batch 2: Add new columns
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Invoices' AND COLUMN_NAME = 'HouseholdId'
)
BEGIN
    ALTER TABLE oe.Invoices ADD HouseholdId UNIQUEIDENTIFIER NULL;
    PRINT 'Added HouseholdId to oe.Invoices';
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Invoices' AND COLUMN_NAME = 'InvoiceType'
)
BEGIN
    ALTER TABLE oe.Invoices ADD InvoiceType NVARCHAR(20) NOT NULL DEFAULT 'Group';
    PRINT 'Added InvoiceType to oe.Invoices';
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Invoices' AND COLUMN_NAME = 'TenantId'
)
BEGIN
    ALTER TABLE oe.Invoices ADD TenantId UNIQUEIDENTIFIER NULL;
    PRINT 'Added TenantId to oe.Invoices';
END;
GO

-- Batch 3: Phase 2 financial breakdown columns (added now for schema stability, populated later)
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Invoices' AND COLUMN_NAME = 'NetRate'
)
BEGIN
    ALTER TABLE oe.Invoices ADD NetRate DECIMAL(18,6) NULL;
    ALTER TABLE oe.Invoices ADD OverrideRate DECIMAL(18,6) NULL;
    ALTER TABLE oe.Invoices ADD Commission DECIMAL(18,6) NULL;
    ALTER TABLE oe.Invoices ADD SystemFees DECIMAL(18,6) NULL;
    ALTER TABLE oe.Invoices ADD ProcessingFeeAmount DECIMAL(18,6) NULL;
    ALTER TABLE oe.Invoices ADD SetupFee DECIMAL(18,6) NULL;
    ALTER TABLE oe.Invoices ADD ProductCommissions NVARCHAR(MAX) NULL;
    ALTER TABLE oe.Invoices ADD ProductVendorAmounts NVARCHAR(MAX) NULL;
    ALTER TABLE oe.Invoices ADD ProductOwnerAmounts NVARCHAR(MAX) NULL;
    PRINT 'Added Phase 2 financial breakdown columns to oe.Invoices';
END;
GO

-- Batch 4: Create indexes (columns now exist from previous batches)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Invoices_HouseholdId' AND object_id = OBJECT_ID('oe.Invoices'))
BEGIN
    CREATE INDEX IX_Invoices_HouseholdId ON oe.Invoices(HouseholdId) WHERE HouseholdId IS NOT NULL;
    PRINT 'Created IX_Invoices_HouseholdId';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Invoices_TenantId' AND object_id = OBJECT_ID('oe.Invoices'))
BEGIN
    CREATE INDEX IX_Invoices_TenantId ON oe.Invoices(TenantId) WHERE TenantId IS NOT NULL;
    PRINT 'Created IX_Invoices_TenantId';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Invoices_InvoiceType' AND object_id = OBJECT_ID('oe.Invoices'))
BEGIN
    CREATE INDEX IX_Invoices_InvoiceType ON oe.Invoices(InvoiceType);
    PRINT 'Created IX_Invoices_InvoiceType';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Invoices_Status_DueDate' AND object_id = OBJECT_ID('oe.Invoices'))
BEGIN
    CREATE INDEX IX_Invoices_Status_DueDate ON oe.Invoices(Status, DueDate);
    PRINT 'Created IX_Invoices_Status_DueDate';
END;
GO

-- Batch 5: Backfill existing group invoices with InvoiceType and TenantId
UPDATE inv
SET inv.InvoiceType = 'Group',
    inv.TenantId = g.TenantId
FROM oe.Invoices inv
INNER JOIN oe.Groups g ON inv.GroupId = g.GroupId
WHERE inv.TenantId IS NULL;

PRINT 'Backfilled InvoiceType and TenantId on existing group invoices';
GO
