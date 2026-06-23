-- =============================================================================
-- Migration: add PreferredColor to oe.Users
-- Date:      2026-05-12
-- Branch:    sharing-request-status
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds one nullable column to oe.Users:
--
--     PreferredColor NVARCHAR(20) NULL
--       Stores a short palette key (e.g., 'red', 'sky', 'emerald') chosen by
--       the user from their profile. The frontend maps the key to a Tailwind
--       background+text class pair so the rendered color stays in-system and
--       theme-aware. NULL means "no preference set" — UI falls back to a
--       neutral gray.
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   Vendor agents and admins want a personal display color so it's quick to
--   scan a list of share requests and see who's working what. The color wraps
--   the claimer name as a pill (matches the status pill pattern).
--
-- IDEMPOTENCY
-- -----------
--   IF NOT EXISTS guard around the column add. Safe to re-run.
--
-- ROLLBACK
-- --------
--   See bottom of file. Commented out by default.
--
-- APPLICATION DEPLOYMENT ORDER
-- ----------------------------
--   1. Apply this migration first.
--   2. Deploy backend (reads/writes PreferredColor; tolerates NULL).
--   3. Deploy frontend (renders the color when present).
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns c
    INNER JOIN sys.tables t  ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
    WHERE s.name = 'oe'
      AND t.name = 'Users'
      AND c.name = 'PreferredColor'
)
BEGIN
    ALTER TABLE oe.Users
        ADD PreferredColor NVARCHAR(20) NULL;
    PRINT 'Added column oe.Users.PreferredColor.';
END
ELSE
BEGIN
    PRINT 'Column oe.Users.PreferredColor already exists — skipping.';
END
GO

-- Verification SELECT
SELECT
    SchemaName  = s.name,
    TableName   = t.name,
    ColumnName  = c.name,
    DataType    = ty.name,
    MaxLength   = c.max_length,
    IsNullable  = c.is_nullable
FROM sys.columns c
INNER JOIN sys.tables t   ON c.object_id = t.object_id
INNER JOIN sys.schemas s  ON t.schema_id  = s.schema_id
INNER JOIN sys.types ty   ON c.user_type_id = ty.user_type_id
WHERE s.name = 'oe'
  AND t.name = 'Users'
  AND c.name = 'PreferredColor';
GO

-- =============================================================================
-- ROLLBACK (commented — uncomment only if you really mean it)
-- =============================================================================
-- IF EXISTS (
--     SELECT 1 FROM sys.columns c
--     INNER JOIN sys.tables t  ON c.object_id = t.object_id
--     INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
--     WHERE s.name = 'oe' AND t.name = 'Users' AND c.name = 'PreferredColor'
-- )
--     ALTER TABLE oe.Users DROP COLUMN PreferredColor;
-- GO
