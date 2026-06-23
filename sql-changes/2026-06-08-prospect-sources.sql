/* 2026-06-08-prospect-sources.sql
   Adds oe.ProspectSources (agent-owned named lead sources) and
   oe.Prospects.SourceId. DRY-RUN by default: set @DryRun = 0 to apply. */
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;   -- <<< set to 0 to actually apply

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN. Would create oe.ProspectSources and add oe.Prospects.SourceId.';
  SELECT
    (SELECT COUNT(*) FROM sys.tables WHERE name = 'ProspectSources' AND schema_id = SCHEMA_ID('oe')) AS ProspectSourcesExists,
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'SourceId') AS ProspectsSourceIdExists;
  RETURN;
END

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ProspectSources' AND schema_id = SCHEMA_ID('oe'))
BEGIN
  CREATE TABLE oe.ProspectSources (
    SourceId       UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    TenantId       UNIQUEIDENTIFIER NOT NULL,
    AgentId        UNIQUEIDENTIFIER NOT NULL,
    Name           NVARCHAR(120) NOT NULL,
    Tag            NVARCHAR(60) NULL,
    Type           NVARCHAR(20) NOT NULL,           -- website | landing | api
    DestinationUrl NVARCHAR(500) NULL,
    LinkCode       NVARCHAR(40) NULL,
    ApiKeyId       UNIQUEIDENTIFIER NULL,
    Status         NVARCHAR(20) NOT NULL DEFAULT 'active',
    CreatedBy      UNIQUEIDENTIFIER NULL,
    CreatedDate    DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    ModifiedDate   DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_ProspectSources_Tenant FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId),
    CONSTRAINT FK_ProspectSources_Agent  FOREIGN KEY (AgentId)  REFERENCES oe.Agents(AgentId)
  );
  CREATE INDEX IX_ProspectSources_Tenant_Agent ON oe.ProspectSources(TenantId, AgentId);
  CREATE UNIQUE INDEX UX_ProspectSources_Tenant_Agent_LinkCode
    ON oe.ProspectSources(TenantId, AgentId, LinkCode) WHERE LinkCode IS NOT NULL;
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'SourceId')
BEGIN
  ALTER TABLE oe.Prospects ADD SourceId UNIQUEIDENTIFIER NULL;
END
PRINT 'Applied.';
