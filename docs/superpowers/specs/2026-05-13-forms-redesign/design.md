# Forms redesign — design

**Date:** 2026-05-13
**Branch:** `fix/back-office/forms-redesign` (off `staging`)
**Status:** all sections drafted (1–9) — awaiting user review before implementation.

## Summary

Restructure the back-office forms system so each form template declares its allowed delivery modes (anonymous / targeted / authenticated), so the care team can send forms directly to a known member with prefilled fields, and so submissions tied to a known member have a universal home on the member profile Documents tab. Per-send linkage attaches submissions to an existing ShareRequest (today) or Case (when Cases ships) without coupling forms to that workflow.

See `current-system-problems.md` for the concrete problems this replaces.

## Locked-in design decisions

1. **Phasing.** Phase 0 (vendor agent backend fix) ships as a standalone small PR before this spec lands. This spec covers Phases 1–4: delivery modes, targeted send, authenticated submission, member-profile destination. Form editor redesign and the consolidation of intake forms via screener-driven branching are a separate later spec.

2. **Delivery mode policy.** Each form template declares three independent booleans:
   - `AllowAnonymous` (default 1) — shareable link, anyone can fill
   - `AllowTargeted` (default 0) — care-team-issued signed link for a specific member, no login required
   - `AllowAuthenticated` (default 0) — recipient must log into member portal first; full profile prefill

   CHECK constraint requires at least one mode allowed. Form creator picks the combination at creation time; care team picks one of the allowed modes at send time.

3. **Submission destinations.** Member Documents tab is the universal home for any submission with a known MemberId. A submission can optionally link to one ShareRequest (`ShareRequestId`, existing) and/or one Case (`CaseId`, new nullable column reserved for future use). Linkage is per-send, not per-template.

4. **Findability.** A submission linked to an SR appears on the member profile Documents tab AND on the SR detail page (new Forms section). Same row in the data; two indexed views. The Case-linked equivalent will exist when Cases ships.

5. **Auto-SR-creation behavior.** A new template flag `CreatesShareRequestOnSubmit` (default 0) replaces today's `FormKind`-slug fall-through. The two existing intake templates (`UnsharedAmount`, `PreventiveCare`) are backfilled to 1. `AdditionalDocuments` template is deprecated (its job is replaced by per-send linkage); legacy rows kept untouched.

6. **Cosmetic intake consolidation.** In the care team UI, `UnsharedAmount` and `PreventiveCare` are grouped under a single "Share Request Intake" section. The actual templates remain separate; real consolidation via screener-driven branching is editor-redesign work in the next spec.

7. **Vendor agent access (Phase 0).** Backend `routes/me/vendor/public-forms.js` adds `VendorAgent` to read-only endpoints. Edit/publish/delete/send remain VendorAdmin + SysAdmin only. Frontend hides edit controls when `userType === 'VendorAgent'`.

8. **Architecture style.** Approach A — extend existing `oe.PublicFormTemplates` and `oe.PublicFormSubmissions`, plus one new `oe.PublicFormInvitations` table for the targeted/authenticated send flow. No "deliveries" entity; the invitations table is the right shape for the actual new behavior.

---

## Section 1 — Data model & schema changes

### `oe.PublicFormTemplates` (additions)

| Column | Type | Default | Purpose |
|---|---|---|---|
| `AllowAnonymous` | BIT NOT NULL | 1 | Delivery mode allowed: anonymous public link |
| `AllowTargeted` | BIT NOT NULL | 0 | Delivery mode allowed: care-team-issued signed link |
| `AllowAuthenticated` | BIT NOT NULL | 0 | Delivery mode allowed: member-portal-authenticated |
| `CreatesShareRequestOnSubmit` | BIT NOT NULL | 0 | When 1 and member-known, auto-create a ShareRequest |

Constraints:
- `CK_PublicFormTemplates_AtLeastOneMode` — at least one of the three `Allow*` flags must be 1.
- Backfill on migration: `UnsharedAmount` + `PreventiveCare` templates get `CreatesShareRequestOnSubmit = 1` and `AllowAnonymous = 1` (current behavior).

### `oe.PublicFormSubmissions` (additions)

| Column | Type | Notes |
|---|---|---|
| `CaseId` | UNIQUEIDENTIFIER NULL | Reserved for Case linkage. FK added when `oe.Cases` ships. |
| `AuthMode` | NVARCHAR(20) NULL | One of `anonymous`, `targeted`, `authenticated`. Set on submit; used for audit. |
| `InvitationId` | UNIQUEIDENTIFIER NULL FK | FK to `oe.PublicFormInvitations.InvitationId` when submission originated from an invitation. |
| `PayloadEmail` | NVARCHAR(254) NULL | Plaintext copy of the submitted email, for cheap diff display against `oe.Users.Email`. See Section 5. |
| `PayloadPhone` | NVARCHAR(50) NULL | Plaintext copy of the submitted phone, for cheap diff display against `oe.Users.PhoneNumber`. See Section 5. |

### `oe.PublicFormInvitations` (new table)

| Column | Type | Notes |
|---|---|---|
| `InvitationId` | UNIQUEIDENTIFIER PK | `crypto.randomUUID()` |
| `TenantId` | UNIQUEIDENTIFIER NOT NULL FK | Tenant isolation |
| `FormTemplateId` | UNIQUEIDENTIFIER NOT NULL FK | Which template |
| `MemberId` | UNIQUEIDENTIFIER NOT NULL FK | Targeted member |
| `Mode` | NVARCHAR(20) NOT NULL | `targeted` (no-login) or `authenticated` (login required) |
| `LinkedShareRequestId` | UNIQUEIDENTIFIER NULL FK | Optional SR linkage at send time |
| `LinkedCaseId` | UNIQUEIDENTIFIER NULL | Optional Case linkage. FK added with `oe.Cases`. |
| `TokenHash` | CHAR(64) NOT NULL | SHA-256 of 32-byte random hex; matches `PublicFormSubmissions.PublicAccessTokenHash` pattern |
| `ExpiresAt` | DATETIME2 NOT NULL | `SYSUTCDATETIME() + 7 DAYS` default. Configurable later. |
| `FirstUsedAt` | DATETIME2 NULL | Audit only — when was it first submitted against. Multi-use within expiry. |
| `DeliveryMethod` | NVARCHAR(20) NOT NULL | `email` \| `copy` \| `both` — see Section 2 |
| `RevokedAt` | DATETIME2 NULL | Manual revoke |
| `SentByUserId` | UNIQUEIDENTIFIER NOT NULL FK | Care team user who issued |
| `SentToEmail` | NVARCHAR(254) NOT NULL | Address the link was emailed to |
| `CreatedDate` | DATETIME2 NOT NULL | `SYSUTCDATETIME()` |

Indexes:
- `UQ_PublicFormInvitations_TokenHash` on `(TokenHash)` UNIQUE
- `IX_PublicFormInvitations_TenantMember` on `(TenantId, MemberId)`
- `IX_PublicFormInvitations_LinkedSR` on `(LinkedShareRequestId)` WHERE `LinkedShareRequestId IS NOT NULL`

### Rationale

- **Invitations table vs. signed JWT in URL**: matches the existing token-hash pattern in `PublicFormSubmissions.PublicAccessTokenHash`. Allows revocation, audit, expiry enforcement, and arbitrary mid-life state changes (revoke, re-link) that a signed payload cannot.
- **`Mode` on invitations**: distinguishes "no-login signed link" from "login-required + prefilled" recipient experiences. Same table, different recipient flow.
- **`AuthMode` on submissions**: forensic. After a year, a viewer can tell how a submission was made without joining to invitations.
- **`LinkedShareRequestId` mirrored on both invitation and submission**: invitation captures intent at send-time; submission captures final reality (admin can retroactively change SR linkage on the submission). They can diverge legitimately.

### Migration concerns

- Production may contain custom-kind form templates whose submissions have been silently spawning Medical ShareRequests. Before deploy: audit `oe.PublicFormTemplates` for slugs not in `('UnsharedAmount', 'PreventiveCare', 'AdditionalDocuments')`, check linked `oe.ShareRequests` rows, decide with stakeholders whether those SRs are legitimate or junk.
- Backfill `CreatesShareRequestOnSubmit = 1` only for `UnsharedAmount` and `PreventiveCare` rows. All other rows (including legacy custom-kind) default to 0 — silent SR creation stops on deploy.
- Existing `AdditionalDocuments` rows are left in place but no longer surfaced in the care team UI. New custom templates supersede them.

---

## Section 2 — Delivery mode policy & care-team UI

### Form editor — Delivery settings panel

The template editor gets a new collapsed-by-default "Delivery settings" panel with four toggles backing the new template columns:

| Toggle label | Column | Help text |
|---|---|---|
| Anonymous public link | `AllowAnonymous` | Anyone with the link can fill this form. Use for non-sensitive intake. |
| Send to a specific member (no login) | `AllowTargeted` | Care team can send this form to a specific member by email. The recipient does not need to log in. Best for short forms (e.g., ACH info, single document upload) where the care team has already established who the recipient is — no PHI is displayed before the recipient fills the form. |
| Authenticated member submission | `AllowAuthenticated` | Recipient must log into their member account. The form is prefilled from their profile. Use for forms containing PHI or that require a verified identity. |
| Auto-create ShareRequest on member-matched submit | `CreatesShareRequestOnSubmit` | Each known-member submission spawns a new ShareRequest. Only enable for SR intake forms. Default off; pre-set for `UnsharedAmount` and `PreventiveCare` templates. |

Frontend enforces: at least one of the three `Allow*` toggles must be on; clear inline error if all are off.

### Care team — Send-to-member flow

Each row on the forms list shows two action buttons (visibility depends on form flags):

- **"Get share link"** — visible when `AllowAnonymous = 1`. Copies an anonymous URL to clipboard. (Existing behavior.)
- **"Send to member"** — visible when `AllowTargeted = 1` OR `AllowAuthenticated = 1`. Opens the send modal described below.

Permission: both buttons visible to `VendorAdmin`, `VendorAgent`, `TenantAdmin`, `SysAdmin`.

#### Send-to-member modal — four ordered steps

1. **Pick member.** Search by name / member ID / email; rows show name + member ID + tenant. Selection required.
2. **Pick delivery mode** (skip if only one of `AllowTargeted` / `AllowAuthenticated` is enabled on the template):
   - "Send without requiring login (recipient does not sign in)" — only if `AllowTargeted = 1`
   - "Require login before filling (recipient logs into their account)" — only if `AllowAuthenticated = 1`
   - Default: stricter mode (authenticated) when both available.
3. **Optional linkage.** Once a member is selected, two side-by-side columns auto-populate:
   - **Open Share Requests** — `oe.ShareRequests` rows for the member where `Status NOT IN ('Closed', 'Denied', 'Cancelled')`. Click to select / deselect.
   - **Open Cases** — placeholder column (`Cases feature not yet available`), wired to data plumbing but disabled until `oe.Cases` ships.
   - Care team picks at most one linkage, OR none. Submission still attaches to the member's Documents tab either way.
4. **Recipient email + delivery method + confirm.**
   - Email defaults to the member's profile email; care team can override.
   - Three buttons:
     - **"Email link to recipient"** — system sends via `publicFormNotifyService`.
     - **"Copy link only"** — invitation created, NO email sent, URL copied to clipboard.
     - (Future) **"Both"** — email AND copy. Out of scope this phase.
   - Summary panel shows: form name + member name + mode + linkage + email + delivery method.

#### Recipient affordance at the top of a targeted-mode form

Targeted-mode forms render a non-editable greeting block at the top:

> **This form is for you, {firstName} ({sentToEmail}).**

Where `firstName` is pulled from the member record (first name only — last name, DOB, member ID, address, etc. NOT shown), and `sentToEmail` is the recipient address from the invitation. This gives the recipient two visual confirmations the form is meant for them while staying within typical industry norms (DocuSign/Mailchimp pattern) for non-PHI greeting display.

The form fields themselves ask only what the form needs. The member-binding happens server-side via the invitation token; the binding details are not displayed.

### Invitations are multi-use within expiry

Each successful submit against an invitation creates a NEW row in `PublicFormSubmissions`, all linked to the same `InvitationId`. The invitation stays valid until `ExpiresAt` or until the care team revokes it (`RevokedAt`).

Audit column `FirstUsedAt` (renamed from `UsedAt` in Section 1's table) records when the first submission against this invitation arrived. No single-use lock.

#### Multi-submission UX in the care team

When a member has multiple submissions tied to the same invitation, the care team UI must make this obvious:

- **On the member's Documents tab**: submissions are grouped by `InvitationId` when more than one exists for the same invitation. The group is visually represented as a stack (e.g., a single row labeled "ACH info form — 3 submissions" that expands to show all). The newest submission is highlighted at the top of the stack with a clear "Latest" chip.
- **Sort default**: newest submission first within each invitation group.
- **Direct submission rows** (no invitation, e.g., anonymous resolved-to-member submissions) appear flat alongside grouped rows.
- **SR detail Forms section** mirrors the same grouping when a linked invitation has multiple submissions.

This prevents the care team from acting on a stale submission when a newer one supersedes it.

### Vendor agent send access (correction)

Vendor agents are NOT read-only. The permission matrix:

| Action | VendorAdmin | VendorAgent | TenantAdmin | SysAdmin |
|---|---|---|---|---|
| List / view templates | ✅ | ✅ | ✅ | ✅ |
| List / view submissions | ✅ | ✅ | ✅ | ✅ |
| Send form to member (issue invitation) | ✅ | ✅ | ✅ | ✅ |
| Resolve / set member on submission | ✅ | ✅ | ✅ | ✅ |
| Revoke own-issued invitation | ✅ | ✅ | ✅ | ✅ |
| Create / edit / publish / delete template | ✅ | ❌ | ✅ | ✅ |

This expands the Phase 0 vendor-agent fix scope — see Section 8.

### Backend endpoints (added in this phase)

- `POST /api/me/{vendor|tenant-admin}/public-forms/:templateId/invitations` — create invitation. Body: `{ memberId, mode, linkedShareRequestId?, linkedCaseId?, recipientEmail, deliveryMethod }`. Returns: `{ invitationId, url, expiresAt }`. When `deliveryMethod === 'email'` (or `both`), triggers send via `publicFormNotifyService`. When `copy`, no email.
- `GET /api/me/{vendor|tenant-admin}/public-forms/invitations/:invitationId` — read for audit / re-copy URL.
- `DELETE /api/me/{vendor|tenant-admin}/public-forms/invitations/:invitationId` — revoke. Sets `RevokedAt`. Returns 204.
- `GET /api/me/{vendor|tenant-admin}/public-forms/:templateId/invitations` — list for a template.

### Schema addition retroactive to Section 1

Add to `oe.PublicFormInvitations`:

| Column | Type | Notes |
|---|---|---|
| `DeliveryMethod` | NVARCHAR(20) NOT NULL | `email` \| `copy` \| `both`. Records how the care team chose to deliver the link. |

Rename `UsedAt` → `FirstUsedAt`. (Multi-use semantics.)

## Section 3 — Targeted-link flow (no-login)

### Token mechanics

- Token generated at invitation creation: `crypto.randomBytes(32).toString('hex')` → 64-char hex string. Matches existing pattern in `backend/services/onboardingLinkService.js`.
- Token included in recipient URL: `https://allaboard365.com/forms/i/{token}`. The `/i/` segment distinguishes invitation URLs from anonymous `/forms/:formId` URLs.
- Stored as `SHA256(token)` in `oe.PublicFormInvitations.TokenHash`. Plain token never persisted.
- Creation response returns the full URL once for clipboard copy; if lost, care team must revoke + re-issue.

### Recipient flow

1. **Open URL** → frontend route `/forms/i/:token` mounts `TargetedFormPage`.
2. **Page load** → `GET /api/public/forms/invitations/:token`:
   - Backend hashes token, looks up by `TokenHash`.
   - Validation gate: `Mode = 'targeted'` AND `RevokedAt IS NULL` AND `ExpiresAt > NOW()`.
   - Success response: `formTitle`, `formDefinition` (published version), `firstName`, `sentToEmail`. Nothing else.
   - Failure: `410 Gone` with generic "This link is no longer valid" — no oracle on why.
3. **Render form** with greeting block at top: "This form is for you, {firstName} ({sentToEmail})." Recipient sees no other identifiers, no linked SR/Case, no MemberId.
4. **Submit form** → `POST /api/public/forms/invitations/:token/submit`:
   - Re-validate gate.
   - Encrypt payload via existing `publicFormCrypto` flow.
   - Insert `PublicFormSubmissions` row with `MemberId`, `InvitationId`, `AuthMode = 'targeted'`, `ShareRequestId` / `CaseId` from invitation, `MemberMatchStatus = 'Matched'`, fresh recipient-facing `PublicAccessTokenHash` for re-view.
   - If `template.CreatesShareRequestOnSubmit = 1`: fire `linkSubmissionToShareWorkflow` (legacy path).
   - Stamp invitation's `FirstUsedAt` if NULL. Multi-use within expiry.
   - Return confirmation.

### Security boundaries — what the targeted token can and can't do

| Capability | Targeted token grants? |
|---|---|
| Open the linked form | ✅ |
| See first name + recipient email (greeting only) | ✅ |
| See MemberId, last name, DOB, member card number, household, address | ❌ |
| See linked SR / Case identifiers or details | ❌ |
| Submit form (multiple times until expiry) | ✅ |
| View other forms / submissions / members | ❌ |
| Modify or delete prior submissions | ❌ |
| View own previously submitted data | ❌ |

### Expiry, revocation, abuse

- Expiry: 7 days from `CreatedDate` (hard-coded for this phase).
- Revocation: `DELETE /api/me/.../invitations/:invitationId` sets `RevokedAt`. Open attempts get `410 Gone`.
- Rate limiting: same per-IP throttle as existing `/api/public/forms/*` endpoints.
- Token guess resistance: 256-bit random → infeasible to brute force. Failed lookups respond identically to expired/revoked → no information disclosure.

### Recipient error states

| Scenario | Response |
|---|---|
| Invalid / expired / revoked token | `410 Gone` — "This link is no longer valid. Contact your care team to request a new one." |
| Template unpublished after invitation issued | `409 Conflict` — "This form is currently unavailable. Contact your care team." |
| Member account deleted / deactivated | `410 Gone` (same generic message) |
| File upload validation fails | Inline form error, retry allowed |

## Section 4 — Authenticated submission flow

> **⚠️ Re-review required before implementation.** This section was drafted with a partial understanding of the current member-portal auth/session state. Before starting the implementation of Section 4, re-audit: (a) how member login + password-set flows work today, (b) whether `req.user.MemberId` is reliably populated after auth, (c) what data is available in the JWT vs. requires a DB join, (d) whether there's an existing "fill this form" mailbox concept in the member portal that should be reused. Revise this section accordingly.

### Pre-login landing — zero data exposure

Recipient clicks email link → frontend route `/forms/i/:token` mounts `InvitationRouter`. It calls a lightweight public endpoint:

- `GET /api/public/forms/invitations/:token/meta` — returns ONLY `{ mode, formTitle, expiresAt, exists }`. Never returns recipient name / email / member info for authenticated-mode invitations.

Behavior based on `mode`:
- `targeted` → render `TargetedFormPage` (Section 3).
- `authenticated` → check session:
  - Not logged in → redirect to `/login?returnTo=/forms/i/{token}`. Login page shows "Log in to fill in: {formTitle}." Entire pre-login disclosure.
  - Logged in as non-Member → "This link is for a member account. Please log out and log in with the member account."
  - Logged in as Member → proceed to load.

### Post-login form load

`GET /api/me/member/forms/invitations/:token`:

1. Hash token, look up invitation. Validate gate.
2. Compare `req.user.MemberId === invitation.MemberId`. Mismatch → `403 Forbidden` "This form is not associated with your account."
3. Build prefill payload (see scope below).
4. Return `{ formTitle, formDefinition, prefill }`.

### Prefill scope — well-known field names

Form fields with well-known names autofill from the authenticated member's profile:

| Form field name | Sourced from |
|---|---|
| `firstName` | `oe.Users.FirstName` (via `oe.Members.UserId`) |
| `lastName` | `oe.Users.LastName` |
| `email` | `oe.Users.Email` |
| `phone` | `oe.Users.PhoneNumber` |
| `memberId` | `oe.Members.HouseholdMemberID` |
| `dateOfBirth` | `oe.Members.DateOfBirth` |
| `relationToPrimary` | derived from `oe.Members.HouseholdId` + primary-member flag |
| `addressLine1` / `addressLine2` / `addressCity` / `addressState` / `addressZip` | member address record |

Custom-named fields don't autofill. Editor will surface a "Member profile autofill available" badge for recognized names in the next-spec editor redesign; this spec relies on server-side mapping only.

### Submission flow

`POST /api/me/member/forms/invitations/:token/submit`:

1. Re-validate gate + member match.
2. Server-side prefill is authoritative — recipient cannot override prefilled values via tampered POST; server wins.
3. Encrypt payload via existing flow.
4. Insert `PublicFormSubmissions` row with `MemberId`, `InvitationId`, `AuthMode = 'authenticated'`, `ShareRequestId` / `CaseId` from invitation, `MemberMatchStatus = 'Matched'`.
5. Stamp `FirstUsedAt` if NULL.
6. `linkSubmissionToShareWorkflow` only if `template.CreatesShareRequestOnSubmit = 1`.
7. Return confirmation.

### Security boundaries — authenticated mode

| Capability | Authenticated token grants? |
|---|---|
| Open the form pre-login | ❌ (only sees "Log in to fill in: {formTitle}") |
| See member identity pre-login | ❌ |
| See full profile prefill post-login | ✅ (it's their own account) |
| Submit form (multiple times until expiry) | ✅ |
| View other forms / submissions via the token | ❌ |
| Modify / delete prior submissions | ❌ |

### Mismatch and edge cases

| Scenario | Response |
|---|---|
| Logged-in user is not the invitation's target member | `403 Forbidden` — "This form is not associated with your account." |
| Member has User account but never set password | Existing login flow's password-set / forgot-password path. Out of scope. |
| Member account deleted / deactivated | `410 Gone` at the meta endpoint |
| Template unpublished after invitation issued | `409 Conflict` post-login |
| Session expires mid-fill | Standard auth-refresh; if refresh fails, prompt re-login + retry |

### Member portal-side work in scope

- New frontend route `/forms/i/:token` with `InvitationRouter` guard.
- New page `AuthenticatedFormPage` (renders inside `MemberLayout`).
- New backend routes under `/api/me/member/forms/invitations/*`.
- New service `publicFormInvitationPrefillService.js` — builds prefill from member profile.

### Member portal-side work OUT of scope

- Password setup / first-time-login refinements.
- A member-portal "forms mailbox" view (a list of all forms the member has been asked to fill). Useful, but later.
- Notification-preference UI for invitation emails — uses tenant defaults.

## Section 5 — Submission destination & findability

### Anonymous (member not yet resolved) — reuse existing submissions page

No new page. The existing `TenantSharingSubmissionsPage.tsx` + vendor mirror remain the home for un-resolved anonymous submissions. Today's member-ID matching stays. Two enhancements in this spec:

- Filter additions: `source` (anonymous / targeted / authenticated / all), in addition to existing `memberMatchStatus`.
- The auto-resolver moves from "admin button" to "server-side at submit" (see below).

### Member workspace — extend existing Documents tab

The existing `MemberDocumentsTab` becomes the universal home for member-related artifacts: SR documents, Case documents (when Cases ships), and form submissions. Structure:

- **One folder per linked ShareRequest** — folder name = SR title or request number. Folder contents = SR-attached files + form submissions linked to that SR.
- **One folder per linked Case** — schema-ready; no folders rendered until `oe.Cases` ships.
- **"Other submissions" folder** — catch-all for any member-known form submission with NO SR and NO Case linkage. Single folder.

Multi-submission grouping under one invitation applies within a folder: multiple submissions tied to the same invitation collapse into a stack with a "Latest" chip on the newest.

### SR workspace — rename Documents tab to "Documents and Forms"

The existing `DocumentsTab` on `ShareRequestWorkspaceTabs.tsx` is renamed in the UI to **"Documents and Forms"**. Contents:
- Top section: existing SR-attached document files (unchanged behavior).
- New section: "Forms linked to this Share Request" — lists form submissions where `ShareRequestId = :srId`, with the same multi-submission grouping pattern.

### Case workspace — schema-ready, UI deferred

When Cases ships, the same rename + add-section pattern applies. This spec leaves it at schema-only.

### Auto-resolver runs on submit, not only on admin click

Today's `resolveMemberForTenant` only fires when an admin clicks "resolve member." New behavior:

- **Targeted-mode submissions** — member known from invitation. Skip resolver entirely; `MemberMatchStatus = 'Matched'` set on insert.
- **Authenticated-mode submissions** — member known from session. Skip resolver; `MemberMatchStatus = 'Matched'`.
- **Anonymous submissions** — auto-run resolver server-side immediately after insert. If matched: set `MemberId` + `MemberMatchStatus = 'Matched'`, drop submission into member's "Other submissions" folder. If unresolved/ambiguous: leave anonymous, admin can still resolve manually.

This means the moment an anonymous form submission with a valid member ID payload arrives, it lands on the member's Documents tab AND (if `template.CreatesShareRequestOnSubmit = 1`) spawns an SR pre-linked to that member.

### Membership data discrepancy display

When a form-submitted name / email / phone differs from the resolved member's profile, the SR membership column (and any membership chip elsewhere) shows both values:

> Sarah Johnson **(Sarah Jonson)** · sarah@example.com **(sara@example.com)** · (555) 123-4567

Account value first, form-submitted value in parentheses only when it differs. No parens when they match.

To support cheap diff display without decrypting the encrypted payload, add plaintext columns on `oe.PublicFormSubmissions` (mirroring existing `PayloadFirstName` / `PayloadLastName`):

- `PayloadEmail NVARCHAR(254) NULL`
- `PayloadPhone NVARCHAR(50) NULL`

Populated at submission write-time. Display-time diff against the current `oe.Users.Email` / `oe.Users.PhoneNumber` / `oe.Users.FirstName` / `oe.Users.LastName`. Full payload remains encrypted; these duplicates exist only for identity-field diffing.

### Backend endpoint changes

- `GET /api/me/{vendor|tenant-admin}/members/:memberId/documents` (existing) — extend response to include grouped form submissions (`{ folders: [{ id, name, kind: 'share-request'|'case'|'other', documents: [...], formSubmissions: [...] }] }`).
- `GET /api/me/{vendor|tenant-admin}/share-requests/:srId/documents` (existing) — extend response to include `formSubmissions` array.
- `POST /api/public/forms/:formTemplateId/submit` (existing) — auto-resolver fires inline after insert.
- `GET /api/me/{vendor|tenant-admin}/public-forms/submissions` (existing) — add `source` query param.

### Member's own portal Documents page — out of scope

`frontend/src/pages/member/Documents.tsx` (the member-facing view) is untouched in this spec. A future enhancement extends it for member-facing forms.

## Section 6 — Per-send linkage UI

### Linkage picker (Send modal, Step 3)

Two side-by-side columns once a member is selected.

**Left: Open Share Requests for this member.** Lists `oe.ShareRequests` where `MemberId = :memberId` AND `Status NOT IN ('Closed', 'Denied', 'Cancelled')`. Each row: `RequestNumber` · short title · `RequestType` · `Status` · `CreatedDate`. Click to select / deselect; single selection.

**Right: Open Cases for this member.** Disabled visual treatment with helper text *"Cases feature not yet available. This column will activate when Cases ship."* Column rendered to communicate future capability and reserve UI space.

Care team picks AT MOST ONE linkage across both columns. "None" is a valid choice (submission lands in member's Documents tab "Other submissions" folder).

### Backend endpoints (for the picker)

- `GET /api/me/{vendor|tenant-admin}/members/:memberId/open-share-requests` — returns `[{ shareRequestId, requestNumber, title, requestType, status, createdDate }]`. Filter excludes closed/denied/cancelled. Tenant-scoped, role-gated.
- Future: `GET /api/me/{vendor|tenant-admin}/members/:memberId/open-cases` — analogous, when `oe.Cases` ships.

### Retroactive linkage on the submissions page

A submission that arrived anonymously and got resolved to a member CAN be retroactively linked to an SR or Case. Surfaces in two places:

1. **Submission detail page** — new "Linkage" panel renders when `MemberId` is known on the submission:
   - If currently linked: shows the linked SR / Case with a "Change" button.
   - If not linked: shows "Not linked. Link to…" with the same two-column picker.
   - Changing linkage updates `oe.PublicFormSubmissions.ShareRequestId` (or `CaseId`). "None" clears the linkage.

2. **Member resolution flow** — after the existing "Resolve member" picks a member, the linkage picker renders as an optional step before saving. Defaults to "None." Resolution and linkage commit atomically.

### Backend endpoint (retroactive linkage)

- `PATCH /api/me/{vendor|tenant-admin}/public-forms/submissions/:submissionId/linkage` — body: `{ shareRequestId?, caseId? }` (mutually exclusive; both null to clear). Updates the submission row. Returns 204.

### Submissions page filter additions (in scope)

The existing `TenantSharingSubmissionsPage` + vendor mirror gain two filters (no larger UX redesign here):

- **Resolution status** — `unresolved` / `resolved-not-linked` / `resolved-linked` / `all`. Helps the care team focus on the queue.
- **Source** — `anonymous` / `targeted` / `authenticated` / `all` (per Section 5).

A broader UX redesign of this page (queue prioritization, faster resolution) is acknowledged but deferred to a follow-up spec.

### Soft warning when a form may be unresolvable

During form template create/edit: if `AllowAnonymous = 1` AND the field set contains no well-known identity fields (`memberId`, `email`, `firstName` + `lastName`, `dateOfBirth`), show a non-blocking warning banner:

> *This form allows anonymous submissions but doesn't ask for any identifying information. Submissions to this form may not be resolvable to a member. Consider adding a Member ID field, or limit this form to "Send to member" / "Authenticated" delivery only.*

Soft warning — admin can save anyway (legitimate use cases exist, e.g., a shareable feedback form). No hard lock.

### Audit trail — invitation vs. submission linkage

- Invitation's `LinkedShareRequestId` = intent at send-time.
- Submission's `ShareRequestId` = final reality (admin may change retroactively).
- They start equal; can diverge through admin action.
- No audit row for linkage changes in this phase — the divergence between invitation and submission is sufficient audit. A full per-change audit log can come later if needed.

### When a linked SR closes

The submission's `ShareRequestId` stays. The SR detail page still shows the submission. The member's Documents tab still shows the SR folder (with a "Closed" badge — optional UI polish). Care team can re-link to a different open SR via the "Change" button.

## Section 7 — Migration & rollout

### SQL migration

Single file: `sql-changes/allaboard365/2026-05-13-forms-redesign.sql`. Idempotent (`IF NOT EXISTS` guards on columns/tables/indexes).

Contents:

1. `ALTER TABLE oe.PublicFormTemplates ADD AllowAnonymous BIT NOT NULL DEFAULT 1, AllowTargeted BIT NOT NULL DEFAULT 0, AllowAuthenticated BIT NOT NULL DEFAULT 0, CreatesShareRequestOnSubmit BIT NOT NULL DEFAULT 0`
2. `ALTER TABLE oe.PublicFormTemplates ADD CONSTRAINT CK_PublicFormTemplates_AtLeastOneMode CHECK (AllowAnonymous = 1 OR AllowTargeted = 1 OR AllowAuthenticated = 1)`
3. `ALTER TABLE oe.PublicFormSubmissions ADD CaseId UNIQUEIDENTIFIER NULL, AuthMode NVARCHAR(20) NULL, InvitationId UNIQUEIDENTIFIER NULL, PayloadEmail NVARCHAR(254) NULL, PayloadPhone NVARCHAR(50) NULL`
4. `CREATE TABLE oe.PublicFormInvitations (...)` with all columns per Section 1 + `DeliveryMethod` per Section 2.
5. Indexes: `UQ_PublicFormInvitations_TokenHash`, `IX_PublicFormInvitations_TenantMember`, `IX_PublicFormInvitations_LinkedSR`.
6. FK: `oe.PublicFormSubmissions.InvitationId` → `oe.PublicFormInvitations.InvitationId`.
7. Backfill: `UPDATE oe.PublicFormTemplates SET CreatesShareRequestOnSubmit = 1 WHERE FormKind IN ('UnsharedAmount', 'PreventiveCare')`.

Per `project_shared_dev_database` memory: write the SQL, do NOT execute it yourself. DBA / lead applies it to `allaboard-testing` and prod.

### Pre-deploy audit

Run against production read replica:

```sql
SELECT TenantId, FormKind, Title, IsPublished, COUNT(s.SubmissionId) AS SubCount,
       COUNT(s.ShareRequestId) AS LinkedSRCount
FROM oe.PublicFormTemplates t
LEFT JOIN oe.PublicFormSubmissions s ON s.FormTemplateId = t.FormTemplateId
WHERE t.FormKind NOT IN ('UnsharedAmount', 'PreventiveCare', 'AdditionalDocuments')
GROUP BY t.TenantId, t.FormKind, t.Title, t.IsPublished;
```

For any rows returned with `LinkedSRCount > 0`: stakeholder review. Those SRs were silently auto-created from custom-kind forms and may or may not be legitimate. After this redesign deploys, that silent creation stops; the SRs themselves stay until manually addressed.

### Deprecation path for `AdditionalDocuments` template

- Existing `AdditionalDocuments` template rows remain in `PublicFormTemplates`. They keep working until manually retired.
- Care team UI hides the template from the "create new form" list — only existing instances remain visible for historical lookup.
- The bespoke "verify last name + DOB + SR number" flow at `publicFormShareLinkService.js:24-44` stays in code for legacy support but no new flows are wired into it.
- A follow-up spec retires the legacy template entirely once all tenants have migrated to per-send linkage.

### Deploy order

1. Apply SQL migration to `allaboard-testing` (manual, DBA).
2. Deploy backend with new endpoints + auto-resolver wired into submit path. Existing endpoints unchanged in behavior for old clients (the new columns are nullable; old code ignores them).
3. Deploy frontend with new editor toggles, send modal, Documents tab folder structure, SR "Documents and Forms" rename.
4. Smoke test in `allaboard-testing` against the test accounts (`reference_test_accounts` memory).
5. Apply SQL to prod, then deploy backend + frontend to prod in same window.

### Feature flag

Not used in this spec. The new template columns default such that existing templates behave exactly as today (`AllowAnonymous = 1`, others off, `CreatesShareRequestOnSubmit` flipped on for the two intake kinds only). New behavior is opt-in by editing a template's toggles.

---

## Section 8 — Vendor agent access fix (Phase 0)

Ships as a **standalone small PR before the main spec lands**. Scope is intentionally narrow.

### Backend (`backend/routes/me/vendor/public-forms.js`)

Update the `authorize([...])` middleware call at the top of the route file so the following endpoints permit `VendorAgent` in addition to `VendorAdmin` and `SysAdmin`:

- `GET /templates` — list
- `GET /templates/:id` — read single template
- `GET /submissions` — list submissions
- `GET /submissions/:id` — read submission detail
- `GET /submissions/:id/submission-pdf*` — PDF download
- `POST /submissions/:id/resolve-member` — auto-match
- `POST /submissions/:id/set-member` — manual member set
- `POST /submissions/:id/retry-link` — retry link to SR workflow
- `POST /submissions/:id/queue-routing-notifications` — resend notification
- `POST /submissions/:id/send-summary-email` — send summary email

These remain VendorAdmin / SysAdmin only:

- `POST /templates` (create)
- `PATCH /templates/:id` (edit)
- `POST /templates/:id/versions` (new version)
- `POST /templates/:id/publish` (publish)
- `DELETE /templates/:id` (delete)

Invitation endpoints (`POST /templates/:id/invitations`, `DELETE /invitations/:id`, `GET /invitations`) are added in the main spec — they're authorized for VendorAgent from the start.

### Frontend

- `TenantSharingFormsPage` (reused for vendor at `/vendor/sharing-forms`) — when `userType === 'VendorAgent'`:
  - Hide "Create form" button
  - On template detail page: hide edit / publish / delete buttons; render read-only view of fields
  - Submissions: keep all current actions visible (resolve-member, set-member, send summary, etc.)

### Test plan

- VendorAgent test account (`test@sharewellpartners.com` per memory) logs in → goes to `/vendor/sharing-forms`
  - Sees template list (no Create button)
  - Clicks a template → sees read-only definition (no Edit / Publish / Delete)
  - Goes to Submissions sub-page → sees the list, can open detail, can resolve / set member, can send summary email
- VendorAdmin test account: full UI behavior unchanged
- Backend: Jest test against the route file confirming each endpoint's `authorize` list matches the matrix above

---

## Section 9 — Testing strategy

### Backend Jest

New test files / test cases:

- `backend/services/__tests__/publicFormInvitationService.test.js` — create / look up / redeem / revoke / expire invitations. Token hashing roundtrip. Single-use → multi-use behavior.
- `backend/services/__tests__/publicFormMemberResolver.auto.test.js` — auto-resolver runs on submit. Targeted + authenticated skip the resolver. Anonymous with matching payload member ID resolves. Ambiguous / unmatched paths preserved.
- `backend/services/__tests__/publicFormInvitationPrefillService.test.js` — well-known field name mapping to member profile. Custom names skipped. PHI never returned for invalid token / wrong member.
- `backend/routes/__tests__/vendor.public-forms.invitations.test.js` — POST / GET / DELETE invitation endpoints. Authorization matrix. Vendor isolation.
- `backend/routes/__tests__/public.forms.invitations.test.js` — `GET /api/public/forms/invitations/:token/meta` (anonymous), `GET /api/public/forms/invitations/:token` for targeted, `POST .../submit` for targeted. Authentication required for `/api/me/member/forms/invitations/:token` path.
- `backend/routes/__tests__/share-requests.documents-and-forms.test.js` — SR documents endpoint extended response shape.
- `backend/routes/__tests__/members.documents.folders.test.js` — member documents endpoint returns folder structure with SR / Other folders.

All tests use the existing test fixtures + mocked Azure SQL / Blob conventions (see `docs/enrollments/testing.md` for the pattern).

### Vitest (frontend unit)

- Send-to-member modal four-step state machine.
- Linkage picker selection / deselection logic.
- Multi-submission grouping in the Documents tab.
- Discrepancy display utility (returns parens text only when values differ).

### Cypress E2E

Specs (under `frontend/cypress/e2e/forms-redesign/`):

- `01-vendor-agent-access.cy.ts` — Phase 0 read-only access via test account.
- `02-anonymous-submit-auto-resolve.cy.ts` — anonymous submit with member ID payload → auto-resolves → lands on member Documents tab in correct folder.
- `03-targeted-send-and-fill.cy.ts` — care team sends targeted form, follows the URL, fills, submission attaches to member.
- `04-targeted-link-revoke.cy.ts` — revoked link returns 410.
- `05-targeted-multi-submission.cy.ts` — two submissions against same invitation group as a stack with "Latest" chip.
- `06-authenticated-pre-login.cy.ts` — landing pre-login shows only form title + Log in CTA.
- `07-authenticated-fill-prefilled.cy.ts` — member logs in, profile fields prefilled, submission lands tied to member.
- `08-authenticated-mismatch.cy.ts` — wrong member logged in → 403.
- `09-send-modal-linkage-picker.cy.ts` — pick member, see open SRs, select one, send.
- `10-retroactive-linkage.cy.ts` — admin resolves anonymous submission, links to existing SR.
- `11-discrepancy-parens-display.cy.ts` — form-submitted name differs from member → parens shown on SR page.
- `12-soft-warning-no-identity.cy.ts` — admin creates anonymous form with no identity fields → warning banner.

Per the memory `feedback_no_real_message_sends`: all Cypress specs stub email-send via `cy.intercept`. Never hit live SendGrid / Twilio / Graph in tests.

### Per-feature test procedures

Each row in `features/_inventory.md` carries a human-runnable test procedure in its detail file. After implementation, a developer runs the procedure and updates the status to ✔️. The inventory is the final checklist before PR review.

## Out of scope (future work)

- **Form editor redesign**, including screener-driven branching ("two-button pre-form questions that determine which field set is presented," modeled on TurboTax/FreeTaxUSA flow). Consolidation of `UnsharedAmount` + `PreventiveCare` into one share-request intake form depends on this editor work.
- **Cases feature itself** — this spec adds nullable `CaseId` columns and parallel optional linkage paths but does not build the Case entity or its UI.
- **Configurable invitation expiry** — 7-day default is hard-coded in this spec; tenant-level override comes later.
- **Multi-use invitations** — invitations are single-use in this spec; reuse cases (e.g., recurring monthly forms) come later.
