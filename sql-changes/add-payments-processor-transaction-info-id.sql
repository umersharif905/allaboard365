-- Migration: Add ProcessorTransactionInfoId to oe.Payments for DIME refund API
-- DIME refund requires transaction_info_id (from charge response); we currently store transaction_number in ProcessorTransactionId.
-- Run once; safe to re-run.

IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Payments' AND schema_id = SCHEMA_ID('oe'))
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Payments') AND name = 'ProcessorTransactionInfoId')
    BEGIN
        ALTER TABLE oe.Payments ADD ProcessorTransactionInfoId NVARCHAR(255) NULL;
        PRINT 'oe.Payments.ProcessorTransactionInfoId added';
    END
END
GO
