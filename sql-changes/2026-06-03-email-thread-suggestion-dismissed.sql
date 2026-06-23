-- =============================================================================
-- Migration: oe.EmailThreads.MatchSuggestionDismissed
-- Date:      2026-06-03
-- Branch:    feat/backoffice/email
-- Spec:      docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT: Adds a flag so a care-team "Deny" on a suggested member match sticks
--       (the suggestion won't keep reappearing). Matching is now suggestion-only
--       (Accept/Deny on the thread reader's right panel) rather than auto-linking.
--
-- IDEMPOTENT: guarded by a column-existence check.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.EmailThreads') AND name = 'MatchSuggestionDismissed'
)
BEGIN
    ALTER TABLE oe.EmailThreads
        ADD MatchSuggestionDismissed BIT NOT NULL
        CONSTRAINT DF_EmailThreads_MatchSuggestionDismissed DEFAULT (0);
    PRINT 'Added column oe.EmailThreads.MatchSuggestionDismissed.';
END
ELSE
BEGIN
    PRINT 'Column oe.EmailThreads.MatchSuggestionDismissed already exists — skipping.';
END
GO

SELECT ColumnExists = CASE WHEN EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.EmailThreads') AND name = 'MatchSuggestionDismissed'
) THEN 1 ELSE 0 END;
GO
