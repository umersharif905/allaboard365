-- Phase 1a: Household credit ledger
-- Single append-only table; signed Amount; idempotency via filtered unique index.
-- Reference: /Users/jeremyfrancis/.cursor/plans/credits_and_clawback_ledger_0655b4cc.plan.md
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables t INNER JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = 'oe' AND t.name = 'HouseholdCreditEntries')
BEGIN
    CREATE TABLE oe.HouseholdCreditEntries (
        EntryId UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_HouseholdCreditEntries_EntryId DEFAULT NEWID(),
        TenantId UNIQUEIDENTIFIER NOT NULL,
        HouseholdId UNIQUEIDENTIFIER NOT NULL,
        EntryType NVARCHAR(40) NOT NULL,
            -- 'OverpaymentRecognized' (positive Amount, paired with SourcePaymentId+SourceInvoiceId)
            -- 'AppliedToInvoice'      (negative Amount, paired with TargetInvoiceId, RelatedEntryId -> source)
            -- 'ReversedApplication'   (positive Amount, paired with RelatedEntryId -> AppliedToInvoice)
            -- 'ManualGoodwill'        (positive Amount, sysadmin)
            -- 'Voided'                (negative Amount, RelatedEntryId -> goodwill/recognized)
        Amount DECIMAL(10, 2) NOT NULL,
        SourcePaymentId UNIQUEIDENTIFIER NULL,
        SourceInvoiceId UNIQUEIDENTIFIER NULL,
        TargetInvoiceId UNIQUEIDENTIFIER NULL,
        RelatedEntryId UNIQUEIDENTIFIER NULL,
        Notes NVARCHAR(500) NULL,
        CreatedBy UNIQUEIDENTIFIER NULL,
        CreatedDate DATETIME2 NOT NULL CONSTRAINT DF_HouseholdCreditEntries_CreatedDate DEFAULT GETUTCDATE(),
        CONSTRAINT PK_HouseholdCreditEntries PRIMARY KEY CLUSTERED (EntryId),
        CONSTRAINT CK_HouseholdCreditEntries_EntryType CHECK (EntryType IN (
            N'OverpaymentRecognized',
            N'AppliedToInvoice',
            N'ReversedApplication',
            N'ManualGoodwill',
            N'Voided'
        ))
    );

    PRINT 'Created oe.HouseholdCreditEntries';
END
ELSE
BEGIN
    PRINT 'oe.HouseholdCreditEntries already exists; skipping CREATE.';
END
GO

-- Idempotency: one OverpaymentRecognized per (SourcePaymentId, SourceInvoiceId).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_HouseholdCreditEntries_OverpaymentSource' AND object_id = OBJECT_ID('oe.HouseholdCreditEntries'))
BEGIN
    CREATE UNIQUE INDEX UX_HouseholdCreditEntries_OverpaymentSource
        ON oe.HouseholdCreditEntries(SourcePaymentId, SourceInvoiceId)
        WHERE EntryType = N'OverpaymentRecognized';
    PRINT 'Created UX_HouseholdCreditEntries_OverpaymentSource (filtered unique)';
END
GO

-- Lookup indexes
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_HouseholdCreditEntries_Household' AND object_id = OBJECT_ID('oe.HouseholdCreditEntries'))
BEGIN
    CREATE INDEX IX_HouseholdCreditEntries_Household
        ON oe.HouseholdCreditEntries(HouseholdId, CreatedDate);
    PRINT 'Created IX_HouseholdCreditEntries_Household';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_HouseholdCreditEntries_Target' AND object_id = OBJECT_ID('oe.HouseholdCreditEntries'))
BEGIN
    CREATE INDEX IX_HouseholdCreditEntries_Target
        ON oe.HouseholdCreditEntries(TargetInvoiceId)
        WHERE TargetInvoiceId IS NOT NULL;
    PRINT 'Created IX_HouseholdCreditEntries_Target (filtered)';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_HouseholdCreditEntries_Source' AND object_id = OBJECT_ID('oe.HouseholdCreditEntries'))
BEGIN
    CREATE INDEX IX_HouseholdCreditEntries_Source
        ON oe.HouseholdCreditEntries(SourcePaymentId)
        WHERE SourcePaymentId IS NOT NULL;
    PRINT 'Created IX_HouseholdCreditEntries_Source (filtered)';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_HouseholdCreditEntries_Tenant' AND object_id = OBJECT_ID('oe.HouseholdCreditEntries'))
BEGIN
    CREATE INDEX IX_HouseholdCreditEntries_Tenant
        ON oe.HouseholdCreditEntries(TenantId, HouseholdId);
    PRINT 'Created IX_HouseholdCreditEntries_Tenant';
END
GO

PRINT 'oe.HouseholdCreditEntries schema migration complete.';
