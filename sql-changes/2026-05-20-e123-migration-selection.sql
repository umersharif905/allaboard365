-- Track per-household inclusion in migration apply + selection UI

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.MigrationImportBatchHousehold') AND name = 'IncludedInImport'
)
BEGIN
  ALTER TABLE oe.MigrationImportBatchHousehold ADD
    IncludedInImport BIT NOT NULL CONSTRAINT DF_MigrationImportBatchHousehold_Included DEFAULT 1;
END
GO
