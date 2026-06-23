/*
  Seed AllAboard vendor SFTP import jobs mirroring sharewell-csv-processor member CSV timers.

  Prerequisite: run sql-changes/2026-06-03-vendor-sftp-import-schema.sql first
  (oe.VendorSftpConnections, oe.VendorImportJobs with LegacyProcessorKey).

  Creates:
    - 1 shared SFTP connection (same host/user as sharewell-csv-processor)
    - 3 import jobs (MPowering, Align SHA, Align) — all IsEnabled = 0
  - Calstar, Summit, E123 omitted (still on sharewell-csv-processor / ShareWELLPartners DB)

  SFTP password is NOT stored here. After apply:
    Vendor portal → Import → SFTP Connections → set password → Test Connection.

  Dual ingest (Align / Align SHA): keep Python timers enabled with ALIGN_SKIP_SFTP_ARCHIVE=true
  (default) so ShareWELL DB is updated first; enable AllAboard jobs on :30 UTC (30 min after Python
  :00) — they import the same CSVs and archive. See sql-changes/2026-06-08-align-dual-sftp-ingest-schedule.sql.

  Full cutover: disable Python Align timers only after AllAboard is sole owner of archive/move.

  Run dry-run (default):
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-03-vendor-sftp-import-sharewell-cutover-seed.sql

  Apply (only after reviewing dry-run output):
    Edit @DryRun = 0 and re-run with explicit approval.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @Now DATETIME2 = SYSUTCDATETIME();
DECLARE @DbName SYSNAME = DB_NAME();

-- ShareWELL vendor (vendor portal)
DECLARE @VendorId UNIQUEIDENTIFIER = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
DECLARE @ExpectedVendorName NVARCHAR(200) = N'ShareWELL Health/Partners';

-- SFTP (matches sharewell-csv-processor app settings — password set via portal, not SQL)
DECLARE @SftpHost NVARCHAR(255) = N'sparkling-water-50295.sftptogo.com';
DECLARE @SftpPort INT = 22;
DECLARE @SftpUsername NVARCHAR(150) = N'106559733aec9ce168adb42e0bfb53';

-- Stable IDs for idempotent re-run
DECLARE @ConnectionId UNIQUEIDENTIFIER = 'aaaaaaaa-0001-4000-8000-000000000001';

-- Tenant targets (override if lookup-by-name fails)
DECLARE @TenantSharewellHealth UNIQUEIDENTIFIER = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6';
DECLARE @TenantAlignHealth UNIQUEIDENTIFIER = '7D5040ED-1105-4940-A352-FF85483B2C3C';
DECLARE @TenantAlignShaOverride UNIQUEIDENTIFIER = NULL;  -- set if no tenant named 'Align Health SHA'

DECLARE @NotifyEmailsJson NVARCHAR(MAX) = N'["admin@open-enroll.net","membersuccess@sharewellpartners.com"]';

BEGIN TRY
  ---------------------------------------------------------------------------
  -- Guards
  ---------------------------------------------------------------------------
  IF OBJECT_ID(N'oe.VendorSftpConnections', N'U') IS NULL
     OR OBJECT_ID(N'oe.VendorImportJobs', N'U') IS NULL
  BEGIN
    IF @DryRun = 1
    BEGIN
      SELECT N'BLOCKED' AS Status,
        N'Run 2026-06-03-vendor-sftp-import-schema.sql first (tables missing).' AS Message,
        @DbName AS DatabaseName;
      RETURN;
    END;
    RAISERROR(
      N'Prerequisite missing: run 2026-06-03-vendor-sftp-import-schema.sql first (connected to %s).',
      16, 1, @DbName
    );
    RETURN;
  END;

  IF COL_LENGTH('oe.VendorImportJobs', 'LegacyProcessorKey') IS NULL
  BEGIN
    IF @DryRun = 1
    BEGIN
      SELECT N'BLOCKED' AS Status,
        N'Run 2026-06-03-vendor-sftp-import-schema.sql first (LegacyProcessorKey column missing).' AS Message;
      RETURN;
    END;
    RAISERROR(
      N'oe.VendorImportJobs.LegacyProcessorKey missing — schema migration must include LegacyProcessorKey.',
      16, 1
    );
    RETURN;
  END;

  IF @DbName NOT IN (N'allaboard-prod', N'allaboard-testing')
  BEGIN
    RAISERROR(N'Unexpected database %s. Expected allaboard-prod or allaboard-testing.', 16, 1, @DbName);
    RETURN;
  END;

  DECLARE @ActualVendorName NVARCHAR(200);
  SELECT @ActualVendorName = VendorName FROM oe.Vendors WHERE VendorId = @VendorId;
  IF @ActualVendorName IS NULL
  BEGIN
    RAISERROR(N'Vendor not found (check VendorId GUID).', 16, 1);
    RETURN;
  END;
  IF @ActualVendorName <> @ExpectedVendorName
  BEGIN
    RAISERROR(N'Vendor name guard failed: expected %s, got %s.', 16, 1, @ExpectedVendorName, @ActualVendorName);
    RETURN;
  END;

  DECLARE @TenantAlignSha UNIQUEIDENTIFIER = @TenantAlignShaOverride;
  IF @TenantAlignSha IS NULL
    SELECT @TenantAlignSha = TenantId FROM oe.Tenants WHERE Name = N'Align Health SHA';

  IF NOT EXISTS (SELECT 1 FROM oe.Tenants WHERE TenantId = @TenantSharewellHealth AND Name = N'ShareWELL Health')
  BEGIN
    RAISERROR(N'Tenant guard failed: ShareWELL Health tenant id/name mismatch.', 16, 1);
    RETURN;
  END;

  IF NOT EXISTS (SELECT 1 FROM oe.Tenants WHERE TenantId = @TenantAlignHealth AND Name = N'Align Health')
  BEGIN
    RAISERROR(N'Tenant guard failed: Align Health tenant id/name mismatch.', 16, 1);
    RETURN;
  END;

  IF @TenantAlignSha IS NULL
  BEGIN
    RAISERROR(
      N'Align Health SHA tenant not found. Create tenant or set @TenantAlignShaOverride before apply.',
      16, 1
    );
    RETURN;
  END;

  ---------------------------------------------------------------------------
  -- Job definitions (mirrors sharewell-csv-processor function.json schedules)
  ---------------------------------------------------------------------------
  IF OBJECT_ID('tempdb..#SharewellImportJobs') IS NOT NULL DROP TABLE #SharewellImportJobs;
  CREATE TABLE #SharewellImportJobs (
    JobId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    LegacyProcessorKey NVARCHAR(80) NOT NULL,
    SubFolderPath NVARCHAR(500) NOT NULL,
    ArchiveFolder NVARCHAR(255) NOT NULL,
    CronScheduleUtc NVARCHAR(100) NOT NULL,
    FormatSlug NVARCHAR(50) NOT NULL,
    TenantId UNIQUEIDENTIFIER NOT NULL,
    NotifyOnNoFiles BIT NOT NULL
  );

  INSERT INTO #SharewellImportJobs (
    JobId, LegacyProcessorKey, SubFolderPath, ArchiveFolder, CronScheduleUtc, FormatSlug, TenantId, NotifyOnNoFiles
  ) VALUES
    -- CalstarProcessor — omitted (still on sharewell-csv-processor)
    -- ('aaaaaaaa-0002-4000-8000-000000000001', N'CalstarProcessor', N'/Calstar', N'Archive',
    --  N'0 0 5,17 * * *', N'sharewell_calstar', @TenantSharewellHealth, 0),
    -- MPoweringBenefitsProcessor — 8:30 AM & 8:30 PM ET → 1:30 & 13:30 UTC; folder /MBP in deployed code
    ('aaaaaaaa-0002-4000-8000-000000000002', N'MPoweringBenefitsProcessor', N'/MBP', N'Archive',
     N'0 30 1,13 * * *', N'sharewell_mpb', @TenantSharewellHealth, 0),
    -- SummitHealthProcessor — omitted (still on sharewell-csv-processor; verify sharewell_default before enabling)
    -- ('aaaaaaaa-0002-4000-8000-000000000003', N'SummitHealthProcessor', N'/Summit', N'Archive',
    --  N'0 0 2,14 * * *', N'sharewell_default', @TenantSharewellHealth, 0),
    -- AlignHealthSHAProcessor — Python 3:00/15:00 UTC; AllAboard +30 min (dual ingest)
    ('aaaaaaaa-0002-4000-8000-000000000004', N'AlignHealthSHAProcessor', N'/ALIGN/SHA', N'Archive',
     N'0 30 3,15 * * *', N'sharewell_align_sha', @TenantAlignSha, 0),
    -- AlignHealthProcessor — Python 4:00/16:00 UTC; AllAboard +30 min; archive/ per Python
    ('aaaaaaaa-0002-4000-8000-000000000005', N'AlignHealthProcessor', N'/ALIGN', N'archive',
     N'0 30 4,16 * * *', N'sharewell_align', @TenantAlignHealth, 0);
    -- E123AgentProcessor — omitted (ShareWELLPartners DB; not AllAboard eligibility import)
    -- ('aaaaaaaa-0002-4000-8000-000000000006', N'E123AgentProcessor', N'/E123', N'Archive',
    --  N'0 30 2 * * *', N'sharewell_default', @TenantSharewellHealth, 0),
    -- E123MemberProcessor — omitted (PGP pipeline → ShareWELLPartners DB)
    -- ('aaaaaaaa-0002-4000-8000-000000000007', N'E123MemberProcessor', N'/E123', N'Archive',
    --  N'0 0 3 * * *', N'sharewell_default', @TenantSharewellHealth, 0);

  ---------------------------------------------------------------------------
  -- Dry-run preview
  ---------------------------------------------------------------------------
  IF @DryRun = 1
  BEGIN
    SELECT N'DRY RUN — sharewell SFTP import cutover seed' AS Mode, @DbName AS DatabaseName;

    SELECT
      N'SFTP connection (would upsert)' AS Section,
      @ConnectionId AS ConnectionId,
      @VendorId AS VendorId,
      N'Sharewell production SFTP (sharewell-csv-processor)' AS DisplayName,
      @SftpHost AS Host,
      @SftpPort AS Port,
      @SftpUsername AS Username,
      N'password' AS AuthType,
      CAST(NULL AS NVARCHAR(MAX)) AS PasswordEncrypted,
      N'(set via vendor portal after apply)' AS PasswordNote;

    SELECT
      N'Import jobs (would upsert, IsEnabled=0)' AS Section,
      j.JobId,
      j.LegacyProcessorKey,
      t.Name AS TargetTenantName,
      j.SubFolderPath,
      j.ArchiveFolder,
      j.CronScheduleUtc,
      j.FormatSlug,
      j.NotifyOnNoFiles,
      @NotifyEmailsJson AS NotifyEmails
    FROM #SharewellImportJobs j
    INNER JOIN oe.Tenants t ON t.TenantId = j.TenantId
    ORDER BY j.LegacyProcessorKey;

    SELECT
      N'Legacy processors to DISABLE on sharewell-csv-processor after cutover' AS Section,
      LegacyProcessorKey AS AzureFunctionName,
      N'az functionapp function update --name sharewell-csv-processor --function-name '
        + LegacyProcessorKey + N' --disabled true' AS DisableCommandHint
    FROM #SharewellImportJobs
    ORDER BY LegacyProcessorKey;

    -- E123 timers stay on sharewell-csv-processor (not seeded here)
    -- SELECT N'Keep running on sharewell-csv-processor (not in this seed)' AS Section, FunctionName
    -- FROM (VALUES (N'E123AgentProcessor'), (N'E123MemberProcessor')) AS x(FunctionName);

    RETURN;
  END;

  ---------------------------------------------------------------------------
  -- Apply (dynamic SQL so dry-run batch compiles before LegacyProcessorKey exists)
  ---------------------------------------------------------------------------
  DECLARE @ApplySql NVARCHAR(MAX) = N'
BEGIN TRANSACTION;

MERGE oe.VendorSftpConnections AS t
USING (
  SELECT
    @ConnectionId AS ConnectionId,
    @VendorId AS VendorId,
    N''Sharewell production SFTP (sharewell-csv-processor)'' AS DisplayName,
    @SftpHost AS Host,
    @SftpPort AS Port,
    @SftpUsername AS Username,
    N''password'' AS AuthType,
    CAST(NULL AS NVARCHAR(MAX)) AS BaseDirectory,
    CAST(1 AS BIT) AS IsActive
) AS s
ON t.ConnectionId = s.ConnectionId
WHEN MATCHED THEN
  UPDATE SET
    DisplayName = s.DisplayName,
    Host = s.Host,
    Port = s.Port,
    Username = s.Username,
    AuthType = s.AuthType,
    BaseDirectory = s.BaseDirectory,
    IsActive = s.IsActive,
    ModifiedUtc = @Now
WHEN NOT MATCHED THEN
  INSERT (
    ConnectionId, VendorId, DisplayName, Host, Port, Username, AuthType,
    PasswordEncrypted, BaseDirectory, IsActive, CreatedUtc, ModifiedUtc
  ) VALUES (
    s.ConnectionId, s.VendorId, s.DisplayName, s.Host, s.Port, s.Username, s.AuthType,
    NULL, s.BaseDirectory, s.IsActive, @Now, @Now
  );

MERGE oe.VendorImportJobs AS t
USING (
  SELECT
    j.JobId,
    @VendorId AS VendorId,
    @ConnectionId AS ConnectionId,
    j.TenantId,
    j.SubFolderPath,
    j.FormatSlug,
    j.CronScheduleUtc,
    j.ArchiveFolder,
    @NotifyEmailsJson AS NotifyEmails,
    CAST(1 AS BIT) AS NotifyOnSuccess,
    CAST(1 AS BIT) AS NotifyOnFailure,
    j.NotifyOnNoFiles,
    CAST(0 AS BIT) AS IsEnabled,
    CAST(0 AS BIT) AS IsRunning,
    j.LegacyProcessorKey,
    CASE
      WHEN NULLIF(LTRIM(RTRIM(t.Name)), N'') IS NOT NULL AND NULLIF(LTRIM(RTRIM(j.SubFolderPath)), N'') IS NOT NULL
        THEN t.Name + N' · ' + j.SubFolderPath
      WHEN NULLIF(LTRIM(RTRIM(t.Name)), N'') IS NOT NULL THEN t.Name
      ELSE j.LegacyProcessorKey
    END AS JobName
  FROM #SharewellImportJobs j
  INNER JOIN oe.Tenants t ON t.TenantId = j.TenantId
) AS s
ON t.VendorId = s.VendorId AND t.LegacyProcessorKey = s.LegacyProcessorKey
WHEN MATCHED THEN
  UPDATE SET
    ConnectionId = s.ConnectionId,
    TenantId = s.TenantId,
    JobName = s.JobName,
    SubFolderPath = s.SubFolderPath,
    FormatSlug = s.FormatSlug,
    CronScheduleUtc = s.CronScheduleUtc,
    ArchiveFolder = s.ArchiveFolder,
    NotifyEmails = s.NotifyEmails,
    NotifyOnSuccess = s.NotifyOnSuccess,
    NotifyOnFailure = s.NotifyOnFailure,
    NotifyOnNoFiles = s.NotifyOnNoFiles,
    ModifiedUtc = @Now
WHEN NOT MATCHED THEN
  INSERT (
    JobId, VendorId, ConnectionId, TenantId, JobName, SubFolderPath, FormatSlug, CronScheduleUtc,
    ArchiveFolder, NotifyEmails, NotifyOnSuccess, NotifyOnFailure, NotifyOnNoFiles,
    IsEnabled, IsRunning, LegacyProcessorKey, CreatedUtc, ModifiedUtc
  ) VALUES (
    s.JobId, s.VendorId, s.ConnectionId, s.TenantId, s.JobName, s.SubFolderPath, s.FormatSlug, s.CronScheduleUtc,
    s.ArchiveFolder, s.NotifyEmails, s.NotifyOnSuccess, s.NotifyOnFailure, s.NotifyOnNoFiles,
    s.IsEnabled, s.IsRunning, s.LegacyProcessorKey, @Now, @Now
  );

COMMIT TRANSACTION;
';

  EXEC sp_executesql
    @ApplySql,
    N'@Now DATETIME2, @VendorId UNIQUEIDENTIFIER, @ConnectionId UNIQUEIDENTIFIER,
      @SftpHost NVARCHAR(255), @SftpPort INT, @SftpUsername NVARCHAR(150), @NotifyEmailsJson NVARCHAR(MAX)',
    @Now, @VendorId, @ConnectionId, @SftpHost, @SftpPort, @SftpUsername, @NotifyEmailsJson;

  SELECT N'Applied — set SFTP password in vendor portal, then enable jobs one at a time' AS Status;

  EXEC sp_executesql
    N'
    SELECT
      j.JobId,
      j.LegacyProcessorKey,
      t.Name AS TargetTenantName,
      j.SubFolderPath,
      j.IsEnabled
    FROM oe.VendorImportJobs j
    INNER JOIN oe.Tenants t ON t.TenantId = j.TenantId
    WHERE j.VendorId = @VendorId
      AND j.LegacyProcessorKey IS NOT NULL
    ORDER BY j.LegacyProcessorKey;
    ',
    N'@VendorId UNIQUEIDENTIFIER',
    @VendorId;

END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  SELECT ERROR_MESSAGE() AS Error, ERROR_LINE() AS Line;
END CATCH;
