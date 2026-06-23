-- sql-changes/allaboard365/2026-05-04-group-recurring-plans-allow-null-schedule-id.sql
/*
  Allow NULL DimeScheduleId on oe.GroupRecurringPaymentPlans.

  Background: backend/services/groupPaymentService.js inserts NULL into
  DimeScheduleId on initial plan creation, with the comment "DIME schedule
  will be created by monthly Azure function — prevents race conditions".
  The schema previously rejected those inserts as NOT NULL, breaking the
  bootstrap path on the very first plan-change action for a brand-new
  group.

  All readers (groupPaymentScheduler.js:206, invoiceService.js:995,
  enrollmentRecurringGapAudit.service.js) already null-check this column.
*/

IF EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'oe'
    AND TABLE_NAME = 'GroupRecurringPaymentPlans'
    AND COLUMN_NAME = 'DimeScheduleId'
    AND IS_NULLABLE = 'NO'
)
BEGIN
  ALTER TABLE oe.GroupRecurringPaymentPlans
    ALTER COLUMN DimeScheduleId nvarchar(255) NULL;
END
