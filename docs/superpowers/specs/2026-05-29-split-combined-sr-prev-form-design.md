# Split "FUTURE SR/PREV FORM COMBINED" into two public forms

**Date:** 2026-05-29
**Status:** Approved design
**Target:** `allaboard-testing` DB, tenant `1CD92AF7-B6F2-4E48-A8F3-EC6316158826`

## Background

The combined public form (`FormTemplateId C0001A15-26B8-4CD7-8B41-46F1A44B05E5`,
KindLabel "Claude's Form (Copy)", published v9) opens with a top-level prescreen
question `ps_routine_or_major` ("What brings you here today?") that routes to two
fundamentally different products:

- **Routine / preventative care** → `autoCreateOnSubmit: case`, no direct-deposit
  page, low friction.
- **Surgery / ER / major event** → `autoCreateOnSubmit: shareRequest`, full
  provider / bills / records / direct-deposit / authorization flow, with a second
  5-way router (`psq_claude_router`) for the sub-type.

Combining them is being deferred: public forms allow **anonymous** submission, and
whether a submitter is eligible for the preventative branch depends on plan/coverage
data only available after sign-in. A single anonymous form cannot gate that branch.
Splitting into two separately-distributed public links is the structurally correct
design — whoever shares the link already knows the audience.

## Approach

Create **two new published templates** (v1) by deriving from the combined v9
definition. Each field carries a `pageId`, so the cut is exact (filter fields by
page). The original combined form is left untouched.

Both new templates: tenant `1CD92AF7…`, `AllowAnonymous=1`, `AllowTargeted=0`,
`AllowAuthenticated=0`, `IsActive=1`, `IsPublished=1`, `PublishedVersion=1`,
`NotifyEmails='[]'`, `AllowedFrameAncestors='*'`, fresh `FormTemplateId` and
`FormKind=K_<guid32>` (mirrors `publicFormAdminService.duplicateTemplate`).

`DefaultVendorId = D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6` (ShareWELL Health/Partners,
`ShareRequestEnabled=true`) on **both** forms — the `no_vendor` guard in
`linkSubmissionToShareWorkflow` precedes the SR-vs-Case split, so the Case path needs
a vendor too for anonymous submissions. `DefaultVendorId` feeds `vendorIdOverride`
(`publicFormSubmissionService.js:587`).

### Form A — `Out-of-Network Copay & Preventative Care Form [NEW]`

- `CreatesCaseOnSubmit=1`, `CreatesShareRequestOnSubmit=0`, KindLabel
  "Out-of-Network Copay & Preventative".
- Definition `title` = "Out-of-Network Copay & Preventative Care Form" (no suffix;
  `[NEW]` lives only on the admin-facing template Title for findability).
- `preScreeningEnabled=false`, `preScreening=[]`.
- Pages (always shown, `defaultHidden` stripped): `page_about_you` → `page_prev` →
  `page_close_auth`. **23 fields.**
- Drops the direct-deposit page (`page_close_dd`) — DD belongs to the reimbursement
  SR flow, not a preventative Case.

### Form B — `Share Request Form [NEW]`

- `CreatesShareRequestOnSubmit=1`, `CreatesCaseOnSubmit=0`, KindLabel "Share Request".
- Definition `title` = "Share Request Form".
- `preScreeningEnabled=true`, `preScreening=[psq_claude_router]` — the 5-way "What
  brings you here today?" (Surgery upcoming/done, ER, Baby, Something Else) becomes
  the entry question. Top-level `ps_routine_or_major` removed.
- `page_request` flipped to always-shown (it was revealed by the removed top
  question; it applies to every SR sub-path).
- Pages: all 19 except `page_prev` → **18 pages, 104 fields.** All router page
  targets verified present.
- `srTypeHint` per router option still resolves the SR type against the vendor's
  `VendorShareRequestTypes`. Vendor `D2A84803` has Surgery-Inpatient/Outpatient,
  Treatment, Maternity, Procedure. Per `resolveRequestTypeIdForPayload`, exact-name
  match wins, else `Procedure`: `Maternity`→Maternity; `Surgery`/`ER`→Procedure
  fallback. **This matches the combined form's existing behavior** — not changed by
  the split. (Tuning the hints to the vendor's exact type names is a separate task.)

## Deliverables

- `docs/forms/share-request-form.definition.json`
- `docs/forms/out-of-network-copay-preventative-form.definition.json`
- `ai_scripts/create-split-forms.cjs` — inserts both templates + v1 versions.
  **Dry-run by default** (prints the plan); writes only with `--commit` (per the
  CLAUDE.md DB-write hard rule). Idempotent: aborts if a template with either Title
  already exists for the tenant.

## Out of scope

- Generating/printing the public share links (done in the admin UI after creation).
- Tuning `srTypeHint` values to the vendor's exact SR type names.
- Retiring or modifying the original combined form.
