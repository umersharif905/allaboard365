/*
  Add processing-fee inclusion flags to tenant product subscriptions.

  - IncludeProcessingFee: when enabled, payment processing fees are included in the product premium (no separate fee line)
  - RoundUpProcessingFee: when enabled, included processing fee is rounded up to the nearest cent (matches existing fee rounding behavior)
*/

IF COL_LENGTH('oe.TenantProductSubscriptions', 'IncludeProcessingFee') IS NULL
BEGIN
  ALTER TABLE oe.TenantProductSubscriptions
    ADD IncludeProcessingFee bit NOT NULL
      CONSTRAINT DF_TenantProductSubscriptions_IncludeProcessingFee DEFAULT (0);
END

IF COL_LENGTH('oe.TenantProductSubscriptions', 'RoundUpProcessingFee') IS NULL
BEGIN
  ALTER TABLE oe.TenantProductSubscriptions
    ADD RoundUpProcessingFee bit NOT NULL
      CONSTRAINT DF_TenantProductSubscriptions_RoundUpProcessingFee DEFAULT (1);
END

