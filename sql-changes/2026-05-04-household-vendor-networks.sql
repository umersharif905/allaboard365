-- ============================================================================
-- Household Vendor Networks
--
-- oe.HouseholdVendorNetworks: per-household chosen network for a given vendor.
-- Mirrors oe.GroupVendorNetworks but keyed by HouseholdId. Used for INDIVIDUAL
-- (non-group) members only. When a member has a GroupId, the group's selection
-- (oe.GroupVendorNetworks) takes precedence.
--
-- Resolution rule applied in enrollment queries:
--   COALESCE(GroupVendorNetworks.VendorNetworkId, HouseholdVendorNetworks.VendorNetworkId)
-- ============================================================================

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'HouseholdVendorNetworks'
)
BEGIN
    CREATE TABLE oe.HouseholdVendorNetworks (
        HouseholdVendorNetworkId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        HouseholdId              UNIQUEIDENTIFIER NOT NULL,
        VendorId                 UNIQUEIDENTIFIER NOT NULL,
        VendorNetworkId          UNIQUEIDENTIFIER NOT NULL,
        CreatedDate              DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate             DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_HouseholdVendorNetworks_Vendors FOREIGN KEY (VendorId)
            REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_HouseholdVendorNetworks_VendorNetworks FOREIGN KEY (VendorNetworkId)
            REFERENCES oe.VendorNetworks (VendorNetworkId)
    );

    CREATE UNIQUE NONCLUSTERED INDEX UX_HouseholdVendorNetworks_HouseholdVendor
        ON oe.HouseholdVendorNetworks (HouseholdId, VendorId);

    CREATE NONCLUSTERED INDEX IX_HouseholdVendorNetworks_VendorNetworkId
        ON oe.HouseholdVendorNetworks (VendorNetworkId);

    CREATE NONCLUSTERED INDEX IX_HouseholdVendorNetworks_HouseholdId
        ON oe.HouseholdVendorNetworks (HouseholdId);

    PRINT 'Created oe.HouseholdVendorNetworks.';
END
ELSE
BEGIN
    PRINT 'oe.HouseholdVendorNetworks already exists - skipping.';
END
GO
