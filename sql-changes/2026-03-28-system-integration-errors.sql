-- oe.SystemIntegrationErrors: cross-cutting integration failures (webhooks, payment processors, etc.)
IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'SystemIntegrationErrors'
)
BEGIN
  CREATE TABLE oe.SystemIntegrationErrors (
    IntegrationErrorId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_SystemIntegrationErrors PRIMARY KEY DEFAULT NEWID(),
    Category NVARCHAR(64) NOT NULL,
    Source NVARCHAR(128) NOT NULL,
    Severity NVARCHAR(32) NOT NULL CONSTRAINT DF_SystemIntegrationErrors_Severity DEFAULT N'error',
    TenantId UNIQUEIDENTIFIER NULL,
    Message NVARCHAR(2000) NOT NULL,
    DetailJson NVARCHAR(MAX) NULL,
    CreatedDate DATETIME2 NOT NULL CONSTRAINT DF_SystemIntegrationErrors_CreatedDate DEFAULT SYSUTCDATETIME()
  );

  CREATE INDEX IX_SystemIntegrationErrors_CreatedDate ON oe.SystemIntegrationErrors (CreatedDate DESC);
  CREATE INDEX IX_SystemIntegrationErrors_Category_CreatedDate ON oe.SystemIntegrationErrors (Category, CreatedDate DESC);
END
GO
