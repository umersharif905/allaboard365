/*
  Add per-product included fee allocation columns to oe.Enrollments.

  These columns are used for UI display math only:
  - Product enrollment PremiumAmount remains the base product premium.
  - Fee enrollments (EnrollmentType = PaymentProcessingFee/SystemFee) store the full totals.
  - Included* columns on Product rows indicate how much fee should be displayed inside that product’s premium and deducted from the Fees line.
*/

IF COL_LENGTH('oe.Enrollments', 'IncludedPaymentProcessingFeeAmount') IS NULL
BEGIN
  ALTER TABLE oe.Enrollments
    ADD IncludedPaymentProcessingFeeAmount decimal(19,4) NOT NULL
      CONSTRAINT DF_Enrollments_IncludedPaymentProcessingFeeAmount DEFAULT (0);
END

IF COL_LENGTH('oe.Enrollments', 'IncludedSystemFeeAmount') IS NULL
BEGIN
  ALTER TABLE oe.Enrollments
    ADD IncludedSystemFeeAmount decimal(19,4) NOT NULL
      CONSTRAINT DF_Enrollments_IncludedSystemFeeAmount DEFAULT (0);
END

