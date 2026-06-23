-- Vendor-scoped Resource Library: mirrors agency-marketing-resource-library per oe.Vendors.
-- Run after sql-changes/2026-04-22-agency-marketing-resource-library.sql

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE t.name = 'VendorMarketingFolders' AND s.name = 'oe'
)
BEGIN
  CREATE TABLE oe.VendorMarketingFolders (
    FolderId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
    VendorId UNIQUEIDENTIFIER NOT NULL,
    OwnerTenantId UNIQUEIDENTIFIER NOT NULL,
    Name NVARCHAR(200) NOT NULL,
    Description NVARCHAR(1000) NULL,
    SortOrder INT NOT NULL DEFAULT 0,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedBy UNIQUEIDENTIFIER NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedBy UNIQUEIDENTIFIER NULL,
    ModifiedDate DATETIME2 NULL,
    CONSTRAINT FK_VendorMarketingFolders_Vendor FOREIGN KEY (VendorId) REFERENCES oe.Vendors (VendorId),
    CONSTRAINT FK_VendorMarketingFolders_Tenant FOREIGN KEY (OwnerTenantId) REFERENCES oe.Tenants (TenantId)
  );
  CREATE NONCLUSTERED INDEX IX_VendorMarketingFolders_Vendor_Sort
    ON oe.VendorMarketingFolders (VendorId, IsActive, SortOrder);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE t.name = 'VendorMarketingResources' AND s.name = 'oe'
)
BEGIN
  CREATE TABLE oe.VendorMarketingResources (
    ResourceId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
    FolderId UNIQUEIDENTIFIER NOT NULL,
    VendorId UNIQUEIDENTIFIER NOT NULL,
    OwnerTenantId UNIQUEIDENTIFIER NOT NULL,
    Title NVARCHAR(300) NOT NULL,
    Description NVARCHAR(1000) NULL,
    ResourceType NVARCHAR(20) NOT NULL,
    FileId UNIQUEIDENTIFIER NULL,
    ExternalUrl NVARCHAR(2000) NULL,
    SortOrder INT NOT NULL DEFAULT 0,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedBy UNIQUEIDENTIFIER NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedBy UNIQUEIDENTIFIER NULL,
    ModifiedDate DATETIME2 NULL,
    CONSTRAINT FK_VendorMarketingResources_Folder FOREIGN KEY (FolderId) REFERENCES oe.VendorMarketingFolders (FolderId),
    CONSTRAINT FK_VendorMarketingResources_Vendor FOREIGN KEY (VendorId) REFERENCES oe.Vendors (VendorId),
    CONSTRAINT FK_VendorMarketingResources_Tenant FOREIGN KEY (OwnerTenantId) REFERENCES oe.Tenants (TenantId),
    CONSTRAINT FK_VendorMarketingResources_File FOREIGN KEY (FileId) REFERENCES oe.FileUploads (FileId),
    CONSTRAINT CK_VendorMarketingResources_Type CHECK (
      (ResourceType = N'link' AND ExternalUrl IS NOT NULL AND FileId IS NULL)
      OR (ResourceType = N'file' AND FileId IS NOT NULL AND ExternalUrl IS NULL)
    )
  );
  CREATE NONCLUSTERED INDEX IX_VendorMarketingResources_Folder_Sort
    ON oe.VendorMarketingResources (FolderId, IsActive, SortOrder);
  CREATE NONCLUSTERED INDEX IX_VendorMarketingResources_Vendor
    ON oe.VendorMarketingResources (VendorId, IsActive);
END
GO
