-- ============================================================================
-- ELIGIBILITY EXPORT: GENERATED FILES (PENDING / SENT)
-- ============================================================================
-- Adds:
-- 1. oe.VendorEligibilityExportFile - each generated eligibility file (pending or sent)
-- 2. oe.VendorEligibilityExportHistory.VendorEligibilityExportFileId - link so we can delete history row when unmarking
-- ============================================================================

PRINT 'Eligibility export: creating generated-files table and history FK...';

-- ============================================================================
-- 1. CREATE oe.VendorEligibilityExportFile
-- ============================================================================
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'oe.VendorEligibilityExportFile') AND type = N'U')
BEGIN
    CREATE TABLE oe.VendorEligibilityExportFile (
        FileId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        VendorId UNIQUEIDENTIFIER NOT NULL,
        GeneratedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        FileName NVARCHAR(255) NOT NULL,
        FilePath NVARCHAR(1024) NOT NULL,
        RecordCount INT NOT NULL DEFAULT 0,
        IncludeOnlyChanges BIT NOT NULL DEFAULT 1,
        SentAt DATETIME2 NULL,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_VendorEligibilityExportFile_Vendor FOREIGN KEY (VendorId) REFERENCES oe.Vendors(VendorId)
    );
    CREATE INDEX IX_VendorEligibilityExportFile_VendorGenerated ON oe.VendorEligibilityExportFile(VendorId, GeneratedAt DESC);
    PRINT 'Created oe.VendorEligibilityExportFile';
END
ELSE
BEGIN
    PRINT 'oe.VendorEligibilityExportFile already exists';
END
GO

-- ============================================================================
-- 2. ADD VendorEligibilityExportFileId TO oe.VendorEligibilityExportHistory
-- ============================================================================
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorEligibilityExportHistory' AND COLUMN_NAME = 'VendorEligibilityExportFileId'
)
BEGIN
    ALTER TABLE oe.VendorEligibilityExportHistory ADD VendorEligibilityExportFileId UNIQUEIDENTIFIER NULL;
    ALTER TABLE oe.VendorEligibilityExportHistory
        ADD CONSTRAINT FK_VendorEligibilityExportHistory_File
        FOREIGN KEY (VendorEligibilityExportFileId) REFERENCES oe.VendorEligibilityExportFile(FileId);
    PRINT 'Added oe.VendorEligibilityExportHistory.VendorEligibilityExportFileId';
END
ELSE
BEGIN
    PRINT 'oe.VendorEligibilityExportHistory.VendorEligibilityExportFileId already exists';
END
GO

PRINT 'Eligibility export generated-files schema update complete.';
