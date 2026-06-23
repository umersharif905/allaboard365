-- =============================================================================
-- Migration: per-vendor Share Request types + free-text sub-type
-- Date:      2026-05-19
-- Branch:    feat/share-request/types
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Replaces the legacy "RequestType / Category / SubCategory" trio on
--   oe.ShareRequests with a per-vendor type list and a single free-text
--   sub-type field.
--
--   Tables created:
--
--     1. oe.VendorShareRequestTypes
--          Per-vendor list of available request types. Each vendor manages
--          their own list via the vendor admin UI. Hard-deletes from the
--          UI null out any dependent ShareRequests.RequestTypeId in the same
--          transaction (see backend route DELETE handler).
--
--   Columns added to oe.ShareRequests:
--
--     2. RequestTypeId  UNIQUEIDENTIFIER NULL
--          FK -> oe.VendorShareRequestTypes(TypeId). NULL means the type
--          was deleted (and the UI displays "—").
--
--     3. SubType        NVARCHAR(500) NULL
--          Free-text description of the specific surgery / procedure /
--          treatment (e.g. "inpatient knee replacement").
--
--   The legacy RequestType (string) and CategoryId columns are LEFT IN
--   PLACE for now. The backend stops reading them once the code in this
--   branch ships. A follow-up migration will drop them and the
--   oe.ShareRequestCategories lookup table once we've confirmed no
--   downstream consumer references them.
--
--   Seed + backfill:
--     * For every existing vendor, inserts the 5 default types:
--         Surgery - Inpatient
--         Surgery - Outpatient
--         Procedure
--         Treatment
--         Maternity
--     * Backfills every existing oe.ShareRequests row's RequestTypeId to
--       that vendor's "Procedure" row (per the design decision to migrate
--       all legacy types to a single default).
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   Care teams want type categories that match how they actually classify
--   work (surgeries with inpatient/outpatient split, procedures,
--   treatments, maternity) instead of the old generic Medical / Pharmacy
--   / Other split. The legacy three-row Type+Category+SubCategory UI is
--   collapsed to two rows: a vendor-managed type dropdown plus a single
--   free-text sub-type.
--
-- IDEMPOTENCY
-- -----------
--   Every CREATE / ALTER / INSERT is guarded by an existence check, so
--   this script can be re-run without error. The seed inserts only fire
--   for (VendorId, Name) pairs that do not already exist, and the
--   backfill only updates rows where RequestTypeId IS NULL.
--
-- ROLLBACK
-- --------
--   See the commented ROLLBACK block at the bottom. Reverse order: drop
--   FK, drop index, drop columns, drop table.
--
-- APPLICATION DEPLOYMENT ORDER
-- ----------------------------
--   1. Apply this migration first.
--   2. Then deploy the backend / frontend code that reads/writes these
--      columns and serves the new /api/me/vendor/request-types CRUD.
--   3. After a soak period, run the follow-up drop-legacy-columns
--      migration (not included here) to remove RequestType, CategoryId,
--      and oe.ShareRequestCategories.
--
-- TEST-DB NOTES (allaboard-testing)
-- ---------------------------------
--   - Applied on: 2026-05-19 (UTC)
--   - Applied by: Claude, on behalf of Amar (via
--                 backend/scripts/run-share-request-types-migration.js
--                 running inside the allaboard365-2-backend container).
--   - Result:     SUCCESS. All 11 batches OK.
--                 * Verification SELECT confirmed both new columns
--                   (RequestTypeId UNIQUEIDENTIFIER NULL,
--                    SubType NVARCHAR(500) NULL) and all 8 columns of
--                   the new oe.VendorShareRequestTypes table exist.
--                 * Seed inserted 40 type rows = 8 vendors × 5 defaults.
--                 * Backfill updated 13/13 existing oe.ShareRequests
--                   rows to RequestTypeId pointing at each vendor's
--                   "Procedure" row.
--   - Notes:      Idempotency guards untested in this run (all objects
--                 were fresh). Re-running is safe per the IF NOT EXISTS
--                 / NOT EXISTS / IS NULL guards.
--   - Post-apply manual checks (run from the UI after the code deploys):
--       * Vendor portal → Share Requests → New: dropdown lists the 5
--         seeded types; saving with a sub-type free-text persists both.
--       * Vendor portal → existing SR detail tab: Classification shows
--         "Procedure" (from backfill); edit + save updates type + sub-type.
--       * Vendor portal → Settings → Request Types
--         (/vendor/settings/request-types, VendorAdmin only): add, rename,
--         arrow reorder, and delete (including the "N share requests use
--         this type" confirm modal) all round-trip.
--
-- PROD READINESS
-- --------------
--   This file is the single source of truth. Apply unmodified to prod
--   after the manual UI checks above pass on the testing environment.
--   The accompanying runner at
--   backend/scripts/run-share-request-types-migration.js can be reused
--   verbatim by changing the container name to the prod backend.
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- Table: oe.VendorShareRequestTypes
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'VendorShareRequestTypes'
)
BEGIN
    CREATE TABLE oe.VendorShareRequestTypes (
        TypeId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_VendorShareRequestTypes_TypeId DEFAULT (NEWID()),
        VendorId      UNIQUEIDENTIFIER NOT NULL,
        Name          NVARCHAR(100)    NOT NULL,
        SortOrder     INT              NOT NULL CONSTRAINT DF_VendorShareRequestTypes_SortOrder DEFAULT (0),
        CreatedDate   DATETIME2        NOT NULL CONSTRAINT DF_VendorShareRequestTypes_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy     UNIQUEIDENTIFIER NULL,
        ModifiedDate  DATETIME2        NULL,
        ModifiedBy    UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_VendorShareRequestTypes              PRIMARY KEY CLUSTERED (TypeId),
        CONSTRAINT UQ_VendorShareRequestTypes_VendorName   UNIQUE (VendorId, Name),
        CONSTRAINT FK_VendorShareRequestTypes_Vendor       FOREIGN KEY (VendorId) REFERENCES oe.Vendors (VendorId)
    );
    PRINT 'Created table oe.VendorShareRequestTypes.';

    CREATE NONCLUSTERED INDEX IX_VendorShareRequestTypes_Vendor_Sort
        ON oe.VendorShareRequestTypes (VendorId, SortOrder);
END
ELSE
BEGIN
    PRINT 'Table oe.VendorShareRequestTypes already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Column: oe.ShareRequests.RequestTypeId
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM sys.columns c
    INNER JOIN sys.tables t  ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
    WHERE s.name = 'oe'
      AND t.name = 'ShareRequests'
      AND c.name = 'RequestTypeId'
)
BEGIN
    ALTER TABLE oe.ShareRequests
        ADD RequestTypeId UNIQUEIDENTIFIER NULL;
    PRINT 'Added column oe.ShareRequests.RequestTypeId.';
END
ELSE
BEGIN
    PRINT 'Column oe.ShareRequests.RequestTypeId already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Column: oe.ShareRequests.SubType
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1
    FROM sys.columns c
    INNER JOIN sys.tables t  ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
    WHERE s.name = 'oe'
      AND t.name = 'ShareRequests'
      AND c.name = 'SubType'
)
BEGIN
    ALTER TABLE oe.ShareRequests
        ADD SubType NVARCHAR(500) NULL;
    PRINT 'Added column oe.ShareRequests.SubType.';
END
ELSE
BEGIN
    PRINT 'Column oe.ShareRequests.SubType already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Foreign key: oe.ShareRequests.RequestTypeId -> oe.VendorShareRequestTypes
-- -----------------------------------------------------------------------------
-- No cascade. The DELETE in the vendor admin UI runs in a transaction that
-- explicitly NULLs out dependent rows before removing the type, so a cascade
-- would mask bugs in that path. A type with no dependents drops cleanly.
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_ShareRequests_RequestType'
)
BEGIN
    ALTER TABLE oe.ShareRequests
        ADD CONSTRAINT FK_ShareRequests_RequestType
            FOREIGN KEY (RequestTypeId) REFERENCES oe.VendorShareRequestTypes (TypeId);
    PRINT 'Added FK FK_ShareRequests_RequestType.';
END
ELSE
BEGIN
    PRINT 'FK FK_ShareRequests_RequestType already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Index: ShareRequests (VendorId, RequestTypeId)
-- -----------------------------------------------------------------------------
-- Supports the list filter (GET /api/me/vendor/share-requests?requestTypeId=...)
-- and the dependent-count check inside the DELETE handler.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_ShareRequests_Vendor_RequestType'
      AND object_id = OBJECT_ID('oe.ShareRequests')
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_ShareRequests_Vendor_RequestType
        ON oe.ShareRequests (VendorId, RequestTypeId);
    PRINT 'Created index IX_ShareRequests_Vendor_RequestType.';
END
ELSE
BEGIN
    PRINT 'Index IX_ShareRequests_Vendor_RequestType already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- Seed: 5 default types for every existing vendor
-- -----------------------------------------------------------------------------
-- Only inserts (VendorId, Name) pairs that don't already exist, so re-running
-- this block is a no-op.
DECLARE @DefaultTypes TABLE (Name NVARCHAR(100), SortOrder INT);
INSERT INTO @DefaultTypes (Name, SortOrder) VALUES
    ('Surgery - Inpatient',  10),
    ('Surgery - Outpatient', 20),
    ('Procedure',            30),
    ('Treatment',            40),
    ('Maternity',            50);

INSERT INTO oe.VendorShareRequestTypes (VendorId, Name, SortOrder)
SELECT v.VendorId, dt.Name, dt.SortOrder
FROM oe.Vendors v
CROSS JOIN @DefaultTypes dt
WHERE NOT EXISTS (
    SELECT 1
    FROM oe.VendorShareRequestTypes existing
    WHERE existing.VendorId = v.VendorId
      AND existing.Name     = dt.Name
);

PRINT CONCAT('Seeded default types. Rows inserted: ', @@ROWCOUNT);
GO

-- -----------------------------------------------------------------------------
-- Backfill: assign every existing ShareRequest to its vendor's "Procedure"
-- -----------------------------------------------------------------------------
-- Only fires for rows where RequestTypeId IS NULL, so re-running is a no-op.
UPDATE sr
SET sr.RequestTypeId = t.TypeId
FROM oe.ShareRequests sr
INNER JOIN oe.VendorShareRequestTypes t
        ON t.VendorId = sr.VendorId
       AND t.Name     = 'Procedure'
WHERE sr.RequestTypeId IS NULL;

PRINT CONCAT('Backfilled ShareRequests.RequestTypeId. Rows updated: ', @@ROWCOUNT);
GO

-- -----------------------------------------------------------------------------
-- Verification SELECTs (safe to run any time)
-- -----------------------------------------------------------------------------
SELECT
    SchemaName  = s.name,
    TableName   = t.name,
    ColumnName  = c.name,
    DataType    = ty.name,
    IsNullable  = c.is_nullable,
    MaxLength   = c.max_length
FROM sys.columns c
INNER JOIN sys.tables t   ON c.object_id = t.object_id
INNER JOIN sys.schemas s  ON t.schema_id  = s.schema_id
INNER JOIN sys.types ty   ON c.user_type_id = ty.user_type_id
WHERE s.name = 'oe'
  AND (
        (t.name = 'ShareRequests'            AND c.name IN ('RequestTypeId', 'SubType'))
     OR (t.name = 'VendorShareRequestTypes')
  )
ORDER BY t.name, c.column_id;
GO

SELECT
    VendorCount       = (SELECT COUNT(*) FROM oe.Vendors),
    TypeRowCount      = (SELECT COUNT(*) FROM oe.VendorShareRequestTypes),
    TypesPerVendorAvg = CAST(
        (SELECT COUNT(*) FROM oe.VendorShareRequestTypes) * 1.0
      / NULLIF((SELECT COUNT(*) FROM oe.Vendors), 0)
      AS DECIMAL(10,2)
    ),
    ShareRequestRows         = (SELECT COUNT(*) FROM oe.ShareRequests),
    ShareRequestRowsWithType = (SELECT COUNT(*) FROM oe.ShareRequests WHERE RequestTypeId IS NOT NULL);
GO

-- =============================================================================
-- ROLLBACK (commented out — uncomment only if you really mean it)
-- =============================================================================
-- IMPORTANT: drop in REVERSE order of creation:
--   1. Drop the FK first.
--   2. Drop the index on ShareRequests.
--   3. Drop the new columns on ShareRequests.
--   4. Drop the new table.
--
-- IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_ShareRequests_RequestType')
--     ALTER TABLE oe.ShareRequests DROP CONSTRAINT FK_ShareRequests_RequestType;
-- GO
-- IF EXISTS (
--     SELECT 1 FROM sys.indexes
--     WHERE name = 'IX_ShareRequests_Vendor_RequestType'
--       AND object_id = OBJECT_ID('oe.ShareRequests')
-- )
--     DROP INDEX IX_ShareRequests_Vendor_RequestType ON oe.ShareRequests;
-- GO
-- IF EXISTS (
--     SELECT 1 FROM sys.columns c
--     INNER JOIN sys.tables t  ON c.object_id = t.object_id
--     INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
--     WHERE s.name = 'oe' AND t.name = 'ShareRequests' AND c.name = 'SubType'
-- )
--     ALTER TABLE oe.ShareRequests DROP COLUMN SubType;
-- GO
-- IF EXISTS (
--     SELECT 1 FROM sys.columns c
--     INNER JOIN sys.tables t  ON c.object_id = t.object_id
--     INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
--     WHERE s.name = 'oe' AND t.name = 'ShareRequests' AND c.name = 'RequestTypeId'
-- )
--     ALTER TABLE oe.ShareRequests DROP COLUMN RequestTypeId;
-- GO
-- IF EXISTS (
--     SELECT 1 FROM sys.tables t
--     INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
--     WHERE s.name = 'oe' AND t.name = 'VendorShareRequestTypes'
-- )
--     DROP TABLE oe.VendorShareRequestTypes;
-- GO
