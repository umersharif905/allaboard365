# Combining Preventative + SR Forms — Branch Notes

Branch: `fix/backoffice/combining-preventative-and-SR-forms` (off `staging`, 2026-05-28)

Rolling change log. Add an entry per substantive change — design decision, file/feature shipped, follow-up — most recent at the top. This becomes the PR description when the branch lands.

---

## Goal

Merge the "Out-of-Network Copay/Preventative Bill" form into Claude's Form (Copy) so that *one* public form handles both routine/preventative reimbursement requests and surgery/ER/major-event sharing requests. Adds the supporting builder + backend primitives so this pattern is available to any future combined form.

## What's shipped on this branch

### 2026-05-28 — editable SR fields, auto-populated from form payload

Big architectural change: Share Requests gain a parallel, *editable* copy of the structured clinical/event data from the form. The form submission stays as the immutable source of truth for what the member actually wrote; the back office edits the SR-side copies to correct typos / wrong NPIs / etc. Divergence between the two is visible (the SR detail tab carries the editable Clinical Event card + the read-only "Member submission" view).

**SQL migration** — `sql-changes/allaboard365/2026-05-28-sr-editable-form-fields.sql`. Additive, idempotent, dry-run by default. Applied to `allaboard-testing` on 2026-05-28. **Needs to be applied to prod.**

Columns added:
- `oe.ShareRequests` (10 columns): `ProcedureName NVARCHAR(500)`, `EventNarrative NVARCHAR(MAX)`, `SymptomsBeganDate DATE`, `IsNewCondition NVARCHAR(20)`, `OtherInsurance NVARCHAR(50)`, `WouldSwitchDoctor BIT`, `ErCharityCareApplied NVARCHAR(20)`, `MaternityDeliveryStatus NVARCHAR(20)`, `SurgeonInNetwork BIT`, `PatientRelationToPrimary NVARCHAR(50)` — all nullable.
- `oe.Providers` (1 column): `TaxId NVARCHAR(50) NULL`. Persists the form's `*_tax_id` text fields onto the provider record (only when the row's TaxId is currently NULL — back-office edits stay authoritative).
- `oe.Providers.Fax` already existed — the form's `req_pcp_fax` writes there on the linked PCP provider using the same NULL-only fill rule.

**Backend** — `publicFormShareLinkService.js`:
- New `extractEditableSrFields(payload)` helper — pulls the 8 fields from whichever form branch the member took.
- New `linkProvidersFromPayload(...)` — walks every `provider_search` value in the payload, find-or-creates an `oe.Providers` row via a three-tier dedup (1: NPI within vendor, 2: name+city+state within vendor, 3: name on any provider this household has used on prior SRs), then inserts a `ShareRequestProvider` link with the right role (`Primary Provider` / `Surgeon` / `Emergency` / `OB/Midwife` / `Provider` / `Facility`).
- Idempotent — re-processing a submission doesn't double provider link rows.
- Both helpers wired into `linkSubmissionToShareWorkflow`. Fields land in the new SR columns at auto-create.

**Backend** — `shareRequestService.js`:
- `createShareRequest` accepts and INSERTs the 8 new fields.
- `updateShareRequest` accepts the 8 new fields, builds them into the dynamic UPDATE and logs each change to SystemActivity.

**Frontend**:
- `shareRequest.types.ts` — extended `ShareRequest` with the 8 new fields.
- `RequestDetailsTab.tsx` — new **"Clinical event"** card in the 3-column grid (right after "Service") with all 8 fields. Editable via the existing Edit / Save flow.

### 2026-05-28 — initial implementation pass

**Schema**
- `PreScreenEffect.targetType` now accepts `'preScreenQuestion'` in addition to `'page'` / `'field'` (`frontend/src/types/publicFormDefinition.ts`). The frontend & shared visibility resolvers honor it.
- `PreScreenQuestion.defaultHidden?: boolean` — symmetric with `FormPage.defaultHidden` / `FieldDef.defaultHidden`.
- `PreScreenOption.helperText?: string`, `iconName?: string`, `srTypeHint?: string` — tile-render copy + icon + the SR-type routing hint.
- JSON normalizers updated to pass these new fields through.

**Visibility resolver (shared + frontend mirror)**
- `resolveVisibility(def, answers)` now returns `visiblePreScreenQuestionIds` alongside pages/fields.
- A question hidden by an earlier effect's `preScreenQuestion`-targeted hide is a no-op (its own effects don't fire).

**Public form render (`PublicFormView.tsx`)**
- Prescreen iteration uses the visible-question list (skips hidden ones).
- Step-progress / Back / advance navigation all account for hidden questions.
- Options with `iconName` or `helperText` render as TurboTax-style tiles (Lucide icon, bold headline, helper paragraph). Plain options unchanged.

**Submission routing (`publicFormShareLinkService.js`)**
- New `detectAbRoute(def, answers)` recognizes option ids `routine_preventative` / `surgery_er_major`.
- New `extractSrTypeHintFromAnswers(def, answers)` pulls the first answered option's `srTypeHint`.
- `resolveRequestTypeIdForPayload(...)` takes the hint as a fourth arg and prefers it over the formKind default — so the existing "What brings you here?" prescreen now drives SR type/category.
- `linkSubmissionToShareWorkflow(...)` reads both `CreatesShareRequestOnSubmit` and the new `CreatesCaseOnSubmit` flag, applies the A/B → Case-only / SR-only routing rule, falls back to the legacy each-flag-independent behavior when no A/B answer is present.
- New `createCaseFromSubmission(...)` calls `caseService.createCase()` with type `reimbursement` and a subcategory pulled from `prev_reimbursement_type` (or fallback `reimbursementType`). Stamps `oe.PublicFormSubmissions.LinkedCaseId`.

**Tenant-admin editor**
- Editor page surfaces a second "Auto-create a case on submit" toggle next to the existing SR-on-submit toggle (`TenantSharingFormEditorPage.tsx`).
- `publicFormAdminService.js` SELECTs / INSERTs / UPDATEs both `CreatesShareRequestOnSubmit` and `CreatesCaseOnSubmit`.

**SQL migration** — `sql-changes/allaboard365/2026-05-28-creates-case-on-submit.sql`
- Adds `oe.PublicFormTemplates.CreatesCaseOnSubmit` (BIT NOT NULL DEFAULT 0) and `oe.PublicFormSubmissions.LinkedCaseId` (UNIQUEIDENTIFIER NULL). Heavily commented; idempotent with `IF NOT EXISTS` guards; `@DryRun = 1` by default. **Applied to testing on 2026-05-28; still needs to be run on prod.**

**Form content — Claude's Form (Copy) DefinitionJson v4** (published in testing)
- Prepended a new pre-screen question `ps_routine_or_major` rendered as the TurboTax-style A/B tiles.
  - `routine_preventative` hides `psq_claude_router` and shows `page_prev`.
  - `surgery_er_major` shows the existing `page_request` so the surgery/ER/maternity branches see their shared intake.
- Marked `page_request` as `defaultHidden: true` so it only shows on the major-event branch.
- Added new page `page_prev` (defaultHidden) with: a proof-of-service intro static_html, `prev_service_date`, `prev_reimbursement_type` radio (Copay / Preventative), `prev_provider` (provider_search mode=both), optional `prev_reason`, required `prev_proof_file`. HIPAA / signature reuse the always-shown `page_close_auth`.
- Added `srTypeHint` to each `psq_claude_router` option: Surgery → `Surgery`, ER → `ER`, Maternity → `Maternity`. "Something else" stays unhinted.

### Followups (not yet done on this branch)

- **Builder UI** — `PreScreeningManager.tsx` / `LinkagePicker.tsx` still don't expose `defaultHidden` on a question, `helperText`/`iconName`/`srTypeHint` on an option, or `preScreenQuestion` targets in the effects picker. Editing the JSON directly works in the meantime.
- **Submission-detail / PDF rendering** — the preventative submission page still renders `prev_reimbursement_type` and `provider_search` values via the generic renderer. Confirm both look reasonable, polish if needed.

## Design decisions

- Single-form approach with prescreen-aware routing (rejected: splash router with two templates).
- Top-level A/B prescreen: **Routine or preventative care** vs **Surgery, ER, or major event** (TurboTax-style tile pair).
- Selecting "Routine/preventative" hides the existing 5-option "What brings you here?" prescreen *and* every surgery/ER/maternity page; reveals a single short preventative page.
- Submission routing reads the A/B answer: preventative → auto-create Case (type `reimbursement`, subcategory from the member's Copay/Preventative radio); major-event → auto-create ShareRequest (existing path).
- Preventative-vs-Copay disambiguated by member on the form, not auto-routed.
- Required proof-of-service file upload on the preventative branch — helper text lists HCFA/CMS-1500 OR itemized bill with CPT codes as acceptable; no codeside enforcement of file *contents*.

## New global features (will live beyond this branch)

- **Conditional pre-screen.** `PreScreenEffect.targetType` gains `'preScreenQuestion'`; `PreScreenQuestion` gains optional `defaultHidden`. Builder picker lists prescreen questions as targets.
- **Auto-create-Case on public-form submit.** New `oe.PublicFormTemplates.CreatesCaseOnSubmit` column; new branch in `publicFormShareLinkService.linkSubmissionToShareWorkflow` that creates a Case when the form's A/B prescreen resolves to "preventative" (or when there's no A/B and the flag is on).

## Form content changes

- Claude's Form (Copy) (`c0001a15-26b8-4cd7-8b41-46f1a44b05e5`) gains the A/B prescreen and the preventative branch fields.

## Tests

- TBD per section.

## Follow-ups out of scope for this branch

- Per-vendor preventative-form duplication (ARM, TallTree replacements).
- Legacy URL preservation for the existing OON form template UUIDs.
- Vendor-scoped Case type-code verification.

## Open blockers

See [`combining-forms-blockers.md`](./combining-forms-blockers.md).
