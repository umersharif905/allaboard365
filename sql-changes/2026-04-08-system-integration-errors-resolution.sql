-- Add resolution workflow fields for oe.SystemIntegrationErrors
-- Used by Tenant Billing > Audit > Webhook errors to mark rows resolved/unresolved.

IF COL_LENGTH('oe.SystemIntegrationErrors', 'Resolved') IS NULL
BEGIN
  ALTER TABLE oe.SystemIntegrationErrors
    ADD Resolved BIT NOT NULL
      CONSTRAINT DF_SystemIntegrationErrors_Resolved DEFAULT (0);
END;

IF COL_LENGTH('oe.SystemIntegrationErrors', 'ResolvedAt') IS NULL
BEGIN
  ALTER TABLE oe.SystemIntegrationErrors
    ADD ResolvedAt DATETIME2 NULL;
END;

IF COL_LENGTH('oe.SystemIntegrationErrors', 'ResolvedByUserId') IS NULL
BEGIN
  ALTER TABLE oe.SystemIntegrationErrors
    ADD ResolvedByUserId UNIQUEIDENTIFIER NULL;
END;

-- Optional supporting index for frequent unresolved webhook filters by tenant/date
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_SystemIntegrationErrors_Tenant_Category_Source_Resolved_CreatedDate'
    AND object_id = OBJECT_ID('oe.SystemIntegrationErrors')
)
BEGIN
  CREATE INDEX IX_SystemIntegrationErrors_Tenant_Category_Source_Resolved_CreatedDate
    ON oe.SystemIntegrationErrors (TenantId, Category, Source, Resolved, CreatedDate DESC);
END;
