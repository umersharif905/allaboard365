-- Persist eligibility CSV in Azure Blob (optional) so downloads work after temp is cleared or across hosts.
-- Application sets EligibilityAzureBlobContainer + EligibilityAzureBlobName when upload succeeds.

IF COL_LENGTH(N'oe.VendorEligibilityExportFile', N'EligibilityAzureBlobContainer') IS NULL
BEGIN
    ALTER TABLE oe.VendorEligibilityExportFile ADD EligibilityAzureBlobContainer NVARCHAR(128) NULL;
    PRINT 'Added oe.VendorEligibilityExportFile.EligibilityAzureBlobContainer';
END

IF COL_LENGTH(N'oe.VendorEligibilityExportFile', N'EligibilityAzureBlobName') IS NULL
BEGIN
    ALTER TABLE oe.VendorEligibilityExportFile ADD EligibilityAzureBlobName NVARCHAR(1024) NULL;
    PRINT 'Added oe.VendorEligibilityExportFile.EligibilityAzureBlobName';
END
