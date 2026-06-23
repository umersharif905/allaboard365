-- =============================================================================
-- Migration: oe.EmailThreadNotes + oe.EmailThreads resolution columns
-- Date:    2026-06-04
-- Branch:  feat/backoffice/email
-- Spec:    docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT: Internal (team-only) notes on an email thread, plus a "Handled" state so a
--       thread can be closed out without sending a redundant reply (e.g. a form was
--       sent via the forms page). Notes mirror oe.CaseNotes. Resolution auto-reopens
--       when a new inbound message arrives (handled in emailThreadService).
--
-- ADDITIVE + IDEMPOTENT.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.tables t INNER JOIN sys.schemas s ON t.schema_id=s.schema_id
    WHERE s.name='oe' AND t.name='EmailThreadNotes'
)
BEGIN
    CREATE TABLE oe.EmailThreadNotes (
        NoteId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_EmailThreadNotes_NoteId DEFAULT (NEWID()),
        ThreadId      UNIQUEIDENTIFIER NOT NULL,
        Note          NVARCHAR(MAX)    NOT NULL,
        IsInternal    BIT              NOT NULL CONSTRAINT DF_EmailThreadNotes_IsInternal DEFAULT (1),
        CreatedDate   DATETIME2        NOT NULL CONSTRAINT DF_EmailThreadNotes_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy     UNIQUEIDENTIFIER NULL,
        CreatedByName NVARCHAR(200)    NULL,
        CONSTRAINT PK_EmailThreadNotes PRIMARY KEY CLUSTERED (NoteId),
        CONSTRAINT FK_EmailThreadNotes_Thread FOREIGN KEY (ThreadId) REFERENCES oe.EmailThreads (ThreadId) ON DELETE CASCADE
    );
    CREATE NONCLUSTERED INDEX IX_EmailThreadNotes_Thread_Created ON oe.EmailThreadNotes (ThreadId, CreatedDate DESC);
    PRINT 'Created table oe.EmailThreadNotes.';
END
ELSE
    PRINT 'Table oe.EmailThreadNotes already exists — skipping.';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.EmailThreads') AND name='ResolvedAt')
    ALTER TABLE oe.EmailThreads ADD ResolvedAt DATETIME2 NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.EmailThreads') AND name='ResolvedByUserId')
    ALTER TABLE oe.EmailThreads ADD ResolvedByUserId UNIQUEIDENTIFIER NULL;
GO

SELECT
    NotesTable = CASE WHEN OBJECT_ID('oe.EmailThreadNotes') IS NOT NULL THEN 1 ELSE 0 END,
    ResolvedAt = CASE WHEN EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.EmailThreads') AND name='ResolvedAt') THEN 1 ELSE 0 END,
    ResolvedByUserId = CASE WHEN EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.EmailThreads') AND name='ResolvedByUserId') THEN 1 ELSE 0 END;
GO
