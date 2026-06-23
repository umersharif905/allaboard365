-- Remove duplicate individual primary member for jgilly96@yahoo.com (Justin Gilbert)
-- while keeping oe.Users and the correct group member row.
--
-- Prod snapshot (2026-05-22):
--   UserId  8E37D72A-979A-4BA0-81A3-5B8493C65D5B  jgilly96@yahoo.com
--   KEEP    9561A75B-072C-4954-BFD4-62F422334AA5  group: Direct Heating and Air LLC (Apr 23)
--   REMOVE  3A293C44-A4AF-4047-B358-D891535CB31F  individual duplicate (Apr 30), 2 enrollment links, 0 enrollments
--
-- @DoDelete = 0 preview only; @DoDelete = 1 apply (commits each step separately to avoid lock timeouts).
-- If you still hit lock timeout, run during a quiet window or use the minimal 2-statement batch at the bottom.

SET NOCOUNT ON;
SET XACT_ABORT ON;
SET LOCK_TIMEOUT 120000; -- 2 minutes per statement (default is often 5s in SSMS)

DECLARE @DoDelete BIT = 0; -- 0 = preview only, 1 = execute
DECLARE @TargetMemberId UNIQUEIDENTIFIER = '3A293C44-A4AF-4047-B358-D891535CB31F';

BEGIN TRY
  -- Preview (always runs, no locks held)
  SELECT
    m.MemberId,
    m.UserId,
    m.HouseholdId,
    m.GroupId,
    g.Name AS GroupName,
    m.RelationshipType,
    m.Status AS MemberStatus,
    u.Email,
    u.FirstName,
    u.LastName
  FROM oe.Members m
  INNER JOIN oe.Users u ON u.UserId = m.UserId
  LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
  WHERE m.MemberId = @TargetMemberId;

  SELECT N'Sibling rows (group row should remain after delete)' AS Section;
  SELECT m.MemberId, m.GroupId, g.Name AS GroupName, m.Status, m.CreatedDate
  FROM oe.Members m
  LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
  WHERE m.UserId = (SELECT UserId FROM oe.Members WHERE MemberId = @TargetMemberId)
  ORDER BY m.CreatedDate;

  SELECT N'Child row counts' AS Section, t.TableName, t.Cnt
  FROM (
    SELECT N'EnrollmentLinks' AS TableName, COUNT(*) AS Cnt FROM oe.EnrollmentLinks WHERE MemberId = @TargetMemberId
    UNION ALL SELECT N'Enrollments', COUNT(*) FROM oe.Enrollments WHERE MemberId = @TargetMemberId
    UNION ALL SELECT N'MemberPaymentMethods', COUNT(*) FROM oe.MemberPaymentMethods WHERE MemberId = @TargetMemberId
  ) t;

  IF @DoDelete = 0
  BEGIN
    SELECT N'Preview only — set @DoDelete = 1 to apply (each step commits separately).' AS ResultMessage;
    RETURN;
  END;

  -- Step 1: enrollment links only (only child rows that exist for this member on prod)
  IF EXISTS (SELECT 1 FROM oe.EnrollmentLinks WHERE MemberId = @TargetMemberId)
  BEGIN
    BEGIN TRAN;
    DELETE FROM oe.EnrollmentLinks WHERE MemberId = @TargetMemberId;
    COMMIT TRAN;
    SELECT N'Step 1: EnrollmentLinks deleted' AS StepResult, @@ROWCOUNT AS RowsAffected;
  END;

  -- Step 2: other FK children — only when rows exist (avoids scanning hot tables under lock)
  IF EXISTS (SELECT 1 FROM oe.Enrollments WHERE MemberId = @TargetMemberId)
  BEGIN
    BEGIN TRAN;
    IF OBJECT_ID('oe.PaymentAttempts', 'U') IS NOT NULL
      DELETE FROM oe.PaymentAttempts WHERE MemberId = @TargetMemberId;
    IF OBJECT_ID('oe.Payments', 'U') IS NOT NULL AND COL_LENGTH('oe.Payments', 'EnrollmentId') IS NOT NULL
      DELETE p FROM oe.Payments p
      INNER JOIN oe.Enrollments e ON e.EnrollmentId = p.EnrollmentId
      WHERE e.MemberId = @TargetMemberId;
    DELETE FROM oe.Enrollments WHERE MemberId = @TargetMemberId;
    COMMIT TRAN;
    SELECT N'Step 2: Enrollments (+ related payments) deleted' AS StepResult;
  END;

  IF EXISTS (SELECT 1 FROM oe.MemberPaymentMethods WHERE MemberId = @TargetMemberId)
  BEGIN
    BEGIN TRAN;
    DELETE FROM oe.MemberPaymentMethods WHERE MemberId = @TargetMemberId;
    COMMIT TRAN;
    SELECT N'Step 3: MemberPaymentMethods deleted' AS StepResult, @@ROWCOUNT AS RowsAffected;
  END;

  IF OBJECT_ID('oe.MemberIDIncrement', 'U') IS NOT NULL
     AND EXISTS (SELECT 1 FROM oe.MemberIDIncrement WHERE MemberId = @TargetMemberId)
  BEGIN
    BEGIN TRAN;
    DELETE FROM oe.MemberIDIncrement WHERE MemberId = @TargetMemberId;
    COMMIT TRAN;
    SELECT N'Step 4: MemberIDIncrement deleted' AS StepResult, @@ROWCOUNT AS RowsAffected;
  END;

  IF OBJECT_ID('oe.UserActivityLog', 'U') IS NOT NULL
     AND COL_LENGTH('oe.UserActivityLog', 'MemberId') IS NOT NULL
     AND EXISTS (SELECT 1 FROM oe.UserActivityLog WHERE MemberId = @TargetMemberId)
  BEGIN
    BEGIN TRAN;
    DELETE FROM oe.UserActivityLog WHERE MemberId = @TargetMemberId;
    COMMIT TRAN;
    SELECT N'Step 5: UserActivityLog deleted' AS StepResult, @@ROWCOUNT AS RowsAffected;
  END;

  -- Step 6: member row (short lock window)
  BEGIN TRAN;
  DELETE FROM oe.Members WHERE MemberId = @TargetMemberId;
  IF @@ROWCOUNT <> 1
  BEGIN
    ROLLBACK TRAN;
    RAISERROR(N'Expected to delete exactly 1 member row; got %d. Rolled back.', 16, 1, @@ROWCOUNT);
  END;
  COMMIT TRAN;

  SELECT N'Done: duplicate removed; UserId 8E37D72A-979A-4BA0-81A3-5B8493C65D5B (oe.Users) preserved.' AS ResultMessage;

END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
  DECLARE @Num INT = ERROR_NUMBER();
  IF @Num = 1222
    RAISERROR(N'Lock timeout — another session is using these rows. Retry in a quiet window, or run the minimal batch below one statement at a time. Error: %s', 16, 1, @Err);
  ELSE IF @Num IN (547, 2627, 2601)
    RAISERROR(N'FK/constraint blocked delete — child row still references this MemberId. Error: %s', 16, 1, @Err);
  ELSE
    RAISERROR(N'Delete failed. Error %d: %s', 16, 1, @Num, @Err);
END CATCH;

/*
-- MINIMAL FALLBACK (prod had only 2 EnrollmentLinks, 0 enrollments — run each line separately if script above still times out):

SET LOCK_TIMEOUT 120000;
DELETE FROM oe.EnrollmentLinks WHERE MemberId = '3A293C44-A4AF-4047-B358-D891535CB31F';
-- wait for success, then:
DELETE FROM oe.Members WHERE MemberId = '3A293C44-A4AF-4047-B358-D891535CB31F';
*/
