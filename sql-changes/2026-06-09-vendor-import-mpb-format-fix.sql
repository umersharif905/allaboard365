/*
  MPowering Benefits manual/SFTP import fixes:
    1) sharewell_mpb tobacco column Tobacco_Surcharge + Yes values
    2) ImportRulesJson target Essential (Sharewell) - 2025 + tier_UA plan keys
    3) VendorImportProductMap tier_UA keys for Essential 2025 (deduped — prefers Tobacco No)

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-09-vendor-import-mpb-format-fix.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @MpbMapRowCount INT;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @Essential2025ProductId UNIQUEIDENTIFIER = '941C7833-D3D7-4411-8407-B43F2A42F2D1';

DECLARE @MpbRules NVARCHAR(MAX) = N'{
  "rowGrain": "perPrimary",
  "products": [{
    "id": "mpb-main",
    "label": "MPowering Benefits",
    "targetProductId": "941C7833-D3D7-4411-8407-B43F2A42F2D1",
    "match": { "mode": "always" },
    "keyStrategy": {
      "type": "planCode",
      "strategies": ["planCode", "tierUa"],
      "tierFields": "Plan_Tier,Plan Tier,Family Size Tier",
      "tierPattern": "^(EE|ES|EC|EF)$",
      "uaFields": "UA",
      "planCodeFields": "Plan Name,Product Name",
      "tierUaSuffixRegex": "(\\d{3,6})(EE|ES|EC|EF)$",
      "uaRelabel": []
    }
  }],
  "tobacco": { "columns": ["Tobacco_Surcharge"], "yesValues": ["Yes"], "yesWhenNumericGreaterThan": 0 },
  "planKey": {
    "strategies": ["planCode", "tierUa"],
    "tierFields": "Plan_Tier,Plan Tier,Family Size Tier",
    "uaFields": "UA",
    "planCodeFields": "Plan Name,Product Name",
    "tierUaSuffixRegex": "(\\d{3,6})(EE|ES|EC|EF)$",
    "uaRelabel": []
  },
  "productMapping": {
    "defaultProductNameContains": "Essential (Sharewell) - 2025",
    "assumedProductId": "941C7833-D3D7-4411-8407-B43F2A42F2D1"
  },
  "householdMemberId": {
    "suffixStripPatterns": ["^(\\d+)(D\\d+)$", "^(MPB\\d+)([A-Z])$"]
  }
}';

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID('tempdb..#MpbTierMapSeed') IS NOT NULL DROP TABLE #MpbTierMapSeed;

  ;WITH TierKeys AS (
    SELECT
      @SharewellVendorId AS VendorId,
      @Essential2025ProductId AS ProductId,
      pp.ProductPricingId,
      CONCAT(
        pp.TierType, N'_',
        LTRIM(RTRIM(REPLACE(REPLACE(CAST(pp.ConfigValue1 AS NVARCHAR(32)), N'$', N''), N',', N'')))
      ) AS SourceProductKey,
      CASE
        WHEN UPPER(LTRIM(RTRIM(ISNULL(pp.TobaccoStatus, N'')))) IN (N'NO', N'N', N'') THEN 0
        ELSE 1
      END AS TobaccoRank
    FROM oe.ProductPricing pp
    WHERE pp.ProductId = @Essential2025ProductId
      AND pp.Status = N'Active'
      AND pp.TierType IS NOT NULL
      AND pp.ConfigValue1 IS NOT NULL
      AND LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(32)))) <> N''
  ),
  Ranked AS (
    SELECT
      VendorId,
      ProductId,
      ProductPricingId,
      SourceProductKey,
      ROW_NUMBER() OVER (
        PARTITION BY SourceProductKey
        ORDER BY TobaccoRank, ProductPricingId
      ) AS rn
    FROM TierKeys
  )
  SELECT VendorId, ProductId, ProductPricingId, SourceProductKey
  INTO #MpbTierMapSeed
  FROM Ranked
  WHERE rn = 1;

  IF @DryRun = 1
  BEGIN
    PRINT 'DRY RUN — sharewell_mpb preset before:';
    SELECT Slug, TobaccoCsvColumn, TobaccoYesValues, LEFT(ImportRulesJson, 200) AS RulesStart
    FROM oe.VendorImportFormatPresets
    WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mpb';

    PRINT 'DRY RUN — duplicate tier_UA keys collapsed (tobacco Yes/No → one map row, prefers Tobacco No):';
    SELECT
      tk.SourceProductKey,
      COUNT(*) AS PricingRowCount
    FROM (
      SELECT
        CONCAT(
          pp.TierType, N'_',
          LTRIM(RTRIM(REPLACE(REPLACE(CAST(pp.ConfigValue1 AS NVARCHAR(32)), N'$', N''), N',', N'')))
        ) AS SourceProductKey
      FROM oe.ProductPricing pp
      WHERE pp.ProductId = @Essential2025ProductId
        AND pp.Status = N'Active'
        AND pp.TierType IS NOT NULL
        AND pp.ConfigValue1 IS NOT NULL
    ) AS tk
    GROUP BY tk.SourceProductKey
    HAVING COUNT(*) > 1
    ORDER BY tk.SourceProductKey;

    PRINT 'DRY RUN — would seed Essential 2025 tier_UA map rows:';
    SELECT SourceProductKey, ProductPricingId, ProductId
    FROM #MpbTierMapSeed
    ORDER BY SourceProductKey;

    SET @MpbMapRowCount = (SELECT COUNT(*) FROM #MpbTierMapSeed);
    PRINT CONCAT('DRY RUN — row count: ', @MpbMapRowCount);
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  UPDATE oe.VendorImportFormatPresets
  SET
    TobaccoCsvColumn = N'Tobacco_Surcharge',
    TobaccoYesValues = N'Yes',
    ImportRulesJson = @MpbRules,
    ModifiedUtc = SYSUTCDATETIME()
  WHERE VendorId = @SharewellVendorId AND Slug = N'sharewell_mpb';

  IF OBJECT_ID('oe.VendorImportProductMap', 'U') IS NOT NULL
  BEGIN
    MERGE oe.VendorImportProductMap AS t
    USING #MpbTierMapSeed AS s
    ON t.VendorId = s.VendorId AND t.SourceProductKey = s.SourceProductKey
    WHEN MATCHED THEN
      UPDATE SET ProductId = s.ProductId, ProductPricingId = s.ProductPricingId, ModifiedDate = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN
      INSERT (VendorId, SourceProductKey, ProductId, ProductPricingId)
      VALUES (s.VendorId, s.SourceProductKey, s.ProductId, s.ProductPricingId);
    PRINT CONCAT('MPB Essential 2025 product map rows affected: ', @@ROWCOUNT);
  END;

  COMMIT TRANSACTION;
  PRINT 'MPB format fix committed.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
