-- =============================================================================
-- Migration: link oe.Encounters to email messages
-- Date:      2026-06-02
-- Branch:    feat/backoffice/email
-- Spec:      docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds oe.Encounters.EmailMessageId (nullable, FK -> oe.EmailMessages) so an
--   email-channel encounter points at the exact message it represents. This is
--   the single canonical encounter<->message link (there is deliberately NO
--   reverse EncounterId column on oe.EmailMessages, which would be a circular FK).
--
--   No change is needed for the new Source value 'email': oe.Encounters.Source
--   has no CHECK constraint (allowed values are enforced in app code), so 'email'
--   simply joins manual | zoom_phone | zoom_meeting | imported. Email encounters
--   also set Channel='email' and ExternalRef=GraphMessageId, reusing the existing
--   IX_Encounters_Source_ExternalRef index for idempotency checks.
--
-- ORDER
-- -----
--   Run AFTER 2026-06-02-email-store.sql (oe.EmailMessages must exist first).
--
-- IDEMPOTENCY
-- -----------
--   Guarded by column/constraint existence checks; safe to re-run.
--
-- ROLLBACK
-- --------
--   See the commented ROLLBACK block at the bottom.
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- Guard: oe.EmailMessages must exist (created by 2026-06-02-email-store.sql).
IF OBJECT_ID('oe.EmailMessages', 'U') IS NULL
BEGIN
    RAISERROR('oe.EmailMessages does not exist. Run 2026-06-02-email-store.sql first.', 16, 1);
    RETURN;
END
GO

-- -----------------------------------------------------------------------------
-- Column: oe.Encounters.EmailMessageId
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Encounters') AND name = 'EmailMessageId'
)
BEGIN
    ALTER TABLE oe.Encounters ADD EmailMessageId UNIQUEIDENTIFIER NULL;
    PRINT 'Added column oe.Encounters.EmailMessageId.';
END
ELSE
BEGIN
    PRINT 'Column oe.Encounters.EmailMessageId already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- FK: oe.Encounters.EmailMessageId -> oe.EmailMessages.EmailMessageId
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Encounters_EmailMessage'
)
BEGIN
    ALTER TABLE oe.Encounters
        ADD CONSTRAINT FK_Encounters_EmailMessage
        FOREIGN KEY (EmailMessageId) REFERENCES oe.EmailMessages (EmailMessageId);
    PRINT 'Added FK_Encounters_EmailMessage.';
END
ELSE
BEGIN
    PRINT 'FK_Encounters_EmailMessage already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Index: lookup an encounter by its email message (and reverse).
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Encounters_EmailMessage' AND object_id = OBJECT_ID('oe.Encounters')
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_Encounters_EmailMessage
        ON oe.Encounters (EmailMessageId)
        WHERE EmailMessageId IS NOT NULL;
    PRINT 'Created index IX_Encounters_EmailMessage.';
END
ELSE
BEGIN
    PRINT 'Index IX_Encounters_EmailMessage already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Verification
-- -----------------------------------------------------------------------------
SELECT
    ColumnExists = CASE WHEN EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Encounters') AND name = 'EmailMessageId') THEN 1 ELSE 0 END,
    FkExists     = CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Encounters_EmailMessage') THEN 1 ELSE 0 END,
    IndexExists  = CASE WHEN EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Encounters_EmailMessage' AND object_id = OBJECT_ID('oe.Encounters')) THEN 1 ELSE 0 END;
GO

-- =============================================================================
-- ROLLBACK (commented out)
-- =============================================================================
-- IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Encounters_EmailMessage' AND object_id = OBJECT_ID('oe.Encounters'))
--     DROP INDEX IX_Encounters_EmailMessage ON oe.Encounters;
-- IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Encounters_EmailMessage')
--     ALTER TABLE oe.Encounters DROP CONSTRAINT FK_Encounters_EmailMessage;
-- IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Encounters') AND name = 'EmailMessageId')
--     ALTER TABLE oe.Encounters DROP COLUMN EmailMessageId;
-- GO
