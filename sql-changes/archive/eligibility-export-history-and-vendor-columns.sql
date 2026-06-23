-- ============================================================================
-- ELIGIBILITY EXPORT: HISTORY TABLE AND VENDOR COLUMNS
-- ============================================================================
-- Adds:
-- 1. oe.VendorEligibilityExportHistory - when each eligibility file was sent
-- 2. oe.Vendors.EligibilityIncludeOnlyChanges - "Only include enrollment changes" (default 1)
-- 3. oe.Vendors.EligibilityRowTemplate - custom CSV row template with placeholders
-- ============================================================================

-- Use your actual database name if different
-- USE [open-enroll];
-- GO

PRINT 'Eligibility export: creating history table and vendor columns...';

-- ============================================================================
-- 1. CREATE oe.VendorEligibilityExportHistory
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'oe.VendorEligibilityExportHistory') AND type = N'U')
BEGIN
    CREATE TABLE oe.VendorEligibilityExportHistory (
        HistoryId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        VendorId UNIQUEIDENTIFIER NOT NULL,
        SentAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        RecordCount INT NOT NULL DEFAULT 0,
        FileName NVARCHAR(255) NULL,
        IncludeOnlyChanges BIT NOT NULL DEFAULT 1,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_VendorEligibilityExportHistory_Vendor FOREIGN KEY (VendorId) REFERENCES oe.Vendors(VendorId)
    );
    CREATE INDEX IX_VendorEligibilityExportHistory_VendorSentAt ON oe.VendorEligibilityExportHistory(VendorId, SentAt DESC);
    PRINT 'Created oe.VendorEligibilityExportHistory';
END
ELSE
BEGIN
    PRINT 'oe.VendorEligibilityExportHistory already exists';
END
GO

-- ============================================================================
-- 2. ADD EligibilityIncludeOnlyChanges TO oe.Vendors
-- ============================================================================
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'EligibilityIncludeOnlyChanges'
)
BEGIN
    ALTER TABLE oe.Vendors ADD EligibilityIncludeOnlyChanges BIT NOT NULL DEFAULT 1;
    PRINT 'Added oe.Vendors.EligibilityIncludeOnlyChanges';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.EligibilityIncludeOnlyChanges already exists';
END
GO

-- ============================================================================
-- 3. ADD EligibilityRowTemplate TO oe.Vendors
-- ============================================================================
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Vendors' AND COLUMN_NAME = 'EligibilityRowTemplate'
)
BEGIN
    ALTER TABLE oe.Vendors ADD EligibilityRowTemplate NVARCHAR(MAX) NULL;
    PRINT 'Added oe.Vendors.EligibilityRowTemplate';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.EligibilityRowTemplate already exists';
END
GO

PRINT 'Eligibility export schema update complete.';
PRINT 'For date format option (ARM/Padded/Compact), run: sql-changes/eligibility-export-date-format.sql';
