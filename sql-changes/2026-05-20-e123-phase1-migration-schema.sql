-- E123 Phase 1 migration hub schema

IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Members') AND name = 'IsPendingMigration'
)
BEGIN
  ALTER TABLE oe.Members ADD
    IsPendingMigration BIT NOT NULL CONSTRAINT DF_Members_IsPendingMigration DEFAULT 0,
    MigrationStage NVARCHAR(50) NULL,
    MigrationSourceSystem NVARCHAR(50) NULL,
    MigrationSourceRecordId NVARCHAR(100) NULL;
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Enrollments') AND name = 'IsPendingMigration'
)
BEGIN
  ALTER TABLE oe.Enrollments ADD
    IsPendingMigration BIT NOT NULL CONSTRAINT DF_Enrollments_IsPendingMigration DEFAULT 0,
    MigrationSourceRecordId NVARCHAR(100) NULL;
END
GO

IF OBJECT_ID('oe.MigrationAgentTenantMap', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationAgentTenantMap (
    AgentTenantMapId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationAgentTenantMap PRIMARY KEY DEFAULT NEWID(),
    RootBrokerId INT NOT NULL,
    RootAgentLabel NVARCHAR(255) NULL,
    IncludeDownline BIT NOT NULL CONSTRAINT DF_MigrationAgentTenantMap_IncludeDownline DEFAULT 1,
    TenantId UNIQUEIDENTIFIER NOT NULL,
    IsActive BIT NOT NULL CONSTRAINT DF_MigrationAgentTenantMap_IsActive DEFAULT 1,
    CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationAgentTenantMap_CreatedUtc DEFAULT SYSUTCDATETIME(),
    ModifiedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationAgentTenantMap_ModifiedUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_MigrationAgentTenantMap_BrokerMode UNIQUE (RootBrokerId, IncludeDownline)
  );
  CREATE INDEX IX_MigrationAgentTenantMap_TenantId ON oe.MigrationAgentTenantMap (TenantId);
END
GO

IF OBJECT_ID('oe.MigrationProductMap', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationProductMap (
    ProductMapId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationProductMap PRIMARY KEY DEFAULT NEWID(),
    TenantId UNIQUEIDENTIFIER NOT NULL,
    SourceSystem NVARCHAR(50) NOT NULL,
    SourceProductKey NVARCHAR(100) NOT NULL,
    SourceBenefitKey NVARCHAR(100) NULL,
    SourceProductLabel NVARCHAR(255) NULL,
    ProductId UNIQUEIDENTIFIER NOT NULL,
    ProductPricingId UNIQUEIDENTIFIER NULL,
    CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationProductMap_CreatedUtc DEFAULT SYSUTCDATETIME(),
    ModifiedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationProductMap_ModifiedUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_MigrationProductMap_Key UNIQUE (TenantId, SourceSystem, SourceProductKey, SourceBenefitKey)
  );
  CREATE INDEX IX_MigrationProductMap_TenantId ON oe.MigrationProductMap (TenantId);
END
GO

IF OBJECT_ID('oe.MigrationImportBatch', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationImportBatch (
    BatchId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationImportBatch PRIMARY KEY DEFAULT NEWID(),
    WizardStep INT NOT NULL CONSTRAINT DF_MigrationImportBatch_WizardStep DEFAULT 1,
    RootBrokerId INT NULL,
    RootAgentLabel NVARCHAR(255) NULL,
    IncludeDownline BIT NOT NULL CONSTRAINT DF_MigrationImportBatch_IncludeDownline DEFAULT 1,
    TenantId UNIQUEIDENTIFIER NULL,
    Status NVARCHAR(50) NOT NULL CONSTRAINT DF_MigrationImportBatch_Status DEFAULT 'draft',
    FetchPagesCompleted INT NOT NULL CONSTRAINT DF_MigrationImportBatch_FetchPages DEFAULT 0,
    FetchMembersLoaded INT NOT NULL CONSTRAINT DF_MigrationImportBatch_FetchMembers DEFAULT 0,
    FetchLastUserId INT NULL,
    FetchError NVARCHAR(MAX) NULL,
    ApplyProcessed INT NOT NULL CONSTRAINT DF_MigrationImportBatch_ApplyProcessed DEFAULT 0,
    ApplyTotal INT NOT NULL CONSTRAINT DF_MigrationImportBatch_ApplyTotal DEFAULT 0,
    ApplyCreateCount INT NOT NULL CONSTRAINT DF_MigrationImportBatch_ApplyCreate DEFAULT 0,
    ApplySkipCount INT NOT NULL CONSTRAINT DF_MigrationImportBatch_ApplySkip DEFAULT 0,
    ApplyErrorCount INT NOT NULL CONSTRAINT DF_MigrationImportBatch_ApplyError DEFAULT 0,
    SummaryJson NVARCHAR(MAX) NULL,
    CreatedBy UNIQUEIDENTIFIER NULL,
    CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationImportBatch_CreatedUtc DEFAULT SYSUTCDATETIME(),
    ModifiedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationImportBatch_ModifiedUtc DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_MigrationImportBatch_Status ON oe.MigrationImportBatch (Status, CreatedUtc DESC);
END
GO

IF OBJECT_ID('oe.MigrationImportBatchHousehold', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationImportBatchHousehold (
    BatchHouseholdId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationImportBatchHousehold PRIMARY KEY DEFAULT NEWID(),
    BatchId UNIQUEIDENTIFIER NOT NULL,
    E123UserId INT NULL,
    HouseholdMemberID NVARCHAR(50) NOT NULL,
    HouseholdJson NVARCHAR(MAX) NOT NULL,
    PreviewAction NVARCHAR(20) NULL,
    PreviewMessage NVARCHAR(500) NULL,
    Applied BIT NOT NULL CONSTRAINT DF_MigrationImportBatchHousehold_Applied DEFAULT 0,
    AppliedUtc DATETIME2 NULL,
    CONSTRAINT FK_MigrationImportBatchHousehold_Batch FOREIGN KEY (BatchId)
      REFERENCES oe.MigrationImportBatch (BatchId) ON DELETE CASCADE
  );
  CREATE INDEX IX_MigrationImportBatchHousehold_BatchId ON oe.MigrationImportBatchHousehold (BatchId);
  CREATE INDEX IX_MigrationImportBatchHousehold_MemberId ON oe.MigrationImportBatchHousehold (HouseholdMemberID);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.MigrationImportBatchHousehold') AND name = 'IncludedInImport'
)
BEGIN
  ALTER TABLE oe.MigrationImportBatchHousehold ADD
    IncludedInImport BIT NOT NULL CONSTRAINT DF_MigrationImportBatchHousehold_Included DEFAULT 1;
END
GO
