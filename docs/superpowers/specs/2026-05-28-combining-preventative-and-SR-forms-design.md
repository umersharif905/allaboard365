# Combining Preventative + SR Forms — Design

- **Date:** 2026-05-28
- **Branch:** `fix/backoffice/combining-preventative-and-SR-forms`
- **Author:** brainstormed with Amar
- **Status:** Approved design; ready for spec review
- **Related:** [`docs/superpowers/specs/2026-05-21-npi-provider-search-form-field-design.md`](./2026-05-21-npi-provider-search-form-field-design.md), [`docs/backoffice/combining-forms-blockers.md`](../../backoffice/combining-forms-blockers.md), [`docs/backoffice/combining-forms-notes.md`](../../backoffice/combining-forms-notes.md)

## 1. Summary

Merge the "Out-of-Network Copay / Preventative Bill" form *into* "Claude's Form (Copy)" (the redesigned Unshared Amount Sharing Request form) so a single public form handles both routine/preventative reimbursement requests and surgery/ER/major-event sharing requests. A new TurboTax-style A/B pre-screen at the top routes the member into one of two branches, and the submission auto-creates a Case (preventative) or a ShareRequest (major-event) accordingly.

Adds two reusable form-builder/backend primitives that any future form can adopt:

1. **Conditional pre-screen** — a pre-screening option can hide *other* pre-screening questions, not just pages/fields.
2. **Auto-create-Case on submit** — parallel to the existing auto-create-ShareRequest hook.

Also fixes a long-standing gap: the existing "What brings you here?" pre-screen on Claude's Form (Copy) (and any form built like it) does **not** drive the auto-created ShareRequest's type today. This branch wires it up.

### Goal

One form, one URL, one submission flow, two reimbursement workflows. Members do not need to know which form to start; the A/B pre-screen handles that.

### Non-goals (in this branch)

- Vendor-program rollout. The per-vendor copies of the existing OON forms (`ARM`, `TallTree`) are *not* migrated here. The work in this branch is the prototype + reusable primitives; per-vendor cloning is a separate effort.
- Legacy URL preservation for the existing OON form templates. Deferred to a follow-up branch.
- Changes to the SR-side flow inside Claude's Form (Copy). The 5 existing paths stay intact.

## 2. Background

### 2.1 Today's pre-screening

Pre-screen state lives in `frontend/src/types/publicFormDefinition.ts`:

- `PreScreenQuestion`, `PreScreenOption`, `PreScreenEffect`
- `PreScreenEffect.targetType` is `'page' | 'field'`. **There is no way for a pre-screen option to hide another pre-screen question.**
- `PreScreenQuestion` has no `defaultHidden`.

Effect-graph evaluation happens in `frontend/src/components/public/PublicFormView.tsx` (and the prescreening wrapper that runs before page rendering).

### 2.2 Today's submission-routing

`backend/services/publicFormShareLinkService.js`:

- `linkSubmissionToShareWorkflow(...)` is the post-submit hook called by `backend/routes/public/public-forms.js`.
- It reads `oe.PublicFormTemplates.CreatesShareRequestOnSubmit`; when true, creates a ShareRequest.
- There is *no* parallel `CreatesCaseOnSubmit` column. Cases are never auto-created from public submissions.
- `resolveRequestTypeIdForPayload(vendorId, formKind, payload)` resolves the SR's `RequestTypeId`. It uses **only** `formKind` plus one special case (`payload.sharingRequestType === 'Maternity'` for `formKind = 'UnsharedAmount'`). Pre-screen answers in the payload are ignored.
- All other prescreen answers end up dropped into the SR's `generalNotes` as text, but never drive type/category.

### 2.3 Today's case taxonomy

`frontend/src/constants/caseTaxonomy.ts`:

- 5 case types: `reimbursement`, `billing`, `encounter_escalation`, `complaint`, `appeals`.
- Subcategories include `oon_copay` and `preventative` (among others).
- These are *fallback labels*. Authoritative rows live in `oe.CaseTypes` / `oe.CaseSubcategories`, vendor-scoped. The label file is for stale-code fallback only.
- Case creation API lives in `backend/services/caseService.js`, function `createCase(...)` (returns a `caseId`).

### 2.4 Forms currently in the testing DB

| FormTemplateId | Title | FormKind | KindLabel | `CreatesShareRequestOnSubmit` |
|---|---|---|---|---|
| `c0001a15-…` | Claude's Form (Copy) | `K_c0001a15…` | (custom) | true |
| `1680CB61-…` | Out-of-Network Bill (Copay or Preventative) Submission (TallTree) | `K_1680cb61…` | BillSubmissionTallTree | false |
| `EACE9CE8-…` | Out-of-Network Copay/Preventative Bill (ARM) | `PreventiveCare` | PreventativeGeneral | true |

The latter two are *not* edited in this branch. Only `c0001a15-…` ships the combined form.

## 3. Decisions locked

1. **Single-form approach**, not a splash/router. The combined form is one DefinitionJson with two branches routed by an A/B prescreen.
2. **A/B prescreen wording:** "What brings you here today?" with two tile-style options:
   - **Routine or preventative care** — *"Checkup, urgent care visit, lab work, vaccine, or well-woman/well-child visit."*
   - **Surgery, ER, or major event** — *"Surgery (had or scheduled), ER visit, hospital stay, or a serious ongoing diagnosis. Bills in the thousands."*
3. **Routing semantics** — prescreen-aware:

   | A/B answer | If template flags set | Auto-creates |
   |---|---|---|
   | `routine_preventative` | `CreatesCaseOnSubmit = true` | one Case (type `reimbursement`, subcategory from member's Copay/Preventative radio) |
   | `routine_preventative` | `CreatesCaseOnSubmit = false` | nothing — submission only |
   | `surgery_er_major` | `CreatesShareRequestOnSubmit = true` | one ShareRequest (existing path, now type-hint-aware) |
   | `surgery_er_major` | `CreatesShareRequestOnSubmit = false` | nothing — submission only |
   | A/B answer missing (non-merged form) | each flag honored independently | unchanged (back-compat clause) |

4. **Preventative vs. OON Copay** — disambiguated by member on the form (single required radio). The codebase carries no embedded definition of the two; the routing relies on the member's answer.
5. **Required proof-of-service file** on the preventative branch. Helper text lists HCFA/CMS-1500 *or* itemized bill with CPT codes as acceptable; no code-side enforcement of file contents.
6. **Conditional pre-screen** ships as a global builder feature (decision (i) over (ii) in §4.4).
7. **Per-option `srTypeHint`** is how the existing "What brings you here?" pre-screen drives SR type — schema-additive, builder-editable.

## 4. Detailed design

### 4.1 New form-definition schema bits

In `frontend/src/types/publicFormDefinition.ts`:

```ts
export type PreScreenEffect = {
  action: 'show' | 'hide';
  targetType: 'page' | 'field' | 'preScreenQuestion';  // ← new
  targetId: string;  // for 'preScreenQuestion', this is PreScreenQuestion.id
};

export type PreScreenQuestion = {
  id: string;
  prompt: string;
  multiSelect?: boolean;
  options: PreScreenOption[];
  defaultHidden?: boolean;                                // ← new
};

export type PreScreenOption = {
  id: string;
  label: string;
  effects: PreScreenEffect[];
  block?: PreScreenBlock;
  // ──────────── new ────────────
  helperText?: string;            // tile-style under-headline copy
  iconName?: string;              // Lucide icon name (e.g. 'stethoscope', 'hospital')
  srTypeHint?: string;            // hint passed to resolveRequestTypeIdForPayload
};
```

All additions are optional — no migration of existing form definitions needed.

### 4.2 Effect-graph evaluation rules

The pre-screen evaluator that runs before page rendering (in `PublicFormView.tsx`, where prescreen answers compute and the visible page list is derived) needs three rule changes:

1. **Order:** questions evaluate in array order (i.e. index 0 first).
2. **Hide propagation:** if any earlier option's effects hide question Q, then Q is not rendered *and* its own effects do not fire. This is what lets the A/B option silently hide the downstream "What brings you here?" prescreen.
3. **`defaultHidden` questions** are not rendered unless an earlier option's effect shows them. (Symmetric with the existing page/field `defaultHidden` rule.)

A hidden question's submitted answer is `undefined`. Submission-routing code (§4.5) treats `undefined` A/B as "no A/B prescreen present" → the back-compat row applies.

### 4.3 Builder UI changes

- `frontend/src/components/tenant-admin/public-form-builder/PreScreeningManager.tsx`: surface `defaultHidden` checkbox on `PreScreenQuestion`, surface `helperText`, `iconName`, `srTypeHint` on `PreScreenOption`.
- `frontend/src/components/tenant-admin/public-form-builder/LinkagePicker.tsx`: `buildTargets()` adds pre-screen questions to the target list, grouped as "Pre-screen question: *prompt*". Implementation note: walk `def.preScreening` after the existing pages/fields loops.

### 4.4 Tile-style render

Existing render of pre-screen options is a row of buttons. Add a tile mode when *any* option in the question has `iconName` or `helperText`:

- Two-up grid (or single column on narrow viewports).
- Each tile: Lucide icon (resolved by `iconName` via the existing icon-lookup pattern), bold headline (`label`), helper-text paragraph (`helperText`).
- Click anywhere on the tile selects it.

If no option declares `iconName`/`helperText`, render as today (no behavior change for existing forms).

### 4.5 Submission router — `linkSubmissionToShareWorkflow`

Extend the post-submit hook in `backend/services/publicFormShareLinkService.js`:

```js
// After payload parsing + prescreen-answer extraction:
const abAnswer = prescreenAnswers['ps_routine_or_major'];  // option id
const abPresent = abAnswer !== undefined;

if (abPresent && abAnswer === 'routine_preventative') {
  if (template.CreatesCaseOnSubmit) await createCaseFromSubmission(...);
  // skip SR create even if CreatesShareRequestOnSubmit=true
} else if (abPresent && abAnswer === 'surgery_er_major') {
  if (template.CreatesShareRequestOnSubmit) await createShareRequestFromSubmission(...);
  // skip Case create
} else {
  // Back-compat: no A/B → honor each flag independently
  if (template.CreatesShareRequestOnSubmit) await createShareRequestFromSubmission(...);
  if (template.CreatesCaseOnSubmit)        await createCaseFromSubmission(...);
}
```

The A/B prescreen-question id (`ps_routine_or_major`) is *not* hardcoded. The router looks for any prescreen option in the form definition whose `id` matches one of the *router-recognised* values (`routine_preventative`, `surgery_er_major`). This keeps the router decoupled from the specific question name, while still resolving via option ids that authors must use consistently.

### 4.6 Case creation from a submission

`createCaseFromSubmission(template, submission, prescreenAnswers)`:

- Resolves `vendorId` / `tenantId` / `memberId` via the same lookups SR creation uses (`publicFormMemberResolver` exists).
- Builds the Case payload:
  - `type`: `'reimbursement'` (matches the fallback type code).
  - `subcategory`: from the form's reimbursement-type radio (`oon_copay` or `preventative`). The radio's `name` is configurable but the form ships with `prev_reimbursement_type` (§4.8).
  - `description`: from the `prev_reason` text field if present, else the prescreen-answer label.
  - `attachments`: every uploaded file on the submission — at minimum the required `prev_proof_file`.
  - `sourceSubmissionId`: the submission's id, for traceability.
- Calls `caseService.createCase(payload)`.
- Inserts the returned `caseId` into the submission row (`oe.PublicFormSubmissions.LinkedCaseId`, new column — see §4.7 migration).

### 4.7 SQL migration — heavily documented

File: `sql-changes/allaboard365/2026-05-28-creates-case-on-submit.sql`.

Two additive columns, both nullable / defaulted, both safe to run on live prod with no downtime. The migration file MUST follow the existing project pattern: idempotent `IF NOT EXISTS` guards, explanatory header comment, and a SELECT-mode preview block at the top per the project's [Database Write Policy](../../../CLAUDE.md#database-write-policy-hard-rules).

```sql
-- =====================================================================
-- Migration: 2026-05-28-creates-case-on-submit.sql
-- Branch:    fix/backoffice/combining-preventative-and-SR-forms
-- Purpose:
--   Add the supporting columns that let a public-form template auto-
--   create a Case (in addition to / instead of a ShareRequest) when
--   it's submitted. Used by the combined "Routine/Preventative vs
--   Surgery/ER/Major" form pattern shipping in this branch.
--
-- Tables touched:
--   1. oe.PublicFormTemplates      → new column CreatesCaseOnSubmit BIT
--                                      NOT NULL DEFAULT 0
--   2. oe.PublicFormSubmissions    → new column LinkedCaseId
--                                      UNIQUEIDENTIFIER NULL
--                                      (parallel to existing LinkedShareRequestId)
--
-- Safety:
--   • Both columns are additive. No existing row is modified.
--   • Defaults preserve current behavior on every existing template.
--   • Backfill not required; legacy rows simply read NULL/0.
--   • Indexes are not added in this migration — query patterns can
--     stay table-scan until the volume warrants one.
--
-- Rollback:
--   Both columns can be safely dropped if needed; no row data depends
--   on them once the application code is rolled back.
--
-- Dry-run mode:
--   Set @DryRun = 1 (default) to preview the changes without applying.
--   Set @DryRun = 0 to execute.
-- =====================================================================

DECLARE @DryRun BIT = 1;          -- ← flip to 0 to actually apply

IF @DryRun = 1 BEGIN
  PRINT 'DRY RUN — no changes will be applied.';
  PRINT 'Would add column oe.PublicFormTemplates.CreatesCaseOnSubmit  (BIT NOT NULL DEFAULT 0)';
  PRINT 'Would add column oe.PublicFormSubmissions.LinkedCaseId       (UNIQUEIDENTIFIER NULL)';
END
ELSE BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE Name = N'CreatesCaseOnSubmit'
      AND Object_ID = Object_ID(N'oe.PublicFormTemplates')
  )
  BEGIN
    ALTER TABLE oe.PublicFormTemplates
      ADD CreatesCaseOnSubmit BIT NOT NULL CONSTRAINT DF_PublicFormTemplates_CreatesCaseOnSubmit DEFAULT 0;
    PRINT 'Added oe.PublicFormTemplates.CreatesCaseOnSubmit';
  END
  ELSE
    PRINT 'oe.PublicFormTemplates.CreatesCaseOnSubmit already present — skipped.';

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
    PRINT 'oe.PublicFormSubmissions.LinkedCaseId already present — skipped.';
END
```

The PR description MUST flag this at the very top:

> **⚠ SQL migration required.** `sql-changes/allaboard365/2026-05-28-creates-case-on-submit.sql` must be run on production *after* this PR is merged. Run with `@DryRun = 1` first to preview; flip to `0` to apply. Both additions are additive and safe (no row mutation, no constraints on existing data).

Migration is applied to testing in this branch (per the shared-dev-DB policy: Amar runs it when explicitly asked; do not auto-apply).

### 4.8 Form content — Claude's Form (Copy) DefinitionJson changes

All changes land in DefinitionJson v4 of template `c0001a15-…`:

**(a) New first pre-screen question** — `ps_routine_or_major`:

```json
{
  "id": "ps_routine_or_major",
  "prompt": "What brings you here today?",
  "multiSelect": false,
  "options": [
    {
      "id": "routine_preventative",
      "label": "Routine or preventative care",
      "iconName": "stethoscope",
      "helperText": "Checkup, urgent care visit, lab work, vaccine, or well-woman/well-child visit.",
      "effects": [
        { "action": "hide", "targetType": "preScreenQuestion", "targetId": "ps_what_brings_you" },
        { "action": "show", "targetType": "page",              "targetId": "page_prev" }
      ]
    },
    {
      "id": "surgery_er_major",
      "label": "Surgery, ER, or major event",
      "iconName": "hospital",
      "helperText": "Surgery (had or scheduled), ER visit, hospital stay, or a serious ongoing diagnosis. Bills in the thousands.",
      "effects": []
    }
  ]
}
```

**(b) Add `srTypeHint` to the existing "What brings you here?" prescreen options**:

| Option label | `srTypeHint` |
|---|---|
| I'm having surgery | `Surgery` |
| I had surgery | `Surgery` |
| ER visit | `ER` |
| I'm having a baby | `Maternity` |
| Something else | *(omit — falls through to vendor default)* |

Exact hint strings are validated against the target vendor's `oe.RequestTypes` rows before the testing-DB write (see blockers #3).

**(c) `defaultHidden: true`** on every page that belongs to the SR branches: `page_surg_*`, `page_post_*`, `page_er_*`, `page_mat_*`, `page_other`. Existing "show page" effects on the "What brings you here?" options already cover the reveal, so no other change is needed for the SR branches.

**(d) New preventative page** — `page_prev`, `defaultHidden: true`:

| Order | Field name | Type | Required | Notes |
|---|---|---|---|---|
| 1 | `prev_intro` | `static_html` | – | Proof-of-service requirements — HCFA/CMS-1500 OR itemized bill with CPT codes; "bills without procedure codes will be returned" |
| 2 | `prev_service_date` | `date` | yes | `dateDisallowFuture: true`. Member name (`ay_first_name`/`ay_last_name`), DOB, member ID (`ay_member_id`), email, phone, and address come from the always-shown `page_about_you` (no duplication needed). |
| 3 | `prev_provider` | `provider_search` (mode `both`) | yes | Reuses the §[NPI design](./2026-05-21-npi-provider-search-form-field-design.md) field type. |
| 4 | `prev_reimbursement_type` | `radio` | yes | options `oon_copay` / `preventative` — helper text describes each in one line. |
| 5 | `prev_reason` | `text` | no | "Briefly, what was the visit?" |
| 6 | `prev_proof_file` | `file` | yes | Helper text: "Upload your CMS/HCFA-1500 OR an itemized bill that shows each line's CPT/procedure code." |
| 7 | `prev_hipaa_terms` + `prev_hipaa_signature` | `terms` + `signature` | yes | Reuse the existing HIPAA block already on the form. |

**(e) Version bump** — update `oe.PublicFormTemplates.PublishedVersion` to 4 and insert a new `oe.PublicFormTemplateVersions` row (VersionNumber=4) with a `ChangeNote` of `"Combine preventative + SR branches; add A/B prescreen, conditional prescreen, auto-create-Case wiring, prescreen → SR type hints."`. The old v3 row stays for rollback.

## 5. Files touched

**New:**
- `sql-changes/allaboard365/2026-05-28-creates-case-on-submit.sql`
- `docs/superpowers/specs/2026-05-28-combining-preventative-and-SR-forms-design.md` (this file)
- `docs/backoffice/combining-forms-blockers.md`
- `docs/backoffice/combining-forms-notes.md`
- Test files per §6.

**Modified:**
- `docs/forms/claudes-form-copy.definition.json` (form content)
- `frontend/src/types/publicFormDefinition.ts` (new schema fields)
- `frontend/src/components/public/PublicFormView.tsx` (effect-graph rule changes, tile rendering)
- `frontend/src/components/tenant-admin/public-form-builder/PreScreeningManager.tsx`
- `frontend/src/components/tenant-admin/public-form-builder/LinkagePicker.tsx`
- `backend/services/publicFormShareLinkService.js` (router rewrite, `srTypeHint` plumbing into `resolveRequestTypeIdForPayload`)
- `backend/routes/me/tenant-admin/public-forms.js` (surface `CreatesCaseOnSubmit` on save)
- DB row update for template `c0001a15-…` v4 in `allaboard-testing`.

**Reused as-is:**
- `backend/services/caseService.js`
- `backend/services/publicFormMemberResolver.js`
- Existing HIPAA block + signature field

## 6. Testing

- **Backend Jest:** new tests for `publicFormShareLinkService` covering the four routing rows in §3 (incl. the back-compat row), and `resolveRequestTypeIdForPayload` honoring `srTypeHint`. Existing tests must not regress.
- **Vitest:** effect-graph evaluator — A/B "routine" hides `ps_what_brings_you`; A/B "major" doesn't; `defaultHidden` question stays hidden until a `show` effect runs.
- **Cypress:** one stub-driven spec — load the form, pick "Routine or preventative", confirm the SR branch pages do not render, fill the preventative page, submit, assert one Case-create POST (stubbed) and zero SR-create POSTs. Mirror it for "Major event" picking the existing surgery flow.
- **Manual** smoke on testing-DB form once DefinitionJson v4 is in place: both branches end-to-end, attachments included.

## 7. Out of scope / non-goals

- Per-vendor rollout of the combined form to ARM / TallTree templates.
- Legacy URL preservation for the existing OON form template UUIDs.
- Any change to the SR flow inside Claude's Form (Copy) (the 5 paths stay as they are).
- Auto-routing the Copay-vs-Preventative subcategory without a member's input.
- Confirming the vendor-scoped exact name of the `reimbursement` Case type for any tenant other than the one we smoke-test on. Tracked in [blockers.md #3](../../backoffice/combining-forms-blockers.md#3-reimbursement-case-type-code).

## 8. PR description requirements

The PR must call out — at the *very top* of the description — that the SQL migration in `sql-changes/allaboard365/2026-05-28-creates-case-on-submit.sql` needs to be run on production after merge. The migration ships with a `@DryRun` flag (default 1) so the receiving team previews before applying.
