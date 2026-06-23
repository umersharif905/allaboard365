-- Fee enrollments (SystemFee / PaymentProcessingFee) created during E123 migration import
-- were missing IsPendingMigration=1, which caused imported households to be misclassified as "locked".
-- Run for a specific household or all pending-migration members.

-- McGuinness (SW0530092)
UPDATE e
SET e.IsPendingMigration = 1
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE m.HouseholdMemberID = 'SW0530092'
  AND m.RelationshipType = 'P'
  AND m.IsPendingMigration = 1
  AND ISNULL(e.IsPendingMigration, 0) = 0
  AND e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee');

-- Optional: all pending-migration households with stray fee rows
-- UPDATE e
-- SET e.IsPendingMigration = 1
-- FROM oe.Enrollments e
-- INNER JOIN oe.Members m ON m.MemberId = e.MemberId
-- WHERE m.IsPendingMigration = 1
--   AND m.RelationshipType = 'P'
--   AND ISNULL(e.IsPendingMigration, 0) = 0
--   AND e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee');

-- Unstick batch row if still applying after successful import
UPDATE oe.MigrationImportBatch
SET Status = N'applied',
    ApplyProcessed = 1,
    ApplyCreateCount = 1,
    ModifiedUtc = SYSUTCDATETIME()
WHERE BatchId = '7BE7B521-CC9B-49B7-BB20-2915E3827BD8'
  AND Status = N'applying';

UPDATE oe.MigrationImportBatchHousehold
SET PreviewAction = N'create',
    PreviewMessage = N'Imported successfully (1 unmapped product(s) skipped)',
    Applied = 1,
    AppliedUtc = SYSUTCDATETIME()
WHERE BatchId = '7BE7B521-CC9B-49B7-BB20-2915E3827BD8'
  AND HouseholdMemberID = 'SW0530092';
