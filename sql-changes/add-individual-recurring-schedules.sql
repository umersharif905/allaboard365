-- oe.IndividualRecurringSchedules: Track individual (household) recurring payment schedules.
-- Enables marking as cancelled instead of deleting, so UI can show both active and cancelled schedules.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'IndividualRecurringSchedules')
BEGIN
    CREATE TABLE oe.IndividualRecurringSchedules (
        ScheduleId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        HouseholdId UNIQUEIDENTIFIER NOT NULL,
        TenantId UNIQUEIDENTIFIER NOT NULL,
        DimeScheduleId NVARCHAR(255) NOT NULL,
        MonthlyAmount DECIMAL(10,2) NOT NULL,
        NextBillingDate DATETIME NULL,
        IsActive BIT NOT NULL DEFAULT 1,
        CancelledDate DATETIME NULL,
        CreatedDate DATETIME NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME NOT NULL DEFAULT GETUTCDATE()
    );
    CREATE INDEX IX_IndividualRecurringSchedules_HouseholdId ON oe.IndividualRecurringSchedules(HouseholdId);
    CREATE INDEX IX_IndividualRecurringSchedules_DimeScheduleId ON oe.IndividualRecurringSchedules(DimeScheduleId);
    PRINT 'Created oe.IndividualRecurringSchedules';

    -- Backfill from oe.Payments (existing recurring schedules before this table existed)
    INSERT INTO oe.IndividualRecurringSchedules (HouseholdId, TenantId, DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, CreatedDate, ModifiedDate)
    SELECT p.HouseholdId, p.TenantId, p.RecurringScheduleId, p.Amount, p.NextBillingDate, 1, p.CreatedDate, p.ModifiedDate
    FROM (
        SELECT p.HouseholdId, p.TenantId, p.RecurringScheduleId, p.Amount, p.NextBillingDate, p.CreatedDate, p.ModifiedDate,
               ROW_NUMBER() OVER (PARTITION BY p.HouseholdId, p.RecurringScheduleId ORDER BY p.PaymentDate DESC) as rn
        FROM oe.Payments p
        WHERE p.HouseholdId IS NOT NULL AND p.TenantId IS NOT NULL AND p.RecurringScheduleId IS NOT NULL
          AND p.Status IN ('succeeded', 'APPROVAL', 'Completed', 'RecurringScheduled')
    ) p
    WHERE p.rn = 1;
    PRINT 'Backfilled oe.IndividualRecurringSchedules from oe.Payments';
END
ELSE
BEGIN
    PRINT 'oe.IndividualRecurringSchedules already exists';
END
