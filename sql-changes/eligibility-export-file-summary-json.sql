-- ============================================================================
-- ELIGIBILITY EXPORT: STORE SUMMARY JSON ON EACH FILE
-- ============================================================================
-- Adds SummaryJson (totalFamilies, newCount, updatedCount, terminatedCount)
-- so we can show the generation overview for any file when loading the list.
-- ============================================================================

PRINT 'Eligibility export: adding SummaryJson to VendorEligibilityExportFile...';

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = N'oe' AND TABLE_NAME = N'VendorEligibilityExportFile' AND COLUMN_NAME = N'SummaryJson'
)
BEGIN
    ALTER TABLE oe.VendorEligibilityExportFile ADD SummaryJson NVARCHAR(MAX) NULL;
    PRINT 'Added oe.VendorEligibilityExportFile.SummaryJson';
END
ELSE
BEGIN
    PRINT 'oe.VendorEligibilityExportFile.SummaryJson already exists';
END
GO

PRINT 'Eligibility export summary column update complete.';
