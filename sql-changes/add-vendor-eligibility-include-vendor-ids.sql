-- Add EligibilityIncludeVendorIds to oe.Vendors (JSON array of vendor GUIDs to include in eligibility file).
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'EligibilityIncludeVendorIds'
)
BEGIN
    ALTER TABLE oe.Vendors ADD EligibilityIncludeVendorIds NVARCHAR(MAX) NULL;
    PRINT 'Added oe.Vendors.EligibilityIncludeVendorIds';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.EligibilityIncludeVendorIds already exists';
END
