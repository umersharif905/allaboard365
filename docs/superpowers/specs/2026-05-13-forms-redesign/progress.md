# Forms redesign — progress snapshot

**Date:** 2026-05-13
**Branch:** `fix/back-office/forms-redesign` (off `staging`, 9 commits)

Where we are at the end of the second working session. The original `design.md`
9 sections + 44-feature inventory have been implemented in code to the point
described below. The bottom half of this file captures **Amar's preferences
for the not-done items** — these are inputs for the follow-up spec
(`2026-05-13-forms-redesign-followup-design.md`), NOT decisions to implement
right now.

---

## What we built — section-by-section audit

### Locked-in design decisions (design.md lines 13–34)

| # | Decision | Status |
|---|---|---|
| 1 | Phase 0 ships separately + spec covers Phases 1–4 | ✅ Phase 0 in `7c160d8f`, Phases 1–4 in 8 subsequent commits |
| 2 | Three independent delivery-mode booleans + CHECK constraint | ✅ migration `2026-05-13-forms-redesign.sql` |
| 3 | Member Documents tab universal home + optional SR/Case linkage | 🚧 SR side ✅; Member side flat list, no folder-per-SR yet |
| 4 | Submission visible on member Documents tab AND linked SR detail | 🚧 SR detail ✅; member visibility ✅ (flat); cross-linking present |
| 5 | `CreatesShareRequestOnSubmit` flag replaces fall-through; UA+PC backfill | ✅ migration + `publicFormShareLinkService.js` gating |
| 6 | UI grouping of UA + PC under "Share Request Intake" | ⏳ NOT done — care team form list shows them ungrouped |
| 7 | Vendor agent Phase 0 (read access) | ✅ commit `7c160d8f` |
| 8 | Architecture A — extend existing tables + one new `oe.PublicFormInvitations` | ✅ matches what shipped |

### Section 1 — Data model & schema changes (Phase 1 schema)

All schema changes ✅ applied to `allaboard-testing`:

- ✅ `PublicFormTemplates`: 4 BIT columns + `CK_PublicFormTemplates_AtLeastOneMode`
- ✅ `PublicFormSubmissions`: `CaseId`, `AuthMode`, `InvitationId`, `PayloadEmail`, `PayloadPhone`
- ✅ `PublicFormInvitations`: new table with all 16 columns + 4 indexes + 5 FKs
- ✅ `CreatesShareRequestOnSubmit=1` backfill for `UnsharedAmount` + `PreventiveCare`

### Section 2 — Delivery mode policy & care-team UI (Phase 1 UI)

- ✅ Editor "Delivery settings" panel — 4 toggles + inline error
- ✅ "Get share link" + "Send to member" buttons gated on flags
- ✅ Send-to-member modal — 4 steps wired (`SendToMemberModal`)
- ✅ Targeted-mode recipient greeting block at top of form
- ✅ All 4 invitation endpoints (POST create, GET list, GET single, DELETE revoke) on both vendor + tenant-admin routes
- ⏳ Multi-submission grouping UX (feature 013) — "Latest" chip stack NOT built; same-invitation submissions render as separate rows
- 🚧 Frontend revoke button (feature 015) — backend DELETE works, no UI button yet
- ⏳ UI consolidation of UA + PC under "Share Request Intake" (decision #6)

### Section 3 — Targeted-link flow (Phase 2)

- ✅ `GET /api/public/forms/invitations/:token/meta` (lightweight, mode + title only)
- ✅ `GET /api/public/forms/invitations/:token` (targeted full payload + greeting) — bug-fixed during testing (JSON parse)
- ✅ `POST /api/public/forms/invitations/:token/submit` — submit with invitation-pinned MemberId/InvitationId/AuthMode/ShareRequestId/CaseId
- ✅ `/forms/i/:token` frontend route + `InvitationFormPage`
- ✅ Greeting affordance ("This form is for you, {firstName} ({sentToEmail})")
- ✅ Expiry / revocation enforcement — 410 Gone, generic "link no longer valid" UI
- ✅ Token mechanics — 32-byte random, SHA-256 stored, 7-day default expiry
- ✅ Multi-use within expiry — `FirstUsedAt` stamped on first submit, idempotent
- 🚧 Browser verify of submit pending the canonical PHI key (see B-002)

### Section 4 — Authenticated submission flow (Phase 3)

- ✅ `GET /api/me/member/forms/invitations/:token` (auth-gated, member-match)
- ✅ `POST /api/me/member/forms/invitations/:token/submit` (server-authoritative prefill overwrite)
- ✅ `publicFormInvitationPrefillService` — 12 well-known field mappings (firstName, lastName, email, phone, memberId, dateOfBirth, relationToPrimary, address × 5)
- ✅ Mismatch 403 handling
- ✅ Login `returnTo` honored
- 🚧 Pre-login zero-disclosure (feature 026) — redirect works, but login page does NOT show "Log in to fill in: {formTitle}" copy
- ⚠️ The §4 re-review asterisk — we audited and `req.user.MemberId` is NOT auto-populated; route handler does its own `SELECT MemberId FROM oe.Members WHERE UserId = ...`. Correct call.

### Section 5 — Submission destination & findability (Phase 4)

- ✅ Auto-resolver runs on submit — was already firing inline; confirmed not regressed
- ✅ `PayloadEmail` + `PayloadPhone` columns populated at write time
- ✅ Targeted/authenticated mode skips resolver, anonymous runs it
- ✅ SR DocumentsTab renamed "Documents and Forms" + new "Forms linked to this Share Request" section
- ✅ New `GET /api/me/vendor/share-requests/:id/form-submissions` endpoint
- ✅ New `GET /api/me/vendor/members/:id/form-submissions` endpoint
- 🚧 Member workspace folder structure — forms render as a flat list below docs, NOT folder-per-SR / "Other submissions" / Case folder (see preferences below)
- 🚧 Endpoint shape — spec called for extending `/members/:id/documents` response with `{ folders: [...] }`; added a separate `form-submissions` endpoint instead. Same data reachable.
- ⏳ Multi-submission grouping inside folders (same as §2 #013)
- ⏳ Membership data discrepancy display (feature 033) — `Sarah Johnson (Sarah Jonson)` parens NOT rendered anywhere
- ⏳ Submissions filter additions (feature 034) — neither `source` nor `resolution status` filters added
- ⚠️ Member's own portal `Documents.tsx` page — explicitly **out of scope** per spec line 411; correctly untouched (moving to blockers per Amar's request)

### Section 6 — Per-send linkage UI

- ✅ Linkage picker visible in Send modal Step 3 (open SRs left column, disabled Cases right column)
- ✅ `GET /members/:memberId/open-share-requests` on vendor + tenant-admin
- ⏳ Retroactive linkage panel on submission detail (feature 037) — NOT built
- ⏳ `PATCH /submissions/:id/linkage` endpoint (feature 038) — NOT built
- ⏳ Soft warning when anonymous form lacks identity fields (feature 039) — NOT built
- 🚧 Linkage picker not extracted as a reusable component yet — inlined in `SendToMemberModal`; would need extraction for retroactive linkage panel
- ✅ Audit trail intent (invitation `LinkedShareRequestId` vs submission `ShareRequestId`) — schema supports the divergence; per spec, no separate audit log needed in this phase

### Section 7 — Migration & rollout

- ✅ `2026-05-13-forms-redesign.sql` written
- ✅ Applied to `allaboard-testing` (20 batches, no errors)
- ✅ Backfill ran (`UnsharedAmount` + `PreventiveCare` set to `CreatesShareRequestOnSubmit=1`)
- ⏳ Pre-deploy audit query (feature 042) — written into the spec, NOT yet run against a prod replica
- ⏳ `AdditionalDocuments` template hidden from create-form list (feature 043) — NOT done; still visible in editor UI
- ⏳ Deploy to prod — not started, this branch hasn't been merged

### Section 8 — Vendor agent access fix (Phase 0)

- ✅ Backend `authorize([...])` updated for read + resolve endpoints (commit `7c160d8f`)
- ✅ Frontend hides edit / publish / delete buttons when `userType === 'VendorAgent'`
- 🔒 **B-001 blocker** — spec line 184 says VendorAdmin should be able to "Create / edit / publish / delete template", but current code blocks publish + delete for ALL vendor roles. Confirming correct behavior with a higher-up.
- ⏳ Browser verification with `test@sharewellpartners.com` (current login is VendorAdmin flavor; VendorAgent flavor verify still owed)

### Section 9 — Testing strategy

- ⏳ **None of the test files in the spec exist** — by direction ("fast iteration"). Spec lists 7 backend Jest files + 4 Vitest specs + 12 Cypress specs. All deferred.

### Out of scope (line 621) — confirmed untouched

- Form editor redesign (screener-driven branching)
- Cases feature itself
- Configurable invitation expiry
- Single-use invitations (current behavior IS multi-use within 7-day window)

---

## Tally

| Status | Count |
|---|---|
| ✅ Done | ~30 |
| 🚧 Partial / minimum viable | 6 |
| ⏳ Not started | 9 |
| 🔒 Blocker | 2 (B-001 VendorAdmin publish, B-002 PHI key) |

**Net:** Phases 0–3 functionally complete in code. Phase 4 at minimum-viable
(no folder grouping). Section 6 retro-linkage and Section 5
discrepancy/filters unstarted. Tests entirely deferred.

---

## Amar's preferences on the not-done items

Captured here so the follow-up spec author has the constraints up-front. These
are **directional preferences**, not implementation instructions. They feed
into `2026-05-13-forms-redesign-followup-design.md`.

### Multi-submission grouping UX (013)

- Primary goal: give the care team a sense of **what the latest form is**.
- Group same-`InvitationId` submissions in the UI (collapse into a stack).
- Current rendering has a date stamp; add a **time stamp** alongside it so the
  care team can tell at a glance which submission within the group is newest.

### Frontend revoke button (015)

> "Is this front end revoke for the revoking of a form? So kind of setting the
> expiration early so the customer can't fill out the form anymore?"

**Yes — that's exactly what it does.** Confirmation: the backend
`DELETE /api/me/{vendor|tenant-admin}/public-forms/invitations/:id` sets
`RevokedAt = SYSUTCDATETIME()`. After that, the recipient's link returns
410 Gone immediately, no matter what the original `ExpiresAt` was. Frontend
just needs the button + confirmation dialog.

### UA + PC consolidation under "Share Request Intake" (decision #6)

> "Not sure what this means, kind of at all."

**Plain-English explanation:**

- `UnsharedAmount` (UA) is the seeded template for Medical/Maternity share
  request intake. `PreventiveCare` (PC) is the seeded template for Wellness
  share request intake. Today the care team forms list shows them as two
  separate rows with their full kind labels.
- The spec asked to **group them under one heading "Share Request Intake"** in
  the care team forms list — purely cosmetic. The templates stay separate at
  the DB / API level. Care team picks UA or PC under the group header.
- The reason: today's UI exposes the underlying schema split (UA vs PC), which
  is confusing for care team members who think of both as "intake form for a
  new share request." Decision is: hide the split in the UI, keep it in the
  data.
- **Open question for Amar:** is this worth doing now, or is it absorbed by
  the future form editor redesign that consolidates UA + PC via
  screener-driven branching? If the editor redesign is coming, this cosmetic
  step might be redundant.

### Member workspace folder structure (028/029)

Sharper requirements than the original spec:

- Each share request a member has already gets its own folder under the
  member's Documents tab.
- A form submission linked to SR #7 should appear **inside the SR #7 folder
  only**. Clicking SR #6 or SR #8 should NOT show the SR #7 form submission.
- **Additionally**, add a new sidebar folder called **"Form submissions"**
  that holds **every** form submission for that member — regardless of
  whether it's linked to an SR, a Case, or nothing.
- (This is slightly different from the original spec's "Other submissions"
  folder, which only held unlinked submissions. The new requirement: "Form
  submissions" is a flat consolidated view of ALL of the member's
  submissions, alongside the per-SR / per-Case folders.)

### Membership data discrepancy display (033)

- Should appear in **two places** when a form's submitted name / email /
  phone differs from the resolved member's profile:
  1. On the **share request page** where the submission is linked.
  2. On the **form submission detail page** itself.
- Only relevant for forms that auto-resolved from a member-submitted
  identity field (e.g. submitted member ID matched a record).

### Submissions filters + new notification system (034)

Two distinct asks rolled into one ticket:

1. **Filters** — confirmation that the spec's intent was to add filters that
   make it easy to find forms which have NOT been auto-resolved to a member.
   Currently the submissions list is unfiltered. Filters needed:
   - Resolution status (unresolved / resolved-not-linked / resolved-linked / all)
   - Source (anonymous / targeted / authenticated / all)
2. **NEW — care-team notification on new submission.** Not in original spec.
   Requirements:
   - When a form submission arrives, notify the care team somehow.
   - Two flavors the system might want to support:
     - **"Bump" the linked share request** — raise it on the queue, show a
       new-activity badge, or similar, so the linked SR re-surfaces.
     - **Generic notification** — "Hey, this form was submitted, look at it
       again" for the broader care team audience that isn't owning the SR.
   - Open: what notification channel(s)? In-app indicator? Email? Both?
     Per-tenant config?

### Retroactive linkage panel on submission detail (037)

- Build it out. Per spec §6: panel that lets an admin retroactively link an
  auto-resolved submission to an SR (or future Case) using the same
  two-column picker as the Send modal.
- Open: lump with the broader form-page UI redesign (next-next spec) or do
  standalone? Lumping is fine if the redesign is coming soon.

### Soft warning when anonymous form lacks identity fields (039)

- Needed. Form-builder side: when a vendor admin (or tenant admin) saves a
  template with `AllowAnonymous = 1` AND no well-known identity fields,
  show a non-blocking banner: "submissions to this form may not be
  resolvable to a member. Consider adding a Member ID field, or limit this
  form to Send-to-member / Authenticated delivery only."
- Soft warning only — admin can save anyway.

### `AdditionalDocuments` template hidden from create-form list (043)

- Roll this into the form-page UI redesign (next-next spec). Not urgent
  enough to land standalone.

### Member's own portal Documents.tsx — moved to blockers

- This was originally out of scope per spec line 411. Promote to a tracked
  blocker (in `blockers.md`) with more context so future spec authors know
  this is on the radar.

### B-001 VendorAdmin publish / delete — held

- Keep the blocker as-is. **Confirming correct behavior with a higher-up**
  before implementing. Spec line 184 (VendorAdmin publish = ✅) may or may
  not be the desired product behavior; current code locks publish to
  TenantAdmin + SysAdmin. Pending decision.

---

## Next-spec scope outline

The follow-up spec at `2026-05-13-forms-redesign-followup-design.md` should
cover the preferences captured above. Recommended slicing:

- **Slice A — surface polish:** revoke button (015), date+time stamp on
  submissions list (013 partial), grouping UX (013), discrepancy parens
  display (033).
- **Slice B — member workspace folders:** the per-SR / "Form submissions"
  folder restructure (028/029).
- **Slice C — submissions queue:** filters (034) + new care-team
  notification system (034 extension).
- **Slice D — linkage panel:** retroactive linkage panel + PATCH endpoint
  (037/038).
- **Slice E — editor polish:** soft-warning banner (039), UA+PC grouping
  decision (#6) if not absorbed by the future form-editor redesign.

Deferred to the eventual broader **form-page UI redesign** (separate later
spec, not this followup):

- `AdditionalDocuments` hide (043)
- 037 could also live here if Amar prefers.
