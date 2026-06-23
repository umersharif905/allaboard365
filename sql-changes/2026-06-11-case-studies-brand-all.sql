-- 2026-06-11 — Case studies: shared 'All' brand bucket
-- =============================================
-- Adds 'All' to the oe.CaseStudies Brand CHECK constraint so a single case study
-- can be shown on every brand's public site (ShareWELL + MightyWELL) instead of
-- exactly one. The public endpoint (caseStudyService.listPublished) returns rows
-- where Brand = <requested brand> OR Brand = 'All', and createCaseStudy now
-- defaults new rows to 'All'.
--
-- Optional: also retags currently-published case studies to 'All' so the launch
-- set appears on both sites (set @RetagPublished = 1).
--
-- Applied to testing + prod 2026-06-11.
--
-- SAFETY: @DryRun = 1 by default (preview only). Set @DryRun = 0 to apply.
-- =============================================
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;          -- 1 = preview only, 0 = APPLY
DECLARE @RetagPublished BIT = 1;  -- 1 = set existing published rows to Brand 'All'

IF @DryRun = 1
BEGIN
    PRINT '=== DRY RUN — no changes written. ===';
    SELECT definition AS current_brand_check
    FROM sys.check_constraints WHERE name = 'CK_CaseStudies_Brand';
    SELECT Brand, COUNT(*) AS n FROM oe.CaseStudies GROUP BY Brand;
    RETURN;
END

BEGIN TRAN;
    IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_CaseStudies_Brand')
        ALTER TABLE oe.CaseStudies DROP CONSTRAINT CK_CaseStudies_Brand;
    ALTER TABLE oe.CaseStudies WITH CHECK
        ADD CONSTRAINT CK_CaseStudies_Brand CHECK ([Brand] IN ('ShareWELL', 'MightyWELL', 'All'));

    IF @RetagPublished = 1
        UPDATE oe.CaseStudies SET Brand = 'All' WHERE IsPublished = 1 AND Brand <> 'All';
COMMIT TRAN;

PRINT '=== APPLIED. ===';
SELECT Brand, COUNT(*) AS n FROM oe.CaseStudies GROUP BY Brand;
