-- Migration: E123 Group Migration batch and group map tables
-- Date: 2026-06-10
-- Author: Jeremy Francis

DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Group Migration schema preview' AS [Status];

        SELECT
          CASE WHEN OBJECT_ID('oe.MigrationGroupMigrationBatch', 'U') IS NOT NULL THEN 1 ELSE 0 END AS BatchTableExists,
          CASE WHEN OBJECT_ID('oe.MigrationGroupMap', 'U') IS NOT NULL THEN 1 ELSE 0 END AS GroupMapTableExists;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    -- -----------------------------------------------------------------------
    -- Table: oe.MigrationGroupMigrationBatch
    -- Tracks a single group-import wizard run (one per instance/tenant pair).
    -- -----------------------------------------------------------------------
    IF OBJECT_ID('oe.MigrationGroupMigrationBatch', 'U') IS NULL
    BEGIN
        CREATE TABLE oe.MigrationGroupMigrationBatch (
            BatchId       UNIQUEIDENTIFIER NOT NULL
                CONSTRAINT PK_MigrationGroupMigrationBatch PRIMARY KEY
                CONSTRAINT DF_MigGrpBatch_BatchId DEFAULT NEWID(),
            InstanceId    UNIQUEIDENTIFIER NOT NULL,
            TenantId      UNIQUEIDENTIFIER NULL,
            Status        NVARCHAR(50)     NOT NULL
                CONSTRAINT DF_MigGrpBatch_Status DEFAULT N'draft',
            WizardStep    INT              NOT NULL
                CONSTRAINT DF_MigGrpBatch_WizardStep DEFAULT 1,
            DraftJson     NVARCHAR(MAX)    NULL,
            SummaryJson   NVARCHAR(MAX)    NULL,
            CreatedBy     UNIQUEIDENTIFIER NULL,
            CreatedUtc    DATETIME2        NOT NULL
                CONSTRAINT DF_MigGrpBatch_CreatedUtc DEFAULT SYSUTCDATETIME(),
            ModifiedUtc   DATETIME2        NOT NULL
                CONSTRAINT DF_MigGrpBatch_ModifiedUtc DEFAULT SYSUTCDATETIME()
        );

        CREATE INDEX IX_MigGrpBatch_InstanceId
            ON oe.MigrationGroupMigrationBatch (InstanceId);

        CREATE INDEX IX_MigGrpBatch_TenantId
            ON oe.MigrationGroupMigrationBatch (TenantId);
    END

    -- -----------------------------------------------------------------------
    -- Table: oe.MigrationGroupMap
    -- Records the E123 group node -> oe.Groups mapping for each instance.
    -- -----------------------------------------------------------------------
    IF OBJECT_ID('oe.MigrationGroupMap', 'U') IS NULL
    BEGIN
        CREATE TABLE oe.MigrationGroupMap (
            GroupMapId     UNIQUEIDENTIFIER NOT NULL
                CONSTRAINT PK_MigrationGroupMap PRIMARY KEY
                CONSTRAINT DF_MigGrpMap_GroupMapId DEFAULT NEWID(),
            InstanceId     UNIQUEIDENTIFIER NOT NULL,
            E123BrokerId   INT              NOT NULL,
            GroupId        UNIQUEIDENTIFIER NOT NULL,
            E123GroupLabel NVARCHAR(400)    NULL,
            MatchMethod    NVARCHAR(100)    NULL,
            CreatedUtc     DATETIME2        NOT NULL
                CONSTRAINT DF_MigGrpMap_CreatedUtc DEFAULT SYSUTCDATETIME(),
            ModifiedUtc    DATETIME2        NOT NULL
                CONSTRAINT DF_MigGrpMap_ModifiedUtc DEFAULT SYSUTCDATETIME()
        );

        CREATE UNIQUE INDEX UX_MigrationGroupMap_InstanceBroker
            ON oe.MigrationGroupMap (InstanceId, E123BrokerId);

        CREATE INDEX IX_MigrationGroupMap_GroupId
            ON oe.MigrationGroupMap (GroupId);
    END

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
