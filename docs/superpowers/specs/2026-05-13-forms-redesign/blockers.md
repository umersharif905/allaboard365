# Forms redesign — known blockers

Running list of gaps surfaced during manual testing that need batched follow-up
work. Each entry: what blocks, where in the code, what the spec says, and what
the fix shape is. The intent is to batch related vendor-permission /
infrastructure work into a single follow-up rather than scattering one-off
patches.

---

## B-001 · VendorAdmin cannot publish or delete templates ✅ RESOLVED — design

**Surfaced:** 2026-05-13, manual test as `test@sharewellpartners.com` (VendorAdmin).
**Resolved (design):** 2026-05-13 session 3 — product confirmed YES,
VendorAdmin should have publish/delete per the original spec §2 / §8 /
line 184. Implementation lives in the followup design as **Slice F**
(`2026-05-13-forms-redesign-followup-design.md`).

Keeping the original entry below for the historical record + fix shape.

### Original report

After creating a new form template the editor only shows "Save draft" and the
post-save toast reads:

> Saved version N as a draft. A tenant admin must publish it to go live.

The VendorAdmin has no path to publish; templates remain unusable until
someone with a TenantAdmin login completes the publish step.

### What the spec says

`design.md` §2 permission matrix:

| Action | VendorAdmin | VendorAgent | TenantAdmin | SysAdmin |
|---|---|---|---|---|
| Create / edit / publish / delete template | ✅ | ❌ | ✅ | ✅ |

§8 also lists `POST /templates/:id/publish` and `DELETE /templates/:id` as
"VendorAdmin / SysAdmin only" — implying both should exist on the vendor
route.

### What the current code does

- `backend/routes/me/vendor/public-forms.js` does NOT expose
  `POST /templates/:formTemplateId/publish` or `DELETE /templates/:formTemplateId`.
  A comment at the top of that file explicitly says "Delete and publish are
  intentionally NOT exposed here" — a pre-spec convention.
- `frontend/src/hooks/usePublicFormsContext.ts` returns `canPublish: false`
  and `canDelete: false` for both `VendorAdmin` and `VendorAgent`. Buttons
  never render for either vendor role.

### Fix shape (~15 lines)

1. Add publish + delete handlers to `backend/routes/me/vendor/public-forms.js`,
   gated on `authorizeWrite` (= `['VendorAdmin', 'SysAdmin']`). Body identical
   to the tenant-admin versions; tenant isolation flows from
   `attachVendorContext` + the existing per-template tenant guard.
2. Flip `canPublish: !isVendorAgent` and `canDelete: !isVendorAgent` in
   `usePublicFormsContext.ts` so VendorAdmin sees both buttons.

### Why this is held back

Touches the vendor permission model. Better batched with: the rest of the
VendorAgent read-only verification (§8 Phase 0), any retro audit of vendor
endpoints that may also need expansion, and the per-feature inventory
follow-through (`features/feature-014-vendor-agent-send-permission.md`,
`features/feature-044-vendor-agent-phase0.md`) before a single combined PR.

---

## B-002 · Local backend has a throwaway PHI encryption key

**Surfaced:** 2026-05-13, "Submission failed: PUBLIC_FORMS_ENCRYPTION_KEY_B64
must be set …" on the first targeted-mode submit in docker-dev.

### State right now

`backend/.env` was missing `PUBLIC_FORMS_ENCRYPTION_KEY_B64` entirely.
A throwaway 16-byte base64 key was generated locally and added to that file
(line marked with a `# Temporary local key …` comment) so submissions can
proceed end-to-end for testing. The key id label stays at the default
`env:aes128gcm:v1`.

### Why this is a blocker

`allaboard-testing` already holds **138 prior submissions** (oldest
2026-03-26, newest 2026-05-13) all encrypted under the canonical team key.
The local throwaway key has the **same** `PayloadKeyId` label, so the
submission viewer has no way to know which rows go with which key:

- Submissions I create here decrypt fine on this container.
- The 138 existing rows decrypt-fail on this container.
- Any submission I create here will decrypt-fail on every teammate's
  container that has the canonical key.

This is fine for "click submit, confirm the row hits the DB" smoke testing,
**not** for any UI verification that needs the admin-side decrypt path
(submissions list, submission detail, PDF generation, summary email).

### Fix shape

Replace the throwaway value in `backend/.env` with the canonical key from
Azure App Service config / Key Vault / a teammate. No code change. After
the swap, restart the backend container; both new and pre-existing rows
become decryptable here.

Longer term: document the canonical key location alongside the other
runtime env vars (or move to a Key Vault reference that the dev compose
stack can pull in) so a fresh checkout doesn't hit this on first submit.

### Why this is held back from being a code fix

It's a deployment-config gap, not a code gap — there's nothing to PR.
Tracking here so it doesn't get lost.

---

## B-003 · Member-facing portal Documents page is silent on form submissions

**Surfaced:** 2026-05-13, scope review of the not-done items in the original
spec.

### Where

`frontend/src/pages/member/Documents.tsx` — the **member-facing** view of
their own Documents tab (the page a logged-in Member sees when they
navigate to their own portal). Distinct from
`frontend/src/components/vendor/members/tabs/MemberDocumentsTab.tsx`, which
is the **care-team-facing** view of a member's documents.

### What the spec said

`design.md` §5 (line 410) explicitly marked this **out of scope**:

> *Member's own portal Documents page — out of scope*
>
> `frontend/src/pages/member/Documents.tsx` (the member-facing view) is
> untouched in this spec. A future enhancement extends it for member-facing
> forms.

So today's Member portal shows a member their share-request documents but
**none of their form submissions** — even the ones they filled in
themselves via the authenticated-mode invitation flow.

### Why this needs to move up the priority list

- An authenticated-mode submission flows: care team sends → member logs in
  → member fills in → submission is persisted to `oe.PublicFormSubmissions`
  with `MemberId = the member's own id`. From the member's point of view
  they just submitted something. They have no way to confirm it landed,
  see what they submitted, or find it again later.
- The same submission shows up correctly on the care-team-facing
  MemberDocumentsTab (forms section we shipped). Members deserve parity.
- Targeted-mode submissions: the recipient was never logged in, so a
  member-portal view is less critical here. But if the member later logs
  in, they should still see "you submitted this form on date X" on their
  own portal.

### Fix shape

Mirror what's already in `MemberDocumentsTab.tsx` (care-team-side) onto
`pages/member/Documents.tsx` (member-side):

- New "Form submissions" section, or a Forms tab, listing the logged-in
  member's submissions.
- Link should land on a **member-safe** view of the submission (their own
  payload, no admin-only metadata). The existing
  `/forms/submissions/:token` anonymous token URL is the wrong fit because
  it relies on the original recipient token; a new "member-scope GET" on a
  submission they own would be cleaner.
- Backend likely needs a new
  `GET /api/me/member/form-submissions` endpoint, scoped to the logged-in
  user's `MemberId`(s).

### Why this is held back

- Out of scope for the original spec; not part of the 44-feature inventory.
- Needs its own small spec slice covering the member-safe submission
  viewer (what the viewer renders + how it differs from the admin viewer
  has unresolved product questions).
- Also reviewed at session 3 (2026-05-13) for inclusion in the
  forms-redesign followup; left out of scope after all. **Amar to create
  a separate GitHub backlog item to track.**
- Likely belongs alongside the broader form-page UI redesign or its own
  small spec, whichever covers member-facing surfaces first.

---

## B-005 · Member workspace (care-team-facing) — verify behavior after Slice B + A.1.b changes

**Surfaced:** 2026-05-13 (session 3 review). Amar flagged that his member
workspace "doesn't 100% work correctly" and wasn't fully aware of what
the followup slices changed on this surface.

### Which surface this is about

`frontend/src/components/vendor/members/tabs/MemberDocumentsTab.tsx`
— the **care-team-facing** view of a member, mounted inside the
vendor-portal member workspace tabs. Distinct from
`frontend/src/pages/member/Documents.tsx` (the member's OWN portal,
tracked separately as B-003).

### What the followup slices changed on this file

Two commits in this branch touched it directly:

- **Slice A.2 partial** (commit `a8d45445`) added grouped submissions UI
  with date+time stamps and a "Latest" chip inside the existing flat
  "Form submissions" section.

- **Slice B + A.1.b** (commit `777e0ea7`) rewrote the entire component:

  1. **Sidebar folder hierarchy.** Previously the sidebar showed one
     folder per distinct `ShareRequestId` from `docs` only. Now it's
     the union of: every SR the member has documents for, every SR the
     member has linked form submissions for, and every SR with an
     active pending invitation to this member. Plus a sibling
     **"Form submissions"** folder that always exists and holds the
     member's full submission history regardless of linkage.

  2. **Per-folder content.** When an SR folder is active, the main
     pane shows:
     - The pending invitations linked to that SR (with inline Revoke).
     - The SR's attached document files (existing documents table).
     - The form submissions linked to that SR.

     When the "Form submissions" folder is active, the main pane
     shows all pending invitations for the member + every submission
     regardless of SR linkage.

  3. **Strict isolation.** A submission with `ShareRequestId = X` now
     renders ONLY in the SR-X folder and in "Form submissions".
     Previously the flat section showed every submission everywhere.

  4. **A.1.b pending-invitations row.** New `GET /api/me/vendor/members/:id/form-invitations`
     endpoint backing it. Revoke button calls the existing
     `DELETE /api/me/vendor/public-forms/invitations/:id` and updates
     the row inline.

  5. **Empty states.** Re-worded the all-empty case ("No documents,
     forms, or invitations") and added per-folder empty pane copy.

### Pre-existing brokenness — what to verify

Amar's note: "my member workspace doesn't 100% work correctly." Worth
auditing whether the brokenness is:

- Pre-existing and not caused by these changes (most likely, since the
  surface has been around a while and the followup mostly added new
  paths rather than rewriting fetches).
- Surfaced or worsened by the rewrite (e.g., the folder restructure
  changing how `activeFolder` initializes after data loads, or the
  empty-state branch taking over when previously a partial render
  showed).
- Caused by `loadVendorMember` now returning `TenantId` — although the
  query just added a column to the SELECT, so no caller should break.

### What to do

1. Smoke-test the care-team workspace with a member who has:
   - Documents but no submissions.
   - Submissions but no documents.
   - Neither (should hit the empty state).
   - Pending invitations to one SR but no submissions/docs yet.
2. Confirm folder switching works for each shape.
3. Confirm Revoke works end-to-end (click → confirm → row updates →
   invitation 410's on the recipient side).
4. If pre-existing brokenness shows up that's NOT related to these
   changes, surface it here so it can be ticketed separately.

### Why this is logged here

Amar wasn't expecting MemberDocumentsTab to get this much rework
inside the followup, and the surface has a known partial-brokenness
state. Logging here keeps the verification step on the radar before
the eventual PR.

---

## B-004 · Care-team notification on new form submission

**Surfaced:** 2026-05-13 (session 2, formalized in session 3 scope
review). Originally drafted as Slice C.2 of the followup; pulled out
during scope-locking to keep the followup tight.

### The ask

When a form submission lands, the care team should get pinged so they
don't have to manually poll the submissions queue. Two related
behaviors the system should support:

1. **Bump the linked share request.** When a submission lands with a
   `ShareRequestId` (set either by invitation linkage or by
   auto-resolver pickup of a member who has open SRs), the linked SR
   should re-surface on whatever care-team queue / dashboard exists.
   Minimum viable: touch a `LastActivityDate` so the SR sorts back to
   the top.
2. **Generic "new submission" signal.** For broader care-team users who
   don't own a specific SR — a way to know "hey, this form was
   submitted, look at it."

### Where this eventually lands

On the **care-team dashboard** as a new-submission indicator (count
badge, recent-activity card, or similar). The dashboard work is a
separate backlog effort; B-004 tracks that this requirement needs to be
folded in when that work starts.

### Open product questions (pending the dashboard conversation)

- **Channel?** In-app indicator first; email opt-in second; Slack/Teams
  later. SMS unlikely.
- **Audience?** All care-team users in the tenant? Only the SR's
  assigned owner? Only when `CreatesShareRequestOnSubmit = 1` + a fresh
  SR was spawned? Likely a mix per role.
- **Granularity?** Per-submission, per-invitation (dedupe multi-use
  invitations), or batched digest?
- **Per-tenant config?** Probably yes — tenants will want different
  cadence / channel preferences.

### Fix shape (minimum-viable first cut, recommended)

- In-app indicator only. A signal on the care-team dashboard / queue:
  "N new submissions since you last looked."
- Click → submissions list filtered to recent + unresolved-or-bumped.
- Schema add: `oe.PublicFormSubmissions.CareTeamSeenAt DATETIME2 NULL`
  (or analogous per-user table if "seen" is per-user). Resets to NULL
  on insert; touched when a care-team user opens the submission detail.
- Bump behavior: on submission insert with a non-null `ShareRequestId`,
  also touch `oe.ShareRequests.LastActivityDate` (or equivalent).

### Why this is held back

- Not just a code change; it's a product conversation about notification
  behavior across the platform.
- Doesn't fit cleanly into the followup spec's slicing; pairs better
  with whatever care-team dashboard work happens next.
- Schema add (`CareTeamSeenAt`) is small but real — wants to land with
  the rest of the dashboard surface in one batch.

---

# Session 3 manual-testing punch list

The following 19 items came out of Amar's manual smoke test of the
forms-page redesign on 2026-05-13. Most are open and should be fixed
on this branch before any PR; a few are deferred to later specs and
flagged as such.

Numbering picks up at B-006 and runs to B-024. Each entry preserves
Amar's voice with a light editorial pass.

---

## B-006 · Kind field still shows when creating a form (deferred)

**Surfaced:** 2026-05-13 session-3 manual test.

The "Create new form" flow on the forms tab still surfaces a Kind
input (transitional shim — title doubles as the kindLabel send to
the backend). The form-editor screen itself also shows Kind during
authoring.

### Status

**Deferred to the form-editor redesign spec** (`2026-05-13-form-editor-redesign-design.md`),
which retires Kind entirely from authoring. Note kept here so the
editor redesign closes this loop.

---

## B-007 · Form editor save lacks confirmation + redirect

**Surfaced:** 2026-05-13 session-3 manual test.

After saving an edit on a form template, the editor doesn't redirect
back to the forms list and the only "saved" affordance is a toast at
the top of the page — you have to scroll up to know anything
happened.

### Fix shape

- After successful save, either:
  - Redirect to `${routeBase}` (forms list) with a transient success
    banner up top, or
  - Show an in-page toast/banner that auto-scrolls into view (or use
    a fixed-position toast so scroll position doesn't matter).
- Apply to both "Save draft" and "Save & publish" paths.

### Status

Open.

---

## B-008 · Form editor has two separate save buttons (deferred)

**Surfaced:** 2026-05-13 session-3 manual test.

The editor has one save for the top settings panel and a separate
save for the form definition itself. Care team has to click twice to
fully save.

### Status

**Deferred to the form-editor redesign spec.** That redo replaces
the entire authoring surface; consolidating the saves is naturally
part of that work.

---

## B-009 · Forms tab "Updated Nh ago" timestamps inaccurate

**Surfaced:** 2026-05-13 session-3 manual test.

Forms list rows show "Updated 1h ago" even for templates that were
just edited or uploaded seconds ago.

### Fix shape

- The frontend `formatRelative()` in
  `TenantSharingFormsPage.tsx` reads `t.ModifiedDate || t.CreatedDate`.
  Verify that:
  1. The backend `UPDATE oe.PublicFormTemplates SET ... ModifiedDate = SYSUTCDATETIME()`
     fires on edits (`updateTemplateMeta` does; check version
     create / publish too).
  2. `ModifiedDate` is returned in the list response (it is, per
     `listTemplatesForTenant`).
  3. The frontend's relative formatter computes minutes correctly
     for very recent times — the current `< 1 day` branch always
     returns "Nh ago", even when the gap is under an hour. Add a
     `< 1h` branch returning "Just now" or "Nm ago".

### Status

Open.

---

## B-010 · Forms tab — direct Send / Copy / View on each row

**Surfaced:** 2026-05-13 session-3 manual test.

Send to member, Copy share link, and View are all buried inside the
kebab menu. The care team should be able to send a form in one
click from the list, not two.

### Fix shape

- Lift `Send to member`, `Copy share link`, and `View` out of the
  kebab and render them as small action buttons on the right side of
  the row (next to the kebab, or replacing it for these primary
  actions).
- Keep the kebab for the longer tail: Edit, Activate/Deactivate,
  View invitations, Delete, Open share link in new tab.
- Gate each button on the same flags as today (Send: AllowTargeted ||
  AllowAuthenticated && IsPublished; Copy: AllowAnonymous; View:
  always).

### Status

Open.

---

## B-011 · Send-to-member SR picker missing open-date column

**Surfaced:** 2026-05-13 session-3 manual test.

When the Send modal shows the member's open share requests, each
row displays RequestNumber + RequestType + Status. The date the SR
was opened is missing — care team would like that context.

### Fix shape

- Extend `GET /members/:id/open-share-requests` to return
  `CreatedDate` (or whichever field represents "opened" on the SR
  schema).
- Update `LinkagePicker` to render the date alongside the
  RequestNumber/Type/Status line.

### Status

Open.

---

## B-012 · Send modal needs an Anonymous broadcast-link delivery option

**Surfaced:** 2026-05-13 session-3 manual test.

Today's Send-to-member modal offers two delivery modes: targeted
(no login, signed link) and authenticated (login required). The
care team also wants a path to send a form using the **plain
anonymous link** — currently they have to copy the link manually
from the forms list and email it themselves.

### Fix shape

- Add a third option to the Send modal's mode step: "Anonymous link"
  (rename to something clearer if needed — "Broadcast link"?). Only
  enabled when the template has `AllowAnonymous=true`.
- For Anonymous mode, the modal skips invitation creation entirely
  and instead emails (or copies) the public `/forms/:templateId`
  link to the recipient. No token; no audit row.
- Audit trail: optional — when the modal sends an anonymous link via
  email, log it as a `PublicFormEmailLog` row with `EmailType =
  'anonymous-broadcast'` (similar to existing routing-notification
  paper trail) so the care team knows it went out.

### Status

Open. Adds a third invitation path that the existing schema doesn't
quite cover (no token to revoke); think through audit trail before
implementing.

---

## B-013 · Submissions list member column blank for targeted/authenticated

**Surfaced:** 2026-05-13 session-3 manual test. Sent a targeted
invitation via copy-link, opened it, submitted; submissions tab row
showed Source=targeted, Resolution=resolved·linked, but the Member
column rendered empty. Opening the submission detail showed the
member name correctly.

### What's happening

`TenantSharingSubmissionsPage` derives the Member column from
`s.PayloadFirstName + s.PayloadLastName`. Targeted and authenticated
submissions don't populate the payload's name fields from the form
(the recipient never types them — the invitation is pinned), so
those columns are NULL in the submission row.

### Fix shape

- Backend `listSubmissions` SELECT needs to JOIN Members → Users on
  `s.MemberId` and return `u.FirstName` / `u.LastName` as
  `MemberFirstName` / `MemberLastName`.
- Frontend: prefer the joined `MemberFirstName + MemberLastName` for
  the Member column; fall back to `PayloadFirstName +
  PayloadLastName` only when the joined fields are NULL (anonymous +
  unresolved submissions still need the payload values).

### Status

Open. Fix on this branch.

---

## B-014 · SR Documents-and-Forms — form rows should open a preview modal

**Surfaced:** 2026-05-13 session-3 manual test.

On a share request's Documents and Forms tab, clicking a form
submission row currently redirects to the submission detail page.
The care team would prefer a **modal pop-up** that previews the
submitted info inline (form title, when submitted, the answers),
with buttons to open the full submission detail or to navigate to
the invitation audit.

### Fix shape

- New `SubmissionPreviewModal` component reused across surfaces.
- On SR Documents-and-Forms tab, clicking a form row opens the
  modal instead of navigating away.
- Modal contents:
  - Header: form title + submitted date+time + source pill
  - Body: payload answers in a read-only `payloadToRows` grid
  - Buttons: "Open full submission" (navigates to
    `/.../submissions/:id`), "Close"
- Pairs with B-015 to also expose Extend/Revoke on this modal when
  the row is an invitation rather than a submission (see B-016).

### Status

Open.

---

## B-015 · Invitations need Extend-expiry action (forms tab + SR modal)

**Surfaced:** 2026-05-13 session-3 manual test.

The per-template Invitations sub-page already has Revoke + Copy
actions on active rows, but the only meaningful adjustment to an
active invitation besides revoking is **extending its expiry**. No
UI for that today; the schema supports it (`ExpiresAt` is just a
DATETIME2 column).

### Fix shape

- Backend: new endpoint
  `PATCH /api/me/{vendor|tenant-admin}/public-forms/invitations/:id`
  with body `{ expiresAt: ISOString }`. Tenant-isolated; rejects if
  the invitation is revoked or already expired.
- Frontend: add an "Extend" action to:
  - The per-template Invitations sub-page rows (active only).
  - The SR-detail modal from B-014 when an invitation row is shown
    (paired with B-016).
- UX: a small date picker or "extend by 7 days" quick-set.

### Status

Open.

---

## B-016 · SR Documents-and-Forms should show sent-but-unsubmitted invitations

**Surfaced:** 2026-05-13 session-3 manual test.

When a form is sent (invitation created) with a linked share
request, the SR Documents-and-Forms tab shows **nothing** until the
recipient submits. The care team should be able to see "we sent this
form, it's pending" inline with the SR's other docs.

### Fix shape

- Backend: extend `GET /share-requests/:id/form-submissions` (or add
  a sibling endpoint) to also return active invitations linked to
  that SR via `LinkedShareRequestId`.
- Frontend: render invitations as their own rows in the section
  with a status pill:
  - `Sent` — created, not yet viewed (FirstUsedAt is NULL).
  - `Opened` — link viewed (need to track `FirstOpenedAt` or repurpose
    `FirstUsedAt`; today `FirstUsedAt` flips on first GET, so it can
    serve as "opened").
  - `Submitted` — at least one submission exists; collapses into the
    existing submission row.
- Avoid the word "Sent" alone if it implies "submission received";
  the spec literally calls out wanting different language so the
  care team doesn't confuse `Sent` invitation with `Submitted` form.
  Probably: invitation rows say `Awaiting submission` or
  `Pending — sent {date}` while submission rows say `Submitted {date}`.
- Pairs with B-014's preview modal and B-015's Extend/Revoke actions.

### Status

Open.

---

## B-017 · Copy buttons don't actually copy

**Surfaced:** 2026-05-13 session-3 manual test. Verified in two
places: the Send modal's "Copy link only" delivery path, and the
forms-tab kebab's "Copy share link" item.

### What's happening

Both call `navigator.clipboard.writeText(...)` inside an async
function. The button click triggers the call but no clipboard write
occurs. Possible causes:

1. Browser permission policy — `clipboard-write` may be blocked
   inside the dev container's localhost frame ancestor.
2. The async function's clipboard call may happen outside the user-
   activation window if there's an `await` before it.
3. The call may be silently throwing and being caught — the existing
   try/catch swallows errors.

### Fix shape

- Move `navigator.clipboard.writeText()` synchronously inside the
  click handler (no `await` before it) so user-activation is
  preserved.
- Fall back to a `document.execCommand('copy')` trick using a
  hidden textarea when `navigator.clipboard` is unavailable.
- Log clipboard errors instead of swallowing.
- Smoke test in the actual dev container, not just localhost.

### Status

Open. Both call sites have the same bug; one shared helper would
clean this up.

---

## B-018 · E.1 soft warning not firing on editor save

**Surfaced:** 2026-05-13 session-3 manual test. Created an anonymous
form with no identity fields (no Member ID, no email, no name, no
DOB) and saved/published — no warning banner appeared.

### What's happening

E.1 was planned as part of the followup spec but deferred to the
form-editor redesign per session-3 scope-locking. So it's **not yet
implemented** — Amar's expectation was incorrect that it had
shipped. Still worth tracking as a real issue.

### Fix shape

Two options:

1. Implement E.1 now on this branch (frontend-only — parse the
   definition `fields` array, check `name` against the well-known
   identity-field list, render a banner above the editor when
   `AllowAnonymous=1` and the set is empty).
2. Keep it deferred to the editor redesign (the original plan).

### Status

Open — needs a decision. If implemented now, this also feeds the
"forms list warning badge" half of Q8 in the redesign spec (which
was locked to "both surfaces"). Implementing both at once may be
the cleanest path.

---

## B-019 · Authenticated prefill — email + phone not populated

**Surfaced:** 2026-05-13 session-3 manual test. Filled out an
authenticated form as a member; first name and last name were
prefilled correctly, but email and phone were blank.

### Fix shape

- Inspect `publicFormInvitationPrefillService.js` (or wherever the
  12 well-known fields are mapped).
- Verify the field-name match logic: it may be looking for `email`
  while the form definition uses `emailAddress`, or `phone` vs
  `phoneNumber`. Field name normalization may need a fuzzy match.
- The backend likely does have the email and phone (the member's
  `u.Email` and `u.PhoneNumber`); the mapping is the suspect.

### Status

Open.

---

## B-020 · Submission payload viewer mixes form fields + account-derived metadata

**Surfaced:** 2026-05-13 session-3 manual test. Authenticated form
only had four fields (text, firstName, lastName, email, phone) but
the submission detail's payload section showed 11 — adding memberId,
dateOfBirth, relationToPrimary, addressLine, addressCity,
addressState, addressZip. Those came from the authenticated prefill
overwrite, not from anything the recipient typed.

### Fix shape

Conceptually the submission's payload should distinguish:

- **Form-asked answers** — fields the recipient saw and could
  edit/submit.
- **Account-derived metadata** — fields the server prefilled or
  stamped from the member's profile (authenticated-mode overwrite).

Options:

1. UI-only: render two grids on the submission detail page — "Form
   answers" (fields in the form definition) vs "Account snapshot"
   (other keys in the payload). The split is computed by
   intersecting the definition's `fields[].name` list with the
   payload keys.
2. Data-level: stop storing the account-derived metadata in
   `PayloadEncrypted` — keep it on the audit log or join from
   `oe.Users` at read time. Bigger change.

Recommendation: Option 1 for fast iteration; can revisit data shape
later.

### Status

Open.

---

## B-021 · Forms that spawn share requests can be linked to a different SR (deferred)

**Surfaced:** 2026-05-13 session-3 manual test.

If a form has `CreatesShareRequestOnSubmit=1` (UA / PC and any
custom template opted in), it's still possible to link a submission
to an existing SR. That doesn't really make sense — the form's
purpose is to create a NEW SR. Linking it to an existing SR
contradicts the model.

### Status

**Deferred — Amar will look into this later.** Not blocking on this
branch. When picked up, fix shape is:

- Either: disable the Linkage panel + Send-modal linkage picker
  when the chosen template has `CreatesShareRequestOnSubmit=1`.
- Or: allow it but document the resulting behavior (does the auto-SR
  still fire? Or does the explicit linkage win?).

---

## B-022 · Discrepancy parens don't render — investigate

**Surfaced:** 2026-05-13 session-3 manual test. Could not see the
A.3 parens diff on any submission.

### What's happening

The current implementation only renders parens when
`AuthMode === 'anonymous'` — the spec says "only relevant for
auto-resolved submissions" and auto-resolution only happens on
anonymous submits. For targeted/authenticated submissions, the
parens are intentionally suppressed.

Amar's test was on a targeted submission, so the suppression is
working as designed. But the spec assumption may need revisiting:

- If a targeted recipient is the wrong member (sent to alice@x but
  bob picked up the link), the payload still pins to alice's
  MemberId — but the typed name might say "bob smith." Worth
  surfacing?
- For authenticated submissions where the user typed a name
  different from their profile, similar story.

### Fix shape

Two options:

1. **Keep current behavior** — parens render only for
   AuthMode='anonymous'. Document this in the membership panel UI
   ("auto-resolved submission" badge). Then create a couple of
   anonymous submissions with name typos to verify parens DO show.
2. **Widen the trigger** — parens render whenever payload identity
   diverges from the resolved member's profile, regardless of
   AuthMode. The pinning logic stays unchanged; the diff display is
   purely informational.

Recommendation: 2 — the diff is informational; suppressing it for
targeted/authenticated removes useful signal.

### Status

Open. Verify which option the team wants. Either way, also smoke-test
with an anonymous submission that creates a real mismatch (e.g.
submit member ID 12345 but type the wrong name) so we know the
parens actually render when they should.

---

## B-023 · Form preview width too narrow

**Surfaced:** 2026-05-13 session-3 manual test. Opening the View
button preview shows the form in a narrow container — looks
"embedded" rather than a clean preview.

### Fix shape

- Widen the preview container's `max-w-*` setting on
  `TenantSharingFormPreviewPage` (currently `max-w-3xl`).
- Consider scaling down the form fields proportionally so the
  preview reads as a faithful screenshot rather than a stretched-out
  recipient view.
- Alternative: render preview in a centered, fixed-width container
  closer to what a recipient sees on desktop (~720px), and let the
  preview rendering use `PublicFormView` at its native sizing.

### Status

Open. Trial different widths and pick one that reads as "preview"
not "live form."

---

## B-024 · Forms tab — priority + sort defaults

**Surfaced:** 2026-05-13 session-3 manual test.

Two related issues:

(a) The "Create new form" section is pre-rendered at the top with
   a pre-populated input. Amar's intuition: creating a new form is
   rare; the inline section steals attention from the day-to-day
   action (searching + finding an existing template).

(b) Today's templates are sorted alphabetically by title. Care team
   would benefit from a smarter default:
   - Templates with `CreatesShareRequestOnSubmit=1` at the top
     (these are the intake forms; most-used flow).
   - Within each group, sort by `SubmissionCount DESC` so
     frequently-used templates surface first.

### Fix shape

- Replace the inline "Create new form" section with a small
  `+ New form` button in the top-right corner of the page header
  (next to the title, gated on `canEdit`). Clicking opens a small
  inline modal or expands a row at the top — but not always-visible.
- Change the default sort: SR-spawning first (`createsSr DESC`),
  then `submissionCount DESC`, then `title ASC` as a tiebreaker.
- Keep the search input and filter row visible at the top; that's
  what care team uses constantly.

### Status

Open.

---

## B-025 · Forms tab row buttons shift when actions are missing ✅ resolved

**Surfaced:** 2026-05-13 session-3 manual testing.

Each forms-tab row renders View / Send / Copy / kebab on the right
side. Send is gated on `canSendToMember`; Copy is gated on
`allowAnon`. When an action was hidden, its siblings shifted right,
making the row alignment inconsistent across the list.

### Fix shape ✅

Each of View / Send / Copy now lives in a fixed-width slot
(`w-[72px]` / `w-[80px]`) inside the right-hand stack. When the
underlying action isn't applicable for a row, an invisible
placeholder of the same width holds the spot. Care team's eye learns
the layout: View | Send | Copy | kebab — stable across rows.

---

## B-026 · Form preview narrow + double-container

**Surfaced:** 2026-05-13 session-3 manual testing.

The View button's preview rendered the form inside a white container
nested inside another white container, sitting on a gray page —
producing a confusing double-card look that read more like an
embedded widget than a faithful screenshot.

### Fix shape ✅

`TenantSharingFormPreviewPage`: removed the inner white card wrapping
`PublicFormView` and the scale transform. The page now uses a single
container at `min(65vw, 1100px)` width with the gray page background
showing through, and `PublicFormView` renders its own card chrome
directly inside. Wider on desktop without losing the screenshot
feel.

---

## B-027 · "New form" button still prompts for a title ✅ resolved

**Surfaced:** 2026-05-13 session-3 manual testing.

Clicking the `+ New form` button toggled an inline panel asking for
the title before creating the template. Care team's expectation: it
should take them straight to the editor where they'd enter the title
along with everything else.

### Fix shape ✅

`TenantSharingFormsPage`: removed the inline create panel entirely.
Clicking `+ New form` now creates a draft template with a default
title (`"Untitled form"`) and immediately navigates to the editor,
where the title field is already editable. One click instead of
three.

---

## B-028 · SR Documents-and-Forms two-section split + Resend modal

**Surfaced:** 2026-05-13 session-3 manual testing.

Two complaints rolled together:

1. The SR Documents-and-Forms tab had "Forms sent — pending
   submission" and "Forms linked to this share request" as two
   separate `<section>` cards. The "linked to this share request"
   header didn't strongly convey that those rows are submitted forms.
2. Pending invitations needed a Resend affordance that lets the care
   team choose email vs copy-link delivery.

### Fix shape ✅

#### Combined section

The two sections merged into one "Forms" card with two sub-sections:

- **Pending submission (N)** — invitation rows (status pill,
  recipient email, expiry, Extend / Revoke / Resend actions).
- **Submitted (N)** — submission rows (date+time, member info,
  grouping, parens diff, click to open preview modal).

Sub-section headers use a gray-50 strip with an uppercase label so
the visual separation between "we sent it" and "they filled it out"
remains crisp.

#### Resend modal

New `POST /api/me/{vendor|tenant-admin}/public-forms/invitations/:id/renew`
endpoint and a service-layer `renewInvitation()` helper:

1. Revokes the old invitation (the original recipient link returns
   410 immediately).
2. Issues a fresh invitation with the same template / member / mode
   / linkage / recipient and a fresh 7-day expiry.
3. If `deliveryMethod === 'email'`: queues the email via SendGrid
   using the existing `sendInvitationEmail` path.
4. Returns the new `{ invitationId, url, expiresAt }`.

UI: Resend button on each pending row opens a modal showing the
recipient email on file, a short explainer
(*"issues a fresh link and revokes the old one"*), and two action
buttons:

- **Email new link** → calls renew with `deliveryMethod=email`,
  shows success when queued.
- **Copy new link** → calls renew with `deliveryMethod=copy`, copies
  the returned URL via `copyToClipboard()`, shows success when
  copied.

Why renew instead of true resend: the plaintext token is never
stored, only the SHA-256 hash, so re-sending the original URL
isn't possible without a security regression. Revoke-and-recreate
preserves the same security model while still letting the care team
get a fresh link to the recipient.

---

## Resolved during testing

These were caught manually but had a clear root cause and got fixed inline
rather than being held back. Kept here as a paper trail for the PR description.

- **Invitation URL fell back to `localhost`** (fixed 2026-05-13). The Send
  modal's "Copy link only" returned `http://localhost:5173/forms/i/<token>`
  because `buildInvitationUrl` only read env vars. Now resolves through the
  shared `resolveSubmissionLinkBase(req)` helper from `publicFormNotifyService`
  (env → request `Origin` → `Referer` → forwarded proto+host → localhost
  fallback). Vendor + tenant-admin invitation create routes pass `{ req }`.
- **`trim()` of undefined when rendering a targeted form** (fixed 2026-05-13).
  Both new invitation GET endpoints handed the raw `DefinitionJson` *string*
  to `definitionWithAuthenticatedHeaderImage`, which returns its input
  unchanged for non-objects — so the frontend received a string instead of
  a parsed object and `PublicFormView`'s `def.title.trim()` crashed. Both
  endpoints now parse the JSON (with a 500 fallback on parse error) before
  the SAS-resolver call, matching the existing anonymous GET path.

---

## Reporting new blockers

Add a new section here with:
- Sequential `B-NNN` id
- 1-line title
- **Surfaced:** date + how it was found
- **Where:** file + line, or endpoint
- **What the spec says** vs **What the current code does**
- **Fix shape**
- **Why held back** (so the next batched PR can pick the right grouping)
