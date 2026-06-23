/*
  After restoring pre-migration enrollments + running migration, you may have two active
  GetWell Dental rows per member.

  IMPORTANT — which row is which
  - Restored rows (from this batch, terminated 2026-04-30 then re-activated): OLD config —
    typically Apr 1 effective and PremiumAmount without “included round-up processing fee”.
  - Migration-created rows: NEW product config — different effective date and premium that
    includes round-up / tenant pricing rules.

  DEFAULT below: terminate the RESTORED pair; keep the migration-created active dental rows.

  If you already ran the older version of this script (kept 987… / 72ad… and killed the new rows),
  you must undo that first (reactivate migration enrollments from backup or prior export) —
  this file cannot invent lost EnrollmentIds.

  Run diagnostics first, then preview, then uncomment UPDATE.
*/

DECLARE @HouseholdId UNIQUEIDENTIFIER = (
  SELECT TOP 1 m.HouseholdId
  FROM oe.Members m
  WHERE m.MemberId IN (
    '9fc78b5f-4e46-4428-8b4a-c5e4633425b3',
    '02aad50d-1b48-4d15-8231-7eaf83055e90'
  )
);

DECLARE @DentalProductId UNIQUEIDENTIFIER = '1d5da922-31e6-401d-8346-d3340fdc4294';

-- Pre-migration dental rows that were in the restore list (terminate these to dedupe on NEW config)
DECLARE @RestoredPreMigrationDentalIds TABLE (EnrollmentId UNIQUEIDENTIFIER PRIMARY KEY);
INSERT INTO @RestoredPreMigrationDentalIds (EnrollmentId) VALUES
  ('987a3aa4-2914-437e-9e67-c02d59cea906'),
  ('72ad9d5e-64fc-4253-b17d-a8625677e695');

IF @HouseholdId IS NULL
BEGIN
  RAISERROR('Could not resolve HouseholdId.', 16, 1);
  RETURN;
END

-- Diagnostics: all current dental rows for this household (compare EffectiveDate, PremiumAmount, CreatedDate)
SELECT
  e.EnrollmentId,
  e.MemberId,
  e.Status,
  e.EffectiveDate,
  e.TerminationDate,
  e.PremiumAmount,
  e.CreatedDate,
  e.ModifiedDate,
  CASE WHEN EXISTS (SELECT 1 FROM @RestoredPreMigrationDentalIds r WHERE r.EnrollmentId = e.EnrollmentId)
    THEN N'RESTORED_PRE_MIGRATION (candidate to terminate)'
    ELSE N'OTHER (typically migration — keep if active)'
  END AS RowRole
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE m.HouseholdId = @HouseholdId
  AND e.ProductId = @DentalProductId
  AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
ORDER BY e.MemberId, e.CreatedDate;

-- Preview: active restored pre-migration dental only (these WILL be terminated)
SELECT
  e.EnrollmentId,
  e.MemberId,
  e.Status,
  e.EffectiveDate,
  e.TerminationDate,
  e.PremiumAmount,
  e.CreatedDate
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
INNER JOIN @RestoredPreMigrationDentalIds r ON r.EnrollmentId = e.EnrollmentId
WHERE m.HouseholdId = @HouseholdId
  AND e.ProductId = @DentalProductId
  AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
  AND e.Status = N'Active'
  AND (e.TerminationDate IS NULL OR e.TerminationDate > CONVERT(date, GETUTCDATE()));

/*
DECLARE @TermDate DATE = DATEADD(day, -1, CONVERT(date, GETUTCDATE()));

UPDATE e
SET
  e.Status = N'Inactive',
  e.TerminationDate = @TermDate,
  e.ModifiedDate = GETUTCDATE()
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
INNER JOIN @RestoredPreMigrationDentalIds r ON r.EnrollmentId = e.EnrollmentId
WHERE m.HouseholdId = @HouseholdId
  AND e.ProductId = @DentalProductId
  AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
  AND e.Status = N'Active'
  AND (e.TerminationDate IS NULL OR e.TerminationDate > CONVERT(date, GETUTCDATE()));
*/

/*
  --- Inverse (rare): keep restored pair, terminate migration duplicates — only if diagnostics show you need it.
  DECLARE @KeepIds TABLE (EnrollmentId UNIQUEIDENTIFIER PRIMARY KEY);
  INSERT INTO @KeepIds VALUES
    ('987a3aa4-2914-437e-9e67-c02d59cea906'),
    ('72ad9d5e-64fc-4253-b17d-a8625677e695');
  -- UPDATE ... active dental WHERE NOT IN @KeepIds (same household/product filters as above)
*/
