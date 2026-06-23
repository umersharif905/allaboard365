/*
  ShareWELL Concierge: set MSRP to base premium and zero SystemFees.

  Why:
  - Product pricing rows should not include processing fee.
  - SystemFees must be 0.00 for all rows.
  - MSRP should be base tier amount only (Net + Override + Commission).

  Behavior:
  - Updates ONLY active rows for ShareWELL Concierge.
  - Keeps NetRate, OverrideRate, VendorCommission unchanged.
  - Sets SystemFees = 0.00.
  - Sets MSRPRate = NetRate + OverrideRate + VendorCommission.
  - Dry run by default.
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
  THROW 50020, 'Product validation failed: ShareWELL Concierge not found for target ProductId.', 1;
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

BEGIN TRY
  BEGIN TRANSACTION;

  -- Preview current values
  SELECT
    'BEFORE' AS Snapshot,
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
    pp.MSRPRate,
    CAST(pp.NetRate + pp.OverrideRate + pp.VendorCommission AS DECIMAL(19,4)) AS ExpectedBaseMSRP
  FROM oe.ProductPricing pp
  WHERE pp.ProductId = @ProductId
    AND pp.Status = 'Active'
  ORDER BY pp.TierType, pp.Label, pp.TobaccoStatus;

  UPDATE pp
    SET pp.SystemFees = CAST(0.00 AS DECIMAL(19,4)),
        pp.MSRPRate = CAST(pp.NetRate + pp.OverrideRate + pp.VendorCommission AS DECIMAL(19,4)),
        pp.ModifiedDate = @Now,
        pp.ModifiedBy = @Actor
  FROM oe.ProductPricing pp
  WHERE pp.ProductId = @ProductId
    AND pp.Status = 'Active';

  DECLARE @RowsUpdated INT = @@ROWCOUNT;

  -- Preview post-update values
  SELECT
    CASE WHEN @DryRun = 1 THEN 'DRY_RUN' ELSE 'APPLY' END AS RunMode,
    @RowsUpdated AS RowsUpdated;

  SELECT
    'AFTER' AS Snapshot,
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
