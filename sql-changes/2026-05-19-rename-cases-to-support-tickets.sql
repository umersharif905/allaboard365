-- =============================================================================
-- Migration: rename oe.Cases* -> oe.SupportTickets*, add ticket taxonomy
-- Date:      2026-05-19
-- Branch:    fix/backoffice/rename-cases-to-support-tickets
-- Spec:      docs/superpowers/specs/2026-05-19-rename-cases-to-support-tickets-design.md
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Renames the back-office Cases feature (added 2026-05-14) to Support Tickets,
--   and adds a TicketType/TicketSubcategory/SubcategoryDetail taxonomy to the
--   parent table. Share Requests are NOT touched.
--
--   Renamed tables:
--     oe.Cases           -> oe.SupportTickets
--     oe.CaseNotes       -> oe.SupportTicketNotes
--     oe.CaseProviders   -> oe.SupportTicketProviders
--     oe.CaseDocuments   -> oe.SupportTicketDocuments
--
--   Renamed columns:
--     oe.SupportTickets.CaseId          -> SupportTicketId   (PK)
--     oe.SupportTickets.CaseNumber      -> TicketNumber
--     oe.SupportTicketNotes.CaseId      -> SupportTicketId   (FK)
--     oe.SupportTicketProviders.CaseId  -> SupportTicketId   (FK)
--     oe.SupportTicketDocuments.CaseId  -> SupportTicketId   (FK)
--     oe.Encounters.CaseId              -> SupportTicketId   (FK; ShareRequestId
--                                         column is UNTOUCHED)
--
--   New columns on oe.SupportTickets:
--     TicketType         NVARCHAR(50)  NOT NULL  DEFAULT 'reimbursement'
--                        CHECK IN ('reimbursement', 'billing',
--                                  'encounter_escalation', 'complaint', 'appeals')
--     TicketSubcategory  NVARCHAR(50)  NULL
--                        CHECK against full subcategory universe (NULL allowed)
--     SubcategoryDetail  NVARCHAR(MAX) NULL
--
--   Status set swap (back-filled in this migration):
--     New                    -> Open
--     Claims                 -> In Progress
--     Billing/Reimbursement  -> In Progress
--     Pending                -> Waiting
--     High Priority          -> In Progress     (FIDELITY LOSS — flagged)
--     Closed                 -> Closed
--
--   Existing CASE-YYYY-NNNN ticket numbers are kept as-is. New rows generate
--   TX-YYYY-NNNN via app code (no SQL backfill).
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   The care team is split on what "Cases" means. Renaming to Support Tickets
--   removes the ambiguity. Share Requests stay a distinct concept. The
--   taxonomy columns let the care team classify each ticket at creation.
--
-- IDEMPOTENCY
-- -----------
--   Every block is guarded with IF EXISTS / IF NOT EXISTS. The script is NOT
--   wrapped in a single transaction — sp_rename auto-commits and the runner
--   splits on GO, so each batch runs in its own request. Re-running is safe
--   because the guards skip already-applied steps.
--
-- ROLLBACK
-- --------
--   See the commented ROLLBACK section at the bottom. The status backfill is
--   many-to-one (multiple old statuses collapse into "In Progress"), so the
--   reverse cannot perfectly restore the old values.
--
-- APPLICATION DEPLOYMENT ORDER
-- ----------------------------
--   1. Apply this migration.
--   2. Then deploy the backend/frontend code that references oe.SupportTickets
--      and the new columns. The code does NOT degrade gracefully if the
--      rename hasn't run yet.
--
-- TEST-DB NOTES (allaboard-testing)
-- ---------------------------------
--   - Applied on: 2026-05-19 UTC
--   - Applied by: Claude, on behalf of Amar (via backend/scripts/run-rename-cases-migration.js
--                 inside the allaboard365-backend container).
--   - Result:     SUCCESS after two amendments. 23 batches OK on the final run.
--                 Verification queries confirmed:
--                   * 4 renamed tables present (SupportTickets, SupportTicketNotes,
--                     SupportTicketProviders, SupportTicketDocuments). Old oe.Cases* gone.
--                   * New columns: TicketType NOT NULL (default 'reimbursement'),
--                     TicketSubcategory NULL, SubcategoryDetail NULL.
--                   * 5 CHECK + default constraints renamed/recreated; Status default
--                     is now 'Open'.
--                   * FK_Encounters_SupportTicket and IX_Encounters_SupportTicket (filtered
--                     index, recreated on the renamed column) both present.
--                   * Status backfill: 5 existing rows, all transitioned New -> Open.
--                   * Existing CASE-YYYY-NNNN ticket numbers preserved; new rows will
--                     generate TX-YYYY-NNNN via app code.
--   - Amendments needed during the run (already folded into this file):
--       1. Step 1 needed to also drop filtered index IX_Encounters_Case (depends on
--          CaseId column). Recreated in step 7 as IX_Encounters_SupportTicket.
--       2. Step 6 OBJECT_ID() lookups for default/FK/PK constraints needed the 'oe.'
--          schema prefix — unqualified OBJECT_ID searches the caller's default schema
--          and silently returned NULL, causing the renames to be skipped on the first
--          run. Re-run with the fix completed all renames cleanly.
--       3. Step 11 was made robust: it now finds whichever default constraint is
--          currently bound to Status (legacy DF_Cases_Status OR renamed DF_SupportTickets_Status)
--          via sys.default_constraints metadata, drops it, then adds the new 'Open'
--          default. Safe to re-run.
--
-- PROD READINESS
-- --------------
--   This file is the single source of truth. Apply unmodified to prod after
--   dev verification.
--
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- 1. Drop outside FK + filtered index on oe.Encounters that depend on CaseId.
--    Both are recreated at step 7 with new names pointing at SupportTicketId.
-- -----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Encounters_Case')
BEGIN
    ALTER TABLE oe.Encounters DROP CONSTRAINT FK_Encounters_Case;
    PRINT 'Dropped FK_Encounters_Case.';
END
ELSE
BEGIN
    PRINT 'FK_Encounters_Case not present — skipping.';
END
GO

IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Encounters_Case'
      AND object_id = OBJECT_ID('oe.Encounters')
)
BEGIN
    DROP INDEX IX_Encounters_Case ON oe.Encounters;
    PRINT 'Dropped IX_Encounters_Case (filtered index on CaseId — recreated at step 7).';
END
ELSE
BEGIN
    PRINT 'IX_Encounters_Case not present — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- 2. Rename tables (parent first, then children — order is cosmetic for sp_rename)
-- -----------------------------------------------------------------------------
IF OBJECT_ID('oe.Cases',          'U') IS NOT NULL AND OBJECT_ID('oe.SupportTickets',          'U') IS NULL
    EXEC sp_rename 'oe.Cases',          'SupportTickets',          'OBJECT';
IF OBJECT_ID('oe.CaseNotes',      'U') IS NOT NULL AND OBJECT_ID('oe.SupportTicketNotes',      'U') IS NULL
    EXEC sp_rename 'oe.CaseNotes',      'SupportTicketNotes',      'OBJECT';
IF OBJECT_ID('oe.CaseProviders',  'U') IS NOT NULL AND OBJECT_ID('oe.SupportTicketProviders',  'U') IS NULL
    EXEC sp_rename 'oe.CaseProviders',  'SupportTicketProviders',  'OBJECT';
IF OBJECT_ID('oe.CaseDocuments',  'U') IS NOT NULL AND OBJECT_ID('oe.SupportTicketDocuments',  'U') IS NULL
    EXEC sp_rename 'oe.CaseDocuments',  'SupportTicketDocuments',  'OBJECT';
PRINT 'Step 2: tables renamed.';
GO

-- -----------------------------------------------------------------------------
-- 3. Rename PK columns CaseId -> SupportTicketId on each renamed table
-- -----------------------------------------------------------------------------
IF COL_LENGTH('oe.SupportTickets',          'CaseId') IS NOT NULL
    EXEC sp_rename 'oe.SupportTickets.CaseId',          'SupportTicketId', 'COLUMN';
IF COL_LENGTH('oe.SupportTicketNotes',      'CaseId') IS NOT NULL
    EXEC sp_rename 'oe.SupportTicketNotes.CaseId',      'SupportTicketId', 'COLUMN';
IF COL_LENGTH('oe.SupportTicketProviders',  'CaseId') IS NOT NULL
    EXEC sp_rename 'oe.SupportTicketProviders.CaseId',  'SupportTicketId', 'COLUMN';
IF COL_LENGTH('oe.SupportTicketDocuments',  'CaseId') IS NOT NULL
    EXEC sp_rename 'oe.SupportTicketDocuments.CaseId',  'SupportTicketId', 'COLUMN';
PRINT 'Step 3: CaseId -> SupportTicketId on renamed tables.';
GO

-- -----------------------------------------------------------------------------
-- 4. Rename FK column on oe.Encounters: CaseId -> SupportTicketId
-- -----------------------------------------------------------------------------
IF COL_LENGTH('oe.Encounters', 'CaseId') IS NOT NULL
    EXEC sp_rename 'oe.Encounters.CaseId', 'SupportTicketId', 'COLUMN';
PRINT 'Step 4: oe.Encounters.CaseId -> SupportTicketId.';
GO

-- -----------------------------------------------------------------------------
-- 5. Rename CaseNumber -> TicketNumber on oe.SupportTickets
-- -----------------------------------------------------------------------------
IF COL_LENGTH('oe.SupportTickets', 'CaseNumber') IS NOT NULL
    EXEC sp_rename 'oe.SupportTickets.CaseNumber', 'TicketNumber', 'COLUMN';
PRINT 'Step 5: CaseNumber -> TicketNumber.';
GO

-- -----------------------------------------------------------------------------
-- 6. Rename constraints / indexes / defaults
-- -----------------------------------------------------------------------------
-- oe.SupportTickets (was oe.Cases). Constraint names need the schema prefix —
-- OBJECT_ID on an unqualified name only searches the caller's default schema
-- and silently misses oe.*.
IF OBJECT_ID('oe.PK_Cases',                  'PK') IS NOT NULL EXEC sp_rename 'oe.PK_Cases',                  'PK_SupportTickets',                  'OBJECT';
IF OBJECT_ID('oe.UQ_Cases_VendorCaseNumber', 'UQ') IS NOT NULL EXEC sp_rename 'oe.UQ_Cases_VendorCaseNumber', 'UQ_SupportTickets_VendorTicketNumber','OBJECT';
IF OBJECT_ID('oe.FK_Cases_Vendor',           'F')  IS NOT NULL EXEC sp_rename 'oe.FK_Cases_Vendor',           'FK_SupportTickets_Vendor',           'OBJECT';
IF OBJECT_ID('oe.FK_Cases_Member',           'F')  IS NOT NULL EXEC sp_rename 'oe.FK_Cases_Member',           'FK_SupportTickets_Member',           'OBJECT';
IF OBJECT_ID('oe.FK_Cases_ClaimedByUser',    'F')  IS NOT NULL EXEC sp_rename 'oe.FK_Cases_ClaimedByUser',    'FK_SupportTickets_ClaimedByUser',    'OBJECT';
IF OBJECT_ID('oe.DF_Cases_CaseId',           'D')  IS NOT NULL EXEC sp_rename 'oe.DF_Cases_CaseId',           'DF_SupportTickets_SupportTicketId',  'OBJECT';
IF OBJECT_ID('oe.DF_Cases_Status',           'D')  IS NOT NULL EXEC sp_rename 'oe.DF_Cases_Status',           'DF_SupportTickets_Status',           'OBJECT';
IF OBJECT_ID('oe.DF_Cases_SubmittedDate',    'D')  IS NOT NULL EXEC sp_rename 'oe.DF_Cases_SubmittedDate',    'DF_SupportTickets_SubmittedDate',    'OBJECT';
IF OBJECT_ID('oe.DF_Cases_CreatedDate',      'D')  IS NOT NULL EXEC sp_rename 'oe.DF_Cases_CreatedDate',      'DF_SupportTickets_CreatedDate',      'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Cases_Vendor_Status'    AND object_id = OBJECT_ID('oe.SupportTickets'))
    EXEC sp_rename 'oe.SupportTickets.IX_Cases_Vendor_Status',    'IX_SupportTickets_Vendor_Status',    'INDEX';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Cases_Vendor_ClaimedBy' AND object_id = OBJECT_ID('oe.SupportTickets'))
    EXEC sp_rename 'oe.SupportTickets.IX_Cases_Vendor_ClaimedBy', 'IX_SupportTickets_Vendor_ClaimedBy', 'INDEX';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Cases_Member'           AND object_id = OBJECT_ID('oe.SupportTickets'))
    EXEC sp_rename 'oe.SupportTickets.IX_Cases_Member',           'IX_SupportTickets_Member',           'INDEX';
PRINT 'Step 6a: renamed constraints/indexes/defaults on oe.SupportTickets.';
GO

-- oe.SupportTicketNotes (was oe.CaseNotes)
IF OBJECT_ID('oe.PK_CaseNotes',                'PK') IS NOT NULL EXEC sp_rename 'oe.PK_CaseNotes',                'PK_SupportTicketNotes',                'OBJECT';
IF OBJECT_ID('oe.FK_CaseNotes_Case',           'F')  IS NOT NULL EXEC sp_rename 'oe.FK_CaseNotes_Case',           'FK_SupportTicketNotes_SupportTicket',  'OBJECT';
IF OBJECT_ID('oe.DF_CaseNotes_NoteId',         'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseNotes_NoteId',         'DF_SupportTicketNotes_NoteId',         'OBJECT';
IF OBJECT_ID('oe.DF_CaseNotes_NoteType',       'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseNotes_NoteType',       'DF_SupportTicketNotes_NoteType',       'OBJECT';
IF OBJECT_ID('oe.DF_CaseNotes_IsInternal',     'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseNotes_IsInternal',     'DF_SupportTicketNotes_IsInternal',     'OBJECT';
IF OBJECT_ID('oe.DF_CaseNotes_CreatedDate',    'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseNotes_CreatedDate',    'DF_SupportTicketNotes_CreatedDate',    'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CaseNotes_Case_Created' AND object_id = OBJECT_ID('oe.SupportTicketNotes'))
    EXEC sp_rename 'oe.SupportTicketNotes.IX_CaseNotes_Case_Created', 'IX_SupportTicketNotes_Ticket_Created', 'INDEX';
PRINT 'Step 6b: renamed constraints/indexes/defaults on oe.SupportTicketNotes.';
GO

-- oe.SupportTicketProviders (was oe.CaseProviders)
IF OBJECT_ID('oe.PK_CaseProviders',              'PK') IS NOT NULL EXEC sp_rename 'oe.PK_CaseProviders',              'PK_SupportTicketProviders',                'OBJECT';
IF OBJECT_ID('oe.FK_CaseProviders_Case',         'F')  IS NOT NULL EXEC sp_rename 'oe.FK_CaseProviders_Case',         'FK_SupportTicketProviders_SupportTicket',  'OBJECT';
IF OBJECT_ID('oe.FK_CaseProviders_Provider',     'F')  IS NOT NULL EXEC sp_rename 'oe.FK_CaseProviders_Provider',     'FK_SupportTicketProviders_Provider',       'OBJECT';
IF OBJECT_ID('oe.DF_CaseProviders_Id',           'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseProviders_Id',           'DF_SupportTicketProviders_Id',             'OBJECT';
IF OBJECT_ID('oe.DF_CaseProviders_CreatedDate',  'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseProviders_CreatedDate',  'DF_SupportTicketProviders_CreatedDate',    'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CaseProviders_Case' AND object_id = OBJECT_ID('oe.SupportTicketProviders'))
    EXEC sp_rename 'oe.SupportTicketProviders.IX_CaseProviders_Case', 'IX_SupportTicketProviders_Ticket', 'INDEX';
PRINT 'Step 6c: renamed constraints/indexes/defaults on oe.SupportTicketProviders.';
GO

-- oe.SupportTicketDocuments (was oe.CaseDocuments)
IF OBJECT_ID('oe.PK_CaseDocuments',              'PK') IS NOT NULL EXEC sp_rename 'oe.PK_CaseDocuments',              'PK_SupportTicketDocuments',                'OBJECT';
IF OBJECT_ID('oe.FK_CaseDocuments_Case',         'F')  IS NOT NULL EXEC sp_rename 'oe.FK_CaseDocuments_Case',         'FK_SupportTicketDocuments_SupportTicket',  'OBJECT';
IF OBJECT_ID('oe.DF_CaseDocuments_Id',           'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseDocuments_Id',           'DF_SupportTicketDocuments_Id',             'OBJECT';
IF OBJECT_ID('oe.DF_CaseDocuments_IsActive',     'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseDocuments_IsActive',     'DF_SupportTicketDocuments_IsActive',       'OBJECT';
IF OBJECT_ID('oe.DF_CaseDocuments_CreatedDate',  'D')  IS NOT NULL EXEC sp_rename 'oe.DF_CaseDocuments_CreatedDate',  'DF_SupportTicketDocuments_CreatedDate',    'OBJECT';
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CaseDocuments_Case' AND object_id = OBJECT_ID('oe.SupportTicketDocuments'))
    EXEC sp_rename 'oe.SupportTicketDocuments.IX_CaseDocuments_Case', 'IX_SupportTicketDocuments_Ticket', 'INDEX';
PRINT 'Step 6d: renamed constraints/indexes/defaults on oe.SupportTicketDocuments.';
GO

-- -----------------------------------------------------------------------------
-- 7. Re-add the Encounters FK + filtered index with new names pointing at the
--    renamed column.
-- -----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Encounters_SupportTicket')
BEGIN
    ALTER TABLE oe.Encounters
        ADD CONSTRAINT FK_Encounters_SupportTicket
            FOREIGN KEY (SupportTicketId) REFERENCES oe.SupportTickets (SupportTicketId);
    PRINT 'Added FK_Encounters_SupportTicket.';
END
ELSE
BEGIN
    PRINT 'FK_Encounters_SupportTicket already exists — skipping.';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Encounters_SupportTicket'
      AND object_id = OBJECT_ID('oe.Encounters')
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_Encounters_SupportTicket
        ON oe.Encounters (SupportTicketId)
        WHERE SupportTicketId IS NOT NULL;
    PRINT 'Created IX_Encounters_SupportTicket (filtered index on new column).';
END
ELSE
BEGIN
    PRINT 'IX_Encounters_SupportTicket already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- 8. Add new columns on oe.SupportTickets
-- -----------------------------------------------------------------------------
IF COL_LENGTH('oe.SupportTickets', 'TicketType') IS NULL
BEGIN
    ALTER TABLE oe.SupportTickets
        ADD TicketType NVARCHAR(50) NOT NULL
            CONSTRAINT DF_SupportTickets_TicketType DEFAULT ('reimbursement');
    PRINT 'Added column oe.SupportTickets.TicketType.';
END
ELSE
BEGIN
    PRINT 'Column oe.SupportTickets.TicketType already exists — skipping.';
END
GO

IF COL_LENGTH('oe.SupportTickets', 'TicketSubcategory') IS NULL
BEGIN
    ALTER TABLE oe.SupportTickets ADD TicketSubcategory NVARCHAR(50) NULL;
    PRINT 'Added column oe.SupportTickets.TicketSubcategory.';
END
ELSE
BEGIN
    PRINT 'Column oe.SupportTickets.TicketSubcategory already exists — skipping.';
END
GO

IF COL_LENGTH('oe.SupportTickets', 'SubcategoryDetail') IS NULL
BEGIN
    ALTER TABLE oe.SupportTickets ADD SubcategoryDetail NVARCHAR(MAX) NULL;
    PRINT 'Added column oe.SupportTickets.SubcategoryDetail.';
END
ELSE
BEGIN
    PRINT 'Column oe.SupportTickets.SubcategoryDetail already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- 9. CHECK constraints
-- -----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SupportTickets_TicketType')
BEGIN
    ALTER TABLE oe.SupportTickets WITH CHECK
        ADD CONSTRAINT CK_SupportTickets_TicketType
            CHECK (TicketType IN ('reimbursement', 'billing', 'encounter_escalation', 'complaint', 'appeals'));
    PRINT 'Added CK_SupportTickets_TicketType.';
END
ELSE
BEGIN
    PRINT 'CK_SupportTickets_TicketType already exists — skipping.';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SupportTickets_TicketSubcategory')
BEGIN
    ALTER TABLE oe.SupportTickets WITH CHECK
        ADD CONSTRAINT CK_SupportTickets_TicketSubcategory
            CHECK (TicketSubcategory IS NULL OR TicketSubcategory IN (
                -- reimbursement
                'oon_copay', 'preventative', 'other',
                -- billing
                'provider_invoice', 'negotiation', 'recovery', 'claims_cob',
                -- encounter_escalation
                'needs_follow_up', 'issue_raised', 'routed_to_team',
                -- complaint
                'service_quality', 'process_outcome', 'privacy',
                -- appeals
                'denied_share', 'denied_reimbursement', 'amount_dispute', 'second_level'
            ));
    PRINT 'Added CK_SupportTickets_TicketSubcategory.';
END
ELSE
BEGIN
    PRINT 'CK_SupportTickets_TicketSubcategory already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- 10. Status backfill (old Cases values -> new ticket-flavored values)
-- -----------------------------------------------------------------------------
UPDATE oe.SupportTickets SET Status = 'Open'        WHERE Status = 'New';
UPDATE oe.SupportTickets SET Status = 'In Progress' WHERE Status IN ('Claims', 'Billing/Reimbursement', 'High Priority');
UPDATE oe.SupportTickets SET Status = 'Waiting'     WHERE Status = 'Pending';
-- 'Closed' is unchanged.
PRINT 'Step 10: status backfill complete.';
GO

-- -----------------------------------------------------------------------------
-- 11. Replace whichever default is currently bound to Status with 'Open'.
--     Robust against either DF_Cases_Status (legacy) or DF_SupportTickets_Status
--     (renamed) being present — finds the actual binding via metadata.
-- -----------------------------------------------------------------------------
DECLARE @df_name SYSNAME;
SELECT @df_name = dc.name
FROM sys.default_constraints dc
INNER JOIN sys.columns  c ON c.default_object_id = dc.object_id
INNER JOIN sys.tables   t ON t.object_id = c.object_id
INNER JOIN sys.schemas  s ON s.schema_id = t.schema_id
WHERE s.name = 'oe' AND t.name = 'SupportTickets' AND c.name = 'Status';

IF @df_name IS NOT NULL
BEGIN
    DECLARE @drop_sql NVARCHAR(500) =
        N'ALTER TABLE oe.SupportTickets DROP CONSTRAINT ' + QUOTENAME(@df_name);
    EXEC sp_executesql @drop_sql;
    PRINT 'Dropped existing default on Status: ' + @df_name;
END

IF NOT EXISTS (
    SELECT 1
    FROM sys.default_constraints dc
    INNER JOIN sys.columns  c ON c.default_object_id = dc.object_id
    INNER JOIN sys.tables   t ON t.object_id = c.object_id
    INNER JOIN sys.schemas  s ON s.schema_id = t.schema_id
    WHERE s.name = 'oe' AND t.name = 'SupportTickets' AND c.name = 'Status'
)
BEGIN
    ALTER TABLE oe.SupportTickets
        ADD CONSTRAINT DF_SupportTickets_Status DEFAULT ('Open') FOR Status;
    PRINT 'Added DF_SupportTickets_Status with default ''Open''.';
END
GO

-- -----------------------------------------------------------------------------
-- 12. Index for rail filtering on (VendorId, TicketType)
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_SupportTickets_Vendor_TicketType'
      AND object_id = OBJECT_ID('oe.SupportTickets')
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_SupportTickets_Vendor_TicketType
        ON oe.SupportTickets (VendorId, TicketType);
    PRINT 'Created IX_SupportTickets_Vendor_TicketType.';
END
ELSE
BEGIN
    PRINT 'IX_SupportTickets_Vendor_TicketType already exists — skipping.';
END
GO

-- =============================================================================
-- Verification SELECTs (safe to run any time)
-- =============================================================================
PRINT '----- Renamed tables -----';
SELECT TableName = t.name
FROM sys.tables t INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'oe'
  AND t.name IN ('SupportTickets', 'SupportTicketNotes', 'SupportTicketProviders', 'SupportTicketDocuments')
ORDER BY t.name;

PRINT '----- New columns on oe.SupportTickets -----';
SELECT ColumnName = c.name, DataType = ty.name, IsNullable = c.is_nullable
FROM sys.columns c
INNER JOIN sys.tables t  ON c.object_id = t.object_id
INNER JOIN sys.schemas s ON t.schema_id  = s.schema_id
INNER JOIN sys.types ty  ON c.user_type_id = ty.user_type_id
WHERE s.name = 'oe' AND t.name = 'SupportTickets'
  AND c.name IN ('TicketType', 'TicketSubcategory', 'SubcategoryDetail');

PRINT '----- CHECK constraints -----';
SELECT ConstraintName = name
FROM sys.check_constraints
WHERE name IN ('CK_SupportTickets_TicketType', 'CK_SupportTickets_TicketSubcategory');

PRINT '----- FK on Encounters -----';
SELECT FkName = name FROM sys.foreign_keys WHERE name = 'FK_Encounters_SupportTicket';

PRINT '----- Status counts after backfill -----';
SELECT Status, RowCount_ = COUNT(*) FROM oe.SupportTickets GROUP BY Status ORDER BY Status;
GO

-- =============================================================================
-- ROLLBACK (commented out — uncomment only if you really mean it)
-- =============================================================================
-- IMPORTANT: Status backfill is many-to-one. The reverse below collapses
-- multiple new statuses back to single old values and will lose fidelity.
-- Restore from a snapshot if you need the original Status values.
--
-- -- 12r. Drop the new index
-- IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SupportTickets_Vendor_TicketType' AND object_id = OBJECT_ID('oe.SupportTickets'))
--     DROP INDEX IX_SupportTickets_Vendor_TicketType ON oe.SupportTickets;
--
-- -- 11r. Restore default 'New' on Status
-- IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_SupportTickets_Status')
--     ALTER TABLE oe.SupportTickets DROP CONSTRAINT DF_SupportTickets_Status;
-- ALTER TABLE oe.SupportTickets ADD CONSTRAINT DF_SupportTickets_Status DEFAULT ('New') FOR Status;
--
-- -- 10r. Reverse backfill (LOSSY — Claims/Billing-Reimbursement/High Priority all came from "In Progress")
-- UPDATE oe.SupportTickets SET Status = 'New'      WHERE Status = 'Open';
-- UPDATE oe.SupportTickets SET Status = 'Claims'   WHERE Status = 'In Progress';
-- UPDATE oe.SupportTickets SET Status = 'Pending'  WHERE Status = 'Waiting';
--
-- -- 9r. Drop CHECK constraints
-- IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SupportTickets_TicketSubcategory')
--     ALTER TABLE oe.SupportTickets DROP CONSTRAINT CK_SupportTickets_TicketSubcategory;
-- IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SupportTickets_TicketType')
--     ALTER TABLE oe.SupportTickets DROP CONSTRAINT CK_SupportTickets_TicketType;
--
-- -- 8r. Drop new columns (drop DF first)
-- IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_SupportTickets_TicketType')
--     ALTER TABLE oe.SupportTickets DROP CONSTRAINT DF_SupportTickets_TicketType;
-- IF COL_LENGTH('oe.SupportTickets', 'SubcategoryDetail') IS NOT NULL
--     ALTER TABLE oe.SupportTickets DROP COLUMN SubcategoryDetail;
-- IF COL_LENGTH('oe.SupportTickets', 'TicketSubcategory') IS NOT NULL
--     ALTER TABLE oe.SupportTickets DROP COLUMN TicketSubcategory;
-- IF COL_LENGTH('oe.SupportTickets', 'TicketType') IS NOT NULL
--     ALTER TABLE oe.SupportTickets DROP COLUMN TicketType;
--
-- -- 7r. Drop the renamed Encounters FK
-- IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Encounters_SupportTicket')
--     ALTER TABLE oe.Encounters DROP CONSTRAINT FK_Encounters_SupportTicket;
--
-- -- 6r. Rename constraints/indexes/defaults back (do this BEFORE renaming tables back)
-- --     ...same sp_rename calls in reverse...
--
-- -- 5r. TicketNumber -> CaseNumber
-- IF COL_LENGTH('oe.SupportTickets', 'TicketNumber') IS NOT NULL
--     EXEC sp_rename 'oe.SupportTickets.TicketNumber', 'CaseNumber', 'COLUMN';
--
-- -- 4r. Encounters.SupportTicketId -> CaseId
-- IF COL_LENGTH('oe.Encounters', 'SupportTicketId') IS NOT NULL
--     EXEC sp_rename 'oe.Encounters.SupportTicketId', 'CaseId', 'COLUMN';
--
-- -- 3r. SupportTicketId -> CaseId on all four tables
-- --     ...sp_rename in reverse...
--
-- -- 2r. Tables back to Cases*
-- IF OBJECT_ID('oe.SupportTicketDocuments', 'U') IS NOT NULL EXEC sp_rename 'oe.SupportTicketDocuments', 'CaseDocuments', 'OBJECT';
-- IF OBJECT_ID('oe.SupportTicketProviders', 'U') IS NOT NULL EXEC sp_rename 'oe.SupportTicketProviders', 'CaseProviders', 'OBJECT';
-- IF OBJECT_ID('oe.SupportTicketNotes',     'U') IS NOT NULL EXEC sp_rename 'oe.SupportTicketNotes',     'CaseNotes',     'OBJECT';
-- IF OBJECT_ID('oe.SupportTickets',         'U') IS NOT NULL EXEC sp_rename 'oe.SupportTickets',         'Cases',         'OBJECT';
--
-- -- 1r. Re-add the original FK_Encounters_Case
-- ALTER TABLE oe.Encounters ADD CONSTRAINT FK_Encounters_Case FOREIGN KEY (CaseId) REFERENCES oe.Cases (CaseId);
-- GO
