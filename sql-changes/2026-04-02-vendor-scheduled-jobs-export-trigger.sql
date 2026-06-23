-- Vendor scheduled jobs: day-of-month (monthly schedules) + optional ExportTrigger (calendar vs NACHA sent).
-- Run on oe. Safe to re-run. Adds any column that is still missing (covers prod that ran an older partial script).

IF COL_LENGTH('oe.VendorScheduledJobs', 'ExportScheduleDayOfMonth') IS NULL
BEGIN
    ALTER TABLE oe.VendorScheduledJobs
    ADD ExportScheduleDayOfMonth INT NULL;
    -- NULL = legacy behavior (treated as 1 in application; scheduler clamps 31 → last day of short months)
END
GO

IF COL_LENGTH('oe.VendorScheduledJobs', 'ExportTrigger') IS NULL
BEGIN
    ALTER TABLE oe.VendorScheduledJobs
    ADD ExportTrigger NVARCHAR(32) NULL;
    -- NULL or 'schedule' = calendar-based (default). 'nacha_generation' = run payables when a NACHA batch including this vendor is marked Sent.
END
GO
