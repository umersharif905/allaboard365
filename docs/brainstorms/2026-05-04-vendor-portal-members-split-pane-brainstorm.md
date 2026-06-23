---
title: Vendor Portal — Members Split-Pane Workspace
date: 2026-05-04
scope: frontend-only
status: draft
---

# Vendor Portal Members — Split-Pane Workspace

## What We're Building

Restructure the vendor portal **Members** experience from two separate pages
(`VendorMembers.tsx` list table + `VendorMemberDetail.tsx` detail page) into a
single **split-pane workspace** that mirrors the layout of the reference
screenshot, while keeping our modern Tailwind / `oe-*` brand styling (not the
dated blue/gray look of the reference).

**Reference layout (from screenshot):**
- **Left rail (~320px):** sticky search input on top, scrollable list of member
  cards. Each card shows Member ID (top-right, muted) + First Name + Last Name
  stacked. Selected card highlighted with brand accent.
- **Right pane:** tab bar across the top with these tabs:
  `Details | Household | Plans | New Request | Call Log | Email Log | Notes | Documents | Share Requests`
- **Active tab content:** fills the right pane. `Details` shows the read-only
  member form (Member ID, First/Last Name, Email, Phone, DoB, Relationship,
  Gender, Address, City, State, Zip).
- Footer action on Details: `Search All Members` (clears selection / opens
  full search).

**What stays the same (UI/UX improvements):**
- Tailwind only, `oe-primary` / `oe-light` / `oe-dark` brand tokens, lucide icons.
- Cards: `bg-white rounded-lg border border-gray-200`.
- No raw `blue-600`. No Material UI.
- Modern field styling (rounded inputs, proper focus rings) — **not** the
  pill-shaped gray inputs from the screenshot.

## Why This Approach

- Matches the operator's mental model from the legacy system (one screen, swap
  between members fast — no full-page navigation per click).
- Consolidates two routes/components into one workspace, reducing duplicated
  data-fetching patterns.
- Adds the missing tabs the legacy app exposed (Household, New Request, Call
  Log, Email Log, Notes, Documents) as **placeholder shells** so the layout is
  in place before each module is wired up.

## Key Decisions

1. **Single route with selection state.** Use `/vendor/members` as the
   workspace route; selecting a member updates the URL to
   `/vendor/members/:id` (or `?member=:id`). Direct deep-links still work —
   the left rail loads + auto-selects.
2. **Left rail = current `VendorMembers` list, condensed.** Drop the table
   columns; keep only ID + Name in a compact card. Search + pagination stay
   on the rail. Empty/loading states preserved.
3. **Right pane = current `VendorMemberDetail` upgraded.** Existing `Plans`
   and `Share Requests` tabs keep their wiring. Add new tabs as shells with
   "Coming soon" placeholders matching the brand. `Details` becomes the
   default tab and shows the member info that today lives in the detail page
   header.
4. **Responsive fallback.** On `< md`, collapse to mobile view: rail-only
   list page → tap member → full-screen detail with back button (essentially
   today's behavior). Avoids re-doing mobile.
5. **No backend changes.** Reuse existing endpoints
   (`/api/me/vendor/members`, `/api/me/vendor/members/:id`,
   `/api/me/vendor/share-requests/member-plans/:id`, etc.). New tabs render
   placeholders only — no new API contracts in this slice.
6. **Brand tokens, not screenshot palette.** The screenshot's navy/sky styling
   is reference for **layout proportions only**. We keep `oe-primary` accents
   and current typography.

## Component Sketch

```
pages/vendor/VendorMembers.tsx          (becomes the workspace shell)
  └─ components/vendor/members/
       ├─ MemberListRail.tsx            (search + paginated list, selectable)
       ├─ MemberWorkspaceTabs.tsx       (tab bar)
       ├─ tabs/MemberDetailsTab.tsx     (read-only member form)
       ├─ tabs/MemberHouseholdTab.tsx   (placeholder)
       ├─ tabs/MemberPlansTab.tsx       (lift from VendorMemberDetail)
       ├─ tabs/MemberNewRequestTab.tsx  (placeholder / link to existing flow)
       ├─ tabs/MemberCallLogTab.tsx     (placeholder)
       ├─ tabs/MemberEmailLogTab.tsx    (placeholder)
       ├─ tabs/MemberNotesTab.tsx       (placeholder)
       ├─ tabs/MemberDocumentsTab.tsx   (placeholder)
       └─ tabs/MemberShareRequestsTab.tsx (lift from VendorMemberDetail)
```

`VendorMemberDetail.tsx` is removed once content is migrated. Old route
`/vendor/members/:id` redirects into the workspace with that member selected.

## Out of Scope (this slice)

- Wiring up Household / Call Log / Email Log / Notes / Documents data —
  placeholders only.
- Any backend endpoint, schema, or service changes.
- Bulk actions, filtering beyond current search, column customization.
- Cypress coverage for placeholder tabs (only Details + Plans + Share
  Requests get smoke specs updated).

## Resolved Questions

1. **URL strategy → nested route.** `/vendor/members` (index, empty-state) +
   `/vendor/members/:id` (member selected). Update `App.tsx` accordingly.
2. **"New Request" tab → navigate to existing `ShareRequestNew`** pre-filled
   with the selected member's context. No duplicate form.
3. **Placeholder tabs → show with "Coming soon" panel.** All tabs visible for
   legacy parity; unbuilt tabs render a styled empty state.
4. **Persistence → no persistence.** Workspace always starts with no
   selection on a fresh load. Deep-links via URL handle resume cases.
5. **Mobile breakpoint → keep current full-page detail behavior on `< md`.**
   Rail-only list page → tap member → full-screen detail with back button.
   No drawer variant in this slice.
