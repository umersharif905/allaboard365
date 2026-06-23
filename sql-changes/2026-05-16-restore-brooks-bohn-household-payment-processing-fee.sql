/*
  Brooks Bohn household (HouseholdId = primary MemberId 9FC78B5F-4E46-4428-8B4A-C5E4633425B3).

  Prod check (2026-05-16): active product premiums sum to 690.91 + system fee 3.50 = 694.41.
  Target ~715/mo matches historical PaymentProcessingFee row 8EAC0B9C... (terminated 2026-04-30)
  with PremiumAmount 20.73 → 694.41 + 20.73 ≈ 715.14.

  Current active PPF row 3BF0BED0-A62F-4D44-9657-03873A951468 shows 2.84 (post-migration trim).

  Run SELECT first; then UPDATE with a write-capable login (not oe_ai_readonly).
*/

DECLARE @H UNIQUEIDENTIFIER = '9FC78B5F-4E46-4428-8B4A-C5E4633425B3';

DECLARE @PpfEnrollmentId UNIQUEIDENTIFIER = '3BF0BED0-A62F-4D44-9657-03873A951468';
DECLARE @TargetPpfPremium DECIMAL(19, 4) = 20.73; -- from prior active row 8EAC0B9C-26DE-4036-B38F-54FBBB5DE4EA

SELECT
  e.EnrollmentId,
  e.EnrollmentType,
  e.Status,
  e.PremiumAmount AS CurrentPremium,
  @TargetPpfPremium AS TargetPremium,
  e.EffectiveDate,
  e.TerminationDate,
  m.MemberId
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE e.EnrollmentId = @PpfEnrollmentId
  AND m.HouseholdId = @H
  AND e.EnrollmentType = N'PaymentProcessingFee';

/*
UPDATE e
SET
  e.PremiumAmount = @TargetPpfPremium,
  e.ModifiedDate = GETUTCDATE()
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE e.EnrollmentId = @PpfEnrollmentId
  AND m.HouseholdId = @H
  AND e.EnrollmentType = N'PaymentProcessingFee'
  AND e.Status = N'Active';
*/
