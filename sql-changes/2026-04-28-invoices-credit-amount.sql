-- Phase 1a: oe.Invoices.CreditAmount column + recomputed BalanceDue
--
-- Adds a separate column that tracks how much of an invoice has been covered by
-- household credit. Keeping CreditAmount distinct from PaidAmount preserves:
--   - TotalAmount = breakdown sum (NetRate + Commission + Override + SystemFee + ...)
--   - PaidAmount  = actual cash collected (matches SUM(oe.Payments) for the invoice)
--   - CreditAmount = covered by oe.HouseholdCreditEntries 'AppliedToInvoice' rows
--   - BalanceDue  = TotalAmount - PaidAmount - CreditAmount (computed)
--
-- Reference: /Users/jeremyfrancis/.cursor/plans/credits_and_clawback_ledger_0655b4cc.plan.md
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- 1. Add CreditAmount column if missing
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Invoices') AND name = 'CreditAmount'
)
BEGIN
    ALTER TABLE oe.Invoices
        ADD CreditAmount DECIMAL(10, 2) NOT NULL CONSTRAINT DF_Invoices_CreditAmount DEFAULT 0;
    PRINT 'Added oe.Invoices.CreditAmount';
END
ELSE
BEGIN
    PRINT 'oe.Invoices.CreditAmount already exists; skipping ADD.';
END
GO

-- 2. Drop existing BalanceDue computed column (if it exists) so we can recreate it
DECLARE @balanceDueIsComputed BIT = 0;
IF EXISTS (
    SELECT 1 FROM sys.computed_columns cc
    INNER JOIN sys.columns c ON cc.object_id = c.object_id AND cc.column_id = c.column_id
    WHERE cc.object_id = OBJECT_ID('oe.Invoices') AND c.name = 'BalanceDue'
)
BEGIN
    SET @balanceDueIsComputed = 1;
    PRINT 'oe.Invoices.BalanceDue is a computed column; dropping to recreate with credit math.';
    ALTER TABLE oe.Invoices DROP COLUMN BalanceDue;
END
ELSE IF EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Invoices') AND name = 'BalanceDue'
)
BEGIN
    PRINT 'oe.Invoices.BalanceDue exists as a regular column - leaving it alone (manual review required).';
    PRINT 'Recommended: drop it manually, then re-run this script so it becomes the computed column.';
    RETURN;
END
ELSE
BEGIN
    PRINT 'oe.Invoices.BalanceDue does not exist; will create as computed.';
    SET @balanceDueIsComputed = 1;
END
GO

-- 3. Add BalanceDue computed column = GREATEST(0, TotalAmount - PaidAmount - CreditAmount)
IF NOT EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Invoices') AND name = 'BalanceDue'
)
BEGIN
    ALTER TABLE oe.Invoices ADD BalanceDue AS (
        CASE
            WHEN (COALESCE(PaidAmount, 0) + COALESCE(CreditAmount, 0)) >= COALESCE(TotalAmount, 0) THEN CONVERT(DECIMAL(12, 2), 0)
            ELSE CONVERT(DECIMAL(12, 2), COALESCE(TotalAmount, 0) - COALESCE(PaidAmount, 0) - COALESCE(CreditAmount, 0))
        END
    ) PERSISTED;
    PRINT 'Added computed column oe.Invoices.BalanceDue (persisted, credit-aware).';
END
GO

-- 4. Lookup index: households with positive credit applied (used by reports + UI)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Invoices_CreditAmount' AND object_id = OBJECT_ID('oe.Invoices'))
BEGIN
    CREATE INDEX IX_Invoices_CreditAmount
        ON oe.Invoices(HouseholdId)
        INCLUDE (CreditAmount, PaidAmount, TotalAmount, Status)
        WHERE CreditAmount > 0;
    PRINT 'Created IX_Invoices_CreditAmount (filtered)';
END
GO

PRINT 'oe.Invoices.CreditAmount migration complete.';
