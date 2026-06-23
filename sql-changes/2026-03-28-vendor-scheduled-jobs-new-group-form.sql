-- Optional column: when JobType = new_group_form, run VendorGroupIdService.applyGenerateForGroup before generating PDFs.
IF COL_LENGTH('oe.VendorScheduledJobs', 'GenerateVendorGroupIdsIfNeeded') IS NULL
BEGIN
    ALTER TABLE oe.VendorScheduledJobs ADD GenerateVendorGroupIdsIfNeeded BIT NOT NULL
        CONSTRAINT DF_VendorScheduledJobs_GenerateVendorGroupIdsIfNeeded DEFAULT (0);
END
GO
