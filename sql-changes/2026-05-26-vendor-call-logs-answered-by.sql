/*
 * Migration: 2026-05-26 — Add AnsweredBy classification column to VendorCallLogs
 *
 * WHY: Many Zoom Phone calls are handled entirely by an Auto Receptionist (AI)
 * or routed to a call queue without reaching a human. Today these show as a
 * blank "Agent" column, indistinguishable from "agent not mapped". This column
 * lets us label AR-handled calls explicitly and surface accurate stats.
 *
 * Values:
 *   'User'             — answered by a real Zoom user (has AgentUserId, hopefully)
 *   'AutoReceptionist' — answered by IVR / Zoom Virtual Agent / auto receptionist
 *   'CallQueue'        — landed in a queue (may also have downstream User row)
 *   'CommonArea'       — common-area phone
 *   'SharedLineGroup'  — shared line group
 *   NULL               — undetermined / legacy data
 *
 * Idempotent. Defaults to DRY-RUN: shows what would change without committing.
 * Set @DryRun = 0 to apply.
 */

SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID(N'oe.VendorCallLogs') AND name = N'AnsweredBy'
    )
    BEGIN
        PRINT 'Adding oe.VendorCallLogs.AnsweredBy NVARCHAR(40) NULL';
        ALTER TABLE oe.VendorCallLogs
            ADD AnsweredBy NVARCHAR(40) NULL;
    END
    ELSE
    BEGIN
        PRINT 'Column oe.VendorCallLogs.AnsweredBy already exists — no change';
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
