/*
  Map Align inbound composite keys 46520_* / 46521_* (Product_ID + Benefit_ID) to Essential pricing.
  Benefit_ID → tier: 9375=EE, 9376=ES, 9377=EC, 9378=EF. Default UA 1500 for catalog map row.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-04-align-46520-46521-product-map-seed.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @EssentialProductId UNIQUEIDENTIFIER = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';

IF OBJECT_ID('oe.VendorImportProductMap', 'U') IS NULL
BEGIN
  RAISERROR('oe.VendorImportProductMap does not exist.', 16, 1);
  RETURN;
END;

IF OBJECT_ID('tempdb..#AlignAddon') IS NOT NULL DROP TABLE #AlignAddon;

SELECT v.SourceProductKey, v.TierType, v.UaNorm
INTO #AlignAddon
FROM (VALUES
  (N'46520_9375', N'EE', N'1500'),
  (N'46520_9376', N'ES', N'1500'),
  (N'46520_9377', N'EC', N'1500'),
  (N'46520_9378', N'EF', N'1500'),
  (N'46521_9375', N'EE', N'1500'),
  (N'46521_9376', N'ES', N'1500'),
  (N'46521_9377', N'EC', N'1500'),
  (N'46521_9378', N'EF', N'1500')
) AS v(SourceProductKey, TierType, UaNorm);

IF OBJECT_ID('tempdb..#EssentialTier') IS NOT NULL DROP TABLE #EssentialTier;

SELECT
  pp.ProductPricingId,
  pp.ProductId,
  UPPER(pp.TierType) AS TierType,
  CASE
    WHEN LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50)))) LIKE N'%.00'
      THEN LEFT(LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50)))), LEN(LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50))))) - 3)
    WHEN LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50)))) LIKE N'%.0'
      THEN LEFT(LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50)))), LEN(LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50))))) - 2)
    ELSE LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50))))
  END AS UaNorm
INTO #EssentialTier
FROM oe.ProductPricing pp
WHERE pp.ProductId = @EssentialProductId
  AND pp.Status = N'Active'
  AND pp.TierType IN (N'EE', N'ES', N'EC', N'EF');

IF OBJECT_ID('tempdb..#Seed') IS NOT NULL DROP TABLE #Seed;

SELECT
  a.SourceProductKey,
  MIN(e.ProductPricingId) AS ProductPricingId,
  MIN(e.ProductId) AS ProductId
INTO #Seed
FROM #AlignAddon a
INNER JOIN #EssentialTier e ON e.TierType = a.TierType AND e.UaNorm = a.UaNorm
GROUP BY a.SourceProductKey;

IF EXISTS (
  SELECT 1 FROM #AlignAddon a
  LEFT JOIN #Seed s ON s.SourceProductKey = a.SourceProductKey
  WHERE s.SourceProductKey IS NULL
)
BEGIN
  RAISERROR('Essential pricing missing for one or more 46520/46521 addon tiers (EE/ES/EC/EF @ 1500).', 16, 1);
  RETURN;
END;

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN — would MERGE 46520/46521 composite map rows:';
  SELECT * FROM #Seed ORDER BY SourceProductKey;
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  MERGE oe.VendorImportProductMap AS t
  USING (
    SELECT @SharewellVendorId AS VendorId, SourceProductKey, ProductId, ProductPricingId
    FROM #Seed
  ) AS s
  ON t.VendorId = s.VendorId AND t.SourceProductKey = s.SourceProductKey
  WHEN MATCHED THEN
    UPDATE SET ProductId = s.ProductId, ProductPricingId = s.ProductPricingId, ModifiedDate = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (VendorId, SourceProductKey, ProductId, ProductPricingId)
    VALUES (s.VendorId, s.SourceProductKey, s.ProductId, s.ProductPricingId);

  PRINT CONCAT('46520/46521 map rows affected: ', @@ROWCOUNT);
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
