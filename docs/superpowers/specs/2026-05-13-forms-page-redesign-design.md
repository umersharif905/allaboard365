# Forms page redesign — design

**Date:** 2026-05-13
**Status:** scope locked 2026-05-13 (session 3). Ready for
implementation.
**Predecessors:**
- `2026-05-13-forms-redesign/design.md` (Phases 0–4 — shipped in code)
- `2026-05-13-forms-redesign-followup-design.md` (Slices F, A.3 partial,
  A.2 partial, B + A.1.b — shipped in this branch)
- `2026-05-13-form-editor-redesign-design.md` (separate later spec
  covering the editor / create-form screen — out of scope here)

---

## Summary

Redesign the back-office forms and submissions surfaces (vendor portal
+ tenant admin) so they cleanly express everything the
forms-redesign branch has built (delivery modes, invitations,
member-pinned submissions, share-request linkage, resolution status,
payload-vs-profile discrepancies) and pick up the carryover slices
that were deferred from the followup.

Two of today's surfaces also still use Material-UI
(`TenantSharingSubmissionsPage`, parts of
`TenantSharingSubmissionDetailPage`), which violates
`CLAUDE.md`'s "Tailwind CSS ONLY" rule. The migration to Tailwind is
folded into this redesign so the cleanup doesn't ship separately.

Net result: a coherent forms-tab + submissions-tab + submission-detail
surface that exposes the new delivery and linkage concepts, uses the
project's UI stack consistently, and gives the care team
straightforward affordances for the things they actually do (preview a
form, send a form to a member, find an unresolved submission, revoke a
pending invitation, retroactively link a submission to an SR).

---

## Surfaces in scope

| File | Mount points | Today |
|---|---|---|
| `frontend/src/pages/tenant-admin/TenantSharingFormsPage.tsx` | `/tenant-admin/sharing-forms`, `/vendor/sharing-forms` | Tailwind table; works but cramped |
| `frontend/src/pages/tenant-admin/TenantSharingSubmissionsPage.tsx` | `/tenant-admin/sharing-forms/submissions`, `/vendor/sharing-forms/submissions` | **Material-UI** (rule violation); MUI DataGrid + Filters |
| `frontend/src/pages/tenant-admin/TenantSharingSubmissionDetailPage.tsx` | `/.../submissions/:id` | Mostly Tailwind, one MUI `Chip` import |

The vendor portal mounts these exact components — no separate vendor
implementations. Redesign benefits both portals at once.

### Out of scope (this spec)

- **Form editor** (`TenantSharingFormEditorPage`) — covered by the
  separate editor-redesign spec.
- **Recipient-facing pages** (`PublicFormPage`, `InvitationFormPage`)
  — those are the *user* side and were redesigned earlier in this
  branch.
- **Member's OWN portal** (`pages/member/Documents.tsx`) — see
  blocker B-003.
- **Member workspace tab** (`MemberDocumentsTab.tsx`) — already
  redesigned in this branch's Slice B + A.1.b; see B-005 for the
  pending verification.
- **Cases feature implementation** — schema-ready only; no Case code.
- **Care-team notification on new submission** — blocker B-004,
  separate dashboard effort.

---

## Audit — what's been built since the original spec

### Predecessor (Phases 0–4, already shipped)

From `2026-05-13-forms-redesign/features/_inventory.md` and the
session-2 progress doc:

- Delivery-mode flags per template: `AllowAnonymous`, `AllowTargeted`,
  `AllowAuthenticated` (#001)
- `CreatesShareRequestOnSubmit` flag — defaults OFF, opts UA + PC in
  via backfill (#002, #041)
- `PublicFormSubmissions`: `AuthMode`, `InvitationId`, `CaseId`,
  `PayloadEmail`, `PayloadPhone` columns (#003–#005, #032)
- `PublicFormInvitations` table + invitation create / redeem / revoke /
  delivery-method flow (#006, #007)
- Send-to-member modal, 4-step flow (#010)
- Open-SR + Case picker columns (#011)
- Invitation expiry / revocation enforcement (410 Gone) (#021)
- Targeted-mode recipient greeting (#012)
- Authenticated submission flow + member-match check + prefill
  service (#022–#025, #027)
- Auto-resolver runs on submit (#031)
- SR DocumentsTab → "Documents and Forms" + form-submissions endpoint
  (#030)
- VendorAgent Phase 0 read access (#044)

### Followup (shipped on this branch, sessions 2–3)

- **Slice F** (commit `8d40886e`): VendorAdmin publish/delete unlocked
  on the vendor portal.
- **Slice A.3 partial** (commit `aadc7f09`): payload-vs-profile
  discrepancy parens on the SR Documents-and-Forms section, normalized
  comparison (phone digits-only, email lowercase, name
  case-insensitive).
- **Slice A.2 partial** (commit `a8d45445`): submission grouping by
  `InvitationId` with date+time stamp and "Latest" chip on the SR
  Documents-and-Forms section and the member workspace forms section.
- **Slice B + A.1.b** (commit `777e0ea7`): member-workspace folder
  hierarchy (per-SR + consolidated "Form submissions") with strict
  isolation rule + inline pending-invitations row with Revoke.

### Concepts NOT yet expressed on the forms-page surfaces

Each of these is real data in the system but invisible on the back-office
forms/submissions UI today:

| Concept | Where it lives | Where it should surface |
|---|---|---|
| Delivery-mode flags | `oe.PublicFormTemplates` 4 bits | Forms tab row, Submission detail header |
| `CreatesShareRequestOnSubmit` flag | Template column | Forms tab row (info badge) |
| AllowAnonymous-without-identity-fields warning | Editor warning (E.1 deferred) | Forms tab row (warning badge) |
| Invitations sent for a template | `PublicFormInvitations` | Per-template Invitations sub-page (A.1.a) |
| Resolution status (unresolved / resolved-not-linked / resolved-linked) | Computed from `MemberMatchStatus` + `ShareRequestId` | Submissions tab filter + row badge |
| Source / AuthMode (anonymous / targeted / authenticated) | `s.AuthMode` | Submissions tab filter + row badge |
| Multi-submission groupings | `s.InvitationId` | Submissions tab row collapse |
| Discrepancy parens on submission detail | `Payload*` vs resolved member | Submission detail membership panel |
| Retroactive linkage to SR / Case | Schema supports, no UI / endpoint yet | Submission detail "Linkage" panel |

---

## Audit — problems with the current UI

(a) **Material-UI on the submissions list violates project rules.**
`TenantSharingSubmissionsPage` imports from `@mui/material` and
`@mui/x-data-grid`. Per CLAUDE.md: "Tailwind CSS ONLY — no Material-UI."

(b) **Forms tab "Public link" column is cramped.** It crams the URL,
an Open button, and a conditional "Send to member" button into one
cell, with `<code>` rendering of the full URL. Visual weight is
disproportionate to importance.

(c) **No filtering on the forms list.** Once a tenant has 10+
templates, finding one means eyeballing the table.

(d) **No preview affordance.** Today's only "View" is actually the
Edit link when `canEdit === false`. A user with edit rights has no
way to preview a form before sending it — the only options are
"navigate to editor and look at the canvas" (which mixes preview with
edit chrome) or "open the public anonymous URL" (which doesn't work
for send-to-member-only templates).

(e) **Submissions page filters are dense but miss the new concepts.**
Today's filters: date range, template, first name, last name,
keyword. Missing: resolution status, source/AuthMode.

(f) **Delivery modes are invisible.** A tenant admin who shipped a
"send-to-member only, authenticated only" template has no badge on
the row indicating this — they have to click into the editor.

(g) **Two action paradigms on one row.** Forms tab today: inline
Open/Send buttons in one cell, Edit/Activate/Deactivate/Delete in a
trailing actions column. No clear hierarchy.

(h) **Submission detail uses MUI `Chip`.** One import, but it's an
inconsistency that should land in the same redesign.

---

## Forms tab redesign

### Goals

1. Express delivery modes per template at a glance.
2. Always-visible **View** button — preview-mode, no submit — on every
   row regardless of delivery mode.
3. Cleaner action grouping; retire the cramped "Public link" column.
4. Add filtering and search.
5. Surface the per-template Invitations sub-page (A.1.a).
6. Show warning indicators where applicable
   (CreatesShareRequestOnSubmit, AllowAnonymous + no identity fields).

### Layout

**Locked:** richer table rows (per session 3 review).

The page header keeps the existing title + "New form" button (when
`canEdit`). Below that, a new filter bar, then the templates list.

#### Filter bar

A single horizontal Tailwind toolbar:

- **Search** — free-text on template title (client-side filter)
- **Status** — `Active` / `Inactive` / `All` (default `Active`)
- **Delivery mode** — multi-select chip group: `Anonymous` /
  `Targeted` / `Authenticated`. Row shows when its
  `Allow{Mode}` is true for any selected mode. Default: all three.
- **Sort** — Updated date desc (default) / Title A–Z / Submission count
  desc

#### Row layout

Replace today's `Title / Kind / Status / Published / Public link /
Actions` with:

```
[ ▸ ] Form Title                                  Updated 3d ago    [actions ›]
       [Anonymous][Targeted] · ⚠ Spawns SR
       12 submissions · 3 active invitations
```

- **Expander chevron** (left) opens a small drawer with the public
  URL (if `AllowAnonymous`), the invitation count, and the
  CreatesShareRequestOnSubmit indicator.
- **Title** — large, primary text. Clicking opens the **View**
  (preview) page.
- **Subline** — mode badges + warnings (no Kind/KindLabel — see
  "FormKind UI removal" below):
  - Mode badges: small pills showing which of Anonymous / Targeted /
    Authenticated are enabled. The disabled ones don't render.
  - Warning badges: `Spawns SR on submit` (when
    `CreatesShareRequestOnSubmit=1`), `No identity fields` (when
    `AllowAnonymous=1` AND no well-known identity field — same check
    Slice E.1 would have run in the editor).
- **Stats line** — submission count + active-invitation count, both
  linkable (submission count → Submissions tab pre-filtered to this
  template; invitation count → per-template Invitations sub-page).
- **Right-hand date** — "Updated Nd ago" (uses `ModifiedDate` or
  `CreatedDate`).
- **Actions menu** (kebab dropdown):
  - View (the same action as clicking the title — surfaced again for
    discoverability)
  - Send to member (only when `AllowTargeted` OR `AllowAuthenticated`
    AND `IsPublished`)
  - Copy share link (only when `AllowAnonymous`)
  - Open share link in new tab (only when `AllowAnonymous`)
  - Edit (canEdit)
  - Publish / Unpublish (canPublish)
  - Activate / Deactivate (canEdit)
  - View invitations (always — opens the per-template sub-page)
  - Delete (canDelete)

The kebab keeps the row clean and lets us add actions later without
recrowding the row.

#### Per-template Invitations sub-page (A.1.a)

Reached from the row's "View invitations" action or the invitation
count. Lives under `/tenant-admin/sharing-forms/template/:id/invitations`
(and vendor mirror). Shows every invitation sent against the template,
sorted newest-first:

| Recipient | Mode | Sent | Status | Linked to | Submissions | Actions |

- Status pill: `Active` (green) / `Used` (gray) / `Revoked` (red) /
  `Expired` (amber).
- Actions:
  - `Revoke` — only when Active. Same confirm modal + DELETE call as
    the existing member-workspace inline revoke (A.1.b shipped).
  - `Copy link` — only when Active and the invitation is targeted
    mode (authenticated mode requires login anyway; the link by
    itself is less useful but still usable).

Backend: reuses the existing
`GET /api/me/{vendor|tenant-admin}/public-forms/templates/:id/invitations`
shipped in the predecessor.

### View button — preview mode

**Locked:** full-page route (session 3).

A click on a form's title (or its row's View action) opens a
preview-mode rendering of the published version.

Route: `/tenant-admin/sharing-forms/template/:id/preview` (+ vendor mirror).

Behavior:

- Renders the published version's definition via the same
  `PublicFormView` component recipients see.
- Falls back to the latest draft if no published version yet (with a
  banner: "Preview of unpublished draft").
- Submit button replaced with a disabled "Preview only — no submit"
  affordance. The form's onSubmit handler is no-op.
- No greeting block (it's care-team-facing, not a real recipient).
- No auto-resolver, no decrypt, no encryption — pure render. Header
  image still resolves via the existing SAS path.
- Back button returns to the forms list.

Backend support: A new
`GET /api/me/{vendor|tenant-admin}/public-forms/templates/:id/preview-payload`
endpoint that returns the template title + version + definition JSON
(parsed, header image SAS'd). Distinct from the existing public GET
because it requires care-team auth and reads the latest published OR
latest draft.

The View button MUST render even for send-to-member-only and
authenticated-only templates that have no public share link, per the
user brief.

---

## Submissions tab redesign

### Goals

1. Migrate fully off Material-UI to Tailwind.
2. Add resolution-status + source filters (Slice C.1).
3. Add multi-submission grouping (Slice A.2 third site).
4. Match the visual language of the redesigned forms tab.
5. Default view should land the care team on actionable rows
   (probably: unresolved + most recent first — open question).

### Layout

#### Header

- Title: "Form submissions"
- Right-side CTAs: `Export CSV` (existing behavior)

#### Filter bar

All Tailwind-native; no MUI:

- **Date range** — two native `<input type="date">` or a small
  Tailwind-styled popover. Defaults: last 30 days.
- **Template** — `<select>` of templates, "All templates" default.
- **Resolution status** — `<select>`:
  - `All`
  - `Unresolved` (MemberId null)
  - `Resolved — not linked` (MemberId set, ShareRequestId + CaseId
    both null)
  - `Resolved — linked` (MemberId set, ShareRequestId OR CaseId set)
- **Source** — `<select>`: `All` / `Anonymous` / `Targeted` /
  `Authenticated` (reads `s.AuthMode`).
- **First name / Last name** — text inputs (keep existing).
- **Keyword in answers** — text input (keep existing).
- **Search** button + **Reset** button.

**Default state on first visit (locked, session 3):**
`resolutionStatus=Unresolved` + last 30 days. Care team lands on the
actionable queue first; clearing filters surfaces history.

**Filter state persistence (locked, session 3):**
Reflected in URL query params (e.g.
`?status=unresolved&from=2026-04-13`). Care team can bookmark common
views, share links with colleagues, and browser back/forward restores
prior filter state.

#### Table

Tailwind-native `<table>` replacing MUI DataGrid. Columns:

| Submitted | Form | Source | Member | Resolution | Linked to | Actions |

- **Submitted** — date+time in viewer's local zone (via the
  `formatSubmissionDateTime` util shipped this branch).
- **Form** — template title, links to that template's preview.
- **Source** — small pill: `Anonymous` / `Targeted` /
  `Authenticated`.
- **Member** — resolved name + email if MemberId is set; "Unresolved"
  with a member ID hint if not.
- **Resolution** — pill:
  - `Unresolved` (amber)
  - `Resolved` (green) — show " · linked" when SR/Case is also set
  - `Resolved · not linked` (gray)
- **Linked to** — SR request number or Case ID (when set);
  otherwise "—".
- **Actions** — `View` link.

Multi-submission grouping (Slice A.2 third site): rows sharing the
same `InvitationId` collapse into a `{FormTitle} — N submissions`
parent row, click to expand. Use the existing
`groupSubmissionsByInvitation` util from this branch. "Latest" chip
on the newest within a group.

Pagination: simple Tailwind Prev/Next + page-size selector. No
DataGrid magic; server-side pagination retained.

#### Empty / loading states

Use the existing `EmptyState` and `Skeleton` components from the
member workspace work for consistency.

---

## Submission detail page redesign

### Goals

1. Migrate the MUI `Chip` to a Tailwind pill.
2. Add the A.3 second render site (discrepancy parens) in the
   membership panel.
3. Surface delivery mode (Anonymous / Targeted / Authenticated) and
   resolution status prominently in the header.
4. Add a **Linkage panel** for retroactive linkage (Slice D revived
   here).

### Layout

#### Header

- Form title (links back to the forms tab)
- Submitted date+time, with the new utility
- Pills: source (AuthMode) + resolution status

#### Membership panel

For submissions with `MemberId IS NOT NULL`:

- Member name + email + phone, rendered through
  `formatNameWithDiff` / `formatEmailWithDiff` /
  `formatPhoneWithDiff` (the Slice A.3 utilities, already shipped).
- Parens diff only for `AuthMode='anonymous'` (per spec).
- Quick action: "Open member workspace" → links to the member's
  workspace tab.

For submissions where `MemberId IS NULL`:

- "Unresolved" banner with the submitted member ID + name fields
  (from payload).
- Action: "Resolve member" (existing endpoint).

#### Linkage panel (Slice D — all three pieces locked, session 3)

D.1 (PATCH endpoint), D.2 (panel), and D.3 (extracted `LinkagePicker`
component, also reused by `SendToMemberModal`) all land here.

Render only when `MemberId IS NOT NULL`:

- If currently linked: shows linked SR (with request number) or Case
  link, plus a "Change" button.
- If not linked: shows "Not linked. Link to…" with a button that
  opens the linkage picker.
- "Change" → opens the picker; current selection pre-selected.
- "Remove linkage" — clears the linkage (PATCH with both null).

Endpoint (Slice D.1):

`PATCH /api/me/{vendor|tenant-admin}/public-forms/submissions/:submissionId/linkage`

- Body: `{ shareRequestId?: string | null, caseId?: string | null }`
- Mutually exclusive (both can't be non-null; both null clears).
- Tenant-isolated.
- Returns 204.

Linkage picker (Slice D.3): extract the inline two-column picker
currently inside `SendToMemberModal` into a shared `LinkagePicker`
component. The picker accepts a `memberId` and renders open SRs in
the left column, Cases (disabled until Cases ships) in the right.

#### Payload section

Existing rendering (with the `payloadToRows` helper). No structural
change but lift to a Tailwind container for visual consistency.

---

## Carryover TODOs (from forms-redesign followup)

All items listed in the seed-version of this doc, retained:

### Submissions tab (already covered in the Submissions tab section above)

- C.1 — filters (resolution status + source)
- A.2 — third render site for multi-submission grouping

### Forms tab (already covered above)

- A.1.a — per-template Invitations sub-page
- View button per template (NEW from user brief)

### Submission detail page (already covered above)

- A.3 second render site — discrepancy parens
- D.1 — PATCH linkage endpoint
- D.2 — Linkage panel
- D.3 — extracted reusable LinkagePicker

### Editor (out of scope here, tracked for editor-redesign spec)

- E.1 — soft-warning banner when anonymous form lacks identity fields

---

## New TODOs found in this audit

- **Migrate `TenantSharingSubmissionsPage` off Material-UI to
  Tailwind.** Replace MUI `DataGrid`, `Paper`, `Stack`, `FormControl`,
  `Select`, `MenuItem`, `TextField`, `Button`, `Alert`, `Box`,
  `Dialog`, `Typography`, `DatePicker`. Bare-minimum migration; no
  feature regression.
- **Migrate `TenantSharingSubmissionDetailPage`'s MUI `Chip` import
  to a Tailwind pill component (or inline span).** Tiny change.
- **Add the warning badges** on forms tab rows:
  - `Spawns SR on submit` when `CreatesShareRequestOnSubmit=1`.
  - `No identity fields` when `AllowAnonymous=1` AND the field set
    has none of `memberId` / `email` / `firstName+lastName` /
    `dateOfBirth`. Same predicate Slice E.1 uses in the editor.

## FormKind UI removal (locked, session 3)

The `FormKind` slug + `KindLabel` band-aid have been called out as bad
design (current-system-problems.md §1–2). They couple unrelated
concerns: (a) backend semantic dispatch for the 3 seeded intake
templates (`UnsharedAmount` / `PreventiveCare` / `AdditionalDocuments`)
and (b) a display label the care team sees. `KindLabel` was added in
April 2026 as a friendlier-label wrapper but doesn't fix the
underlying coupling.

**This redesign removes Kind from every UI surface.** Phase 1 only —
the schema column stays for backend dispatch; full retirement waits
for the editor redesign (which consolidates UA + PC into one
screener-driven intake and retires `AdditionalDocuments`).

### What gets removed

- **Forms tab:** no Kind column, no Kind text in row subline.
- **Submissions tab:** no Kind column in the list; template picker
  dropdown shows just `Title` instead of `Title — Kind`.
- **Submission detail page:** no Kind chip/label in the header or
  metadata panel.
- **CSV export header:** drop the `FormKind` / `TemplateKindLabel` /
  `Kind` columns. Submissions still identify their template via
  `FormTemplateId` and `FormTitle`.
- **`displayFormKindLabel` util:** removed from all UI imports. The
  function itself can stay in `constants/formBuilderKindPresets.ts`
  for one more cycle in case anything outside the back-office uses
  it, but no forms-page surface calls it.

### What stays

- `oe.PublicFormTemplates.FormKind` and `KindLabel` columns —
  untouched.
- `oe.PublicFormSubmissions.FormKind` — untouched.
- Backend services that switch on `FormKind === 'UnsharedAmount' |
  'PreventiveCare' | 'AdditionalDocuments'` — untouched.
- The form editor's Kind field (when authoring a new template) —
  out of scope for THIS spec; handled by the editor redesign which
  retires Kind entirely.

---

## Out of scope (this spec)

- **Form editor / create-form screen** — separate editor-redesign
  spec; some carryover items (E.1) belong there.
- **`AdditionalDocuments` hide from create-form list** (043) — also
  editor redesign.
- **Form-editor screener-driven branching** (the new data model) —
  separate editor-redesign spec.
- **Member-facing portal** `pages/member/Documents.tsx` — blocker
  B-003; Amar tracking via GitHub backlog.
- **Care-team notification on new submission** — blocker B-004;
  dashboard work.
- **Cases feature implementation** — schema-ready; no Cases code in
  this spec.
- **Multi-key encryption for PHI payloads** — blocker B-002; deploy
  config.

---

## Resolved during review (session 3, 2026-05-13)

All eight open questions from the draft were answered:

| # | Question | Decision |
|---|---|---|
| 1 | Forms tab layout | Richer table rows (+ Kind removed from all UI — see "FormKind UI removal" section) |
| 2 | View button preview target | Full-page route at `/sharing-forms/template/:id/preview` |
| 3 | Submissions tab default filter | `Unresolved` + last 30 days |
| 4 | Filter state persistence | URL query params (deep-linkable, browser back/forward respected) |
| 5 | Slice D scope | All three pieces ship here — D.1 endpoint + D.2 panel + D.3 extracted `LinkagePicker` |
| 6 | Invitations sub-page placement | Nested route under template (`/sharing-forms/template/:id/invitations`) |
| 7 | Rollout | Both portals together (default consequence of shared components — no feature flag) |
| 8 | "No identity fields" warning extent | Both surfaces — editor banner (Slice E.1) + forms-list row badge (redundancy net) |

---

## Related

- Predecessor: `2026-05-13-forms-redesign/design.md`
- Followup: `2026-05-13-forms-redesign-followup-design.md`
- Editor redesign: `2026-05-13-form-editor-redesign-design.md`
- Blockers: `2026-05-13-forms-redesign/blockers.md` (B-001 ✅, B-002,
  B-003, B-004, B-005)
- Inventory: `2026-05-13-forms-redesign/features/_inventory.md`
- Current problems audit:
  `2026-05-13-forms-redesign/current-system-problems.md`
