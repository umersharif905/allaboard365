-- =============================================================================
-- Migration: Back Office Email store
-- Date:      2026-06-02
-- Branch:    feat/backoffice/email
-- Spec:      docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds the unified email store that the in-app back-office inbox is built on,
--   superseding the abandoned per-share-request email feature (oe.ShareRequestEmails,
--   dropped separately in 2026-06-02-drop-sharerequest-emails.sql).
--
--   Tables created:
--     1. oe.EmailThreads      one row per Graph conversation per vendor mailbox;
--                             holds derived state + the SR/Case/Member link.
--     2. oe.EmailMessages     one row per Graph message (inbound + outbound).
--     3. oe.EmailAttachments  file attachments (Azure Blob), same shape as
--                             oe.EncounterAttachments.
--     4. oe.EmailMailboxSync  per-vendor Graph sync state (subscription id +
--                             expiry, delta link, last webhook/poll timestamps).
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   The care team works customer email in a shared Outlook inbox today. This
--   store brings email into the back office: threaded inbox, attributed sends,
--   and (once a thread is linked) one encounter per message so email flows into
--   the same History timeline as Zoom calls.
--
-- IDEMPOTENCY
-- -----------
--   Every CREATE is guarded by an existence check; safe to re-run.
--
-- ORDER
-- -----
--   Run BEFORE 2026-06-02-encounters-email-source.sql (that script adds an FK
--   from oe.Encounters to oe.EmailMessages created here).
--
-- ROLLBACK
-- --------
--   See the commented ROLLBACK block at the bottom (children before parents).
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- Table: oe.EmailThreads
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'EmailThreads'
)
BEGIN
    CREATE TABLE oe.EmailThreads (
        ThreadId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_EmailThreads_ThreadId DEFAULT (NEWID()),
        VendorId         UNIQUEIDENTIFIER NOT NULL,
        ConversationId   NVARCHAR(512)    NOT NULL,         -- Graph conversationId (unique per vendor)
        Subject          NVARCHAR(998)    NULL,
        MemberId         UNIQUEIDENTIFIER NULL,             -- resolved / linked member
        CaseId           UNIQUEIDENTIFIER NULL,             -- linked case
        ShareRequestId   UNIQUEIDENTIFIER NULL,             -- linked share request
        Participants     NVARCHAR(MAX)    NULL,             -- JSON [{name,address}]
        FirstMessageAt   DATETIME2        NULL,
        LastMessageAt    DATETIME2        NULL,             -- drives sort
        LastDirection    NVARCHAR(10)     NULL,             -- inbound | outbound
        MessageCount     INT              NOT NULL CONSTRAINT DF_EmailThreads_MessageCount DEFAULT (0),
        UnreadCount      INT              NOT NULL CONSTRAINT DF_EmailThreads_UnreadCount  DEFAULT (0),
        NeedsReply       BIT              NOT NULL CONSTRAINT DF_EmailThreads_NeedsReply   DEFAULT (0),
        AssignedToUserId UNIQUEIDENTIFIER NULL,             -- optional thread owner
        IsArchived       BIT              NOT NULL CONSTRAINT DF_EmailThreads_IsArchived   DEFAULT (0),
        CreatedDate      DATETIME2        NOT NULL CONSTRAINT DF_EmailThreads_CreatedDate  DEFAULT (SYSUTCDATETIME()),
        CreatedBy        UNIQUEIDENTIFIER NULL,
        ModifiedDate     DATETIME2        NULL,
        ModifiedBy       UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_EmailThreads PRIMARY KEY CLUSTERED (ThreadId),
        CONSTRAINT UQ_EmailThreads_VendorConversation UNIQUE (VendorId, ConversationId),
        CONSTRAINT FK_EmailThreads_Vendor         FOREIGN KEY (VendorId)         REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_EmailThreads_Member         FOREIGN KEY (MemberId)         REFERENCES oe.Members (MemberId),
        CONSTRAINT FK_EmailThreads_Case           FOREIGN KEY (CaseId)           REFERENCES oe.Cases (CaseId),
        CONSTRAINT FK_EmailThreads_ShareRequest   FOREIGN KEY (ShareRequestId)   REFERENCES oe.ShareRequests (ShareRequestId),
        CONSTRAINT FK_EmailThreads_AssignedToUser FOREIGN KEY (AssignedToUserId) REFERENCES oe.Users (UserId),
        CONSTRAINT FK_EmailThreads_CreatedByUser  FOREIGN KEY (CreatedBy)        REFERENCES oe.Users (UserId)
    );
    PRINT 'Created table oe.EmailThreads.';

    -- Inbox list: newest activity first, per vendor.
    CREATE NONCLUSTERED INDEX IX_EmailThreads_Vendor_LastMessage
        ON oe.EmailThreads (VendorId, LastMessageAt DESC);

    -- "Needs reply" filter.
    CREATE NONCLUSTERED INDEX IX_EmailThreads_Vendor_NeedsReply
        ON oe.EmailThreads (VendorId)
        WHERE NeedsReply = 1;

    -- Share request detail Email tab.
    CREATE NONCLUSTERED INDEX IX_EmailThreads_ShareRequest
        ON oe.EmailThreads (ShareRequestId)
        WHERE ShareRequestId IS NOT NULL;

    -- Case detail Email tab.
    CREATE NONCLUSTERED INDEX IX_EmailThreads_Case
        ON oe.EmailThreads (CaseId)
        WHERE CaseId IS NOT NULL;

    -- Member history.
    CREATE NONCLUSTERED INDEX IX_EmailThreads_Member
        ON oe.EmailThreads (MemberId)
        WHERE MemberId IS NOT NULL;
END
ELSE
BEGIN
    PRINT 'Table oe.EmailThreads already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Table: oe.EmailMessages
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'EmailMessages'
)
BEGIN
    CREATE TABLE oe.EmailMessages (
        EmailMessageId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_EmailMessages_Id DEFAULT (NEWID()),
        ThreadId           UNIQUEIDENTIFIER NOT NULL,
        VendorId           UNIQUEIDENTIFIER NOT NULL,
        GraphMessageId     NVARCHAR(512)    NOT NULL,        -- Graph immutable id (Prefer: IdType="ImmutableId")
        GraphConversationId NVARCHAR(512)   NULL,
        InternetMessageId  NVARCHAR(998)    NULL,            -- RFC 2822 Message-ID
        Direction          NVARCHAR(10)     NOT NULL,        -- inbound | outbound
        FromAddress        NVARCHAR(320)    NULL,
        FromName           NVARCHAR(255)    NULL,
        ToAddresses        NVARCHAR(MAX)    NULL,            -- JSON
        CcAddresses        NVARCHAR(MAX)    NULL,            -- JSON
        Subject            NVARCHAR(998)    NULL,
        BodyHtml           NVARCHAR(MAX)    NULL,
        BodyPreview        NVARCHAR(512)    NULL,
        ReceivedAt         DATETIME2        NULL,
        SentAt             DATETIME2        NULL,
        IsRead             BIT              NOT NULL CONSTRAINT DF_EmailMessages_IsRead DEFAULT (0),
        HasAttachments     BIT              NOT NULL CONSTRAINT DF_EmailMessages_HasAttachments DEFAULT (0),
        SentByUserId       UNIQUEIDENTIFIER NULL,            -- internal sender (outbound) — attribution
        RefStamp           NVARCHAR(50)     NULL,            -- value of x-aab-ref (e.g. SR-2026-0123)
        SendStatus         NVARCHAR(20)     NULL,            -- outbound: queued | sent | failed
        SendError          NVARCHAR(MAX)    NULL,
        CreatedDate        DATETIME2        NOT NULL CONSTRAINT DF_EmailMessages_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy          UNIQUEIDENTIFIER NULL,
        ModifiedDate       DATETIME2        NULL,
        ModifiedBy         UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_EmailMessages PRIMARY KEY CLUSTERED (EmailMessageId),
        CONSTRAINT UQ_EmailMessages_VendorGraphId UNIQUE (VendorId, GraphMessageId),
        CONSTRAINT FK_EmailMessages_Thread       FOREIGN KEY (ThreadId)     REFERENCES oe.EmailThreads (ThreadId),
        CONSTRAINT FK_EmailMessages_Vendor       FOREIGN KEY (VendorId)     REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_EmailMessages_SentByUser   FOREIGN KEY (SentByUserId) REFERENCES oe.Users (UserId),
        CONSTRAINT FK_EmailMessages_CreatedByUser FOREIGN KEY (CreatedBy)   REFERENCES oe.Users (UserId)
    );
    PRINT 'Created table oe.EmailMessages.';

    -- Thread reader: messages in time order.
    CREATE NONCLUSTERED INDEX IX_EmailMessages_Thread_Time
        ON oe.EmailMessages (ThreadId, ReceivedAt, SentAt);
END
ELSE
BEGIN
    PRINT 'Table oe.EmailMessages already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Table: oe.EmailAttachments
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'EmailAttachments'
)
BEGIN
    CREATE TABLE oe.EmailAttachments (
        AttachmentId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_EmailAttachments_Id DEFAULT (NEWID()),
        EmailMessageId   UNIQUEIDENTIFIER NOT NULL,
        FileName         NVARCHAR(255)    NOT NULL,
        MimeType         NVARCHAR(100)    NULL,
        FileSize         BIGINT           NULL,
        BlobUrl          NVARCHAR(500)    NULL,
        BlobPath         NVARCHAR(500)    NULL,
        GraphAttachmentId NVARCHAR(512)   NULL,
        IsInline         BIT              NOT NULL CONSTRAINT DF_EmailAttachments_IsInline DEFAULT (0),
        ContentId        NVARCHAR(255)    NULL,             -- cid: for inline images
        IsActive         BIT              NOT NULL CONSTRAINT DF_EmailAttachments_IsActive DEFAULT (1),
        CreatedDate      DATETIME2        NOT NULL CONSTRAINT DF_EmailAttachments_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy        UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_EmailAttachments PRIMARY KEY CLUSTERED (AttachmentId),
        CONSTRAINT FK_EmailAttachments_Message
            FOREIGN KEY (EmailMessageId) REFERENCES oe.EmailMessages (EmailMessageId) ON DELETE CASCADE
    );
    PRINT 'Created table oe.EmailAttachments.';

    CREATE NONCLUSTERED INDEX IX_EmailAttachments_Message
        ON oe.EmailAttachments (EmailMessageId, IsActive);
END
ELSE
BEGIN
    PRINT 'Table oe.EmailAttachments already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Table: oe.EmailMailboxSync  (per-vendor Graph sync state)
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'EmailMailboxSync'
)
BEGIN
    CREATE TABLE oe.EmailMailboxSync (
        VendorId             UNIQUEIDENTIFIER NOT NULL,
        SubscriptionId       NVARCHAR(200)    NULL,
        SubscriptionExpiresAt DATETIME2       NULL,
        DeltaLink            NVARCHAR(MAX)    NULL,
        LastWebhookAt        DATETIME2        NULL,
        LastPollAt           DATETIME2        NULL,
        SyncStatus           NVARCHAR(20)     NULL,          -- idle | active | error
        LastError            NVARCHAR(MAX)    NULL,
        ModifiedDate         DATETIME2        NOT NULL CONSTRAINT DF_EmailMailboxSync_ModifiedDate DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_EmailMailboxSync PRIMARY KEY CLUSTERED (VendorId),
        CONSTRAINT FK_EmailMailboxSync_Vendor FOREIGN KEY (VendorId) REFERENCES oe.Vendors (VendorId)
    );
    PRINT 'Created table oe.EmailMailboxSync.';
END
ELSE
BEGIN
    PRINT 'Table oe.EmailMailboxSync already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Verification SELECT
-- -----------------------------------------------------------------------------
SELECT TableName = t.name
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'oe'
  AND t.name IN ('EmailThreads', 'EmailMessages', 'EmailAttachments', 'EmailMailboxSync')
ORDER BY t.name;
GO

-- =============================================================================
-- ROLLBACK (commented out — drop children before parents)
-- =============================================================================
-- IF OBJECT_ID('oe.EmailAttachments', 'U') IS NOT NULL DROP TABLE oe.EmailAttachments;
-- IF OBJECT_ID('oe.EmailMailboxSync', 'U') IS NOT NULL DROP TABLE oe.EmailMailboxSync;
-- IF OBJECT_ID('oe.EmailMessages',    'U') IS NOT NULL DROP TABLE oe.EmailMessages;   -- after dropping FK from oe.Encounters
-- IF OBJECT_ID('oe.EmailThreads',     'U') IS NOT NULL DROP TABLE oe.EmailThreads;
-- GO
