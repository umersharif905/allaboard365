-- Migration: Add RefundReason and RefundDate to oe.Refunds for refund history
-- Run once; safe to re-run (checks for column existence).

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Refunds' AND schema_id = SCHEMA_ID('oe'))
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Refunds') AND name = 'RefundReason')
    BEGIN
        ALTER TABLE oe.Refunds ADD RefundReason NVARCHAR(500) NULL;
        PRINT 'oe.Refunds.RefundReason added';
    END

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Refunds') AND name = 'RefundDate')
    BEGIN
        ALTER TABLE oe.Refunds ADD RefundDate DATETIME2 NULL;
        PRINT 'oe.Refunds.RefundDate added';
    END
END
GO
