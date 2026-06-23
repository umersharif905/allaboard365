-- ============================================================================
-- Vendor Networks + Group Vendor Networks
--
-- oe.VendorNetworks: vendor-defined "Networks" (e.g. PPO/HMO style buckets) used
-- by groups to choose an ID card variation per vendor. Exactly one network per
-- vendor may be the default (filtered unique index).
--
-- oe.GroupVendorNetworks: group's chosen network for a given vendor. Driven by
-- group settings UI; absent row means "use default ID card / no override".
-- ============================================================================

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorNetworks'
)
BEGIN
    CREATE TABLE oe.VendorNetworks (
        VendorNetworkId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        VendorId        UNIQUEIDENTIFIER NOT NULL,
        Title           NVARCHAR(255)    NOT NULL,
        IsDefault       BIT              NOT NULL DEFAULT 0,
        IsActive        BIT              NOT NULL DEFAULT 1,
        CreatedDate     DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate    DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_VendorNetworks_Vendors FOREIGN KEY (VendorId)
            REFERENCES oe.Vendors (VendorId) ON DELETE CASCADE
    );

    CREATE NONCLUSTERED INDEX IX_VendorNetworks_VendorId
        ON oe.VendorNetworks (VendorId);

    -- Only one default network per vendor (filtered unique index)
    CREATE UNIQUE NONCLUSTERED INDEX UX_VendorNetworks_DefaultPerVendor
        ON oe.VendorNetworks (VendorId)
        WHERE IsDefault = 1 AND IsActive = 1;

    PRINT 'Created oe.VendorNetworks.';
END
ELSE
BEGIN
    PRINT 'oe.VendorNetworks already exists - skipping.';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupVendorNetworks'
)
BEGIN
    CREATE TABLE oe.GroupVendorNetworks (
        GroupVendorNetworkId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        GroupId              UNIQUEIDENTIFIER NOT NULL,
        VendorId             UNIQUEIDENTIFIER NOT NULL,
        VendorNetworkId      UNIQUEIDENTIFIER NOT NULL,
        CreatedDate          DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate         DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_GroupVendorNetworks_Groups FOREIGN KEY (GroupId)
            REFERENCES oe.Groups (GroupId) ON DELETE CASCADE,
        CONSTRAINT FK_GroupVendorNetworks_Vendors FOREIGN KEY (VendorId)
            REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_GroupVendorNetworks_VendorNetworks FOREIGN KEY (VendorNetworkId)
            REFERENCES oe.VendorNetworks (VendorNetworkId)
    );

    CREATE UNIQUE NONCLUSTERED INDEX UX_GroupVendorNetworks_GroupVendor
        ON oe.GroupVendorNetworks (GroupId, VendorId);

    CREATE NONCLUSTERED INDEX IX_GroupVendorNetworks_VendorNetworkId
        ON oe.GroupVendorNetworks (VendorNetworkId);

    PRINT 'Created oe.GroupVendorNetworks.';
END
ELSE
BEGIN
    PRINT 'oe.GroupVendorNetworks already exists - skipping.';
END
GO
