-- =============================================================================
-- Migration: add claim columns to oe.ShareRequests
-- Date:      2026-05-12
-- Branch:    feat/claim-share-requests
-- Spec:      docs/superpowers/specs/2026-05-12-claim-share-requests-design.md
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds two nullable columns to oe.ShareRequests and one supporting index.
--
--   1. ClaimedByUserId  UNIQUEIDENTIFIER NULL
--        FK -> oe.Users(UserId).
--        Holds the current claimer of a share request (a soft-ownership
--        signal — does not lock editing). NULL means unclaimed.
--
--   2. ClaimedAt        DATETIME2 NULL
--        UTC timestamp the current claim was set. NULL when unclaimed.
--        Updated by claim and reassign; cleared by unclaim.
--
--   3. IX_ShareRequests_Vendor_ClaimedBy (non-clustered index)
--        Covers the rail dropdown + list filter queries that scan
--        (VendorId, ClaimedByUserId).
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   Vendor agents and admins coordinate work on incoming share requests via
--   a new "Unclaimed / Claimed" tab in the vendor portal SR list rail.
--   Soft ownership: anyone in the vendor can still edit a claimed SR; the
--   claim column tells the team who is *working* it. See the spec doc for
--   the full UX, API, and permission matrix.
--
-- IDEMPOTENCY
-- -----------
--   Each block is wrapped in IF NOT EXISTS guards so this script can be
--   re-run without error. Re-running on a DB that already has the columns
--   is a no-op.
--
-- ROLLBACK
-- --------
--   See the ROLLBACK section at the bottom of this file. (Commented out by
--   default — uncomment and run only after confirming no app instance is
--   still reading the columns.)
--
-- APPLICATION DEPLOYMENT ORDER
-- ----------------------------
--   1. Apply this migration first.
--   2. Then deploy the backend/frontend code that reads/writes these
--      columns. (The code does NOT degrade gracefully if the columns are
--      missing — SELECTs will error.)
--
-- TEST-DB NOTES (allaboard-testing)
-- ---------------------------------
--   - Applied on: 2026-05-12 15:52 UTC
--   - Applied by: Claude, on behalf of Amar (via backend/scripts/run-claim-columns-migration.js
--     running inside the allaboard365-backend container)
--   - Result:     SUCCESS. All 7 batches OK. Verification SELECT returned the
--                 two expected rows:
--                   oe.ShareRequests.ClaimedByUserId  UNIQUEIDENTIFIER  NULL
--                   oe.ShareRequests.ClaimedAt        DATETIME2         NULL
--                 FK FK_ShareRequests_ClaimedByUser and index
--                 IX_ShareRequests_Vendor_ClaimedBy were created on this run.
--   - Notes:      Nothing surprising. Idempotent guards untested in this run
--                 (fresh columns); re-running this file is safe per the
--                 IF NOT EXISTS blocks but not yet exercised here.
--   - Post-apply manual checks (run these from the UI after the code deploys):
--       * SELECT TOP 5 ShareRequestId, ClaimedByUserId, ClaimedAt
--           FROM oe.ShareRequests; -> columns exist, values NULL
--       * Vendor portal /vendor/share-requests/:id rail renders both tabs
--       * Claim/unclaim/reassign round-trip works from the UI
--
-- PROD READINESS
-- --------------
--   This file is the single source of truth. Apply unmodified to prod after
--   the manual UI checks above pass on the testing environment.
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- Column: oe.ShareRequests.ClaimedByUserId
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM sys.columns c
    INNER JOIN sys.tables t  ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
    WHERE s.name = 'oe'
      AND t.name = 'ShareRequests'
      AND c.name = 'ClaimedByUserId'
)
BEGIN
    ALTER TABLE oe.ShareRequests
        ADD ClaimedByUserId UNIQUEIDENTIFIER NULL;
    PRINT 'Added column oe.ShareRequests.ClaimedByUserId.';
END
ELSE
BEGIN
    PRINT 'Column oe.ShareRequests.ClaimedByUserId already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Column: oe.ShareRequests.ClaimedAt
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM sys.columns c
    INNER JOIN sys.tables t  ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
    WHERE s.name = 'oe'
      AND t.name = 'ShareRequests'
      AND c.name = 'ClaimedAt'
)
BEGIN
    ALTER TABLE oe.ShareRequests
        ADD ClaimedAt DATETIME2 NULL;
    PRINT 'Added column oe.ShareRequests.ClaimedAt.';
END
ELSE
BEGIN
    PRINT 'Column oe.ShareRequests.ClaimedAt already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Foreign key: ClaimedByUserId -> oe.Users(UserId)
-- -----------------------------------------------------------------------------
-- We do NOT cascade delete. If a user is removed and they still have claimed
-- SRs, the FK will block the user delete — that is intentional. The cleanup
-- path is: admin reassigns or unclaims those SRs first.
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_ShareRequests_ClaimedByUser'
)
BEGIN
    ALTER TABLE oe.ShareRequests
        ADD CONSTRAINT FK_ShareRequests_ClaimedByUser
            FOREIGN KEY (ClaimedByUserId) REFERENCES oe.Users (UserId);
    PRINT 'Added FK FK_ShareRequests_ClaimedByUser.';
END
ELSE
BEGIN
    PRINT 'FK FK_ShareRequests_ClaimedByUser already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Index: (VendorId, ClaimedByUserId)
-- -----------------------------------------------------------------------------
-- Supports:
--   * GET /api/me/vendor/share-requests?claimed=true&claimedByUserId=<uuid>
--     (rail "Claimed" tab + dropdown filtered by user)
--   * The claimer-count subquery in /claimers (per-vendor per-user count)
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_ShareRequests_Vendor_ClaimedBy'
      AND object_id = OBJECT_ID('oe.ShareRequests')
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_ShareRequests_Vendor_ClaimedBy
        ON oe.ShareRequests (VendorId, ClaimedByUserId);
    PRINT 'Created index IX_ShareRequests_Vendor_ClaimedBy.';
END
ELSE
BEGIN
    PRINT 'Index IX_ShareRequests_Vendor_ClaimedBy already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Verification SELECT (safe to run any time)
-- -----------------------------------------------------------------------------
SELECT
    SchemaName  = s.name,
    TableName   = t.name,
    ColumnName  = c.name,
    DataType    = ty.name,
    IsNullable  = c.is_nullable
FROM sys.columns c
INNER JOIN sys.tables t   ON c.object_id = t.object_id
INNER JOIN sys.schemas s  ON t.schema_id  = s.schema_id
INNER JOIN sys.types ty   ON c.user_type_id = ty.user_type_id
WHERE s.name = 'oe'
  AND t.name = 'ShareRequests'
  AND c.name IN ('ClaimedByUserId', 'ClaimedAt');
GO

-- =============================================================================
-- ROLLBACK (commented out — uncomment only if you really mean it)
-- =============================================================================
-- IMPORTANT: drop in REVERSE order of creation:
--   1. Drop the FK first (otherwise the column ALTER will fail).
--   2. Drop the index.
--   3. Drop the columns.
--
-- IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_ShareRequests_ClaimedByUser')
--     ALTER TABLE oe.ShareRequests DROP CONSTRAINT FK_ShareRequests_ClaimedByUser;
-- GO
-- IF EXISTS (
--     SELECT 1 FROM sys.indexes
--     WHERE name = 'IX_ShareRequests_Vendor_ClaimedBy'
--       AND object_id = OBJECT_ID('oe.ShareRequests')
-- )
--     DROP INDEX IX_ShareRequests_Vendor_ClaimedBy ON oe.ShareRequests;
-- GO
-- IF EXISTS (
--     SELECT 1 FROM sys.columns c
--     INNER JOIN sys.tables t  ON c.object_id = t.object_id
--     INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
--     WHERE s.name = 'oe' AND t.name = 'ShareRequests' AND c.name = 'ClaimedAt'
-- )
--     ALTER TABLE oe.ShareRequests DROP COLUMN ClaimedAt;
-- GO
-- IF EXISTS (
--     SELECT 1 FROM sys.columns c
--     INNER JOIN sys.tables t  ON c.object_id = t.object_id
--     INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
--     WHERE s.name = 'oe' AND t.name = 'ShareRequests' AND c.name = 'ClaimedByUserId'
-- )
--     ALTER TABLE oe.ShareRequests DROP COLUMN ClaimedByUserId;
-- GO
