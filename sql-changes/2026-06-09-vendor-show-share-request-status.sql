-- Migration: Add ShowShareRequestStatusToMembers to oe.Vendors
-- Date: 2026-06-09
-- Purpose: Per-vendor (global) gating flag controlling whether members see the
--          sharing-request status progress bar in the member portal.

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @ColExists BIT = CASE WHEN COL_LENGTH('oe.Vendors', 'ShowShareRequestStatusToMembers') IS NOT NULL THEN 1 ELSE 0 END;

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Preview of changes:' AS [Status];

        IF @ColExists = 0
        BEGIN
            SELECT 'Column oe.Vendors.ShowShareRequestStatusToMembers does not exist yet — will be added (BIT NOT NULL DEFAULT 0)' AS [Action];
        END
        ELSE
        BEGIN
            SELECT 'Column oe.Vendors.ShowShareRequestStatusToMembers already exists — no change' AS [Action];
        END;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF @ColExists = 0
    BEGIN
        ALTER TABLE oe.Vendors
        ADD ShowShareRequestStatusToMembers BIT NOT NULL
            CONSTRAINT DF_Vendors_ShowShareRequestStatusToMembers DEFAULT 0;
    END

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH;
