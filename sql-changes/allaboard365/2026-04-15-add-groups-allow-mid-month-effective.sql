-- sql-changes/allaboard365/2026-04-15-add-groups-allow-mid-month-effective.sql
/*
  Add per-group opt-in flag for mid-month (15th) effective dates.
  When AllowMidMonthEffective = 1, the enrollment date-picker offers both 1st
  and 15th of each month. Default 0 means existing 1st-only behavior.
*/

IF COL_LENGTH('oe.Groups', 'AllowMidMonthEffective') IS NULL
BEGIN
  ALTER TABLE oe.Groups
    ADD AllowMidMonthEffective bit NOT NULL
      CONSTRAINT DF_Groups_AllowMidMonthEffective DEFAULT (0);
END
