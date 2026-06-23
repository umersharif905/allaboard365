/*
  Dual SFTP ingest for MPowering Benefits:
    sharewell-csv-processor (ShareWELL DB) runs first and leaves files on /MBP
    AllAboard imports same files ~30 minutes later and archives them.

  Python timer (unchanged on function app):
    MPoweringBenefitsProcessor  0 30 1,13 * * *  → 8:30 AM / 8:30 PM ET

  AllAboard job (this script):
    MPoweringBenefitsProcessor  0 0 2,14 * * *   → 9:00 AM / 9:00 PM ET

  Deploy sharewell-csv-processor with MPB_SKIP_SFTP_ARCHIVE=true (default) so Python does not archive.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-10-mpb-dual-sftp-ingest-schedule.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @JobMpb UNIQUEIDENTIFIER = 'aaaaaaaa-0002-4000-8000-000000000002';
DECLARE @CronMpb NVARCHAR(100) = N'0 0 2,14 * * *';

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — MPB dual SFTP ingest schedule' AS Mode, DB_NAME() AS DatabaseName;

  SELECT
    j.JobId,
    j.LegacyProcessorKey,
    j.SubFolderPath,
    j.ArchiveFolder,
    j.CronScheduleUtc AS CurrentCron,
    @CronMpb AS NewCron,
    j.FormatSlug,
    j.IsEnabled AS CurrentIsEnabled,
    CAST(1 AS BIT) AS NewIsEnabled
  FROM oe.VendorImportJobs j
  WHERE j.JobId = @JobMpb;

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  UPDATE oe.VendorImportJobs
  SET
    CronScheduleUtc = @CronMpb,
    ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId = @JobMpb;

  UPDATE oe.VendorImportJobs
  SET IsEnabled = 1, ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId = @JobMpb AND IsEnabled = 0;

  COMMIT TRANSACTION;

  SELECT N'Applied MPB dual SFTP ingest schedule' AS Status,
         @@ROWCOUNT AS RowsTouched;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
