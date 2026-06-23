-- E123 CSV catalog staging (parse-on-upload; does not write oe.Products)

IF OBJECT_ID('oe.MigrationE123CatalogExport', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationE123CatalogExport (
    ExportId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationE123CatalogExport PRIMARY KEY DEFAULT NEWID(),
    RootBrokerId INT NOT NULL,
    UploadedBy UNIQUEIDENTIFIER NULL,
    FileManifestJson NVARCHAR(MAX) NULL,
    ProductCount INT NOT NULL CONSTRAINT DF_MigrationE123CatalogExport_ProductCount DEFAULT 0,
    MissingKindsJson NVARCHAR(MAX) NULL,
    CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationE123CatalogExport_CreatedUtc DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_MigrationE123CatalogExport_BrokerCreated
    ON oe.MigrationE123CatalogExport (RootBrokerId, CreatedUtc DESC);
END
GO

IF OBJECT_ID('oe.MigrationE123ProductSnapshot', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationE123ProductSnapshot (
    SnapshotId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationE123ProductSnapshot PRIMARY KEY DEFAULT NEWID(),
    ExportId UNIQUEIDENTIFIER NOT NULL,
    RootBrokerId INT NOT NULL,
    Pdid INT NOT NULL,
    Label NVARCHAR(255) NULL,
    PricingTierCount INT NOT NULL CONSTRAINT DF_MigrationE123ProductSnapshot_PricingTierCount DEFAULT 0,
    SnapshotJson NVARCHAR(MAX) NOT NULL,
    CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationE123ProductSnapshot_CreatedUtc DEFAULT SYSUTCDATETIME(),
    ModifiedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationE123ProductSnapshot_ModifiedUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_MigrationE123ProductSnapshot_Export FOREIGN KEY (ExportId)
      REFERENCES oe.MigrationE123CatalogExport (ExportId) ON DELETE CASCADE,
    CONSTRAINT UQ_MigrationE123ProductSnapshot_BrokerPdid UNIQUE (RootBrokerId, Pdid)
  );
  CREATE INDEX IX_MigrationE123ProductSnapshot_ExportId ON oe.MigrationE123ProductSnapshot (ExportId);
  CREATE INDEX IX_MigrationE123ProductSnapshot_Pdid ON oe.MigrationE123ProductSnapshot (Pdid);
END
GO
