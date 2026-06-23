/*
 * Migration: 2026-05-26 — Add Notes column to oe.Encounters
 *
 * WHY: Notes from the call detail panel currently save to VendorCallLogs.CallNotes
 * only. Encounters are the durable record of a conversation — notes should live
 * on the encounter so they survive even if the call log row is archived, and so
 * the encounter detail page can show/edit them.
 *
 * Idempotent. DRY-RUN default. Set @DryRun = 0 to apply.
 */

SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID(N'oe.Encounters') AND name = N'Notes'
    )
    BEGIN
        PRINT 'Adding oe.Encounters.Notes NVARCHAR(MAX) NULL';
        ALTER TABLE oe.Encounters ADD Notes NVARCHAR(MAX) NULL;
    END
    ELSE
    BEGIN
        PRINT 'oe.Encounters.Notes already exists — no change';
    END

    IF @DryRun = 1
    BEGIN
        PRINT 'DRY RUN — rolling back. Set @DryRun = 0 to apply.';
        ROLLBACK TRANSACTION;
    END
    ELSE
    BEGIN
        PRINT 'APPLY — committing.';
        COMMIT TRANSACTION;
    END
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
