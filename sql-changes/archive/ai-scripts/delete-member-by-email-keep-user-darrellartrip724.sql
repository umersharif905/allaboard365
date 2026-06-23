-- READ snapshot (via ai_scripts/db-query.sh, allaboard-prod, 2026-03-24):
--   UserId 26AE42B4-3782-4EA0-A93D-BE8C0CF4888E, email darrellartrip724@gmail.com, TenantId 1CD92AF7-B6F2-4E48-A8F3-EC6316158826
--   Six member rows (same user): see INSERT list below.
--   At read time: Enrollments 0, Payments via EnrollmentId 0, PaymentAttempts 0
--
-- Explicit MemberId GUIDs only. Edit INSERT if you need a subset.
-- Keeps login user row; removes member rows and dependent FK data.
-- @DoDelete = 0 dry run (rollback); @DoDelete = 1 commit.
--
-- Do not run a partial selection starting mid-file; run from SET NOCOUNT below or whole file.

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DoDelete BIT = 0; -- 0 = preview only, 1 = execute

BEGIN TRY
  IF OBJECT_ID('tempdb..#TargetMembers') IS NOT NULL DROP TABLE #TargetMembers;

  CREATE TABLE #TargetMembers (
    MemberId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY
  );

  INSERT INTO #TargetMembers (MemberId) VALUES
    ('26F9EBD4-1161-437E-AF3D-168049122A06'),
    ('BFB43EA3-FF12-4142-B58D-3B676CE6F96C'),
    ('F9825F39-2B9A-4FA8-86B3-B44E4CCFE947'),
    ('089BAE26-70B1-48CC-8FB0-B5E34DD9475F'),
    ('EE0C41EA-EE44-450D-AA22-D75E2A522672'),
    ('C8400CD5-769B-4DCA-9F38-F441A20E18F4');

  -- Preview (before transaction)
  SELECT
    m.MemberId,
    m.UserId,
    m.HouseholdId,
    m.GroupId,
    m.RelationshipType,
    m.Status AS MemberStatus,
    u.Email,
    u.FirstName,
    u.LastName
  FROM oe.Members m
  INNER JOIN #TargetMembers t ON t.MemberId = m.MemberId
  INNER JOIN oe.Users u ON u.UserId = m.UserId;

  SELECT
    tm.MemberId,
    m.RelationshipType,
    m.HouseholdId,
    (SELECT COUNT(*) FROM oe.Members m2 WHERE m2.HouseholdId = m.HouseholdId) AS MembersInHousehold
  FROM #TargetMembers tm
  INNER JOIN oe.Members m ON m.MemberId = tm.MemberId;

  SELECT N'Rows in #TargetMembers' AS Section, COUNT(*) AS Cnt FROM #TargetMembers;

  BEGIN TRAN;

  IF OBJECT_ID('oe.PaymentAttempts', 'U') IS NOT NULL
    DELETE pa FROM oe.PaymentAttempts pa WHERE pa.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.CommissionLogs', 'U') IS NOT NULL
  BEGIN
    IF COL_LENGTH('oe.CommissionLogs', 'MemberId') IS NOT NULL
      DELETE cl FROM oe.CommissionLogs cl WHERE cl.MemberId IN (SELECT MemberId FROM #TargetMembers);
    IF COL_LENGTH('oe.CommissionLogs', 'PaymentId') IS NOT NULL
      DELETE cl
      FROM oe.CommissionLogs cl
      WHERE EXISTS (
        SELECT 1
        FROM oe.Payments p
        INNER JOIN oe.Enrollments e ON e.EnrollmentId = p.EnrollmentId
        WHERE e.MemberId IN (SELECT MemberId FROM #TargetMembers)
          AND cl.PaymentId = p.PaymentId
      );
    IF COL_LENGTH('oe.CommissionLogs', 'EnrollmentId') IS NOT NULL
      DELETE cl FROM oe.CommissionLogs cl
      WHERE cl.EnrollmentId IN (SELECT EnrollmentId FROM oe.Enrollments WHERE MemberId IN (SELECT MemberId FROM #TargetMembers));
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

  IF OBJECT_ID('oe.Payments', 'U') IS NOT NULL
    AND COL_LENGTH('oe.Payments', 'EnrollmentId') IS NOT NULL
  BEGIN
    DELETE p
    FROM oe.Payments p
    WHERE p.EnrollmentId IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM oe.Enrollments e
        WHERE e.EnrollmentId = p.EnrollmentId
          AND e.MemberId IN (SELECT MemberId FROM #TargetMembers)
      );
  END;

  DELETE e FROM oe.Enrollments e WHERE e.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.MemberPaymentMethods', 'U') IS NOT NULL
    DELETE mpm FROM oe.MemberPaymentMethods mpm WHERE mpm.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF OBJECT_ID('oe.MemberIDIncrement', 'U') IS NOT NULL
    DELETE mii FROM oe.MemberIDIncrement mii WHERE mii.MemberId IN (SELECT MemberId FROM #TargetMembers);

  /* FK_UserActivityLog_Members */
  IF OBJECT_ID('oe.UserActivityLog', 'U') IS NOT NULL
    AND COL_LENGTH('oe.UserActivityLog', 'MemberId') IS NOT NULL
    DELETE ual FROM oe.UserActivityLog ual WHERE ual.MemberId IN (SELECT MemberId FROM #TargetMembers);

  DELETE m FROM oe.Members m WHERE m.MemberId IN (SELECT MemberId FROM #TargetMembers);

  IF @DoDelete = 1
  BEGIN
    COMMIT TRAN;
    SELECT N'Done: listed MemberId rows removed; UserId 26AE42B4-3782-4EA0-A93D-BE8C0CF4888E (oe.Users) preserved.' AS ResultMessage;
  END
  ELSE
  BEGIN
    ROLLBACK TRAN;
    SELECT N'DRY RUN: no changes committed. Set @DoDelete = 1 to apply.' AS ResultMessage;
  END
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(N'Failed (likely FK from another table referencing oe.Members). Error: %s', 16, 1, @Err);
END CATCH;
