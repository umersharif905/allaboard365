/*
  Backfill DIME recurring schedule for Jeremy (production) — francisj12@icloud.com household.
  Enrollment used test household 4A4EAA94-...; DIME schedule was created successfully but oe.Payments was not updated (Pending ACH).

  Source: Azure App Service logs (AllAboard365-Backend), 2026-03-27 ~18:01 UTC
    DIME scheduleId: 606
    Log householdId (at create time): 4A4EAA94-5CC8-4271-A3CD-179DA29658F7
    Monthly amount: 930.61
    Next billing (DIME next_run_date): 2026-05-01

  Resolve household by primary email (current prod household after move-billing script: A92FC133-...).
  If you have NOT run move-billing yet, either run that first or temporarily point @HouseholdId at the old test household.

  Run order:
    1) Set @Apply = 0 — review PRINT output (rolls back).
    2) Set @Apply = 1 — COMMIT.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Apply BIT = 0; /* 0 = rollback after preview; 1 = commit */

DECLARE @PrimaryEmail NVARCHAR(320) = N'francisj12@icloud.com';

DECLARE @DimeScheduleId NVARCHAR(255) = N'606';
DECLARE @MonthlyAmount DECIMAL(10, 2) = 930.61;
/* DIME next_run_date was 2026-05-01T04:00:00.000000Z (UTC) */
DECLARE @NextBillingDate DATETIME2 = '2026-05-01T04:00:00';

DECLARE @HouseholdId UNIQUEIDENTIFIER;
DECLARE @TenantId UNIQUEIDENTIFIER;

SELECT TOP 1
  @HouseholdId = m.HouseholdId,
  @TenantId = u.TenantId
FROM oe.Members m
INNER JOIN oe.Users u ON u.UserId = m.UserId
WHERE m.RelationshipType = 'P'
  AND LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(RTRIM(@PrimaryEmail)));

IF @HouseholdId IS NULL
BEGIN
  RAISERROR(N'Primary member not found for francisj12@icloud.com (check oe.Users).', 16, 1);
  RETURN;
END;

PRINT N'--- Resolved ---';
SELECT @HouseholdId AS HouseholdId, @TenantId AS TenantId;

PRINT N'--- Current payment row(s) for household (top 5 by PaymentDate) ---';
SELECT TOP 5
  PaymentId, Amount, Status, RecurringScheduleId, NextBillingDate, PaymentDate
FROM oe.Payments
WHERE HouseholdId = @HouseholdId
ORDER BY PaymentDate DESC;

BEGIN TRY
  BEGIN TRAN;

  IF EXISTS (
    SELECT 1 FROM oe.Payments
    WHERE HouseholdId = @HouseholdId AND RecurringScheduleId = @DimeScheduleId
  )
    PRINT N'INFO: oe.Payments already has RecurringScheduleId = 606 for this household — UPDATE may affect 0 rows.';

  UPDATE p
  SET
    RecurringScheduleId = @DimeScheduleId,
    NextBillingDate = @NextBillingDate,
    ModifiedDate = SYSUTCDATETIME()
  FROM oe.Payments p
  WHERE p.PaymentId = (
    SELECT TOP 1 p2.PaymentId
    FROM oe.Payments p2
    WHERE p2.HouseholdId = @HouseholdId
      AND p2.Status IN (N'succeeded', N'APPROVAL', N'Completed', N'Pending')
      AND p2.RecurringScheduleId IS NULL
    ORDER BY p2.PaymentDate DESC
  );

  IF @@ROWCOUNT = 0
  BEGIN
    UPDATE p
    SET
      RecurringScheduleId = @DimeScheduleId,
      NextBillingDate = @NextBillingDate,
      ModifiedDate = SYSUTCDATETIME()
    FROM oe.Payments p
    WHERE p.PaymentId = (
      SELECT TOP 1 p2.PaymentId
      FROM oe.Payments p2
      WHERE p2.HouseholdId = @HouseholdId
        AND p2.Status IN (N'succeeded', N'APPROVAL', N'Completed', N'Pending')
      ORDER BY p2.PaymentDate DESC
    );
    PRINT N'INFO: Fell back to latest successful/pending payment row.';
  END;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = N'oe' AND TABLE_NAME = N'IndividualRecurringSchedules'
  )
    PRINT N'WARNING: oe.IndividualRecurringSchedules missing — skipping insert.';
  ELSE IF NOT EXISTS (
    SELECT 1 FROM oe.IndividualRecurringSchedules
    WHERE HouseholdId = @HouseholdId AND DimeScheduleId = @DimeScheduleId
  )
  BEGIN
    INSERT INTO oe.IndividualRecurringSchedules (
      HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate
    )
    VALUES (
      @HouseholdId, @TenantId, @DimeScheduleId, @MonthlyAmount, @NextBillingDate, 1, SYSUTCDATETIME(), SYSUTCDATETIME()
    );
  END
  ELSE
    PRINT N'INFO: oe.IndividualRecurringSchedules row already exists for this DimeScheduleId.';

  PRINT N'--- After update ---';
  SELECT TOP 5
    PaymentId, Amount, Status, RecurringScheduleId, NextBillingDate, PaymentDate
  FROM oe.Payments
  WHERE HouseholdId = @HouseholdId
  ORDER BY PaymentDate DESC;

  IF @Apply = 1
    COMMIT TRAN;
  ELSE
  BEGIN
    ROLLBACK TRAN;
    PRINT N' Rolled back (@Apply = 0). Set @Apply = 1 to commit.';
  END
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;
