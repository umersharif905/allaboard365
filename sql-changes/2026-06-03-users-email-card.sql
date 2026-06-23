-- =============================================================================
-- Migration: oe.Users.EmailCard (per-user ShareWELL signature card config)
-- Date:      2026-06-03
-- Branch:    feat/backoffice/email
-- Spec:      docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT: JSON config for a care member's ShareWELL "business card" email
--       signature. Fields: { enabled, title, directPhone, email, website,
--       photoPath, compositePath }. The card (name from profile + these fields +
--       shared logo/ornament/main phone) is rendered in the Back Office email
--       footer. The free-text oe.Users.EmailSignature remains as an optional
--       line below the card. NULL = no card.
--
-- IDEMPOTENT: column-existence guarded.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.Users') AND name='EmailCard')
    ALTER TABLE oe.Users ADD EmailCard NVARCHAR(MAX) NULL;
GO
PRINT 'oe.Users.EmailCard ensured.';
GO

SELECT ColumnExists = CASE WHEN EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.Users') AND name='EmailCard') THEN 1 ELSE 0 END;
GO
