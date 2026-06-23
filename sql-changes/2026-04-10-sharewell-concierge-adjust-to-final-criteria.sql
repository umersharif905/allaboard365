/*
  ShareWELL Concierge pricing adjustments to final criteria.
  - Updates ONLY active pricing rows for ProductId 4B0E0672-810B-4BCE-8B95-07EA7E84B698
  - Matches rows by TierType + Label + TobaccoStatus + MinAge + MaxAge
  - Dry run by default
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1; -- 1 = preview + rollback, 0 = apply + commit
DECLARE @Now DATETIME2(7) = SYSUTCDATETIME();
DECLARE @ProductId UNIQUEIDENTIFIER = '4B0E0672-810B-4BCE-8B95-07EA7E84B698';

IF NOT EXISTS (
  SELECT 1
  FROM oe.Products p
  WHERE p.ProductId = @ProductId
    AND p.Name = 'ShareWELL Concierge'
)
BEGIN
  THROW 50010, 'Product validation failed: ShareWELL Concierge not found for target ProductId.', 1;
END;

DECLARE @Actor UNIQUEIDENTIFIER;
SELECT TOP 1
  @Actor = COALESCE(pp.ModifiedBy, pp.CreatedBy)
FROM oe.ProductPricing pp
WHERE pp.ProductId = @ProductId
  AND pp.Status = 'Active'
  AND COALESCE(pp.ModifiedBy, pp.CreatedBy) IS NOT NULL
ORDER BY pp.ModifiedDate DESC, pp.CreatedDate DESC;

IF @Actor IS NULL
  SET @Actor = '00000000-0000-0000-0000-000000000000';

IF OBJECT_ID('tempdb..#Target') IS NOT NULL
  DROP TABLE #Target;

CREATE TABLE #Target (
  TierType NVARCHAR(50) NOT NULL,
  Label NVARCHAR(100) NOT NULL,
  TobaccoStatus NVARCHAR(50) NOT NULL,
  MinAge INT NOT NULL,
  MaxAge INT NOT NULL,
  NetRate DECIMAL(19,4) NOT NULL,
  OverrideRate DECIMAL(19,4) NOT NULL,
  VendorCommission DECIMAL(19,4) NOT NULL,
  SystemFees DECIMAL(19,4) NOT NULL,
  MSRPRate DECIMAL(19,4) NOT NULL
);

INSERT INTO #Target (
  TierType, Label, TobaccoStatus, MinAge, MaxAge,
  NetRate, OverrideRate, VendorCommission, SystemFees, MSRPRate
)
VALUES
  ('EE','EE 2500 Up to 45','No',18,45,122.50,3.50,0.00,4.00,130.00),
  ('EE','EE 2500 Up to 45','Yes',18,45,219.50,3.50,0.00,7.00,230.00),
  ('EE','EE 5000 Up to 45','No',18,45,78.50,3.50,0.00,3.00,85.00),
  ('EE','EE 5000 Up to 45','Yes',18,45,175.50,3.50,0.00,6.00,185.00),

  ('ES','ES 2500 Up to 45','No',18,45,232.50,3.50,0.00,8.00,244.00),
  ('ES','ES 2500 Up to 45','Yes',18,45,329.50,3.50,0.00,11.00,344.00),
  ('ES','ES 5000 Up to 45','No',18,45,176.50,3.50,0.00,6.00,186.00),
  ('ES','ES 5000 Up to 45','Yes',18,45,273.50,3.50,0.00,9.00,286.00),

  ('EC','EC 2500 Up to 45','No',18,45,227.50,3.50,0.00,8.00,239.00),
  ('EC','EC 2500 Up to 45','Yes',18,45,324.50,3.50,0.00,11.00,339.00),
  ('EC','EC 5000 Up to 45','No',18,45,171.50,3.50,0.00,6.00,181.00),
  ('EC','EC 5000 Up to 45','Yes',18,45,268.50,3.50,0.00,9.00,281.00),

  ('EF','EF 2500 Up to 45','No',18,45,340.50,3.50,0.00,11.00,355.00),
  ('EF','EF 2500 Up to 45','Yes',18,45,437.50,3.50,0.00,14.00,455.00),
  ('EF','EF 5000 Up to 45','No',18,45,279.50,3.50,0.00,9.00,292.00),
  ('EF','EF 5000 Up to 45','Yes',18,45,376.50,3.50,0.00,12.00,392.00),

  ('EE','EE 2500 Over 45','No',46,64,135.44,72.56,0.00,7.00,215.00),
  ('EE','EE 2500 Over 45','Yes',46,64,232.44,72.56,0.00,10.00,315.00),
  ('EE','EE 5000 Over 45','No',46,64,87.44,66.56,0.00,5.00,159.00),
  ('EE','EE 5000 Over 45','Yes',46,64,184.44,66.56,0.00,8.00,259.00),

  ('ES','ES 2500 Over 45','No',46,64,261.36,105.64,0.00,12.00,379.00),
  ('ES','ES 2500 Over 45','Yes',46,64,358.36,105.64,0.00,15.00,479.00),
  ('ES','ES 5000 Over 45','No',46,64,198.36,97.64,0.00,10.00,306.00),
  ('ES','ES 5000 Over 45','Yes',46,64,295.36,97.64,0.00,13.00,406.00),

  ('EC','EC 2500 Over 45','No',46,64,260.60,109.40,0.00,12.00,382.00),
  ('EC','EC 2500 Over 45','Yes',46,64,357.60,109.40,0.00,15.00,482.00),
  ('EC','EC 5000 Over 45','No',46,64,197.40,101.60,0.00,10.00,309.00),
  ('EC','EC 5000 Over 45','Yes',46,64,294.40,101.60,0.00,13.00,409.00),

  ('EF','EF 2500 Over 45','No',46,64,387.88,143.12,0.00,17.00,548.00),
  ('EF','EF 2500 Over 45','Yes',46,64,484.88,143.12,0.00,20.00,648.00),
  ('EF','EF 5000 Over 45','No',46,64,319.28,134.72,0.00,15.00,469.00),
  ('EF','EF 5000 Over 45','Yes',46,64,417.28,134.72,0.00,17.00,569.00);

-- Validate target set integrity
IF (SELECT COUNT(*) FROM #Target) <> 32
  THROW 50011, 'Target set must contain exactly 32 pricing rows.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  ;WITH ActiveRows AS (
    SELECT
      pp.ProductPricingId,
      pp.TierType,
      pp.Label,
      pp.TobaccoStatus,
      pp.MinAge,
      pp.MaxAge,
      pp.NetRate,
      pp.OverrideRate,
      pp.VendorCommission,
      pp.SystemFees,
      pp.MSRPRate
    FROM oe.ProductPricing pp
    WHERE pp.ProductId = @ProductId
      AND pp.Status = 'Active'
  )
  SELECT
    'MISSING_IN_ACTIVE' AS DiffType,
    t.TierType, t.Label, t.TobaccoStatus, t.MinAge, t.MaxAge
  FROM #Target t
  LEFT JOIN ActiveRows a
    ON a.TierType = t.TierType
   AND a.Label = t.Label
   AND a.TobaccoStatus = t.TobaccoStatus
   AND a.MinAge = t.MinAge
   AND a.MaxAge = t.MaxAge
  WHERE a.ProductPricingId IS NULL
  UNION ALL
  SELECT
    'EXTRA_ACTIVE' AS DiffType,
    a.TierType, a.Label, a.TobaccoStatus, a.MinAge, a.MaxAge
  FROM ActiveRows a
  LEFT JOIN #Target t
    ON a.TierType = t.TierType
   AND a.Label = t.Label
   AND a.TobaccoStatus = t.TobaccoStatus
   AND a.MinAge = t.MinAge
   AND a.MaxAge = t.MaxAge
  WHERE t.TierType IS NULL;

  IF EXISTS (
    SELECT 1
    FROM oe.ProductPricing pp
    WHERE pp.ProductId = @ProductId
      AND pp.Status = 'Active'
    GROUP BY pp.ProductId
    HAVING COUNT(*) <> 32
  )
  BEGIN
    THROW 50012, 'Expected exactly 32 active pricing rows before adjustment.', 1;
  END;

  IF EXISTS (
    SELECT 1
    FROM #Target t
    LEFT JOIN oe.ProductPricing pp
      ON pp.ProductId = @ProductId
     AND pp.Status = 'Active'
     AND pp.TierType = t.TierType
     AND pp.Label = t.Label
     AND pp.TobaccoStatus = t.TobaccoStatus
     AND pp.MinAge = t.MinAge
     AND pp.MaxAge = t.MaxAge
    WHERE pp.ProductPricingId IS NULL
  )
  BEGIN
    THROW 50013, 'Active rows do not match target key set. Aborting update.', 1;
  END;

  UPDATE pp
    SET pp.NetRate = t.NetRate,
        pp.OverrideRate = t.OverrideRate,
        pp.VendorCommission = t.VendorCommission,
        pp.SystemFees = t.SystemFees,
        pp.MSRPRate = t.MSRPRate,
        pp.ModifiedDate = @Now,
        pp.ModifiedBy = @Actor
  FROM oe.ProductPricing pp
  INNER JOIN #Target t
    ON pp.TierType = t.TierType
   AND pp.Label = t.Label
   AND pp.TobaccoStatus = t.TobaccoStatus
   AND pp.MinAge = t.MinAge
   AND pp.MaxAge = t.MaxAge
  WHERE pp.ProductId = @ProductId
    AND pp.Status = 'Active';

  DECLARE @RowsUpdated INT = @@ROWCOUNT;

  SELECT
    CASE WHEN @DryRun = 1 THEN 'DRY_RUN' ELSE 'APPLY' END AS RunMode,
    @RowsUpdated AS RowsUpdated;

  SELECT
    pp.TierType,
    pp.Label,
    pp.TobaccoStatus,
    pp.MinAge,
    pp.MaxAge,
    pp.NetRate,
    pp.OverrideRate,
    pp.VendorCommission,
    pp.SystemFees,
    pp.MSRPRate
  FROM oe.ProductPricing pp
  WHERE pp.ProductId = @ProductId
    AND pp.Status = 'Active'
  ORDER BY pp.TierType, pp.Label, pp.TobaccoStatus;

  IF @DryRun = 1
  BEGIN
    ROLLBACK TRANSACTION;
    SELECT 'DRY RUN complete: changes rolled back.' AS Outcome;
  END
  ELSE
  BEGIN
    COMMIT TRANSACTION;
    SELECT 'APPLY complete: changes committed.' AS Outcome;
  END
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
    ROLLBACK TRANSACTION;
  THROW;
END CATCH;
