/*
  2026-05-30-drop-share-request-fap.sql
  Billing rework — retire the Share Request FAP (Financial Assistance Program)
  feature. The Finances tab FAP sub-tab, its routes, and its service were
  removed in code; financial assistance is now recorded via the 'Financial Aid'
  ledger transaction type.

  This drops oe.ShareRequestFinancialApplications.

  IMPORTANT: this is unrelated to the PROVIDER FAP subsystem
  (services/fapService.js + routes/me/vendor/fap.js + its own tables), which is
  NOT touched.

  DESTRUCTIVE: dropping the table deletes all Share Request FAP records. This
  script is dry-run first and prints what would be lost. Review the row count
  and the archive step, then set @DryRun = 0 to execute.

  Recommended: run the archive (step 1) on prod regardless, so the data is
  recoverable, before dropping.

  Run against: allaboard-testing first, then prod after verification + sign-off.
*/

SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;   -- <<< set to 0 to actually archive + drop

-------------------------------------------------------------------------------
-- 0. Preview what exists
-------------------------------------------------------------------------------
IF OBJECT_ID('oe.ShareRequestFinancialApplications', 'U') IS NULL
BEGIN
    PRINT 'oe.ShareRequestFinancialApplications does not exist — nothing to do.';
    RETURN;
END

DECLARE @rows INT;
SELECT @rows = COUNT(*) FROM oe.ShareRequestFinancialApplications;
PRINT CONCAT('oe.ShareRequestFinancialApplications row count: ', @rows);
SELECT TOP 50 * FROM oe.ShareRequestFinancialApplications ORDER BY CreatedDate DESC;

-------------------------------------------------------------------------------
-- 1. Archive into a timestamped backup table (only if there is data)
-------------------------------------------------------------------------------
IF @DryRun = 0
BEGIN
    IF @rows > 0
    BEGIN
        IF OBJECT_ID('oe._archive_ShareRequestFinancialApplications_20260530', 'U') IS NULL
        BEGIN
            SELECT * INTO oe._archive_ShareRequestFinancialApplications_20260530
            FROM oe.ShareRequestFinancialApplications;
            PRINT CONCAT('Archived ', @@ROWCOUNT, ' rows to oe._archive_ShareRequestFinancialApplications_20260530');
        END
        ELSE
            PRINT 'Archive table already exists — skipping archive (review before dropping).';
    END
    ELSE
        PRINT 'No rows to archive.';

    -------------------------------------------------------------------------------
    -- 2. Drop the table
    -------------------------------------------------------------------------------
    DROP TABLE oe.ShareRequestFinancialApplications;
    PRINT 'Dropped oe.ShareRequestFinancialApplications';
END
ELSE
    PRINT '[DryRun] Would archive to oe._archive_ShareRequestFinancialApplications_20260530 then DROP oe.ShareRequestFinancialApplications. Review the rows above, then set @DryRun = 0.';
