/*
  Manual adjustment: EF & S Concrete (GroupId A423CFAE-5E63-4630-832E-BD1A14E16C78)
  Reduces PaymentProcessingFee enrollment PremiumAmount by $6.00 for three households.

  Run the SELECT first.

  • If premium is still at original ($10.40 / $13.52 / $10.40): use BLOCK A.
  • If you already applied the -$7 version ($3.40 / $6.52 / $3.40): use BLOCK B to add $1 back to each (net -$6 from original).
*/

-- Preview (expect three rows)
SELECT
  e.EnrollmentId,
  e.HouseholdId,
  e.EnrollmentType,
  e.PremiumAmount AS ProcessingFeeAmount,
  e.Status
FROM oe.Enrollments e
WHERE e.EnrollmentId IN (
  '740BAEE3-6A13-421E-ADF1-5F6B58DDF1F4',
  'F00E406A-196F-4AC6-A6B8-4890E64E678B',
  '3D683BA4-7FBC-4556-839D-299739215B1F'
)
  AND e.EnrollmentType = 'PaymentProcessingFee';

/*
-- ========== BLOCK A: from original premium (never ran a reduction, or reverted to original) ==========

BEGIN TRANSACTION;

-- Ricardo Gonzalez household: $10.40 -> $4.40
UPDATE oe.Enrollments
SET
  PremiumAmount = 4.40,
  ModifiedDate = GETUTCDATE()
WHERE EnrollmentId = '740BAEE3-6A13-421E-ADF1-5F6B58DDF1F4'
  AND HouseholdId = 'A085A5FD-BB07-4C00-A684-7809ABEC2A2A'
  AND EnrollmentType = 'PaymentProcessingFee'
  AND ProductId = '00000000-0000-0000-0000-000000000000'
  AND PremiumAmount = 10.40;

-- Joe Esparza household (2 members): $13.52 -> $7.52
UPDATE oe.Enrollments
SET
  PremiumAmount = 7.52,
  ModifiedDate = GETUTCDATE()
WHERE EnrollmentId = 'F00E406A-196F-4AC6-A6B8-4890E64E678B'
  AND HouseholdId = 'EEA1E518-F433-4EBF-937A-B1506C448FAE'
  AND EnrollmentType = 'PaymentProcessingFee'
  AND ProductId = '00000000-0000-0000-0000-000000000000'
  AND PremiumAmount = 13.52;

-- Joe Esparza Jr household: $10.40 -> $4.40
UPDATE oe.Enrollments
SET
  PremiumAmount = 4.40,
  ModifiedDate = GETUTCDATE()
WHERE EnrollmentId = '3D683BA4-7FBC-4556-839D-299739215B1F'
  AND HouseholdId = 'DFC7B2AC-BE7D-4C7F-B7F2-F058FD5FDCB6'
  AND EnrollmentType = 'PaymentProcessingFee'
  AND ProductId = '00000000-0000-0000-0000-000000000000'
  AND PremiumAmount = 10.40;

-- Expect three UPDATEs each with @@ROWCOUNT = 1.

COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;
*/

/*
-- ========== BLOCK B: correction after -$7 was applied ($3.40 / $6.52 / $3.40) -> net -$6 ($4.40 / $7.52 / $4.40) ==========

BEGIN TRANSACTION;

UPDATE oe.Enrollments
SET PremiumAmount = 4.40, ModifiedDate = GETUTCDATE()
WHERE EnrollmentId = '740BAEE3-6A13-421E-ADF1-5F6B58DDF1F4'
  AND HouseholdId = 'A085A5FD-BB07-4C00-A684-7809ABEC2A2A'
  AND EnrollmentType = 'PaymentProcessingFee'
  AND ProductId = '00000000-0000-0000-0000-000000000000'
  AND PremiumAmount = 3.40;

UPDATE oe.Enrollments
SET PremiumAmount = 7.52, ModifiedDate = GETUTCDATE()
WHERE EnrollmentId = 'F00E406A-196F-4AC6-A6B8-4890E64E678B'
  AND HouseholdId = 'EEA1E518-F433-4EBF-937A-B1506C448FAE'
  AND EnrollmentType = 'PaymentProcessingFee'
  AND ProductId = '00000000-0000-0000-0000-000000000000'
  AND PremiumAmount = 6.52;

UPDATE oe.Enrollments
SET PremiumAmount = 4.40, ModifiedDate = GETUTCDATE()
WHERE EnrollmentId = '3D683BA4-7FBC-4556-839D-299739215B1F'
  AND HouseholdId = 'DFC7B2AC-BE7D-4C7F-B7F2-F058FD5FDCB6'
  AND EnrollmentType = 'PaymentProcessingFee'
  AND ProductId = '00000000-0000-0000-0000-000000000000'
  AND PremiumAmount = 3.40;

COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;
*/
