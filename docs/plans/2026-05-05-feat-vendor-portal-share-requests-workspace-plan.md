---
title: Vendor Portal — Share Requests Split-Pane Workspace
type: feat
status: active
date: 2026-05-05
deepened: 2026-05-05
origin: docs/brainstorms/2026-05-05-vendor-portal-share-requests-split-pane-brainstorm.md
---

# Vendor Portal — Share Requests Split-Pane Workspace

## Enhancement Summary

**Deepened on:** 2026-05-05
**Sections enhanced:** 7 — State & Data Fetching, Routing, Architecture,
Acceptance Criteria, Risks, plus new sections: TypeScript Conventions,
Concurrency & Lifecycle Policy, Accessibility & Keyboard.
**Review agents used:** Kieran TypeScript, Frontend Races (Julik), Code
Simplicity, Pattern Recognition, Performance Oracle, Agent-Native Parity,
Best Practices Researcher.

### Key Improvements
1. **Paradigm reconciled with Members workspace.** Plan originally specified
   React Query; Members uses `apiService` + `AbortController` directly. Slice
   now matches Members for parity; React Query lift is filed as a separate
   cross-workspace follow-up.
2. **Concurrency & Lifecycle Policy added** — closes 10 race conditions
   identified by the frontend-races review (mutation-mid-switch, upload
   policy, polling cleanup, URL sync, optimistic rollback toast surfacing,
   per-tab state machine, `keepPreviousData` on header).
3. **TypeScript conventions section added** — `IconComponent` lifted to
   `frontend/src/types/icon.ts` (third-site rule from learnings), discriminated
   `TabKey` union (`primary` vs `advanced`), `as const satisfies` derived tab
   list, query key factory (when RQ lands), banned `LucideIcon` and `any`.
4. **URL state expanded** — rail filters (`q`, `status`, `determination`,
   `type`, `from`, `to`, `page`, `limit`) AND `tab` all live in the URL;
   `replace: true` for tab changes, `push` for SR-id changes.
5. **Accessibility & keyboard contract** added — listbox + activedescendant
   for the rail (W3C APG), Disclosure pattern (not menu) for `Advanced ▾`,
   J/K/Enter/Esc/Cmd+\\ keymap, `aria-live` announce on SR swap.
6. **Performance defaults specified** — Email Log polling on-demand only;
   page size 25 + virtualize > 50; memoize rail/header/tabs; precise
   invalidation predicates (no whole-detail invalidation on Bill add);
   list-endpoint payload audit added to Phase 2.
7. **Simplicity trims** — dropped arbitrary "≤ 400 LOC" metric, inlined
   empty state component, trimmed Future Considerations bloat.

### Open Questions Surfaced
- **Documents upload policy:** detached queue (uploads survive SR switch
  via module-scope queue) vs. block-and-warn (`beforeunload`-style guard).
  Recommendation: detached queue. Confirm before Phase 2.
- **Plan rollup label:** computed client-side (over-fetch + drift) or pushed
  into `getShareRequestById` payload (correct, requires backend touch).
  Recommendation: backend-side rollup as a small additive field.

## Overview

Replace the current Share Requests experience — `ShareRequestList.tsx`
(table) + `ShareRequestDetail.tsx` (5,551-line monolithic detail page) — with
a **single split-pane workspace** mirroring the legacy reference screenshots:
sticky-search rail of share-request cards on the left, fixed Membership /
Requester / Plan header card on top of the right pane, and a 10-tab body
underneath (Request Details, Providers, Bills, Ledger, Documents, Plans,
Call Log, Email Log, Medical Records, Notes), with the existing power-user
tabs (History, Negotiations, FAP, ESS, Work Items, Queues) preserved behind
an **Advanced** overflow.

This is the direct sibling of the Members workspace already shipped on
`new-backoffice-portal` and re-uses the same shell pattern, primitives
(`Spinner`, `Skeleton`, `EmptyState`, `ComingSoonPanel`), and brand tokens.

## Problem Statement

1. **Operator UX gap.** Vendor agents work the legacy app today and switch
   between requests dozens of times per shift; full-page navigation per click
   in the new portal is a measurable friction point.
2. **Code maintainability.** `ShareRequestDetail.tsx` is **5,551 lines** with
   13 tab branches, intertwined CRUD handlers, and inline UI for every tab
   in one file. Touching one tab risks regressions across the rest.
3. **Visual + UX inconsistency with Members workspace.** Members already
   ships a split-pane workspace; Share Requests is the most-used screen in
   the portal and lags behind.
4. **No header summary.** Today the operator scrolls to find member / plan
   context; in the legacy app that header is always-visible above the tabs.
5. **Medical Records is missing entirely** in the new portal even though the
   legacy app exposes it.

## Proposed Solution

A new workspace shell at `/vendor/share-requests` (already a route — we
swap the component) with:

- **Left rail** (`ShareRequestListRail`): sticky search, scrollable cards
  showing `SW{number}` + `R-{reference}`, member name + DoB, agent (with
  edit-pencil), status, created date. Selected card highlighted with
  `oe-light` background and `oe-primary` left-border. Pagination & filter
  chips kept (lift from `ShareRequestList`).
- **Header card** (`ShareRequestHeaderCard`): 3 columns, always visible —
  Membership / Requester / Plan — sourced from the existing
  `getShareRequestById` payload (no new joins).
- **Tab bar** (`ShareRequestWorkspaceTabs`): primary 10-tab surface +
  trailing **Advanced ▾** overflow disclosing 6 power-user tabs.
- **Tab body**: lazy-loaded per-tab components in
  `components/vendor/share-requests/tabs/` and `.../advanced/`.
- **Mobile (`<md`)**: collapses to rail-only list page → tap → full-screen
  detail with back button. No drawer this slice.

Existing CRUD wiring on every tab is **lifted, not rewritten** — the goal is
decomposition + layout, not a re-implementation of business logic.

## Technical Approach

### Architecture

```
pages/vendor/ShareRequestWorkspace.tsx          (replaces ShareRequestList + ShareRequestDetail at /vendor/share-requests/:id?)
  ├─ ShareRequestListRail                        (left, ~320px)
  └─ <selected request? — render header + tabs : empty state>
        ├─ ShareRequestHeaderCard                (Membership / Requester / Plan)
        └─ ShareRequestWorkspaceTabs
              └─ <active tab component>

components/vendor/share-requests/
  ├─ ShareRequestListRail.tsx                    (search + filters + paginated list)
  ├─ ShareRequestHeaderCard.tsx                  (3-col fixed header)
  ├─ ShareRequestWorkspaceTabs.tsx               (primary tabs + Advanced overflow)
  ├─ ShareRequestWorkspaceEmptyState.tsx         (rendered when no SR is selected)
  ├─ tabs/
  │    ├─ RequestDetailsTab.tsx                  (lift summary section)
  │    ├─ ProvidersTab.tsx                       (lift)
  │    ├─ BillsTab.tsx                           (lift; provider grid + bills grid + totals strip)
  │    ├─ LedgerTab.tsx                          (lift transactions)
  │    ├─ DocumentsTab.tsx                       (lift folder tree + upload)
  │    ├─ PlansTab.tsx                           (lift; read-only)
  │    ├─ CallLogTab.tsx                         (lift)
  │    ├─ EmailLogTab.tsx                        (lift; keep send/preview/check-replies)
  │    ├─ MedicalRecordsTab.tsx                  (placeholder — ComingSoonPanel)
  │    └─ NotesTab.tsx                           (lift; SMS sub-tab moves to Advanced)
  └─ advanced/
       ├─ HistoryTab.tsx
       ├─ NegotiationsTab.tsx
       ├─ FAPTab.tsx
       ├─ ESSTab.tsx
       ├─ WorkItemsTab.tsx
       ├─ QueuesTab.tsx
       └─ SmsTab.tsx                             (lift commSubTab='SMS' subtree out of NotesTab)
```

`ShareRequestList.tsx` and `ShareRequestDetail.tsx` are removed once content
is migrated. `App.tsx` collapses the two routes into one workspace route.

### Routing & URL State Contract

```tsx
// frontend/src/App.tsx (around line 585)
<Route path="share-requests/dashboard" element={<ShareRequestDashboard />} />
<Route path="share-requests/queues"    element={<ShareRequestQueues />} />
<Route path="share-requests/new"       element={<ShareRequestNew />} />
<Route path="share-requests/:id"       element={<ShareRequestWorkspace />} />
<Route path="share-requests"           element={<ShareRequestWorkspace />} />
```

Both `share-requests` and `share-requests/:id` resolve to the workspace.
The 18 internal `navigate('/vendor/share-requests/${id}')` callsites
identified across the codebase keep working unchanged — they auto-select
that request in the rail.

**URL is the single source of truth.** Local state must NOT mirror URL
fields. Reads via `useSearchParams().get(...)`; writes via the **functional
updater** (`setSearchParams(prev => { prev.set(...); return prev; }, { replace })`)
because `setSearchParams` does not compose across multiple sync calls in
the same tick (Members workspace already uses this pattern).

**Query parameters honored:**

| Param           | Source             | Example                  |
|-----------------|--------------------|--------------------------|
| `q`             | rail search        | `?q=bender`              |
| `status`        | rail filter chip   | `?status=New`            |
| `determination` | rail filter chip   | `?determination=Pending` |
| `type`          | rail filter chip   | `?type=Medical`          |
| `from` / `to`   | rail date range    | `?from=2026-04-01`       |
| `page` / `limit`| rail pagination    | `?page=2&limit=25`       |
| `tab`           | active tab         | `?tab=bills`             |

**Valid `tab` values** (deep-linkable, including Advanced):
`request-details | providers | bills | ledger | documents | plans | call-log
| email-log | medical-records | notes | history | negotiations | fap | ess
| work-items | queues | sms`. Unknown values silently fall back to
`request-details` (via `isTabKey` type guard — see TypeScript Conventions).
Advanced tabs are addressable directly without opening the overflow first.

**Navigation semantics:**
- Tab change → `setSearchParams(..., { replace: true })` — back/forward
  navigates between SRs, not tab-by-tab within one SR.
- SR id change (rail click) → `navigate('/vendor/share-requests/:id?...', { replace: false })`
  preserving the current `tab` and rail filter params.
- Default tab is `request-details`. When the active tab equals the default,
  **delete the `tab` param** rather than setting it (matches Members
  workspace pattern in `VendorMembersWorkspace.tsx:38–49`).

### State & Data Fetching

> **Paradigm decision (revised after deepen):** match the **Members workspace
> pattern** — direct `apiService` calls + per-fetch `AbortController` —
> rather than introducing React Query in this slice. Reason: introducing
> React Query asymmetrically would split the two sibling workspaces across
> two paradigms (cf. Pattern Recognition review). React Query lift is filed
> as a separate cross-workspace follow-up that re-homes both Members and
> Share Requests in one PR.

- **List rail:** custom hook `useShareRequestsList({ q, status,
  determination, type, from, to, page, limit })` mirroring
  `MemberListRail.tsx`'s pattern: `useState` (loading, data, error) +
  `useEffect` with an `AbortController` re-created per dependency change.
  300ms debounce on `q`. On debounce change, page resets to 1. Backed by
  `GET /api/me/vendor/share-requests`.
- **Selected request:** `useShareRequest(id)` — same shape, backed by
  `GET /api/me/vendor/share-requests/:id`. Provides Membership / Requester /
  Plan fields for the header card; no new endpoint required for this slice.
  Header keeps last data on refetch (equivalent to RQ `keepPreviousData`)
  via a local `useRef` of the last good payload, so rapid SR switching
  doesn't blank the header.
- **Per-tab data:** each tab owns its fetch hook (lazy on tab activation;
  remount keyed `${id}-${activeTab}` so AbortControllers reset cleanly).
  Existing endpoints map 1:1:

  | Tab              | Endpoint(s)                                                          |
  |------------------|----------------------------------------------------------------------|
  | Request Details  | `GET/PUT /:id`, `PUT /:id/status`                                    |
  | Providers        | `GET/POST/DELETE /:id/providers`                                     |
  | Bills            | `GET/POST/PUT/DELETE /:id/bills`                                     |
  | Ledger           | `GET/POST/PUT/DELETE /:id/transactions`                              |
  | Documents        | `GET/POST/DELETE /:id/documents` (+ `/upload`)                       |
  | Plans            | `GET /:id/member-plans`                                              |
  | Call Log         | `GET/POST/PUT /:id/call-logs`                                        |
  | Email Log        | `GET/POST /:id/emails` (+ `/send`, `/preview`, `/check-replies`)     |
  | Medical Records  | _(none yet — placeholder; backend follow-up ticket)_                 |
  | Notes            | `GET/POST/PUT/DELETE /:id/notes`                                     |
  | Advanced         | `/history`, `/negotiations`, `/fap`, `/ess`, `/work-items`, `/queues` (all extant) |

- **Cross-tab invalidation (without React Query):** each tab hook exposes a
  `refetch()` ref + a small `useShareRequestEvents(id)` event bus
  (`mitt` or a hand-rolled `EventTarget`) that mutations emit on. E.g.,
  Bills' `addBill` mutation emits `bills.changed` and `ledger.changed`
  (Ledger totals depend on bills); the Ledger tab's hook listens and
  refetches if mounted, no-ops if not. The header card listens for
  `request.changed` only — adding a Bill does NOT invalidate the whole
  detail; Ledger totals are read from `GET /:id/transactions` directly.
  Catalog every `loadTabData('x')` callsite in `ShareRequestDetail.tsx`
  during the lift and translate it to an event emission.

### Header Card Field Mapping

Sourced from the `getShareRequestById` payload (already returns these — see
`backend/services/shareRequestService.js`):

```
Membership column:                Requester column:               Plan column:
  Name        ← Member.FullName    Member ID  ← MemberCode/SW#     <Family/Individual> $<UAAmount> UA
  DoB         ← Member.DoB         Effective  ← Plan.EffectiveDate UA: <UAAmount>
  Primary    ← PrimaryName        Term Date  ← Plan.TermDate      Tier: <TierCode>
  Spouse     ← SpouseName         Status     ← Status (green dot)
  Phone      ← MemberPhone
  Email      ← MemberEmail
```

The "Plan" column rolls up `member-plans` results into a single label
(top plan if multiple); detail in the Plans tab.

### UI Tokens & Primitives (no new design system)

- Cards: `bg-white rounded-lg border border-gray-200`.
- Active rail card: `bg-oe-light border-l-4 border-oe-primary`.
- Tab bar active: `border-b-2 border-oe-primary text-oe-primary`.
- Reuse `Spinner`, `Skeleton`, `EmptyState`, `ComingSoonPanel` from
  `components/vendor/ui/` and `components/vendor/members/ComingSoonPanel.tsx`
  (move ComingSoonPanel to `components/vendor/ui/` so both workspaces share it).

### TypeScript Conventions (binding for this PR)

1. **Lift `IconComponent` to `frontend/src/types/icon.ts`.** Per the existing
   learning at `docs/solutions/build-errors/lucide-react-icon-type-import.md`
   (line 113: *"if a third place needs the same alias, lift it"*), this PR
   is the third site. Update `MemberWorkspaceTabs.tsx` and `ComingSoonPanel.tsx`
   imports in the same PR. Banned imports in code review: `import { LucideIcon }`,
   `import type { LucideIcon }`.
2. **Discriminated `TabKey` union, `as const satisfies`-derived list:**

   ```ts
   type PrimaryTabKey =
     | 'request-details' | 'providers' | 'bills' | 'ledger' | 'documents'
     | 'plans' | 'call-log' | 'email-log' | 'medical-records' | 'notes';
   type AdvancedTabKey =
     | 'history' | 'negotiations' | 'fap' | 'ess' | 'work-items' | 'queues' | 'sms';
   type TabKey = PrimaryTabKey | AdvancedTabKey;

   const TABS = [
     { key: 'request-details', group: 'primary', label: 'Request Details', icon: FileText },
     // …
     { key: 'queues',          group: 'advanced', label: 'Queues',          icon: ListChecks },
   ] as const satisfies readonly {
     key: TabKey; group: 'primary' | 'advanced'; label: string; icon: IconComponent
   }[];

   const isTabKey = (v: string | null): v is TabKey =>
     !!v && TABS.some(t => t.key === v);
   ```

   Tab bar filters by `group === 'primary'` for the visible row and
   `group === 'advanced'` for the disclosure panel. No `VALID_TABS` runtime
   list duplicating the type union.
3. **Header card props as discriminated state union** —
   `{ state: 'loading' } | { state: 'error'; message } | { state: 'ready'; data }`.
   Renderer maps `null → '—'` in one place. No `string | undefined | ''`.
4. **No inline `apiService.get<{ ... }>(...)` generics in tab code.** Each
   tab's hook declares a real response interface in a co-located `types.ts`
   (e.g., `ShareRequestBillsResponse`).
5. **No `any` introduced or preserved.** Lifted code from the monolith must
   narrow `any` to a real type or add a `// TODO(strictness): narrow X`
   comment with a follow-up issue link. `npx tsc --noEmit` passes (project
   is not strict-mode-wide today; do not flip the flag in this PR).
6. **`?tab=` parsing uses `isTabKey` guard.** No `as TabKey` casts.
7. **Hook signatures accept undefined ids** (`useShareRequest(id?: string)`)
   and use `enabled: !!id`-equivalent gating in the `useEffect`.
8. **Filter type, not `Record<string, any>`:** `interface ShareRequestFilters
   { q?: string; status?: ShareRequestStatus; determination?: ...; type?:
   ...; from?: string; to?: string; }`. Already largely defined in
   `types/shareRequest.types.ts` — extend, don't re-derive.

### Concurrency & Lifecycle Policy

Codifies mitigations for races identified during deepen review.

1. **Mutation closure-capture of `srId`.** Every mutation handler captures
   `const srId = id` at trigger time. `onSuccess`/`onError` callbacks
   refetch using the captured id. No use of the live `id` from
   `useParams()` inside async callbacks.
2. **Mutation toasts via global toast service**, not local component state.
   A `BillsTab` that has unmounted (operator switched SR) must still emit
   the success/failure toast for its in-flight mutation. Toast click on
   failure navigates back to the originating SR + tab — see point 6.
3. **Document upload policy: detached upload queue (recommended).** Uploads
   live in a module-scope queue keyed by SR id with their own
   `AbortController`. They survive SR switch / tab unmount and report
   completion via toast + `documents.changed` event against the original
   SR id. The Documents tab subscribes to "uploads for this SR" on mount
   and renders an "in-flight uploads" strip above the folder tree.
   Block-and-warn `beforeunload` is the documented fallback if detached
   queue lands too late.
4. **Polling cleanup contract (HIPAA-adjacent).** Every `setInterval` /
   `setTimeout` lifted from the monolith lives inside a `useEffect` whose
   cleanup clears the timer. Tick handlers check a captured-at-trigger-time
   cancel ref before calling `setState`; otherwise an in-flight tick from
   SR-A repaints SR-B's tab with SR-A's data. **No `setInterval` may
   outlive its tab's unmount.** Specifically applies to: SMS auto-refresh,
   activity history auto-refresh.
5. **Email Log polling is on-demand only.** No background polling; the
   "Check Replies" button triggers a one-shot fetch. `refetchInterval:
   false` if React Query is later introduced.
6. **Persistent failure toasts for mutations whose tab has unmounted.**
   Optimistic rollback for an unmounted tab is invisible by default —
   surface it as a toast with a click handler that navigates to the
   original SR + tab.
7. **Per-tab state machine for tabs with > 1 mutation.** Bills / Ledger /
   Notes / Documents / Call Log / Email Log use a `Symbol`-based enum
   (`idle | loading | loaded | savingAdd | savingEdit | savingDelete |
   errored`) instead of a single boolean. Save buttons are disabled by
   exhaustive-switch on the state.
8. **Header + rail keep previous data during refetch** (no blanking).
   Implementation: a `useRef<LastGoodData | null>` updated on success;
   render falls back to ref while `loading && data === undefined`.
9. **No CSS transitions on tab body mount/unmount.** Tab swaps must feel
   instant; transitions cause Cypress flake.
10. **Single cancellation policy:** `AbortController` per fetch in
    `useEffect` cleanup; mutations do **not** cancel on unmount (uploads,
    bill edits, etc. should complete and report). Add a comment at each
    mutation site referencing this policy.

### Accessibility & Keyboard

Follows W3C ARIA Authoring Practices Guide (APG).

- **Rail = `role="listbox"` + `aria-activedescendant`.** Rail does NOT move
  DOM focus on arrow-key navigation; it updates `aria-activedescendant` on
  the listbox so screen readers announce the new card without stealing
  focus from whatever the operator was typing in the detail pane. Each
  card is `role="option"` with `aria-selected`. Reference:
  https://www.w3.org/WAI/ARIA/apg/patterns/listbox/.
- **Tab bar = `role="tablist"`** with `role="tab"` buttons, each
  `aria-controls`-ing its panel `role="tabpanel"` + `aria-labelledby` back
  to its tab. Roving tabindex (one tab is `tabindex="0"`, others
  `tabindex="-1"`); arrow keys move within the tablist only.
- **`Advanced ▾` = Disclosure pattern, NOT `role="menu"`.** Trigger is
  `<button aria-expanded aria-controls="advanced-panel">`; revealed items
  are still `role="tab"` participating in the same tablist. Esc closes and
  returns focus to trigger. Tab key (not arrows) traverses revealed tabs.
  Reference: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/.
- **Active tab always visible.** If `ResizeObserver` detects the active
  tab would overflow, swap it with the last visible tab so operators see
  their selection.
- **Keyboard contract:**
  - `↑ / ↓` (or `J / K`) — move highlight in rail.
  - `Enter` — load highlighted SR (push URL).
  - `Esc` — return focus from detail pane to rail.
  - `Cmd / Ctrl + \\` — toggle rail visibility.
  - `← / →` — move within tab bar.
  - `Tab` — natural focus traversal inside detail pane.
- **`aria-live="polite"` status node** announces SR-swap completion ("Loaded
  share request SW8879419 for Duke Bender"). Do NOT auto-focus inside the
  detail pane on SR swap — steals from rail navigation.
- **Color contrast:** active rail card (`bg-oe-light/60` + 4px
  `oe-primary` left border) and active tab indicator must pass WCAG AA
  against the surrounding gray-200 borders. Verify with a lighthouse run.

### Implementation Phases

#### Phase 1 — Shell + read-only spine (small PR)
- New files: `ShareRequestWorkspace.tsx`, `ShareRequestListRail.tsx`,
  `ShareRequestHeaderCard.tsx`, `ShareRequestWorkspaceTabs.tsx`. Empty state
  is **inlined** in `ShareRequestWorkspace.tsx` — no separate file.
- New shared types file: `frontend/src/types/icon.ts` exporting
  `IconComponent`. Update existing imports in
  `components/vendor/members/ComingSoonPanel.tsx` and
  `components/vendor/members/MemberWorkspaceTabs.tsx` to consume from there
  (per the lucide learning).
- Move `ComingSoonPanel.tsx` from `components/vendor/members/` to
  `components/vendor/ui/` and update Members imports in the same commit
  (one shared primitive, one home).
- Lift the **Request Details** read view + **Plans** tab + **Providers**
  list view (read only — no Add/Delete yet) into their tab files.
- Wire routes in `App.tsx`. `ShareRequestList.tsx` deleted.
- Implement URL state contract (rail filters + `tab` in query string).
- Implement ARIA + keyboard contract from §Accessibility.
- Cypress smoke: list loads, search filters URL-sync, select-card-shows-header,
  Plans renders, default tab is Request Details (with no `tab` param).

**Deliverable:** new workspace usable as a navigator with read access.

#### Phase 2 — CRUD parity for primary tabs (the heavy lift)
- Lift CRUD for **Request Details** (form save), **Providers**
  (Add/Delete), **Bills** (Add/Edit/Delete + provider grid + totals),
  **Ledger** (Add/Edit/Delete + totals strip), **Notes** (Add/Edit/Delete),
  **Documents** (folders + detached upload queue + delete), **Call Log**
  (Add/Edit/Delete), **Email Log** (New / View / Delete + send + preview +
  on-demand `check-replies` button — no auto-poll).
- **Medical Records** placeholder using `ComingSoonPanel` from
  `components/vendor/ui/`.
- Cross-tab refresh via the `useShareRequestEvents(id)` event bus
  (translated 1:1 from monolith `loadTabData` callsites).
- Apply Concurrency & Lifecycle Policy: closure-capture `srId`, global
  toasts, polling cleanup, per-tab state machine, `keepPreviousData`-equiv
  on header.
- **Backend audit (small):** review `GET /api/me/vendor/share-requests`
  list response shape; add a `?fields=summary` projection if it returns
  more than the 7 fields the rail card needs (cf. Performance review).
- Cypress: 1 CRUD smoke spec per heavy tab (Request Details, Bills,
  Ledger, Documents, Notes, Email Log) — 6 specs.

**Deliverable:** functional parity with the monolith for the 10 primary tabs.

#### Phase 3 — Advanced overflow + decommission monolith
- Lift History, Negotiations, FAP, ESS, Work Items, Queues, SMS into
  `tabs/advanced/`. Behind an `Advanced ▾` overflow on the tab bar.
- **Delete `ShareRequestDetail.tsx`** once all references are migrated.
- Final regression sweep: dashboard, queues, call center, member workspace
  → all entry points still hit the new workspace.

**Deliverable:** monolith removed, workspace is the only detail surface.

#### Phase 4 — Medical Records backend (separate ticket, scoped here for traceability)
- New table `oe.share_request_medical_records`:
  `MedicalRecordId, ShareRequestId, TenantId, RequestDate, ReceivedDate,
  Email, FaxNumber, Notes, CreatedAt, CreatedBy, UpdatedAt, UpdatedBy`.
- CRUD endpoints `GET/POST/PUT/DELETE /:id/medical-records` mirroring
  notes/call-logs shape.
- Replace placeholder `MedicalRecordsTab.tsx` with real grid.
- Filed as follow-up issue; **out of scope** for this PR.

## Alternative Approaches Considered

1. **Keep two routes, just restyle.** Rejected — doesn't deliver the
   operator-parity goal (no fast SR-to-SR navigation, no fixed header).
2. **In-place refactor of `ShareRequestDetail.tsx`.** Rejected — leaves a
   5,551-line file; extracting tabs requires a shell anyway.
3. **Drawer-based mobile fallback instead of full-screen.** Rejected — adds
   a new pattern divergent from Members workspace; mobile users are <5% on
   this surface.
4. **Custom tab framework.** Rejected — native HTML + Tailwind suffices,
   matches CLAUDE.md UI rules.

## System-Wide Impact

### Interaction Graph

```
User clicks SR card in rail
  → URL pushed to /vendor/share-requests/:id?tab=<current>
  → useShareRequest(id) refetches
  → Header card re-renders with new payload
  → Active tab component remounts (queryKey changes) and lazy-loads its data

User adds a Bill on Bills tab
  → POST /:id/bills
  → On success: queryClient.invalidateQueries(['shareRequest', id, 'bills'])
                queryClient.invalidateQueries(['shareRequest', id, 'transactions']) // ledger totals
                queryClient.invalidateQueries(['shareRequest', id])                  // header may show totals
```

### Error & Failure Propagation

- Tab-level errors render an in-tab error banner (red; uses
  `text-red-600 hover:bg-red-50` per CLAUDE.md). Header card and rail are
  unaffected — operator can still pick another SR.
- 401/403 from any endpoint bubbles to global Axios interceptor (existing
  behavior; no change).
- Optimistic mutations rolled back on error; React Query handles via
  `onError` rollback handler — pattern already used in Members workspace.

### State Lifecycle Risks

- **Stale tab cache after SR switch.** Mitigation: `queryKey` includes
  `[id]` so switching SR invalidates implicitly.
- **Document upload in flight when SR switches.** Existing upload uses
  `multer` and is per-request — abort on unmount via `AbortController`
  passed to Axios.
- **Add-Bill-then-switch-SR race.** Mutation continues; success toast still
  fires; cache invalidation is keyed by the old `id` so no leakage.
- **Browser back/forward** preserves last-selected tab via
  `?tab=<id>` and `useSearchParams`.

### API Surface Parity

No new backend endpoints land in this slice. The only API change planned
is **Phase 4** (Medical Records CRUD) — separate PR, separate ticket.

| Caller of monolith                           | Behavior under new workspace             |
|----------------------------------------------|------------------------------------------|
| `ShareRequestDashboard.tsx` cards            | Navigate to workspace (URL unchanged)    |
| `ShareRequestQueues.tsx` rows                | Navigate to workspace (URL unchanged)    |
| `MemberShareRequestsTab.tsx` (Members WS)    | Navigate to workspace (URL unchanged)    |
| `VendorCallCenter.tsx` rows                  | Navigate to workspace (URL unchanged)    |
| `ShareRequestNew.tsx` post-create redirect   | Lands on workspace with new SR selected  |

### Integration Test Scenarios

Cypress specs (`frontend/cypress/e2e/vendor-share-requests-workspace.cy.ts`):

1. **Rail → header**: load workspace, type in search, click a card, verify
   header shows correct member name and tab body shows Request Details.
2. **Bills → Ledger sync**: switch to Bills, add a bill, switch to Ledger,
   verify totals row reflects the new bill amount.
3. **Documents folder tree**: add root folder, add subfolder, upload a
   document, verify it appears under the subfolder.
4. **Email send + check-replies**: open Email Log, send a templated email,
   click "Check Replies", verify polling works.
5. **Advanced overflow**: open `Advanced ▾`, click `Work Items`, verify
   work items load.
6. **Mobile fallback (`< md`)**: viewport `iphone-x`, rail-only view, tap
   card, full-screen detail, back button returns to rail.
7. **Medical Records placeholder**: tab clickable, renders ComingSoonPanel,
   no console errors.

## Acceptance Criteria

### Functional Requirements

- [x] `/vendor/share-requests` renders the workspace (rail + empty state).
- [x] `/vendor/share-requests/:id` renders the workspace with that SR
      selected (rail + header + active tab).
- [x] Left rail: search, filter chips (status / determination / type / date
      range), pagination, sticky search input, condensed card layout
      (SW# + R-ref, member + DoB, agent + pencil icon, status, created date).
- [x] Header card: Membership (Name, DoB, Primary, Spouse, Phone, Email),
      Requester (Member ID, Effective, Term Date, Status with green dot),
      Plan (rollup label, UA, Tier).
- [x] Tab bar: 10 primary tabs in order — Request Details, Providers, Bills,
      Ledger, Documents, Plans, Call Log, Email Log, Medical Records, Notes
      — plus trailing `Advanced ▾` overflow with History, Negotiations, FAP,
      ESS, Work Items, Queues, SMS.
- [x] CRUD parity with monolith for all 10 primary tabs (Medical Records
      excluded — placeholder). Notes / Call Log / Bills / Ledger / Documents
      / Email Log / Request Details edit / Providers Add+Delete all lifted.
- [x] `?tab=<id>` query string deep-links into a tab.
- [x] Mobile `< md`: rail-only → full-screen detail with back button.
- [x] `ShareRequestList.tsx` and `ShareRequestDetail.tsx` (5,551 lines) both
      deleted. Workspace is now the only detail surface.

### Non-Functional Requirements

- [x] Tailwind only, `oe-*` brand tokens (no `blue-600`); lucide icons only.
- [x] No Material UI or CSS-in-JS.
- [x] Tab body is lazy — switching tabs triggers data fetch only on first
      visit per session per SR.
- [ ] Heavy tabs lazy via `React.lazy`; primary 3 (Request Details, Bills,
      Documents) prefetched on workspace mount. _(Phase 2 perf opt)_
- [x] All queries filter by TenantId via existing middleware (no bypass).
- [x] Type-checks pass (`npx tsc --noEmit`); lint clean (`npx eslint .`).
- [x] No `LucideIcon` or `any` introduced (see TypeScript Conventions).
- [x] No `setInterval` outlives its tab's unmount (see Concurrency Policy).
- [x] No Email Log auto-poll (on-demand `check-replies` only).
- [x] ARIA roles + keyboard contract from §Accessibility implemented.
      _(roles done; full J/K rail keymap deferred to a small follow-up.)_
- [x] Rail filters and `tab` are URL-synced; default tab omits the param.

### Quality Gates

- [ ] Unit tests for `useShareRequest`, `ShareRequestListRail`,
      `ShareRequestHeaderCard` (vitest, jsdom).
- [ ] 7 Cypress specs above pass headless.
- [ ] Manual regression: every entry point (Dashboard, Queues, Call Center,
      Members workspace, post-create redirect) lands correctly.
- [ ] PR description includes before/after screenshots for at least 5 tabs.

## Success Metrics

- **Code:** `ShareRequestList.tsx` (502 lines) and `ShareRequestDetail.tsx`
  (5,551 lines) deleted. No arbitrary per-file LOC target — measure parity,
  not LOC.
- **Operator velocity:** time-to-switch-between-SRs drops to a single click
  in the rail (no full-page nav).
- **Visual parity:** layout matches the 10 reference screenshots; brand
  tokens preserved.
- **Zero regressions:** all existing CRUD operations continue to work; no
  new 4xx/5xx in App Insights for `/api/me/vendor/share-requests/*` endpoints
  during the week post-merge.
- **Bundle:** initial vendor portal chunk drops measurably (lazy-load all
  tabs except the prefetched primary 3: Request Details, Bills, Documents).
- **Type safety:** `npx tsc --noEmit` is clean; `LucideIcon` and `any`
  introductions blocked in code review.

## Dependencies & Risks

### Dependencies
- Members workspace primitives (`Spinner`, `Skeleton`, `EmptyState`,
  `ComingSoonPanel`) — already shipped on `new-backoffice-portal`.
- React Query (already in use).
- Existing 60+ vendor share-request endpoints.

### Risks

| Risk                                                      | Mitigation                                                                                  |
|-----------------------------------------------------------|---------------------------------------------------------------------------------------------|
| 5,551-line monolith → regressions during decomposition     | Phase 1 ships read-only first; Phase 2 lifts CRUD tab-by-tab; each PR has Cypress smoke    |
| Cross-tab refresh missed (Bills/Ledger/Header)            | Catalog `loadTabData('x')` callsites in the monolith; translate each to an event emission on `useShareRequestEvents(id)`. |
| Mutation-mid-SR-switch causes stale-closure bugs          | Concurrency Policy item 1: closure-capture `srId`; global toasts; refetch via captured id  |
| Documents upload silently lost on SR switch                | Detached upload queue (Concurrency Policy item 3) — uploads survive unmount + report via toast |
| Polling intervals from monolith repaint wrong SR's data   | HIPAA-adjacent. Concurrency Policy item 4: every interval in `useEffect` cleanup; cancel-token check before `setState`. |
| Email Log polling traffic flood                            | On-demand only — no auto-poll. `check-replies` is an explicit button.                      |
| Optimistic rollback invisible after operator switches SR  | Persistent failure toast with click-to-return navigation (Concurrency Policy item 6)       |
| Paradigm divergence with Members (RQ vs apiService)       | Adopt `apiService + AbortController` for parity in this slice; React Query lift is a separate cross-workspace ticket (Future Considerations) |
| Document upload regressions                                | Reuse exact multer endpoint + payload shape; Cypress spec covers upload happy path         |
| Medical Records gap visible to operators                   | Coming-Soon panel explicitly says "Coming soon — backend follow-up #<ticket>"               |
| Header card field gaps for SRs with missing member/plan   | Discriminated state union (`loading / error / ready`); ready data has all-nullable fields rendered as `—` |
| Mobile `< md` differs from Members workspace              | Reuse identical breakpoint + back-button pattern from `VendorMembersWorkspace.tsx`; copy = "Back to share requests" |
| Old detail bookmarks / external links                     | URL is unchanged (`/vendor/share-requests/:id`); no redirect needed                        |
| Rail card re-renders on every SR switch (perf)            | `React.memo` on card with shallow compare on `selected` + `status`                         |
| Documents folder tree slow for SRs with 100+ docs         | Virtualize (`react-arborist` or `FixedSizeList`); fetch by folder via `?folderId=`         |
| Default React Query refetch-on-focus floods backend        | Not applicable in this slice (RQ deferred); when RQ lands, set `refetchOnWindowFocus: false` and per-hook `staleTime` |

## Resource Requirements

- **Engineering:** ~2-3 days for one engineer familiar with Members workspace
  patterns. Phase 1 ≈ 0.5 day, Phase 2 ≈ 1.5 day, Phase 3 ≈ 0.5 day. Phase 4
  is a separate ticket (~1 day backend + 0.5 day frontend).
- **Design:** none — reusing brand tokens + Members workspace patterns.
- **QA:** Cypress smoke specs are part of the deliverable; manual regression
  pass on all entry points.

## Future Considerations

- **React Query lift across both workspaces** (Members + Share Requests in
  one PR). Rationale for this slice using `apiService + AbortController`:
  paradigm parity with Members. Lift is the natural cross-workspace
  follow-up.
- **`WorkspaceListRail<T>` + `WorkspaceHeaderCard` generic primitives** in
  `components/vendor/ui/` once a third workspace appears (Enrollments /
  Households are likely candidates).
- **Backend `/list` summary projection** (7-field response) and `/plan-summary`
  (server-side rollup label) — small follow-up tickets called out by the
  Performance and Agent-Native reviews.

## Documentation Plan

- [ ] Update `ai-context/component-map.md` with the new component tree.
- [ ] Add a learnings note at
      `docs/solutions/refactoring/share-requests-monolith-decomposition.md`
      capturing the Bills↔Ledger invalidation pattern and the Advanced
      overflow decision.
- [ ] Update `memory-bank/activeContext.md` to reflect that
      `ShareRequestDetail.tsx` is gone.
- [ ] Cross-link this plan + brainstorm from PR description.

## Sources & References

### Origin
- **Brainstorm:** [`docs/brainstorms/2026-05-05-vendor-portal-share-requests-split-pane-brainstorm.md`](../brainstorms/2026-05-05-vendor-portal-share-requests-split-pane-brainstorm.md).
  Key decisions carried forward:
  1. Single workspace at `/vendor/share-requests` + `/:id`; collapse list +
     detail into one shell.
  2. 10 primary tabs match legacy screenshots; existing power-user tabs
     hidden behind `Advanced ▾`.
  3. Medical Records ships as placeholder this slice; backend follow-up.

### Internal References
- Sibling pattern: `frontend/src/pages/vendor/VendorMembersWorkspace.tsx` and
  `frontend/src/components/vendor/members/*`.
- Brainstorm sibling: `docs/brainstorms/2026-05-04-vendor-portal-members-split-pane-brainstorm.md`.
- Members plan sibling: `docs/plans/2026-05-04-feat-vendor-portal-members-workspace-plan.md`.
- Monolith to decompose: `frontend/src/pages/vendor/ShareRequestDetail.tsx` (5,551 lines).
- List to retire: `frontend/src/pages/vendor/ShareRequestList.tsx` (502 lines).
- Backend: `backend/routes/me/vendor/share-requests.js` (3,461 lines, 60+ endpoints).
- Routing: `frontend/src/App.tsx:582-586`.
- 18 navigation callsites into `/vendor/share-requests/:id` already enumerated;
  none change.
- CLAUDE.md UI rules + brand tokens.

### Related Work
- PR introducing Members workspace (current branch `new-backoffice-portal`).
- Cypress sibling spec: `frontend/cypress/e2e/vendor-members-workspace.cy.ts`.

### Deepen-Plan Inputs (2026-05-05)
- **Learnings consulted:** `docs/solutions/build-errors/lucide-react-icon-type-import.md` —
  `IconComponent` lifted to `frontend/src/types/icon.ts` per the third-site rule.
- **Review agents:** Kieran TypeScript, Frontend Races (Julik), Code
  Simplicity, Pattern Recognition, Performance Oracle, Agent-Native Parity.
- **External research:** TanStack Query v5 invalidation/cancellation/optimistic-update
  patterns; React Router v6 `useSearchParams` functional updater; W3C APG
  Listbox / Tabs / Disclosure / Window Splitter patterns; web.dev
  code-splitting guidance.

## MVP File Outline

### `frontend/src/pages/vendor/ShareRequestWorkspace.tsx`
```tsx
// Shell: rail + (header + tabs | empty state). Reads `:id` and `?tab=`.
// Hooks: useShareRequestsList (rail), useShareRequest(id) (header + tabs),
// useNavigate, useSearchParams. Renders <ShareRequestListRail> + right pane.
// On `< md`, renders rail-only when no `:id`, full-screen detail when `:id`.
```

### `frontend/src/components/vendor/share-requests/ShareRequestListRail.tsx`
```tsx
// Sticky search + filter chips + paginated list of cards. Lift from
// ShareRequestList.tsx. Card = SW# + R-ref + member name + DoB + agent +
// status + created date. Selected card highlighted with oe-light bg + border.
```

### `frontend/src/components/vendor/share-requests/ShareRequestHeaderCard.tsx`
```tsx
// 3-col card: Membership (Name, DoB, Primary, Spouse, Phone, Email),
// Requester (Member ID, Effective, Term Date, Status), Plan (label, UA, Tier).
// Always visible. Skeleton state when loading.
```

### `frontend/src/components/vendor/share-requests/ShareRequestWorkspaceTabs.tsx`
```tsx
// Renders the 10 primary tab buttons + trailing Advanced ▾ overflow that
// reveals 7 advanced tabs (History, Negotiations, FAP, ESS, Work Items,
// Queues, SMS). Active tab synced to ?tab= query string.
```

### `frontend/src/components/vendor/share-requests/tabs/<TabName>Tab.tsx` (10 files)
```tsx
// One per primary tab. Owns its own React Query hook + mutations.
// Lifts the corresponding section out of ShareRequestDetail.tsx.
```

### `frontend/src/components/vendor/share-requests/tabs/advanced/<TabName>Tab.tsx` (7 files)
```tsx
// Same pattern, lifted as-is from existing ShareRequest*Tab components in
// `components/shareRequest/`.
```

### `frontend/cypress/e2e/vendor-share-requests-workspace.cy.ts`
```ts
// 7 specs as enumerated in Integration Test Scenarios.
```

### `frontend/src/App.tsx` (small edit)
```tsx
// Replace ShareRequestList + ShareRequestDetail imports with
// ShareRequestWorkspace. Both routes (`share-requests` and `share-requests/:id`)
// resolve to the workspace.
```

### Removed
- `frontend/src/pages/vendor/ShareRequestList.tsx` (deleted in Phase 1 end).
- `frontend/src/pages/vendor/ShareRequestDetail.tsx` (deleted at end of Phase 3).

## Open Questions

_None — all brainstorm questions resolved. Proceed to `/ce:work` when ready._
