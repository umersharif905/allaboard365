-- Allow migration instances to expose E123 migration tab in tenant portal

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.MigrationInstance') AND name = 'EnableTenantPortal'
)
BEGIN
  ALTER TABLE oe.MigrationInstance
    ADD EnableTenantPortal BIT NOT NULL
      CONSTRAINT DF_MigrationInstance_EnableTenantPortal DEFAULT 0;
END
GO
