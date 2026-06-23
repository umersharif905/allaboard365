-- Optional: dedupe payables scheduled exports — skip re-upload when latest NACHA unchanged.
IF EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'VendorScheduledJobs'
)
AND NOT EXISTS (
    SELECT 1 FROM sys.columns c
    INNER JOIN sys.tables t ON c.object_id = t.object_id
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'VendorScheduledJobs' AND c.name = 'LastExportedNachaId'
)
BEGIN
    ALTER TABLE oe.VendorScheduledJobs ADD LastExportedNachaId UNIQUEIDENTIFIER NULL;
END
GO
