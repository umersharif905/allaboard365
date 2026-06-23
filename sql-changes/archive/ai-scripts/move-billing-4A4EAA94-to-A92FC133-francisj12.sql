/*
  Move billing artifacts from test household (jeremy@mightywell.us primary) to real household (francisj12@icloud.com).

  Current prod snapshot (verify before run):
    Old HH: 4A4EAA94-5CC8-4271-A3CD-179DA29658F7  | primary MemberId = same | email jeremy@mightywell.us
    New HH: A92FC133-CE42-4958-A70F-B4409C397AC9  | primary MemberId = same | email francisj12@icloud.com

  Moves:
    - oe.Payments: 1 row (388E19BD-...) — EnrollmentId 29EF04DF -> 1B6D8D68 (same ProductId on new primary), HouseholdId -> new
    - oe.PaymentAttempts: MemberId + HouseholdId -> Jeremy primary / household
    - oe.MemberPaymentMethods: ACH row from old primary -> new primary (Jeremy had none at last check)

  Run order:
    1) Set @Apply = 0, execute — review PRINT output (no commit).
    2) Set @Apply = 1, execute — COMMIT.

  Then run delete-household-4A4EAA94-jeremy-mightywell-test.sql (with @DoDelete = 1) to remove the test member + Gloria dependent only.
  Do NOT delete oe.Users for jeremy@mightywell.us if other member rows still reference that user.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Apply BIT = 0; /* 0 = rollback after preview; 1 = commit */

DECLARE @OldHouseholdId UNIQUEIDENTIFIER = '4A4EAA94-5CC8-4271-A3CD-179DA29658F7';
DECLARE @NewHouseholdId UNIQUEIDENTIFIER = 'A92FC133-CE42-4958-A70F-B4409C397AC9';
DECLARE @OldPrimaryMemberId UNIQUEIDENTIFIER = '4A4EAA94-5CC8-4271-A3CD-179DA29658F7';
DECLARE @NewPrimaryMemberId UNIQUEIDENTIFIER = 'A92FC133-CE42-4958-A70F-B4409C397AC9';

/* Payment row observed on old household */
DECLARE @PaymentId UNIQUEIDENTIFIER = '388E19BD-3EA4-4852-A6C5-8A3DEFA57D99';
DECLARE @OldEnrollmentIdForPayment UNIQUEIDENTIFIER = '29EF04DF-A228-4787-9647-2A1EC39B921A'; /* Product 13130A78 on old primary */
DECLARE @NewEnrollmentIdForPayment UNIQUEIDENTIFIER = '1B6D8D68-10C7-4C11-B606-4D904EA83C59'; /* same ProductId on Jeremy primary */

DECLARE @PaymentMethodId UNIQUEIDENTIFIER = '674D844F-8DF3-452D-AC69-2AFED65DC501';

BEGIN TRY
  /* --- Pre-checks (always visible) --- */
  IF NOT EXISTS (SELECT 1 FROM oe.Payments p WHERE p.PaymentId = @PaymentId AND p.HouseholdId = @OldHouseholdId)
    RAISERROR(N'Pre-check failed: Payment not found on old household (ids may already be moved).', 16, 1);

  IF NOT EXISTS (
    SELECT 1 FROM oe.Enrollments e
    WHERE e.EnrollmentId = @NewEnrollmentIdForPayment AND e.MemberId = @NewPrimaryMemberId
  )
    RAISERROR(N'Pre-check failed: New enrollment id does not belong to Jeremy primary member.', 16, 1);

  IF EXISTS (
    SELECT 1 FROM oe.MemberPaymentMethods m
    WHERE m.MemberId = @NewPrimaryMemberId AND m.PaymentMethodId <> @PaymentMethodId
  )
    PRINT N'WARNING: Jeremy already has other payment methods; you may hit a unique constraint or want to merge manually.';

  PRINT N'--- BEFORE (Payments) ---';
  SELECT PaymentId, HouseholdId, EnrollmentId, Amount, Status, TransactionType
  FROM oe.Payments WHERE PaymentId = @PaymentId;

  PRINT N'--- BEFORE (PaymentAttempts) ---';
  SELECT PaymentAttemptId, MemberId, HouseholdId, Status, Amount
  FROM oe.PaymentAttempts
  WHERE HouseholdId = @OldHouseholdId OR MemberId = @OldPrimaryMemberId;

  PRINT N'--- BEFORE (MemberPaymentMethods) ---';
  SELECT PaymentMethodId, MemberId, PaymentMethodType, IsDefault, Status
  FROM oe.MemberPaymentMethods WHERE PaymentMethodId = @PaymentMethodId;

  BEGIN TRAN;

  UPDATE oe.Payments
  SET HouseholdId = @NewHouseholdId,
      EnrollmentId = @NewEnrollmentIdForPayment,
      ModifiedDate = SYSUTCDATETIME()
  WHERE PaymentId = @PaymentId;

  UPDATE oe.PaymentAttempts
  SET MemberId = @NewPrimaryMemberId,
      HouseholdId = @NewHouseholdId,
      ModifiedDate = SYSUTCDATETIME()
  WHERE HouseholdId = @OldHouseholdId OR MemberId = @OldPrimaryMemberId;

  UPDATE oe.MemberPaymentMethods
  SET MemberId = @NewPrimaryMemberId,
      ModifiedDate = SYSUTCDATETIME()
  WHERE PaymentMethodId = @PaymentMethodId AND MemberId = @OldPrimaryMemberId;

  PRINT N'--- AFTER (Payments) ---';
  SELECT PaymentId, HouseholdId, EnrollmentId, Amount, Status, TransactionType
  FROM oe.Payments WHERE PaymentId = @PaymentId;

  PRINT N'--- AFTER (PaymentAttempts on new HH) ---';
  SELECT PaymentAttemptId, MemberId, HouseholdId, Status, Amount
  FROM oe.PaymentAttempts WHERE HouseholdId = @NewHouseholdId AND MemberId = @NewPrimaryMemberId;

  PRINT N'--- AFTER (MemberPaymentMethods) ---';
  SELECT PaymentMethodId, MemberId, PaymentMethodType, IsDefault, Status
  FROM oe.MemberPaymentMethods WHERE PaymentMethodId = @PaymentMethodId;

  IF @Apply = 1
  BEGIN
    COMMIT TRAN;
    PRINT N'Done: billing moved to francisj12 household; committed.';
  END
  ELSE
  BEGIN
    ROLLBACK TRAN;
    PRINT N'DRY RUN: rolled back. Set @Apply = 1 to commit.';
  END
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(N'Failed: %s', 16, 1, @Err);
END CATCH;
