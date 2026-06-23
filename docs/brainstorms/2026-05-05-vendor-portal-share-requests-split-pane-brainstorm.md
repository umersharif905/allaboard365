---
title: Vendor Portal — Share Requests Split-Pane Workspace
date: 2026-05-05
scope: frontend-primary (one backend gap: medical-records)
status: draft
---

# Vendor Portal Share Requests — Split-Pane Workspace

## What We're Building

Restructure the vendor portal **Share Requests** experience from the current
list (`ShareRequestList.tsx`) + monolithic 5,551-line detail
(`ShareRequestDetail.tsx`) into a single **split-pane workspace** that mirrors
the reference screenshots, while keeping our modern Tailwind / `oe-*` brand
styling (not the dated navy/sky blue look of the legacy reference).

This is the direct sibling of the Members workspace already shipped on
`new-backoffice-portal` (see `2026-05-04-vendor-portal-members-split-pane-
brainstorm.md`) and re-uses the same shell pattern.

**Reference layout (from screenshots):**
- **Left rail (~320px):** sticky "Search Share Requests" input on top, scrollable
  list of share-request cards. Each card shows:
  - Request number (e.g. `SW8879419`) + Reference (`R-68c32a2`) on top row
  - Member name + DoB (e.g. `DUKE BENDER · 10-24-2020`)
  - Pencil icon + Agent name (e.g. `Duke`)
  - `Status: New`
  - `Created Date: 05-04-2026`
  Selected card highlighted with brand accent.

- **Right pane header (3 columns, always visible):**
  - **Membership:** Name, DoB, Primary Name, Spouse Name, Phone, Email
  - **Requester:** Member ID, Effective, Term Date, Status (with green dot)
  - **Plan:** Family/UA/Tier rollup (`Family $3000 UA · UA · Tier: EF`)

- **Tab bar (right pane, below header):**
  `Request Details | Providers | Bills | Ledger | Documents | Plans | Call Log | Email Log | Medical Records | Notes`

- **Per-tab content (right pane body):**
  - **Request Details** — read/edit form: Request Type, Status, Determination,
    Disposition, Visit Type, Phase, Reasons (multi-select), Negotiations
    (Y/N), Resolutions, Eligible Date(s). Footer: `Cancel Changes` /
    `Save Changes`.
  - **Providers** — table (Type, Company, First Name, Last Name, Email, Phone)
    with `Add Provider` / `Delete Provider`.
  - **Bills** — provider grid on top + bills grid below (Bill ID, Bill Name,
    Account #, Date of Service, Amount, Notes) + totals strip
    ("Selected Provider — Total Bills" / "Total Bills"). Buttons:
    `Add Bill` / `Delete Bill`.
  - **Ledger** — Provider + Bill filters; transactions grid (Transaction Date,
    Type, Payment Type, Status, Transaction Number); totals strip
    (UA Amount, Total UA Paid, UA Reduction, Balance, Bill Amount, UA Payment,
    Reimbursement, Total Discounts, Payments to Provider, Member Payment,
    Balance). Buttons: `Add / Edit / Delete Transaction`.
  - **Documents** — folder tree (root folder + sub-folders) with
    `Add Root Folder` / `Add Subfolder` / `Add Document`.
  - **Plans** — read-only grid: Product Name, Tier, UA, Effective Date,
    Termination Date.
  - **Call Log** — grid (Phone Number, Direction, Start, End, Notes) +
    `Add / Edit / Delete Call`.
  - **Email Log** — grid (Email Date, To, Subject, Emailed By, Template) +
    `New Email / View Email / Delete Email`.
  - **Medical Records** — grid (Request Date, Received Date, Email, Fax
    Number) + `Add / Edit`.
  - **Notes** — grid (Type, Note, Date, Created By) + `Add / Edit / Delete
    Note`.

**What stays the same (UI/UX improvements):**
- Tailwind only, `oe-primary` / `oe-light` / `oe-dark` brand tokens, lucide
  icons.
- Cards: `bg-white rounded-lg border border-gray-200`.
- No raw `blue-600`. No Material UI.
- Modern field styling (rounded inputs, proper focus rings) — **not** the
  pill-shaped gray inputs from the legacy screenshots.

## Why This Approach

- **Operator parity.** Matches the legacy screen muscle memory (one screen,
  swap between requests fast — no full-page nav per click).
- **Consolidation.** Replaces a 5,551-line monolith with a thin shell + 10
  focused tab components, mirroring the Members workspace pattern. Code reuse
  for the rail, header card, tab bar, and empty/skeleton primitives.
- **Backend already exists.** All 10 tabs (except Medical Records) map 1:1 to
  endpoints already shipped on
  `backend/routes/me/vendor/share-requests.js`:
  - `GET/POST/PUT /:id` → Request Details
  - `/:id/providers` → Providers
  - `/:id/bills` → Bills
  - `/:id/transactions` → Ledger
  - `/:id/documents` (+ upload) → Documents
  - `/:id/member-plans` → Plans
  - `/:id/call-logs` → Call Log
  - `/:id/emails` (+ send/preview) → Email Log
  - `/:id/notes` → Notes

  Only **Medical Records** has no backend yet — ship as a placeholder shell
  this slice, file follow-up for endpoint + table.

## Key Decisions

1. **Single route with selection state.** Use `/vendor/share-requests` as the
   workspace route; selecting a request updates the URL to
   `/vendor/share-requests/:id`. Direct deep-links still work — the rail loads
   + auto-selects.
2. **Left rail = current `ShareRequestList`, condensed.** Drop the table
   columns; keep request number, reference, member name + DoB, agent, status,
   created date in a compact card. Search + filter chips + pagination stay on
   the rail. Empty/loading states preserved.
3. **Right pane = decomposed `ShareRequestDetail`.** Lift the existing tabs
   (`summary/plans/bills/transactions/providers/documents/notes/history` plus
   negotiations/FAP/ESS/work-items/queues) into per-tab components; the visible
   10-tab set in the screenshots becomes the **primary surface**, while the
   power-user tabs (negotiations / FAP / ESS / work-items / queues / history)
   move behind an "Advanced" affordance (overflow menu or secondary row) to
   avoid losing existing functionality.
4. **Medical Records = placeholder.** Ship the tab with a styled "Coming soon"
   panel matching the brand. File a follow-up ticket for schema +
   `/api/me/vendor/share-requests/:id/medical-records` endpoints.
5. **Header card = always visible.** The 3-column Membership / Requester /
   Plan header sits above the tab bar and stays fixed while the tab body
   scrolls. Sourced from the same `ShareRequestService.getShareRequestById`
   payload already returned today.
6. **Responsive fallback.** On `< md`, collapse to mobile view: rail-only list
   page → tap card → full-screen detail with back button. No drawer variant
   this slice.
7. **No new backend endpoints (except Medical Records ticket).** Reuse
   existing 60+ endpoints. New tab components are wrappers around existing
   data hooks.
8. **Brand tokens, not screenshot palette.** Screenshots dictate **layout
   proportions only** — we keep `oe-primary` accents and current typography.

## Component Sketch

```
pages/vendor/ShareRequestWorkspace.tsx          (workspace shell)
  └─ components/vendor/share-requests/
       ├─ ShareRequestListRail.tsx              (search + paginated list, selectable)
       ├─ ShareRequestHeaderCard.tsx            (3-col Membership / Requester / Plan)
       ├─ ShareRequestWorkspaceTabs.tsx         (primary tab bar + overflow)
       ├─ tabs/RequestDetailsTab.tsx            (lift from monolith summary section)
       ├─ tabs/ProvidersTab.tsx                 (lift)
       ├─ tabs/BillsTab.tsx                     (lift, includes provider grid + totals)
       ├─ tabs/LedgerTab.tsx                    (was 'transactions')
       ├─ tabs/DocumentsTab.tsx                 (lift, folder tree)
       ├─ tabs/PlansTab.tsx                     (lift, read-only)
       ├─ tabs/CallLogTab.tsx                   (lift)
       ├─ tabs/EmailLogTab.tsx                  (lift)
       ├─ tabs/MedicalRecordsTab.tsx            (placeholder — Coming Soon)
       ├─ tabs/NotesTab.tsx                     (lift, drop SMS sub-tab into overflow)
       └─ advanced/
            ├─ HistoryTab.tsx                   (lift)
            ├─ NegotiationsTab.tsx              (lift)
            ├─ FAPTab.tsx                       (lift)
            ├─ ESSTab.tsx                       (lift)
            ├─ WorkItemsTab.tsx                 (lift)
            └─ QueuesTab.tsx                    (lift)
```

`ShareRequestDetail.tsx` is removed once content is migrated. Old route
`/vendor/share-requests/:id` redirects into the workspace with that request
selected. `ShareRequestList.tsx` becomes the empty-state index of the
workspace.

## Out of Scope (this slice)

- Wiring up Medical Records data (tab is a placeholder; backend follow-up).
- Any other backend endpoint, schema, or service changes.
- Bulk actions, column customization, saved filters beyond what
  `ShareRequestList` already exposes.
- Revisiting the dashboard (`ShareRequestDashboard.tsx`) — that page stays as
  is, but its links route into the new workspace.
- Cypress coverage for placeholder Medical Records tab; smoke specs added for
  Request Details / Providers / Bills / Ledger / Notes (the load-bearing
  tabs).

## Resolved Questions

1. **URL strategy → nested route.** `/vendor/share-requests` (index, empty
   state) + `/vendor/share-requests/:id` (selected). `App.tsx` updated; old
   detail route 301s into workspace.
2. **Where do power-user tabs go?** Behind an "Advanced" overflow on the tab
   bar so the primary 10-tab surface matches the screenshots, but
   negotiations / FAP / ESS / work-items / queues / history stay reachable.
3. **Medical Records → placeholder this slice**, with a Coming-Soon panel and
   a follow-up backend ticket (schema + CRUD endpoints).
4. **Mobile breakpoint → keep current full-page detail behavior on `< md`.**
   Rail-only list page → tap card → full-screen detail with back button. No
   drawer variant this slice.
5. **Persistence → no persistence.** Workspace always opens with no selection.
   Deep-links via `/vendor/share-requests/:id` handle resume.
6. **Header card data → reuse existing detail payload.** No new joins; the
   `getShareRequestById` response already contains member + plan + requester
   fields used today in the monolith's header section.

## Open Questions

_None at this time — proceed to planning._
