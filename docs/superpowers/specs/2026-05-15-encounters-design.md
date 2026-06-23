# Back-Office Encounters — Design Spec

**Date:** 2026-05-15
**Branch:** `feature/backoffice-encounters`
**Status:** Draft, pending user review

## Goal

Give the care team a first-class, searchable record of every conversation they
have with a member — phone calls, emails, in-person, anything. Today these are
created manually from a "New Encounter" modal in the vendor portal. Tomorrow,
when the team's Zoom phone line is wired into the platform, the same data shape
will receive auto-generated encounters (with transcripts) without a schema
redesign.

Encounters are a third trackable object alongside **Cases** (`oe.Cases`,
landed 2026-05-14) and **Share Requests** (`oe.ShareRequests`). They follow the
same vendor-scoped, member-rooted patterns those use, deliberately so that the
care team's mental model stays consistent across the three.

## Non-goals (v1)

- **Not** building the Zoom integration itself (no webhook, no OAuth, no
  transcription pipeline). The schema is shaped to receive Zoom-sourced
  encounters; only the manual path is implemented.
- **No** @-mentions or in-app notifications on assign / follow-up. Defer until
  the team asks for it.
- **No** tags or categories. Filterable enums (channel, direction) cover the
  obvious cuts; structured taxonomy is overkill for v1.
- **No** threading or replies. Notes already serve the "scratch comment" role;
  encounters stay flat.
- **No** member-facing visibility. Encounters are internal-only, like Notes.
- **No** per-edit history table. Only `ModifiedBy` / `ModifiedDate` are
  tracked; full audit log can come later if needed.
- **No automated tests** for v1, per the user's "fast iteration" instruction.
  Commit and PR messages will not call this out.

## Data model

Two new tables in the `oe.*` schema. Migration file:
**`sql-changes/2026-05-15-encounters-tables.sql`**.

Per the shared-dev-database rule, the SQL file is committed but **not** applied
by Claude — the user (or DBA) runs it against `allaboard-testing`, and the same
script will be run against prod when the feature ships. The script is
idempotent (existence-guarded `CREATE TABLE` like the cases migration) and
includes a commented `ROLLBACK` block.

### `oe.Encounters`

The encounter record itself. One row per conversation.

| Column | Type | Notes |
|---|---|---|
| `EncounterId` | `UNIQUEIDENTIFIER PK` | `NEWID()` default |
| `VendorId` | `UNIQUEIDENTIFIER NOT NULL` | Tenant scoping; FK to `oe.Vendors` |
| `EncounterNumber` | `NVARCHAR(50) NOT NULL` | `ENC-YYYY-NNNN`, unique per vendor |
| `MemberId` | `UNIQUEIDENTIFIER NULL` | **NULL = Triage**. FK to `oe.Members` |
| `CaseId` | `UNIQUEIDENTIFIER NULL` | Optional pin; FK to `oe.Cases` |
| `ShareRequestId` | `UNIQUEIDENTIFIER NULL` | Optional pin; FK to `oe.ShareRequests` |
| `Summary` | `NVARCHAR(MAX) NOT NULL` | The only required user input |
| `Channel` | `NVARCHAR(20) NULL` | Enum: `phone` / `email` / `in_person` / `sms` / `video` / `other` |
| `Direction` | `NVARCHAR(20) NULL` | Enum: `inbound` / `outbound` / `internal` |
| `Source` | `NVARCHAR(30) NOT NULL DEFAULT 'manual'` | Enum: `manual` / `zoom_phone` / `zoom_meeting` / `imported` |
| `ExternalRef` | `NVARCHAR(200) NULL` | Future Zoom call ID slot |
| `OccurredAt` | `DATETIME2 NULL` | When the conversation happened (≠ `CreatedDate`); enables back-dated entries |
| `DurationSeconds` | `INT NULL` | Future Zoom |
| `RecordingUrl` | `NVARCHAR(500) NULL` | Future Zoom |
| `TranscriptText` | `NVARCHAR(MAX) NULL` | Future Zoom |
| `AssignedToUserId` | `UNIQUEIDENTIFIER NULL` | Triage assign-to; FK to `oe.Users` |
| `FollowUpDueDate` | `DATETIME2 NULL` | Follow-up flag |
| `FollowUpCompletedAt` | `DATETIME2 NULL` | Clears the flag when set |
| `IsArchived` | `BIT NOT NULL DEFAULT 0` | Soft delete |
| `CreatedDate` | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | |
| `CreatedBy` | `UNIQUEIDENTIFIER NULL` | Author; FK to `oe.Users` |
| `CreatedByName` | `NVARCHAR(200) NULL` | Cached author display name (mirrors `oe.CaseNotes`) |
| `ModifiedDate` | `DATETIME2 NULL` | |
| `ModifiedBy` | `UNIQUEIDENTIFIER NULL` | |

**Constraints**
- `PK_Encounters (EncounterId)`
- `UQ_Encounters_VendorEncounterNumber (VendorId, EncounterNumber)`
- FKs: Vendor, Member, Case, ShareRequest, AssignedToUser, CreatedBy
  (no `ON DELETE CASCADE` on the parent links — encounters survive deletion of
  their pinned case/SR; the FK col goes NULL via app-level cleanup or stays
  dangling and the UI shows "deleted")

**Indexes**
- `IX_Encounters_Vendor_Triage (VendorId)` filtered `WHERE MemberId IS NULL` —
  the dashboard's Triage filter is the hottest read
- `IX_Encounters_Vendor_AssignedTo (VendorId, AssignedToUserId)` — "Mine"
  filter
- `IX_Encounters_Member_Created (MemberId, CreatedDate DESC)` — member tab
- `IX_Encounters_Case (CaseId)` — case tab
- `IX_Encounters_ShareRequest (ShareRequestId)` — SR tab
- `IX_Encounters_Vendor_FollowUp (VendorId, FollowUpDueDate)` filtered
  `WHERE FollowUpDueDate IS NOT NULL AND FollowUpCompletedAt IS NULL` —
  "Follow-ups due" filter

**State is derived, not stored.** No `Status` enum. The set of encounter states
is fully expressible from existing columns:
- *Triage*: `MemberId IS NULL`
- *Assigned*: `AssignedToUserId IS NOT NULL`
- *Follow-up due*: `FollowUpDueDate IS NOT NULL AND FollowUpCompletedAt IS NULL`
- *Archived*: `IsArchived = 1`

This mirrors how `oe.Cases` derives Unclaimed/Claimed without a status enum,
and avoids the maintenance burden of a status state machine for what is
fundamentally a flat note-of-record.

### `oe.EncounterAttachments`

Optional file uploads. Same shape as `oe.CaseDocuments`.

| Column | Type | Notes |
|---|---|---|
| `AttachmentId` | `UNIQUEIDENTIFIER PK` | `NEWID()` default |
| `EncounterId` | `UNIQUEIDENTIFIER NOT NULL` | FK to `oe.Encounters`, `ON DELETE CASCADE` |
| `FileName` | `NVARCHAR(255) NOT NULL` | Original upload name |
| `MimeType` | `NVARCHAR(100) NULL` | |
| `FileSize` | `BIGINT NULL` | |
| `BlobUrl` | `NVARCHAR(500) NULL` | Azure Blob URL |
| `BlobPath` | `NVARCHAR(500) NULL` | Azure Blob path |
| `Description` | `NVARCHAR(500) NULL` | Optional caption |
| `UploadedBy` | `NVARCHAR(100) NULL` | Display name cache |
| `IsActive` | `BIT NOT NULL DEFAULT 1` | Soft delete |
| `CreatedDate` | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | |
| `CreatedBy` | `UNIQUEIDENTIFIER NULL` | |

Index: `IX_EncounterAttachments_Encounter (EncounterId, IsActive)`.

### Why no `EncounterNotes` audit table

Cases and Share Requests use `XxxNotes` tables to record both user notes
*and* status-change audit, distinguished by a `NoteType` discriminator. We
don't need this for encounters because:
1. Encounters don't have a status state machine.
2. Encounters *are themselves* the notes-of-record — there's no parent object
   that needs a per-event audit trail.
3. Edits write `ModifiedBy` / `ModifiedDate`. If full per-edit history becomes
   important (e.g. for transcript corrections of auto-generated content), it
   can be added without touching this table.

## Backend

**Service:** `backend/services/encounterService.js` — same shape as
`backend/services/caseService.js`. Exports an `ENCOUNTER_CHANNELS` and
`ENCOUNTER_DIRECTIONS` constant array so the front end can fetch via
`GET /api/me/vendor/encounters/meta`.

Methods:
- `generateEncounterNumber(pool, vendorId)` — `ENC-YYYY-NNNN`, vendor-scoped
  sequence (race-tolerant: unique constraint catches duplicates, caller
  retries)
- `getDashboardStats(vendorId, userId)` — returns `{ Total, Triage, Mine,
  FollowUpDueOpen, ToDayCount, ByChannel: { phone: n, email: n, ... } }`
- `listEncounters(vendorId, opts)` — supports `q`, `triage`, `mine`,
  `assignedToUserId`, `channel`, `memberId`, `caseId`, `shareRequestId`,
  `followUp` (`open` / `overdue` / `done`), `archived`, paging
- `getEncounter(vendorId, encounterId)`
- `createEncounter(vendorId, userId, userName, body)` — body fields all
  optional except `summary`; `Source` always `'manual'` for this path
- `updateEncounter(vendorId, encounterId, body, userId)` — sets `ModifiedBy/Date`
- `archiveEncounter(vendorId, encounterId)` — sets `IsArchived = 1`
- `assignEncounter(vendorId, encounterId, assignedToUserId)`
- `completeFollowUp(vendorId, encounterId)` — sets `FollowUpCompletedAt = now`
- `convertToCase(vendorId, userId, userName, encounterId, caseInput)` —
  precondition: encounter's existing `CaseId IS NULL` (else 409). Delegates
  to `CaseService.createCase` with `{ memberId: encounter.MemberId, title:
  caseInput.title, description: caseInput.description ?? encounter.Summary }`,
  then patches the encounter with the new `CaseId`. Encounter must have a
  `MemberId` set first (Triage encounters can't convert until assigned).
- `addAttachment(...)`, `getAttachment(...)`, `archiveAttachment(...)` —
  mirror the case documents helpers, reuse the same Blob client init pattern

**Route:** `backend/routes/me/vendor/encounters.js` — wired into
`backend/routes/me/vendor/index.js`.

```
GET    /api/me/vendor/encounters/meta              # channels + directions enums
GET    /api/me/vendor/encounters/dashboard         # stat cards
GET    /api/me/vendor/encounters                   # list with filters
POST   /api/me/vendor/encounters                   # create (manual)
GET    /api/me/vendor/encounters/:id
PATCH  /api/me/vendor/encounters/:id
DELETE /api/me/vendor/encounters/:id               # soft archive
POST   /api/me/vendor/encounters/:id/assign        # body: { userId }
POST   /api/me/vendor/encounters/:id/follow-up/complete
POST   /api/me/vendor/encounters/:id/convert-to-case  # body: { title?, description? }
POST   /api/me/vendor/encounters/:id/attachments   # multipart, multer
GET    /api/me/vendor/encounters/:id/attachments
GET    /api/me/vendor/encounters/:id/attachments/:attachmentId  # SAS download
DELETE /api/me/vendor/encounters/:id/attachments/:attachmentId
```

Auth on every route: `authenticate` →
`authorize(['VendorAdmin', 'VendorAgent'])` → `attachVendorContext`. Every
query in the service filters by `VendorId`. Tenant isolation is never bypassed.

## Frontend

### Types

`frontend/src/types/encounter.types.ts` — mirrors the shape of
`case.types.ts`. Exports `EncounterRow`, `EncounterAttachment`,
`EncounterListFilters`, `EncounterChannel`, `EncounterDirection`,
`EncounterSource`.

### Pages

- **`pages/vendor/EncountersPage.tsx`** — dashboard + list. Stat cards row at
  top (`Total / Triage / Mine / Follow-ups due`), filter chips
  (`All | Triage | Mine | Follow-ups due | by channel`), search input. List
  rail on the left, detail card on the right (or full-width on mobile).
  Reuses the visual pattern of the existing `pages/vendor/CaseWorkspace.tsx`.

- **`pages/vendor/EncounterWorkspace.tsx`** — opened when a row is selected.
  Shows the encounter detail card plus the attachments section. No tabs —
  encounters are flat.

### Components

- **`components/vendor/encounters/EncounterListRail.tsx`** — clone of
  `CaseListRail.tsx`. Each row shows: encounter number, member name (or
  *"Triage — unassigned"* in italic), channel icon, direction arrow, summary
  preview (one-line truncate), `OccurredAt` or `CreatedDate`,
  follow-up indicator if applicable.

- **`components/vendor/encounters/EncounterNewModal.tsx`** — the single-screen
  modal. Layout, top to bottom:
  1. Member search (`MemberSearchResult`-style, debounced; reuse
     `/api/me/vendor/members/search`). **Optional**, with a clear "Save without
     a member (Triage)" affordance.
  2. Optional pin row: `Link to a Case` and `Link to a Share Request` —
     filtered to the selected member's open items if a member is set;
     hidden / disabled if no member.
  3. `Channel` segmented control (Phone / Email / In-person / SMS / Video /
     Other).
  4. `Direction` segmented control (Inbound / Outbound / Internal).
  5. `OccurredAt` datetime input, defaults to "now."
  6. `Summary` — large textarea. **The only required field.** Save button
     enables once it has any non-whitespace text.
  7. Optional follow-up: a checkbox "Needs follow-up by" + date picker.
  - Submit: `POST /api/me/vendor/encounters` with everything the user filled.
    On success, modal closes and either (a) the user lands on the new
    encounter's detail page if launched from the dashboard, or (b) the
    relevant tab refetches if launched from a Case / SR / Member tab.

- **`components/vendor/encounters/EncounterDetailCard.tsx`** — view + inline
  edit of summary, channel, direction, occurred-at, member, pinned case/SR,
  assigned-to, follow-up. "Convert to case" button shown only when `CaseId
  IS NULL` *and* `MemberId IS NOT NULL` (Triage must be assigned first); if a
  `CaseId` is already set, that area becomes a link to the pinned case.
  Archive button (with confirm).

- **`components/vendor/encounters/EncounterAttachmentsSection.tsx`** — drop
  zone + list, reuses the case documents pattern.

- **`components/vendor/encounters/EncountersList.tsx`** — shared list
  component used by the per-entity tabs. Props: `scope: { memberId? } |
  { caseId? } | { shareRequestId? }`. Renders a compact list and an
  "Add encounter" button that opens `EncounterNewModal` with the scope
  pre-filled.

- **`components/vendor/encounters/EncounterFollowUpBadge.tsx`** — small
  reusable indicator (yellow if due soon, red if overdue, grey if completed).

### Tab additions on existing surfaces

- **Case workspace** (`components/vendor/cases/CaseWorkspaceTabs.tsx`) — add
  an `encounters` tab between `notes` and `communications`. Body:
  `<EncountersList scope={{ caseId }} />`.

- **Share request workspace**
  (`components/vendor/share-requests/ShareRequestWorkspaceTabs.tsx`) — same,
  add `encounters` tab between `notes` and `communications`. Body:
  `<EncountersList scope={{ shareRequestId }} />`.

- **Member detail tabs** — add a new `MemberEncountersTab.tsx` and slot it
  into `pages/members/MembersPage.tsx`'s tab definition. Body:
  `<EncountersList scope={{ memberId }} />`.

If the per-entity tab bars get crowded, the fallback is to fold
`Communications` and `Encounters` under a single `Activity` parent tab — but
v1 keeps them separate for clarity.

### Navigation

`components/vendor/VendorNavigation.tsx` — add an `Encounters` item between
`Cases` and the next nav entry. Show a small badge with the Triage count
(fetched from `/api/me/vendor/encounters/dashboard`, refreshed on tab focus).

## Future-Zoom hooks

Today's code keeps these paths open so the eventual Zoom integration is a
new module, not a rewrite:

- `Source = 'manual'` is hardcoded in the manual create path. A future Zoom
  worker writes `'zoom_phone'` (or `'zoom_meeting'`) plus
  `ExternalRef = <call-id>`. Schema is ready; no API change.
- `EncounterNumber` generation is reusable — a webhook handler can mint
  numbers the same way (vendor-scoped sequence).
- `DurationSeconds`, `RecordingUrl`, `TranscriptText` columns exist; the
  future ingest worker just inserts a row with those populated and `MemberId`
  resolved via a caller-id lookup. If the lookup fails, `MemberId` is left
  NULL and the row lands in Triage — same path users hit today.
- `POST /api/me/vendor/encounters` accepts the same fields a future Zoom
  webhook handler will need. The webhook itself will live at a separate
  path (e.g. `POST /api/integrations/zoom/...`) with HMAC verification and
  its own auth profile, but it'll write to the same service method.

## Migration constraints

This is the deliverable list for the schema change. The user runs the SQL;
Claude does not.

- One file: **`sql-changes/2026-05-15-encounters-tables.sql`**
- Idempotent: every `CREATE TABLE` is wrapped in `IF NOT EXISTS`, every
  index is checked before creation. Mirrors the cases migration verbatim
  in style.
- Includes a commented `ROLLBACK` block at the bottom (drop children before
  parent).
- Includes a verification `SELECT` that lists the tables created.
- Same script applies to prod when shipping.

## Open questions / followups

These are intentionally deferred. Listed here so a future spec author knows
where the seams are.

- **Member-side visibility** — if customers ever want to see "Sarah from the
  care team called you on Tuesday" in the member portal, expose a `IsMemberVisible`
  flag and a sanitized projection. Out of v1.
- **Triage SLA** — alerting if a triage encounter sits for > N hours. Out of
  v1.
- **Bulk operations** — bulk archive, bulk reassign. Wait for need.
- **Member auto-detection from phone number** — when Zoom integration lands,
  resolution will need a phone-number → MemberId index. Probably uses
  `oe.Members.PhoneNumber` plus a normalized lookup table; out of this spec.
- **Edit history on auto-transcribed encounters** — once Zoom transcripts can
  be edited by humans (to correct ASR errors), a per-edit log probably wants
  to exist. Easy add at that point.
