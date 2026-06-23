-- =====================================================================
-- Migration: 2026-05-28-creates-case-on-submit.sql
-- Branch:    fix/backoffice/combining-preventative-and-SR-forms
-- Author:    Amar Vugdalic (via Claude Code)
-- Purpose:
--   Add the supporting columns that let a public-form template auto-create
--   a Case (in addition to / instead of a ShareRequest) when it's submitted.
--   Used by the combined "Routine/Preventative vs Surgery/ER/Major" form
--   pattern shipping in this branch, and by any future form that wants the
--   same primitive.
--
-- Tables touched (additive only):
--   1. oe.PublicFormTemplates
--        + CreatesCaseOnSubmit  BIT NOT NULL DEFAULT 0
--          Parallel of CreatesShareRequestOnSubmit. When true, a submission
--          MAY auto-create a Case (the in-app router decides based on the
--          A/B prescreen answer when one is present). Defaulting to 0
--          preserves current behavior for every existing template.
--
--   2. oe.PublicFormSubmissions
--        + LinkedCaseId         UNIQUEIDENTIFIER NULL
--          Parallel of LinkedShareRequestId / ShareRequestId. Populated by
--          publicFormShareLinkService.createCaseFromSubmission with the
--          resulting Case's id, so the submission row can deep-link.
--
--   3. oe.ShareRequests
--        + MemberStatedUA       NVARCHAR(50) NULL
--          The Unshared Amount tier the member entered on the public form
--          (e.g. "1500", "2500", "5000"). Captured at SR auto-create from
--          the form payload so the back-office team can compare it against
--          the member's current plan UA without having to crack open the
--          encrypted submission payload. Plain text; no normalization.
--
-- Safety:
--   * Both columns are additive. No existing row is modified.
--   * Defaults preserve current behavior on every existing template /
--     submission row.
--   * Backfill is not required; legacy rows simply read 0 / NULL.
--   * No indexes added — query patterns can stay table-scan until volume
--     warrants one.
--
-- Dry-run mode:
--   By default this script runs in dry-run mode and only PRINTs what it
--   would do. To actually apply the migration, set @DryRun = 0 below.
--
-- Rollback:
--   Both columns are safe to drop. The supporting application code reads
--   them defensively (treats NULL/missing as 0/NULL), so a roll-back of
--   the application alone is fine without dropping the columns. If a full
--   rollback is desired:
--     ALTER TABLE oe.PublicFormTemplates  DROP CONSTRAINT DF_PublicFormTemplates_CreatesCaseOnSubmit;
--     ALTER TABLE oe.PublicFormTemplates  DROP COLUMN CreatesCaseOnSubmit;
--     ALTER TABLE oe.PublicFormSubmissions DROP COLUMN LinkedCaseId;
-- =====================================================================

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;   -- 1 = preview, 0 = apply

IF @DryRun = 1
BEGIN
    PRINT '=== DRY RUN — no changes will be applied. ===';
    PRINT 'Would add column oe.PublicFormTemplates.CreatesCaseOnSubmit  (BIT NOT NULL DEFAULT 0)';
    PRINT 'Would add column oe.PublicFormSubmissions.LinkedCaseId       (UNIQUEIDENTIFIER NULL)';
    PRINT 'Would add column oe.ShareRequests.MemberStatedUA             (NVARCHAR(50) NULL)';
    PRINT 'Set @DryRun = 0 in this script and re-run to apply.';
END
ELSE
BEGIN
    PRINT '=== APPLYING migration 2026-05-28-creates-case-on-submit ===';

    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE Name = N'CreatesCaseOnSubmit'
          AND Object_ID = Object_ID(N'oe.PublicFormTemplates')
    )
    BEGIN
        ALTER TABLE oe.PublicFormTemplates
            ADD CreatesCaseOnSubmit BIT NOT NULL
                CONSTRAINT DF_PublicFormTemplates_CreatesCaseOnSubmit DEFAULT 0;
        PRINT 'Added oe.PublicFormTemplates.CreatesCaseOnSubmit';
    END
    ELSE
    BEGIN
        PRINT 'oe.PublicFormTemplates.CreatesCaseOnSubmit already present — skipped.';
    END

    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE Name = N'LinkedCaseId'
          AND Object_ID = Object_ID(N'oe.PublicFormSubmissions')
    )
    BEGIN
        ALTER TABLE oe.PublicFormSubmissions
            ADD LinkedCaseId UNIQUEIDENTIFIER NULL;
        PRINT 'Added oe.PublicFormSubmissions.LinkedCaseId';
    END
    ELSE
    BEGIN
        PRINT 'oe.PublicFormSubmissions.LinkedCaseId already present — skipped.';
    END

    IF NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE Name = N'MemberStatedUA'
          AND Object_ID = Object_ID(N'oe.ShareRequests')
    )
    BEGIN
        ALTER TABLE oe.ShareRequests
            ADD MemberStatedUA NVARCHAR(50) NULL;
        PRINT 'Added oe.ShareRequests.MemberStatedUA';
    END
    ELSE
    BEGIN
        PRINT 'oe.ShareRequests.MemberStatedUA already present — skipped.';
    END

    PRINT '=== Done. ===';
END
