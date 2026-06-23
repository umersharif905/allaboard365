/*
  Manual cleanup: Christopher Teal (chris.teal@powerlinktech.com)
  Inactivates the duplicate plan-mod rollup contribution row:
  ProductId = 00000000-0000-0000-0000-000000000000, ContributionId NULL,
  same total as the per-product Contribution rows (Lyric / Copay MEC / Essential).

  MemberId: 201600A4-E4AC-40BA-83CF-488A2BD0A0F8
  EnrollmentId: 375247B8-8965-472E-BDBC-A0F70B8DBE30

  Run the SELECT first; then uncomment and run BEGIN/COMMIT with the UPDATE.
*/

-- Preview (expect one row, EmployerContributionAmount ~ 158.09)
SELECT
  e.EnrollmentId,
  e.MemberId,
  e.ProductId,
  e.ContributionId,
  e.EmployerContributionAmount,
  e.Status,
  e.EffectiveDate,
  e.EnrollmentType,
  u.Email
FROM oe.Enrollments e
JOIN oe.Members m ON m.MemberId = e.MemberId
JOIN oe.Users u ON u.UserId = m.UserId
WHERE u.Email = N'chris.teal@powerlinktech.com'
  AND e.EnrollmentId = '375247B8-8965-472E-BDBC-A0F70B8DBE30'
  AND e.EnrollmentType = 'Contribution'
  AND e.ProductId = '00000000-0000-0000-0000-000000000000';

/*
BEGIN TRANSACTION;

UPDATE oe.Enrollments
SET
  Status = 'Inactive',
  TerminationDate = GETUTCDATE(),
  ModifiedDate = GETUTCDATE()
WHERE EnrollmentId = '375247B8-8965-472E-BDBC-A0F70B8DBE30'
  AND MemberId = '201600A4-E4AC-40BA-83CF-488A2BD0A0F8'
  AND EnrollmentType = 'Contribution'
  AND ProductId = '00000000-0000-0000-0000-000000000000'
  AND ContributionId IS NULL
  AND Status = 'Active';

-- Expect @@ROWCOUNT = 1. If 0, stop and re-verify IDs in your environment.

COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;
*/
