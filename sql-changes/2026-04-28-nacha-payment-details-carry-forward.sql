-- Phase 11 — Optional NACHAPaymentDetails.CarryForwardAmount column
--
-- Tracks how much was carried forward (clawback amount that exceeded the
-- recipient's positive payouts in this NACHA cycle). Lets us produce a
-- "Carries to next cycle" report without recomputing from oe.Commissions /
-- oe.PayoutClawbacks each time.
--
-- Nullable + zero-default — back-compat with existing rows.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE Name = N'CarryForwardAmount'
      AND Object_ID = OBJECT_ID(N'oe.NACHAPaymentDetails')
)
BEGIN
    ALTER TABLE oe.NACHAPaymentDetails
        ADD CarryForwardAmount DECIMAL(10,2) NOT NULL CONSTRAINT DF_NACHAPaymentDetails_CarryForwardAmount DEFAULT 0;

    PRINT 'Added oe.NACHAPaymentDetails.CarryForwardAmount';
END
ELSE
BEGIN
    PRINT 'oe.NACHAPaymentDetails.CarryForwardAmount already exists - skipping';
END
GO
