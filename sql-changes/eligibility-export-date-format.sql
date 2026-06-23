-- ============================================================================
-- ELIGIBILITY EXPORT: DATE FORMAT OPTION (PER VENDOR)
-- ============================================================================
-- Adds oe.Vendors.EligibilityDateFormat so each vendor can choose:
--   ARM   = M/d/yyyy (e.g. 2/1/2025) — original ARM format
--   Padded = MM/dd/yyyy (e.g. 02/01/2025) — e.g. Sharewell
--   Compact = MMDDYYYY (e.g. 02012025)
-- ============================================================================

-- USE [open-enroll]; -- if needed
-- GO

PRINT 'Eligibility export: adding EligibilityDateFormat to oe.Vendors...';

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'EligibilityDateFormat'
)
BEGIN
    ALTER TABLE oe.Vendors ADD EligibilityDateFormat NVARCHAR(20) NULL;
    PRINT 'Added oe.Vendors.EligibilityDateFormat';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.EligibilityDateFormat already exists';
END
GO

-- Run in separate batch so new column is visible
UPDATE oe.Vendors SET EligibilityDateFormat = 'ARM' WHERE EligibilityDateFormat IS NULL;
GO

PRINT 'Eligibility date format schema update complete.';
