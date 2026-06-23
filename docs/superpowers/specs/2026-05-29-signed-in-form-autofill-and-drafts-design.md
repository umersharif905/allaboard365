# Signed-in Form Autofill, Suggested Providers & Drafts — Design Spec

**Date:** 2026-05-29
**Branch:** `feat/forms/sr-required-fields-and-npi-fax`
**Status:** Approved design — ready for implementation plan
**Applies to:** the combined Share Request form and the Out-of-Network Copay / Preventative Care form (the two public sharing forms).

> Companion file: [`docs/forms/signed-in-autofill-migration-log.md`](../../forms/signed-in-autofill-migration-log.md) tracks every SQL migration so the production migration at PR time mirrors what was applied to `allaboard-testing`.

---

## 1. Goal & guiding principle

Make the Share Request and Preventative forms **auto-fillable and resumable for a signed-in member**, while leaving the anonymous experience exactly as it is today.

**Guiding principle — everything keys off "is a Member signed in *in this browser session*."**

- **Anonymous visitor:** identical to today. No autofill, no drafts, no provider suggestions. No new network calls, no redirect.
- **Signed-in Member:** enhanced — personal-info autofill (for self *or* a household member), suggested providers from their own history, and silent draft autosave with resume.

Both forms are public-facing today and are expected to move behind member login in ~1–2 months. Because every enhancement is gated on session presence, the same code serves both eras — when the forms move into the member portal, the "anonymous" branch simply stops being exercised. **No member-portal forms page is required for this work to function**; that surface is future and out of scope here.

---

## 2. Background — what already exists (verified)

- **Three link modes** on a submission via `oe.PublicFormSubmissions.AuthMode` (`anonymous` / `targeted` / `authenticated`) + optional `InvitationId`. Anonymous = public link; targeted = personal link (member pre-bound, no login); authenticated = secure link (login required).
- **Prefill service** `backend/services/publicFormInvitationPrefillService.js` → `buildPrefillForMember({ memberId, tenantId })` returns 12 well-known keys from `oe.Members` ⨝ `oe.Users`. **Currently only invoked on the authenticated (secure-link) path** (`backend/routes/me/member/forms.js:133,193`).
- **Frontend mapper** `frontend/src/pages/public/InvitationFormPage.tsx:284` `mapPrefillToInitialValues` matches prefill→fields by **field `type`** for `first_name/last_name/email/tel/member_id`, and by **exact field `name`** for everything else. This is why DOB/address/relation do **not** fill today (their names `ay_dob`, `ay_addr_*`, `field_…` ≠ the well-known keys `dateOfBirth`/`addressLine1`/…).
- **Household model:** `oe.Members.HouseholdId` groups a family; `RelationshipType` ∈ {`P`=Primary, `S`=Spouse, `C`=Child} is stored per member. `GET /api/me/member/household` (`backend/routes/me/member/household.js`) already returns every household member with name/DOB/address/relation. Dependents usually have no real login (children get `dependent-{uuid}@noemail.com`), so the **only** way to fill a child's info is the primary selecting them.
- **Provider history (household-scoped):** every `provider_search` answer on a past share request is persisted in `oe.Providers` ⨝ `oe.ShareRequestProviders` (role-tagged) ⨝ `oe.ShareRequests`, including **NPI, Tax ID, fax, phone, address**. The dedup query `findOrCreateProviderForFormValue` (`backend/services/publicFormShareLinkService.js:362-378`) already reads this history by `HouseholdId`.
- **UA / Unshared Amount:** not a per-member column. It is the member's chosen pricing tier carried in their **active enrollment's "Unshared Amount" config** (`oe.Enrollments` config JSON; resolution logic exists at `backend/services/shareRequestService.js:1594`, "prefer enrollments that carry an Unshared Amount config field"). Tier values are the relabeled `1500 / 2500 / 5000`.
- **Drafts:** **nothing exists.** No draft state on submissions, no frontend persistence (`PublicFormView` holds everything in `useState`, no localStorage / `beforeunload`), files upload to Azure blob only on final submit (in-memory multer), and the member portal has no forms page or "my submissions" endpoint.
- **Back-office forms tabs:** `frontend/src/pages/tenant-admin/TenantSharingFormsLayout.tsx` renders `Forms` (`routeBase`) and `Submissions` (`routeBase/submissions`) NavLinks driven by `usePublicFormsContext().routeBase`; the layout is reused by both tenant-admin and vendor (`App.tsx:581` and `:684`).

---

## 3. Known bug this design fixes

The existing authenticated-invitation prefill always fills from `invitation.memberId` — i.e. whoever the form was *sent to*. There is **no person selection**, so a share request meant for a spouse/child is silently prefilled with the **primary's** identity. The "Who is this for?" selector (§4.2) fixes this for the new autofill path; the same fix should be applied to the existing invitation path (noted in §8).

---

## 4. Phase A — Signed-in autofill + "Who is this for?"

### 4.1 Session detection

- Wrap the public form route `/forms/:formId` in `<AuthProvider>` (same precedent as the invitation route, `App.tsx:231-235`). `AuthProvider` is a no-op for anonymous visitors (no token → `setIsLoading(false)`, no network call, no redirect — `AuthContext.tsx:134-159`).
- `PublicFormPage` reads `useAuth()`. **Signed-in mode** = `isAuthenticated && user.userType === 'Member'`. Anything else → today's anonymous behavior.

### 4.2 "Who is this for?" selector

- In signed-in mode, render a selector at the top of the "About You" page populated from `GET /api/me/member/household` (existing): self + spouse + children, each labeled with name and relation.
- On selection, fetch that member's prefill (§4.3) and populate the About You fields. Default selection = the signed-in member (self).
- The selected member's `RelationshipType` (P/S/C) auto-fills the **"Relation to primary member"** field (→ self/spouse/child).

### 4.3 Prefill endpoint & payload

- **New endpoint:** `GET /api/me/member/forms/prefill?memberId=<id>` (authenticated, Member role).
- **Authorization:** the requested `memberId` MUST belong to the signed-in user's household (resolve household via the user's own member rows, then assert membership). Reject otherwise.
- **Payload:** extends `buildPrefillForMember` keys with **`uaTier`**, derived from the selected member's active enrollment Unshared Amount config (reuse the resolution approach in `shareRequestService.js:1594`; return `null` if none). Full key set: `firstName, lastName, email, phone, memberId, dateOfBirth, relationToPrimary, addressLine1, addressLine2, addressCity, addressState, addressZip, uaTier`.

### 4.4 Field → concept binding (Architecture choice 1 — `prefillKey`)

- Add an **optional `prefillKey` property** to the field definition type (`frontend/src/types/publicFormDefinition.ts`). It names the well-known prefill concept a field maps to (e.g. `ay_dob.prefillKey = 'dateOfBirth'`, `ay_addr_zip.prefillKey = 'addressZip'`, relation select `.prefillKey = 'relationToPrimary'`).
- Mapper precedence in `mapPrefillToInitialValues` becomes: **explicit `prefillKey` → semantic type (`first_name/last_name/email/tel/member_id`) → exact field `name`**.
- A field's `type` and validation are unchanged (a `date` field stays a `date` field). This is form-author-controllable and generalizes to future forms.
- **Data migration:** set `prefillKey` on the relevant fields of the two existing published form definitions (DefinitionJson on `oe.PublicFormTemplateVersions`). See migration log.
- (Editor support for setting `prefillKey` in `TenantSharingFormEditorPage` is a follow-up nicety, not required for this work — existing forms are migrated directly.)

### 4.5 Anti-tamper on submit

- On a signed-in submit, the server re-derives the prefill for the selected (household-validated) member and overwrites the identity fields in the payload (same pattern as `forms.js:197`), so a tampered POST cannot spoof another member's identity. The free-text/answer fields (narrative, dates, files) are taken from the payload as submitted.

### 4.6 Out of scope for Phase A

- Auto-filling banking / direct-deposit (sensitive; member re-enters — see §7).
- SSN (never auto-filled).

---

## 5. Phase B — Suggested providers from member history

> **Builds on the existing NPI/fax work on this branch** (uncommitted but complete): fax now rides on the `provider_search` value itself (NPPES `fax_number` forwarded by `publicNpiSearch.service.js` → stored on the whole result by `ProviderSearchField.tsx`), the standalone `req_pcp_fax` field was removed, and `ManualProvider` (`frontend/src/types/providerSearch.ts`) carries full detail (NPI, phone, fax, address2, providerType). Phase B continues this work on the same branch — no merge wait.

- **New endpoint:** `GET /api/me/member/forms/prior-providers?memberId=<id>` (authenticated, Member; household + vendor scoped). Returns a deduped list shaped like the existing `NpiProvider` value (so a suggestion drops straight into the field): `{ name, npi, taxId, fax, phone, address1, address2, city, state, zip, providerType, role, lastUsedDate }`. Query joins `oe.Providers` ⨝ `oe.ShareRequestProviders` ⨝ `oe.ShareRequests` filtered by `HouseholdId` and vendor (reuse the existing query shape).
- **Vendor scope:** provider history is vendor-scoped; resolve the vendor for the member's context the same way the SR auto-create path does.
- **Frontend:** when signed in, the provider-search field shows a **"Your providers"** section above live NPI search. Selecting a suggestion populates the `provider_search` value — which now natively carries fax (no separate fax field) — and fills the paired **Tax ID** text field (`PROVIDER_TAX_ID_PAIRS` still applies). Anonymous visitors, or members with no history, get today's plain NPI search (graceful fallback).
- **Constraint (per product decision):** only providers actually linked to the household are suggested — no broader recommendations.

---

## 6. Phase C — Drafts, Azure file staging & admin "In Progress" tab

> Largest, all-new subsystem. Gated on signed-in mode.

### 6.1 Draft storage (Architecture choice 2 — separate tables)

- **New table `oe.PublicFormDrafts`** — keeps completed submissions untouched (existing submission queries/exports/SR-linkage don't change). Columns (final names in migration):
  - `DraftId` (UNIQUEIDENTIFIER, PK)
  - `TenantId`, `FormTemplateId`
  - `OwnerUserId` (the signed-in user) and `ForMemberId` (the household member the form is *for* — supports the "who is this for" case)
  - `HouseholdId` (denormalized for admin scoping/queries)
  - `PayloadEncrypted`, `PayloadIv`, `PayloadAuthTag` (same encryption scheme as submissions)
  - `CreatedDate`, `UpdatedDate`
- **New table `oe.PublicFormDraftFiles`** — staged uploads:
  - `DraftFileId` (PK), `DraftId` (FK), `FieldName`, `OriginalFileName`, `BlobUrl`/`BlobPath`, `ContentType`, `SizeBytes`, `CreatedDate`.
- **One active draft per (OwnerUserId, ForMemberId, FormTemplateId).**

### 6.2 File staging on Azure (Architecture choice 3 — stage & promote)

- When a signed-in member attaches a file, upload it immediately to a draft-scoped blob path `drafts/{draftId}/{draftFileId}` via **`POST /api/me/member/forms/drafts/:draftId/files`** (multipart, single file); record a `PublicFormDraftFiles` row. The draft payload references staged file IDs, not the file bytes.
- **`DELETE /api/me/member/forms/drafts/:draftId/files/:draftFileId`** removes a staged file (blob + row).
- **On final submit:** the submission re-points to the staged blobs (mark permanent / move out of the `drafts/` prefix as implementation dictates), the draft row + draft-file rows are deleted. Reuse the existing `createSubmissionFromPublicRequest` submission path for everything else.
- **On draft delete (member discard or admin):** purge draft row, draft-file rows, and all staged blobs.
- This is what lets a member leave for a day or two (e.g. to get PCP records) and resume **on any device** — the blocker the whole feature targets.

### 6.3 Autosave & resume

- **Lazy create:** a draft is created on first meaningful input (or first file attach) while signed in.
- **Autosave:** debounced **`PATCH /api/me/member/forms/drafts/:draftId`** (on blur / ~1–2s idle) writing the encrypted payload + staged-file reference list.
- **Resume:** when a signed-in member opens the form and an active draft exists for (member, form), prompt **"Resume where you left off?"** → load payload + staged files into the form.

### 6.4 "Leave & save" UX (per product decision)

- Silent autosave once signed in — no explicit save button needed for saving.
- A **persistent "Leave & save" button** gives an exit affordance (don't rely on the user closing the tab). Clicking it opens a modal: *"Your progress is saved — you can return anytime from your account."* then navigates away.
- A `beforeunload` guard is a secondary backstop only.

### 6.5 Admin "In Progress" tab (Vendor admin back office)

- **New third tab** in `TenantSharingFormsLayout.tsx`, labeled **"In Progress"**, route `routeBase/drafts` → new page `TenantSharingDraftsPage`. Because the layout is shared, the tab appears in both tenant-admin and vendor contexts, each backed by its own API scope; the **primary target is the vendor admin back office**.
- **List columns:** member (owner), who-it's-for, form, created, last updated, **age badge**, file count, total file size.
- **Actions:** view (read-only payload + staged files) and **delete** (purges draft + staged blobs).
- **Retention is manual-only (per product decision)** — there is **no auto-purge job**. Storage hygiene is admin-driven; the age/size columns + sort-by-oldest/largest make stale, file-heavy drafts easy to find and clear.
- **New endpoints** under `backend/routes/me/vendor/` (and tenant-admin mirror): list drafts (scoped), get one draft, delete a draft. Tenant isolation via `requireTenantAccess`; vendor scope per existing vendor route conventions.

---

## 7. Security & data-handling rules

- **Never auto-fill:** SSN, and the Direct Deposit block (account holder, bank, account type, routing, account number). These exist (`oe.MemberDirectDeposits`, encrypted) but must be re-entered — auto-filling banking is a PCI/security regression.
- **Household authorization** is enforced server-side on every prefill, prior-provider, and draft operation: the acting user may only read/fill/save for members in their own household.
- **Draft payloads** are encrypted at rest using the same scheme as submissions.
- **Tenant isolation** (`requireTenantAccess`) on all new admin/member routes — never bypassed.

---

## 8. Cross-cutting: logging & migrations

- **Spec doc:** this file.
- **Migration log:** `docs/forms/signed-in-autofill-migration-log.md` — every SQL file, what it does, and whether it has been applied to `allaboard-testing`, so the prod migration at PR time mirrors it exactly.
- **SQL files** live in `sql-changes/allaboard365/` per convention.
- **DB write policy:** each SQL file is authored and logged first; it is run against **testing only**, with a one-line confirmation per migration, and never against production from here. Every executed migration is recorded in the log with date + effect.
- **Apply the spouse/child fix to the existing invitation prefill path** (§3) as part of this work, not just the new autofill path.

### Anticipated migrations (final names/columns set during implementation)

1. **Data migration** — set `prefillKey` on the About-You fields (DOB, address ×4, relation) of the two published form definitions (`oe.PublicFormTemplateVersions.DefinitionJson`).
2. **DDL** — create `oe.PublicFormDrafts`.
3. **DDL** — create `oe.PublicFormDraftFiles`.

---

## 9. Phasing / ship order

1. **Phase A** — highest value, lowest risk (one data migration; mostly additive frontend/backend). Includes the §3 invitation-path fix.
2. **Phase B** — continues the existing NPI/fax work already on this branch; small and self-contained.
3. **Phase C** — largest, all-new subsystem (2 DDL migrations, blob staging, admin tab).

Each phase is independently shippable but tracked and PR'd together under this spec.

---

## 10. Out of scope

- Member-portal forms listing page / "my submissions" page (future surface).
- Auto-purge / retention job for drafts (explicitly manual-only for now).
- Form-editor UI for setting `prefillKey` (existing forms migrated directly).
- Any change to anonymous-visitor behavior.
