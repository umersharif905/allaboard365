-- Resource Library: allow tenant admins to hide folders from the agent portal (agents use GET /api/me/agent/marketing-resources).

IF NOT EXISTS (
  SELECT 1
  FROM sys.columns c
  INNER JOIN sys.tables t ON c.object_id = t.object_id
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'TenantMarketingFolders' AND c.name = 'HideFromAgents'
)
BEGIN
  ALTER TABLE oe.TenantMarketingFolders ADD HideFromAgents BIT NOT NULL
    CONSTRAINT DF_TenantMarketingFolders_HideFromAgents DEFAULT (0);
END
GO
