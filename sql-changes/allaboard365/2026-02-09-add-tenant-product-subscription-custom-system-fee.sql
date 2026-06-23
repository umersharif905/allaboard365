/*
  Add custom system fee option to tenant product subscriptions.

  - CustomSystemFeeEnabled: when enabled, this product's custom system fee overrides tenant-level member-charged system fee for enrollments that include this product
  - CustomSystemFeeAmount: flat amount (e.g. 5.00) charged as system fee when CustomSystemFeeEnabled = 1. If multiple selected products have custom system fee, the highest amount is used.
*/

IF COL_LENGTH('oe.TenantProductSubscriptions', 'CustomSystemFeeEnabled') IS NULL
BEGIN
  ALTER TABLE oe.TenantProductSubscriptions
    ADD CustomSystemFeeEnabled bit NOT NULL
      CONSTRAINT DF_TenantProductSubscriptions_CustomSystemFeeEnabled DEFAULT (0);
END

IF COL_LENGTH('oe.TenantProductSubscriptions', 'CustomSystemFeeAmount') IS NULL
BEGIN
  ALTER TABLE oe.TenantProductSubscriptions
    ADD CustomSystemFeeAmount decimal(19,4) NULL;
END
