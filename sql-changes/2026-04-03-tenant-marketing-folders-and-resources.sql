-- Tenant Marketing Documents: folders and resources (files + external links)
-- Run against open-enroll. Ordering: SortOrder ascending within tenant (folders) and within folder (resources).

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE t.name = 'TenantMarketingFolders' AND s.name = 'oe'
)
BEGIN
  CREATE TABLE oe.TenantMarketingFolders (
    FolderId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
    OwnerTenantId UNIQUEIDENTIFIER NOT NULL,
    Name NVARCHAR(200) NOT NULL,
    Description NVARCHAR(1000) NULL,
    SortOrder INT NOT NULL DEFAULT 0,
    IsActive BIT NOT NULL DEFAULT 1,
    CreatedBy UNIQUEIDENTIFIER NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedBy UNIQUEIDENTIFIER NULL,
    ModifiedDate DATETIME2 NULL,
    CONSTRAINT FK_TenantMarketingFolders_Tenant FOREIGN KEY (OwnerTenantId) REFERENCES oe.Tenants (TenantId)
  );
  CREATE NONCLUSTERED INDEX IX_TenantMarketingFolders_Owner_Sort
    ON oe.TenantMarketingFolders (OwnerTenantId, IsActive, SortOrder);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE t.name = 'TenantMarketingResources' AND s.name = 'oe'
)
BEGIN
  CREATE TABLE oe.TenantMarketingResources (
    ResourceId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
    FolderId UNIQUEIDENTIFIER NOT NULL,
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
    CONSTRAINT FK_TenantMarketingResources_Folder FOREIGN KEY (FolderId) REFERENCES oe.TenantMarketingFolders (FolderId),
    CONSTRAINT FK_TenantMarketingResources_Tenant FOREIGN KEY (OwnerTenantId) REFERENCES oe.Tenants (TenantId),
    CONSTRAINT FK_TenantMarketingResources_File FOREIGN KEY (FileId) REFERENCES oe.FileUploads (FileId),
    CONSTRAINT CK_TenantMarketingResources_Type CHECK (
      (ResourceType = N'link' AND ExternalUrl IS NOT NULL AND FileId IS NULL)
      OR (ResourceType = N'file' AND FileId IS NOT NULL AND ExternalUrl IS NULL)
    )
  );
  CREATE NONCLUSTERED INDEX IX_TenantMarketingResources_Folder_Sort
    ON oe.TenantMarketingResources (FolderId, IsActive, SortOrder);
  CREATE NONCLUSTERED INDEX IX_TenantMarketingResources_Owner
    ON oe.TenantMarketingResources (OwnerTenantId, IsActive);
END
GO
