# Case & Share Request History Timeline — Implementation / PR Notes

Branch: `feat/back-office/case-history`
Status: **Phases 1–3 complete; migration applied to testing — pending browser check + PR**
Started: 2026-05-20

This is the running doc for the History timeline work. It tracks the design,
the change log (for writing the PR at the end), and the planned DB migrations.
Nothing here is committed or pushed automatically.

---

## Goal

A read-only **History tab** that shows a complete, time-ordered timeline of a
Case or Share Request — from how it was opened through every change, note,
document, form, encounter and communication — so a brand-new vendor agent can
see exactly where it stands. Cases get a new tab; the Share Request History
tab gets upgraded from its current thin status-only view.

## Approved design (Approach C — hybrid)

- **One shared component** `HistoryTimeline` + one backend aggregator, both
  parameterised by entity type (`case` | `share-request`).
- **Read model:** aggregate already-recorded history from domain tables at
  request time — no new event store. Existing open cases/SRs show their real
  full history immediately.
- **Targeted instrumentation** only for the genuine gaps (creation source,
  plan changes, outreach linkage) — deferred to Phases 2–3.
- **Email:** the timeline carries a `communication` event category and reads
  `oe.ShareRequestEmails`, but the email pipeline itself stays dormant (see
  Blocker below). SR email rows surface automatically once it is activated.
- **Notes tab stays** as the place to write notes; History is separate and
  read-only.

## Normalized event shape

```ts
interface TimelineEvent {
  id: string;
  category: 'creation' | 'status' | 'assignment' | 'note' | 'document'
          | 'provider' | 'encounter' | 'form' | 'communication' | 'plan' | 'system';
  occurredAt: string;            // ISO
  actorName: string | null;      // null = system
  title: string;
  detail: string | null;
  before: string | null;
  after: string | null;
}
```

## Phasing

| Phase | Scope | DB migration |
|-------|-------|--------------|
| **1** | Event shape, backend aggregator, 2 endpoints, shared component, both tabs. Reads only already-recorded data. | **None** |
| **2** | Creation event labelled `form` / `vendor` / `encounter` | `CreatedVia` column on `oe.Cases` + `oe.ShareRequests` |
| **3** | Plan changes + outreach in the timeline | Plan-change log + `CaseId`/`ShareRequestId` on `oe.MessageHistory` |

## Phase 1 — data sources (all already recorded)

**Case:** `oe.CaseNotes` (all NoteTypes — creation/status/claims/edits/user
notes), `oe.CaseDocuments`, `oe.CaseProviders`, `oe.Encounters` (by `CaseId`),
`oe.PublicFormSubmissions` (by `CaseId`), `oe.PublicFormInvitations` (by
`LinkedCaseId`).

**Share Request:** `oe.ShareRequestStatusHistory`, `oe.ShareRequestNotes` (all
NoteTypes), `oe.Encounters` (by `ShareRequestId`), `oe.ShareRequestEmails`,
`oe.PublicFormSubmissions` (by `ShareRequestId`), `oe.PublicFormInvitations`
(by `LinkedShareRequestId`).

Each source is collected defensively — a failing collector logs and yields an
empty list rather than breaking the whole tab.

---

## DB migration — `sql-changes/2026-05-20-history-timeline.sql`

**Applied to `allaboard-testing` on 2026-05-20** (all 5 columns + both filtered
indexes created; verified). **Still needs to run on production** with the
deploy. Idempotent (COL_LENGTH / sys.indexes guarded). Adds:
- `oe.Cases.CreatedVia`, `oe.ShareRequests.CreatedVia` — Phase 2
- `oe.MemberEventLog.EventDetails` — Phase 3A
- `oe.MessageHistory.CaseId` + `ShareRequestId` + filtered indexes — Phase 3B

**Code/migration order is independent.** All backend code tolerates these
columns being absent (defensive queries / try-catch): before the migration the
creation events show no source label, plan/outreach events don't appear, and
case/SR/enrollment writes still succeed — nothing breaks. After it runs, the
extra detail appears automatically.

---

## Blocker — email pipeline is dormant

The email feature is fully coded but never activated:
- `oe.ShareRequestEmails` — **0 rows**.
- **0 of 8 vendors** have Office 365 credentials configured.
- `EmailLogTab.tsx` exists but is **not mounted** in the SR workspace.
- `checkForReplies()` is reactive-only; no scheduled poller.

Surfacing email in the timeline therefore shows nothing until the pipeline is
activated. Proposed activation (separate effort, not in this project):
1. Register a per-vendor Office 365 app with `Mail.Send` + `Mail.Read`.
2. Populate `oe.Vendors` O365 columns; verify with `testEmailConfig()`.
3. Mount `EmailLogTab` in `ShareRequestWorkspaceTabs`.
4. Optionally add a scheduled `checkForReplies()` poller.
Once active, SR emails appear in the timeline automatically via the
`communication` category — no further timeline work needed.

---

## Follow-up — event detail & click-through (Phase 1.5, proposed)

Phase 1 rows are intentionally one-liners and lack detail an agent needs:
"Form sent" doesn't name the form; "Encounter logged" doesn't show
channel/duration/follow-up; "Document added" doesn't link to the file.

The richer data already exists in the source tables — Phase 1 just doesn't
fetch or surface it. Proposed enhancement:

1. **Enrich collectors** — join the missing context (e.g. `PublicFormTemplates`
   for the form name / `KindLabel`; encounter number/channel/duration;
   document size/type/URL).
2. **Extend `TimelineEvent`** with two optional fields:
   - `meta` — key→value detail pairs rendered inside a modal.
   - `ref` — `{ kind, id }` identifying the underlying record for click-through.
3. **Clickable rows** — clicking an event opens a detail modal (the `meta`
   pairs); the modal has an "Open" / "See all" button that deep-links to the
   real record via `ref`.

Deep-link destinations that already exist (vendor-scoped routes):

| Event | Destination |
|-------|-------------|
| encounter | `…/encounters/:id` |
| form submitted | `…/sharing-forms/submissions/:submissionId` |
| form sent | `…/sharing-forms/template/:formTemplateId/invitations` |
| document | open blob URL, or switch to the Documents tab |
| provider | switch to the Providers tab |
| note / status | no link — fully shown inline |

Open question: documents and providers have no standalone detail page — the
modal can either deep-link to the relevant workspace tab or just show inline.

## Form open/view tracking — NOT available (correction)

An earlier draft of this doc claimed form first-open was tracked. **That was
wrong.** The platform records **no "form opened to be filled" timestamp** for
any form type. The only "open" columns are *post-submission* events, and only
for anonymous forms:
- `PublicFormSubmissions.AnonymousLinkFirstViewedAt` — the submitter's
  anonymous *submission view-link* opened, **after** submitting (the code
  computes `secondsFromSubmitToFirstView`).
- `PublicFormSubmissions.RoutingEmailFirstOpenedAt` — the post-submit routing
  email opened.
- `PublicFormInvitations.FirstUsedAt` — invitation first **submitted** against.

Targeted-invitation forms (`AuthMode='targeted'`) have no view/open data at
all. **Decision: form-open events were dropped from the timeline** — they were
mislabeled and only ever fired for anonymous forms. Real form-open tracking
would need new instrumentation in the public form-fill route — out of scope.

### Separate task — surface first-open on the forms/submissions UI

Checked whether the first-open timestamps are visible in the existing UI:
- `TenantSharingSubmissionDetailPage.tsx` **does** show "Submission link first
  opened" (`AnonymousLinkFirstViewedAt`).
- The submissions **list** (`TenantSharingSubmissionsPage.tsx`) types the
  column but does not render it.
- `RoutingEmailFirstOpenedAt` is **not surfaced anywhere** in the UI.

Follow-up (tracked separately, not part of this branch): add a "link opened" /
"email opened" indicator to the submissions list and surface
`RoutingEmailFirstOpenedAt` on the detail page.

## Change log (for the PR)

### Phase 1 — added
- `backend/services/historyTimelineService.js` — read-only aggregator.
  `getTimeline(entityType, entityId, vendorId)` fans out across the domain
  tables, normalizes each source into `TimelineEvent`, merges newest-first.
  Per-collector `try/catch` so one failing source can't break the tab.
  Enforces vendor ownership (wrong vendor → 404).
- `frontend/src/components/vendor/shared/HistoryTimeline.tsx` — shared
  read-only timeline component, props `{ entityType, entityId, refreshKey? }`.
  Vertical timeline with per-category icons, before→after chips, actor +
  timestamp, and client-side category filter chips.

### Phase 1 — modified
- `backend/routes/me/vendor/cases.js` — added `GET /:id/history` + service
  require.
- `backend/routes/me/vendor/share-requests.js` — added `GET /:id/history` +
  service require. (The old `GET /:id/activity` route is left in place,
  now unused by the UI — can be removed in a later cleanup.)
- `frontend/src/components/vendor/cases/CaseWorkspaceTabs.tsx` — added the
  `history` tab (key/TABS/renderBody) with the `Activity` icon.
- `frontend/src/components/vendor/share-requests/tabs/HistoryTab.tsx` —
  replaced the old status-only implementation with a thin wrapper around the
  shared `HistoryTimeline`. The SR History tab now also shows notes,
  encounters, forms and (when present) emails.

### Phase 1 — DB migration
None. Phase 1 reads only already-recorded data.

### Phase 1.5 — added / modified
- `backend/services/historyTimelineService.js` — enriched all collectors:
  - `meta` (label/value detail pairs) and `ref` ({ kind, id } deep-link
    target) added to every event.
  - Form events resolve the real form name via `PublicFormTemplates.Title`.
  - ~~New events: "Form link first opened" / "Routing email first opened".~~
    **Dropped** — those columns are post-submit link opens, not form opens;
    see "Form open/view tracking" above.
  - Encounter / document / provider events carry structured detail
    (channel, duration, follow-up, file size/type, NPI, etc.).
- `frontend/src/components/vendor/shared/HistoryTimeline.tsx` — events with
  `meta`/`ref` are clickable; opens a detail modal showing the meta pairs and
  an "Open …" button that deep-links to the underlying record:
  - encounter → `/vendor/encounters/:id`
  - form submission → `/vendor/sharing-forms/submissions/:id`
  - form sent → `/vendor/sharing-forms/template/:id/invitations`
  - Modal closes on Escape / click-outside.

### Phase 1.5 — DB migration
None.

### Phase 2 — creation source
- `backend/services/caseService.js` — `createCase` accepts `createdVia`
  (default `'vendor'`), stamps it via a post-insert UPDATE wrapped in
  try/catch (tolerates the column being absent pre-migration).
- `backend/services/shareRequestService.js` — same for `createShareRequest`.
- Callers pass the right value:
  - `services/encounterService.js` `convertToCase` → `'encounter'`
  - `routes/me/member/sharing-requests.js` → `'form'`
  - `services/publicFormShareLinkService.js` → `'form'`
  - vendor-portal create routes → default `'vendor'`
- `backend/services/historyTimelineService.js` — new `collectCreation`
  collector emits one "created via form/vendor/encounter" event from the
  entity row; the redundant `created` / `Share request created` notes are
  filtered out.

### Phase 3 — plan changes + outreach
- `backend/services/memberEventLogService.js` (new) — fire-and-forget,
  never-throws writer for `oe.MemberEventLog`; own connection (cannot abort a
  caller's transaction); COL_LENGTH-aware (works pre/post migration).
- `backend/services/enrollments/enrollmentWriter.service.js` —
  `insertProductEnrollmentRow` now logs an `ENROLLMENT_CREATED` member event
  (fire-and-forget, not awaited — enrollment cannot be broken by it).
- `backend/services/historyTimelineService.js` — new collectors:
  - `collectPlanChanges` — reads `oe.MemberEventLog` for the entity's member,
    limited to the case/SR open window. Surfaces `ENROLLMENT_CREATED` plus the
    already-logged `PLAN_MODIFICATION_APPLIED` and `GROUP_CHANGED` events.
  - `collectOutreach` — reads `oe.MessageHistory` by `CaseId`/`ShareRequestId`.
- No frontend changes — the `plan` and `communication` categories already
  exist in the shared component.

### Phase 3 — known gap (outreach sender wiring, deferred)
`collectOutreach` + the `MessageHistory` columns are in place, but **no sender
stamps `CaseId`/`ShareRequestId` yet**, so outreach events stay empty until
that is wired. The only case/SR-contextual `MessageHistory` path is staff
**note-mention emails** (low timeline value — the note itself already shows).
Wiring it means threading an id through shared messaging infra
(`messageQueue.service.js`, `immediateEmailSend.js`/`immediateSmsSend.js`,
`noteMentionService.js`, the two note routes) with deploy-ordering risk.
Customer-facing SR email is already covered via `oe.ShareRequestEmails`.
Recommended as a separate follow-up.

## Manual verification
- `tsc --noEmit` — no errors in any changed frontend file.
- Backend modules load cleanly (`require` of every new/changed service + route).
- Aggregator smoke-run against `allaboard-testing`:
  - Phase 1: `CASE-2026-0001` → 8 events; SR → 10 events; wrong vendor → 404.
  - Phase 1.5: case encounter event carries `meta` (Encounter #, Channel,
    Direction, Follow-up) + `ref`; SR form-submitted event resolves the real
    form name and carries a `form-submission` `ref`.
- Phase 2/3 (pre-migration): case → 8 events incl. a `creation` event; SR → 15
  events incl. a `creation` event; plan/outreach collectors degrade to empty
  gracefully (columns absent); no crash.
- Migration applied to `allaboard-testing` (2026-05-20); post-migration
  aggregator re-run — no regression (case → 8, SR → 16, creation events
  present). `CreatedVia` is NULL on pre-existing rows, so their creation event
  shows "Ticket/Share request created" with no source label — only entities
  created after this point get the "created via …" label.
- Still **to do before merge**: open a Case and a Share Request (ideally a
  freshly created one) in the vendor portal and eyeball the History tab + a
  detail modal + the "created via …" label.

## Suggested PR title
`feat(back-office): add History timeline tab to Cases and Share Requests`
