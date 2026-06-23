/*
  Targeted restore: ONLY the enrollments your bad product-migration run ended on 2026-04-30
  (ModifiedDate ~ 2026-05-16). Does NOT touch unknown households or older superseded rows
  (e.g. TerminationDate 2026-03-31 / ModifiedDate 2026-03-27).

  Your paste: primary member = 9FC78B5F-4E46-4428-8B4A-C5E4633425B3, dependent = 02AAD50D-1B48-4D15-8231-7EAF83055E90.

  GetWell Dental: if an ACTIVE dental enrollment already exists from the migration, REMOVE the
  two dental EnrollmentIds from the IN list below before running UPDATE (avoid duplicate dental).
*/

DECLARE @HouseholdId UNIQUEIDENTIFIER = (
  SELECT TOP 1 m.HouseholdId
  FROM oe.Members m
  WHERE m.MemberId IN (
    '9fc78b5f-4e46-4428-8b4a-c5e4633425b3',
    '02aad50d-1b48-4d15-8231-7eaf83055e90'
  )
);

IF @HouseholdId IS NULL
BEGIN
  RAISERROR('Could not resolve HouseholdId from known MemberIds.', 16, 1);
  RETURN;
END

-- Sanity: these are exactly the rows from your export (migration batch only).
DECLARE @Ids TABLE (EnrollmentId UNIQUEIDENTIFIER PRIMARY KEY);
INSERT INTO @Ids (EnrollmentId) VALUES
  ('3c24ee56-5f3a-4ba9-b0e7-2c8239c5cfb1'),
  ('3bfcc472-55a2-41b3-b7d9-54ef4cf5b4c5'),
  ('93c033c8-decb-4cd2-beaa-4db6d203bbdc'),
  ('9d4bd349-ee61-4167-8de5-8858d2badd13'),
  ('987a3aa4-2914-437e-9e67-c02d59cea906'),
  ('72ad9d5e-64fc-4253-b17d-a8625677e695'),
  ('7312e681-bc37-4ad7-88e3-61e58f896d5d'),
  ('c272a053-92b6-44ef-9292-060013f5ca7f'),
  ('23111ffc-6c6f-4ce5-8dc1-eda45b417bcf'),
  ('4a81b66d-8bb7-497f-940e-23fd2fc9f596');

-- Preview: must be 10 rows, same household only, inactive, term 2026-04-30
SELECT
  e.EnrollmentId,
  e.MemberId,
  e.ProductId,
  p.Name AS ProductName,
  e.Status,
  e.EffectiveDate,
  e.TerminationDate,
  e.PremiumAmount,
  e.ModifiedDate
FROM oe.Enrollments e
INNER JOIN @Ids i ON i.EnrollmentId = e.EnrollmentId
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
LEFT JOIN oe.Products p ON p.ProductId = e.ProductId
WHERE m.HouseholdId = @HouseholdId
  AND e.Status = N'Inactive'
  AND CAST(e.TerminationDate AS DATE) = '2026-04-30';

-- Optional: show active dental for this household (if any) — if present, exclude dental IDs from UPDATE
SELECT e.EnrollmentId, e.MemberId, e.ProductId, p.Name, e.Status, e.EffectiveDate, e.TerminationDate, e.PremiumAmount
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
LEFT JOIN oe.Products p ON p.ProductId = e.ProductId
WHERE m.HouseholdId = @HouseholdId
  AND e.ProductId = '1d5da922-31e6-401d-8346-d3340fdc4294'
  AND e.Status = N'Active'
  AND (e.TerminationDate IS NULL OR e.TerminationDate > CAST(GETUTCDATE() AS DATE));

/*
-- Uncomment ONLY after preview looks correct (and remove dental IDs from @Ids if duplicate active dental).

UPDATE e
SET
  e.TerminationDate = NULL,
  e.Status = N'Active',
  e.ModifiedDate = GETUTCDATE()
FROM oe.Enrollments e
INNER JOIN @Ids i ON i.EnrollmentId = e.EnrollmentId
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE m.HouseholdId = @HouseholdId
  AND e.Status = N'Inactive'
  AND CAST(e.TerminationDate AS DATE) = '2026-04-30';
*/

/*
  If both restored + migration dental are now active: run
  sql-changes/2026-05-16-dedupe-getwell-dental-after-restore.sql — it terminates the two
  RESTORED dental IDs (old effective/premium) and leaves the migration-created rows (new config).
*/
