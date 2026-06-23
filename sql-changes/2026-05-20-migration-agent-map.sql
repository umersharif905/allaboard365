-- E123 broker → AB365 agent map (instance-scoped, for member import agent assignment)

IF OBJECT_ID('oe.MigrationAgentMap', 'U') IS NULL
BEGIN
  CREATE TABLE oe.MigrationAgentMap (
    AgentMapId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_MigrationAgentMap PRIMARY KEY DEFAULT NEWID(),
    InstanceId UNIQUEIDENTIFIER NOT NULL,
    E123BrokerId INT NOT NULL,
    AgentId UNIQUEIDENTIFIER NOT NULL,
    MatchMethod NVARCHAR(50) NULL,
    E123AgentLabel NVARCHAR(255) NULL,
    CreatedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationAgentMap_CreatedUtc DEFAULT SYSUTCDATETIME(),
    ModifiedUtc DATETIME2 NOT NULL CONSTRAINT DF_MigrationAgentMap_ModifiedUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_MigrationAgentMap_InstanceBroker UNIQUE (InstanceId, E123BrokerId)
  );
  CREATE INDEX IX_MigrationAgentMap_InstanceId ON oe.MigrationAgentMap (InstanceId);
  CREATE INDEX IX_MigrationAgentMap_AgentId ON oe.MigrationAgentMap (AgentId);
END
GO
