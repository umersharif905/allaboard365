-- Remove duplicate test household 4A4EAA94-5CC8-4271-A3CD-179DA29658F7 (MightyWELL).
-- Primary: MemberId = HouseholdId, test test, jeremy@mightywell.us (UserId 6926798D...) — user row KEPT (still linked to member 07881565).
-- Dependent: Gloria Francis (6CA7AD59...) — UserId EBE98D39... removed with member.
--
-- @DoDelete = 0: preview + ROLLBACK; @DoDelete = 1: COMMIT.

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DoDelete BIT = 0; -- set 1 only AFTER move-billing-4A4EAA94-to-A92FC133-francisj12.sql committed

DECLARE @HouseholdId UNIQUEIDENTIFIER = '4A4EAA94-5CC8-4271-A3CD-179DA29658F7';
DECLARE @PrimaryMemberId UNIQUEIDENTIFIER = '4A4EAA94-5CC8-4271-A3CD-179DA29658F7';
DECLARE @DependentMemberId UNIQUEIDENTIFIER = '6CA7AD59-1451-4E18-B797-D175E4E12E89';
DECLARE @DependentUserId UNIQUEIDENTIFIER = 'EBE98D39-8DD5-4AA7-B398-D20058288F74';

BEGIN TRY
  IF OBJECT_ID('tempdb..#TargetMembers') IS NOT NULL DROP TABLE #TargetMembers;
  CREATE TABLE #TargetMembers (MemberId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY);
  INSERT INTO #TargetMembers (MemberId) VALUES (@PrimaryMemberId), (@DependentMemberId);

  SELECT N'Preview: members to remove' AS Section;
  SELECT m.MemberId, m.HouseholdId, m.RelationshipType, m.Status, u.Email, u.FirstName, u.LastName, m.UserId
  FROM oe.Members m
  INNER JOIN oe.Users u ON u.UserId = m.UserId
  INNER JOIN #TargetMembers t ON t.MemberId = m.MemberId;

  SELECT N'Preview: enrollments' AS Section;
  SELECT e.EnrollmentId, e.MemberId, e.Status, e.ProductId
  FROM oe.Enrollments e
  WHERE e.MemberId IN (SELECT MemberId FROM #TargetMembers);

  SELECT N'Preview: payments (household or by enrollment)' AS Section;
  SELECT p.PaymentId, p.HouseholdId, p.EnrollmentId, p.Amount, p.Status
  FROM oe.Payments p
  WHERE p.HouseholdId = @HouseholdId
     OR (p.EnrollmentId IS NOT NULL AND EXISTS (
       SELECT 1 FROM oe.Enrollments e
       WHERE e.EnrollmentId = p.EnrollmentId AND e.MemberId IN (SELECT MemberId FROM #TargetMembers)
     ));

  BEGIN TRAN;

  IF OBJECT_ID('oe.PaymentAttempts', 'U') IS NOT NULL
    DELETE pa FROM oe.PaymentAttempts pa
    WHERE pa.HouseholdId = @HouseholdId
       OR pa.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.Payments', 'U') IS NOT NULL
  BEGIN
    DELETE p FROM oe.Payments p
    WHERE p.HouseholdId = @HouseholdId
       OR (p.EnrollmentId IS NOT NULL AND EXISTS (
         SELECT 1 FROM oe.Enrollments e
         WHERE e.EnrollmentId = p.EnrollmentId AND e.MemberId IN (SELECT MemberId FROM #TargetMembers)
       ));
  END;

  IF OBJECT_ID('oe.EnrollmentAcknowledgements', 'U') IS NOT NULL
    DELETE ea FROM oe.EnrollmentAcknowledgements ea
    WHERE ea.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.CommissionLogs', 'U') IS NOT NULL
  BEGIN
    IF COL_LENGTH('oe.CommissionLogs', 'MemberId') IS NOT NULL
      DELETE cl FROM oe.CommissionLogs cl WHERE cl.MemberId IN (SELECT MemberId FROM #TargetMembers);
    IF COL_LENGTH('oe.CommissionLogs', 'EnrollmentId') IS NOT NULL
      DELETE cl FROM oe.CommissionLogs cl
      WHERE cl.EnrollmentId IN (SELECT EnrollmentId FROM oe.Enrollments WHERE MemberId IN (SELECT MemberId FROM #TargetMembers));
    IF COL_LENGTH('oe.CommissionLogs', 'PaymentId') IS NOT NULL
      DELETE cl FROM oe.CommissionLogs cl
      WHERE EXISTS (
        SELECT 1 FROM oe.Payments p
        INNER JOIN oe.Enrollments e ON e.EnrollmentId = p.EnrollmentId
        WHERE e.MemberId IN (SELECT MemberId FROM #TargetMembers) AND cl.PaymentId = p.PaymentId
      );
  END;

  IF OBJECT_ID('oe.GroupActivityLogs', 'U') IS NOT NULL
    AND COL_LENGTH('oe.GroupActivityLogs', 'MemberId') IS NOT NULL
    DELETE gal FROM oe.GroupActivityLogs gal WHERE gal.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.DeclineAcknowledgements', 'U') IS NOT NULL
    DELETE da FROM oe.DeclineAcknowledgements da WHERE da.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.EnrollmentLinks', 'U') IS NOT NULL
    DELETE el FROM oe.EnrollmentLinks el WHERE el.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.TrainingCompletions', 'U') IS NOT NULL
    AND COL_LENGTH('oe.TrainingCompletions', 'MemberId') IS NOT NULL
    DELETE tc FROM oe.TrainingCompletions tc WHERE tc.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.ShareRequestMembers', 'U') IS NOT NULL
    DELETE srm FROM oe.ShareRequestMembers srm WHERE srm.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.VendorCallLogs', 'U') IS NOT NULL
    DELETE vcl FROM oe.VendorCallLogs vcl WHERE vcl.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.VendorSmsMessages', 'U') IS NOT NULL
    DELETE vsm FROM oe.VendorSmsMessages vsm WHERE vsm.MemberId IN (SELECT MemberId FROM #TargetMembers);

  DELETE e FROM oe.Enrollments e WHERE e.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.MemberPaymentMethods', 'U') IS NOT NULL
    DELETE mpm FROM oe.MemberPaymentMethods mpm WHERE mpm.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.MemberIDIncrement', 'U') IS NOT NULL
    DELETE mii FROM oe.MemberIDIncrement mii WHERE mii.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.UserActivityLog', 'U') IS NOT NULL
    AND COL_LENGTH('oe.UserActivityLog', 'MemberId') IS NOT NULL
    DELETE ual FROM oe.UserActivityLog ual WHERE ual.MemberId IN (SELECT MemberId FROM #TargetMembers);

  DELETE m FROM oe.Members m WHERE m.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.UserRoles', 'U') IS NOT NULL
    DELETE ur FROM oe.UserRoles ur WHERE ur.UserId = @DependentUserId;

  DELETE u FROM oe.Users u WHERE u.UserId = @DependentUserId
    AND NOT EXISTS (SELECT 1 FROM oe.Members m WHERE m.UserId = u.UserId);

  IF @DoDelete = 1
  BEGIN
    COMMIT TRAN;
    SELECT N'Done: household 4A4EAA94 removed; oe.Users for jeremy@mightywell.us preserved; dependent user EBE98D39 removed.' AS ResultMessage;
  END
  ELSE
  BEGIN
    ROLLBACK TRAN;
    SELECT N'DRY RUN: no changes. Set @DoDelete = 1 and re-run to apply.' AS ResultMessage;
  END
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(N'Failed: %s', 16, 1, @Err);
END CATCH;
