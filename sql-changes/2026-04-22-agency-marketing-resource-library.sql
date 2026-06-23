-- Agency-scoped Resource Library (optional): mirrors tenant library per oe.Agencies.
-- Run after sql-changes/2026-04-03-tenant-marketing-folders-and-resources.sql

IF COL_LENGTH('oe.Agencies', 'UseCustomResourceLibrary') IS NULL
BEGIN
  ALTER TABLE oe.Agencies
    ADD UseCustomResourceLibrary BIT NOT NULL CONSTRAINT DF_Agencies_UseCustomResourceLibrary DEFAULT (0);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE t.name = 'AgencyMarketingFolders' AND s.name = 'oe'
)
BEGIN
  CREATE TABLE oe.AgencyMarketingFolders (
    FolderId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
    AgencyId UNIQUEIDENTIFIER NOT NULL,
    OwnerTenantId UNIQUEIDENTIFIER NOT NULL,
    Name NVARCHAR(200) NOT NULL,
    Description NVARCHAR(1000) NULL,
    SortOrder INT NOT NULL DEFAULT 0,
    IsActive BIT NOT NULL DEFAULT 1,
    HideFromAgents BIT NOT NULL DEFAULT 0,
    CreatedBy UNIQUEIDENTIFIER NULL,
    CreatedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedBy UNIQUEIDENTIFIER NULL,
    ModifiedDate DATETIME2 NULL,
    CONSTRAINT FK_AgencyMarketingFolders_Agency FOREIGN KEY (AgencyId) REFERENCES oe.Agencies (AgencyId),
    CONSTRAINT FK_AgencyMarketingFolders_Tenant FOREIGN KEY (OwnerTenantId) REFERENCES oe.Tenants (TenantId)
  );
  CREATE NONCLUSTERED INDEX IX_AgencyMarketingFolders_Agency_Sort
    ON oe.AgencyMarketingFolders (AgencyId, IsActive, SortOrder);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE t.name = 'AgencyMarketingResources' AND s.name = 'oe'
)
BEGIN
  CREATE TABLE oe.AgencyMarketingResources (
    ResourceId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
    FolderId UNIQUEIDENTIFIER NOT NULL,
    AgencyId UNIQUEIDENTIFIER NOT NULL,
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
    CONSTRAINT FK_AgencyMarketingResources_Folder FOREIGN KEY (FolderId) REFERENCES oe.AgencyMarketingFolders (FolderId),
    CONSTRAINT FK_AgencyMarketingResources_Agency FOREIGN KEY (AgencyId) REFERENCES oe.Agencies (AgencyId),
    CONSTRAINT FK_AgencyMarketingResources_Tenant FOREIGN KEY (OwnerTenantId) REFERENCES oe.Tenants (TenantId),
    CONSTRAINT FK_AgencyMarketingResources_File FOREIGN KEY (FileId) REFERENCES oe.FileUploads (FileId),
    CONSTRAINT CK_AgencyMarketingResources_Type CHECK (
      (ResourceType = N'link' AND ExternalUrl IS NOT NULL AND FileId IS NULL)
      OR (ResourceType = N'file' AND FileId IS NOT NULL AND ExternalUrl IS NULL)
    )
  );
  CREATE NONCLUSTERED INDEX IX_AgencyMarketingResources_Folder_Sort
    ON oe.AgencyMarketingResources (FolderId, IsActive, SortOrder);
  CREATE NONCLUSTERED INDEX IX_AgencyMarketingResources_Agency
    ON oe.AgencyMarketingResources (AgencyId, IsActive);
END
GO
