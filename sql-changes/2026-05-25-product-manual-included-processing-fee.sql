/*
  Product-level flag: wizard uses hand-entered IncludedProcessingFee per tier
  instead of auto-calculating from ProcessingFeePercentage / RoundUpProcessingFee.

  Per-tier dollar amounts remain on oe.ProductPricing.IncludedProcessingFee.
*/

IF COL_LENGTH('oe.Products', 'ManualIncludedProcessingFee') IS NULL
BEGIN
  ALTER TABLE oe.Products
    ADD ManualIncludedProcessingFee bit NOT NULL
      CONSTRAINT DF_Products_ManualIncludedProcessingFee DEFAULT (0);
END

GO
