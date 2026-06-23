/*
  Leslie Alexander household — spouse has two ACTIVE GetWell Dental rows after tier migration:
  - 5C1BD501... eff 2026-04-01 (original)
  - 680DACC9... eff 2026-05-01 (migration)

  Primary already has a single 5/1 dental row. Preview, then terminate the older spouse row only.

  Household total ~$384.50 vs ~$387: see 2026-05-16-restore-leslie-alexander-ppf-for-384-50-total.sql (PPF 8.34).

  HouseholdId = 3BE078C3-7232-483F-8DD4-110A273D9960
  Dependent MemberId = 184588EE-FA5D-4C07-9121-4C2BB5D85191
*/

DECLARE @H UNIQUEIDENTIFIER = '3BE078C3-7232-483F-8DD4-110A273D9960';
DECLARE @DentalProductId UNIQUEIDENTIFIER = '1D5DA922-31E6-401D-8346-D3340FDC4294';
DECLARE @TerminateEnrollmentId UNIQUEIDENTIFIER = '5C1BD501-4353-4375-8F8D-76BBC31906AD';

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
WHERE m.HouseholdId = @H
  AND e.ProductId = @DentalProductId
  AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
ORDER BY e.MemberId, e.EffectiveDate;

/*
DECLARE @TermDate DATE = DATEADD(day, -1, CONVERT(date, GETUTCDATE()));

UPDATE e
SET
  e.Status = N'Inactive',
  e.TerminationDate = @TermDate,
  e.ModifiedDate = GETUTCDATE()
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE e.EnrollmentId = @TerminateEnrollmentId
  AND m.HouseholdId = @H
  AND e.Status = N'Active';
*/
