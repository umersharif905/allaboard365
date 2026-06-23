/*
  Dual SFTP ingest: sharewell-csv-processor (ShareWELL DB) runs first; AllAboard imports same
  files ~30 minutes later and archives them.

  Python timers (unchanged on function app):
    AlignHealthSHAProcessor  0 0 3,15 * * *  → 10 AM / 10 PM ET
    AlignHealthProcessor     0 0 4,16 * * *  → 11 AM / 11 PM ET

  AllAboard jobs (this script):
    Align SHA  0 30 3,15 * * *
    Align      0 30 4,16 * * *

  Also sets Align SHA FormatSlug to sharewell_align_sha (full eligibility).

  Deploy sharewell-csv-processor with ALIGN_SKIP_SFTP_ARCHIVE=true (default) so Python does not archive.

  Dry-run:
    cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-08-align-dual-sftp-ingest-schedule.sql
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @JobAlignSha UNIQUEIDENTIFIER = 'aaaaaaaa-0002-4000-8000-000000000004';
DECLARE @JobAlignHealth UNIQUEIDENTIFIER = 'aaaaaaaa-0002-4000-8000-000000000005';

DECLARE @CronAlignSha NVARCHAR(100) = N'0 30 3,15 * * *';
DECLARE @CronAlignHealth NVARCHAR(100) = N'0 30 4,16 * * *';
DECLARE @FormatAlignSha NVARCHAR(50) = N'sharewell_align_sha';

IF @DryRun = 1
BEGIN
  SELECT N'DRY RUN — align dual SFTP ingest schedule' AS Mode, DB_NAME() AS DatabaseName;

  SELECT
    j.JobId,
    j.LegacyProcessorKey,
    j.SubFolderPath,
    j.CronScheduleUtc AS CurrentCron,
    CASE j.JobId
      WHEN @JobAlignSha THEN @CronAlignSha
      WHEN @JobAlignHealth THEN @CronAlignHealth
      ELSE j.CronScheduleUtc
    END AS NewCron,
    j.FormatSlug AS CurrentFormatSlug,
    CASE j.JobId WHEN @JobAlignSha THEN @FormatAlignSha ELSE j.FormatSlug END AS NewFormatSlug
  FROM oe.VendorImportJobs j
  WHERE j.JobId IN (@JobAlignSha, @JobAlignHealth);

  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  UPDATE oe.VendorImportJobs
  SET
    CronScheduleUtc = @CronAlignSha,
    FormatSlug = @FormatAlignSha,
    ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId = @JobAlignSha;

  UPDATE oe.VendorImportJobs
  SET
    CronScheduleUtc = @CronAlignHealth,
    ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId = @JobAlignHealth;

  -- Dual ingest: AllAboard runs after Python; both need jobs enabled.
  UPDATE oe.VendorImportJobs
  SET IsEnabled = 1, ModifiedUtc = SYSUTCDATETIME()
  WHERE JobId IN (@JobAlignSha, @JobAlignHealth) AND IsEnabled = 0;

  COMMIT TRANSACTION;

  SELECT N'Applied align dual SFTP ingest schedule' AS Status,
         @@ROWCOUNT AS RowsTouched;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(@ErrMsg, 16, 1);
END CATCH;
