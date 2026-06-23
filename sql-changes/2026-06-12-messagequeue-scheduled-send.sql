-- Migration: Add ScheduledSendDate to oe.MessageQueue for deferred billing/payment notifications
-- Date: 2026-06-12
-- Author: Jeremy Francis

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - column preview' AS [Status];

        IF COL_LENGTH('oe.MessageQueue', 'ScheduledSendDate') IS NULL
            SELECT 'Would ADD oe.MessageQueue.ScheduledSendDate datetime2 NULL' AS Action;
        ELSE
            SELECT 'oe.MessageQueue.ScheduledSendDate already exists' AS Action;

        -- Static SQL only references columns that exist today (ScheduledSendDate validated at compile time).
        SELECT TOP 5 MessageId, Status, CreatedDate
        FROM oe.MessageQueue
        ORDER BY CreatedDate DESC;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF COL_LENGTH('oe.MessageQueue', 'ScheduledSendDate') IS NULL
    BEGIN
        ALTER TABLE oe.MessageQueue
        ADD ScheduledSendDate datetime2 NULL;
    END

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
