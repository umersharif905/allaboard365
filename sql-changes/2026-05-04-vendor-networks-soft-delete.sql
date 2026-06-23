-- ============================================================================
-- Soft-delete for Group/Household Vendor Networks
--
-- Adds IsActive flag to oe.GroupVendorNetworks and oe.HouseholdVendorNetworks
-- so that "clear selection" no longer hard-deletes rows. Preserving the row
-- (with ModifiedDate bumped on flip) lets eligibility export change-detection
-- pick up network changes via the existing ModifiedDate column.
--
-- Unique index becomes filtered (IsActive = 1) so a re-add after clear works.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- oe.GroupVendorNetworks
-- ----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.GroupVendorNetworks') AND name = 'IsActive'
)
BEGIN
    ALTER TABLE oe.GroupVendorNetworks
        ADD IsActive BIT NOT NULL CONSTRAINT DF_GroupVendorNetworks_IsActive DEFAULT 1;
    PRINT 'Added oe.GroupVendorNetworks.IsActive.';
END
ELSE
BEGIN
    PRINT 'oe.GroupVendorNetworks.IsActive already exists - skipping column add.';
END
GO

-- Drop unfiltered unique index (if present) and recreate filtered on IsActive=1.
IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_GroupVendorNetworks_GroupVendor'
      AND object_id = OBJECT_ID('oe.GroupVendorNetworks')
)
BEGIN
    DROP INDEX UX_GroupVendorNetworks_GroupVendor ON oe.GroupVendorNetworks;
    PRINT 'Dropped UX_GroupVendorNetworks_GroupVendor.';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_GroupVendorNetworks_GroupVendor_Active'
      AND object_id = OBJECT_ID('oe.GroupVendorNetworks')
)
BEGIN
    CREATE UNIQUE NONCLUSTERED INDEX UX_GroupVendorNetworks_GroupVendor_Active
        ON oe.GroupVendorNetworks (GroupId, VendorId)
        WHERE IsActive = 1;
    PRINT 'Created UX_GroupVendorNetworks_GroupVendor_Active (filtered IsActive=1).';
END
GO

-- ----------------------------------------------------------------------------
-- oe.HouseholdVendorNetworks
-- ----------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.HouseholdVendorNetworks') AND name = 'IsActive'
)
BEGIN
    ALTER TABLE oe.HouseholdVendorNetworks
        ADD IsActive BIT NOT NULL CONSTRAINT DF_HouseholdVendorNetworks_IsActive DEFAULT 1;
    PRINT 'Added oe.HouseholdVendorNetworks.IsActive.';
END
ELSE
BEGIN
    PRINT 'oe.HouseholdVendorNetworks.IsActive already exists - skipping column add.';
END
GO

IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_HouseholdVendorNetworks_HouseholdVendor'
      AND object_id = OBJECT_ID('oe.HouseholdVendorNetworks')
)
BEGIN
    DROP INDEX UX_HouseholdVendorNetworks_HouseholdVendor ON oe.HouseholdVendorNetworks;
    PRINT 'Dropped UX_HouseholdVendorNetworks_HouseholdVendor.';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_HouseholdVendorNetworks_HouseholdVendor_Active'
      AND object_id = OBJECT_ID('oe.HouseholdVendorNetworks')
)
BEGIN
    CREATE UNIQUE NONCLUSTERED INDEX UX_HouseholdVendorNetworks_HouseholdVendor_Active
        ON oe.HouseholdVendorNetworks (HouseholdId, VendorId)
        WHERE IsActive = 1;
    PRINT 'Created UX_HouseholdVendorNetworks_HouseholdVendor_Active (filtered IsActive=1).';
END
GO
