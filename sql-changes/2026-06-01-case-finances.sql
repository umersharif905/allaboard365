-- =============================================================================
-- Migration: create oe.CaseBills and oe.CaseTransactions
-- Date:      2026-06-01
-- Branch:    fix/backoffice/billing
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds editable Bills + Ledger to the back-office Cases feature, mirroring the
--   Share Request Finances tab. Two new tables in the oe.* schema:
--
--     1. oe.CaseBills          provider charges / estimates on a case.
--     2. oe.CaseTransactions   ledger entries (payments, discounts, etc.).
--
--   The shape mirrors oe.ShareRequestBills / oe.ShareRequestTransactions but
--   intentionally DROPS the share-request-only medical-claim columns
--   (UAAmount, ShareAmount, CPTCodes, DiagnosisCodes) — a Case is a support
--   ticket, not an unshared-amount claim. The ledger uses a reduced transaction
--   type set (no "UA Payment" / "UA Reduction").
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   See docs/billing-rework/case-finances-design.md. Cases need the same
--   bill/ledger bookkeeping the back office already does on Share Requests, but
--   without the UA machinery.
--
-- IDEMPOTENCY
-- -----------
--   Every CREATE is guarded by an existence check, so this script is safe to
--   re-run.
--
-- ROLLBACK
-- --------
--   See the commented ROLLBACK block at the bottom (children first).
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- Table: oe.CaseBills
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'CaseBills'
)
BEGIN
    CREATE TABLE oe.CaseBills (
        BillId          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CaseBills_BillId DEFAULT (NEWID()),
        CaseId          UNIQUEIDENTIFIER NOT NULL,
        VendorId        UNIQUEIDENTIFIER NOT NULL,
        ProviderId      UNIQUEIDENTIFIER NULL,
        BillNumber      NVARCHAR(100)    NULL,
        BillType        NVARCHAR(50)     NOT NULL CONSTRAINT DF_CaseBills_BillType DEFAULT ('Bill'),
        BillDate        DATE             NULL,
        DateOfService   DATE             NULL,
        Description     NVARCHAR(MAX)    NULL,
        BilledAmount    DECIMAL(18, 2)   NOT NULL CONSTRAINT DF_CaseBills_BilledAmount DEFAULT (0),
        AllowedAmount   DECIMAL(18, 2)   NULL,
        PaidAmount      DECIMAL(18, 2)   NOT NULL CONSTRAINT DF_CaseBills_PaidAmount DEFAULT (0),
        Balance         DECIMAL(18, 2)   NOT NULL CONSTRAINT DF_CaseBills_Balance DEFAULT (0),
        Notes           NVARCHAR(MAX)    NULL,
        IsActive        BIT              NOT NULL CONSTRAINT DF_CaseBills_IsActive DEFAULT (1),
        CreatedDate     DATETIME2        NOT NULL CONSTRAINT DF_CaseBills_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy       UNIQUEIDENTIFIER NULL,
        ModifiedDate    DATETIME2        NULL,
        ModifiedBy      UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_CaseBills PRIMARY KEY CLUSTERED (BillId),
        CONSTRAINT FK_CaseBills_Case     FOREIGN KEY (CaseId)     REFERENCES oe.Cases (CaseId) ON DELETE CASCADE,
        CONSTRAINT FK_CaseBills_Vendor   FOREIGN KEY (VendorId)   REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_CaseBills_Provider FOREIGN KEY (ProviderId) REFERENCES oe.Providers (ProviderId)
    );
    PRINT 'Created table oe.CaseBills.';

    CREATE NONCLUSTERED INDEX IX_CaseBills_Case_Active ON oe.CaseBills (CaseId, IsActive);
    CREATE NONCLUSTERED INDEX IX_CaseBills_Provider    ON oe.CaseBills (ProviderId);
END
ELSE
BEGIN
    PRINT 'Table oe.CaseBills already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Table: oe.CaseTransactions
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'CaseTransactions'
)
BEGIN
    CREATE TABLE oe.CaseTransactions (
        TransactionId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CaseTransactions_Id DEFAULT (NEWID()),
        CaseId             UNIQUEIDENTIFIER NOT NULL,
        VendorId           UNIQUEIDENTIFIER NOT NULL,
        BillId             UNIQUEIDENTIFIER NULL,
        ProviderId         UNIQUEIDENTIFIER NULL,
        TransactionType    NVARCHAR(100)    NOT NULL,
        PaymentType        NVARCHAR(50)     NULL,
        TransactionStatus  NVARCHAR(50)     NOT NULL CONSTRAINT DF_CaseTransactions_Status DEFAULT ('Pending'),
        Amount             DECIMAL(18, 2)   NOT NULL CONSTRAINT DF_CaseTransactions_Amount DEFAULT (0),
        TransactionDate    DATE             NULL,
        ReferenceNumber    NVARCHAR(100)    NULL,
        Description        NVARCHAR(MAX)    NULL,
        Notes              NVARCHAR(MAX)    NULL,
        CreatedDate        DATETIME2        NOT NULL CONSTRAINT DF_CaseTransactions_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy          UNIQUEIDENTIFIER NULL,
        ModifiedDate       DATETIME2        NULL,
        ModifiedBy         UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_CaseTransactions PRIMARY KEY CLUSTERED (TransactionId),
        CONSTRAINT FK_CaseTransactions_Case     FOREIGN KEY (CaseId)     REFERENCES oe.Cases (CaseId) ON DELETE CASCADE,
        CONSTRAINT FK_CaseTransactions_Vendor   FOREIGN KEY (VendorId)   REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_CaseTransactions_Provider FOREIGN KEY (ProviderId) REFERENCES oe.Providers (ProviderId)
        -- BillId intentionally has NO enforced FK to oe.CaseBills: it is a loose
        -- join key (the same way oe.ShareRequestTransactions relates to bills),
        -- and bills are soft-deleted (IsActive = 0), never hard-deleted. Adding a
        -- FK here would create a second delete path to this table alongside the
        -- Cases cascade above and risk runtime cascade conflicts (error 547).
    );
    PRINT 'Created table oe.CaseTransactions.';

    CREATE NONCLUSTERED INDEX IX_CaseTransactions_Case ON oe.CaseTransactions (CaseId);
    CREATE NONCLUSTERED INDEX IX_CaseTransactions_Bill ON oe.CaseTransactions (BillId);
END
ELSE
BEGIN
    PRINT 'Table oe.CaseTransactions already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Verification SELECT
-- -----------------------------------------------------------------------------
SELECT TableName = t.name
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'oe'
  AND t.name IN ('CaseBills', 'CaseTransactions')
ORDER BY t.name;
GO

-- =============================================================================
-- ROLLBACK (commented out — drop children before parent)
-- =============================================================================
-- IF OBJECT_ID('oe.CaseTransactions', 'U') IS NOT NULL DROP TABLE oe.CaseTransactions;
-- IF OBJECT_ID('oe.CaseBills',        'U') IS NOT NULL DROP TABLE oe.CaseBills;
-- GO
