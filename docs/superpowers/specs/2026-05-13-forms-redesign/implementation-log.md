# Forms redesign — implementation log

**Branch:** `fix/back-office/forms-redesign` (off `staging`)
**Date:** 2026-05-13
**Status:** all work committed; planning docs in this folder are the
companion record. Smoke-test pending before merge.

| Stat | Value |
|---|---|
| Commits ahead of `staging` | 27 |
| Files touched | 47 |
| Lines added | 9,323 |
| Lines removed | 733 |
| Specs authored / extended | 5 |
| Blocker entries logged | 19 (B-001 through B-024, three deferred) |

This log captures every concrete feature shipped on the branch and
every defect closed during the manual-testing punch list. Organized by
surface and slice rather than by commit so it reads like an inventory.

---

## Phase 0 — VendorAgent forms access

Predates the main spec. Fixed broken VendorAgent UX where the
frontend let the role into `/vendor/sharing-forms` but the backend
401'd them.

- `backend/routes/me/vendor/public-forms.js` `authorize()` updated for
  the read + resolve endpoints.
- Frontend hides edit / publish / delete buttons for `VendorAgent`.

---

## Schema & data model (forms-redesign Phases 1–4)

`sql-changes/allaboard365/2026-05-13-forms-redesign.sql` applied to
the shared `allaboard-testing` instance.

- `oe.PublicFormTemplates`: three delivery-mode BIT columns
  (`AllowAnonymous` / `AllowTargeted` / `AllowAuthenticated`) +
  `CK_PublicFormTemplates_AtLeastOneMode` check constraint.
- `oe.PublicFormTemplates.CreatesShareRequestOnSubmit` BIT (defaults
  OFF; UA + PC backfilled to 1 so existing intake behavior holds).
- `oe.PublicFormSubmissions`: `CaseId`, `AuthMode`, `InvitationId`,
  `PayloadEmail`, `PayloadPhone` columns.
- `oe.PublicFormInvitations` new table: token hash, mode, expiry,
  revocation, linked SR / Case, delivery method, audit fields. Four
  indexes. Five FKs.
- One-off dev runner: `backend/scripts/run-forms-redesign-migration.js`.

---

## Delivery-mode policy

Per-template choice of which delivery paths the recipient experience
supports.

- Editor "Delivery settings" panel — 4 toggles
  (Anonymous / Targeted / Authenticated / Creates SR on submit) +
  inline error if all are off.
- Backend validation rejects all-off templates on PATCH.
- Forms list surfaces "Get share link" / "Send to member" controls
  conditioned on the flags.

---

## Send-to-member flow

Care-team-driven invitation creation with mode + linkage + recipient
email.

- 4-step modal (`SendToMemberModal`): member search → mode →
  optional SR linkage → review.
- 32-byte token, SHA-256 stored, 7-day default expiry, multi-use
  within the window, server-side revoke.
- Three delivery methods: email (SendGrid), copy-link, both.
- `POST /api/me/{vendor|tenant-admin}/public-forms/templates/:id/invitations`
  and a sibling list/get/`DELETE` for revoke.
- Invitation URL fix during testing: now resolves through request
  Origin / forwarded headers instead of hard-coding `localhost`.

---

## Targeted-mode recipient flow

The signed-link path — no login, but pinned to a specific member.

- `/forms/i/:token` route with `InvitationRouter` guard
  (target-mode detection before render).
- `GET /api/public/forms/invitations/:token/meta` (lightweight
  mode lookup) and `GET /api/public/forms/invitations/:token` (full
  payload + greeting).
- `POST /api/public/forms/invitations/:token/submit` with the
  invitation's MemberId / ShareRequestId / CaseId stamped at write
  time.
- Greeting block: "This form is for you, {firstName} ({sentToEmail})".
- 410 Gone enforcement on expired / revoked invitations; generic
  recipient-side error UI.
- JSON-parse fix during testing: definition is now parsed before
  passing to `definitionWithAuthenticatedHeaderImage`, which silently
  passed strings through and crashed `PublicFormView`'s
  `def.title.trim()`.

---

## Authenticated-mode recipient flow

The login-required path with full profile prefill.

- `/forms/i/:token` redirects through `/login?returnTo=...` when
  the recipient isn't authenticated; `returnTo` is preserved through
  the auth bounce.
- `GET /api/me/member/forms/invitations/:token` — auth-gated;
  member-match check; 403 + generic error on mismatch.
- `POST /api/me/member/forms/invitations/:token/submit` —
  server-authoritative prefill overwrite stamps the well-known
  profile fields into the payload regardless of what the recipient
  submitted.
- `publicFormInvitationPrefillService` with 12 well-known fields:
  firstName, lastName, email, phone, memberId, dateOfBirth,
  relationToPrimary, address × 5.

---

## ShareRequest linkage & auto-resolution

- Auto-resolver runs inline on submit. `PayloadEmail` +
  `PayloadPhone` populated at write so the resolver has plaintext
  identity fields without decrypting the encrypted payload.
- `CreatesShareRequestOnSubmit=0` stops the silent SR-creation bug
  documented in current-system-problems.md §1: custom-kind forms no
  longer spawn surprise Medical SRs.
- Retroactive linkage:
  `PATCH /api/me/{vendor|tenant-admin}/public-forms/submissions/:id/linkage`
  with body `{ shareRequestId?, caseId? }` (mutually exclusive).
- Shared `LinkagePicker` component used by both the Send modal
  step 3 and the submission-detail Linkage panel.

---

## VendorAdmin permissions

- VendorAdmin (and SysAdmin) can publish + delete templates from the
  vendor portal — backend endpoints + frontend hook flags.
- Stale comment in `routes/me/vendor/public-forms.js` ("Delete and
  publish are intentionally NOT exposed here") removed.

---

## Member workspace (care-team-facing)

Vendor-side view of a member's files + forms.

- Folder hierarchy: per-SR folders (union of SRs with documents,
  submissions, or active invitations) + a consolidated "Form
  submissions" folder.
- Strict isolation: a submission linked to SR #7 appears in SR #7's
  folder and "Form submissions" — never in SR #6 or SR #8.
- Inline pending-invitations row with Extend (+7d) and Revoke
  actions per row.
- New endpoint `GET /api/me/vendor/members/:id/form-invitations`.
- Multi-submission grouping by `InvitationId` inside each folder
  with a "Latest" chip and date+time stamps.

---

## Share request workspace

The SR detail page's Documents tab gained forms-related surfaces.

- Tab renamed "Documents and Forms".
- Two sections now appear alongside the existing documents table:
  - **"Forms sent — pending submission"** — active invitations
    linked to the SR with status pill (`Awaiting submission` /
    `Opened`), sent date, mode, recipient email, expiry, and
    inline Extend + Revoke buttons.
  - **"Forms linked to this share request"** — submissions
    actually received, grouped by `InvitationId` with Latest chip
    and date+time.
- Clicking a submission opens a preview modal
  (`SubmissionPreviewModal`) instead of navigating away. Modal
  shows form title, submitted date+time, source pill, linked-SR,
  member info, and payload key/value rows. "Open full submission"
  button takes the care team to the detail page when they need
  more.
- A.3 discrepancy parens in the submission row's member line —
  payload-vs-profile divergence rendered for any submission with a
  resolved member, regardless of AuthMode.
- New endpoints:
  `GET /api/me/vendor/share-requests/:id/form-submissions` and
  `GET /api/me/vendor/share-requests/:id/form-invitations`.

---

## Forms tab (back-office)

Total rework of `TenantSharingFormsPage` (vendor + tenant-admin
share the same component).

- Header: title + tenant-name + top-right `+ New form` button
  (gated on canEdit) that toggles a collapsible inline create panel.
- Filter bar: search-by-title + Active/Inactive/All status select +
  delivery-mode chip toggles.
- Richer rows: chevron expander · clickable title (opens preview) ·
  mode badges (Anonymous / Targeted / Authenticated) · warning
  badges (Draft, Spawns SR) · submission + active-invitation counts
  (the invitation count is itself a link to the Invitations sub-page) ·
  "Updated Nd ago" — with sub-hour granularity ("just now" / "Nm
  ago" / "Nh ago"…).
- Direct row actions: View · Send to member · Copy share link as
  inline icon buttons. Kebab keeps the longer-tail actions
  (Open share link in new tab · View invitations · Edit ·
  Activate/Deactivate · Delete).
- Default sort: templates with
  `CreatesShareRequestOnSubmit=1` first, then by `SubmissionCount`
  DESC, then by title.
- Kind column and all Kind / KindLabel references removed from this
  surface. Schema column stays for backend dispatch.
- Backend `listTemplatesForTenant` extended with
  `SubmissionCount` + `ActiveInvitationCount` subqueries.

---

## Form preview ("View" button)

Care-team-facing preview that works regardless of delivery mode.

- Route: `/sharing-forms/template/:id/preview` (vendor + tenant-admin
  mirrors).
- New `GET /templates/:id/preview-payload` endpoint returns the
  published version's parsed definition with header-image SAS
  resolved; falls back to the latest draft when nothing is published
  (with a "previewing unpublished draft" banner in the UI).
- Renders via the same `PublicFormView` component recipients see,
  with `previewMode={true}` so the submit button is disabled and
  shows "Preview only — no submit".
- Container width `max-w-5xl`; inner form rendered at recipient
  width (max-w-3xl) scaled to 92% so it reads as a faithful
  screenshot rather than a stretched live form.
- Works even for send-to-member-only and authenticated-only
  templates that have no public share URL.

---

## Per-template Invitations sub-page

Audit view of every invitation sent against a given template.

- Route: `/sharing-forms/template/:id/invitations` (both portals).
- Reached from the row's "View invitations" kebab item or the
  clickable active-invitation count on the row.
- Columns: Recipient · Mode · Sent · Status · Linked · Submissions
  · Actions.
- Status pill (active / used / revoked / expired) derived from
  `RevokedAt` + `ExpiresAt` + `SubmissionCount`.
- Active rows have Extend (+7 days) and Revoke actions.

---

## Submissions tab (back-office)

Full migration of `TenantSharingSubmissionsPage` off Material-UI to
Tailwind — closes a long-standing project-rule violation
(`CLAUDE.md` mandates Tailwind-only).

- Removed MUI dependencies for this surface: `Alert`, `Box`,
  `Button`, `Dialog`, `FormControl`, `Paper`, `Select`,
  `MenuItem`, `Stack`, `TextField`, `Typography`, MUI X
  `DataGrid` and `DatePicker`. Replaced with native HTML controls +
  Tailwind styling.
- New filters: resolution status (All / Unresolved /
  Resolved-not-linked / Resolved-linked) and source
  (All / Anonymous / Targeted / Authenticated).
- URL query params drive every filter — deep-linkable, browser
  back/forward respects state.
- Default load: `Unresolved` + last 30 days so the care team lands
  on the actionable queue first.
- Multi-submission grouping by `InvitationId` — parent row shows
  "{Form} — N submissions" with click-to-expand; "Latest" chip on
  the newest within a group.
- Columns: Submitted (date+time) · Form (links to preview) ·
  Source pill · Member · Resolution pill · Linked to · Member ID
  (form) · Link view Δ · Email queue (with Resend) · Open.
- Member column prefers the resolved profile name (JOIN'd from
  Members → Users); falls back to payload only when needed.
- Resend-routing-notification dialog migrated to a Tailwind modal
  with the localhost link-base picker preserved.
- CSV export header drops `FormKind` / `Kind` / `TemplateKindLabel`
  columns; submissions still identify their template via
  `FormTemplateId` + `FormTitle`.
- Simple Tailwind pagination (Prev / Next + rows-per-page select).

---

## Submission detail page

`TenantSharingSubmissionDetailPage` polish + new affordances.

- Migrated the last MUI dependency (`Chip`) to a Tailwind pill.
- `AuthMode` pill added to the header so source is visible at a
  glance.
- Membership panel: discrepancy parens via the shared diff utility
  (normalized phone digits-only, email lowercase, name trim +
  collapse + case-insensitive). Renders for any submission with a
  resolved member; suppression happens automatically when values
  match.
- Linkage panel: shows current SR (or Case, once Cases ships) with
  Change / Remove buttons. Embedded `LinkagePicker` for retroactive
  changes; PATCH endpoint persists.
- Payload split into two grids: **Form answers** (keys present in
  the form definition's fields list) and **Account snapshot**
  (keys the server stamped via authenticated-mode prefill overwrite
  — memberId / DOB / address fields the form never asked for).
  Snapshot grid has a monospace key + a caption explaining "the
  recipient did not type these."
- Backend `getSubmissionDetail` JOINs Members → Users to return
  the resolved member's name / email / phone for the parens diff.

---

## Send-to-member modal — anonymous send

Added inside the existing modal (no new modal needed).

- "Switch to anonymous send" inline link at the top of the
  member-search step, gated on `AllowAnonymous` + `IsPublished`.
- Anonymous mode renders a simpler flow: recipient email + optional
  message + Send button. Bypasses member-search / mode / linkage
  / review.
- New endpoint
  `POST /api/me/{vendor|tenant-admin}/public-forms/templates/:id/send-anonymous-link`
  with `{ recipientEmail, message? }`. Plain SendGrid send of the
  template's public URL; no invitation row, no token, no member
  binding.

---

## Shared utilities introduced

- `frontend/src/utils/formMemberDiff.ts` —
  `formatNameWithDiff` / `formatEmailWithDiff` /
  `formatPhoneWithDiff` with normalization rules.
- `frontend/src/utils/formSubmissionGrouping.ts` —
  `groupSubmissionsByInvitation()` + `formatSubmissionDateTime()`.
- `frontend/src/utils/clipboard.ts` — `copyToClipboard()` with
  `navigator.clipboard.writeText` + `document.execCommand('copy')`
  fallback. Used at four call sites.
- `frontend/src/components/tenant-admin/public-form-builder/LinkagePicker.tsx`
  — two-column SR + Case picker. Reused by `SendToMemberModal` and
  the submission-detail Linkage panel.
- `frontend/src/components/vendor/share-requests/SubmissionPreviewModal.tsx`
  — submission preview lookup + read-only render.

---

## Manual-testing punch list — 16 fixes shipped

Issues surfaced during a smoke test of the redesigned surfaces.
Three more (B-006, B-008, B-021) are logged but deferred —
documented in `blockers.md`.

### Small fixes

- **B-009** — Forms-tab "Updated Nh ago" was reporting "1h ago" even
  for templates updated 10 seconds ago. Now: "just now" / "Nm ago"
  / "Nh ago" / "Nd ago" / "Nmo ago" / "Ny ago".
- **B-013** — Submissions list Member column was blank for
  targeted / authenticated submissions (payload doesn't carry their
  name fields). Backend JOINs Members → Users; frontend prefers
  resolved name and falls back to payload only when needed.
- **B-017** — Copy buttons didn't actually copy (browser
  user-activation timeout after `await`). New shared
  `copyToClipboard()` helper falls back to `execCommand('copy')` when
  the modern API fails. Applied at four call sites.
- **B-018** — E.1 soft warning. Editor's Delivery settings panel
  now shows an amber banner when `AllowAnonymous=1` and the
  definition lacks all of `memberId` / `email` /
  `firstName + lastName` / `dateOfBirth`. Non-blocking.
- **B-019** — Authenticated prefill only filled first / last name;
  email + phone stayed blank. Two-part fix:
  (a) `newFieldFromPalette()` now defaults new `email` and `tel`
  fields to `email` / `phone` names (matching the prefill keys);
  (b) `mapPrefillToInitialValues()` maps by field type instead of
  name so existing forms with `field_xxx` names get prefill too.
- **B-022** — Discrepancy parens never rendered. Trigger was
  `AuthMode='anonymous'` only; widened to any submission with a
  resolved member. The diff utility suppresses parens when
  normalized values match, so server-pinned modes naturally don't
  show parens unless the recipient typed something different.

### UI tweaks

- **B-007** — Editor save → no confirmation or redirect. After
  Save-and-Publish: scroll to top so the success banner is visible,
  then redirect to the forms list with `?saved=<versionNumber>`
  after ~900 ms. Forms list reads the param and shows a transient
  green banner that clears after 4 s.
- **B-010** — Direct row buttons. View / Send / Copy now render as
  inline icon buttons on the right side of each row, not buried in
  the kebab. Kebab keeps the longer-tail actions.
- **B-011** — Send-modal SR picker missing the open-date column.
  `LinkagePicker` now renders the SR's `SubmittedDate` alongside
  RequestType and Status.
- **B-023** — Form preview was too narrow. Container widened to
  `max-w-5xl`; inner form scaled to 92% inside a `max-w-3xl` wrapper
  so it reads as a screenshot rather than stretched.
- **B-024** — Forms-tab priority + sort. "Create new form" moved
  from an always-visible inline section to a top-right
  `+ New form` button (collapsible inline panel on click). Default
  sort: `CreatesShareRequestOnSubmit=1` first, then submission count
  desc, then title.

### Functional additions

- **B-015** — Extend invitation expiry. New `PATCH /invitations/:id`
  endpoint pushes expiry by 7 days. "Extend" button on active rows
  in the per-template Invitations sub-page AND the member-workspace
  pending-invitations row.
- **B-016** — Sent invitations under SR. SR Documents-and-Forms
  tab gains a "Forms sent — pending submission" section with status
  pills (`Awaiting submission` / `Opened`), sent date, recipient
  email, expiry, and inline Extend + Revoke. Backend excludes
  revoked / expired / already-submitted invitations.
- **B-014** — SR preview modal. Clicking a form submission on the
  SR Documents-and-Forms tab opens `SubmissionPreviewModal` instead
  of navigating away. Shows form title, submitted date+time, source
  pill, linked SR, member info, payload key/value rows.
  "Open full submission" link takes the care team to the detail
  page when they need more.
- **B-012** — Anonymous broadcast-link delivery. Inline "Switch to
  anonymous send" in the Send-to-member modal (gated on
  `AllowAnonymous` + `IsPublished`). Simpler flow: recipient email +
  optional message + Send button. Bypasses member-search / mode /
  linkage. Sends the public form URL via SendGrid; no invitation
  row, no token.
- **B-020** — Payload split on submission detail. Two grids instead
  of one: **Form answers** (keys in the form definition) vs
  **Account snapshot** (keys the server stamped via prefill
  overwrite). Snapshot grid has monospace key + a caption
  explaining "the recipient did not type these."

### Bug fixes resolved inline (during testing, before the punch list)

- **Invitation URL fell back to `localhost`** when `FRONTEND_URL`
  wasn't set in docker-dev. `buildInvitationUrl` now resolves
  through the request `Origin` / forwarded headers via the
  `resolveSubmissionLinkBase` helper from `publicFormNotifyService`.
- **`trim()` of undefined when rendering a targeted form.** Both
  the targeted and authenticated invitation GET endpoints now
  `JSON.parse` `DefinitionJson` before passing to
  `definitionWithAuthenticatedHeaderImage`, which silently passed
  strings through and crashed `PublicFormView`'s `def.title.trim()`.

### Deferred (3, in blockers.md)

- **B-006** Kind field in form creation → form-editor redesign spec.
- **B-008** Two separate save buttons in the editor → form-editor
  redesign spec.
- **B-021** Forms that spawn share requests shouldn't be linkable to
  a different SR → product clarification owed; tracked for later.

---

## Specs authored / extended on this branch

| File | Purpose |
|---|---|
| `design.md` | Phases 0–4 of the original forms redesign |
| `current-system-problems.md` | Audit of pain points the redesign addresses |
| `features/_inventory.md` | 44-feature inventory with per-feature status |
| `progress.md` | Session-2 snapshot |
| `2026-05-13-forms-redesign-followup-design.md` | Slices F / A.3 / A.2 / B / A.1.b (followup) |
| `2026-05-13-forms-page-redesign-design.md` | Back-office forms-page UX redesign |
| `2026-05-13-form-editor-redesign-design.md` | Drafted; future work |
| `blockers.md` | B-001 through B-024 — open + deferred + resolved |

---

## Tracked blockers — running state

- **B-001** VendorAdmin publish/delete — ✅ resolved (Slice F).
- **B-002** Local backend has a throwaway PHI encryption key —
  deploy-config item; not a code gap.
- **B-003** Member-facing portal `pages/member/Documents.tsx`
  silent on form submissions — backlog item Amar is tracking in
  GitHub.
- **B-004** Care-team notification on new submission — slated for
  the future care-team dashboard work; design captured here.
- **B-005** Member workspace (care-team-facing) verification —
  smoke-test owed against the Slice B + A.1.b rewrite.
- **B-006 through B-024** — session-3 manual-testing punch list;
  16 fixed, 3 deferred (see above).
