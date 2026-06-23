/*
  Quick patch if full essential-ah-vendor-import-product-map.sql already ran but preview
  still lists EE_3000 / ES_3000 / EE_6000 / … as unmapped.

  Root cause: import rules now target Essential - AH; these legacy UA keys were still
  mapped to Essential (ShareWELL) or Essential (Sharewell) - 2025 → scoped lookup fails.

  Maps file UA labels → Essential - AH pricing (same tiers as EE_2500 / EE_5000).

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-11-essential-ah-legacy-ua-keys-only.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @EssentialAhProductId UNIQUEIDENTIFIER = '5F9E2FD9-C817-48A6-ADF6-3D44021F6250';

IF OBJECT_ID('tempdb..#LegacyUa') IS NOT NULL DROP TABLE #LegacyUa;
IF OBJECT_ID('tempdb..#Seed') IS NOT NULL DROP TABLE #Seed;

SELECT v.SourceProductKey, v.TierType, v.UaNorm
INTO #LegacyUa
FROM (VALUES
  (N'EE_3000', N'EE', N'2500'),
  (N'ES_3000', N'ES', N'2500'),
  (N'EC_3000', N'EC', N'2500'),
  (N'EF_3000', N'EF', N'2500'),
  (N'EE_6000', N'EE', N'5000'),
  (N'ES_6000', N'ES', N'5000'),
  (N'EC_6000', N'EC', N'5000'),
  (N'EF_6000', N'EF', N'5000')
) AS v(SourceProductKey, TierType, UaNorm);

SELECT
  l.SourceProductKey,
  @EssentialAhProductId AS ProductId,
  pp.ProductPricingId
INTO #Seed
FROM #LegacyUa l
INNER JOIN oe.ProductPricing pp
  ON pp.ProductId = @EssentialAhProductId
 AND pp.Status = N'Active'
 AND pp.TobaccoStatus = N'No'
 AND UPPER(pp.TierType) = l.TierType
 AND LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50)))) = l.UaNorm;

IF EXISTS (
  SELECT 1 FROM #LegacyUa l LEFT JOIN #Seed s ON s.SourceProductKey = l.SourceProductKey WHERE s.SourceProductKey IS NULL
)
BEGIN
  RAISERROR('Essential - AH pricing missing for legacy UA alias tier.', 16, 1);
  RETURN;
END;

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — Essential - AH legacy UA keys' AS Mode;
  SELECT
    s.SourceProductKey,
    cur.Name AS CurrentProduct,
    CASE WHEN m.ProductId = s.ProductId THEN N'already_correct' ELSE N'would_update' END AS RowState,
    s.ProductPricingId AS NewProductPricingId
  FROM #Seed s
  LEFT JOIN oe.VendorImportProductMap m
    ON m.VendorId = @SharewellVendorId AND m.SourceProductKey = s.SourceProductKey
  LEFT JOIN oe.Products cur ON cur.ProductId = m.ProductId
  ORDER BY s.SourceProductKey;
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  MERGE oe.VendorImportProductMap AS t
  USING (
    SELECT @SharewellVendorId AS VendorId, SourceProductKey, ProductId, ProductPricingId FROM #Seed
  ) AS s
  ON t.VendorId = s.VendorId AND t.SourceProductKey = s.SourceProductKey
  WHEN MATCHED AND (t.ProductId <> s.ProductId OR t.ProductPricingId <> s.ProductPricingId) THEN
    UPDATE SET ProductId = s.ProductId, ProductPricingId = s.ProductPricingId, ModifiedDate = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (VendorId, SourceProductKey, ProductId, ProductPricingId)
    VALUES (s.VendorId, s.SourceProductKey, s.ProductId, s.ProductPricingId);

  COMMIT TRANSACTION;
  PRINT 'Legacy UA keys repointed to Essential - AH.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;

DROP TABLE #LegacyUa;
DROP TABLE #Seed;
