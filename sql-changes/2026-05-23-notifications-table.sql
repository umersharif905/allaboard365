-- oe.Notifications: in-app notifications for back-office (vendor) users.
--
-- One row per recipient per event (per-user read state):
--   - 'mention'         — a teammate @-mentioned the recipient in a Share
--                         Request or Case note.
--   - 'form-submission' — a public form owned by the recipient's vendor
--                         received a new submission (fanned out to each active
--                         vendor user).
--
-- Vendor isolation: every row carries VendorId; the API filters on
-- RecipientUserId + VendorId so a user only ever sees their own vendor's rows.
-- TenantId is captured when known (resolved via the vendor's products) for
-- completeness; it is nullable because oe.Vendors has no direct TenantId.
--
-- This script is idempotent and safe to re-run.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'Notifications'
)
BEGIN
  CREATE TABLE oe.Notifications (
    NotificationId  UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_Notifications PRIMARY KEY DEFAULT NEWID(),
    RecipientUserId UNIQUEIDENTIFIER NOT NULL,
    VendorId        UNIQUEIDENTIFIER NULL,
    TenantId        UNIQUEIDENTIFIER NULL,
    Type            NVARCHAR(40)  NOT NULL,           -- 'mention' | 'form-submission'
    ContextType     NVARCHAR(40)  NULL,               -- 'share-request' | 'case' | 'form-submission'
    ContextId       UNIQUEIDENTIFIER NULL,            -- ShareRequestId / CaseId / SubmissionId
    ContextLabel    NVARCHAR(255) NULL,               -- e.g. RequestNumber / CaseNumber / form title
    ActorUserId     UNIQUEIDENTIFIER NULL,            -- who triggered it (note author); null for system
    ActorName       NVARCHAR(255) NULL,
    Body            NVARCHAR(1000) NULL,              -- note snippet
    Href            NVARCHAR(500) NULL,               -- in-app deep link
    IsRead          BIT NOT NULL CONSTRAINT DF_Notifications_IsRead DEFAULT 0,
    ReadDate        DATETIME2 NULL,
    CreatedDate     DATETIME2 NOT NULL CONSTRAINT DF_Notifications_CreatedDate DEFAULT SYSUTCDATETIME()
  );

  -- List query: newest-first per recipient (optionally scoped to a vendor).
  CREATE INDEX IX_Notifications_Recipient_Created
    ON oe.Notifications (RecipientUserId, VendorId, CreatedDate DESC);

  -- Unread-badge count per recipient.
  CREATE INDEX IX_Notifications_Recipient_Unread
    ON oe.Notifications (RecipientUserId, VendorId, IsRead);

  -- Dedupe guard for form-submission fan-out (one notification per
  -- recipient per submission) and for re-processed events.
  CREATE INDEX IX_Notifications_Context
    ON oe.Notifications (RecipientUserId, Type, ContextId);
END
GO
