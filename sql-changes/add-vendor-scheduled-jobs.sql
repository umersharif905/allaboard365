-- Vendor scheduled jobs: multiple schedules per vendor (eligibility export first).
-- Run against oe database. Safe to re-run: backfill only inserts when vendor has legacy schedule and no job row yet.

IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'VendorScheduledJobs'
)
BEGIN
    CREATE TABLE oe.VendorScheduledJobs (
        VendorScheduledJobId UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT PK_VendorScheduledJobs PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
        VendorId UNIQUEIDENTIFIER NOT NULL,
        JobType NVARCHAR(64) NOT NULL,
        IsEnabled BIT NOT NULL CONSTRAINT DF_VendorScheduledJobs_IsEnabled DEFAULT (1),
        ExportSchedule NVARCHAR(100) NULL,
        ExportScheduleDay NVARCHAR(20) NULL,
        ExportScheduleTime NVARCHAR(10) NULL,
        EmailRecipients NVARCHAR(MAX) NULL,
        UseVendorDefaultSftp BIT NOT NULL CONSTRAINT DF_VendorScheduledJobs_UseVendorDefaultSftp DEFAULT (1),
        SftpPathOverride NVARCHAR(512) NULL,
        LastRunAt DATETIME2 NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_VendorScheduledJobs_CreatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_VendorScheduledJobs_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT FK_VendorScheduledJobs_Vendors FOREIGN KEY (VendorId)
            REFERENCES oe.Vendors (VendorId) ON DELETE CASCADE
    );

    CREATE INDEX IX_VendorScheduledJobs_VendorId_IsEnabled
        ON oe.VendorScheduledJobs (VendorId, IsEnabled);

    CREATE INDEX IX_VendorScheduledJobs_ScheduleLookup
        ON oe.VendorScheduledJobs (IsEnabled, ExportSchedule, ExportScheduleDay, ExportScheduleTime)
        WHERE IsEnabled = 1;
END
GO

-- Backfill: one eligibility_export job per vendor that had legacy ExportSchedule set (no existing job for that vendor).
IF EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'VendorScheduledJobs'
)
BEGIN
    INSERT INTO oe.VendorScheduledJobs (
        VendorScheduledJobId,
        VendorId,
        JobType,
        IsEnabled,
        ExportSchedule,
        ExportScheduleDay,
        ExportScheduleTime,
        EmailRecipients,
        UseVendorDefaultSftp,
        SftpPathOverride
    )
    SELECT
        NEWID(),
        v.VendorId,
        N'eligibility_export',
        1,
        NULLIF(LTRIM(RTRIM(v.ExportSchedule)), ''),
        NULLIF(LTRIM(RTRIM(v.ExportScheduleDay)), ''),
        COALESCE(NULLIF(LTRIM(RTRIM(v.ExportScheduleTime)), ''), N'09:00'),
        CASE
            WHEN v.ExportEmailAddress IS NOT NULL AND LTRIM(RTRIM(v.ExportEmailAddress)) <> ''
            THEN LTRIM(RTRIM(v.ExportEmailAddress))
            ELSE NULL
        END,
        1,
        NULL
    FROM oe.Vendors v
    WHERE v.ExportSchedule IS NOT NULL
      AND LTRIM(RTRIM(v.ExportSchedule)) <> ''
      AND NOT EXISTS (
          SELECT 1 FROM oe.VendorScheduledJobs j WHERE j.VendorId = v.VendorId
      );
END
GO
