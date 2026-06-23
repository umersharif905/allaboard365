-- Migration: Add MemberOutcomeNote to oe.ShareRequests
-- Date: 2026-06-09
-- Purpose: Member-facing closing explanation entered by the care team when a
--          share request reaches a terminal status (Completed / Denied /
--          Withdrawn). Shown on the member dashboard. Distinct from the internal
--          NextSteps / GeneralNotes / EligibilityNotes fields.

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @ColExists BIT = CASE WHEN COL_LENGTH('oe.ShareRequests', 'MemberOutcomeNote') IS NOT NULL THEN 1 ELSE 0 END;

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Preview of changes:' AS [Status];
        IF @ColExists = 0
            SELECT 'Column oe.ShareRequests.MemberOutcomeNote does not exist yet — will be added (NVARCHAR(MAX) NULL)' AS [Action];
        ELSE
            SELECT 'Column oe.ShareRequests.MemberOutcomeNote already exists — no change' AS [Action];

        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF @ColExists = 0
    BEGIN
        ALTER TABLE oe.ShareRequests ADD MemberOutcomeNote NVARCHAR(MAX) NULL;
    END

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH;
