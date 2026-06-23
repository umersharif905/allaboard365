-- E123 migration instances: labeled workspaces with own credentials and tenant scope

IF OBJECT_ID('oe.MigrationInstance', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationInstance (
    InstanceId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationInstance PRIMARY KEY DEFAULT NEWID(),
    Label NVARCHAR(255) NOT NULL,
    E123CorpId NVARCHAR(50) NULL,
    E123Username NVARCHAR(255) NULL,
    E123PasswordEncrypted NVARCHAR(MAX) NULL,
    OrgBrokerId INT NULL,
    OrgBrokerLabel NVARCHAR(255) NULL,
    IsArchived BIT NOT NULL CONSTRAINT DF_MigrationInstance_IsArchived DEFAULT 0,
    CreatedBy UNIQUEIDENTIFIER NULL,
    CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationInstance_CreatedUtc DEFAULT SYSUTCDATETIME(),
    ModifiedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationInstance_ModifiedUtc DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_MigrationInstance_Active ON oe.MigrationInstance (IsArchived, CreatedUtc DESC);
END
GO

IF OBJECT_ID('oe.MigrationInstanceTenant', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationInstanceTenant (
    InstanceTenantId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationInstanceTenant PRIMARY KEY DEFAULT NEWID(),
    InstanceId UNIQUEIDENTIFIER NOT NULL,
    TenantId UNIQUEIDENTIFIER NOT NULL,
    CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationInstanceTenant_CreatedUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_MigrationInstanceTenant_Instance FOREIGN KEY (InstanceId)
      REFERENCES oe.MigrationInstance (InstanceId) ON DELETE CASCADE,
    CONSTRAINT FK_MigrationInstanceTenant_Tenant FOREIGN KEY (TenantId)
      REFERENCES oe.Tenants (TenantId),
    CONSTRAINT UQ_MigrationInstanceTenant_TenantId UNIQUE (TenantId)
  );
  CREATE INDEX IX_MigrationInstanceTenant_InstanceId ON oe.MigrationInstanceTenant (InstanceId);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MigrationImportBatch') AND name = 'InstanceId'
)
BEGIN
  ALTER TABLE oe.MigrationImportBatch ADD InstanceId UNIQUEIDENTIFIER NULL;
  CREATE INDEX IX_MigrationImportBatch_InstanceId ON oe.MigrationImportBatch (InstanceId, CreatedUtc DESC);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.MigrationE123CatalogExport') AND name = 'InstanceId'
)
BEGIN
  ALTER TABLE oe.MigrationE123CatalogExport ADD InstanceId UNIQUEIDENTIFIER NULL;
  CREATE INDEX IX_MigrationE123CatalogExport_InstanceId ON oe.MigrationE123CatalogExport (InstanceId, CreatedUtc DESC);
END
GO
