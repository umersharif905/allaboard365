-- =============================================================================
-- Migration: create oe.Encounters and oe.EncounterAttachments
-- Date:      2026-05-15
-- Branch:    feature/backoffice-encounters
-- Spec:      docs/superpowers/specs/2026-05-15-encounters-design.md
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds the back-office Encounters feature: vendor-scoped, member-rooted
--   records of conversations the care team has with members (phone, email,
--   in-person, etc.). Sits alongside Cases (oe.Cases) and Share Requests
--   (oe.ShareRequests) as a third trackable object in the vendor portal.
--
--   Tables created:
--
--     1. oe.Encounters             one row per conversation; member optional
--                                  (NULL = "Triage" bucket). Optional pin to
--                                  a Case and/or Share Request. Schema is
--                                  pre-shaped for future Zoom phone integration
--                                  (Source/ExternalRef/DurationSeconds/
--                                  RecordingUrl/TranscriptText all nullable
--                                  in v1).
--
--     2. oe.EncounterAttachments   optional file attachments (Azure Blob),
--                                  same shape as oe.CaseDocuments.
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   The care team currently has no first-class place to record what was said
--   on a member call. Notes are short scratch text per Case/SR; Communications
--   is read-only outbound message history (SendGrid/Twilio). Encounters fills
--   the gap and pre-shapes the data so the future Zoom integration (auto-
--   transcribed inbound calls) is a new producer, not a schema redesign.
--
--   No Status state machine (mirrors oe.Cases' Unclaimed/Claimed pattern):
--   states are derived from columns:
--     - Triage:        MemberId IS NULL
--     - Assigned:      AssignedToUserId IS NOT NULL
--     - Follow-up due: FollowUpDueDate IS NOT NULL AND FollowUpCompletedAt IS NULL
--     - Archived:      IsArchived = 1
--
-- IDEMPOTENCY
-- -----------
--   Every CREATE is guarded by an existence check, so this script is safe to
--   re-run.
--
-- ROLLBACK
-- --------
--   See the commented ROLLBACK block at the bottom. Reverse the create order
--   (children first, then oe.Encounters).
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- Table: oe.Encounters
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'Encounters'
)
BEGIN
    CREATE TABLE oe.Encounters (
        EncounterId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Encounters_EncounterId DEFAULT (NEWID()),
        VendorId            UNIQUEIDENTIFIER NOT NULL,
        EncounterNumber     NVARCHAR(50)     NOT NULL,
        MemberId            UNIQUEIDENTIFIER NULL,            -- NULL = Triage bucket
        CaseId              UNIQUEIDENTIFIER NULL,            -- optional pin
        ShareRequestId      UNIQUEIDENTIFIER NULL,            -- optional pin
        Summary             NVARCHAR(MAX)    NOT NULL,        -- the only required user input
        Channel             NVARCHAR(20)     NULL,            -- phone | email | in_person | sms | video | other
        Direction           NVARCHAR(20)     NULL,            -- inbound | outbound | internal
        Source              NVARCHAR(30)     NOT NULL CONSTRAINT DF_Encounters_Source DEFAULT ('manual'),
                                                              -- manual | zoom_phone | zoom_meeting | imported
        ExternalRef         NVARCHAR(200)    NULL,            -- future Zoom call id slot
        OccurredAt          DATETIME2        NULL,            -- when the conversation actually happened
        DurationSeconds     INT              NULL,            -- future Zoom
        RecordingUrl        NVARCHAR(500)    NULL,            -- future Zoom
        TranscriptText      NVARCHAR(MAX)    NULL,            -- future Zoom (or human-edited transcript)
        AssignedToUserId    UNIQUEIDENTIFIER NULL,            -- triage assign-to
        FollowUpDueDate     DATETIME2        NULL,            -- follow-up flag
        FollowUpCompletedAt DATETIME2        NULL,            -- clears the flag
        IsArchived          BIT              NOT NULL CONSTRAINT DF_Encounters_IsArchived DEFAULT (0),
        CreatedDate         DATETIME2        NOT NULL CONSTRAINT DF_Encounters_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy           UNIQUEIDENTIFIER NULL,
        CreatedByName       NVARCHAR(200)    NULL,
        ModifiedDate        DATETIME2        NULL,
        ModifiedBy          UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_Encounters PRIMARY KEY CLUSTERED (EncounterId),
        CONSTRAINT UQ_Encounters_VendorEncounterNumber UNIQUE (VendorId, EncounterNumber),
        CONSTRAINT FK_Encounters_Vendor         FOREIGN KEY (VendorId)         REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_Encounters_Member         FOREIGN KEY (MemberId)         REFERENCES oe.Members (MemberId),
        CONSTRAINT FK_Encounters_Case           FOREIGN KEY (CaseId)           REFERENCES oe.Cases (CaseId),
        CONSTRAINT FK_Encounters_ShareRequest   FOREIGN KEY (ShareRequestId)   REFERENCES oe.ShareRequests (ShareRequestId),
        CONSTRAINT FK_Encounters_AssignedToUser FOREIGN KEY (AssignedToUserId) REFERENCES oe.Users (UserId),
        CONSTRAINT FK_Encounters_CreatedByUser  FOREIGN KEY (CreatedBy)        REFERENCES oe.Users (UserId)
    );
    PRINT 'Created table oe.Encounters.';

    -- Triage queue: hot read on the dashboard.
    CREATE NONCLUSTERED INDEX IX_Encounters_Vendor_Triage
        ON oe.Encounters (VendorId)
        WHERE MemberId IS NULL;

    -- "Mine" / "Assigned to X" filter on the dashboard.
    CREATE NONCLUSTERED INDEX IX_Encounters_Vendor_AssignedTo
        ON oe.Encounters (VendorId, AssignedToUserId);

    -- Member detail tab (history of all encounters for a member, newest first).
    CREATE NONCLUSTERED INDEX IX_Encounters_Member_Created
        ON oe.Encounters (MemberId, CreatedDate DESC);

    -- Case detail Encounters tab.
    CREATE NONCLUSTERED INDEX IX_Encounters_Case
        ON oe.Encounters (CaseId)
        WHERE CaseId IS NOT NULL;

    -- Share request detail Encounters tab.
    CREATE NONCLUSTERED INDEX IX_Encounters_ShareRequest
        ON oe.Encounters (ShareRequestId)
        WHERE ShareRequestId IS NOT NULL;

    -- "Follow-ups due" filter — only rows with an open follow-up.
    CREATE NONCLUSTERED INDEX IX_Encounters_Vendor_FollowUp
        ON oe.Encounters (VendorId, FollowUpDueDate)
        WHERE FollowUpDueDate IS NOT NULL AND FollowUpCompletedAt IS NULL;

    -- Future Zoom dedupe / lookup by external call id.
    CREATE NONCLUSTERED INDEX IX_Encounters_Source_ExternalRef
        ON oe.Encounters (Source, ExternalRef)
        WHERE ExternalRef IS NOT NULL;
END
ELSE
BEGIN
    PRINT 'Table oe.Encounters already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Table: oe.EncounterAttachments
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'EncounterAttachments'
)
BEGIN
    CREATE TABLE oe.EncounterAttachments (
        AttachmentId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_EncounterAttachments_Id DEFAULT (NEWID()),
        EncounterId     UNIQUEIDENTIFIER NOT NULL,
        FileName        NVARCHAR(255)    NOT NULL,
        MimeType        NVARCHAR(100)    NULL,
        FileSize        BIGINT           NULL,
        BlobUrl         NVARCHAR(500)    NULL,
        BlobPath        NVARCHAR(500)    NULL,
        Description     NVARCHAR(500)    NULL,
        UploadedBy      NVARCHAR(100)    NULL,
        IsActive        BIT              NOT NULL CONSTRAINT DF_EncounterAttachments_IsActive DEFAULT (1),
        CreatedDate     DATETIME2        NOT NULL CONSTRAINT DF_EncounterAttachments_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy       UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_EncounterAttachments PRIMARY KEY CLUSTERED (AttachmentId),
        CONSTRAINT FK_EncounterAttachments_Encounter
            FOREIGN KEY (EncounterId) REFERENCES oe.Encounters (EncounterId) ON DELETE CASCADE
    );
    PRINT 'Created table oe.EncounterAttachments.';

    CREATE NONCLUSTERED INDEX IX_EncounterAttachments_Encounter
        ON oe.EncounterAttachments (EncounterId, IsActive);
END
ELSE
BEGIN
    PRINT 'Table oe.EncounterAttachments already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Verification SELECT
-- -----------------------------------------------------------------------------
SELECT TableName = t.name
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'oe'
  AND t.name IN ('Encounters', 'EncounterAttachments')
ORDER BY t.name;
GO

-- =============================================================================
-- ROLLBACK (commented out — drop children before parent)
-- =============================================================================
-- IF OBJECT_ID('oe.EncounterAttachments', 'U') IS NOT NULL DROP TABLE oe.EncounterAttachments;
-- IF OBJECT_ID('oe.Encounters',           'U') IS NOT NULL DROP TABLE oe.Encounters;
-- GO
