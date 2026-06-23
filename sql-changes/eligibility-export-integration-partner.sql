-- ============================================================================
-- ELIGIBILITY EXPORT: INTEGRATION PARTNER (e.g. AB365 for AllAboard365)
-- ============================================================================
-- Adds EligibilityIntegrationPartner to oe.Vendors. Used as first column
-- in ShareWELL-style eligibility CSV (Integration Partner). Default AB365.
-- ============================================================================

PRINT 'Eligibility export: adding EligibilityIntegrationPartner to oe.Vendors...';

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = N'oe' AND TABLE_NAME = N'Vendors' AND COLUMN_NAME = N'EligibilityIntegrationPartner'
)
BEGIN
    ALTER TABLE oe.Vendors ADD EligibilityIntegrationPartner NVARCHAR(50) NULL;
    PRINT 'Added oe.Vendors.EligibilityIntegrationPartner (app default AB365 when null)';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.EligibilityIntegrationPartner already exists';
END
GO

PRINT 'Eligibility integration partner column update complete.';
