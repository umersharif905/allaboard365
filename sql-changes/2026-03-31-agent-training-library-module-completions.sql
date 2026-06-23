-- Per-agent completion of modules within assigned tenant training library packages.

IF NOT EXISTS (
    SELECT 1
    FROM sys.tables
    WHERE name = 'AgentTrainingLibraryModuleCompletions'
      AND schema_id = SCHEMA_ID('oe')
)
BEGIN
    CREATE TABLE oe.AgentTrainingLibraryModuleCompletions (
        AgentTrainingLibraryModuleCompletionId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        AgentId UNIQUEIDENTIFIER NOT NULL,
        PackageId NVARCHAR(100) NOT NULL,
        ModuleId NVARCHAR(100) NOT NULL,
        CompletedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT PK_AgentTrainingLibraryModuleCompletions PRIMARY KEY (AgentTrainingLibraryModuleCompletionId),
        CONSTRAINT FK_AgentTrainingLibraryModuleCompletions_Agents FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId)
    );

    CREATE UNIQUE NONCLUSTERED INDEX UX_AgentTrainingLibraryModuleCompletions_AgentPackageModule
        ON oe.AgentTrainingLibraryModuleCompletions(AgentId, PackageId, ModuleId);

    CREATE NONCLUSTERED INDEX IX_AgentTrainingLibraryModuleCompletions_AgentId
        ON oe.AgentTrainingLibraryModuleCompletions(AgentId)
        INCLUDE (PackageId, ModuleId, CompletedAt);
END;

