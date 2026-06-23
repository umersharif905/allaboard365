-- =============================================================================
-- Migration: vendor-customizable Support Ticket taxonomy
-- Date:      2026-05-19
-- Branch:    fix/backoffice/rename-cases-to-support-tickets
-- Spec:      docs/superpowers/specs/2026-05-19-support-ticket-taxonomy-customization-design.md
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds vendor-scoped lookup tables that let VendorAdmin customize the
--   support ticket taxonomy (white-label requirement).
--
--   New tables:
--     oe.SupportTicketTypes          (TypeId, VendorId, Code, Label, IsActive, SortOrder, audit)
--     oe.SupportTicketSubcategories  (SubcategoryId, VendorId, TypeId, Code, Label, IsActive, SortOrder, audit)
--
--   Drops the now-obsolete hardcoded CHECK constraints on oe.SupportTickets
--   (CK_SupportTickets_TicketType and CK_SupportTickets_TicketSubcategory).
--   Validation moves to the app layer against the new lookup tables.
--
--   Seeds the 5 default types and their subcategories for every existing
--   vendor in oe.Vendors.
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   Open-Enroll is white-label. Different vendors need different ticket types.
--   Pre-seeding the existing defaults means no vendor sees a regression.
--
-- IDEMPOTENCY
-- -----------
--   Every block is guarded by IF EXISTS / IF NOT EXISTS or WHERE NOT EXISTS.
--   Re-running is a no-op.
--
-- ROLLBACK
-- --------
--   See the commented ROLLBACK block at the bottom. Drops the two new tables
--   and re-adds the original CHECK constraints (which restore validation to
--   the hardcoded universe).
--
-- APPLICATION DEPLOYMENT ORDER
-- ----------------------------
--   1. Apply this migration AFTER 2026-05-19-rename-cases-to-support-tickets.sql.
--   2. Then deploy the backend + frontend that read from the new tables.
--
-- TEST-DB NOTES (allaboard-testing)
-- ---------------------------------
--   - Applied on: 2026-05-19 UTC
--   - Applied by: Claude, on behalf of Amar (via backend/scripts/run-support-ticket-taxonomy-migration.js
--                 inside the allaboard365-backend container).
--   - Result:     SUCCESS. 9 batches OK. Verification confirmed:
--                   * 8 existing vendors each got 5 types + 17 subcategories.
--                   * CK_SupportTickets_TicketType and CK_SupportTickets_TicketSubcategory
--                     are gone.
--                   * Sample type rows show codes/labels/sort orders as designed.
--   - Amendments needed during the run (folded into this file):
--       1. Verification SELECT used v.Name; oe.Vendors uses v.VendorName.
--
-- PROD READINESS
-- --------------
--   Single source of truth. Apply unmodified to prod after dev verification.
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- 1. Create oe.SupportTicketTypes
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'oe' AND t.name = 'SupportTicketTypes'
)
BEGIN
    CREATE TABLE oe.SupportTicketTypes (
        TypeId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_SupportTicketTypes_TypeId DEFAULT (NEWID()),
        VendorId      UNIQUEIDENTIFIER NOT NULL,
        Code          NVARCHAR(50)     NOT NULL,
        Label         NVARCHAR(100)    NOT NULL,
        IsActive      BIT              NOT NULL CONSTRAINT DF_SupportTicketTypes_IsActive DEFAULT (1),
        SortOrder     INT              NOT NULL CONSTRAINT DF_SupportTicketTypes_SortOrder DEFAULT (0),
        CreatedDate   DATETIME2        NOT NULL CONSTRAINT DF_SupportTicketTypes_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy     UNIQUEIDENTIFIER NULL,
        ModifiedDate  DATETIME2        NULL,
        ModifiedBy    UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_SupportTicketTypes              PRIMARY KEY CLUSTERED (TypeId),
        CONSTRAINT UQ_SupportTicketTypes_VendorCode   UNIQUE (VendorId, Code),
        CONSTRAINT FK_SupportTicketTypes_Vendor       FOREIGN KEY (VendorId)  REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_SupportTicketTypes_CreatedByUser  FOREIGN KEY (CreatedBy)  REFERENCES oe.Users (UserId),
        CONSTRAINT FK_SupportTicketTypes_ModifiedByUser FOREIGN KEY (ModifiedBy) REFERENCES oe.Users (UserId)
    );
    PRINT 'Created table oe.SupportTicketTypes.';

    CREATE NONCLUSTERED INDEX IX_SupportTicketTypes_Vendor_Active
        ON oe.SupportTicketTypes (VendorId, IsActive)
        INCLUDE (SortOrder, Code, Label);
END
ELSE
BEGIN
    PRINT 'Table oe.SupportTicketTypes already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- 2. Create oe.SupportTicketSubcategories
-- -----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'oe' AND t.name = 'SupportTicketSubcategories'
)
BEGIN
    CREATE TABLE oe.SupportTicketSubcategories (
        SubcategoryId UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_SupportTicketSubcategories_SubcategoryId DEFAULT (NEWID()),
        VendorId      UNIQUEIDENTIFIER NOT NULL,
        TypeId        UNIQUEIDENTIFIER NOT NULL,
        Code          NVARCHAR(50)     NOT NULL,
        Label         NVARCHAR(100)    NOT NULL,
        IsActive      BIT              NOT NULL CONSTRAINT DF_SupportTicketSubcategories_IsActive DEFAULT (1),
        SortOrder     INT              NOT NULL CONSTRAINT DF_SupportTicketSubcategories_SortOrder DEFAULT (0),
        CreatedDate   DATETIME2        NOT NULL CONSTRAINT DF_SupportTicketSubcategories_CreatedDate DEFAULT (SYSUTCDATETIME()),
        CreatedBy     UNIQUEIDENTIFIER NULL,
        ModifiedDate  DATETIME2        NULL,
        ModifiedBy    UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_SupportTicketSubcategories              PRIMARY KEY CLUSTERED (SubcategoryId),
        CONSTRAINT UQ_SupportTicketSubcategories_VendorTypeCode UNIQUE (VendorId, TypeId, Code),
        CONSTRAINT FK_SupportTicketSubcategories_Vendor         FOREIGN KEY (VendorId) REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_SupportTicketSubcategories_Type           FOREIGN KEY (TypeId)   REFERENCES oe.SupportTicketTypes (TypeId) ON DELETE CASCADE,
        CONSTRAINT FK_SupportTicketSubcategories_CreatedByUser  FOREIGN KEY (CreatedBy)  REFERENCES oe.Users (UserId),
        CONSTRAINT FK_SupportTicketSubcategories_ModifiedByUser FOREIGN KEY (ModifiedBy) REFERENCES oe.Users (UserId)
    );
    PRINT 'Created table oe.SupportTicketSubcategories.';

    CREATE NONCLUSTERED INDEX IX_SupportTicketSubcategories_VendorType_Active
        ON oe.SupportTicketSubcategories (VendorId, TypeId, IsActive)
        INCLUDE (SortOrder, Code, Label);
END
ELSE
BEGIN
    PRINT 'Table oe.SupportTicketSubcategories already exists — skipping.';
END
GO

-- -----------------------------------------------------------------------------
-- 3. Drop the now-obsolete CHECK constraints on oe.SupportTickets
-- -----------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SupportTickets_TicketType')
BEGIN
    ALTER TABLE oe.SupportTickets DROP CONSTRAINT CK_SupportTickets_TicketType;
    PRINT 'Dropped CK_SupportTickets_TicketType.';
END
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SupportTickets_TicketSubcategory')
BEGIN
    ALTER TABLE oe.SupportTickets DROP CONSTRAINT CK_SupportTickets_TicketSubcategory;
    PRINT 'Dropped CK_SupportTickets_TicketSubcategory.';
END
GO

-- -----------------------------------------------------------------------------
-- 4. Seed defaults for every existing vendor
--    The 5 types are inserted in a fixed order with SortOrder 10/20/30/40/50.
--    Each WHERE NOT EXISTS guard makes the insert idempotent on a per-vendor,
--    per-code basis.
-- -----------------------------------------------------------------------------

-- 4a. Types (one INSERT statement per type code, fanned across all vendors)
INSERT INTO oe.SupportTicketTypes (VendorId, Code, Label, SortOrder)
SELECT v.VendorId, 'reimbursement', 'Reimbursement', 10
FROM oe.Vendors v
WHERE NOT EXISTS (
    SELECT 1 FROM oe.SupportTicketTypes t
    WHERE t.VendorId = v.VendorId AND t.Code = 'reimbursement'
);

INSERT INTO oe.SupportTicketTypes (VendorId, Code, Label, SortOrder)
SELECT v.VendorId, 'billing', 'Billing', 20
FROM oe.Vendors v
WHERE NOT EXISTS (
    SELECT 1 FROM oe.SupportTicketTypes t
    WHERE t.VendorId = v.VendorId AND t.Code = 'billing'
);

INSERT INTO oe.SupportTicketTypes (VendorId, Code, Label, SortOrder)
SELECT v.VendorId, 'encounter_escalation', 'Encounter Escalation', 30
FROM oe.Vendors v
WHERE NOT EXISTS (
    SELECT 1 FROM oe.SupportTicketTypes t
    WHERE t.VendorId = v.VendorId AND t.Code = 'encounter_escalation'
);

INSERT INTO oe.SupportTicketTypes (VendorId, Code, Label, SortOrder)
SELECT v.VendorId, 'complaint', 'Complaint', 40
FROM oe.Vendors v
WHERE NOT EXISTS (
    SELECT 1 FROM oe.SupportTicketTypes t
    WHERE t.VendorId = v.VendorId AND t.Code = 'complaint'
);

INSERT INTO oe.SupportTicketTypes (VendorId, Code, Label, SortOrder)
SELECT v.VendorId, 'appeals', 'Appeals', 50
FROM oe.Vendors v
WHERE NOT EXISTS (
    SELECT 1 FROM oe.SupportTicketTypes t
    WHERE t.VendorId = v.VendorId AND t.Code = 'appeals'
);
PRINT 'Step 4a: types seeded.';
GO

-- 4b. Subcategories (table-valued seed list joined to types per vendor)
;WITH seeds (TypeCode, SubCode, SubLabel, SortOrder) AS (
    SELECT 'reimbursement',         'oon_copay',            'OON Copay',            10 UNION ALL
    SELECT 'reimbursement',         'preventative',         'Preventative',         20 UNION ALL
    SELECT 'reimbursement',         'other',                'Other',                30 UNION ALL
    SELECT 'billing',               'provider_invoice',     'Provider Invoice',     10 UNION ALL
    SELECT 'billing',               'negotiation',          'Negotiation',          20 UNION ALL
    SELECT 'billing',               'recovery',             'Recovery',             30 UNION ALL
    SELECT 'billing',               'claims_cob',           'Claims / COB',         40 UNION ALL
    SELECT 'encounter_escalation',  'needs_follow_up',      'Needs Follow Up',      10 UNION ALL
    SELECT 'encounter_escalation',  'issue_raised',         'Issue Raised',         20 UNION ALL
    SELECT 'encounter_escalation',  'routed_to_team',       'Routed to Team',       30 UNION ALL
    SELECT 'complaint',             'service_quality',      'Service Quality',      10 UNION ALL
    SELECT 'complaint',             'process_outcome',      'Process / Outcome',    20 UNION ALL
    SELECT 'complaint',             'privacy',              'Privacy',              30 UNION ALL
    SELECT 'appeals',               'denied_share',         'Denied Share',         10 UNION ALL
    SELECT 'appeals',               'denied_reimbursement', 'Denied Reimbursement', 20 UNION ALL
    SELECT 'appeals',               'amount_dispute',       'Amount Dispute',       30 UNION ALL
    SELECT 'appeals',               'second_level',         '2nd Level',            40
)
INSERT INTO oe.SupportTicketSubcategories (VendorId, TypeId, Code, Label, SortOrder)
SELECT t.VendorId, t.TypeId, s.SubCode, s.SubLabel, s.SortOrder
FROM oe.SupportTicketTypes t
INNER JOIN seeds s ON s.TypeCode = t.Code
WHERE NOT EXISTS (
    SELECT 1 FROM oe.SupportTicketSubcategories sc
    WHERE sc.VendorId = t.VendorId
      AND sc.TypeId   = t.TypeId
      AND sc.Code     = s.SubCode
);
PRINT 'Step 4b: subcategories seeded.';
GO

-- -----------------------------------------------------------------------------
-- 5. Verification
-- -----------------------------------------------------------------------------
PRINT '----- Per-vendor counts -----';
SELECT
    v.VendorId,
    v.VendorName,
    TypeCount        = (SELECT COUNT(*) FROM oe.SupportTicketTypes t WHERE t.VendorId = v.VendorId),
    SubcategoryCount = (SELECT COUNT(*) FROM oe.SupportTicketSubcategories sc WHERE sc.VendorId = v.VendorId)
FROM oe.Vendors v
ORDER BY v.VendorName;

PRINT '----- Sample types for first vendor -----';
SELECT TOP 5 t.VendorId, t.Code, t.Label, t.SortOrder, t.IsActive
FROM oe.SupportTicketTypes t
ORDER BY t.VendorId, t.SortOrder;

PRINT '----- CHECK constraints (both should be gone) -----';
SELECT name FROM sys.check_constraints
WHERE name IN ('CK_SupportTickets_TicketType', 'CK_SupportTickets_TicketSubcategory');
GO

-- =============================================================================
-- ROLLBACK (commented — uncomment only if you really mean it)
-- =============================================================================
-- IF OBJECT_ID('oe.SupportTicketSubcategories', 'U') IS NOT NULL DROP TABLE oe.SupportTicketSubcategories;
-- IF OBJECT_ID('oe.SupportTicketTypes',         'U') IS NOT NULL DROP TABLE oe.SupportTicketTypes;
-- GO
-- -- Restore the original CHECK constraints (fixed universe).
-- IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SupportTickets_TicketType')
--     ALTER TABLE oe.SupportTickets WITH CHECK
--         ADD CONSTRAINT CK_SupportTickets_TicketType
--         CHECK (TicketType IN ('reimbursement', 'billing', 'encounter_escalation', 'complaint', 'appeals'));
-- IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SupportTickets_TicketSubcategory')
--     ALTER TABLE oe.SupportTickets WITH CHECK
--         ADD CONSTRAINT CK_SupportTickets_TicketSubcategory
--             CHECK (TicketSubcategory IS NULL OR TicketSubcategory IN (
--                 'oon_copay','preventative','other',
--                 'provider_invoice','negotiation','recovery','claims_cob',
--                 'needs_follow_up','issue_raised','routed_to_team',
--                 'service_quality','process_outcome','privacy',
--                 'denied_share','denied_reimbursement','amount_dispute','second_level'
--             ));
-- GO
