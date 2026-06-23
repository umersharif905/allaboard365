# Forms redesign — followup design

**Date:** 2026-05-13
**Branch (proposed):** `feat/back-office/forms-redesign-followup` (off `staging`)
**Status:** scope locked 2026-05-13 (session 3). Ready for implementation.
**Predecessor:** `docs/superpowers/specs/2026-05-13-forms-redesign/` (see
`progress.md` in that folder for what shipped and what didn't).

---

## Summary

The original forms-redesign spec ships Phases 0–4 in code but leaves five
surfaces partially built or unstarted: multi-submission grouping, the
member-workspace folder structure, retroactive linkage, identity-discrepancy
display, and the submissions queue (filters + a then-new notification ask).

After post-implementation review, scope tightened. **In:** surface polish
(Slice A), member-workspace folder restructure (Slice B), submissions
filters (Slice C.1), editor soft-warning (Slice E.1), VendorAdmin
publish/delete (new Slice F — B-001 confirmed). **Out, deferred elsewhere:**
care-team notification system, retroactive linkage panel + endpoint, UA+PC
grouping, and `AdditionalDocuments` hide.

### Where deferred items land

| Deferred | Goes to |
|---|---|
| C.2 care-team notification on new submission | New blocker B-004 → eventually surfaces on care-team dashboard (separate backlog effort) |
| D.1 PATCH linkage endpoint | Broader form-page UI redesign (later spec) |
| D.2 retroactive linkage panel | Broader form-page UI redesign |
| D.3 extracted linkage picker | Broader form-page UI redesign |
| E.2 UA+PC "Share Request Intake" grouping | Absorbed by form-editor redesign (`2026-05-13-form-editor-redesign-design.md`) |
| 043 `AdditionalDocuments` hide | Form-editor redesign |
| Member-facing portal `pages/member/Documents.tsx` | Tracked as blocker B-003 |

---

## Locked-in design decisions

1. **Five active slices.** A / B / C.1 / E.1 / F. Each is a self-contained
   PR-sized chunk; they're independent except where called out. Slice F is
   net-new from review: VendorAdmin publish/delete (B-001 confirmed YES).
2. **Reuse the existing schema.** No new tables, no new columns. All work
   in this spec is UI-side or trivial reads from existing tables.
3. **No notification system in this followup.** C.2 deferred to a separate
   backlog item (B-004) that will eventually land on the care-team
   dashboard.
4. **No retroactive linkage work in this followup.** All of Slice D
   (endpoint + panel + extracted picker) deferred to the broader form-page
   UI redesign so the linkage UX is designed holistically once.
5. **Member-workspace folder structure (Slice B) is the highest-impact UX
   item** and is sliced separately so it can ship first if needed.
6. **A.1 revoke button lives in two places** — both the inline member
   workspace "Form submissions" folder AND a separate "Invitations"
   sub-page per template. Care team needs both contexts (per-member view
   and per-template audit).
7. **Verification posture: fast iteration.** Manual browser testing,
   opportunistic Cypress fixes only if regressions surface. No new
   Cypress specs scaffolded in this slice.

---

## Slice A — Surface polish (submissions list + revoke + grouping + discrepancy)

Low-risk visual polish, mostly frontend. Shippable as one small PR.

### A.1 — Frontend revoke button on invitations

**Plain-English:** "Revoke" means **setting an invitation's expiration
early** so the recipient can't fill out the form anymore. The backend
DELETE endpoint already does this (`RevokedAt = SYSUTCDATETIME()` →
recipient link returns 410 Gone). The frontend just needs the button.

#### Where (BOTH surfaces — locked from review)

Two complementary places. The care team needs both contexts:

- **A.1.a — "Invitations" sub-page per template** in
  `TenantSharingFormsPage` and vendor mirror. Lists every invitation
  ever sent against the selected template, sorted newest-first. Each row
  shows recipient, mode, sent date, status (active / used / revoked /
  expired), and a Revoke button when active. Useful for per-template
  audit: "who has this form pending?"
- **A.1.b — inline on member workspace "Form submissions" folder**
  (per Slice B). Shows the member's pending / unused invitations as
  their own visual row above the submissions list, each with a Revoke
  control. Useful for per-member context: "what have I sent this
  member?"

Both read from `oe.PublicFormInvitations` filtered on the relevant
scope (TemplateId for A.1.a, MemberId for A.1.b). No new backend
endpoints if the existing `GET /api/me/{vendor|tenant-admin}/public-forms/templates/:id/invitations`
list (added in the predecessor) is reused for A.1.a; A.1.b needs a
small `GET /api/me/{vendor|tenant-admin}/members/:memberId/form-invitations`
to filter per-member.

#### Behavior

- Revoke button visible only when `RevokedAt IS NULL AND ExpiresAt > NOW`
  (i.e. the invitation is still active).
- Confirmation modal: "Revoke this invitation? The recipient won't be able
  to open the form. Existing submissions are kept."
- On confirm: call `DELETE
  /api/me/{vendor|tenant-admin}/public-forms/invitations/:invitationId`.
  Row UI updates inline ("Revoked at HH:MM"). The recipient's next page
  load returns 410.

#### Out of scope

- "Unrevoke" — schema doesn't support it (RevokedAt is one-way today).
  Care team must re-issue a new invitation.

### A.2 — Multi-submission grouping with date+time + "Latest" chip

**Goal:** when a recipient submits the same form multiple times against
the same invitation, give the care team an at-a-glance read on **which
one is newest**.

#### Behavior

- Group submissions by `InvitationId` in the UI **only**. No data-side
  change. A group renders as a single collapsed row labeled
  "{FormTitle} — N submissions"; clicking expands to show all submissions
  sorted newest-first.
- Direct submissions (no `InvitationId`, e.g. anonymous resolved) appear
  flat alongside grouped rows.
- The **newest submission within a group** gets a "Latest" chip rendered
  to the right of its date+time stamp.
- **Date+time stamp on every submission row** — both grouped and flat.
  Today the SR Documents-and-Forms section + the member workspace
  forms section show a date only. Add time (local time zone of the
  viewer, "Mar 15, 2026 · 2:14 PM" or similar).

#### Where this renders

Three places where same-invitation grouping applies:

1. Care-team submissions list page (`TenantSharingSubmissionsPage` +
   vendor mirror).
2. SR workspace → Documents and Forms tab → "Forms linked to this share
   request" section.
3. Member workspace → Documents tab → per-SR folder + "Form submissions"
   folder (per Slice B).

### A.3 — Membership data discrepancy display ("parens diff")

**Goal:** when an auto-resolved submission's payload identity fields
(name / email / phone) differ from the resolved member's profile, surface
both values side-by-side so the care team can spot mismatches.

#### Behavior

- Only relevant for submissions that **auto-resolved from a member-submitted
  identity field**. (Targeted/authenticated submissions are pinned to a
  member up-front; no discrepancy possible since the server is
  authoritative.)
- Format: account value first, payload value in parens after, only when
  they differ. No parens when they match.

  ```
  Sarah Johnson (Sarah Jonson) · sarah@example.com (sara@example.com) · (555) 123-4567
  ```

- Compare:
  - `oe.Users.FirstName + LastName` vs `oe.PublicFormSubmissions.PayloadFirstName + PayloadLastName`
  - `oe.Users.Email` vs `oe.PublicFormSubmissions.PayloadEmail`
  - `oe.Users.PhoneNumber` vs `oe.PublicFormSubmissions.PayloadPhone`
- **Normalize all three before comparing** so cosmetic formatting
  differences don't trigger parens:
  - Phone: strip all non-digit characters
  - Email: lowercase
  - Name: trim, collapse internal whitespace, case-insensitive
  Parens render only when normalized values differ. Display values are
  the original (non-normalized) strings.
- Schema-side: the `Payload*` columns already exist as of
  `2026-05-13-forms-redesign.sql`. No DB work needed.

#### Render in two places

1. **Share request page** where the submission is linked (per the original
   spec).
2. **Form submission detail page itself** — added in this followup. Same
   format. Lives in the membership column / panel of the detail view.

#### Pure-frontend implementation

Small utility: `formatNameWithDiff(account, payload)`,
`formatEmailWithDiff(...)`, `formatPhoneWithDiff(...)`. Used by both
render sites.

---

## Slice B — Member workspace folder restructure

The highest-impact piece. Currently the member workspace Documents tab
shows forms as a flat list below the docs table. Target structure:

### B.1 — Folder hierarchy

Sidebar layout in `MemberDocumentsTab` (vendor side; tenant-admin doesn't
have an equivalent today):

- **Per-share-request folder** — one folder per share request the member
  has. Folder name = the SR's request number (or short title).
  Folder contents = both the SR-attached document files (existing) AND
  any form submissions where
  `oe.PublicFormSubmissions.ShareRequestId = :srId`.
- **Per-case folder** — schema-ready; doesn't render until `oe.Cases`
  ships. Same pattern as SR folders when that lands.
- **"Form submissions" folder (new)** — flat consolidated view of **every**
  form submission for this member, regardless of linkage. This folder
  appears as a sibling to the per-SR folders in the sidebar.

### B.2 — Critical isolation rule

A form submission linked to SR #7 must appear:

- ✅ Inside the SR #7 folder.
- ✅ Inside the "Form submissions" folder (consolidated view).
- ❌ NOT inside SR #6, SR #8, or any other SR folder.

This was the design intent of the original spec but is NOT currently
enforced — the flat-list rendering ignores linkage. Slice B fixes that.

### B.3 — Backend shape

Option 1 (reshape existing endpoint): Extend
`GET /api/me/vendor/members/:memberId/documents` to return:

```json
{
  "folders": [
    {
      "id": "<sr-or-case-id>",
      "kind": "share-request",
      "name": "SR-2026-00734",
      "documents": [...],
      "formSubmissions": [...]
    },
    ...
  ],
  "allFormSubmissions": [...]   // for the "Form submissions" sidebar folder
}
```

Option 2 (keep current shape): leave the documents endpoint alone, keep
the separate `form-submissions` endpoint, and do the folder grouping
client-side. Frontend joins on `ShareRequestId`.

**Locked: Option 2.** Less backend churn; the client already has both
lists. Reshape later if perf demands it.

### B.4 — Multi-submission grouping applies inside folders

Each folder (per-SR, per-Case, or "Form submissions") respects the Slice
A.2 grouping rule: same-invitation submissions collapse into a stack
with a Latest chip. Date+time visible.

---

## Slice C — Submissions queue filters

### C.1 — Filter additions (from original spec)

Add two filters to `TenantSharingSubmissionsPage` + vendor mirror:

- **Resolution status** dropdown — `unresolved` /
  `resolved-not-linked` / `resolved-linked` / `all` (default `all`).
  Helps the care team focus on submissions that auto-resolution didn't
  pin to a member.
- **Source** dropdown — `anonymous` / `targeted` / `authenticated` /
  `all` (default `all`). Reads `oe.PublicFormSubmissions.AuthMode`.

Backend: extend the existing submissions list endpoint's query params
with `resolutionStatus` and `source`. Maps trivially to WHERE clauses.

### C.2 — Care-team notification on new submission (DEFERRED)

**Status:** moved to backlog as blocker **B-004** in
`2026-05-13-forms-redesign/blockers.md`. Will eventually surface on the
care-team dashboard as a "new submissions" signal; needs its own product
conversation (channel, audience, granularity, dedup) and fits naturally
alongside whatever dashboard work happens next.

Not in this followup.

---

## Slice D — Retroactive linkage panel + PATCH endpoint (DEFERRED)

**Status:** all of Slice D (D.1 endpoint, D.2 panel, D.3 extracted
picker) deferred to the broader form-page UI redesign. The redesign
will rework the submission-detail page layout holistically; locking
linkage UX into the current layout now would be churn.

Tracking notes for the future redesign:

- The existing inline picker in `SendToMemberModal` should be extracted
  into a shared `LinkagePicker` component as part of that work.
- Endpoint shape: `PATCH /api/me/{vendor|tenant-admin}/public-forms/submissions/:submissionId/linkage`
  with body `{ shareRequestId?, caseId? }`, mutually exclusive, both
  null clears. Tenant-isolated.
- Panel renders only when `MemberId IS NOT NULL` (un-resolved
  submissions have no member context yet).

Not in this followup.

---

## Slice E — Editor polish

### E.1 — Soft warning when anonymous form lacks identity fields

In the form editor (`TenantSharingFormEditorPage`), after the user
saves a draft or publishes a new version, check the saved definition:

- IF `AllowAnonymous = 1`
- AND the field set has NONE of: `memberId`, `email`, `firstName` +
  `lastName` together, `dateOfBirth`
- THEN show a non-blocking banner above the form definition:

  > *This form allows anonymous submissions but doesn't ask for any
  > identifying information. Submissions to this form may not be
  > resolvable to a member. Consider adding a Member ID field, or limit
  > this form to "Send to member" / "Authenticated" delivery only.*

- Soft warning only — admin can save anyway (legitimate use cases exist:
  shareable feedback forms, e.g.).
- Where: vendor admin + tenant admin sides of the editor (same component,
  reused per `usePublicFormsContext`).
- Detection: parse the definition JSON's `fields` array, check `name`
  against the well-known list.

### E.2 — UA + PC consolidation (DEFERRED)

**Status:** deferred to the form-editor redesign
(`2026-05-13-form-editor-redesign-design.md`). That spec consolidates UA
+ PC into a single screener-driven intake template, which makes the
cosmetic grouping redundant.

Not in this followup.

---

## Slice F — VendorAdmin publish/delete (B-001)

**Status:** product confirmed YES — VendorAdmin should have
publish/delete per original spec §2 / §8 / line 184. Fold here (or ship
as a tiny standalone PR at implementer's discretion).

### F.1 — Backend handlers

Add two route handlers to `backend/routes/me/vendor/public-forms.js`,
mirroring the tenant-admin equivalents and gated on
`authorizeWrite = ['VendorAdmin', 'SysAdmin']`:

- `POST /templates/:formTemplateId/publish` — body identical to
  `routes/me/tenant-admin/public-forms.js`'s version. Tenant isolation
  flows from `attachVendorContext` + the existing per-template tenant
  guard already used on the vendor edit endpoint.
- `DELETE /templates/:formTemplateId` — same shape as tenant-admin
  version. Soft-delete or hard-delete should match whatever
  tenant-admin does today; do not diverge.

The comment in `routes/me/vendor/public-forms.js` that reads "Delete and
publish are intentionally NOT exposed here" is now stale — remove it.

### F.2 — Frontend permission flags

In `frontend/src/hooks/usePublicFormsContext.ts`:

- Flip `canPublish: !isVendorAgent` so it's true for `VendorAdmin` and
  `false` for `VendorAgent`.
- Flip `canDelete: !isVendorAgent` with the same logic.

The buttons themselves render conditionally on these flags in the
editor and the forms list. Once flipped, VendorAdmin gets both buttons;
VendorAgent stays read-only.

### F.3 — Manual verification

Log in as `test@sharewellpartners.com` (VendorAdmin) and confirm
Publish + Delete render and work. Then log in as a VendorAgent flavor
account and confirm both are hidden.

### Why this is in scope here (and not its own PR)

Tiny code change (~15 lines), no schema. Bundling with the followup
saves a separate review cycle. Can split out at implementer's
discretion if it's blocking other slices.

---

## Out of scope (this followup)

Explicitly NOT in this followup spec, with where they go instead:

- **C.2 care-team notification on new submission** → backlog blocker
  B-004; surfaces on the care-team dashboard later.
- **Slice D — retroactive linkage** (PATCH endpoint, panel, extracted
  picker) → broader form-page UI redesign.
- **E.2 UA+PC grouping** → form-editor redesign
  (`2026-05-13-form-editor-redesign-design.md`).
- **`AdditionalDocuments` hide from create-form list (043)** →
  form-editor redesign.
- **Form editor screener-driven branching** → form-editor redesign.
- **Member-facing portal `pages/member/Documents.tsx`** → see blocker
  B-003.
- **Cases feature implementation** → schema is ready; no Cases code in
  this spec.
- **Multi-key encryption for PHI payloads** → see blocker B-002
  (deployment config, not a code gap).

---

## Suggested rollout

The five active slices are independent and can ship as separate PRs or
bundled at implementer's discretion. Verification is manual / fast
iteration per locked decision #7; no Cypress scaffolding owed.

- **Slice A** — ~1–2 days. UI polish: revoke button (BOTH locations),
  multi-submission grouping with date+time + "Latest" chip, discrepancy
  display.
- **Slice B** — ~2–3 days. Member-workspace folder restructure
  (`MemberDocumentsTab.tsx`). Highest UX impact.
- **Slice C.1** — ~half day. Two query params + two dropdowns.
- **Slice E.1** — ~half day. Editor banner.
- **Slice F** — ~half day. ~15-line vendor permission fix (B-001).

Recommended ship order:

1. **F + C.1 + E.1** bundled — smallest, lowest-risk. Unblocks
   VendorAdmin workflow, adds the filter surface, adds the editor
   safety banner.
2. **A** — surface polish across the existing submission/invitation UI.
3. **B** — folder restructure; the big UX win.

---

## Resolved during review (session 3, 2026-05-13)

The open questions from the draft were answered:

| Question | Decision |
|---|---|
| C.2 notification channel + audience + granularity | Defer entirely; new blocker B-004 |
| D.2/D.3 (and D.1) — build here or defer? | Defer all of D to broader redesign |
| E.2 UA+PC grouping — defer or do now? | Defer to editor redesign |
| Verification posture | Fast iteration (same as predecessor) |
| A.1 revoke button location | BOTH (per-template sub-page + per-member inline) |
| B-001 VendorAdmin publish/delete | Confirmed YES → new Slice F here |
