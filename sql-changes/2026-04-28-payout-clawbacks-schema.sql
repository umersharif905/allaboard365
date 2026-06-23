-- Phase 3 — oe.PayoutClawbacks
--
-- Single discriminated table for vendor and tenant-override clawbacks. Mirrors
-- the commission clawback pattern but for payout types that don't live in
-- oe.Commissions (vendor payouts and product owner / tenant overrides).
--
-- Status flow:
--   Available         -> remaining > 0, no NACHA application
--   PartiallyApplied  -> remaining > 0, AppliedToNACHAId may be set per-cycle
--   FullyApplied      -> remaining = 0
--   Voided            -> manual sysadmin cancel
--
-- The ledger is append-only; partial application is tracked by RemainingAmount.
-- Carry-forward across NACHA cycles is automatic — anything Available stays
-- eligible for the next cycle.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'oe.PayoutClawbacks', N'U') IS NULL
BEGIN
    CREATE TABLE oe.PayoutClawbacks (
        ClawbackId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        TenantId UNIQUEIDENTIFIER NOT NULL,
        PayoutType NVARCHAR(20) NOT NULL,            -- 'Vendor' | 'TenantOverride'
        RecipientEntityType NVARCHAR(20) NOT NULL,   -- 'Vendor' | 'Tenant'
        RecipientEntityId UNIQUEIDENTIFIER NOT NULL,
        SourcePaymentId UNIQUEIDENTIFIER NOT NULL,   -- The original payment that was refunded
        SourceRefundId UNIQUEIDENTIFIER NULL,        -- oe.Refunds row, if available
        Amount DECIMAL(10,2) NOT NULL,               -- Original clawback magnitude (positive)
        RemainingAmount DECIMAL(10,2) NOT NULL,      -- Drains as it gets netted into NACHA
        Status NVARCHAR(20) NOT NULL,
        AppliedToNACHAId UNIQUEIDENTIFIER NULL,      -- Most recent NACHA that consumed some/all
        Notes NVARCHAR(500) NULL,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT PK_PayoutClawbacks PRIMARY KEY (ClawbackId),
        CONSTRAINT CK_PayoutClawbacks_PayoutType
            CHECK (PayoutType IN (N'Vendor', N'TenantOverride')),
        CONSTRAINT CK_PayoutClawbacks_RecipientEntityType
            CHECK (RecipientEntityType IN (N'Vendor', N'Tenant')),
        CONSTRAINT CK_PayoutClawbacks_Status
            CHECK (Status IN (N'Available', N'PartiallyApplied', N'FullyApplied', N'Voided')),
        CONSTRAINT CK_PayoutClawbacks_AmountNonNegative
            CHECK (Amount >= 0),
        CONSTRAINT CK_PayoutClawbacks_RemainingNonNegative
            CHECK (RemainingAmount >= 0)
    );

    CREATE INDEX IX_PayoutClawbacks_Available
        ON oe.PayoutClawbacks(TenantId, PayoutType, RecipientEntityId)
        WHERE Status IN (N'Available', N'PartiallyApplied');

    CREATE INDEX IX_PayoutClawbacks_SourcePayment
        ON oe.PayoutClawbacks(SourcePaymentId);

    CREATE INDEX IX_PayoutClawbacks_AppliedToNACHAId
        ON oe.PayoutClawbacks(AppliedToNACHAId)
        WHERE AppliedToNACHAId IS NOT NULL;

    PRINT 'Created oe.PayoutClawbacks';
END
ELSE
BEGIN
    PRINT 'oe.PayoutClawbacks already exists - skipping';
END
GO
