-- Monthly scheduled export: day of month (1–31). Scheduler clamps to last day of short months (e.g. 31 → Feb 28/29).
-- Run on oe. Safe to re-run.
-- Also bundled in 2026-04-02-vendor-scheduled-jobs-export-trigger.sql (preferred: one script for prod).

IF COL_LENGTH('oe.VendorScheduledJobs', 'ExportScheduleDayOfMonth') IS NULL
BEGIN
    ALTER TABLE oe.VendorScheduledJobs
    ADD ExportScheduleDayOfMonth INT NULL;
    -- NULL = legacy behavior (treated as 1 in application)
END
GO
