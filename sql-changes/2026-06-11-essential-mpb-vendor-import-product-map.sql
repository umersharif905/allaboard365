/*
  MPowering Benefits import: sharewell_mpb format + VendorImportProductMap.

  Partner premiums (ShareWELL partner_invoice_pricing, MPB012025) do NOT fully match
  Essential (ShareWELL) NetRate — EE/EF exact; ES/EC +$5 (383 vs 378, etc.).
  Create duplicate product "Essential - MPB" with NetRates below, then set @MpbProductId.

  Expected NetRate (non-tobacco) — set MSRP = NetRate + Essential ShareWELL margin per tier:
    UA 1500: EE 194/220, ES 383/415, EC 383/415, EF 537/575
    UA 2500 (file 3000): EE 149/175, ES 288/315, EC 288/315, EF 417/455
    UA 5000 (file 6000): EE 99/125, ES 223/250, EC 223/250, EF 347/385
  Tobacco rows: NetRate = non-tobacco + 100; MSRP = NetRate + same tier margin.

  CSV keys: Plan_Tier + UA (1500/3000/6000). uaRelabel 3000→2500, 6000→5000.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-11-essential-mpb-vendor-import-product-map.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
-- REPLACE after creating Essential - MPB (duplicate of Essential ShareWELL with MPB NetRates):
DECLARE @MpbProductId UNIQUEIDENTIFIER = NULL;

DECLARE @MpbRules NVARCHAR(MAX) = N'{
  "rowGrain": "perPrimary",
  "products": [{
    "id": "mpb-main",
    "label": "MPowering Benefits",
    "targetProductId": "__MPB_PRODUCT_ID__",
    "match": { "mode": "always" },
    "keyStrategy": {
      "type": "planCode",
      "strategies": ["planCode", "tierUa"],
      "tierFields": "Plan_Tier,Plan Tier,Family Size Tier",
      "tierPattern": "^(EE|ES|EC|EF)$",
      "uaFields": "UA",
      "planCodeFields": "Plan Name,Product Name",
      "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$",
      "uaRelabel": [{ "from": "3000", "to": "2500" }, { "from": "6000", "to": "5000" }]
    }
  }],
  "tobacco": { "columns": ["Tobacco_Surcharge"], "yesValues": ["Yes"], "yesWhenNumericGreaterThan": 0 },
  "planKey": {
    "strategies": ["planCode", "tierUa"],
    "tierFields": "Plan_Tier,Plan Tier,Family Size Tier",
    "tierPattern": "^(EE|ES|EC|EF)$",
    "uaFields": "UA",
    "planCodeFields": "Plan Name,Product Name",
    "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$",
    "uaRelabel": [{ "from": "3000", "to": "2500" }, { "from": "6000", "to": "5000" }]
  },
  "productMapping": {
    "defaultProductNameContains": "Essential - MPB",
    "assumedProductId": "__MPB_PRODUCT_ID__"
  },
  "householdMemberId": {
    "suffixStripPatterns": ["^(\\\\d+)(D\\\\d+)$", "^(MPB\\\\d+)([A-Z])$"]
  }
}';

IF @MpbProductId IS NULL
BEGIN
  RAISERROR('Set @MpbProductId to the Essential - MPB product GUID before applying.', 16, 1);
  RETURN;
END;

SET @MpbRules = REPLACE(@MpbRules, N'__MPB_PRODUCT_ID__', CAST(@MpbProductId AS NVARCHAR(36)));

IF OBJECT_ID('oe.VendorImportProductMap', 'U') IS NULL
BEGIN
  RAISERROR('oe.VendorImportProductMap does not exist.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1 FROM oe.Products
  WHERE ProductId = @MpbProductId
    AND VendorId = @SharewellVendorId
    AND Status NOT IN (N'Deleted')
)
BEGIN
  RAISERROR('MPB product not found — verify @MpbProductId.', 16, 1);
  RETURN;
END;

IF OBJECT_ID('tempdb..#MpbComposite') IS NOT NULL DROP TABLE #MpbComposite;
IF OBJECT_ID('tempdb..#MpbExpected') IS NOT NULL DROP TABLE #MpbExpected;
IF OBJECT_ID('tempdb..#MpbMapSeed') IS NOT NULL DROP TABLE #MpbMapSeed;

SELECT v.SourceProductKey, v.TierType, v.UaNorm
INTO #MpbComposite
FROM (VALUES
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
  (N'EE_3000', N'EE', N'2500'),
  (N'ES_3000', N'ES', N'2500'),
  (N'EC_3000', N'EC', N'2500'),
  (N'EF_3000', N'EF', N'2500'),
  (N'EE_6000', N'EE', N'5000'),
  (N'ES_6000', N'ES', N'5000'),
  (N'EC_6000', N'EC', N'5000'),
  (N'EF_6000', N'EF', N'5000')
) AS v(SourceProductKey, TierType, UaNorm);

SELECT v.UaNorm, v.TierType, v.ExpectedNetRate
INTO #MpbExpected
FROM (VALUES
  (N'1500', N'EE', 194), (N'1500', N'ES', 383), (N'1500', N'EC', 383), (N'1500', N'EF', 537),
  (N'2500', N'EE', 149), (N'2500', N'ES', 288), (N'2500', N'EC', 288), (N'2500', N'EF', 417),
  (N'5000', N'EE', 99),  (N'5000', N'ES', 223), (N'5000', N'EC', 223), (N'5000', N'EF', 347)
) AS v(UaNorm, TierType, ExpectedNetRate);

;WITH MpbTierPricing AS (
  SELECT
    pp.ProductPricingId,
    pp.ProductId,
    UPPER(LTRIM(RTRIM(pp.TierType))) AS TierType,
    LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50)))) AS UaNorm,
    pp.MSRPRate,
    pp.NetRate,
    pp.TobaccoStatus,
    CASE
      WHEN UPPER(LTRIM(RTRIM(ISNULL(pp.TobaccoStatus, N'')))) IN (N'NO', N'N', N'') THEN 0
      ELSE 1
    END AS TobaccoRank
  FROM oe.ProductPricing pp
  WHERE pp.ProductId = @MpbProductId
    AND pp.Status = N'Active'
    AND pp.TierType IN (N'EE', N'ES', N'EC', N'EF')
),
Ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY TierType, UaNorm
      ORDER BY TobaccoRank, ProductPricingId
    ) AS rn
  FROM MpbTierPricing
)
SELECT
  a.SourceProductKey,
  @MpbProductId AS ProductId,
  p.ProductPricingId,
  p.TierType,
  p.UaNorm,
  p.MSRPRate,
  p.NetRate,
  e.ExpectedNetRate
INTO #MpbMapSeed
FROM #MpbComposite a
INNER JOIN Ranked p
  ON p.TierType = a.TierType
 AND p.UaNorm = a.UaNorm
 AND p.rn = 1
LEFT JOIN #MpbExpected e
  ON e.TierType = a.TierType
 AND e.UaNorm = a.UaNorm;

IF EXISTS (
  SELECT 1
  FROM #MpbComposite a
  LEFT JOIN #MpbMapSeed s ON s.SourceProductKey = a.SourceProductKey
  WHERE s.SourceProductKey IS NULL
)
BEGIN
  SELECT N'Missing MPB product pricing for import key' AS Error, a.SourceProductKey, a.TierType, a.UaNorm
  FROM #MpbComposite a
  LEFT JOIN #MpbMapSeed s ON s.SourceProductKey = a.SourceProductKey
  WHERE s.SourceProductKey IS NULL;
  RAISERROR('Essential - MPB active pricing missing for one or more MPB import map keys.', 16, 1);
  RETURN;
END;

IF EXISTS (
  SELECT 1 FROM #MpbMapSeed
  WHERE ExpectedNetRate IS NOT NULL
    AND ABS(CAST(NetRate AS DECIMAL(19,4)) - ExpectedNetRate) > 0.009
)
BEGIN
  SELECT
    N'NetRate mismatch vs ShareWELL partner_invoice_pricing' AS Error,
    SourceProductKey,
    TierType,
    UaNorm,
    NetRate,
    ExpectedNetRate
  FROM #MpbMapSeed
  WHERE ExpectedNetRate IS NOT NULL
    AND ABS(CAST(NetRate AS DECIMAL(19,4)) - ExpectedNetRate) > 0.009;
  RAISERROR('Essential - MPB NetRate does not match MPB partner premiums — fix product pricing first.', 16, 1);
  RETURN;
END;

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — Essential - MPB vendor import product map' AS Mode, DB_NAME() AS DatabaseName;

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
    p.Name AS NewProductName,
    s.NetRate,
    s.ExpectedNetRate,
    s.TierType,
    s.UaNorm AS CatalogUA
  FROM #MpbMapSeed s
  LEFT JOIN oe.VendorImportProductMap m
    ON m.VendorId = @SharewellVendorId AND m.SourceProductKey = s.SourceProductKey
  LEFT JOIN oe.Products cur ON cur.ProductId = m.ProductId
  LEFT JOIN oe.Products p ON p.ProductId = s.ProductId
  ORDER BY s.SourceProductKey;

  SELECT Slug, Label, TobaccoCsvColumn, LEFT(ImportRulesJson, 120) AS RulesStart
  FROM oe.VendorImportFormatPresets
  WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mpb';

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  MERGE oe.VendorImportProductMap AS t
  USING (
    SELECT @SharewellVendorId AS VendorId, SourceProductKey, ProductId, ProductPricingId
    FROM #MpbMapSeed
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

  UPDATE oe.VendorImportFormatPresets
  SET
    TobaccoCsvColumn = N'Tobacco_Surcharge',
    TobaccoYesValues = N'Yes',
    ImportRulesJson = @MpbRules,
    ModifiedUtc = SYSUTCDATETIME()
  WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mpb';

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
    AND m.SourceProductKey IN (SELECT SourceProductKey FROM #MpbMapSeed)
  ORDER BY m.SourceProductKey;

  PRINT 'Repointed sharewell_mpb import map + format rules to Essential - MPB.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;

DROP TABLE #MpbComposite;
DROP TABLE #MpbExpected;
DROP TABLE #MpbMapSeed;
