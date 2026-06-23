-- ============================================================================
-- VENDOR SFTP: SEPARATE DESTINATION PATHS FOR NACHA AND ELIGIBILITY
-- ============================================================================
-- Adds to oe.Vendors:
--   SftpPathNacha     - destination folder for NACHA/payment files (fallback: SftpPath)
--   SftpPathEligibility - destination folder for eligibility CSV files (fallback: SftpPath)
-- ============================================================================

PRINT 'Adding SftpPathNacha and SftpPathEligibility to oe.Vendors...';

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'SftpPathNacha'
)
BEGIN
    ALTER TABLE oe.Vendors ADD SftpPathNacha NVARCHAR(255) NULL;
    PRINT 'Added oe.Vendors.SftpPathNacha';
END
ELSE
    PRINT 'oe.Vendors.SftpPathNacha already exists';
GO

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'SftpPathEligibility'
)
BEGIN
    ALTER TABLE oe.Vendors ADD SftpPathEligibility NVARCHAR(255) NULL;
    PRINT 'Added oe.Vendors.SftpPathEligibility';
END
ELSE
    PRINT 'oe.Vendors.SftpPathEligibility already exists';
GO

PRINT 'Vendor SFTP destination paths update complete.';
