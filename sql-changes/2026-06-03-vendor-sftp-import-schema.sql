-- =============================================================================
-- Vendor SFTP Scheduled Import — Schema Migration
-- Creates: oe.VendorSftpConnections, oe.VendorImportJobs,
--          oe.VendorImportJobRuns, oe.VendorImportJobRunFiles
-- Date: 2026-06-03
-- =============================================================================
-- DRY RUN: Set @DryRun = 0 to execute.
-- Default @DryRun = 1 — runs SELECT preview only, no writes.
-- =============================================================================

DECLARE @DryRun BIT = 1;

BEGIN TRY
  BEGIN TRANSACTION;

  -- -----------------------------------------------------------------------
  -- DRY RUN preview — show what would be created
  -- -----------------------------------------------------------------------
  IF @DryRun = 1
  BEGIN
    PRINT 'DRY RUN — no changes written. Set @DryRun = 0 to execute.';

    SELECT 'WOULD CREATE' AS Action, 'oe.VendorSftpConnections' AS ObjectName, 'TABLE' AS ObjectType
    UNION ALL
    SELECT 'WOULD CREATE', 'oe.VendorImportJobs', 'TABLE'
    UNION ALL
    SELECT 'WOULD CREATE', 'oe.VendorImportJobRuns', 'TABLE'
    UNION ALL
    SELECT 'WOULD CREATE', 'oe.VendorImportJobRunFiles', 'TABLE'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorSftpConnections_VendorId', 'INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorImportJobs_VendorId', 'INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorImportJobs_TenantId', 'INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorImportJobs_IsEnabled', 'INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'UX_VendorImportJobs_VendorLegacyKey', 'UNIQUE INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorImportJobRuns_JobId', 'INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorImportJobRuns_VendorId', 'INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorImportJobRuns_Status', 'INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorImportJobRunFiles_RunId', 'INDEX'
    UNION ALL
    SELECT 'WOULD CREATE', 'IX_VendorImportJobRunFiles_JobId', 'INDEX';

    -- Preview existing tables in oe schema (sanity check)
    SELECT TABLE_SCHEMA, TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe'
      AND TABLE_NAME IN (
        'VendorSftpConnections', 'VendorImportJobs', 'VendorShareImportJobs',
        'VendorImportJobRuns', 'VendorImportJobRunFiles',
        'VendorImportJobRows', 'VendorShareImportJobRows'
      );

    IF OBJECT_ID(N'oe.VendorImportJobs', N'U') IS NOT NULL
       AND COL_LENGTH(N'oe.VendorImportJobs', N'JobType') IS NOT NULL
       AND COL_LENGTH(N'oe.VendorImportJobs', N'ConnectionId') IS NULL
      SELECT 'WOULD RENAME' AS Action, 'oe.VendorImportJobs' AS ObjectName, 'oe.VendorShareImportJobs' AS ObjectType
      UNION ALL
      SELECT 'WOULD RENAME', 'oe.VendorImportJobRows', 'oe.VendorShareImportJobRows';

    ROLLBACK TRANSACTION;
    RETURN;
  END;

  -- -----------------------------------------------------------------------
  -- EXECUTE path (@DryRun = 0)
  -- -----------------------------------------------------------------------

  -- -----------------------------------------------------------------------
  -- 1. oe.VendorSftpConnections
  -- -----------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorSftpConnections'
  )
  BEGIN
    CREATE TABLE oe.VendorSftpConnections (
      ConnectionId          UNIQUEIDENTIFIER NOT NULL
                              CONSTRAINT PK_VendorSftpConnections PRIMARY KEY
                              DEFAULT NEWID(),
      VendorId              UNIQUEIDENTIFIER NOT NULL,
      DisplayName           NVARCHAR(150)    NOT NULL,
      Host                  NVARCHAR(255)    NOT NULL,
      Port                  INT              NOT NULL
                              CONSTRAINT DF_VendorSftpConnections_Port DEFAULT 22,
      Username              NVARCHAR(150)    NOT NULL,
      AuthType              NVARCHAR(20)     NOT NULL
                              CONSTRAINT DF_VendorSftpConnections_AuthType DEFAULT 'password',
      PasswordEncrypted     NVARCHAR(MAX)    NULL,
      PrivateKeyEncrypted   NVARCHAR(MAX)    NULL,
      PassphraseEncrypted   NVARCHAR(MAX)    NULL,
      BaseDirectory         NVARCHAR(500)    NULL,
      IsActive              BIT              NOT NULL
                              CONSTRAINT DF_VendorSftpConnections_IsActive DEFAULT 1,
      CreatedBy             UNIQUEIDENTIFIER NULL,
      CreatedUtc            DATETIME2        NOT NULL
                              CONSTRAINT DF_VendorSftpConnections_CreatedUtc DEFAULT SYSUTCDATETIME(),
      ModifiedUtc           DATETIME2        NOT NULL
                              CONSTRAINT DF_VendorSftpConnections_ModifiedUtc DEFAULT SYSUTCDATETIME()
    );
    PRINT 'Created oe.VendorSftpConnections';
  END
  ELSE
    PRINT 'SKIP: oe.VendorSftpConnections already exists';

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorSftpConnections_VendorId'
      AND object_id = OBJECT_ID('oe.VendorSftpConnections')
  )
  BEGIN
    CREATE INDEX IX_VendorSftpConnections_VendorId
      ON oe.VendorSftpConnections (VendorId, IsActive);
    PRINT 'Created IX_VendorSftpConnections_VendorId';
  END

  -- -----------------------------------------------------------------------
  -- 2. oe.VendorImportJobs (SFTP scheduled imports)
  -- -----------------------------------------------------------------------
  -- Legacy 2026-05-24 share-request import jobs used the same table name (JobType, Status).
  -- NOTE: sp_rename is not transactional — a failed run may leave oe.VendorShareImportJobs
  -- without oe.VendorImportJobs; this block is idempotent for that case.
  IF OBJECT_ID(N'oe.VendorImportJobs', N'U') IS NOT NULL
     AND COL_LENGTH(N'oe.VendorImportJobs', N'JobType') IS NOT NULL
     AND COL_LENGTH(N'oe.VendorImportJobs', N'ConnectionId') IS NULL
     AND OBJECT_ID(N'oe.VendorShareImportJobs', N'U') IS NULL
  BEGIN
    IF OBJECT_ID(N'oe.VendorImportJobRows', N'U') IS NOT NULL
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM sys.foreign_keys fk
        WHERE fk.parent_object_id = OBJECT_ID(N'oe.VendorImportJobRows')
          AND fk.name = N'FK_VendorImportJobRows_Job'
      )
        ALTER TABLE oe.VendorImportJobRows
          DROP CONSTRAINT FK_VendorImportJobRows_Job;

      EXEC sp_rename N'oe.VendorImportJobRows', N'VendorShareImportJobRows', N'OBJECT';
      PRINT 'Renamed oe.VendorImportJobRows → oe.VendorShareImportJobRows';
    END;

    EXEC sp_rename N'oe.VendorImportJobs', N'VendorShareImportJobs', N'OBJECT';
    PRINT 'Renamed legacy oe.VendorImportJobs → oe.VendorShareImportJobs';

    IF OBJECT_ID(N'oe.VendorShareImportJobRows', N'U') IS NOT NULL
       AND NOT EXISTS (
        SELECT 1
        FROM sys.foreign_keys fk
        WHERE fk.parent_object_id = OBJECT_ID(N'oe.VendorShareImportJobRows')
          AND fk.referenced_object_id = OBJECT_ID(N'oe.VendorShareImportJobs')
      )
    BEGIN
      ALTER TABLE oe.VendorShareImportJobRows
        ADD CONSTRAINT FK_VendorShareImportJobRows_Job
        FOREIGN KEY (JobId) REFERENCES oe.VendorShareImportJobs (JobId) ON DELETE CASCADE;
      PRINT 'Recreated FK_VendorShareImportJobRows_Job';
    END;
  END
  ELSE IF OBJECT_ID(N'oe.VendorShareImportJobs', N'U') IS NOT NULL
    PRINT 'SKIP: legacy import jobs already at oe.VendorShareImportJobs';

  -- Legacy oe.VendorShareImportJobs keeps PK_VendorImportJobs; constraint names are schema-global,
  -- so the new SFTP table uses PK_VendorSftpImportJobs (no sp_rename on Azure).

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorImportJobs'
  )
  BEGIN
    CREATE TABLE oe.VendorImportJobs (
      JobId              UNIQUEIDENTIFIER NOT NULL
                           CONSTRAINT PK_VendorSftpImportJobs PRIMARY KEY
                           DEFAULT NEWID(),
      VendorId           UNIQUEIDENTIFIER NOT NULL,
      ConnectionId       UNIQUEIDENTIFIER NOT NULL,
      TenantId           UNIQUEIDENTIFIER NOT NULL,
      JobName            NVARCHAR(150)    NOT NULL
                           CONSTRAINT DF_VendorImportJobs_JobName DEFAULT '',
      SubFolderPath      NVARCHAR(500)    NULL,
      FormatSlug         NVARCHAR(50)     NOT NULL,
      CronScheduleUtc    NVARCHAR(100)    NOT NULL,
      ArchiveFolder      NVARCHAR(255)    NOT NULL
                           CONSTRAINT DF_VendorImportJobs_ArchiveFolder DEFAULT 'archived',
      NotifyEmails       NVARCHAR(MAX)    NOT NULL,
      NotifyOnSuccess    BIT              NOT NULL
                           CONSTRAINT DF_VendorImportJobs_NotifyOnSuccess DEFAULT 1,
      NotifyOnFailure    BIT              NOT NULL
                           CONSTRAINT DF_VendorImportJobs_NotifyOnFailure DEFAULT 1,
      NotifyOnNoFiles    BIT              NOT NULL
                           CONSTRAINT DF_VendorImportJobs_NotifyOnNoFiles DEFAULT 0,
      LegacyProcessorKey NVARCHAR(80)     NULL,
      IsEnabled          BIT              NOT NULL
                           CONSTRAINT DF_VendorImportJobs_IsEnabled DEFAULT 0,
      IsRunning          BIT              NOT NULL
                           CONSTRAINT DF_VendorImportJobs_IsRunning DEFAULT 0,
      LastRunAtUtc       DATETIME2        NULL,
      CreatedBy          UNIQUEIDENTIFIER NULL,
      CreatedUtc         DATETIME2        NOT NULL
                           CONSTRAINT DF_VendorImportJobs_CreatedUtc DEFAULT SYSUTCDATETIME(),
      ModifiedUtc        DATETIME2        NOT NULL
                           CONSTRAINT DF_VendorImportJobs_ModifiedUtc DEFAULT SYSUTCDATETIME()
    );
    PRINT 'Created oe.VendorImportJobs';
  END
  ELSE
    PRINT 'SKIP: oe.VendorImportJobs already exists';

  -- Idempotent column adds when SFTP table pre-existed without newer columns (dynamic SQL avoids compile-time errors)
  IF OBJECT_ID(N'oe.VendorImportJobs', N'U') IS NOT NULL
     AND COL_LENGTH(N'oe.VendorImportJobs', N'ConnectionId') IS NOT NULL
     AND COL_LENGTH(N'oe.VendorImportJobs', N'JobName') IS NULL
  BEGIN
    EXEC(N'
      ALTER TABLE oe.VendorImportJobs ADD JobName NVARCHAR(150) NULL;
      UPDATE oe.VendorImportJobs SET JobName = N'''' WHERE JobName IS NULL;
      ALTER TABLE oe.VendorImportJobs ALTER COLUMN JobName NVARCHAR(150) NOT NULL;
      IF NOT EXISTS (
        SELECT 1 FROM sys.default_constraints
        WHERE parent_object_id = OBJECT_ID(N''oe.VendorImportJobs'')
          AND name = N''DF_VendorImportJobs_JobName''
      )
        ALTER TABLE oe.VendorImportJobs
          ADD CONSTRAINT DF_VendorImportJobs_JobName DEFAULT N'''' FOR JobName;
    ');
    PRINT 'Added oe.VendorImportJobs.JobName';
  END;

  IF OBJECT_ID(N'oe.VendorImportJobs', N'U') IS NOT NULL
     AND COL_LENGTH(N'oe.VendorImportJobs', N'ConnectionId') IS NOT NULL
     AND COL_LENGTH(N'oe.VendorImportJobs', N'LegacyProcessorKey') IS NULL
  BEGIN
    EXEC(N'ALTER TABLE oe.VendorImportJobs ADD LegacyProcessorKey NVARCHAR(80) NULL;');
    PRINT 'Added oe.VendorImportJobs.LegacyProcessorKey';
  END;

  IF COL_LENGTH(N'oe.VendorImportJobs', N'IsEnabled') IS NOT NULL
     AND NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorImportJobs_VendorId'
      AND object_id = OBJECT_ID(N'oe.VendorImportJobs')
  )
  BEGIN
    CREATE INDEX IX_VendorImportJobs_VendorId
      ON oe.VendorImportJobs (VendorId, IsEnabled);
    PRINT 'Created IX_VendorImportJobs_VendorId';
  END

  IF COL_LENGTH(N'oe.VendorImportJobs', N'TenantId') IS NOT NULL
     AND NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorImportJobs_TenantId'
      AND object_id = OBJECT_ID(N'oe.VendorImportJobs')
  )
  BEGIN
    CREATE INDEX IX_VendorImportJobs_TenantId
      ON oe.VendorImportJobs (TenantId);
    PRINT 'Created IX_VendorImportJobs_TenantId';
  END

  IF COL_LENGTH(N'oe.VendorImportJobs', N'IsEnabled') IS NOT NULL
     AND COL_LENGTH(N'oe.VendorImportJobs', N'LastRunAtUtc') IS NOT NULL
     AND NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorImportJobs_IsEnabled'
      AND object_id = OBJECT_ID(N'oe.VendorImportJobs')
  )
  BEGIN
    CREATE INDEX IX_VendorImportJobs_IsEnabled
      ON oe.VendorImportJobs (IsEnabled, LastRunAtUtc);
    PRINT 'Created IX_VendorImportJobs_IsEnabled';
  END

  IF COL_LENGTH(N'oe.VendorImportJobs', N'LegacyProcessorKey') IS NOT NULL
     AND NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UX_VendorImportJobs_VendorLegacyKey'
      AND object_id = OBJECT_ID('oe.VendorImportJobs')
  )
  BEGIN
    -- Dynamic SQL: batch compile must not reference LegacyProcessorKey before ALTER above
    EXEC(N'
      CREATE UNIQUE INDEX UX_VendorImportJobs_VendorLegacyKey
        ON oe.VendorImportJobs (VendorId, LegacyProcessorKey)
        WHERE LegacyProcessorKey IS NOT NULL;
    ');
    PRINT 'Created UX_VendorImportJobs_VendorLegacyKey';
  END

  -- -----------------------------------------------------------------------
  -- 3. oe.VendorImportJobRuns
  -- -----------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorImportJobRuns'
  )
  BEGIN
    CREATE TABLE oe.VendorImportJobRuns (
      RunId                UNIQUEIDENTIFIER NOT NULL
                             CONSTRAINT PK_VendorImportJobRuns PRIMARY KEY
                             DEFAULT NEWID(),
      JobId                UNIQUEIDENTIFIER NOT NULL,
      VendorId             UNIQUEIDENTIFIER NOT NULL,
      TenantId             UNIQUEIDENTIFIER NOT NULL,
      TriggerType          NVARCHAR(20)     NOT NULL,
      -- Status: running|success|partial|failed|no-files|skipped
      Status               NVARCHAR(20)     NOT NULL,
      FilesFound           INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRuns_FilesFound DEFAULT 0,
      FilesImported        INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRuns_FilesImported DEFAULT 0,
      FilesFailed          INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRuns_FilesFailed DEFAULT 0,
      HouseholdsCreated    INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRuns_HHCreated DEFAULT 0,
      HouseholdsUpdated    INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRuns_HHUpdated DEFAULT 0,
      HouseholdsTerminated INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRuns_HHTerm DEFAULT 0,
      HouseholdsSkipped    INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRuns_HHSkipped DEFAULT 0,
      ErrorSummary         NVARCHAR(MAX)    NULL,
      StartedUtc           DATETIME2        NOT NULL
                             CONSTRAINT DF_VendorImportJobRuns_StartedUtc DEFAULT SYSUTCDATETIME(),
      CompletedUtc         DATETIME2        NULL
    );
    PRINT 'Created oe.VendorImportJobRuns';
  END
  ELSE
    PRINT 'SKIP: oe.VendorImportJobRuns already exists';

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorImportJobRuns_JobId'
      AND object_id = OBJECT_ID('oe.VendorImportJobRuns')
  )
  BEGIN
    CREATE INDEX IX_VendorImportJobRuns_JobId
      ON oe.VendorImportJobRuns (JobId, StartedUtc DESC);
    PRINT 'Created IX_VendorImportJobRuns_JobId';
  END

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorImportJobRuns_VendorId'
      AND object_id = OBJECT_ID('oe.VendorImportJobRuns')
  )
  BEGIN
    CREATE INDEX IX_VendorImportJobRuns_VendorId
      ON oe.VendorImportJobRuns (VendorId, StartedUtc DESC);
    PRINT 'Created IX_VendorImportJobRuns_VendorId';
  END

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorImportJobRuns_Status'
      AND object_id = OBJECT_ID('oe.VendorImportJobRuns')
  )
  BEGIN
    CREATE INDEX IX_VendorImportJobRuns_Status
      ON oe.VendorImportJobRuns (Status, StartedUtc DESC);
    PRINT 'Created IX_VendorImportJobRuns_Status';
  END

  -- -----------------------------------------------------------------------
  -- 4. oe.VendorImportJobRunFiles
  -- -----------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'VendorImportJobRunFiles'
  )
  BEGIN
    CREATE TABLE oe.VendorImportJobRunFiles (
      FileId               UNIQUEIDENTIFIER NOT NULL
                             CONSTRAINT PK_VendorImportJobRunFiles PRIMARY KEY
                             DEFAULT NEWID(),
      RunId                UNIQUEIDENTIFIER NOT NULL,
      JobId                UNIQUEIDENTIFIER NOT NULL,
      VendorId             UNIQUEIDENTIFIER NOT NULL,
      FileName             NVARCHAR(500)    NOT NULL,
      RemotePath           NVARCHAR(1000)   NOT NULL,
      -- Status: success|failed|skipped
      Status               NVARCHAR(20)     NOT NULL,
      HouseholdsCreated    INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRunFiles_HHCreated DEFAULT 0,
      HouseholdsUpdated    INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRunFiles_HHUpdated DEFAULT 0,
      HouseholdsTerminated INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRunFiles_HHTerm DEFAULT 0,
      HouseholdsSkipped    INT NOT NULL
                             CONSTRAINT DF_VendorImportJobRunFiles_HHSkipped DEFAULT 0,
      -- JSON array of {row, message}
      RowErrors            NVARCHAR(MAX)    NULL,
      ArchivePath          NVARCHAR(1000)   NULL,
      ProcessedUtc         DATETIME2        NOT NULL
                             CONSTRAINT DF_VendorImportJobRunFiles_ProcessedUtc DEFAULT SYSUTCDATETIME()
    );
    PRINT 'Created oe.VendorImportJobRunFiles';
  END
  ELSE
    PRINT 'SKIP: oe.VendorImportJobRunFiles already exists';

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorImportJobRunFiles_RunId'
      AND object_id = OBJECT_ID('oe.VendorImportJobRunFiles')
  )
  BEGIN
    CREATE INDEX IX_VendorImportJobRunFiles_RunId
      ON oe.VendorImportJobRunFiles (RunId, ProcessedUtc);
    PRINT 'Created IX_VendorImportJobRunFiles_RunId';
  END

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_VendorImportJobRunFiles_JobId'
      AND object_id = OBJECT_ID('oe.VendorImportJobRunFiles')
  )
  BEGIN
    CREATE INDEX IX_VendorImportJobRunFiles_JobId
      ON oe.VendorImportJobRunFiles (JobId, ProcessedUtc DESC);
    PRINT 'Created IX_VendorImportJobRunFiles_JobId';
  END

  -- -----------------------------------------------------------------------
  -- Final row counts
  -- -----------------------------------------------------------------------
  SELECT
    'oe.VendorSftpConnections' AS TableName,
    COUNT(*) AS TotalRows
  FROM oe.VendorSftpConnections
  UNION ALL
  SELECT 'oe.VendorImportJobs', COUNT(*) FROM oe.VendorImportJobs
  UNION ALL
  SELECT 'oe.VendorImportJobRuns', COUNT(*) FROM oe.VendorImportJobRuns
  UNION ALL
  SELECT 'oe.VendorImportJobRunFiles', COUNT(*) FROM oe.VendorImportJobRunFiles;

  COMMIT TRANSACTION;
  PRINT 'Migration committed successfully.';

END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  DECLARE @ErrSev INT             = ERROR_SEVERITY();
  DECLARE @ErrSt  INT             = ERROR_STATE();
  RAISERROR(@ErrMsg, @ErrSev, @ErrSt);
END CATCH;
