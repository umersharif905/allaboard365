-- 2026-06-10-sr-drop-legacy-coding-columns.sql
-- Coding revamp, migration 2 of 2. RUN ONLY AFTER the app no longer reads/writes
-- these columns (this PR) is deployed AND verified in prod.
-- RequestType and SubType are intentionally KEPT — RequestType is soft-retired
-- with a default; SubType still holds real per-request data shown in the UI.
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

SELECT 'WOULD DROP columns DiagnosisCode, DiagnosisDescription on oe.ShareRequests' AS Action;

IF @DryRun = 0
BEGIN
    IF COL_LENGTH('oe.ShareRequests', 'DiagnosisCode') IS NOT NULL
        ALTER TABLE oe.ShareRequests DROP COLUMN DiagnosisCode;
    IF COL_LENGTH('oe.ShareRequests', 'DiagnosisDescription') IS NOT NULL
        ALTER TABLE oe.ShareRequests DROP COLUMN DiagnosisDescription;
    PRINT 'Legacy coding columns dropped.';
END
ELSE
    PRINT 'DRY RUN — no changes applied.';
