-- Persist scheduled payables CSVs in Azure Blob (optional) so run-download works after temp cleanup/redeploy.
-- Application sets PayablesAzureBlobContainer + PayablesAzureBlobName when upload succeeds.

IF COL_LENGTH(N'oe.VendorScheduledJobRuns', N'PayablesAzureBlobContainer') IS NULL
BEGIN
    ALTER TABLE oe.VendorScheduledJobRuns ADD PayablesAzureBlobContainer NVARCHAR(128) NULL;
    PRINT 'Added oe.VendorScheduledJobRuns.PayablesAzureBlobContainer';
END

IF COL_LENGTH(N'oe.VendorScheduledJobRuns', N'PayablesAzureBlobName') IS NULL
BEGIN
    ALTER TABLE oe.VendorScheduledJobRuns ADD PayablesAzureBlobName NVARCHAR(1024) NULL;
    PRINT 'Added oe.VendorScheduledJobRuns.PayablesAzureBlobName';
END
