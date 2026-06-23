-- Speeds up tenant-scoped billing webhook error queries (Tenant Billing → Webhook errors)
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  INNER JOIN sys.tables t ON i.object_id = t.object_id
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = N'oe' AND t.name = N'SystemIntegrationErrors' AND i.name = N'IX_SystemIntegrationErrors_TenantId_Category_CreatedDate'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_SystemIntegrationErrors_TenantId_Category_CreatedDate
    ON oe.SystemIntegrationErrors (TenantId, Category, CreatedDate DESC)
    INCLUDE (Source, Severity, Message);
END
GO
