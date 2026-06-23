-- Run history for scheduled vendor export jobs (eligibility / payables).
-- Safe to re-run: creates table only if missing.

IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'VendorScheduledJobRuns'
)
BEGIN
    CREATE TABLE oe.VendorScheduledJobRuns (
        VendorScheduledJobRunId UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT PK_VendorScheduledJobRuns PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
        VendorScheduledJobId UNIQUEIDENTIFIER NULL,
        VendorId UNIQUEIDENTIFIER NOT NULL,
        JobType NVARCHAR(64) NOT NULL,
        TriggerSource NVARCHAR(32) NOT NULL CONSTRAINT DF_VendorScheduledJobRuns_Trigger DEFAULT (N'scheduled'),
        RanAt DATETIME2 NOT NULL CONSTRAINT DF_VendorScheduledJobRuns_RanAt DEFAULT (SYSUTCDATETIME()),
        Success BIT NOT NULL,
        ExportSkipped BIT NOT NULL CONSTRAINT DF_VendorScheduledJobRuns_ExportSkipped DEFAULT (0),
        RecordCount INT NULL,
        FileName NVARCHAR(512) NULL,
        EligibilityExportFileId UNIQUEIDENTIFIER NULL,
        PayablesArtifactPath NVARCHAR(1024) NULL,
        NACHAId UNIQUEIDENTIFIER NULL,
        TenantsJson NVARCHAR(MAX) NULL,
        MethodsJson NVARCHAR(MAX) NULL,
        ErrorMessage NVARCHAR(MAX) NULL,
        CONSTRAINT FK_VendorScheduledJobRuns_Vendors FOREIGN KEY (VendorId)
            REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_VendorScheduledJobRuns_ScheduledJob FOREIGN KEY (VendorScheduledJobId)
            REFERENCES oe.VendorScheduledJobs (VendorScheduledJobId) ON DELETE SET NULL
    );

    CREATE INDEX IX_VendorScheduledJobRuns_VendorId_RanAt
        ON oe.VendorScheduledJobRuns (VendorId, RanAt DESC);
END
GO
