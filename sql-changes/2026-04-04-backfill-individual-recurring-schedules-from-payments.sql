-- Idempotent backfill: oe.IndividualRecurringSchedules from oe.Payments where schedule id exists but IRS row is missing.
-- Run once per environment after deploy (safe to re-run).
-- Canonical schedule metadata should live in IndividualRecurringSchedules; Payments may still carry RecurringScheduleId for charge rows.

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'IndividualRecurringSchedules')
BEGIN
    PRINT N'SKIP: oe.IndividualRecurringSchedules does not exist — run sql-changes/add-individual-recurring-schedules.sql first.';
    RETURN;
END;

INSERT INTO oe.IndividualRecurringSchedules (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate)
SELECT src.HouseholdId, src.TenantId, CAST(src.RecurringScheduleId AS NVARCHAR(255)), src.Amount, src.NextBillingDate, 1, GETUTCDATE(), GETUTCDATE()
FROM (
    SELECT p.HouseholdId, p.TenantId, p.RecurringScheduleId, p.Amount, p.NextBillingDate,
           ROW_NUMBER() OVER (PARTITION BY p.HouseholdId, p.RecurringScheduleId ORDER BY p.PaymentDate DESC) AS rn
    FROM oe.Payments p
    WHERE p.RecurringScheduleId IS NOT NULL
      AND p.HouseholdId IS NOT NULL
      AND p.TenantId IS NOT NULL
      AND p.Status IN (N'succeeded', N'APPROVAL', N'Completed', N'Pending', N'RecurringScheduled')
) src
WHERE src.rn = 1
  AND NOT EXISTS (
      SELECT 1
      FROM oe.IndividualRecurringSchedules irs
      WHERE irs.HouseholdId = src.HouseholdId
        AND irs.DimeScheduleId = CAST(src.RecurringScheduleId AS NVARCHAR(255))
  );

PRINT N'Backfill: inserted missing IndividualRecurringSchedules rows from oe.Payments (if any).';
