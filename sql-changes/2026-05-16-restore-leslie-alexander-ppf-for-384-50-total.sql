/*
  Leslie Alexander — household 3BE078C3-7232-483F-8DD4-110A273D9960.

  Target monthly total $384.50 (historical):
    Product premiums (active): 275.50 (Copay MEC primary) + 21.00 (Quest) + 76.16 (GetWell) + $0 spouse product rows = 372.66
    System fee: 3.50
    Payment processing fee: 8.34
    → 372.66 + 3.50 + 8.34 = 384.50

  If PPF was bumped to ~10.84, household total shows ~387.00. Set PPF back to 8.34.

  EnrollmentId from prod: 7D8FC154-0A00-4B46-AB06-9C45CC63AAD2
*/

DECLARE @H UNIQUEIDENTIFIER = '3BE078C3-7232-483F-8DD4-110A273D9960';
DECLARE @PpfEnrollmentId UNIQUEIDENTIFIER = '7D8FC154-0A00-4B46-AB06-9C45CC63AAD2';
DECLARE @TargetPpf DECIMAL(19, 4) = 8.34;

SELECT
  e.EnrollmentId,
  e.EnrollmentType,
  e.Status,
  e.PremiumAmount AS CurrentPpf,
  @TargetPpf AS TargetPpf
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE e.EnrollmentId = @PpfEnrollmentId
  AND m.HouseholdId = @H
  AND e.EnrollmentType = N'PaymentProcessingFee';

/*
UPDATE e
SET
  e.PremiumAmount = @TargetPpf,
  e.ModifiedDate = GETUTCDATE()
FROM oe.Enrollments e
INNER JOIN oe.Members m ON m.MemberId = e.MemberId
WHERE e.EnrollmentId = @PpfEnrollmentId
  AND m.HouseholdId = @H
  AND e.EnrollmentType = N'PaymentProcessingFee'
  AND e.Status = N'Active';
*/
