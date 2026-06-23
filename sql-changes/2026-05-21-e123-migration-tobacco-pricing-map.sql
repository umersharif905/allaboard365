-- Dual tobacco / non-tobacco pricing on E123 product maps

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.MigrationProductMap') AND name = 'ProductPricingIdTobacco'
)
BEGIN
  ALTER TABLE oe.MigrationProductMap
    ADD ProductPricingIdTobacco UNIQUEIDENTIFIER NULL;
END
GO
