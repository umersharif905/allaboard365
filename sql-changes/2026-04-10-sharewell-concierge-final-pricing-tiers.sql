/*
  ShareWELL Concierge final pricing tiers (Pinnacle Life Group bundle support)
  - Default behavior is DRY RUN (no committed changes)
  - Set @DryRun = 0 to apply
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1; -- 1 = preview and rollback, 0 = apply and commit
DECLARE @RunLabel NVARCHAR(100) = CASE WHEN @DryRun = 1 THEN N'DRY_RUN' ELSE N'APPLY' END;
DECLARE @Now DATETIME2(7) = SYSUTCDATETIME();
DECLARE @Actor UNIQUEIDENTIFIER;
DECLARE @EffectiveDate DATE;

DECLARE @ProductId UNIQUEIDENTIFIER = '4B0E0672-810B-4BCE-8B95-07EA7E84B698';

IF NOT EXISTS (
  SELECT 1
  FROM oe.Products p
  WHERE p.ProductId = @ProductId
    AND p.Name = 'ShareWELL Concierge'
)
BEGIN
  THROW 50001, 'Product validation failed for ShareWELL Concierge ProductId.', 1;
END;

SELECT TOP 1
  @Actor = COALESCE(pp.ModifiedBy, pp.CreatedBy)
FROM oe.ProductPricing pp
WHERE pp.ProductId = @ProductId
  AND COALESCE(pp.ModifiedBy, pp.CreatedBy) IS NOT NULL
ORDER BY pp.ModifiedDate DESC, pp.CreatedDate DESC;

IF @Actor IS NULL
BEGIN
  SELECT TOP 1
    @Actor = COALESCE(p.ModifiedBy, p.CreatedBy, p.UpdatedBy)
  FROM oe.Products p
  WHERE p.ProductId = @ProductId;
END;

IF @Actor IS NULL
BEGIN
  -- fallback technical user GUID when no audit GUID exists
  SET @Actor = '00000000-0000-0000-0000-000000000000';
END;

SELECT TOP 1
  @EffectiveDate = pp.EffectiveDate
FROM oe.ProductPricing pp
WHERE pp.ProductId = @ProductId
  AND pp.Status = 'Active'
  AND pp.EffectiveDate IS NOT NULL
ORDER BY pp.EffectiveDate DESC, pp.ModifiedDate DESC;

IF @EffectiveDate IS NULL
BEGIN
  SELECT TOP 1
    @EffectiveDate = CAST(p.EffectiveDate AS DATE)
  FROM oe.Products p
  WHERE p.ProductId = @ProductId
    AND p.EffectiveDate IS NOT NULL;
END;

IF @EffectiveDate IS NULL
BEGIN
  SET @EffectiveDate = CAST(@Now AS DATE);
END;

IF OBJECT_ID('tempdb..#NewPricing') IS NOT NULL
  DROP TABLE #NewPricing;

CREATE TABLE #NewPricing (
  TierType VARCHAR(10) NOT NULL,
  TobaccoStatus VARCHAR(10) NOT NULL,
  UnsharedAmount INT NOT NULL,
  AgeBand VARCHAR(20) NOT NULL,
  MinAge INT NOT NULL,
  MaxAge INT NOT NULL,
  NetRate DECIMAL(10,2) NOT NULL,
  OverrideRate DECIMAL(10,2) NOT NULL,
  VendorCommission DECIMAL(10,2) NOT NULL,
  SystemFees DECIMAL(10,2) NOT NULL,
  MSRPRate DECIMAL(10,2) NOT NULL
);

INSERT INTO #NewPricing (
  TierType, TobaccoStatus, UnsharedAmount, AgeBand, MinAge, MaxAge,
  NetRate, OverrideRate, VendorCommission, SystemFees, MSRPRate
)
VALUES
  -- Up to 45 / 2500
  ('EE','No', 2500,'UpTo45',18,45,129.50,  3.50,0.00, 4.00,130.00),
  ('EE','Yes',2500,'UpTo45',18,45,226.50,  3.50,0.00, 7.00,230.00),
  ('ES','No', 2500,'UpTo45',18,45,242.50,  3.50,0.00, 8.00,254.00),
  ('ES','Yes',2500,'UpTo45',18,45,339.50,  3.50,0.00,11.00,354.00),
  ('EC','No', 2500,'UpTo45',18,45,238.50,  3.50,0.00, 8.00,250.00),
  ('EC','Yes',2500,'UpTo45',18,45,335.50,  3.50,0.00,11.00,350.00),
  ('EF','No', 2500,'UpTo45',18,45,353.50,  3.50,0.00,11.00,368.00),
  ('EF','Yes',2500,'UpTo45',18,45,450.50,  3.50,0.00,14.00,468.00),
  -- Up to 45 / 5000
  ('EE','No', 5000,'UpTo45',18,45, 85.50,  3.50,0.00, 3.00, 92.00),
  ('EE','Yes',5000,'UpTo45',18,45,182.50,  3.50,0.00, 6.00,192.00),
  ('ES','No', 5000,'UpTo45',18,45,186.50,  3.50,0.00, 6.00,196.00),
  ('ES','Yes',5000,'UpTo45',18,45,283.50,  3.50,0.00, 9.00,296.00),
  ('EC','No', 5000,'UpTo45',18,45,182.50,  3.50,0.00, 6.00,192.00),
  ('EC','Yes',5000,'UpTo45',18,45,279.50,  3.50,0.00, 9.00,292.00),
  ('EF','No', 5000,'UpTo45',18,45,292.50,  3.50,0.00, 9.00,305.00),
  ('EF','Yes',5000,'UpTo45',18,45,389.50,  3.50,0.00,12.00,405.00),
  -- Over 45 / 2500
  ('EE','No', 2500,'Over45',46,64,142.44, 72.56,0.00, 7.00,222.00),
  ('EE','Yes',2500,'Over45',46,64,239.44, 72.56,0.00,10.00,322.00),
  ('ES','No', 2500,'Over45',46,64,271.36,105.64,0.00,12.00,389.00),
  ('ES','Yes',2500,'Over45',46,64,368.36,105.64,0.00,15.00,489.00),
  ('EC','No', 2500,'Over45',46,64,271.60,109.40,0.00,12.00,393.00),
  ('EC','Yes',2500,'Over45',46,64,368.60,109.40,0.00,15.00,493.00),
  ('EF','No', 2500,'Over45',46,64,400.88,143.12,0.00,17.00,561.00),
  ('EF','Yes',2500,'Over45',46,64,497.88,143.12,0.00,20.00,661.00),
  -- Over 45 / 5000
  ('EE','No', 5000,'Over45',46,64, 94.44, 66.56,0.00, 5.00,166.00),
  ('EE','Yes',5000,'Over45',46,64,191.44, 66.56,0.00, 8.00,266.00),
  ('ES','No', 5000,'Over45',46,64,208.36, 97.64,0.00,10.00,316.00),
  ('ES','Yes',5000,'Over45',46,64,305.36, 97.64,0.00,13.00,416.00),
  ('EC','No', 5000,'Over45',46,64,208.40,101.60,0.00,10.00,320.00),
  ('EC','Yes',5000,'Over45',46,64,305.40,101.60,0.00,13.00,420.00),
  ('EF','No', 5000,'Over45',46,64,332.28,134.72,0.00,15.00,482.00),
  ('EF','Yes',5000,'Over45',46,64,430.28,134.72,0.00,17.00,582.00);

DECLARE @RowsToInsert INT = (SELECT COUNT(*) FROM #NewPricing);

IF EXISTS (
  SELECT
    np.TierType,
    np.UnsharedAmount,
    np.AgeBand,
    np.MinAge,
    np.MaxAge
  FROM #NewPricing np
  GROUP BY
    np.TierType,
    np.UnsharedAmount,
    np.AgeBand,
    np.MinAge,
    np.MaxAge
  HAVING
    SUM(CASE WHEN np.TobaccoStatus = 'Yes' THEN 1 ELSE 0 END) = 0
    OR SUM(CASE WHEN np.TobaccoStatus = 'No' THEN 1 ELSE 0 END) = 0
)
BEGIN
  THROW 50002, 'Preflight validation failed: every TierType/UnsharedAmount/AgeBand/MinAge/MaxAge group must include both TobaccoStatus Yes and No rows.', 1;
END;

SELECT
  @RunLabel AS RunMode,
  p.ProductId,
  p.Name AS ProductName,
  p.Status AS ProductStatus,
  @RowsToInsert AS NewRowsPrepared
FROM oe.Products p
WHERE p.ProductId = @ProductId;

SELECT
  'CURRENT_ACTIVE_BEFORE' AS PreviewType,
  pp.ProductPricingId,
  pp.PricingName,
  pp.TierType,
  pp.TobaccoStatus,
  pp.MinAge,
  pp.MaxAge,
  pp.NetRate,
  pp.OverrideRate,
  pp.VendorCommission,
  pp.SystemFees,
  pp.MSRPRate,
  pp.ConfigField1,
  pp.ConfigValue1,
  pp.ConfigField2,
  pp.ConfigValue2,
  pp.Label,
  pp.Status
FROM oe.ProductPricing pp
WHERE pp.ProductId = @ProductId
  AND pp.Status = 'Active'
ORDER BY pp.TierType, pp.TobaccoStatus, pp.MinAge, pp.MaxAge, pp.MSRPRate;

BEGIN TRY
  BEGIN TRANSACTION;

  UPDATE pp
    SET pp.Status = 'Inactive',
        pp.TerminationDate = COALESCE(pp.TerminationDate, @Now),
        pp.ModifiedDate = @Now,
        pp.ModifiedBy = @Actor
  FROM oe.ProductPricing pp
  WHERE pp.ProductId = @ProductId
    AND pp.Status = 'Active';

  DECLARE @RowsInactivated INT = @@ROWCOUNT;

  INSERT INTO oe.ProductPricing (
    ProductPricingId,
    ProductId,
    PricingName,
    NetRate,
    OverrideRate,
    VendorCommission,
    SystemFees,
    MSRPRate,
    MinAge,
    MaxAge,
    TierType,
    TobaccoStatus,
    ConfigField1,
    ConfigField2,
    ConfigValue1,
    ConfigValue2,
    EffectiveDate,
    Status,
    CreatedDate,
    ModifiedDate,
    CreatedBy,
    ModifiedBy,
    Label
  )
  SELECT
    NEWID(),
    @ProductId,
    CONCAT(np.TierType, '_', CASE WHEN np.TobaccoStatus = 'Yes' THEN 'Yes' ELSE 'No' END),
    np.NetRate,
    np.OverrideRate,
    np.VendorCommission,
    np.SystemFees,
    np.MSRPRate,
    np.MinAge,
    np.MaxAge,
    np.TierType,
    np.TobaccoStatus,
    'UnsharedAmount',
    'AgeBand',
    CAST(np.UnsharedAmount AS VARCHAR(20)),
    np.AgeBand,
    @EffectiveDate,
    'Active',
    @Now,
    @Now,
    @Actor,
    @Actor,
    CONCAT(
      np.TierType,
      ' ',
      np.UnsharedAmount,
      ' ',
      CASE
        WHEN np.AgeBand = 'UpTo45' THEN 'Up to 45'
        WHEN np.AgeBand = 'Over45' THEN 'Over 45'
        ELSE np.AgeBand
      END
    )
  FROM #NewPricing np;

  DECLARE @RowsInserted INT = @@ROWCOUNT;

  SELECT
    @RunLabel AS RunMode,
    @RowsInactivated AS RowsInactivated,
    @RowsInserted AS RowsInserted,
    (SELECT COUNT(*) FROM oe.ProductPricing pp WHERE pp.ProductId = @ProductId AND pp.Status = 'Active') AS ActiveRowsAfterMutation;

  SELECT
    'ACTIVE_AFTER_MUTATION' AS PreviewType,
    pp.ProductPricingId,
    pp.PricingName,
    pp.TierType,
    pp.TobaccoStatus,
    pp.MinAge,
    pp.MaxAge,
    pp.NetRate,
    pp.OverrideRate,
    pp.VendorCommission,
    pp.SystemFees,
    pp.MSRPRate,
    pp.ConfigField1,
    pp.ConfigValue1,
    pp.ConfigField2,
    pp.ConfigValue2,
    pp.Label,
    pp.Status
  FROM oe.ProductPricing pp
  WHERE pp.ProductId = @ProductId
    AND pp.Status = 'Active'
  ORDER BY pp.TierType, pp.ConfigValue1, pp.ConfigValue2, pp.TobaccoStatus;

  IF @DryRun = 1
  BEGIN
    ROLLBACK TRANSACTION;
    SELECT 'DRY RUN complete: all changes rolled back.' AS Outcome;
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
