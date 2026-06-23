-- =====================================================================
-- Migration: 2026-05-28-sr-editable-form-fields.sql
-- Branch:    fix/backoffice/combining-preventative-and-SR-forms
-- Author:    Amar Vugdalic (via Claude Code)
-- Purpose:
--   Add the editable Share-Request fields that capture the structured
--   clinical/event data submitted on the public form (Claude's Form
--   Copy and its eventual descendants), separated from the form
--   submission itself.
--
--   Rationale: today the form submission is the only place this data
--   lives, and editing the submission would rewrite the member's
--   answers (the form must stay as the source of truth of what the
--   member actually wrote). By holding a parallel, mutable copy on
--   the ShareRequest, the back-office team can correct typos / NPI
--   errors / wrong dates without touching the original submission —
--   divergence between the two is visible and auditable.
--
--   Auto-population happens at SR auto-create time:
--   publicFormShareLinkService.linkSubmissionToShareWorkflow reads
--   the submission payload, finds the matching form-field values for
--   whichever branch the member took, and writes them into the new
--   columns.
--
-- Tables touched (additive only):
--   1. oe.ShareRequests
--        + ProcedureName            NVARCHAR(500)  NULL
--          From form fields surg_procedure / post_procedure.
--          Free-text "What surgery?" answer plus optional CPT code.
--
--        + EventNarrative           NVARCHAR(MAX)  NULL
--          From surg_description / post_description / mat_description /
--          other_description / er_reason. Long-form narrative of what
--          happened. (Note: DiagnosisDescription is kept distinct — it
--          remains the short coded diagnosis text the back office uses
--          for review; EventNarrative is the member's story.)
--
--        + SymptomsBeganDate        DATE           NULL
--          From req_symptoms_began.
--
--        + IsNewCondition           NVARCHAR(20)   NULL
--          From req_is_new_condition. Stored as the raw form value
--          ("yes" / "no" today) — the back office may correct.
--
--        + OtherInsurance           NVARCHAR(50)   NULL
--          From req_other_insurance.
--
--        + WouldSwitchDoctor        BIT            NULL
--          From surg_switch_doctor (upcoming-surgery branch only).
--          "yes" → 1, "no" → 0, anything else / missing → NULL.
--
--        + ErCharityCareApplied     NVARCHAR(20)   NULL
--          From er_fa_applied (ER branch only). Raw form value.
--
--        + MaternityDeliveryStatus  NVARCHAR(20)   NULL
--          From mat_delivery_status (maternity branch only).
--
--        + SurgeonInNetwork          BIT            NULL
--          From surg_in_network (upcoming-surgery branch). The member's
--          claim about whether the surgeon is in-network on this SR.
--          "yes" → 1, "no" → 0, anything else / missing → NULL.
--
--        + PatientRelationToPrimary  NVARCHAR(50)   NULL
--          From the form's Relation-to-Primary-Member select (currently
--          field id `field_mpe6t9kq14t1e73ol`). Captured per-SR as
--          editable text so the back office can correct the member's
--          answer without touching their household enrollment record.
--
--   2. oe.Providers
--        + TaxId                    NVARCHAR(50)   NULL
--          Persists the TIN/EIN the member supplied via the form's
--          *_tax_id text fields (surg_tax_id, post_tax_id, er_tax_id,
--          mat_tax_id). Written at auto-create only when the matching
--          Providers row's TaxId is NULL — form text never overwrites
--          a back-office-verified value.
--
--        (The Fax column already exists on this table — req_pcp_fax is
--        written to the linked PCP provider's Fax field using the same
--        NULL-only fill rule. No new column required.)
--
-- Safety:
--   * Both tables get additive nullable columns only — no row
--     mutations, no default backfill, no constraint changes.
--   * Safe under live traffic on production.
--   * `SELECT *` SR-detail reads pick up the new columns automatically.
--   * Legacy SRs (created before this migration) simply read NULL
--     for every new column; no backfill is planned.
--
-- Dry-run mode:
--   `@DryRun = 1` (default) PRINTs what would change. Set to 0 to
--   apply. Each ALTER TABLE is guarded with IF NOT EXISTS so the
--   migration is idempotent and safe to re-run.
--
-- Rollback:
--   Each new column is safe to drop after rolling the application
--   back. There are no constraints to release first:
--     ALTER TABLE oe.ShareRequests DROP COLUMN ProcedureName, EventNarrative,
--       SymptomsBeganDate, IsNewCondition, OtherInsurance, WouldSwitchDoctor,
--       ErCharityCareApplied, MaternityDeliveryStatus;
--     ALTER TABLE oe.Providers DROP COLUMN TaxId;
--
-- Related migrations on this branch:
--   * 2026-05-28-creates-case-on-submit.sql — adds CreatesCaseOnSubmit,
--     LinkedCaseId, MemberStatedUA. Both migrations must be applied to
--     production for the combined-form work to function end-to-end.
-- =====================================================================

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;   -- 1 = preview, 0 = apply

IF @DryRun = 1
BEGIN
    PRINT '=== DRY RUN — no changes will be applied. ===';
    PRINT 'Would add column oe.ShareRequests.ProcedureName            (NVARCHAR(500) NULL)';
    PRINT 'Would add column oe.ShareRequests.EventNarrative           (NVARCHAR(MAX)  NULL)';
    PRINT 'Would add column oe.ShareRequests.SymptomsBeganDate        (DATE           NULL)';
    PRINT 'Would add column oe.ShareRequests.IsNewCondition           (NVARCHAR(20)   NULL)';
    PRINT 'Would add column oe.ShareRequests.OtherInsurance           (NVARCHAR(50)   NULL)';
    PRINT 'Would add column oe.ShareRequests.WouldSwitchDoctor        (BIT            NULL)';
    PRINT 'Would add column oe.ShareRequests.ErCharityCareApplied     (NVARCHAR(20)   NULL)';
    PRINT 'Would add column oe.ShareRequests.MaternityDeliveryStatus  (NVARCHAR(20)   NULL)';
    PRINT 'Would add column oe.ShareRequests.SurgeonInNetwork         (BIT            NULL)';
    PRINT 'Would add column oe.ShareRequests.PatientRelationToPrimary (NVARCHAR(50)   NULL)';
    PRINT 'Would add column oe.Providers.TaxId                        (NVARCHAR(50)   NULL)';
    PRINT 'Set @DryRun = 0 in this script and re-run to apply.';
END
ELSE
BEGIN
    PRINT '=== APPLYING migration 2026-05-28-sr-editable-form-fields ===';

    -- oe.ShareRequests additions ---------------------------------------

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'ProcedureName' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD ProcedureName NVARCHAR(500) NULL;
        PRINT 'Added oe.ShareRequests.ProcedureName';
    END ELSE PRINT 'oe.ShareRequests.ProcedureName already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'EventNarrative' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD EventNarrative NVARCHAR(MAX) NULL;
        PRINT 'Added oe.ShareRequests.EventNarrative';
    END ELSE PRINT 'oe.ShareRequests.EventNarrative already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'SymptomsBeganDate' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD SymptomsBeganDate DATE NULL;
        PRINT 'Added oe.ShareRequests.SymptomsBeganDate';
    END ELSE PRINT 'oe.ShareRequests.SymptomsBeganDate already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'IsNewCondition' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD IsNewCondition NVARCHAR(20) NULL;
        PRINT 'Added oe.ShareRequests.IsNewCondition';
    END ELSE PRINT 'oe.ShareRequests.IsNewCondition already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'OtherInsurance' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD OtherInsurance NVARCHAR(50) NULL;
        PRINT 'Added oe.ShareRequests.OtherInsurance';
    END ELSE PRINT 'oe.ShareRequests.OtherInsurance already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'WouldSwitchDoctor' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD WouldSwitchDoctor BIT NULL;
        PRINT 'Added oe.ShareRequests.WouldSwitchDoctor';
    END ELSE PRINT 'oe.ShareRequests.WouldSwitchDoctor already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'ErCharityCareApplied' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD ErCharityCareApplied NVARCHAR(20) NULL;
        PRINT 'Added oe.ShareRequests.ErCharityCareApplied';
    END ELSE PRINT 'oe.ShareRequests.ErCharityCareApplied already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'MaternityDeliveryStatus' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD MaternityDeliveryStatus NVARCHAR(20) NULL;
        PRINT 'Added oe.ShareRequests.MaternityDeliveryStatus';
    END ELSE PRINT 'oe.ShareRequests.MaternityDeliveryStatus already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'SurgeonInNetwork' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD SurgeonInNetwork BIT NULL;
        PRINT 'Added oe.ShareRequests.SurgeonInNetwork';
    END ELSE PRINT 'oe.ShareRequests.SurgeonInNetwork already present — skipped.';

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'PatientRelationToPrimary' AND Object_ID = Object_ID(N'oe.ShareRequests'))
    BEGIN
        ALTER TABLE oe.ShareRequests ADD PatientRelationToPrimary NVARCHAR(50) NULL;
        PRINT 'Added oe.ShareRequests.PatientRelationToPrimary';
    END ELSE PRINT 'oe.ShareRequests.PatientRelationToPrimary already present — skipped.';

    -- oe.Providers addition --------------------------------------------

    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'TaxId' AND Object_ID = Object_ID(N'oe.Providers'))
    BEGIN
        ALTER TABLE oe.Providers ADD TaxId NVARCHAR(50) NULL;
        PRINT 'Added oe.Providers.TaxId';
    END ELSE PRINT 'oe.Providers.TaxId already present — skipped.';

    PRINT '=== Done. ===';
END
