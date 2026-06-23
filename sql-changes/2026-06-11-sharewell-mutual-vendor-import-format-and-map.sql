/*
  Mutual Health (Lyric /LYRIC SFTP) import format + VendorImportProductMap.

  No existing AllAboard product NetRate matches ShareWELL partner_invoice_pricing.
  Create duplicate product "Essential - Mutual" with NetRates below, then set @MutualProductId.

  Expected NetRate (tobacco surcharge $0 — one row per tier, Tobacco No):
    UA 1500: EE 285, ES 525, EC 525, EF 790
    UA 2500 (file 3000): EE 240, ES 435, EC 435, EF 670
    UA 5000 (file 6000): EE 210, ES 375, EC 375, EF 375

  CSV: sharewell 24-col (Plan Tier + UA + Plan Name LYR{ua}). Tobacco column present but $0 card.

  Also seeds sharewell_mutual preset and repoints Mutual Health job FormatSlug.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-11-sharewell-mutual-vendor-import-format-and-map.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @MutualHealthJobId UNIQUEIDENTIFIER = '8AC88275-6EFA-4A20-B1D5-4D13C7FD6313';
-- REPLACE after creating Essential - Mutual:
DECLARE @MutualProductId UNIQUEIDENTIFIER = NULL;

DECLARE @MutualRowTemplate NVARCHAR(MAX) = N'{IntegrationPartner:Integration Partner},{BillType:Bill Type},{Relationship:Relationship},{FirstName:First Name},{LastName:Last Name},{MiddleInitial:Middle Name},{Phone1:Phone1},{Phone2:Phone2},{Email:Email},{Address1:Address1},{Address2:Address2},{City:City},{State:State},{ZipCode:Zip},{DOB:DoB},{Gender:Gender},{PlanName:Plan Name},{PlanTier:Plan Tier},{EffectiveDate:Effective Date},{TerminateDate:Terminate Date},{PlanPrice:Plan Price},{UA:UA},{TobaccoSurcharge:Tobacco Surcharge},{MemberIDBase:Member ID}';

DECLARE @MutualRules NVARCHAR(MAX) = N'{
  "rowGrain": "perPrimary",
  "products": [{
    "id": "mutual-main",
    "label": "Mutual Health",
    "targetProductId": "__MUTUAL_PRODUCT_ID__",
    "match": { "mode": "always" },
    "keyStrategy": {
      "type": "planCode",
      "strategies": ["planCode", "tierUa"],
      "tierFields": "Plan Tier,Plan_Tier,Family Size Tier,Coverage Tier",
      "tierPattern": "^(EE|ES|EC|EF)$",
      "uaFields": "UA,Deductible IUA,Plan Base",
      "planCodeFields": "Plan Name,Product Name",
      "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$",
      "uaRelabel": [{ "from": "3000", "to": "2500" }, { "from": "6000", "to": "5000" }]
    }
  }],
  "tobacco": { "columns": ["Tobacco Surcharge"], "yesValues": ["Yes", "100"], "yesWhenNumericGreaterThan": 0 },
  "planKey": {
    "strategies": ["planCode", "tierUa"],
    "tierFields": "Plan Tier,Plan_Tier,Family Size Tier,Coverage Tier",
    "tierPattern": "^(EE|ES|EC|EF)$",
    "uaFields": "UA,Deductible IUA,Plan Base",
    "planCodeFields": "Plan Name,Product Name",
    "tierUaSuffixRegex": "(\\\\d{3,6})(EE|ES|EC|EF)$",
    "uaRelabel": [{ "from": "3000", "to": "2500" }, { "from": "6000", "to": "5000" }]
  },
  "productMapping": {
    "defaultProductNameContains": "Essential - Mutual",
    "assumedProductId": "__MUTUAL_PRODUCT_ID__"
  }
}';

IF @MutualProductId IS NULL
BEGIN
  RAISERROR('Set @MutualProductId to the Essential - Mutual product GUID before applying.', 16, 1);
  RETURN;
END;

SET @MutualRules = REPLACE(@MutualRules, N'__MUTUAL_PRODUCT_ID__', CAST(@MutualProductId AS NVARCHAR(36)));

IF OBJECT_ID('oe.VendorImportProductMap', 'U') IS NULL
BEGIN
  RAISERROR('oe.VendorImportProductMap does not exist.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1 FROM oe.Products
  WHERE ProductId = @MutualProductId
    AND VendorId = @SharewellVendorId
    AND Status NOT IN (N'Deleted')
)
BEGIN
  RAISERROR('Mutual Health product not found — verify @MutualProductId.', 16, 1);
  RETURN;
END;

IF OBJECT_ID('tempdb..#MutualComposite') IS NOT NULL DROP TABLE #MutualComposite;
IF OBJECT_ID('tempdb..#MutualExpected') IS NOT NULL DROP TABLE #MutualExpected;
IF OBJECT_ID('tempdb..#MutualMapSeed') IS NOT NULL DROP TABLE #MutualMapSeed;

SELECT v.SourceProductKey, v.TierType, v.UaNorm
INTO #MutualComposite
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
INTO #MutualExpected
FROM (VALUES
  (N'1500', N'EE', 285), (N'1500', N'ES', 525), (N'1500', N'EC', 525), (N'1500', N'EF', 790),
  (N'2500', N'EE', 240), (N'2500', N'ES', 435), (N'2500', N'EC', 435), (N'2500', N'EF', 670),
  (N'5000', N'EE', 210), (N'5000', N'ES', 375), (N'5000', N'EC', 375), (N'5000', N'EF', 375)
) AS v(UaNorm, TierType, ExpectedNetRate);

;WITH MutualTierPricing AS (
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
  WHERE pp.ProductId = @MutualProductId
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
  FROM MutualTierPricing
),
SELECT
  a.SourceProductKey,
  @MutualProductId AS ProductId,
  p.ProductPricingId,
  p.TierType,
  p.UaNorm,
  p.MSRPRate,
  p.NetRate,
  e.ExpectedNetRate
INTO #MutualMapSeed
FROM #MutualComposite a
INNER JOIN Ranked p
  ON p.TierType = a.TierType
 AND p.UaNorm = a.UaNorm
 AND p.rn = 1
LEFT JOIN #MutualExpected e
  ON e.TierType = a.TierType
 AND e.UaNorm = a.UaNorm;

IF EXISTS (
  SELECT 1
  FROM #MutualComposite a
  LEFT JOIN #MutualMapSeed s ON s.SourceProductKey = a.SourceProductKey
  WHERE s.SourceProductKey IS NULL
)
BEGIN
  SELECT N'Missing Mutual product pricing for import key' AS Error, a.SourceProductKey, a.TierType, a.UaNorm
  FROM #MutualComposite a
  LEFT JOIN #MutualMapSeed s ON s.SourceProductKey = a.SourceProductKey
  WHERE s.SourceProductKey IS NULL;
  RAISERROR('Essential - Mutual active pricing missing for one or more Mutual import map keys.', 16, 1);
  RETURN;
END;

IF EXISTS (
  SELECT 1 FROM #MutualMapSeed
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
  FROM #MutualMapSeed
  WHERE ExpectedNetRate IS NOT NULL
    AND ABS(CAST(NetRate AS DECIMAL(19,4)) - ExpectedNetRate) > 0.009;
  RAISERROR('Essential - Mutual NetRate does not match Mutual partner premiums — fix product pricing first.', 16, 1);
  RETURN;
END;

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — Essential - Mutual vendor import format + product map' AS Mode, DB_NAME() AS DatabaseName;

  SELECT
    CASE WHEN EXISTS (
      SELECT 1 FROM oe.VendorImportFormatPresets
      WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mutual'
    ) THEN N'would_update_preset' ELSE N'would_insert_preset' END AS PresetAction,
    N'sharewell_mutual' AS Slug,
    N'Mutual Health (Lyric SFTP)' AS Label;

  SELECT
    j.JobName,
    j.FormatSlug AS CurrentFormatSlug,
    N'sharewell_mutual' AS NewFormatSlug
  FROM oe.VendorImportJobs j
  WHERE j.JobId = @MutualHealthJobId;

  SELECT
    s.SourceProductKey,
    CASE
      WHEN m.MapId IS NULL THEN N'would_insert'
      WHEN m.ProductId <> s.ProductId OR m.ProductPricingId <> s.ProductPricingId THEN N'would_update'
      ELSE N'already_correct'
    END AS RowState,
    s.NetRate,
    s.ExpectedNetRate,
    s.TierType,
    s.UaNorm AS CatalogUA
  FROM #MutualMapSeed s
  LEFT JOIN oe.VendorImportProductMap m
    ON m.VendorId = @SharewellVendorId AND m.SourceProductKey = s.SourceProductKey
  ORDER BY s.SourceProductKey;

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  IF NOT EXISTS (
    SELECT 1 FROM oe.VendorImportFormatPresets
    WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mutual'
  )
  BEGIN
    INSERT INTO oe.VendorImportFormatPresets (
      VendorId, Slug, Label, RowTemplate, SortOrder, IsActive,
      TobaccoCsvColumn, TobaccoYesValues, ImportRulesJson
    )
    VALUES (
      @SharewellVendorId,
      N'sharewell_mutual',
      N'Mutual Health (Lyric SFTP)',
      @MutualRowTemplate,
      45,
      1,
      N'Tobacco Surcharge',
      N'Yes,100',
      @MutualRules
    );
  END
  ELSE
  BEGIN
    UPDATE oe.VendorImportFormatPresets
    SET
      Label = N'Mutual Health (Lyric SFTP)',
      RowTemplate = @MutualRowTemplate,
      TobaccoCsvColumn = N'Tobacco Surcharge',
      TobaccoYesValues = N'Yes,100',
      ImportRulesJson = @MutualRules,
      ModifiedUtc = SYSUTCDATETIME()
    WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mutual';
  END;

  UPDATE oe.VendorImportJobs
  SET FormatSlug = N'sharewell_mutual', ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId = @MutualHealthJobId;

  MERGE oe.VendorImportProductMap AS t
  USING (
    SELECT @SharewellVendorId AS VendorId, SourceProductKey, ProductId, ProductPricingId
    FROM #MutualMapSeed
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

  COMMIT TRANSACTION;

  PRINT 'Seeded sharewell_mutual preset + repointed Mutual Health job + product map.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;

DROP TABLE #MutualComposite;
DROP TABLE #MutualExpected;
DROP TABLE #MutualMapSeed;
