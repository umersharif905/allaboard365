-- Billing audit persisted reports (manual + scheduled runs)
IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'BillingAuditReports'
)
BEGIN
  CREATE TABLE oe.BillingAuditReports (
    ReportId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_BillingAuditReports PRIMARY KEY,
    TenantId UNIQUEIDENTIFIER NULL,
    RunAtUtc DATETIME2(7) NOT NULL CONSTRAINT DF_BillingAuditReports_RunAtUtc DEFAULT (SYSUTCDATETIME()),
    TriggerName NVARCHAR(32) NOT NULL,
    SummaryJson NVARCHAR(MAX) NOT NULL,
    DetailJson NVARCHAR(MAX) NULL,
    CreatedBy NVARCHAR(256) NULL
  );
  CREATE INDEX IX_BillingAuditReports_Tenant_RunAt ON oe.BillingAuditReports (TenantId, RunAtUtc DESC);
END
GO
