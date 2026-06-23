/*
  Alias legacy Align file UA labels (3000/6000) to relabeled catalog keys (2500/5000).
  Mapping UI may save 11321_AH3000* while preview resolves EE_3000 — this bridges both.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-04-align-legacy-ua-alias-product-map-seed.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

IF OBJECT_ID('tempdb..#Alias') IS NOT NULL DROP TABLE #Alias;
CREATE TABLE #Alias (
  LegacyKey NVARCHAR(80) NOT NULL,
  CatalogKey NVARCHAR(80) NOT NULL
);

INSERT INTO #Alias (LegacyKey, CatalogKey) VALUES
  (N'EE_3000', N'EE_2500'),
  (N'EE_6000', N'EE_5000'),
  (N'ES_3000', N'ES_2500'),
  (N'ES_6000', N'ES_5000'),
  (N'EC_3000', N'EC_2500'),
  (N'EC_6000', N'EC_5000'),
  (N'EF_3000', N'EF_2500'),
  (N'EF_6000', N'EF_5000');

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN — would copy VendorImportProductMap legacy UA aliases:';
  SELECT a.LegacyKey, a.CatalogKey, m.ProductPricingId
  FROM #Alias a
  LEFT JOIN oe.VendorImportProductMap m
    ON m.VendorId = @SharewellVendorId AND m.SourceProductKey = a.CatalogKey
  ORDER BY a.LegacyKey;
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  MERGE oe.VendorImportProductMap AS t
  USING (
    SELECT
      @SharewellVendorId AS VendorId,
      a.LegacyKey AS SourceProductKey,
      m.ProductId,
      m.ProductPricingId
    FROM #Alias a
    INNER JOIN oe.VendorImportProductMap m
      ON m.VendorId = @SharewellVendorId AND m.SourceProductKey = a.CatalogKey
  ) AS s
  ON t.VendorId = s.VendorId AND t.SourceProductKey = s.SourceProductKey
  WHEN MATCHED THEN
    UPDATE SET ProductId = s.ProductId, ProductPricingId = s.ProductPricingId, ModifiedDate = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (VendorId, SourceProductKey, ProductId, ProductPricingId)
    VALUES (s.VendorId, s.SourceProductKey, s.ProductId, s.ProductPricingId);

  PRINT CONCAT('Legacy UA alias rows affected: ', @@ROWCOUNT);
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
