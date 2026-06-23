-- sql-changes/allaboard365/2026-05-04-group-recurring-plans-add-cohort.sql
/*
  Add Cohort column to oe.GroupRecurringPaymentPlans so a single group can have
  one active plan per billing cohort (FIRST charged on the 5th, FIFTEENTH on the
  20th). Mixed-cohort groups need two plans + two DIME schedules to bill each
  household on the cycle that matches its enrollment effective date.

  Existing rows are backfilled to 'FIRST' (every plan today bills on day 5,
  which is the FIRST cohort's charge day).

  Idempotent.
*/

IF COL_LENGTH('oe.GroupRecurringPaymentPlans', 'Cohort') IS NULL
BEGIN
  ALTER TABLE oe.GroupRecurringPaymentPlans
    ADD Cohort NVARCHAR(20) NOT NULL CONSTRAINT DF_GroupRecurringPaymentPlans_Cohort DEFAULT N'FIRST';
END;

-- Backfill: any pre-existing plan with BillingDay=20 was created by the
-- bootstrap path under the FIFTEENTH cohort; mark it accordingly so the
-- scheduler can find it on the next 15th-cycle run.
UPDATE oe.GroupRecurringPaymentPlans
   SET Cohort = N'FIFTEENTH'
 WHERE BillingDay = 20
   AND Cohort = N'FIRST';

-- Drop the pre-existing UNIQUE(GroupId, IsActive) constraint. It limited each
-- group to at most one active + one inactive row, which makes mixed-cohort
-- billing impossible (we now need up to 2 active + 2+ inactive per group: one
-- (active, history) per cohort). The replacement filtered index below pins
-- the correct invariant: at most one ACTIVE plan per (GroupId, Cohort).
DECLARE @oldUq sysname;
SELECT @oldUq = kc.name
  FROM sys.key_constraints kc
  JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
 WHERE kc.parent_object_id = OBJECT_ID('oe.GroupRecurringPaymentPlans')
   AND kc.type = 'UQ'
   AND c.name IN ('GroupId', 'IsActive')
 GROUP BY kc.name
HAVING COUNT(*) = 2;
IF @oldUq IS NOT NULL
BEGIN
  DECLARE @dropUq nvarchar(max) = N'ALTER TABLE oe.GroupRecurringPaymentPlans DROP CONSTRAINT ' + QUOTENAME(@oldUq);
  EXEC sp_executesql @dropUq;
END;

-- Uniqueness: at most one ACTIVE plan per (GroupId, Cohort). Inactive history
-- rows are unconstrained so the scheduler's cancel-and-recreate flow keeps
-- working. Filtered index because IsActive is a bit (filter on bit=1 is fine).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'UX_GroupRecurringPaymentPlans_GroupId_Cohort_Active'
     AND object_id = OBJECT_ID('oe.GroupRecurringPaymentPlans')
)
BEGIN
  CREATE UNIQUE INDEX UX_GroupRecurringPaymentPlans_GroupId_Cohort_Active
    ON oe.GroupRecurringPaymentPlans (GroupId, Cohort)
    WHERE IsActive = 1;
END;
