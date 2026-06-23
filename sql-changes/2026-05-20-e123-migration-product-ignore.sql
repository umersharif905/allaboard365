-- Allow E123 migration product maps to be explicitly ignored (no oe.Enrollments created)

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.MigrationProductMap') AND name = 'IgnoreImport'
)
BEGIN
  ALTER TABLE oe.MigrationProductMap ADD
    IgnoreImport BIT NOT NULL CONSTRAINT DF_MigrationProductMap_IgnoreImport DEFAULT 0;
END
GO

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.MigrationProductMap')
    AND name = 'ProductId'
    AND is_nullable = 0
)
BEGIN
  ALTER TABLE oe.MigrationProductMap ALTER COLUMN ProductId UNIQUEIDENTIFIER NULL;
END
GO
