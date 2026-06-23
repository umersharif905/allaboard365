-- Per-file import detail (household names, plans) for vendor SFTP run history UI.
-- Run with @DryRun=0 after review.

DECLARE @DryRun BIT = 1;

IF @DryRun = 1
BEGIN
  SELECT 'WOULD ADD', 'oe.VendorImportJobRunFiles.ImportSummary', 'NVARCHAR(MAX) NULL';
END
ELSE
BEGIN
  IF COL_LENGTH('oe.VendorImportJobRunFiles', 'ImportSummary') IS NULL
  BEGIN
    ALTER TABLE oe.VendorImportJobRunFiles
      ADD ImportSummary NVARCHAR(MAX) NULL;
    PRINT 'Added oe.VendorImportJobRunFiles.ImportSummary';
  END
  ELSE
    PRINT 'SKIP: ImportSummary already exists';
END
