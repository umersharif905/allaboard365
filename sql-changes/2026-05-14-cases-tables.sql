-- =============================================================================
-- Migration: create oe.Cases and supporting tables
-- Date:      2026-05-14
-- Branch:    back-office-cases
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds a new back-office "Cases" feature that lives alongside Share Requests
--   in the vendor portal. Cases are for less-urgent / less-expensive items that
--   still need triage, claiming, status tracking, providers, documents, and
--   notes — but DO NOT go through the public sharing-request submission flow.
--   Only VendorAdmin / VendorAgent create cases; members cannot.
--
--   Tables created (all in the oe.* schema):
--
--     1. oe.Cases               main case row, scoped per vendor + member.
--     2. oe.CaseNotes           user-visible notes AND status/claim audit
--                               (NoteType differentiates rows; same pattern as
--                                oe.ShareRequestNotes).
--     3. oe.CaseProviders       providers linked to a case.
--     4. oe.CaseDocuments       uploaded attachments (Azure Blob).
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   See ticket / PR for back-office-cases. The shape mirrors oe.ShareRequests
--   et al. but intentionally drops the financial / determination / queue /
--   public-form columns because cases don't have those workflows. Status set
--   is also distinct (Case statuses, not Share Request statuses).
--
-- IDEMPOTENCY
-- -----------
--   Every CREATE is guarded by an existence check, so this script is safe to
--   re-run.
--
-- ROLLBACK
-- --------
--   See the commented ROLLBACK block at the bottom. Reverse the create order
--   (children first, then oe.Cases).
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- Table: oe.Cases
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'Cases'
)
BEGIN
    CREATE TABLE oe.Cases (
        CaseId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Cases_CaseId DEFAULT (NEWID()),
        VendorId          UNIQUEIDENTIFIER NOT NULL,
        CaseNumber        NVARCHAR(50)     NOT NULL,
        MemberId          UNIQUEIDENTIFIER NOT NULL,
        HouseholdId       UNIQUEIDENTIFIER NULL,
        Status            NVARCHAR(50)     NOT NULL CONSTRAINT DF_Cases_Status DEFAULT ('New'),
        Title             NVARCHAR(200)    NULL,
        Description       NVARCHAR(MAX)    NULL,
        SubmittedDate     DATETIME2        NOT NULL CONSTRAINT DF_Cases_SubmittedDate DEFAULT (SYSUTCDATETIME()),
        CompletedDate     DATETIME2        NULL,
        ClaimedByUserId   UNIQUEIDENTIFIER NULL,
        ClaimedAt         DATETIME2        NULL,
        CreatedDate       DATETIME2        NOT NULL CONSTRAINT DF_Cases_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy         UNIQUEIDENTIFIER NULL,
        ModifiedDate      DATETIME2        NULL,
        ModifiedBy        UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_Cases PRIMARY KEY CLUSTERED (CaseId),
        CONSTRAINT UQ_Cases_VendorCaseNumber UNIQUE (VendorId, CaseNumber),
        CONSTRAINT FK_Cases_Vendor          FOREIGN KEY (VendorId)        REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_Cases_Member          FOREIGN KEY (MemberId)        REFERENCES oe.Members (MemberId),
        CONSTRAINT FK_Cases_ClaimedByUser   FOREIGN KEY (ClaimedByUserId) REFERENCES oe.Users (UserId)
    );
    PRINT 'Created table oe.Cases.';

    CREATE NONCLUSTERED INDEX IX_Cases_Vendor_Status         ON oe.Cases (VendorId, Status);
    CREATE NONCLUSTERED INDEX IX_Cases_Vendor_ClaimedBy      ON oe.Cases (VendorId, ClaimedByUserId);
    CREATE NONCLUSTERED INDEX IX_Cases_Member                ON oe.Cases (MemberId);
END
ELSE
BEGIN
    PRINT 'Table oe.Cases already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Table: oe.CaseNotes  (user notes + status/claim audit; differentiated by NoteType)
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'CaseNotes'
)
BEGIN
    CREATE TABLE oe.CaseNotes (
        NoteId          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CaseNotes_NoteId DEFAULT (NEWID()),
        CaseId          UNIQUEIDENTIFIER NOT NULL,
        NoteType        NVARCHAR(50)     NOT NULL CONSTRAINT DF_CaseNotes_NoteType DEFAULT ('user_note'),
        Note            NVARCHAR(MAX)    NOT NULL,
        IsInternal      BIT              NOT NULL CONSTRAINT DF_CaseNotes_IsInternal DEFAULT (1),
        PreviousValue   NVARCHAR(500)    NULL,
        NewValue        NVARCHAR(500)    NULL,
        CreatedDate     DATETIME2        NOT NULL CONSTRAINT DF_CaseNotes_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy       UNIQUEIDENTIFIER NULL,
        CreatedByName   NVARCHAR(200)    NULL,
        CONSTRAINT PK_CaseNotes PRIMARY KEY CLUSTERED (NoteId),
        CONSTRAINT FK_CaseNotes_Case FOREIGN KEY (CaseId) REFERENCES oe.Cases (CaseId) ON DELETE CASCADE
    );
    PRINT 'Created table oe.CaseNotes.';

    CREATE NONCLUSTERED INDEX IX_CaseNotes_Case_Created ON oe.CaseNotes (CaseId, CreatedDate DESC);
END
ELSE
BEGIN
    PRINT 'Table oe.CaseNotes already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Table: oe.CaseProviders
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'CaseProviders'
)
BEGIN
    CREATE TABLE oe.CaseProviders (
        CaseProviderId  UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CaseProviders_Id DEFAULT (NEWID()),
        CaseId          UNIQUEIDENTIFIER NOT NULL,
        ProviderId      UNIQUEIDENTIFIER NOT NULL,
        ProviderRole    NVARCHAR(100)    NULL,
        Notes           NVARCHAR(MAX)    NULL,
        CreatedDate     DATETIME2        NOT NULL CONSTRAINT DF_CaseProviders_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy       UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_CaseProviders PRIMARY KEY CLUSTERED (CaseProviderId),
        CONSTRAINT FK_CaseProviders_Case     FOREIGN KEY (CaseId)     REFERENCES oe.Cases (CaseId) ON DELETE CASCADE,
        CONSTRAINT FK_CaseProviders_Provider FOREIGN KEY (ProviderId) REFERENCES oe.Providers (ProviderId)
    );
    PRINT 'Created table oe.CaseProviders.';

    CREATE NONCLUSTERED INDEX IX_CaseProviders_Case ON oe.CaseProviders (CaseId);
END
ELSE
BEGIN
    PRINT 'Table oe.CaseProviders already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Table: oe.CaseDocuments
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'CaseDocuments'
)
BEGIN
    CREATE TABLE oe.CaseDocuments (
        DocumentId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CaseDocuments_Id DEFAULT (NEWID()),
        CaseId          UNIQUEIDENTIFIER NOT NULL,
        DocumentName    NVARCHAR(255)    NOT NULL,
        DocumentType    NVARCHAR(100)    NULL,
        FileName        NVARCHAR(255)    NOT NULL,
        FileSize        BIGINT           NULL,
        MimeType        NVARCHAR(100)    NULL,
        BlobUrl         NVARCHAR(500)    NULL,
        BlobPath        NVARCHAR(500)    NULL,
        Description     NVARCHAR(500)    NULL,
        UploadedBy      NVARCHAR(100)    NULL,
        IsActive        BIT              NOT NULL CONSTRAINT DF_CaseDocuments_IsActive DEFAULT (1),
        CreatedDate     DATETIME2        NOT NULL CONSTRAINT DF_CaseDocuments_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy       UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_CaseDocuments PRIMARY KEY CLUSTERED (DocumentId),
        CONSTRAINT FK_CaseDocuments_Case FOREIGN KEY (CaseId) REFERENCES oe.Cases (CaseId) ON DELETE CASCADE
    );
    PRINT 'Created table oe.CaseDocuments.';

    CREATE NONCLUSTERED INDEX IX_CaseDocuments_Case ON oe.CaseDocuments (CaseId, IsActive);
END
ELSE
BEGIN
    PRINT 'Table oe.CaseDocuments already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Verification SELECT
-- -----------------------------------------------------------------------------
SELECT TableName = t.name
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'oe'
  AND t.name IN ('Cases', 'CaseNotes', 'CaseProviders', 'CaseDocuments')
ORDER BY t.name;
GO

-- =============================================================================
-- ROLLBACK (commented out — drop children before parent)
-- =============================================================================
-- IF OBJECT_ID('oe.CaseDocuments', 'U') IS NOT NULL DROP TABLE oe.CaseDocuments;
-- IF OBJECT_ID('oe.CaseProviders', 'U') IS NOT NULL DROP TABLE oe.CaseProviders;
-- IF OBJECT_ID('oe.CaseNotes',     'U') IS NOT NULL DROP TABLE oe.CaseNotes;
-- IF OBJECT_ID('oe.Cases',         'U') IS NOT NULL DROP TABLE oe.Cases;
-- GO
