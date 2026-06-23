/*
  VendorImportProductMap for MPowering Benefits (tier_UA keys from Plan_Tier + UA).
  Maps Essential (Sharewell) - 2025 tiers. One row per SourceProductKey (prefers Tobacco No).

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-08-vendor-import-mpb-product-map-seed.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @MpbMapRowCount INT;
DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @MpbProductId UNIQUEIDENTIFIER = '941C7833-D3D7-4411-8407-B43F2A42F2D1';

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID('tempdb..#MpbTierMapSeed') IS NOT NULL DROP TABLE #MpbTierMapSeed;

  ;WITH TierKeys AS (
    SELECT
      @SharewellVendorId AS VendorId,
      @MpbProductId AS ProductId,
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
    WHERE pp.ProductId = @MpbProductId
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
      WHERE pp.ProductId = @MpbProductId
        AND pp.Status = N'Active'
        AND pp.TierType IS NOT NULL
        AND pp.ConfigValue1 IS NOT NULL
    ) AS tk
    GROUP BY tk.SourceProductKey
    HAVING COUNT(*) > 1
    ORDER BY tk.SourceProductKey;

    PRINT 'DRY RUN — would MERGE VendorImportProductMap rows:';
    SELECT SourceProductKey, ProductPricingId, ProductId
    FROM #MpbTierMapSeed
    ORDER BY SourceProductKey;

    SET @MpbMapRowCount = (SELECT COUNT(*) FROM #MpbTierMapSeed);
    PRINT CONCAT('DRY RUN — row count: ', @MpbMapRowCount);
    ROLLBACK TRANSACTION;
    RETURN;
  END;

  MERGE oe.VendorImportProductMap AS t
  USING #MpbTierMapSeed AS s
  ON t.VendorId = s.VendorId AND t.SourceProductKey = s.SourceProductKey
  WHEN MATCHED THEN
    UPDATE SET ProductId = s.ProductId, ProductPricingId = s.ProductPricingId, ModifiedDate = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (VendorId, SourceProductKey, ProductId, ProductPricingId)
    VALUES (s.VendorId, s.SourceProductKey, s.ProductId, s.ProductPricingId);

  PRINT CONCAT('MPB product map rows affected: ', @@ROWCOUNT);

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
