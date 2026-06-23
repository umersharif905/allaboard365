/*
  Add Align SHA file codes 11321_AH1500FM / 11321_AH3000FM only.
  Same Essential (ShareWELL) pricing as existing 11321_AH1500EF / 11321_AH3000EF.
  Does NOT re-seed catalog keys (EE_1500, EF, etc.).

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-07-align-sha-fm-composite-product-map.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @SharewellVendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @EssentialProductId UNIQUEIDENTIFIER = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';

IF OBJECT_ID('oe.VendorImportProductMap', 'U') IS NULL
BEGIN
  RAISERROR('oe.VendorImportProductMap does not exist.', 16, 1);
  RETURN;
END;

IF OBJECT_ID('tempdb..#FmOnly') IS NOT NULL DROP TABLE #FmOnly;

SELECT v.SourceProductKey, v.ProductPricingId
INTO #FmOnly
FROM (VALUES
  (N'11321_AH1500FM', CAST('C58144CB-1058-4F80-AB29-4B0540B112E4' AS UNIQUEIDENTIFIER)),
  (N'11321_AH3000FM', CAST('735E9183-D77D-4F2A-89B2-494D500AA822' AS UNIQUEIDENTIFIER))
) AS v(SourceProductKey, ProductPricingId);

IF EXISTS (
  SELECT 1
  FROM #FmOnly f
  LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = f.ProductPricingId
    AND pp.ProductId = @EssentialProductId
    AND pp.Status = N'Active'
  WHERE pp.ProductPricingId IS NULL
)
BEGIN
  RAISERROR('Essential pricing row missing for FM map — verify ProductPricingIds match 11321_AH1500EF / 11321_AH3000EF.', 16, 1);
  RETURN;
END;

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN — no changes written. Set @DryRun = 0 to apply.';

  SELECT
    f.SourceProductKey,
    CASE WHEN m.MapId IS NOT NULL THEN N'already_mapped' ELSE N'would_insert' END AS RowState,
    @EssentialProductId AS ProductId,
    f.ProductPricingId,
    pp.TierType,
    pp.ConfigValue1 AS Ua,
    ef.SourceProductKey AS SamePricingAs
  FROM #FmOnly f
  LEFT JOIN oe.VendorImportProductMap m
    ON m.VendorId = @SharewellVendorId AND m.SourceProductKey = f.SourceProductKey
  INNER JOIN oe.ProductPricing pp ON pp.ProductPricingId = f.ProductPricingId
  LEFT JOIN oe.VendorImportProductMap ef
    ON ef.VendorId = @SharewellVendorId
   AND ef.ProductPricingId = f.ProductPricingId
   AND ef.SourceProductKey IN (N'11321_AH1500EF', N'11321_AH3000EF')
  ORDER BY f.SourceProductKey;

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  MERGE oe.VendorImportProductMap AS t
  USING (
    SELECT
      @SharewellVendorId AS VendorId,
      f.SourceProductKey,
      @EssentialProductId AS ProductId,
      f.ProductPricingId
    FROM #FmOnly f
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

  SELECT m.SourceProductKey, m.ProductId, m.ProductPricingId, pp.TierType, pp.ConfigValue1 AS Ua
  FROM oe.VendorImportProductMap m
  INNER JOIN oe.ProductPricing pp ON pp.ProductPricingId = m.ProductPricingId
  WHERE m.VendorId = @SharewellVendorId
    AND m.SourceProductKey IN (N'11321_AH1500FM', N'11321_AH3000FM')
  ORDER BY m.SourceProductKey;

  PRINT 'Inserted/updated 11321_AH1500FM and 11321_AH3000FM only.';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;

DROP TABLE #FmOnly;
