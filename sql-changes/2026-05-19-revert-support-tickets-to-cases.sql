-- =============================================================================
-- Migration: revert Support Tickets back to Cases (keep taxonomy + status set)
-- Date:      2026-05-19
-- Branch:    fix/backoffice/rename-cases-to-support-tickets
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Undoes the table/column/constraint renames from the earlier migrations on
--   this branch, returning the schema to "Cases" naming. The vendor-customizable
--   taxonomy tables stay (they keep their data), but their names change from
--   oe.SupportTicket* back to oe.Case*. The 4-status set (Open/In Progress/
--   Pending/Closed) and the encounter "no member" rename are NOT reverted.
--
--   Tables renamed (back):
--     oe.SupportTickets              -> oe.Cases
--     oe.SupportTicketNotes          -> oe.CaseNotes
--     oe.SupportTicketProviders      -> oe.CaseProviders
--     oe.SupportTicketDocuments      -> oe.CaseDocuments
--     oe.SupportTicketTypes          -> oe.CaseTypes
--     oe.SupportTicketSubcategories  -> oe.CaseSubcategories
--
--   Columns renamed:
--     oe.Cases.SupportTicketId         -> CaseId
--     oe.CaseNotes.SupportTicketId     -> CaseId
--     oe.CaseProviders.SupportTicketId -> CaseId
--     oe.CaseDocuments.SupportTicketId -> CaseId
--     oe.Cases.TicketNumber            -> CaseNumber
--     oe.Cases.TicketType              -> CaseType
--     oe.Cases.TicketSubcategory       -> CaseSubcategory
--     oe.Encounters.SupportTicketId    -> CaseId    (FK column)
--
--   Backfill TX-YYYY-NNNN ticket numbers to CASE-YYYY-NNNN (sequential after
--   max existing CASE- per vendor) so we don't ship mixed prefixes.
--
-- WHY
-- ---
--   Care team feedback: keep calling them "Cases" after all. The taxonomy
--   feature (admin-editable types/subcategories) and the trimmed status set
--   are keepers — only the noun changes.
--
-- IDEMPOTENCY
-- -----------
--   Every step is guarded by IF EXISTS / COL_LENGTH / OBJECT_ID checks. Safe
--   to re-run. The TX-prefix backfill is also a no-op once everyone is
--   migrated.
--
-- APPLICATION DEPLOYMENT ORDER
-- ----------------------------
--   1. Apply this migration AFTER the three earlier migrations on this branch.
--   2. Then deploy the backend + frontend (which call everything "Case" again).
--
-- TEST-DB NOTES (allaboard-testing)
-- ---------------------------------
--   - Applied on: 2026-05-19 UTC
--   - Applied by: Claude, on behalf of Amar (via backend/scripts/run-revert-support-tickets-to-cases-migration.js
--                 inside the allaboard365-backend container).
--   - Result:     SUCCESS. 17 batches OK. Verification confirmed:
--                   * 6 tables renamed back to oe.Case* (Cases, CaseNotes,
--                     CaseProviders, CaseDocuments, CaseTypes, CaseSubcategories).
--                     No oe.SupportTicket* tables remain.
--                   * oe.Cases columns: CaseId, CaseNumber, CaseType (NOT NULL),
--                     CaseSubcategory (NULL), SubcategoryDetail (NULL).
--                   * FK_Encounters_Case and IX_Encounters_Case both present;
--                     FK_Encounters_SupportTicket and IX_Encounters_SupportTicket gone.
--                   * 2 TX-prefixed rows backfilled to CASE-2026-0006 and CASE-2026-0007
--                     (sequential after the existing max CASE-2026-0005 per vendor).
--   - Notes:      The verification SELECT in step 9 originally referenced v.Name
--                 (a non-existent column on oe.Vendors); not relevant here since
--                 this file doesn't reference v.* — caught in #2's TEST-DB NOTES.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- 1. Drop outside FK + filtered index on oe.Encounters
-- -----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Encounters_SupportTicket')
BEGIN
    ALTER TABLE oe.Encounters DROP CONSTRAINT FK_Encounters_SupportTicket;
    PRINT 'Dropped FK_Encounters_SupportTicket.';
END
GO

IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Encounters_SupportTicket'
      AND object_id = OBJECT_ID('oe.Encounters')
)
BEGIN
    DROP INDEX IX_Encounters_SupportTicket ON oe.Encounters;
    PRINT 'Dropped IX_Encounters_SupportTicket.';
END
GO

-- -----------------------------------------------------------------------------
-- 2. Rename tables back to Case*
-- -----------------------------------------------------------------------------
IF OBJECT_ID('oe.SupportTickets',             'U') IS NOT NULL AND OBJECT_ID('oe.Cases',              'U') IS NULL
    EXEC sp_rename 'oe.SupportTickets',             'Cases',              'OBJECT';
IF OBJECT_ID('oe.SupportTicketNotes',         'U') IS NOT NULL AND OBJECT_ID('oe.CaseNotes',          'U') IS NULL
    EXEC sp_rename 'oe.SupportTicketNotes',         'CaseNotes',          'OBJECT';
IF OBJECT_ID('oe.SupportTicketProviders',     'U') IS NOT NULL AND OBJECT_ID('oe.CaseProviders',      'U') IS NULL
    EXEC sp_rename 'oe.SupportTicketProviders',     'CaseProviders',      'OBJECT';
IF OBJECT_ID('oe.SupportTicketDocuments',     'U') IS NOT NULL AND OBJECT_ID('oe.CaseDocuments',      'U') IS NULL
    EXEC sp_rename 'oe.SupportTicketDocuments',     'CaseDocuments',      'OBJECT';
IF OBJECT_ID('oe.SupportTicketTypes',         'U') IS NOT NULL AND OBJECT_ID('oe.CaseTypes',          'U') IS NULL
    EXEC sp_rename 'oe.SupportTicketTypes',         'CaseTypes',          'OBJECT';
IF OBJECT_ID('oe.SupportTicketSubcategories', 'U') IS NOT NULL AND OBJECT_ID('oe.CaseSubcategories',  'U') IS NULL
    EXEC sp_rename 'oe.SupportTicketSubcategories', 'CaseSubcategories',  'OBJECT';
PRINT 'Step 2: tables renamed back to Case*.';
GO

-- -----------------------------------------------------------------------------
-- 3. Rename PK columns back to CaseId
-- -----------------------------------------------------------------------------
IF COL_LENGTH('oe.Cases',          'SupportTicketId') IS NOT NULL
    EXEC sp_rename 'oe.Cases.SupportTicketId',          'CaseId', 'COLUMN';
IF COL_LENGTH('oe.CaseNotes',      'SupportTicketId') IS NOT NULL
    EXEC sp_rename 'oe.CaseNotes.SupportTicketId',      'CaseId', 'COLUMN';
IF COL_LENGTH('oe.CaseProviders',  'SupportTicketId') IS NOT NULL
    EXEC sp_rename 'oe.CaseProviders.SupportTicketId',  'CaseId', 'COLUMN';
IF COL_LENGTH('oe.CaseDocuments',  'SupportTicketId') IS NOT NULL
    EXEC sp_rename 'oe.CaseDocuments.SupportTicketId',  'CaseId', 'COLUMN';
PRINT 'Step 3: SupportTicketId -> CaseId on Cases* tables.';
GO

-- -----------------------------------------------------------------------------
-- 4. Rename FK column on oe.Encounters back to CaseId
-- -----------------------------------------------------------------------------
IF COL_LENGTH('oe.Encounters', 'SupportTicketId') IS NOT NULL
    EXEC sp_rename 'oe.Encounters.SupportTicketId', 'CaseId', 'COLUMN';
PRINT 'Step 4: oe.Encounters.SupportTicketId -> CaseId.';
GO

-- -----------------------------------------------------------------------------
-- 5. Rename data columns on oe.Cases back
-- -----------------------------------------------------------------------------
IF COL_LENGTH('oe.Cases', 'TicketNumber') IS NOT NULL
    EXEC sp_rename 'oe.Cases.TicketNumber',      'CaseNumber',      'COLUMN';
IF COL_LENGTH('oe.Cases', 'TicketType') IS NOT NULL
    EXEC sp_rename 'oe.Cases.TicketType',        'CaseType',        'COLUMN';
IF COL_LENGTH('oe.Cases', 'TicketSubcategory') IS NOT NULL
    EXEC sp_rename 'oe.Cases.TicketSubcategory', 'CaseSubcategory', 'COLUMN';
PRINT 'Step 5: data columns renamed on oe.Cases.';
GO

-- -----------------------------------------------------------------------------
-- 6. Rename constraints, indexes, defaults back to *_Cases_*
--    OBJECT_ID lookups use schema-qualified names — unqualified silently
--    misses oe.* (learned this on the forward rename).
-- -----------------------------------------------------------------------------

-- oe.Cases (was oe.SupportTickets)
IF OBJECT_ID('oe.PK_SupportTickets',                       'PK') IS NOT NULL EXEC sp_rename 'oe.PK_SupportTickets',                       'PK_Cases',                  'OBJECT';
IF OBJECT_ID('oe.UQ_SupportTickets_VendorTicketNumber',    'UQ') IS NOT NULL EXEC sp_rename 'oe.UQ_SupportTickets_VendorTicketNumber',    'UQ_Cases_VendorCaseNumber', 'OBJECT';
IF OBJECT_ID('oe.FK_SupportTickets_Vendor',                'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTickets_Vendor',                'FK_Cases_Vendor',           'OBJECT';
IF OBJECT_ID('oe.FK_SupportTickets_Member',                'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTickets_Member',                'FK_Cases_Member',           'OBJECT';
IF OBJECT_ID('oe.FK_SupportTickets_ClaimedByUser',         'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTickets_ClaimedByUser',         'FK_Cases_ClaimedByUser',    'OBJECT';
IF OBJECT_ID('oe.DF_SupportTickets_SupportTicketId',       'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTickets_SupportTicketId',       'DF_Cases_CaseId',           'OBJECT';
IF OBJECT_ID('oe.DF_SupportTickets_Status',                'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTickets_Status',                'DF_Cases_Status',           'OBJECT';
IF OBJECT_ID('oe.DF_SupportTickets_SubmittedDate',         'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTickets_SubmittedDate',         'DF_Cases_SubmittedDate',    'OBJECT';
IF OBJECT_ID('oe.DF_SupportTickets_CreatedDate',           'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTickets_CreatedDate',           'DF_Cases_CreatedDate',      'OBJECT';
IF OBJECT_ID('oe.DF_SupportTickets_TicketType',            'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTickets_TicketType',            'DF_Cases_CaseType',         'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTickets_Vendor_Status'     AND object_id = OBJECT_ID('oe.Cases'))
    EXEC sp_rename 'oe.Cases.IX_SupportTickets_Vendor_Status',     'IX_Cases_Vendor_Status',     'INDEX';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTickets_Vendor_ClaimedBy'  AND object_id = OBJECT_ID('oe.Cases'))
    EXEC sp_rename 'oe.Cases.IX_SupportTickets_Vendor_ClaimedBy',  'IX_Cases_Vendor_ClaimedBy',  'INDEX';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTickets_Member'            AND object_id = OBJECT_ID('oe.Cases'))
    EXEC sp_rename 'oe.Cases.IX_SupportTickets_Member',            'IX_Cases_Member',            'INDEX';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTickets_Vendor_TicketType' AND object_id = OBJECT_ID('oe.Cases'))
    EXEC sp_rename 'oe.Cases.IX_SupportTickets_Vendor_TicketType', 'IX_Cases_Vendor_CaseType',   'INDEX';
PRINT 'Step 6a: renamed constraints/indexes/defaults on oe.Cases.';
GO

-- oe.CaseNotes (was oe.SupportTicketNotes)
IF OBJECT_ID('oe.PK_SupportTicketNotes',              'PK') IS NOT NULL EXEC sp_rename 'oe.PK_SupportTicketNotes',              'PK_CaseNotes',             'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketNotes_SupportTicket','F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketNotes_SupportTicket','FK_CaseNotes_Case',        'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketNotes_NoteId',       'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketNotes_NoteId',       'DF_CaseNotes_NoteId',      'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketNotes_NoteType',     'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketNotes_NoteType',     'DF_CaseNotes_NoteType',    'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketNotes_IsInternal',   'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketNotes_IsInternal',   'DF_CaseNotes_IsInternal',  'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketNotes_CreatedDate',  'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketNotes_CreatedDate',  'DF_CaseNotes_CreatedDate', 'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTicketNotes_Ticket_Created' AND object_id = OBJECT_ID('oe.CaseNotes'))
    EXEC sp_rename 'oe.CaseNotes.IX_SupportTicketNotes_Ticket_Created', 'IX_CaseNotes_Case_Created', 'INDEX';
PRINT 'Step 6b: renamed constraints/indexes/defaults on oe.CaseNotes.';
GO

-- oe.CaseProviders (was oe.SupportTicketProviders)
IF OBJECT_ID('oe.PK_SupportTicketProviders',                'PK') IS NOT NULL EXEC sp_rename 'oe.PK_SupportTicketProviders',                'PK_CaseProviders',             'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketProviders_SupportTicket',  'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketProviders_SupportTicket',  'FK_CaseProviders_Case',        'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketProviders_Provider',       'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketProviders_Provider',       'FK_CaseProviders_Provider',    'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketProviders_Id',             'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketProviders_Id',             'DF_CaseProviders_Id',          'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketProviders_CreatedDate',    'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketProviders_CreatedDate',    'DF_CaseProviders_CreatedDate', 'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTicketProviders_Ticket' AND object_id = OBJECT_ID('oe.CaseProviders'))
    EXEC sp_rename 'oe.CaseProviders.IX_SupportTicketProviders_Ticket', 'IX_CaseProviders_Case', 'INDEX';
PRINT 'Step 6c: renamed constraints/indexes/defaults on oe.CaseProviders.';
GO

-- oe.CaseDocuments (was oe.SupportTicketDocuments)
IF OBJECT_ID('oe.PK_SupportTicketDocuments',                'PK') IS NOT NULL EXEC sp_rename 'oe.PK_SupportTicketDocuments',                'PK_CaseDocuments',             'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketDocuments_SupportTicket',  'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketDocuments_SupportTicket',  'FK_CaseDocuments_Case',        'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketDocuments_Id',             'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketDocuments_Id',             'DF_CaseDocuments_Id',          'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketDocuments_IsActive',       'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketDocuments_IsActive',       'DF_CaseDocuments_IsActive',    'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketDocuments_CreatedDate',    'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketDocuments_CreatedDate',    'DF_CaseDocuments_CreatedDate', 'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTicketDocuments_Ticket' AND object_id = OBJECT_ID('oe.CaseDocuments'))
    EXEC sp_rename 'oe.CaseDocuments.IX_SupportTicketDocuments_Ticket', 'IX_CaseDocuments_Case', 'INDEX';
PRINT 'Step 6d: renamed constraints/indexes/defaults on oe.CaseDocuments.';
GO

-- oe.CaseTypes (was oe.SupportTicketTypes) — taxonomy lookup table
IF OBJECT_ID('oe.PK_SupportTicketTypes',                   'PK') IS NOT NULL EXEC sp_rename 'oe.PK_SupportTicketTypes',                   'PK_CaseTypes',                  'OBJECT';
IF OBJECT_ID('oe.UQ_SupportTicketTypes_VendorCode',        'UQ') IS NOT NULL EXEC sp_rename 'oe.UQ_SupportTicketTypes_VendorCode',        'UQ_CaseTypes_VendorCode',       'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketTypes_Vendor',            'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketTypes_Vendor',            'FK_CaseTypes_Vendor',           'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketTypes_CreatedByUser',     'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketTypes_CreatedByUser',     'FK_CaseTypes_CreatedByUser',    'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketTypes_ModifiedByUser',    'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketTypes_ModifiedByUser',    'FK_CaseTypes_ModifiedByUser',   'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketTypes_TypeId',            'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketTypes_TypeId',            'DF_CaseTypes_TypeId',           'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketTypes_IsActive',          'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketTypes_IsActive',          'DF_CaseTypes_IsActive',         'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketTypes_SortOrder',         'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketTypes_SortOrder',         'DF_CaseTypes_SortOrder',        'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketTypes_CreatedDate',       'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketTypes_CreatedDate',       'DF_CaseTypes_CreatedDate',      'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTicketTypes_Vendor_Active' AND object_id = OBJECT_ID('oe.CaseTypes'))
    EXEC sp_rename 'oe.CaseTypes.IX_SupportTicketTypes_Vendor_Active', 'IX_CaseTypes_Vendor_Active', 'INDEX';
PRINT 'Step 6e: renamed constraints/indexes/defaults on oe.CaseTypes.';
GO

-- oe.CaseSubcategories (was oe.SupportTicketSubcategories)
IF OBJECT_ID('oe.PK_SupportTicketSubcategories',                'PK') IS NOT NULL EXEC sp_rename 'oe.PK_SupportTicketSubcategories',                'PK_CaseSubcategories',                'OBJECT';
IF OBJECT_ID('oe.UQ_SupportTicketSubcategories_VendorTypeCode', 'UQ') IS NOT NULL EXEC sp_rename 'oe.UQ_SupportTicketSubcategories_VendorTypeCode', 'UQ_CaseSubcategories_VendorTypeCode', 'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketSubcategories_Vendor',         'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketSubcategories_Vendor',         'FK_CaseSubcategories_Vendor',         'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketSubcategories_Type',           'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketSubcategories_Type',           'FK_CaseSubcategories_Type',           'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketSubcategories_CreatedByUser',  'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketSubcategories_CreatedByUser',  'FK_CaseSubcategories_CreatedByUser',  'OBJECT';
IF OBJECT_ID('oe.FK_SupportTicketSubcategories_ModifiedByUser', 'F')  IS NOT NULL EXEC sp_rename 'oe.FK_SupportTicketSubcategories_ModifiedByUser', 'FK_CaseSubcategories_ModifiedByUser', 'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketSubcategories_SubcategoryId',  'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketSubcategories_SubcategoryId',  'DF_CaseSubcategories_SubcategoryId',  'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketSubcategories_IsActive',       'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketSubcategories_IsActive',       'DF_CaseSubcategories_IsActive',       'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketSubcategories_SortOrder',      'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketSubcategories_SortOrder',      'DF_CaseSubcategories_SortOrder',      'OBJECT';
IF OBJECT_ID('oe.DF_SupportTicketSubcategories_CreatedDate',    'D')  IS NOT NULL EXEC sp_rename 'oe.DF_SupportTicketSubcategories_CreatedDate',    'DF_CaseSubcategories_CreatedDate',    'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTicketSubcategories_VendorType_Active' AND object_id = OBJECT_ID('oe.CaseSubcategories'))
    EXEC sp_rename 'oe.CaseSubcategories.IX_SupportTicketSubcategories_VendorType_Active', 'IX_CaseSubcategories_VendorType_Active', 'INDEX';
PRINT 'Step 6f: renamed constraints/indexes/defaults on oe.CaseSubcategories.';
GO

-- -----------------------------------------------------------------------------
-- 7. Re-add Encounters FK + filtered index with original names
-- -----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Encounters_Case')
BEGIN
    ALTER TABLE oe.Encounters
        ADD CONSTRAINT FK_Encounters_Case
            FOREIGN KEY (CaseId) REFERENCES oe.Cases (CaseId);
    PRINT 'Added FK_Encounters_Case.';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Encounters_Case'
      AND object_id = OBJECT_ID('oe.Encounters')
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_Encounters_Case
        ON oe.Encounters (CaseId)
        WHERE CaseId IS NOT NULL;
    PRINT 'Created IX_Encounters_Case.';
END
GO

-- -----------------------------------------------------------------------------
-- 8. Backfill TX-YYYY-NNNN -> CASE-YYYY-NNNN
--    Re-number after the max existing CASE- value per (Vendor, Year). No-op
--    once everyone is migrated. Uses ROW_NUMBER to allocate sequential slots.
-- -----------------------------------------------------------------------------
;WITH tx AS (
    SELECT
        c.CaseId,
        c.VendorId,
        c.CaseNumber,
        TheYear = SUBSTRING(c.CaseNumber, 4, 4),                -- "TX-YYYY-..." -> YYYY
        RN      = ROW_NUMBER() OVER (
                      PARTITION BY c.VendorId, SUBSTRING(c.CaseNumber, 4, 4)
                      ORDER BY c.CaseNumber
                  )
    FROM oe.Cases c
    WHERE c.CaseNumber LIKE 'TX-%'
), maxes AS (
    SELECT
        c.VendorId,
        TheYear = SUBSTRING(c.CaseNumber, 6, 4),                -- "CASE-YYYY-..." -> YYYY
        MaxSeq  = MAX(CAST(SUBSTRING(c.CaseNumber, 11, 10) AS INT))
    FROM oe.Cases c
    WHERE c.CaseNumber LIKE 'CASE-[0-9][0-9][0-9][0-9]-%'
    GROUP BY c.VendorId, SUBSTRING(c.CaseNumber, 6, 4)
)
UPDATE c
SET CaseNumber =
    'CASE-' + tx.TheYear + '-'
    + RIGHT('0000' + CAST(ISNULL(m.MaxSeq, 0) + tx.RN AS NVARCHAR(10)), 4)
FROM oe.Cases c
INNER JOIN tx ON tx.CaseId = c.CaseId
LEFT  JOIN maxes m ON m.VendorId = tx.VendorId AND m.TheYear = tx.TheYear;
PRINT 'Step 8: TX-prefixed CaseNumbers backfilled to CASE-prefix.';
GO

-- -----------------------------------------------------------------------------
-- 9. Verification
-- -----------------------------------------------------------------------------
PRINT '----- Renamed tables present -----';
SELECT TableName = t.name
FROM sys.tables t INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name = 'oe'
  AND t.name IN ('Cases', 'CaseNotes', 'CaseProviders', 'CaseDocuments',
                 'CaseTypes', 'CaseSubcategories',
                 'SupportTickets', 'SupportTicketNotes', 'SupportTicketProviders', 'SupportTicketDocuments',
                 'SupportTicketTypes', 'SupportTicketSubcategories')
ORDER BY t.name;

PRINT '----- oe.Cases data columns -----';
SELECT ColumnName = c.name, DataType = ty.name
FROM sys.columns c
INNER JOIN sys.tables t  ON c.object_id = t.object_id
INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
INNER JOIN sys.types ty  ON c.user_type_id = ty.user_type_id
WHERE s.name = 'oe' AND t.name = 'Cases'
  AND c.name IN ('CaseId','CaseNumber','CaseType','CaseSubcategory','SubcategoryDetail','SupportTicketId','TicketNumber','TicketType','TicketSubcategory');

PRINT '----- Encounters FK + index -----';
SELECT FkName = name FROM sys.foreign_keys WHERE name IN ('FK_Encounters_Case', 'FK_Encounters_SupportTicket');
SELECT IxName = name FROM sys.indexes WHERE name IN ('IX_Encounters_Case', 'IX_Encounters_SupportTicket') AND object_id = OBJECT_ID('oe.Encounters');

PRINT '----- Case numbers (any TX- left?) -----';
SELECT CaseNumber FROM oe.Cases ORDER BY CaseNumber;
GO
