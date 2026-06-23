/*
 * Migration: 2026-05-26 — Add ZoomAISummary column to VendorCallLogs
 *
 * WHY: Zoom's native AI Call Summary (April 2025 webhook
 * `phone.ai_call_summary_changed`) is a separate signal from our own OpenAI
 * summary stored in AISummary. Keep both so vendors have two perspectives
 * and a fallback when one fails.
 *
 * Idempotent. DRY-RUN default. Set @DryRun = 0 to apply.
 */

SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID(N'oe.VendorCallLogs') AND name = N'ZoomAISummary'
    )
    BEGIN
        PRINT 'Adding oe.VendorCallLogs.ZoomAISummary NVARCHAR(MAX) NULL';
        ALTER TABLE oe.VendorCallLogs ADD ZoomAISummary NVARCHAR(MAX) NULL;
        PRINT 'Adding oe.VendorCallLogs.ZoomAISummaryReceivedAt DATETIME2 NULL';
        ALTER TABLE oe.VendorCallLogs ADD ZoomAISummaryReceivedAt DATETIME2 NULL;
    END
    ELSE
    BEGIN
        PRINT 'ZoomAISummary already exists — no change';
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
