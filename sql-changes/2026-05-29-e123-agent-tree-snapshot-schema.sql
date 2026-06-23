-- Migration: E123 agent tree staging tables (uploaded Agent Tree / Agent_Full export)
-- Date: 2026-05-29
-- Author: Jeremy Francis

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Agent tree schema preview' AS [Status];

        SELECT
            expected.TableName,
            CASE WHEN t.object_id IS NOT NULL THEN 'exists' ELSE 'will create' END AS [Action]
        FROM (VALUES
            ('MigrationE123AgentTreeExport'),
            ('MigrationE123AgentNode')
        ) AS expected(TableName)
        LEFT JOIN sys.tables t
            ON t.object_id = OBJECT_ID('oe.' + expected.TableName);

        SELECT
            CASE WHEN OBJECT_ID('oe.MigrationE123AgentTreeExport', 'U') IS NOT NULL THEN 1 ELSE 0 END AS ExportTableExists,
            CASE WHEN OBJECT_ID('oe.MigrationE123AgentNode', 'U') IS NOT NULL THEN 1 ELSE 0 END AS NodeTableExists;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF OBJECT_ID('oe.MigrationE123AgentTreeExport', 'U') IS NULL
    BEGIN
      CREATE TABLE oe.MigrationE123AgentTreeExport (
        ExportId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationE123AgentTreeExport PRIMARY KEY DEFAULT NEWID(),
        InstanceId UNIQUEIDENTIFIER NULL,
        RootBrokerId INT NULL,
        RootLabel NVARCHAR(400) NULL,
        SourceFormat NVARCHAR(40) NULL,
        FileName NVARCHAR(400) NULL,
        NodeCount INT NOT NULL CONSTRAINT DF_MigrationE123AgentTreeExport_NodeCount DEFAULT 0,
        UploadedBy UNIQUEIDENTIFIER NULL,
        CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationE123AgentTreeExport_CreatedUtc DEFAULT SYSUTCDATETIME()
      );
      CREATE INDEX IX_MigrationE123AgentTreeExport_InstanceCreated
        ON oe.MigrationE123AgentTreeExport (InstanceId, CreatedUtc DESC);
      CREATE INDEX IX_MigrationE123AgentTreeExport_BrokerCreated
        ON oe.MigrationE123AgentTreeExport (RootBrokerId, CreatedUtc DESC);
    END

    IF OBJECT_ID('oe.MigrationE123AgentNode', 'U') IS NULL
    BEGIN
      CREATE TABLE oe.MigrationE123AgentNode (
        NodeId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationE123AgentNode PRIMARY KEY DEFAULT NEWID(),
        ExportId UNIQUEIDENTIFIER NOT NULL,
        InstanceId UNIQUEIDENTIFIER NULL,
        RootBrokerId INT NULL,
        AgentId INT NOT NULL,
        ParentAgentId INT NULL,
        Label NVARCHAR(400) NULL,
        Depth INT NOT NULL CONSTRAINT DF_MigrationE123AgentNode_Depth DEFAULT 0,
        SortOrder INT NOT NULL CONSTRAINT DF_MigrationE123AgentNode_SortOrder DEFAULT 0,
        ChildCount INT NOT NULL CONSTRAINT DF_MigrationE123AgentNode_ChildCount DEFAULT 0,
        IsGroup BIT NULL,
        CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationE123AgentNode_CreatedUtc DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_MigrationE123AgentNode_Export FOREIGN KEY (ExportId)
          REFERENCES oe.MigrationE123AgentTreeExport (ExportId) ON DELETE CASCADE
      );
      CREATE INDEX IX_MigrationE123AgentNode_ExportId ON oe.MigrationE123AgentNode (ExportId);
      CREATE INDEX IX_MigrationE123AgentNode_Parent ON oe.MigrationE123AgentNode (ExportId, ParentAgentId);
      CREATE INDEX IX_MigrationE123AgentNode_Agent ON oe.MigrationE123AgentNode (ExportId, AgentId);
    END

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
GO
