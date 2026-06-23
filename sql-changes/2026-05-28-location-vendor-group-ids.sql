-- ============================================================
-- Migration: PlanId on Products + per-vendor location vendor
--            group IDs for multi-location groups
-- ============================================================
-- @DryRun = 1  → SELECT-only preview (default, safe to run)
-- @DryRun = 0  → apply all DDL changes
-- ============================================================

DECLARE @DryRun BIT = 1;

-- ============================================================
-- DRY-RUN PREVIEW
-- ============================================================
IF @DryRun = 1
BEGIN
    PRINT 'DRY RUN MODE — no changes applied. Set @DryRun = 0 to execute.';

    SELECT
        'oe.Products.PlanId' AS [Change],
        CASE
            WHEN EXISTS (
                SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                  AND TABLE_NAME  = 'Products'
                  AND COLUMN_NAME = 'PlanId'
            ) THEN 'Column already exists — no action needed'
            ELSE 'Would ADD COLUMN PlanId NVARCHAR(100) NULL'
        END AS [Action];

    SELECT
        'oe.GroupVendorLocationIdSettings' AS [Change],
        CASE
            WHEN EXISTS (
                SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA = 'oe'
                  AND TABLE_NAME  = 'GroupVendorLocationIdSettings'
            ) THEN 'Table already exists — no action needed'
            ELSE 'Would CREATE TABLE oe.GroupVendorLocationIdSettings'
        END AS [Action];

    SELECT
        'oe.GroupLocationVendorIds' AS [Change],
        CASE
            WHEN EXISTS (
                SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA = 'oe'
                  AND TABLE_NAME  = 'GroupLocationVendorIds'
            ) THEN 'Table already exists — no action needed'
            ELSE 'Would CREATE TABLE oe.GroupLocationVendorIds'
        END AS [Action];

    RETURN;
END;

-- ============================================================
-- APPLY CHANGES  (@DryRun = 0)
-- ============================================================
PRINT 'Applying migration: location-vendor-group-ids ...';

-- ----------------------------------------------------------
-- 1.  Add PlanId to oe.Products
-- ----------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe'
      AND TABLE_NAME  = 'Products'
      AND COLUMN_NAME = 'PlanId'
)
BEGIN
    ALTER TABLE oe.Products
        ADD PlanId NVARCHAR(100) NULL;
    PRINT '  + Added oe.Products.PlanId (NVARCHAR(100) NULL)';
END
ELSE
    PRINT '  = oe.Products.PlanId already exists — skipped';

-- ----------------------------------------------------------
-- 2.  Create oe.GroupVendorLocationIdSettings
--     One row per (GroupId, VendorId) controlling whether
--     per-location vendor IDs are generated / used for that
--     group + vendor combination.
-- ----------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe'
      AND TABLE_NAME  = 'GroupVendorLocationIdSettings'
)
BEGIN
    CREATE TABLE oe.GroupVendorLocationIdSettings (
        SettingId                    UNIQUEIDENTIFIER NOT NULL
                                         CONSTRAINT DF_GroupVendorLocationIdSettings_SettingId DEFAULT NEWID()
                                         CONSTRAINT PK_GroupVendorLocationIdSettings PRIMARY KEY,
        GroupId                      UNIQUEIDENTIFIER NOT NULL,
        VendorId                     UNIQUEIDENTIFIER NOT NULL,
        TenantId                     UNIQUEIDENTIFIER NOT NULL,
        LocationVendorGroupIdsEnabled BIT              NOT NULL
                                         CONSTRAINT DF_GroupVendorLocationIdSettings_Enabled DEFAULT 0,
        CreatedDate                  DATETIME2        NOT NULL
                                         CONSTRAINT DF_GroupVendorLocationIdSettings_CreatedDate DEFAULT GETDATE(),
        ModifiedDate                 DATETIME2        NOT NULL
                                         CONSTRAINT DF_GroupVendorLocationIdSettings_ModifiedDate DEFAULT GETDATE(),
        CreatedBy                    UNIQUEIDENTIFIER NULL,
        ModifiedBy                   UNIQUEIDENTIFIER NULL,

        CONSTRAINT FK_GroupVendorLocationIdSettings_Groups
            FOREIGN KEY (GroupId)  REFERENCES oe.Groups(GroupId),
        CONSTRAINT FK_GroupVendorLocationIdSettings_Vendors
            FOREIGN KEY (VendorId) REFERENCES oe.Vendors(VendorId),

        -- One settings row per (Group, Vendor)
        CONSTRAINT UQ_GroupVendorLocationIdSettings_Group_Vendor
            UNIQUE (GroupId, VendorId)
    );
    PRINT '  + Created oe.GroupVendorLocationIdSettings';
END
ELSE
    PRINT '  = oe.GroupVendorLocationIdSettings already exists — skipped';

-- ----------------------------------------------------------
-- 3.  Create oe.GroupLocationVendorIds
--     Stores the vendor-assigned location ID for a specific
--     GroupLocations row.
-- ----------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe'
      AND TABLE_NAME  = 'GroupLocationVendorIds'
)
BEGIN
    CREATE TABLE oe.GroupLocationVendorIds (
        LocationVendorIdRow  UNIQUEIDENTIFIER NOT NULL
                                 CONSTRAINT DF_GroupLocationVendorIds_PK DEFAULT NEWID()
                                 CONSTRAINT PK_GroupLocationVendorIds PRIMARY KEY,
        LocationId           UNIQUEIDENTIFIER NOT NULL,
        VendorId             UNIQUEIDENTIFIER NOT NULL,
        TenantId             UNIQUEIDENTIFIER NOT NULL,
        VendorLocationId     NVARCHAR(50)     NOT NULL,
        IsAutoGenerated      BIT              NOT NULL
                                 CONSTRAINT DF_GroupLocationVendorIds_IsAutoGenerated DEFAULT 0,
        IsActive             BIT              NOT NULL
                                 CONSTRAINT DF_GroupLocationVendorIds_IsActive DEFAULT 1,
        CreatedDate          DATETIME2        NOT NULL
                                 CONSTRAINT DF_GroupLocationVendorIds_CreatedDate DEFAULT GETDATE(),
        ModifiedDate         DATETIME2        NOT NULL
                                 CONSTRAINT DF_GroupLocationVendorIds_ModifiedDate DEFAULT GETDATE(),
        CreatedBy            UNIQUEIDENTIFIER NULL,
        ModifiedBy           UNIQUEIDENTIFIER NULL,

        CONSTRAINT FK_GroupLocationVendorIds_Locations
            FOREIGN KEY (LocationId) REFERENCES oe.GroupLocations(LocationId),
        CONSTRAINT FK_GroupLocationVendorIds_Vendors
            FOREIGN KEY (VendorId)   REFERENCES oe.Vendors(VendorId)
    );

    -- Active VendorLocationId must be globally unique per Vendor (cannot reuse across groups/locations)
    CREATE UNIQUE INDEX UQ_GroupLocationVendorIds_Vendor_VendorLocationId_Active
        ON oe.GroupLocationVendorIds (VendorId, VendorLocationId)
        WHERE IsActive = 1;

    -- One active row per (Location, Vendor)
    CREATE UNIQUE INDEX UQ_GroupLocationVendorIds_Location_Vendor_Active
        ON oe.GroupLocationVendorIds (LocationId, VendorId)
        WHERE IsActive = 1;

    PRINT '  + Created oe.GroupLocationVendorIds';
END
ELSE
    PRINT '  = oe.GroupLocationVendorIds already exists — skipped';

PRINT 'Migration 2026-05-28-location-vendor-group-ids complete.';
