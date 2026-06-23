-- Migration: E123 payables detail staging (uploaded payables_detail CSV per instance)
-- Date: 2026-06-03
-- Author: Jeremy Francis

DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - MigrationE123PayablesExport schema preview' AS [Status];
        SELECT CASE WHEN OBJECT_ID('oe.MigrationE123PayablesExport', 'U') IS NOT NULL THEN 1 ELSE 0 END AS TableExists;
        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF OBJECT_ID('oe.MigrationE123PayablesExport', 'U') IS NULL
    BEGIN
      CREATE TABLE oe.MigrationE123PayablesExport (
        ExportId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationE123PayablesExport PRIMARY KEY DEFAULT NEWID(),
        InstanceId UNIQUEIDENTIFIER NOT NULL,
        FileName NVARCHAR(400) NULL,
        CsvRowCount INT NOT NULL CONSTRAINT DF_MigrationE123PayablesExport_CsvRowCount DEFAULT 0,
        AgentCount INT NOT NULL CONSTRAINT DF_MigrationE123PayablesExport_AgentCount DEFAULT 0,
        DominantMonth NVARCHAR(20) NULL,
        MinPostedDate DATE NULL,
        MaxPostedDate DATE NULL,
        SummaryJson NVARCHAR(MAX) NULL,
        UploadedBy UNIQUEIDENTIFIER NULL,
        CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationE123PayablesExport_CreatedUtc DEFAULT SYSUTCDATETIME()
      );
      CREATE INDEX IX_MigrationE123PayablesExport_InstanceCreated
        ON oe.MigrationE123PayablesExport (InstanceId, CreatedUtc DESC);
    END

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
