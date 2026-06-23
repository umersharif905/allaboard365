---
title: Vendor Portal Members Split-Pane Workspace
type: feat
status: completed
date: 2026-05-04
origin: docs/brainstorms/2026-05-04-vendor-portal-members-split-pane-brainstorm.md
scope: frontend-only
---

# feat: Vendor Portal Members Split-Pane Workspace

## Overview

Restructure the vendor portal `Members` experience from two separate pages
(`VendorMembers.tsx` list + `VendorMemberDetail.tsx` detail) into a **single
split-pane workspace**. Layout (left rail = searchable member list, right
pane = tabbed detail with `Details | Household | Plans | New Request | Call
Log | Email Log | Notes | Documents | Share Requests`) mirrors the legacy
reference screenshot. Visual styling stays on our brand tokens (`oe-primary`
/ `oe-light` / `oe-dark`, lucide icons, Tailwind only) — **layout parity, not
look-and-feel parity** (see brainstorm: `docs/brainstorms/2026-05-04-vendor-portal-members-split-pane-brainstorm.md`).

Frontend-only. No backend, schema, or API contract changes.

## Problem Statement / Motivation

Today's vendor Members surface forces a full route navigation per member
(`/vendor/members` → row click → `/vendor/members/:id`). Operators triaging
multiple members lose context on every click and can't quickly compare or
hop between members. The legacy system used a workspace pattern they
remember; rebuilding to that mental model removes friction and unblocks
adding the missing operational tabs (Household, Notes, Documents, Call/
Email Log) that already exist in the legacy app.

## Proposed Solution

A workspace shell at `/vendor/members` with two regions:

- **Left rail (~320px sticky):** sticky search input on top, scrollable list
  of compact member cards (avatar bubble + name + Member ID + relationship
  pill). Selected card highlighted with `bg-oe-light` + left accent bar.
  Pagination footer stays.
- **Right pane:** tab bar across the top (9 tabs), active-tab content fills
  the rest. Empty state when no member is selected.

Selecting a member updates the URL to `/vendor/members/:id` (nested route per
brainstorm decision). Active tab is tracked via `?tab=<key>` query param to
keep `App.tsx` route surface flat (see "Key Decisions" below). Direct
deep-links (e.g., `/vendor/members/abc?tab=plans`) work — list rail loads,
selected member is highlighted if visible on the current page.

`VendorMemberDetail.tsx` is removed; its `Plans` and `Share Requests` tabs
are lifted into the workspace verbatim. Five new tabs (`Household`,
`Call Log`, `Email Log`, `Notes`, `Documents`) ship as styled "Coming soon"
placeholders so the layout matches legacy parity from day one (see
brainstorm: resolved question #3). The `New Request` tab is a passthrough
that calls `navigate('/vendor/share-requests/new?memberId=...')` — requires a
small enabling change to `ShareRequestNew.tsx` (currently ignores the query
param; see brainstorm: resolved question #2 + research finding #5).

## Technical Considerations

### Architecture

- **Route shape (App.tsx:564–595):** keep flat. Replace existing two routes:
  ```tsx
  <Route path="members" element={<VendorMembersWorkspace />} />
  <Route path="members/:id" element={<VendorMembersWorkspace />} />
  ```
  Same component handles both — `useParams<{id?:string}>()` drives whether
  the right pane shows the empty state or a selected member. No App.tsx
  redirects required because the URL surface stays the same.
- **Tab state** lives in `?tab=` query param via `useSearchParams`. Default
  = `details`. Keeps App.tsx untouched and matches the precedent at
  `frontend/src/pages/vendor/ShareRequestList.tsx:35`.
- **No shared Tabs primitive exists** in the codebase (research finding
  #4). Mirror the inline tab style from `VendorMemberDetail.tsx:317–347`
  (`border-b-2 border-oe-primary text-oe-primary`) — do **not** introduce a
  new abstraction in this slice; YAGNI.
- **No React Query migration** in this slice. Existing `apiService` + local
  state pattern is preserved across the lift to keep the diff scoped to
  layout. Migration to React Query is a follow-up.
- **Mobile (`< md`):** keep current full-page behavior. On `/vendor/members`
  show rail only (no right pane). On `/vendor/members/:id` show detail
  only with a back button (`hidden md:block` for the rail, `block md:hidden`
  for the back button). No drawer variant — see brainstorm: resolved
  question #5.

### File layout

```
frontend/src/pages/vendor/
  VendorMembersWorkspace.tsx        (NEW — replaces VendorMembers.tsx; routes both /vendor/members and /vendor/members/:id)
  VendorMembers.tsx                 (DELETE)
  VendorMemberDetail.tsx            (DELETE — content lifted into tabs)

frontend/src/components/vendor/members/
  MemberListRail.tsx                (NEW — search + paginated list, selectable, mobile rail-only)
  MemberWorkspaceTabs.tsx           (NEW — tab bar with 9 tabs + Outlet-style child render)
  MemberWorkspaceEmptyState.tsx     (NEW — "Select a member to view details")
  MemberWorkspaceMobileBack.tsx     (NEW — back button shown md:hidden when :id present)
  tabs/MemberDetailsTab.tsx         (NEW — read-only member info form; default tab)
  tabs/MemberHouseholdTab.tsx       (NEW — placeholder)
  tabs/MemberPlansTab.tsx           (NEW — lifted from VendorMemberDetail Plans block)
  tabs/MemberNewRequestTab.tsx      (NEW — auto-navigates to ShareRequestNew with memberId)
  tabs/MemberCallLogTab.tsx         (NEW — placeholder)
  tabs/MemberEmailLogTab.tsx        (NEW — placeholder)
  tabs/MemberNotesTab.tsx           (NEW — placeholder)
  tabs/MemberDocumentsTab.tsx       (NEW — placeholder)
  tabs/MemberShareRequestsTab.tsx   (NEW — lifted from VendorMemberDetail Share Requests block)
  ComingSoonPanel.tsx               (NEW — shared placeholder body for unbuilt tabs)
```

### Pseudo-code anchors

```tsx
// VendorMembersWorkspace.tsx
const { id } = useParams<{ id?: string }>();
const [searchParams, setSearchParams] = useSearchParams();
const activeTab = (searchParams.get('tab') as TabKey) ?? 'details';
const selectMember = (memberId: string) =>
  navigate(`/vendor/members/${memberId}?tab=${activeTab}`);

return (
  <div className="flex h-[calc(100vh-Xpx)]">
    <MemberListRail
      selectedId={id}
      onSelect={selectMember}
      className={id ? 'hidden md:flex' : 'flex'}
    />
    <main className={`flex-1 ${id ? 'flex' : 'hidden md:flex'} flex-col`}>
      {id ? (
        <MemberWorkspaceTabs memberId={id} activeTab={activeTab} onTabChange={...} />
      ) : (
        <MemberWorkspaceEmptyState />
      )}
    </main>
  </div>
);
```

```tsx
// MemberWorkspaceTabs.tsx — only render the active tab's body (no eager fetching)
{activeTab === 'details' && <MemberDetailsTab memberId={memberId} />}
{activeTab === 'plans'   && <MemberPlansTab memberId={memberId} />}
// ... etc
```

```tsx
// MemberNewRequestTab.tsx — passthrough; immediate redirect on mount
useEffect(() => {
  navigate(`/vendor/share-requests/new?memberId=${memberId}`, { replace: true });
}, [memberId]);
return <ComingSoonPanel title="Opening new share request..." />;
```

### Required enabling change to `ShareRequestNew.tsx`

Currently ignores any URL params (research finding #5). Add:
```tsx
const [params] = useSearchParams();
const prefillMemberId = params.get('memberId');

useEffect(() => {
  if (!prefillMemberId) return;
  // call existing selectHousehold(...) once household for this memberId is fetched
}, [prefillMemberId]);
```
This is a thin prereq, not a rewrite of `ShareRequestNew`.

### Performance

- Right pane only fetches data for the **active tab**. Switching tabs does
  not refetch already-loaded data within the same selection (component-
  local cache; React Query migration is a follow-up).
- Rail keeps existing 25/page default + 300ms debounce (`VendorMembers.tsx:48–63`).
- Switching members aborts in-flight per-tab requests (use `AbortController`).

### Security

- No new endpoints. All data reads continue through `/api/me/vendor/...`
  which already enforces vendor scoping. Tenant isolation unchanged.
- Tab visibility for `Share Requests` keeps the existing feature-flag probe
  (`/api/me/vendor/share-requests/dashboard`) — hide tab if disabled.

### Accessibility

- Tab bar: `role="tablist"`, each tab `role="tab"`, `aria-selected`,
  `aria-controls`. Tab panels `role="tabpanel"`.
- List rail items become `<button type="button">` (currently `<div onClick>`
  in `VendorMembers.tsx:204–207`) so keyboard users can tab through.
- `aria-current="true"` on the selected member card.
- Focus rings preserved (`focus:ring-2 focus:ring-oe-primary`).

## System-Wide Impact

- **Interaction graph:**
  `MemberListRail` selection → `useNavigate` → URL `:id` change →
  `VendorMembersWorkspace` re-renders → mounts/refocuses
  `MemberWorkspaceTabs` → active tab body fetches its own data via
  `apiService`. No callbacks/middleware/observers fire.
- **Error propagation:** Per-tab failures stay scoped to their panel (each
  tab owns its loading/error state). Rail errors keep current toast/console
  behavior. Right-pane error in one tab does not blank the rail or other
  tabs.
- **State lifecycle risks:** Rapid member-switching could race in-flight
  requests for the previous member. Mitigation: each tab uses
  `AbortController` keyed on `memberId`. No persistent client-side state to
  orphan (no localStorage by decision).
- **API surface parity:** Same vendor REST endpoints. The `Plans` and
  `Share Requests` tabs use exactly the same endpoints as `VendorMember
  Detail.tsx` does today. `ShareRequestNew` gains optional `?memberId=`
  support — backward compatible.
- **Integration test scenarios** (Cypress):
  1. Select member from rail → URL becomes `/vendor/members/:id?tab=details`
     → details form populated.
  2. Switch tabs via tab bar → URL `?tab=` updates → only active tab body
     visible.
  3. Direct deep-link to `/vendor/members/<unknown-id>?tab=plans` → rail
     loads, right pane shows error empty state, no app crash.
  4. On mobile viewport, rail-only on `/vendor/members`, full-screen detail
     with back button on `/vendor/members/:id`.
  5. Click `New Request` tab → navigates to `/vendor/share-requests/new?
     memberId=...` with the household + member pre-selected.

## Acceptance Criteria

### Functional

- [x] `/vendor/members` renders the workspace shell with rail visible and
      right pane showing the empty state.
- [x] `/vendor/members/:id` renders the workspace with that member selected
      and the `Details` tab active by default.
- [x] All 9 tabs render in the order: `Details, Household, Plans, New
      Request, Call Log, Email Log, Notes, Documents, Share Requests`.
- [x] `Details` tab shows: Member ID, First Name, Last Name, Email, Phone,
      DoB, Relationship (label, not raw code), Gender, Address, City,
      State, Zip — all read-only.
- [x] `Plans` tab fetches `/api/me/vendor/share-requests/member-plans/:id`
      and renders identically to the existing detail page.
- [x] `Share Requests` tab is hidden when the feature-flag probe to
      `/api/me/vendor/share-requests/dashboard` returns 404/disabled.
- [x] `New Request` tab navigates with `replace: true` to
      `/vendor/share-requests/new?memberId=:id`.
- [x] `ShareRequestNew.tsx` reads `?memberId=` from URL and pre-selects
      that member in its existing two-step flow.
- [x] Placeholder tabs (`Household`, `Call Log`, `Email Log`, `Notes`,
      `Documents`) render a styled `ComingSoonPanel` with tab name + lucide
      icon.
- [x] Selecting a member updates the URL via `navigate(...)` (preserves
      browser back/forward).
- [x] Switching tabs updates `?tab=` query param (preserves browser back/
      forward).
- [x] Search query and pagination state persist across member selection
      changes.
- [x] List rail items are `<button>` elements; keyboard `Tab` + `Enter`
      selects a member.
- [x] Old `VendorMembers.tsx` and `VendorMemberDetail.tsx` files are
      deleted; no dead imports remain.

### Non-functional

- [x] No raw Tailwind blues for interactive elements — all use `oe-*` brand
      tokens. (Existing relationship-pill `bg-blue-100/bg-purple-100` may
      stay if treated as semantic status colors, but interactive controls
      use `oe-primary`.)
- [x] No Material-UI, no CSS-in-JS, no inline styles. Tailwind + lucide
      only (CLAUDE.md UI rule).
- [x] Tab bar uses `role="tablist"` / `role="tab"` / `aria-selected` /
      `aria-controls`. Selected list item uses `aria-current="true"`.
- [x] Mobile (`< md`): rail-only on no-selection, detail-only on selection,
      back button visible.
- [x] Per-tab loading states (skeletons) preserved from existing detail
      page where applicable; `ComingSoonPanel` has no spinner.

### Quality gates

- [x] `npx tsc --noEmit` passes.
- [x] `npx eslint .` passes in `frontend/`.
- [x] `npx vitest run` passes; new unit covers tab routing + empty state.
- [x] One new Cypress spec `frontend/cypress/e2e/vendor-members-workspace.cy.ts`
      covering scenarios 1–4 above (scenario 5 covered by an existing
      `ShareRequestNew` spec extension).

## Success Metrics

- Operators can switch between members **without a full page navigation**
  (visual confirmation: rail stays mounted, no route-level loading shimmer).
- Time from "click member A" → "see member A details" measured in render
  cycles, not network round-trips for the rail.
- No regression in `/api/me/vendor/members*` request volume — same calls,
  same shapes.

## Dependencies & Risks

- **Risk: ShareRequestNew prefill brittleness.** The household → member
  two-step state machine in `ShareRequestNew.tsx` was not designed for
  external prefill. Mitigation: make the prefill effect a no-op if the
  household lookup fails, and fall back to the empty flow. Add a Cypress
  case for the missing-household path.
- **Risk: viewport height assumptions.** `flex h-[calc(100vh-Xpx)]` for the
  workspace requires knowing the `VendorLayout` header offset. Mitigation:
  measure once from `VendorLayout.tsx`; if it changes per breakpoint, use
  `min-h-0` + flex children rather than hard-coded vh.
- **Risk: feature-flag probe race.** `Share Requests` tab visibility flips
  after the dashboard probe resolves. Mitigation: render the tab in a
  loading/skeleton state until the probe settles, then either keep or
  hide. Don't blank-flash the tab bar.
- **Dependency: none external.** No new packages, no API contract changes,
  no schema migrations.

## Open Questions (resolve before / during implementation)

1. **`Search All Members` button from the screenshot** — drop entirely (its
   role is duplicated by the rail search), or keep as a "clear selection"
   button that routes back to `/vendor/members`? **Recommendation: drop**
   for cleaner UX; revisit if operators report missing it.
2. **Selected member not in current rail page** — when a deep-link selects
   a member who isn't on the currently loaded list page, do we (a) leave
   the rail unchanged with no highlight, or (b) auto-navigate the rail to
   the page containing that member? **Recommendation: (a)** — simpler,
   avoids extra fetch; rail still works for "find next" workflow.
3. **Tab body lazy-loading vs eager mount** — render only the active tab
   (chosen above) means switching tabs always re-fetches if data is local
   to the tab. Acceptable for v1; React Query migration solves later.

## Sources & References

### Origin

- **Brainstorm:** [docs/brainstorms/2026-05-04-vendor-portal-members-split-pane-brainstorm.md](../brainstorms/2026-05-04-vendor-portal-members-split-pane-brainstorm.md). Carried-forward decisions: split-pane layout with `oe-*` brand styling (not screenshot palette); nested route `/vendor/members/:id`; show all 9 tabs with placeholders; `New Request` passthrough to existing `ShareRequestNew`; no localStorage persistence; mobile keeps full-page detail.

### Internal references

- `frontend/src/pages/vendor/VendorMembers.tsx` — current list page (322L; debounced search, pagination, member card style).
- `frontend/src/pages/vendor/VendorMemberDetail.tsx:56` — `activeTab` state pattern.
- `frontend/src/pages/vendor/VendorMemberDetail.tsx:317–347` — tab bar style to mirror.
- `frontend/src/pages/vendor/VendorMemberDetail.tsx:59–115` — `loadMember()` API sequence + feature-flag probe.
- `frontend/src/pages/vendor/VendorMemberDetail.tsx:260` — existing `?memberId=` link to `ShareRequestNew`.
- `frontend/src/pages/vendor/ShareRequestNew.tsx:50–56,187–225` — two-step household → member flow that needs prefill support.
- `frontend/src/pages/vendor/ShareRequestList.tsx:35` — `useSearchParams` precedent for tab state.
- `frontend/src/App.tsx:564–595` — vendor route tree; lines 591–592 are the routes being replaced.
- `frontend/src/components/vendor/VendorLayout.tsx:58–78` — sidebar + `<Outlet/>` shell.
- `frontend/src/components/vendor/VendorNavigation.tsx:77–82` — Members nav item; active state owned by `SideNavigation`.
- `frontend/src/components/common/SideNavigation.tsx` — verifies prefix-match keeps "Members" highlighted on `/vendor/members/:id`.
- `CLAUDE.md` — UI rules (Tailwind only, lucide only, `oe-*` tokens, no raw blues for interactives).

### External references

None — local patterns are sufficient.

### Related work

- No prior PRs identified. No prior brainstorms or plans on vendor Members
  workspace. This plan establishes the split-pane precedent for the
  codebase.
