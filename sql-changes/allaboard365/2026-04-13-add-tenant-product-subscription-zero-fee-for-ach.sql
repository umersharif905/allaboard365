/*
  Add zero-fee-for-ACH flag to tenant product subscriptions.

  - ZeroFeeForACH: when enabled, this product's processing fee is $0 when paid via ACH.
    For credit card payments, the tenant's configured CC fee still applies.
    Used for products like ShareWELL where ACH payments incur no processing fee.
*/

IF COL_LENGTH('oe.TenantProductSubscriptions', 'ZeroFeeForACH') IS NULL
BEGIN
  ALTER TABLE oe.TenantProductSubscriptions
    ADD ZeroFeeForACH bit NOT NULL
      CONSTRAINT DF_TenantProductSubscriptions_ZeroFeeForACH DEFAULT (0);
END
