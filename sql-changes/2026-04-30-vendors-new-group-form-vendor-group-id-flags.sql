-- New Group Form vendor-group-ID behavior flags on oe.Vendors
-- Safe to run multiple times.

SET NOCOUNT ON;

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE Name = N'NewGroupFormIncludeAllVendorGroupIds' AND Object_ID = Object_ID(N'oe.Vendors')
)
BEGIN
    ALTER TABLE oe.Vendors ADD NewGroupFormIncludeAllVendorGroupIds BIT NULL;
    PRINT 'Added oe.Vendors.NewGroupFormIncludeAllVendorGroupIds';
END

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE Name = N'NewGroupFormRequireMasterVendorGroupId' AND Object_ID = Object_ID(N'oe.Vendors')
)
BEGIN
    ALTER TABLE oe.Vendors ADD NewGroupFormRequireMasterVendorGroupId BIT NULL;
    PRINT 'Added oe.Vendors.NewGroupFormRequireMasterVendorGroupId';
END

GO
