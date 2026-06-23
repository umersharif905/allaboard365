# Signed-in Form Autofill, Suggested Providers & Drafts — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Checkboxes track progress. This plan is intentionally **lean** (per user preference): each task names exact files, the behavior, and how to verify. Full design rationale lives in the spec: `docs/superpowers/specs/2026-05-29-signed-in-form-autofill-and-drafts-design.md`.

**Goal:** Auto-fill personal info + suggest the member's own providers + autosave drafts on the Share Request and Preventative forms, all gated on a signed-in Member session; anonymous behavior unchanged.

**Architecture:** AuthProvider-wrapped public form route → signed-in mode. Prefill/household/prior-provider data via new `/api/me/member/forms/*` endpoints (household-authorized). Drafts in new `oe.PublicFormDrafts` + `oe.PublicFormDraftFiles` with stage-and-promote Azure blobs. Admin "In Progress" tab reuses the shared sharing-forms layout.

**Tech Stack:** Express + MSSQL (`mssql`), React 18 + Vite + TS, TanStack Query, Tailwind, Jest (backend), Vitest (frontend), Azure Blob.

**Migrations:** authored as SQL files in `sql-changes/allaboard365/`, logged in `docs/forms/signed-in-autofill-migration-log.md`, run against `allaboard-testing` **only with per-migration confirmation from Amar**. Never prod from here.

---

## Phase A — Signed-in autofill + "Who is this for?"

> **Approach decision (supersedes earlier `prefillKey` idea):** autofill is driven by the **field key** (`field.name`) matching a canonical member key. The original `mapPrefillToInitialValues` already does exact-name + semantic-type matching, and `newFieldFromPalette` already pre-keys the semantic fields (`firstName`/`lastName`/`memberId`/`email`/`phone`). No `prefillKey` property and no DB schema change. The discoverability gap (admins not knowing the magic key names) is closed by an editor affordance + pre-keyed defaults.

### Task A1: Canonical member-key source of truth + FieldInspector "Autofills from member" affordance ✅ DONE
**Files:**
- Create: `frontend/src/types/memberAutofillKeys.ts` (`MEMBER_AUTOFILL_FIELDS: {key,label}[]` for firstName, lastName, dateOfBirth, email, phone, memberId, addressLine1, addressCity, addressState, addressZip, relationToPrimary, uaTier; + a `Set` of keys; mirrors the prefill payload from `publicFormInvitationPrefillService`)
- Modify: `frontend/src/components/tenant-admin/public-form-builder/FieldInspector.tsx` (add an "Autofills from member account" `<select>` near the "Field key (payload)" input; selecting a concept sets `field.name` to the canonical key; show a `🔗 Autofills <label>` badge when `field.name` is a known key)
- Test: `frontend/src/components/tenant-admin/public-form-builder/__tests__/FieldInspector.autofill.test.tsx`

- [ ] Failing Vitest: selecting "Date of birth" calls `onChange({name:'dateOfBirth'})`; a field already named `addressZip` shows the badge; unknown key shows no badge / dropdown = none.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task A2: Pre-keyed defaults for the non-semantic member concepts ✅ DONE
**Files:**
- Modify: `frontend/src/types/publicFormDefinition.ts` (`newFieldFromPalette`: semantic types already pre-key; nothing to change there)
- Modify: `frontend/src/components/tenant-admin/public-form-builder/FieldPalette.tsx` + its `onAdd` path in `useFormDefinition.ts` (add a **"Member info"** palette group whose items insert pre-keyed generic fields: Date of birth→`{type:'date',name:'dateOfBirth'}`, Street→`{text,addressLine1}`, City→`{text,addressCity}`, State→`{text,addressState}`, ZIP→`{text,addressZip}`, Relation to primary→`{select,relationToPrimary}` with self/spouse/child options, Unshared Amount tier→`{select,uaTier}`)
- Test: extend builder tests to assert a "Member info" insert produces the canonical key

- [ ] Failing Vitest: adding "Date of birth" from the Member-info palette yields a field keyed `dateOfBirth`.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task A3: Extend prefill payload with `uaTier` + a household-authorized prefill endpoint ✅ DONE
**Files:**
- Modify: `backend/services/publicFormInvitationPrefillService.js` (add `uaTier` via active-enrollment Unshared-Amount config; reuse approach from `backend/services/shareRequestService.js:1594`)
- Create: route `GET /api/me/member/forms/prefill?memberId=` in `backend/routes/me/member/forms.js` (assert `memberId` ∈ caller's household before building prefill)
- Test: `backend/services/__tests__/publicFormInvitationPrefillService.uaTier.test.js`, `backend/routes/__tests__/member-forms.prefill.test.js` (DB mocked)

- [ ] Failing Jest: prefill includes `uaTier` from a mocked enrollment; prefill endpoint 403s when `memberId` not in household, 200 with payload when it is.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task A4: Wrap public form route in AuthProvider + signed-in detection ✅ DONE
**Files:**
- Modify: `frontend/src/App.tsx` (wrap `/forms/:formId` route element in `<AuthProvider>`, mirroring the invitation route)
- Modify: `frontend/src/pages/public/PublicFormPage.tsx` (read `useAuth`; compute `signedInMember = isAuthenticated && user.userType==='Member'`; pass down)
- Test: `frontend/src/pages/public/__tests__/PublicFormPage.signedin.test.tsx`

- [ ] Failing Vitest: anonymous render = no profile/household fetch (no autofill UI); signed-in Member render triggers household fetch.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task A5: "Who is this for?" selector + apply prefill ✅ DONE
**Files:**
- Create: `frontend/src/components/public/WhoIsThisForSelect.tsx` (lists household from `GET /api/me/member/household`; default self)
- Create/Modify: a hook `frontend/src/hooks/member/usePriorFormPrefill.ts` (fetch `/api/me/member/forms/prefill?memberId=`) 
- Modify: `frontend/src/pages/public/PublicFormPage.tsx` / `PublicFormView.tsx` (render selector at top of About-You in signed-in mode; on select, set `initialValues` via `mapPrefillToInitialValues`; fill relation from selected member)
- Test: `frontend/src/components/public/__tests__/WhoIsThisForSelect.test.tsx`

- [ ] Failing Vitest: selecting a child loads that member's prefill into the About-You fields and sets relation=child.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task A6: Anti-tamper on signed-in submit ✅ DONE
**Files:**
- Modify: `backend/routes/me/member/forms.js` (on signed-in submit, re-derive prefill for the household-validated `forMemberId` and overwrite identity fields — extend existing `forms.js:197` pattern to honor a selected member, not just `invitation.memberId`)
- Test: `backend/routes/__tests__/member-forms.submit-antitamper.test.js`

- [ ] Failing Jest: a payload with spoofed `firstName` for a selected household member is overwritten with the server copy; non-household member rejected.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task A7: Set canonical member keys on the two live [NEW] forms (data) ✅ DONE (testing)
**Files:**
- Create: a reviewable Node migration (`ai_scripts/` or `sql-changes/`) that reads each form's published `DefinitionJson`, renames the About-You demographic fields to canonical keys (`ay_dob→dateOfBirth`, `ay_addr_street→addressLine1`, `ay_addr_city→addressCity`, `ay_addr_state→addressState`, `ay_addr_zip→addressZip`, relation→`relationToPrimary`, `req_ua_tier→uaTier`), and writes back. Dry-run/preview by default.
- Modify: `docs/forms/signed-in-autofill-migration-log.md`

- [ ] First read the live definitions (read-only) to confirm exact current field names + that no internal references break.
- [ ] Write the migration with a dry-run preview. **STOP — confirm exact ops + affected rows with Amar before running against testing.** Log it.

---

## Phase B — Suggested providers (continues NPI/fax work, same branch)

### Task B1: `prior-providers` endpoint ✅ DONE
**Files:**
- Create: route `GET /api/me/member/forms/prior-providers?memberId=` in `backend/routes/me/member/forms.js`
- Create: `backend/services/priorProviderService.js` (query `oe.Providers` ⨝ `oe.ShareRequestProviders` ⨝ `oe.ShareRequests` by `HouseholdId`+vendor; return `NpiProvider`-shaped rows incl. `fax`,`taxId`,`role`,`lastUsedDate`, deduped)
- Test: `backend/services/__tests__/priorProviderService.test.js`

- [ ] Failing Jest: returns deduped providers for the household; empty for a member with no history; household auth enforced.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task B2: "Your providers" suggestions in the provider field ✅ DONE
**Files:**
- Modify: `frontend/src/components/public/fields/ProviderSearchField.tsx` (when signed in, show "Your providers" section above NPI search; selecting one sets the `provider_search` value — fax rides on it — and fills the paired Tax-ID field per `PROVIDER_TAX_ID_PAIRS`)
- Create: hook `frontend/src/hooks/member/usePriorProviders.ts`
- Test: extend `frontend/src/components/public/fields/__tests__/ProviderSearchField.test.tsx`

- [ ] Failing Vitest: signed-in with history shows suggestions; selecting fills value incl. fax; anonymous shows only live search.
- [ ] Run → fail. Implement. Run → pass. Commit.

---

## Phase C — Drafts, file staging & admin "In Progress" tab

### Task C1: Migrations — drafts + draft files tables ✅ DONE (testing)
**Files:**
- Create: `sql-changes/allaboard365/2026-05-29-public-form-drafts.sql` (`oe.PublicFormDrafts`: DraftId PK, TenantId, FormTemplateId, OwnerUserId, ForMemberId, HouseholdId, PayloadEncrypted/Iv/AuthTag, CreatedDate, UpdatedDate; unique active per Owner+ForMember+Template)
- Create: `sql-changes/allaboard365/2026-05-29-public-form-draft-files.sql` (`oe.PublicFormDraftFiles`: DraftFileId PK, DraftId FK, FieldName, OriginalFileName, BlobPath, ContentType, SizeBytes, CreatedDate)
- Modify: migration log

- [ ] Write both SQL files (idempotent `IF NOT EXISTS`). Log them. **STOP — confirm with Amar before running against testing.**

### Task C2: Draft service + autosave endpoints ✅ DONE
**Files:**
- Create: `backend/services/publicFormDraftService.js` (create/get-active/patch/delete; encrypt payload with existing scheme; household auth)
- Create: routes in `backend/routes/me/member/forms.js`: `POST /drafts`, `GET /drafts/active?formTemplateId=&forMemberId=`, `PATCH /drafts/:draftId`, `DELETE /drafts/:draftId`
- Test: `backend/services/__tests__/publicFormDraftService.test.js`

- [ ] Failing Jest: create→patch→get round-trips encrypted payload; one active draft per (owner,forMember,template); delete removes row.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task C3: File staging endpoints + promote-on-submit ✅ DONE
**Files:**
- Create: `POST /drafts/:draftId/files` (multipart single; upload to `drafts/{draftId}/{draftFileId}` blob; insert `PublicFormDraftFiles`) and `DELETE /drafts/:draftId/files/:draftFileId` in `backend/routes/me/member/forms.js`
- Modify: signed-in submit path to promote staged blobs into the submission and delete the draft + draft-file rows (reuse `createSubmissionFromPublicRequest` + `uploadToAzureBlob` helpers)
- Test: `backend/routes/__tests__/member-forms.draft-files.test.js` (Azure mocked)

- [ ] Failing Jest: staging inserts a row + blob; submit promotes + clears draft; delete purges blob+row.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task C4: Frontend autosave + "Leave & save" ✅ DONE
**Files:**
- Modify: `frontend/src/components/public/PublicFormView.tsx` (signed-in: debounced PATCH autosave on blur/idle; lazy-create draft on first input; stage files via the file endpoint; resume prompt when an active draft exists)
- Create: `frontend/src/components/public/LeaveAndSaveButton.tsx` (+ confirm modal) and a `beforeunload` backstop
- Create: hook `frontend/src/hooks/member/useFormDraft.ts`
- Test: `frontend/src/components/public/__tests__/PublicFormView.draft.test.tsx`

- [ ] Failing Vitest: typing triggers debounced save; "Leave & save" opens modal then navigates; resume loads saved payload.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task C5: Admin "In Progress" tab ✅ DONE
**Files:**
- Modify: `frontend/src/pages/tenant-admin/TenantSharingFormsLayout.tsx` (add third NavLink "In Progress" → `${routeBase}/drafts`)
- Modify: `frontend/src/App.tsx` (nested route `sharing-forms/drafts` → `TenantSharingDraftsPage`, under both tenant-admin and vendor layouts)
- Create: `frontend/src/pages/tenant-admin/TenantSharingDraftsPage.tsx` (list: member, who-for, form, created/updated, age badge, file count, total size; view + delete)
- Create: admin routes — list/get/delete drafts in `backend/routes/me/vendor/public-forms.js` (+ tenant-admin mirror); scoped + `requireTenantAccess`
- Test: `backend/routes/__tests__/vendor-drafts.test.js`, `frontend/src/pages/tenant-admin/__tests__/TenantSharingDraftsPage.test.tsx`

- [ ] Failing tests: admin list returns scoped drafts; delete purges draft + blobs; tab renders and is tenant-isolated.
- [ ] Run → fail. Implement. Run → pass. Commit.

---

## Done-when
- Anonymous form flow byte-for-byte unchanged (regression check).
- Signed-in: About-You autofills for self + any household member; relation + UA tier fill; provider suggestions appear; drafts autosave, resume, and promote on submit; admin tab lists/deletes drafts incl. their blobs.
- All new tests pass; migration log reflects what was applied to testing.
