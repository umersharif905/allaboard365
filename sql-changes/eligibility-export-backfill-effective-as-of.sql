-- ============================================================================
-- Backfill EffectiveAsOfDate for the one file that has NULL (set to Feb 23 2026)
-- ============================================================================
-- Get the file GUID (from ai_scripts): ./db-query.sh "SELECT FileId, VendorId, FileName, EffectiveAsOfDate FROM oe.VendorEligibilityExportFile WHERE EffectiveAsOfDate IS NULL"
-- Then run the UPDATE (from ai_scripts): ./db-query.sh "UPDATE oe.VendorEligibilityExportFile SET EffectiveAsOfDate = '2026-02-23' WHERE EffectiveAsOfDate IS NULL"
-- Or run in SSMS.
-- ============================================================================

-- See the file(s) with no EffectiveAsOfDate (and get FileId if needed)
SELECT FileId, VendorId, FileName, GeneratedAt, RecordCount, EffectiveAsOfDate
FROM oe.VendorEligibilityExportFile
WHERE EffectiveAsOfDate IS NULL;

-- Set EffectiveAsOfDate to 2026-02-23 for that row
UPDATE oe.VendorEligibilityExportFile
SET EffectiveAsOfDate = '2026-02-23'
WHERE EffectiveAsOfDate IS NULL;

-- Verify (should return 0 rows if only one file was null)
SELECT FileId, VendorId, FileName, GeneratedAt, EffectiveAsOfDate
FROM oe.VendorEligibilityExportFile
WHERE EffectiveAsOfDate IS NULL;
