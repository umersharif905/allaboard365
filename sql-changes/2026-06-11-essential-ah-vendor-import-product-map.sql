/*
  Repoint Align Health import map keys to Essential - AH (partner-matched pricing).

  Covers:
    • 11321_AH* composite file codes (export layout)
    • 46520_* / 46521_* addon rows (Product_ID + Benefit_ID: 9375=EE … 9378=EF @ UA 1500)
    • Catalog tier_UA keys (EE_1500, EE_2500, …) AND legacy file labels (EE_3000, EE_6000, …)

  Also updates sharewell_align / sharewell_align_sha ImportRulesJson targetProductId
  so scoped import lookup matches Essential - AH (not Essential ShareWELL).

  Fact-check (2026-06-11): Essential - AH MSRP matches ShareWELL partner_invoice_pricing
  for Align Health on all tiers/UA bands.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-11-essential-ah-vendor-import-product-map.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @EssentialAhProductId UNIQUEIDENTIFIER = '5F9E2FD9-C817-48A6-ADF6-3D44021F6250';
DECLARE @EssentialSharewellProductId UNIQUEIDENTIFIER = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';
DECLARE @AlignRulesReplaceFrom NVARCHAR(80) = CAST(@EssentialSharewellProductId AS NVARCHAR(36));
DECLARE @AlignRulesReplaceTo NVARCHAR(80) = CAST(@EssentialAhProductId AS NVARCHAR(36));

IF OBJECT_ID('oe.VendorImportProductMap', 'U') IS NULL
BEGIN
  RAISERROR('oe.VendorImportProductMap does not exist.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1 FROM oe.Products
  WHERE ProductId = @EssentialAhProductId
    AND VendorId = @SharewellVendorId
    AND LTRIM(RTRIM(Name)) = N'Essential - AH'
    AND Status NOT IN (N'Deleted')
)
BEGIN
  RAISERROR('Essential - AH product not found — verify @EssentialAhProductId.', 16, 1);
  RETURN;
END;

IF OBJECT_ID('tempdb..#AhComposite') IS NOT NULL DROP TABLE #AhComposite;
IF OBJECT_ID('tempdb..#AhMapSeed') IS NOT NULL DROP TABLE #AhMapSeed;

SELECT v.SourceProductKey, v.TierType, v.UaNorm
INTO #AhComposite
FROM (VALUES
  (N'11321_AH1500EE', N'EE', N'1500'),
  (N'11321_AH1500ES', N'ES', N'1500'),
  (N'11321_AH1500EC', N'EC', N'1500'),
  (N'11321_AH1500EF', N'EF', N'1500'),
  (N'11321_AH1500FM', N'EF', N'1500'),
  (N'11321_AH3000EE', N'EE', N'2500'),
  (N'11321_AH3000ES', N'ES', N'2500'),
  (N'11321_AH3000EC', N'EC', N'2500'),
  (N'11321_AH3000EF', N'EF', N'2500'),
  (N'11321_AH3000FM', N'EF', N'2500'),
  (N'11321_AH6000EE', N'EE', N'5000'),
  (N'11321_AH6000ES', N'ES', N'5000'),
  (N'11321_AH6000EC', N'EC', N'5000'),
  (N'11321_AH6000EF', N'EF', N'5000'),
  -- Align native inbound addon rows (46520/46521 + Benefit_ID)
  (N'46520_9375', N'EE', N'1500'),
  (N'46520_9376', N'ES', N'1500'),
  (N'46520_9377', N'EC', N'1500'),
  (N'46520_9378', N'EF', N'1500'),
  (N'46521_9375', N'EE', N'1500'),
  (N'46521_9376', N'ES', N'1500'),
  (N'46521_9377', N'EC', N'1500'),
  (N'46521_9378', N'EF', N'1500'),
  -- Catalog keys from tier_UA resolution (UA relabel: file 3000→2500, 6000→5000)
  (N'EE_1500', N'EE', N'1500'),
  (N'ES_1500', N'ES', N'1500'),
  (N'EC_1500', N'EC', N'1500'),
  (N'EF_1500', N'EF', N'1500'),
  (N'EE_2500', N'EE', N'2500'),
  (N'ES_2500', N'ES', N'2500'),
  (N'EC_2500', N'EC', N'2500'),
  (N'EF_2500', N'EF', N'2500'),
  (N'EE_5000', N'EE', N'5000'),
  (N'ES_5000', N'ES', N'5000'),
  (N'EC_5000', N'EC', N'5000'),
  (N'EF_5000', N'EF', N'5000'),
  -- Legacy file UA labels (preview distinctProducts uses these before relabel)
  (N'EE_3000', N'EE', N'2500'),
  (N'ES_3000', N'ES', N'2500'),
  (N'EC_3000', N'EC', N'2500'),
  (N'EF_3000', N'EF', N'2500'),
  (N'EE_6000', N'EE', N'5000'),
  (N'ES_6000', N'ES', N'5000'),
  (N'EC_6000', N'EC', N'5000'),
  (N'EF_6000', N'EF', N'5000')
) AS v(SourceProductKey, TierType, UaNorm);

;WITH AhTierPricing AS (
  SELECT
    pp.ProductPricingId,
    pp.ProductId,
    UPPER(LTRIM(RTRIM(pp.TierType))) AS TierType,
    LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50)))) AS UaNorm,
    pp.MSRPRate,
    pp.NetRate,
    pp.TobaccoStatus
  FROM oe.ProductPricing pp
  WHERE pp.ProductId = @EssentialAhProductId
    AND pp.Status = N'Active'
    AND pp.TobaccoStatus = N'No'
    AND pp.TierType IN (N'EE', N'ES', N'EC', N'EF')
)
SELECT
  a.SourceProductKey,
  @EssentialAhProductId AS ProductId,
  p.ProductPricingId,
  p.TierType,
  p.UaNorm,
  p.MSRPRate,
  p.NetRate
INTO #AhMapSeed
FROM #AhComposite a
INNER JOIN AhTierPricing p
  ON p.TierType = a.TierType
 AND p.UaNorm = a.UaNorm;

IF EXISTS (
  SELECT 1
  FROM #AhComposite a
  LEFT JOIN #AhMapSeed s ON s.SourceProductKey = a.SourceProductKey
  WHERE s.SourceProductKey IS NULL
)
BEGIN
  SELECT N'Missing Essential - AH pricing for composite key' AS Error, a.SourceProductKey, a.TierType, a.UaNorm
  FROM #AhComposite a
  LEFT JOIN #AhMapSeed s ON s.SourceProductKey = a.SourceProductKey
  WHERE s.SourceProductKey IS NULL;
  RAISERROR('Essential - AH active pricing missing for one or more Align import map keys.', 16, 1);
  RETURN;
END;

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — Essential - AH vendor import product map' AS Mode, DB_NAME() AS DatabaseName;

  SELECT
    s.SourceProductKey,
    CASE
      WHEN m.MapId IS NULL THEN N'would_insert'
      WHEN m.ProductId <> s.ProductId OR m.ProductPricingId <> s.ProductPricingId THEN N'would_update'
      ELSE N'already_correct'
    END AS RowState,
    m.ProductId AS CurrentProductId,
    cur.Name AS CurrentProductName,
    s.ProductId AS NewProductId,
    N'Essential - AH' AS NewProductName,
    m.ProductPricingId AS CurrentProductPricingId,
    curPp.MSRPRate AS CurrentMSRP,
    s.ProductPricingId AS NewProductPricingId,
    s.MSRPRate AS NewMSRP,
    s.TierType,
    s.UaNorm AS CatalogUA
  FROM #AhMapSeed s
  LEFT JOIN oe.VendorImportProductMap m
    ON m.VendorId = @SharewellVendorId AND m.SourceProductKey = s.SourceProductKey
  LEFT JOIN oe.Products cur ON cur.ProductId = m.ProductId
  LEFT JOIN oe.ProductPricing curPp ON curPp.ProductPricingId = m.ProductPricingId
  ORDER BY s.SourceProductKey;

  SELECT
    fp.Slug,
    fp.Label,
    CASE
      WHEN fp.ImportRulesJson IS NULL THEN N'would_set_full_rules'
      WHEN fp.ImportRulesJson LIKE N'%' + @AlignRulesReplaceFrom + N'%' THEN N'would_repoint_target_product'
      ELSE N'no_product_id_change'
    END AS RulesRowState,
    CASE
      WHEN fp.ImportRulesJson IS NULL THEN @AlignRulesReplaceTo
      ELSE REPLACE(fp.ImportRulesJson, @AlignRulesReplaceFrom, @AlignRulesReplaceTo)
    END AS NewImportRulesPreview
  FROM oe.VendorImportFormatPresets fp
  WHERE fp.VendorId = @SharewellVendorId
    AND fp.Slug IN (N'sharewell_align', N'sharewell_align_sha')
  ORDER BY fp.Slug;

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  MERGE oe.VendorImportProductMap AS t
  USING (
    SELECT
      @SharewellVendorId AS VendorId,
      SourceProductKey,
      ProductId,
      ProductPricingId
    FROM #AhMapSeed
  ) AS s
  ON t.VendorId = s.VendorId AND t.SourceProductKey = s.SourceProductKey
  WHEN MATCHED AND (t.ProductId <> s.ProductId OR t.ProductPricingId <> s.ProductPricingId) THEN
    UPDATE SET
      ProductId = s.ProductId,
      ProductPricingId = s.ProductPricingId,
      ModifiedDate = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (VendorId, SourceProductKey, ProductId, ProductPricingId)
    VALUES (s.VendorId, s.SourceProductKey, s.ProductId, s.ProductPricingId);

  IF COL_LENGTH('oe.VendorImportFormatPresets', 'ImportRulesJson') IS NOT NULL
  BEGIN
    UPDATE oe.VendorImportFormatPresets
    SET
      ImportRulesJson = CASE
        WHEN ImportRulesJson IS NULL THEN
          REPLACE(
            (SELECT TOP 1 ImportRulesJson
             FROM oe.VendorImportFormatPresets
             WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_align' AND ImportRulesJson IS NOT NULL),
            @AlignRulesReplaceFrom,
            @AlignRulesReplaceTo
          )
        ELSE REPLACE(ImportRulesJson, @AlignRulesReplaceFrom, @AlignRulesReplaceTo)
      END,
      ModifiedUtc = SYSUTCDATETIME()
    WHERE VendorId = @SharewellVendorId
      AND Slug IN (N'sharewell_align', N'sharewell_align_sha')
      AND (
        ImportRulesJson IS NULL
        OR ImportRulesJson LIKE N'%' + @AlignRulesReplaceFrom + N'%'
      );
  END;

  COMMIT TRANSACTION;

  SELECT
    m.SourceProductKey,
    p.Name AS ProductName,
    m.ProductPricingId,
    pp.TierType,
    pp.ConfigValue1 AS UA,
    pp.MSRPRate,
    pp.NetRate
  FROM oe.VendorImportProductMap m
  INNER JOIN oe.Products p ON p.ProductId = m.ProductId
  INNER JOIN oe.ProductPricing pp ON pp.ProductPricingId = m.ProductPricingId
  WHERE m.VendorId = @SharewellVendorId
    AND m.SourceProductKey IN (SELECT SourceProductKey FROM #AhMapSeed)
  ORDER BY m.SourceProductKey;

  SELECT Slug, Label, ImportRulesJson
  FROM oe.VendorImportFormatPresets
  WHERE VendorId = @SharewellVendorId
    AND Slug IN (N'sharewell_align', N'sharewell_align_sha');

  PRINT 'Repointed Align import map rows + format rules to Essential - AH.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;

DROP TABLE #AhComposite;
DROP TABLE #AhMapSeed;
