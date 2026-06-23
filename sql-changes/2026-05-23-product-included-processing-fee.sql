/*
  Product-level included processing fee configuration and per-tier stored amounts.

  - oe.Products: wizard-level flags and % used for tier recalculation
  - oe.ProductPricing.IncludedProcessingFee: persisted dollars per tier (runtime source when Products.IncludeProcessingFee = 1)
*/

IF COL_LENGTH('oe.Products', 'IncludeProcessingFee') IS NULL
BEGIN
  ALTER TABLE oe.Products
    ADD IncludeProcessingFee bit NOT NULL
      CONSTRAINT DF_Products_IncludeProcessingFee DEFAULT (0);
END

IF COL_LENGTH('oe.Products', 'RoundUpProcessingFee') IS NULL
BEGIN
  ALTER TABLE oe.Products
    ADD RoundUpProcessingFee bit NOT NULL
      CONSTRAINT DF_Products_RoundUpProcessingFee DEFAULT (1);
END

IF COL_LENGTH('oe.Products', 'ProcessingFeePercentage') IS NULL
BEGIN
  ALTER TABLE oe.Products
    ADD ProcessingFeePercentage decimal(9, 4) NULL;
END

IF COL_LENGTH('oe.ProductPricing', 'IncludedProcessingFee') IS NULL
BEGIN
  ALTER TABLE oe.ProductPricing
    ADD IncludedProcessingFee decimal(19, 4) NOT NULL
      CONSTRAINT DF_ProductPricing_IncludedProcessingFee DEFAULT (0);
END

GO
