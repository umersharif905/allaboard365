-- 2026-06-10-sr-coding-backfill.sql
-- Coding revamp, migration 1 of 2 (backfill + soft-retire). Idempotent.
-- DOES NOT DROP COLUMNS. The follow-up 2026-06-10-sr-drop-legacy-coding-columns.sql
-- physically drops them after prod verification.
--
-- DEPLOY ORDERING (required): apply this with @DryRun = 0 BEFORE (or together with)
-- the app deploy. The app's createShareRequest now omits the legacy NOT NULL
-- RequestType column and relies on the DEFAULT 'Medical' this migration adds;
-- deploying the app first would break share-request creation.
--
-- Run with @DryRun = 1 first (default): prints the rows that WOULD change.
-- Set @DryRun = 0 to apply.
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

-- 1) Backfill ShareRequestDiagnoses from the singular DiagnosisCode column.
--    Only rows with a real CODE are migrated. Code-less DiagnosisDescription
--    values are narrative-derived (the public form never captured a diagnosis)
--    and are intentionally NOT imported as diagnoses.
;WITH src AS (
    SELECT sr.ShareRequestId, sr.DiagnosisCode, sr.DiagnosisDescription
    FROM oe.ShareRequests sr
    WHERE NULLIF(LTRIM(RTRIM(sr.DiagnosisCode)), '') IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM oe.ShareRequestDiagnoses d
          WHERE d.ShareRequestId = sr.ShareRequestId
      )
)
SELECT 'WOULD INSERT diagnosis' AS Action, ShareRequestId, DiagnosisCode, DiagnosisDescription
FROM src;

IF @DryRun = 0
BEGIN
    BEGIN TRAN;

    INSERT INTO oe.ShareRequestDiagnoses
        (DiagnosisId, ShareRequestId, ICD10Code, Description, IsPrimary, SortOrder, CreatedDate, CreatedBy)
    SELECT NEWID(), sr.ShareRequestId,
           UPPER(LTRIM(RTRIM(sr.DiagnosisCode))),
           NULLIF(LTRIM(RTRIM(sr.DiagnosisDescription)), ''),
           1, 0, GETDATE(), NULL
    FROM oe.ShareRequests sr
    WHERE NULLIF(LTRIM(RTRIM(sr.DiagnosisCode)), '') IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM oe.ShareRequestDiagnoses d
          WHERE d.ShareRequestId = sr.ShareRequestId
      );

    -- 2) Soft-retire RequestType: a DEFAULT lets the app stop supplying it
    --    without violating the existing NOT NULL. Not dropped here.
    IF NOT EXISTS (
        SELECT 1 FROM sys.default_constraints
        WHERE name = 'DF_ShareRequests_RequestType'
    )
    BEGIN
        ALTER TABLE oe.ShareRequests
            ADD CONSTRAINT DF_ShareRequests_RequestType DEFAULT 'Medical' FOR RequestType;
    END

    COMMIT TRAN;
    PRINT 'Backfill applied.';
END
ELSE
    PRINT 'DRY RUN — no changes applied. Set @DryRun = 0 to apply.';
