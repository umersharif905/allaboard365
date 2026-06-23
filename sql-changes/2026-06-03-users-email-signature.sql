-- =============================================================================
-- Migration: oe.Users.EmailSignature (per-user Back Office email footer)
-- Date:      2026-06-03
-- Branch:    feat/backoffice/email
-- Spec:      docs/superpowers/specs/2026-06-02-back-office-email/design.md
-- =============================================================================
--
-- WHAT: A per-care-member email signature/footer they can customize in Profile
--       Settings. Used by the Back Office inbox on outbound mail (reply +
--       compose). If empty, the default "— {name} from the {vendor} Care Team…"
--       footer is used. The customer-facing "Ref: SR-…" line is always appended
--       automatically regardless of signature, to preserve correlation.
--
-- IDEMPOTENT: guarded by a column-existence check.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.Users') AND name='EmailSignature')
    ALTER TABLE oe.Users ADD EmailSignature NVARCHAR(MAX) NULL;
GO
PRINT 'oe.Users.EmailSignature ensured.';
GO

SELECT ColumnExists = CASE WHEN EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('oe.Users') AND name='EmailSignature') THEN 1 ELSE 0 END;
GO
