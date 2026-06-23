-- File: sql-changes/2026-04-28-credit-entries-add-group-scope.sql
--
-- Phase: Group-level credit support
--
-- Extends oe.HouseholdCreditEntries to support GROUP-scoped credit entries
-- (in addition to the existing HOUSEHOLD-scoped entries). Each entry is now
-- scoped to exactly one of:
--   - HouseholdId (individual household credit, existing behaviour)
--   - GroupId (group-level credit applied against oe.Invoices where InvoiceType='Group')
--
-- Tables touched: oe.HouseholdCreditEntries (additive only — no data migration).
-- Idempotent: re-runnable.
--
-- Why GO statements: SQL Server compiles each batch as a unit. Without GO
-- between the ADD COLUMN and the CHECK/INDEX that reference the new column,
-- the compiler errors with "Invalid column name 'GroupId'".

SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- 1. Make HouseholdId nullable so group-only entries can omit it.
IF EXISTS (
    SELECT 1 FROM sys.columns c
    WHERE c.object_id = OBJECT_ID(N'oe.HouseholdCreditEntries')
      AND c.name = N'HouseholdId'
      AND c.is_nullable = 0
)
BEGIN
    PRINT 'Relaxing HouseholdId to NULLABLE...';
    ALTER TABLE oe.HouseholdCreditEntries ALTER COLUMN HouseholdId UNIQUEIDENTIFIER NULL;
END
ELSE
BEGIN
    PRINT 'HouseholdId already nullable.';
END
GO

-- 2. Add GroupId column.
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'oe.HouseholdCreditEntries')
      AND name = N'GroupId'
)
BEGIN
    PRINT 'Adding GroupId column...';
    ALTER TABLE oe.HouseholdCreditEntries ADD GroupId UNIQUEIDENTIFIER NULL;
END
ELSE
BEGIN
    PRINT 'GroupId column already exists.';
END
GO

-- 3. Enforce: exactly one of HouseholdId / GroupId must be non-null per row.
IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE name = N'CK_CreditEntries_OneScope'
      AND parent_object_id = OBJECT_ID(N'oe.HouseholdCreditEntries')
)
BEGIN
    PRINT 'Adding CK_CreditEntries_OneScope...';
    ALTER TABLE oe.HouseholdCreditEntries WITH CHECK ADD CONSTRAINT CK_CreditEntries_OneScope
        CHECK ((HouseholdId IS NOT NULL AND GroupId IS NULL)
            OR (HouseholdId IS NULL AND GroupId IS NOT NULL));
END
ELSE
BEGIN
    PRINT 'CK_CreditEntries_OneScope already exists.';
END
GO

-- 4. Index for group balance lookups.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_HouseholdCreditEntries_Group'
      AND object_id = OBJECT_ID(N'oe.HouseholdCreditEntries')
)
BEGIN
    PRINT 'Creating IX_HouseholdCreditEntries_Group...';
    CREATE INDEX IX_HouseholdCreditEntries_Group
        ON oe.HouseholdCreditEntries(GroupId, CreatedDate)
        WHERE GroupId IS NOT NULL;
END
ELSE
BEGIN
    PRINT 'IX_HouseholdCreditEntries_Group already exists.';
END
GO

-- 5. Verify.
SELECT
    SUM(CASE WHEN HouseholdId IS NOT NULL THEN 1 ELSE 0 END) AS HouseholdEntries,
    SUM(CASE WHEN GroupId     IS NOT NULL THEN 1 ELSE 0 END) AS GroupEntries,
    SUM(CASE WHEN HouseholdId IS NULL AND GroupId IS NULL THEN 1 ELSE 0 END) AS InvalidEntries
FROM oe.HouseholdCreditEntries;
GO

PRINT 'Migration complete.';
GO
