/*
  Dual SFTP ingest for Mutual Health (Lyric):
    sharewell-csv-processor MutualHealthProcessor runs first on /LYRIC
    AllAboard imports same files ~30 minutes later and archives them.

  Python timer (deploy sharewell-csv-processor):
    MutualHealthProcessor  0 30 4,16 * * *  → 11:30 PM / 11:30 AM ET

  AllAboard job (already configured in vendor portal):
    Mutual Health  0 0 5,17 * * *           → 12:00 AM / 12:00 PM ET

  Deploy with LYRIC_SKIP_SFTP_ARCHIVE=true (default) so Python does not archive.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-10-mutual-health-dual-sftp-ingest-schedule.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @JobMutualHealth UNIQUEIDENTIFIER = '8AC88275-6EFA-4A20-B1D5-4D13C7FD6313';
DECLARE @CronAllAboard NVARCHAR(100) = N'0 0 5,17 * * *';
DECLARE @LegacyKey NVARCHAR(80) = N'MutualHealthProcessor';

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — Mutual Health dual SFTP ingest schedule' AS Mode, DB_NAME() AS DatabaseName;

  SELECT
    j.JobId,
    j.JobName,
    j.LegacyProcessorKey AS CurrentLegacyKey,
    @LegacyKey AS NewLegacyKey,
    j.SubFolderPath,
    j.CronScheduleUtc AS CurrentCron,
    @CronAllAboard AS ExpectedAllAboardCron,
    j.FormatSlug,
    j.IsEnabled AS CurrentIsEnabled,
    CAST(1 AS BIT) AS NewIsEnabled
  FROM oe.VendorImportJobs j
  WHERE j.JobId = @JobMutualHealth;

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  UPDATE oe.VendorImportJobs
  SET
    LegacyProcessorKey = @LegacyKey,
    CronScheduleUtc = @CronAllAboard,
    ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId = @JobMutualHealth;

  UPDATE oe.VendorImportJobs
  SET IsEnabled = 1, ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId = @JobMutualHealth AND IsEnabled = 0;

  COMMIT TRANSACTION;

  SELECT N'Applied Mutual Health dual SFTP ingest schedule' AS Status,
         @@ROWCOUNT AS RowsTouched;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
