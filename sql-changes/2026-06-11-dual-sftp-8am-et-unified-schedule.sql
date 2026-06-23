/*
  Unified dual SFTP ingest schedule — all four partners run around 8:00 AM / 8:00 PM ET.

  Python (sharewell-csv-processor) — runs first, leaves files on SFTP:
    MPB, Align SHA, Align, Mutual Health  →  0 30 0,12 * * *  (7:30 AM / 7:30 PM ET)

  AllAboard (this script) — imports + archives ~30 min later:
    All four jobs  →  0 0 1,13 * * *  (8:00 AM / 8:00 PM ET)

  Deploy sharewell-csv-processor after applying (function.json timers updated in repo).

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-11-dual-sftp-8am-et-unified-schedule.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @CronAllAboard NVARCHAR(100) = N'0 0 1,13 * * *';

DECLARE @JobMpb UNIQUEIDENTIFIER = 'aaaaaaaa-0002-4000-8000-000000000002';
DECLARE @JobAlignSha UNIQUEIDENTIFIER = 'aaaaaaaa-0002-4000-8000-000000000004';
DECLARE @JobAlignHealth UNIQUEIDENTIFIER = 'aaaaaaaa-0002-4000-8000-000000000005';
DECLARE @JobMutualHealth UNIQUEIDENTIFIER = '8AC88275-6EFA-4A20-B1D5-4D13C7FD6313';

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — unified 8 AM ET dual SFTP ingest schedule' AS Mode, DB_NAME() AS DatabaseName;

  SELECT
    j.JobId,
    j.JobName,
    j.LegacyProcessorKey,
    j.SubFolderPath,
    j.CronScheduleUtc AS CurrentCron,
    @CronAllAboard AS NewCron,
    j.IsEnabled
  FROM oe.VendorImportJobs j
  WHERE j.JobId IN (@JobMpb, @JobAlignSha, @JobAlignHealth, @JobMutualHealth)
  ORDER BY j.JobName;

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  UPDATE oe.VendorImportJobs
  SET
    CronScheduleUtc = @CronAllAboard,
    ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId IN (@JobMpb, @JobAlignSha, @JobAlignHealth, @JobMutualHealth);

  COMMIT TRANSACTION;

  SELECT N'Applied unified 8 AM ET dual SFTP ingest schedule' AS Status,
         @@ROWCOUNT AS RowsTouched;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
