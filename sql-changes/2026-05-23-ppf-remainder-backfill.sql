-- PPF remainder-only storage backfill
-- Adjust PaymentProcessingFee enrollment rows: PremiumAmount -= household included fee on product rows.
-- Terminate PPF rows that become zero (fully included-fee households).
-- Run in same release window as application code that writes remainder-only PPF rows.

SET NOCOUNT ON;

BEGIN TRANSACTION;

-- Dry-run preview (uncomment to inspect before UPDATE)
/*
SELECT
  ppf.EnrollmentId,
  ppf.HouseholdId,
  ppf.PremiumAmount AS CurrentPpfPremium,
  ISNULL(inc.IncludedSum, 0) AS IncludedOnProducts,
  CASE
    WHEN GREATEST(0, ppf.PremiumAmount - ISNULL(inc.IncludedSum, 0)) <= 0.01 THEN 0
    ELSE ROUND(GREATEST(0, ppf.PremiumAmount - ISNULL(inc.IncludedSum, 0)), 2)
  END AS NewPpfPremium
FROM oe.Enrollments ppf
OUTER APPLY (
  SELECT SUM(COALESCE(e.IncludedPaymentProcessingFeeAmount, 0)) AS IncludedSum
  FROM oe.Enrollments e
  WHERE e.HouseholdId = ppf.HouseholdId
    AND (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
    AND e.ProductId IS NOT NULL
    AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
) inc
WHERE ppf.EnrollmentType = 'PaymentProcessingFee'
  AND (ppf.TerminationDate IS NULL OR ppf.TerminationDate > GETUTCDATE());
*/

UPDATE ppf
SET
  PremiumAmount = CASE
    WHEN GREATEST(0, ppf.PremiumAmount - ISNULL(inc.IncludedSum, 0)) <= 0.01 THEN 0
    ELSE ROUND(GREATEST(0, ppf.PremiumAmount - ISNULL(inc.IncludedSum, 0)), 2)
  END,
  TerminationDate = CASE
    WHEN GREATEST(0, ppf.PremiumAmount - ISNULL(inc.IncludedSum, 0)) <= 0.01 THEN CAST(GETUTCDATE() AS DATE)
    ELSE ppf.TerminationDate
  END,
  ModifiedDate = GETUTCDATE()
FROM oe.Enrollments ppf
OUTER APPLY (
  SELECT SUM(COALESCE(e.IncludedPaymentProcessingFeeAmount, 0)) AS IncludedSum
  FROM oe.Enrollments e
  WHERE e.HouseholdId = ppf.HouseholdId
    AND (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
    AND e.ProductId IS NOT NULL
    AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
) inc
WHERE ppf.EnrollmentType = 'PaymentProcessingFee'
  AND (ppf.TerminationDate IS NULL OR ppf.TerminationDate > GETUTCDATE())
  AND ISNULL(inc.IncludedSum, 0) > 0;

COMMIT TRANSACTION;
