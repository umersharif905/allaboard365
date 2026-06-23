/* =============================================================================
   2026-06-02  Drop the abandoned oe.ShareRequestEmails table
   -----------------------------------------------------------------------------
   Context: the per-share-request email feature (graphEmailService + the orphaned
   EmailLogTab + the per-SR emails endpoints) is being
   superseded by the unified Back Office Email store
   (oe.EmailThreads / oe.EmailMessages / oe.EmailAttachments).
   See docs/superpowers/specs/2026-06-02-back-office-email/design.md

   As of 2026-06-02 the table holds 0 rows in allaboard-testing — nothing to
   migrate. This script removes it.

   SAFETY: dry-run by default. It only PREVIEWS (existence + row count). It will
   NOT drop anything unless you explicitly set @DryRun = 0. Per project DB rules,
   do not execute the write half without confirming the row count first.

   ORDER OF OPERATIONS (do these before @DryRun = 0):
     1. Ship the code change that stops reading oe.ShareRequestEmails
        (historyTimelineService re-pointed; SR emails endpoints removed).
     2. Re-confirm row count is still 0 (or back up rows if any appeared).
     3. Then run this with @DryRun = 0.
   ============================================================================= */

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;   -- <<< leave 1 to preview; set 0 ONLY to actually drop

IF OBJECT_ID('oe.ShareRequestEmails') IS NULL
BEGIN
    PRINT 'oe.ShareRequestEmails does not exist. Nothing to do.';
    RETURN;
END

DECLARE @Rows INT;
SELECT @Rows = COUNT(*) FROM oe.ShareRequestEmails;
PRINT 'oe.ShareRequestEmails exists. Row count = ' + CAST(@Rows AS NVARCHAR(20));

IF @DryRun = 1
BEGIN
    PRINT 'DRY RUN: no changes made. Set @DryRun = 0 to drop the table.';
    -- Show a sample so you can eyeball before any destructive action.
    SELECT TOP (20) * FROM oe.ShareRequestEmails ORDER BY CreatedDate DESC;
    RETURN;
END

/* ---- WRITE PATH (only reached when @DryRun = 0) ---- */
IF @Rows > 0
BEGIN
    RAISERROR('ABORT: oe.ShareRequestEmails is not empty (%d rows). Back up / migrate before dropping.', 16, 1, @Rows);
    RETURN;
END

DROP TABLE oe.ShareRequestEmails;
PRINT 'Dropped oe.ShareRequestEmails.';
