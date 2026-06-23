-- =============================================================================
-- Migration: oe.EmailMailboxSync.SentDeltaLink (Sent Items delta cursor)
-- Date:      2026-06-04
-- Branch:    feat/backoffice/email
-- Spec:      docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT: Adds a SentDeltaLink column to oe.EmailMailboxSync so the Sent Items
--       folder gets its own delta cursor, independent of the Inbox cursor
--       (DeltaLink). Lets emailSyncService.reconcileSentDelta() capture replies
--       a care-team member sent directly from Outlook (not the back office) and
--       reflect them on the thread as outbound messages.
--
--       A fresh sync (NULL SentDeltaLink) seeds the full Sent Items folder, so
--       the first run also backfills historical Outlook-sent replies.
--
-- ADDITIVE + IDEMPOTENT: nullable column, existence-guarded. Safe to run
--       pre-deploy (column simply sits unused until this branch is live).
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.EmailMailboxSync') AND name = 'SentDeltaLink'
)
BEGIN
    ALTER TABLE oe.EmailMailboxSync ADD SentDeltaLink NVARCHAR(MAX) NULL;
    PRINT 'Added column oe.EmailMailboxSync.SentDeltaLink.';
END
ELSE
BEGIN
    PRINT 'Column oe.EmailMailboxSync.SentDeltaLink already exists — skipping.';
END
GO

SELECT ColumnExists = CASE
    WHEN EXISTS (SELECT 1 FROM sys.columns
                 WHERE object_id = OBJECT_ID('oe.EmailMailboxSync') AND name = 'SentDeltaLink')
    THEN 1 ELSE 0 END;
GO
