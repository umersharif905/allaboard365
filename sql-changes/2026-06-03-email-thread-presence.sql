-- =============================================================================
-- Migration: oe.EmailThreadPresence (collision presence — viewing + replying)
-- Date:      2026-06-03
-- Branch:    feat/backoffice/email
-- Spec:      docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT: Per-user, per-thread presence so the inbox can show who is *viewing* a
--       conversation and who is *replying* to it (advisory, auto-expiring). One
--       row per (ThreadId, UserId), refreshed by a heartbeat; treated as expired
--       after ~90s of no heartbeat (tolerates background-tab timer throttling so
--       a member with an open draft in another tab still shows as replying).
--
--       Supersedes the single-column reply-lock (ReplyingBy* on oe.EmailThreads),
--       which couldn't represent multiple simultaneous viewers — those columns
--       are dropped here.
--
-- IDEMPOTENT: existence-guarded.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- Drop the superseded single-column lock (added earlier on testing only).
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.EmailThreads') AND name='ReplyingByUserId')
    ALTER TABLE oe.EmailThreads DROP COLUMN ReplyingByUserId;
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.EmailThreads') AND name='ReplyingByName')
    ALTER TABLE oe.EmailThreads DROP COLUMN ReplyingByName;
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.EmailThreads') AND name='ReplyingAt')
    ALTER TABLE oe.EmailThreads DROP COLUMN ReplyingAt;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.tables t INNER JOIN sys.schemas s ON t.schema_id=s.schema_id
    WHERE s.name='oe' AND t.name='EmailThreadPresence'
)
BEGIN
    CREATE TABLE oe.EmailThreadPresence (
        ThreadId   UNIQUEIDENTIFIER NOT NULL,
        UserId     UNIQUEIDENTIFIER NOT NULL,
        VendorId   UNIQUEIDENTIFIER NOT NULL,
        UserName   NVARCHAR(200)    NULL,
        State      NVARCHAR(20)     NOT NULL CONSTRAINT DF_EmailThreadPresence_State DEFAULT ('viewing'), -- viewing | replying
        LastSeenAt DATETIME2        NOT NULL CONSTRAINT DF_EmailThreadPresence_LastSeenAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_EmailThreadPresence PRIMARY KEY CLUSTERED (ThreadId, UserId),
        CONSTRAINT FK_EmailThreadPresence_Thread FOREIGN KEY (ThreadId) REFERENCES oe.EmailThreads (ThreadId) ON DELETE CASCADE
    );
    CREATE NONCLUSTERED INDEX IX_EmailThreadPresence_Thread ON oe.EmailThreadPresence (ThreadId, LastSeenAt);
    PRINT 'Created table oe.EmailThreadPresence.';
END
ELSE
BEGIN
    PRINT 'Table oe.EmailThreadPresence already exists — skipping.';
END
GO

SELECT TableExists = CASE WHEN OBJECT_ID('oe.EmailThreadPresence') IS NOT NULL THEN 1 ELSE 0 END;
GO
