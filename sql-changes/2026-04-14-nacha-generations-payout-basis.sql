-- Add PayoutBasis column to oe.NACHAGenerations
-- Records which payout logic was used when generating the NACHA file:
-- 'effectiveEnrollment' = filtered by invoice BillingPeriod (coverage effective date)
-- 'paymentReceived' = filtered by PaymentDate (when payment was collected)
-- NULL = legacy NACHA generated before this column existed (treat as paymentReceived)

ALTER TABLE oe.NACHAGenerations
ADD PayoutBasis NVARCHAR(50) NULL;
GO

-- Backfill: leave existing NACHAs as NULL (legacy = paymentReceived behavior)
-- New NACHAs will populate this at generation time
