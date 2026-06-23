# Feature inventory

Running index of every concrete addition this redesign makes. Each row links to a per-feature file documenting DB/backend/frontend impact, use case, and test procedure. Update status as work progresses.

Status legend: ⏳ pending · 🚧 in-progress · ✅ implemented · ✔️ verified end-to-end

## Snapshot — 2026-05-13

Where we are at end of session 2 (continuation from a prior chat).

- **Code:** 9 commits on `fix/back-office/forms-redesign` covering Phase 0 + the main spec implementation. Tasks #1–18 from the original queue all closed in code. Two inline bug fixes (URL host, JSON-string parse) landed during manual testing.
- **DB:** `2026-05-13-forms-redesign.sql` applied to the shared `allaboard-testing` instance.
- **Containers:** Local docker stack at `/mnt/pool/docker/allaboard365/compose.yaml` is up; backend has a throwaway PHI key for end-to-end submit testing (see B-002).
- **Held back from this branch (in `blockers.md`):**
  - **B-001** VendorAdmin publish/delete — spec §2/§8 say it should work; current code blocks. Held back so it can be batched with the rest of the vendor permission work.
  - **B-002** Local backend uses a throwaway encryption key. Replace with canonical Azure key before any admin-side decrypt UI is verified.
- **Manually verified end-to-end:** Editor delivery-mode toggles save, "Send to member" modal walks through to invitation create, recipient URL opens the targeted form and renders the SSN field. Submit blocked earlier on the missing PHI key; should now succeed with the throwaway key — re-verify is the open item.

The per-row Status column below reflects code-ship state. ✔️ verified only after a manual walkthrough confirms the behavior in the browser; everything currently ✅ is "in code, not yet verified by the user this session".

| # | Feature | DB | Backend | Frontend | Status |
|---|---|---|---|---|---|
| 001 | [Delivery-mode flags on form template](feature-001-delivery-mode-flags.md) | ✅ adds 3 BIT columns | ✅ validation + check constraint | ✅ editor UI + send picker | ✅ |
| 002 | [`CreatesShareRequestOnSubmit` flag](feature-002-creates-share-request-on-submit.md) | ✅ adds BIT column | ✅ replaces fall-through dispatch | ✅ editor UI | ✅ |
| 003 | [`PublicFormSubmissions.CaseId` column](feature-003-submission-case-id.md) | ✅ nullable UUID column | ⚠️ unused until Cases ships | ⚠️ hidden until Cases ships | ✅ |
| 004 | [`PublicFormSubmissions.AuthMode` column](feature-004-submission-auth-mode.md) | ✅ NVARCHAR(20) | ✅ set on submit | – | ✅ |
| 005 | [`PublicFormSubmissions.InvitationId` column](feature-005-submission-invitation-id.md) | ✅ nullable FK | ✅ set on targeted/authenticated submit | – | ✅ |
| 006 | [`PublicFormInvitations` table](feature-006-public-form-invitations-table.md) | ✅ new table | ✅ create/redeem/revoke flow | ✅ send modal | ✅ |
| 007 | [`PublicFormInvitations.DeliveryMethod` column](feature-007-invitation-delivery-method.md) | ✅ NVARCHAR(20) | ✅ branch on send vs copy | ✅ three-button choice in modal | ✅ |
| 008 | [Form editor — Delivery settings panel](feature-008-editor-delivery-settings.md) | – | ✅ template update validation | ✅ 4 toggles + inline error | ✔️ |
| 009 | [Forms list — "Get share link" + "Send to member" buttons](feature-009-forms-list-action-buttons.md) | – | – | ✅ visibility based on flags | ✔️ |
| 010 | [Send-to-member modal (4-step flow)](feature-010-send-to-member-modal.md) | – | ✅ create-invitation endpoint | ✅ multi-step modal | ✔️ |
| 011 | [Member SR + Case picker columns](feature-011-linkage-picker-columns.md) | – | ✅ list open SRs for member endpoint | ✅ two-column picker; Case disabled | ✅ |
| 012 | [Targeted-mode recipient affordance (greeting block)](feature-012-targeted-greeting-affordance.md) | – | ✅ invitation-lookup returns firstName + email | ✅ greeting block at top of form | ✅ |
| 013 | [Multi-submission grouping UX](feature-013-multi-submission-grouping.md) | – | ⏳ submissions endpoint group-by InvitationId NOT done | ⏳ stacked-row UI NOT done | ⏳ |
| 014 | [VendorAgent send permission](feature-014-vendor-agent-send-permission.md) | – | ✅ authorize() updates on send endpoints | ✅ buttons visible to vendor agents | ✅ |
| 015 | [Revoke invitation endpoint + UI](feature-015-revoke-invitation.md) | – | ✅ DELETE endpoint | ⏳ revoke button on invitation row NOT done | 🚧 |

### From Section 3 — Targeted-link flow

| # | Feature | DB | Backend | Frontend | Status |
|---|---|---|---|---|---|
| 016 | [Frontend route `/forms/i/:token`](feature-016-invitation-routing.md) | – | – | ✅ InvitationRouter guard | ✔️ |
| 017 | [TargetedFormPage component](feature-017-targeted-form-page.md) | – | – | ✅ inline in InvitationFormPage | ✔️ |
| 018 | [`GET /api/public/forms/invitations/:token/meta`](feature-018-invitation-meta-endpoint.md) | – | ✅ lightweight lookup | – | ✔️ |
| 019 | [`GET /api/public/forms/invitations/:token` (targeted)](feature-019-invitation-targeted-get.md) | – | ✅ full data for targeted mode (JSON-parse fix during testing) | – | ✔️ |
| 020 | [`POST /api/public/forms/invitations/:token/submit` (targeted)](feature-020-invitation-targeted-submit.md) | – | ✅ submit + auto-link to member | – | 🚧 verify after PHI key |
| 021 | [Expiry / revocation enforcement](feature-021-expiry-revocation.md) | – | ✅ 410 Gone response | ✅ error UI | ✅ |

### From Section 4 — Authenticated flow

| # | Feature | DB | Backend | Frontend | Status |
|---|---|---|---|---|---|
| 022 | [AuthenticatedFormPage component](feature-022-authenticated-form-page.md) | – | – | ✅ inline in InvitationFormPage (not in MemberLayout chrome) | ✅ |
| 023 | [`GET /api/me/member/forms/invitations/:token`](feature-023-authenticated-get.md) | – | ✅ auth-gated, member-match check (JSON-parse fix during testing) | – | ✅ |
| 024 | [`POST /api/me/member/forms/invitations/:token/submit`](feature-024-authenticated-submit.md) | – | ✅ auth-gated submit | – | ✅ |
| 025 | [Profile prefill service (well-known fields)](feature-025-prefill-service.md) | – | ✅ new service | – | ✅ |
| 026 | [Pre-login zero-disclosure landing](feature-026-pre-login-landing.md) | – | – | 🚧 redirect works; login page does NOT yet show "Log in to fill in: {title}" | 🚧 |
| 027 | [Mismatched-member 403 handling](feature-027-mismatch-handling.md) | – | ✅ user.MemberId check | ✅ generic error | ✅ |

### From Section 5 — Destination & findability

| # | Feature | DB | Backend | Frontend | Status |
|---|---|---|---|---|---|
| 028 | [MemberDocumentsTab folder restructure](feature-028-member-documents-folders.md) | – | 🚧 flat list, no per-folder grouping yet | 🚧 forms render flat below docs, no Other/SR/Case folders | 🚧 minimum viable |
| 029 | [`GET /members/:id/documents` extended response](feature-029-member-docs-endpoint-extension.md) | – | 🚧 NEW endpoint `/members/:id/form-submissions` instead of extending docs response | – | 🚧 same outcome, different shape |
| 030 | [SR DocumentsTab renamed to "Documents and Forms"](feature-030-sr-documents-and-forms.md) | – | ✅ NEW endpoint `/share-requests/:id/form-submissions` | ✅ rename + forms section | ✅ |
| 031 | [Auto-resolver runs on submit](feature-031-auto-resolver-on-submit.md) | – | ✅ pre-existing inline call, confirmed not regressed | – | ✅ |
| 032 | [`PayloadEmail` / `PayloadPhone` plaintext columns](feature-032-payload-email-phone.md) | ✅ 2 NVARCHAR columns | ✅ populated at write | – | ✅ |
| 033 | [Discrepancy display in membership column](feature-033-discrepancy-parens.md) | – | – | ⏳ NOT done | ⏳ |
| 034 | [Submissions filter: resolution status + source](feature-034-submissions-filters.md) | – | ⏳ NOT done | ⏳ NOT done | ⏳ |

### From Section 6 — Per-send linkage UI

| # | Feature | DB | Backend | Frontend | Status |
|---|---|---|---|---|---|
| 035 | [Linkage picker component (2 columns)](feature-035-linkage-picker-component.md) | – | – | 🚧 inlined in SendToMemberModal, NOT extracted yet | 🚧 |
| 036 | [`GET /members/:id/open-share-requests`](feature-036-open-share-requests-endpoint.md) | – | ✅ vendor + tenant-admin variants | – | ✅ |
| 037 | [Retroactive linkage panel on submission detail](feature-037-retro-linkage-panel.md) | – | – | ⏳ NOT done | ⏳ |
| 038 | [`PATCH /submissions/:id/linkage`](feature-038-patch-linkage-endpoint.md) | – | ⏳ NOT done | – | ⏳ |
| 039 | [Soft warning: anonymous form lacks identity fields](feature-039-soft-warning-no-identity.md) | – | – | ⏳ NOT done | ⏳ |

### From Section 7 — Migration & rollout

| # | Feature | DB | Backend | Frontend | Status |
|---|---|---|---|---|---|
| 040 | [SQL migration `2026-05-13-forms-redesign.sql`](feature-040-sql-migration.md) | ✅ written + applied to `allaboard-testing` | – | – | ✔️ |
| 041 | [Backfill: UA + PC get `CreatesShareRequestOnSubmit = 1`](feature-041-backfill-intake-templates.md) | ✅ UPDATE ran with migration | – | – | ✔️ |
| 042 | [Pre-deploy audit query](feature-042-pre-deploy-audit-query.md) | – (read-only check) | – | – | ⏳ run before prod deploy |
| 043 | [`AdditionalDocuments` template hidden from new sends](feature-043-deprecate-additional-docs.md) | – | – | ⏳ NOT done | ⏳ |

### From Section 8 — Vendor agent fix (Phase 0, separate PR)

| # | Feature | DB | Backend | Frontend | Status |
|---|---|---|---|---|---|
| 044 | [VendorAgent on vendor public-forms read + resolve endpoints](feature-044-vendor-agent-phase0.md) | – | ✅ authorize() updates | ✅ hide edit controls | ✅ (manual verify on testing DB still owed) |


> **Per-feature detail files are not yet written.** The links above will resolve as each feature's detail file is created. The intended workflow: create the detail file (copy `_template.md`) when starting implementation of that feature; promote status as it progresses; verify ✔️ once tested end-to-end.

## Verification checklist (per feature)

For each feature row marked ✅ implemented, the per-feature file must contain a test procedure that has been executed at least once. Promote to ✔️ verified once tested.

Cross-cutting verifications:
- [ ] Every feature listed here has a corresponding file in this directory.
- [ ] No feature is shipped without its row reaching ✔️.
- [ ] Spec design doc references match feature file names.
