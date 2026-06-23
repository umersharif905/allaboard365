-- ============================================================================
-- ELIGIBILITY EXPORT: EFFECTIVE AS OF DATE (SNAPSHOT DATE)
-- ============================================================================
-- Adds EffectiveAsOfDate: the "effective before or on" date used to filter
-- enrollments when generating the file. GeneratedAt/CreatedDate remain
-- "when the file was created"; this is the as-of date for the data.
-- ============================================================================

PRINT 'Eligibility export: adding EffectiveAsOfDate to VendorEligibilityExportFile...';

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = N'oe' AND TABLE_NAME = N'VendorEligibilityExportFile' AND COLUMN_NAME = N'EffectiveAsOfDate'
)
BEGIN
    ALTER TABLE oe.VendorEligibilityExportFile ADD EffectiveAsOfDate DATE NULL;
    PRINT 'Added oe.VendorEligibilityExportFile.EffectiveAsOfDate';
END
ELSE
BEGIN
    PRINT 'oe.VendorEligibilityExportFile.EffectiveAsOfDate already exists';
END
GO

PRINT 'Eligibility export effective-as-of-date column update complete.';
