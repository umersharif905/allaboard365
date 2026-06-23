/*
  Auto-seed oe.VendorImportProductMap for ShareWELL (Mightywell) vendor import.

  1) Catalog tier keys (EE_1500, ES_3000, Calstar UA-only, etc.)
  2) Align Health composite file codes (11321_AH3000ES, …) → Essential (Sharewell) pricing tiers

  Run dry-run (default):
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-04-mightywell-vendor-import-product-map-seed.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @EssentialProductId UNIQUEIDENTIFIER = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';

IF OBJECT_ID('oe.VendorImportProductMap', 'U') IS NULL
BEGIN
  RAISERROR('oe.VendorImportProductMap does not exist — run 2026-05-24-vendor-import-schema.sql first.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (SELECT 1 FROM oe.Products WHERE ProductId = @EssentialProductId AND VendorId = @SharewellVendorId)
BEGIN
  RAISERROR('Essential (Sharewell) product not found for vendor — verify @EssentialProductId.', 16, 1);
  RETURN;
END;

IF OBJECT_ID('tempdb..#ImportMapSeed') IS NOT NULL DROP TABLE #ImportMapSeed;

;WITH TierKeys AS (
  SELECT
    pp.ProductPricingId,
    pp.ProductId,
    p.Name AS ProductName,
    UPPER(LTRIM(RTRIM(ISNULL(pp.TierType, N'')))) AS TierType,
    LTRIM(RTRIM(
      COALESCE(
        NULLIF(LTRIM(RTRIM(CAST(pp.ConfigValue1 AS NVARCHAR(50)))), N''),
        NULLIF(LTRIM(RTRIM(CAST(pp.ConfigValue2 AS NVARCHAR(50)))), N''),
        NULLIF(LTRIM(RTRIM(CAST(pp.ConfigValue3 AS NVARCHAR(50)))), N'')
      )
    )) AS UaRaw
  FROM oe.ProductPricing pp
  INNER JOIN oe.Products p ON p.ProductId = pp.ProductId
  WHERE p.VendorId = @SharewellVendorId
    AND p.Status NOT IN (N'Deleted')
    AND pp.Status = N'Active'
),
CatalogKeys AS (
  SELECT
    ProductPricingId,
    ProductId,
    CASE
      WHEN TierType IN (N'EE', N'ES', N'EC', N'EF') AND NULLIF(UaRaw, N'') IS NOT NULL THEN
        TierType + N'_' + CASE
          WHEN UaRaw LIKE N'%.00' THEN LEFT(UaRaw, LEN(UaRaw) - 3)
          WHEN UaRaw LIKE N'%.0' THEN LEFT(UaRaw, LEN(UaRaw) - 2)
          ELSE UaRaw
        END
      WHEN TierType IN (N'EE', N'ES', N'EC', N'EF') THEN TierType
      WHEN NULLIF(UaRaw, N'') IS NOT NULL THEN
        CASE
          WHEN UaRaw LIKE N'%.00' THEN LEFT(UaRaw, LEN(UaRaw) - 3)
          WHEN UaRaw LIKE N'%.0' THEN LEFT(UaRaw, LEN(UaRaw) - 2)
          ELSE UaRaw
        END
      ELSE NULL
    END AS SourceProductKey
  FROM TierKeys
),
CatalogDeduped AS (
  SELECT SourceProductKey, MIN(ProductPricingId) AS ProductPricingId, MIN(ProductId) AS ProductId
  FROM CatalogKeys
  WHERE SourceProductKey IS NOT NULL
  GROUP BY SourceProductKey
),
EssentialTierKeys AS (
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
  FROM oe.ProductPricing pp
  WHERE pp.ProductId = @EssentialProductId
    AND pp.Status = N'Active'
    AND pp.TierType IN (N'EE', N'ES', N'EC', N'EF')
),
AlignComposite AS (
  /* File codes use AH3000* (legacy UA label); Essential catalog UA is 2500 after 2026-04 relabel. */
  SELECT v.SourceProductKey, v.TierType, v.UaNorm
  FROM (VALUES
    (N'11321_AH1500EE', N'EE', N'1500'),
    (N'11321_AH3000EE', N'EE', N'2500'),
    (N'11321_AH1500ES', N'ES', N'1500'),
    (N'11321_AH3000ES', N'ES', N'2500'),
    (N'11321_AH1500EC', N'EC', N'1500'),
    (N'11321_AH3000EC', N'EC', N'2500'),
    (N'11321_AH1500EF', N'EF', N'1500'),
    (N'11321_AH3000EF', N'EF', N'2500')
  ) AS v(SourceProductKey, TierType, UaNorm)
),
AlignMapped AS (
  SELECT
    a.SourceProductKey,
    MIN(e.ProductPricingId) AS ProductPricingId,
    MIN(e.ProductId) AS ProductId
  FROM AlignComposite a
  INNER JOIN EssentialTierKeys e ON e.TierType = a.TierType AND e.UaNorm = a.UaNorm
  GROUP BY a.SourceProductKey
),
Combined AS (
  SELECT SourceProductKey, ProductPricingId, ProductId, N'catalog' AS MapSource FROM CatalogDeduped
  UNION ALL
  SELECT SourceProductKey, ProductPricingId, ProductId, N'align_composite' AS MapSource FROM AlignMapped
),
Deduped AS (
  SELECT
    SourceProductKey,
    ProductPricingId,
    ProductId,
    MapSource,
    ROW_NUMBER() OVER (
      PARTITION BY SourceProductKey
      ORDER BY CASE MapSource WHEN N'align_composite' THEN 0 ELSE 1 END, ProductPricingId
    ) AS rn
  FROM Combined
)
SELECT SourceProductKey, ProductPricingId, ProductId, MapSource
INTO #ImportMapSeed
FROM Deduped
WHERE rn = 1;

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN — no changes written. Set @DryRun = 0 to apply.';

  SELECT MapSource, SourceProductKey, ProductId, ProductPricingId
  FROM #ImportMapSeed
  ORDER BY MapSource, SourceProductKey;

  SELECT COUNT(*) AS WouldUpsertCount FROM #ImportMapSeed;

  SELECT SourceProductKey, COUNT(*) AS Cnt
  FROM #ImportMapSeed
  GROUP BY SourceProductKey
  HAVING COUNT(*) > 1;

  SELECT s.SourceProductKey, p.Name AS ProductName, s.ProductPricingId, N'would_insert' AS RowState
  FROM #ImportMapSeed s
  INNER JOIN oe.Products p ON p.ProductId = s.ProductId
  WHERE s.SourceProductKey LIKE N'11321_AH%'
  ORDER BY s.SourceProductKey;
END
ELSE
BEGIN
  BEGIN TRY
    BEGIN TRANSACTION;

    MERGE oe.VendorImportProductMap AS t
    USING (
      SELECT
        @SharewellVendorId AS VendorId,
        SourceProductKey,
        ProductId,
        ProductPricingId
      FROM #ImportMapSeed
    ) AS s
    ON t.VendorId = s.VendorId AND t.SourceProductKey = s.SourceProductKey
    WHEN MATCHED AND (t.ProductPricingId IS NULL OR t.ProductPricingId <> s.ProductPricingId) THEN
      UPDATE SET ProductId = s.ProductId, ProductPricingId = s.ProductPricingId
    WHEN NOT MATCHED THEN
      INSERT (VendorId, SourceProductKey, ProductId, ProductPricingId)
      VALUES (s.VendorId, s.SourceProductKey, s.ProductId, s.ProductPricingId);

    COMMIT TRANSACTION;
    PRINT 'Seeded VendorImportProductMap (catalog keys + Align 11321_AH* codes).';

    SELECT m.SourceProductKey, p.Name AS ProductName, m.ProductPricingId
    FROM oe.VendorImportProductMap m
    INNER JOIN oe.Products p ON p.ProductId = m.ProductId
    WHERE m.VendorId = @SharewellVendorId
      AND m.SourceProductKey LIKE N'11321_AH%'
    ORDER BY m.SourceProductKey;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(@ErrMsg, 16, 1);
  END CATCH;
END;

DROP TABLE #ImportMapSeed;
