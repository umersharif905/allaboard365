-- Migration: E123 agent import batch (agent migration wizard)
-- Date: 2026-06-02
-- Author: Jeremy Francis

DECLARE @DryRun BIT = 1;

BEGIN TRY
  BEGIN TRANSACTION;

  IF @DryRun = 1
  BEGIN
    SELECT 'DRY RUN - MigrationAgentImportBatch schema preview' AS [Status];
    SELECT
      OBJECT_ID('oe.MigrationAgentImportBatch', 'U') AS MigrationAgentImportBatchExists,
      OBJECT_ID('oe.MigrationAgentMap', 'U') AS MigrationAgentMapExists,
      OBJECT_ID('oe.MigrationE123AgentNode', 'U') AS MigrationE123AgentNodeExists;
    ROLLBACK TRANSACTION;
    RETURN;
  END

  IF OBJECT_ID('oe.MigrationAgentImportBatch', 'U') IS NULL
  BEGIN
    CREATE TABLE oe.MigrationAgentImportBatch (
      BatchId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationAgentImportBatch PRIMARY KEY DEFAULT NEWID(),
      InstanceId UNIQUEIDENTIFIER NOT NULL,
      RootBrokerId INT NOT NULL,
      RootAgentLabel NVARCHAR(255) NULL,
      IncludeDownline BIT NOT NULL CONSTRAINT DF_MigrationAgentImportBatch_IncludeDownline DEFAULT 1,
      TenantId UNIQUEIDENTIFIER NULL,
      AgencyId UNIQUEIDENTIFIER NULL,
      WizardStep INT NOT NULL CONSTRAINT DF_MigrationAgentImportBatch_WizardStep DEFAULT 1,
      Status NVARCHAR(50) NOT NULL CONSTRAINT DF_MigrationAgentImportBatch_Status DEFAULT 'draft',
      DraftJson NVARCHAR(MAX) NULL,
      SummaryJson NVARCHAR(MAX) NULL,
      CreatedBy UNIQUEIDENTIFIER NULL,
      CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationAgentImportBatch_CreatedUtc DEFAULT SYSUTCDATETIME(),
      ModifiedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationAgentImportBatch_ModifiedUtc DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_MigrationAgentImportBatch_InstanceId
      ON oe.MigrationAgentImportBatch (InstanceId, CreatedUtc DESC);
    CREATE INDEX IX_MigrationAgentImportBatch_Status
      ON oe.MigrationAgentImportBatch (Status, CreatedUtc DESC);
  END

  COMMIT TRANSACTION;
  SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
