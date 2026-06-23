-- 2026-04-29 — Vendor Group ID configuration: configurable step, affix position, auto-generate flag
--
-- Adds three nullable columns to oe.Vendors to extend the existing GroupIdPrefix +
-- GroupIdSeedNumber configuration used by backend/services/vendorGroupIdService.js:
--
--   1. GroupIdBetweenGroupsIncrement — INT NULL.
--      Configurable spacing between successive employer-group numeric bases.
--      NULL means application defaults to legacy value 5 (current ARM-style behavior).
--
--   2. GroupIdAffixPosition — NVARCHAR(10) NULL.
--      Placement of GroupIdPrefix string relative to the numeric part of a vendor
--      group ID. Allowed values: N'Prefix' | N'Suffix'.
--      NULL means application defaults to N'Prefix' (legacy: e.g. "MW1001").
--      N'Suffix' produces e.g. "1001MW".
--
--   3. AutoGenerateVendorGroupIds — BIT NULL.
--      When 1, the nightly /api/scheduled-jobs/auto-vendor-group-ids job creates
--      Master vendor group IDs for groups served by this vendor that have at
--      least one Active enrollment but no group-level Master row in
--      oe.GroupProductVendorGroupIds yet. NULL or 0 means off (default).
--
-- Affix-flip migration policy: existing rows in oe.GroupProductVendorGroupIds
-- keep their stored value when GroupIdAffixPosition changes. Only NEW IDs
-- adopt the new shape — application code does not migrate historical rows.
--
-- Safe to run multiple times.

SET NOCOUNT ON;

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE Name = N'GroupIdBetweenGroupsIncrement'
      AND Object_ID = Object_ID(N'oe.Vendors')
)
BEGIN
    ALTER TABLE oe.Vendors ADD GroupIdBetweenGroupsIncrement INT NULL;
    PRINT 'Added oe.Vendors.GroupIdBetweenGroupsIncrement';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.GroupIdBetweenGroupsIncrement already exists — skipped.';
END
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE Name = N'GroupIdAffixPosition'
      AND Object_ID = Object_ID(N'oe.Vendors')
)
BEGIN
    ALTER TABLE oe.Vendors ADD GroupIdAffixPosition NVARCHAR(10) NULL;
    PRINT 'Added oe.Vendors.GroupIdAffixPosition';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.GroupIdAffixPosition already exists — skipped.';
END
GO

-- Optional CHECK constraint to keep stored values aligned with the application enum.
IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE name = N'CK_Vendors_GroupIdAffixPosition'
)
BEGIN
    ALTER TABLE oe.Vendors
    ADD CONSTRAINT CK_Vendors_GroupIdAffixPosition
        CHECK (GroupIdAffixPosition IS NULL OR GroupIdAffixPosition IN (N'Prefix', N'Suffix'));
    PRINT 'Added CHECK CK_Vendors_GroupIdAffixPosition';
END
ELSE
BEGIN
    PRINT 'CK_Vendors_GroupIdAffixPosition already exists — skipped.';
END
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE Name = N'AutoGenerateVendorGroupIds'
      AND Object_ID = Object_ID(N'oe.Vendors')
)
BEGIN
    ALTER TABLE oe.Vendors ADD AutoGenerateVendorGroupIds BIT NULL;
    PRINT 'Added oe.Vendors.AutoGenerateVendorGroupIds';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.AutoGenerateVendorGroupIds already exists — skipped.';
END
GO
