-- Add configurable window for including future-effective enrollments in eligibility export (default 7 days).
-- When set to 0, only current/past effectives are included. When N > 0, include effectives up to N days after effective-as-of date.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'EligibilityFutureEffectiveDays')
BEGIN
    ALTER TABLE oe.Vendors ADD EligibilityFutureEffectiveDays INT NULL;
    PRINT 'EligibilityFutureEffectiveDays column added to oe.Vendors (app defaults to 7 when NULL)';
END
GO
