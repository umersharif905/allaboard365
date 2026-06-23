-- Migration: E123 groups list staging (Invoices View Groups export CSV per instance)
-- Date: 2026-06-10
-- Author: Jeremy Francis

DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - MigrationE123GroupsListExport schema preview' AS [Status];
        SELECT CASE WHEN OBJECT_ID('oe.MigrationE123GroupsListExport', 'U') IS NOT NULL THEN 1 ELSE 0 END AS TableExists;
        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF OBJECT_ID('oe.MigrationE123GroupsListExport', 'U') IS NULL
    BEGIN
      CREATE TABLE oe.MigrationE123GroupsListExport (
        ExportId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationE123GroupsListExport PRIMARY KEY DEFAULT NEWID(),
        InstanceId UNIQUEIDENTIFIER NOT NULL,
        FileName NVARCHAR(400) NULL,
        CsvRowCount INT NOT NULL CONSTRAINT DF_MigrationE123GroupsListExport_CsvRowCount DEFAULT 0,
        GroupCount INT NOT NULL CONSTRAINT DF_MigrationE123GroupsListExport_GroupCount DEFAULT 0,
        SummaryJson NVARCHAR(MAX) NULL,
        UploadedBy UNIQUEIDENTIFIER NULL,
        CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationE123GroupsListExport_CreatedUtc DEFAULT SYSUTCDATETIME()
      );
      CREATE INDEX IX_MigrationE123GroupsListExport_InstanceCreated
        ON oe.MigrationE123GroupsListExport (InstanceId, CreatedUtc DESC);
    END

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
