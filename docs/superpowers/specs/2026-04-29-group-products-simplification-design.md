# Group Products Tab Simplification

**Date:** 2026-04-29
**Branch:** `group-updates/hide-clearity`
**Author:** Joey (designed via brainstorming with Claude)

## Problem

The Group Products tab (`frontend/src/pages/groups/GroupProductsTab.tsx`) presents two sources of confusion to agents and group admins:

1. **ASA signature pills are noisy.** Each product row shows its own "Signed / Pending / No ASA Required" badge, with per-product "Sign Now" buttons. In reality, many products share the same ASA document — signing one document covers all products that reference it. The per-row display creates the impression that multiple separate signatures are needed when usually only one is.
2. **"Hide" vs "Delete" is a distinction without a use case.** Agents currently see only a Hide/Show toggle. There is no Delete. Hiding still leaves the product on the tab (under a "Show hidden products" checkbox visible only to tenant admins), which mixes active and inactive products in the same place. Agents want the simpler verb "Delete" — and they don't need to think about whether anyone is enrolled, because the system should handle that automatically.

## Goal

Simplify the Group Products tab so that:

- **ASA signing** is surfaced once at the top of the tab as a banner listing each unsigned ASA document, with a per-document Sign button. The per-row ASA pill column is removed.
- **Visibility actions** are reduced to a single per-row "Delete" button (Agents/Tenants only). Behind the scenes it still flips `GroupProducts.IsHidden = 1`. Existing enrollments are unaffected; the product just stops appearing in new enrollment links.
- A read-only **"Products with Active Enrollments"** section appears below the active products list (Agents/Tenants only), listing deleted products that still have enrolled members, with the member list per product. This preserves the audit trail without cluttering the active list.
- **Re-adding** a deleted product uses the existing "add product" flow — the agent picks it from the available-products list, and the system flips `IsHidden = 0` instead of inserting a duplicate row.
- **Group admins** lose all visibility controls. They see the active list, the ASA banner (which they can sign), and nothing else hide/delete-related.

## Non-Goals

- **No catalog-wide changes.** Every change here is scoped to `GroupProducts` (the per-group join row). The `Products` table and the tenant catalog UI are untouched.
- **No new database columns.** `GroupProducts.IsHidden` is reused as the soft-delete flag.
- **No changes to existing enrollments.** A "deleted" product with active members continues to function exactly as a hidden product does today: existing enrollments stay live, and the product is omitted from new enrollment links.
- **No changes to the `AgentProducts.tsx` page** (the agent's read-only product browser). All work is in `GroupProductsTab.tsx`.
- **No changes to the SysAdmin/TenantAdmin product-management areas.** Those use a different surface and a different model.

## Permission Matrix

| Role | ASA Banner | Active Products List | Delete button | "Products with Active Enrollments" section | Re-add (via Add Product flow) |
|------|------------|----------------------|---------------|---------------------------------------------|--------------------------------|
| Group Admin | Visible, signing-enabled (signs their group's ASAs) | Visible, view-only | Hidden | Hidden | Hidden |
| Agent | Visible, read-only ("Awaiting group admin signature on:") | Visible | Visible | Visible | Visible |
| Tenant Admin | Visible, read-only | Visible | Visible | Visible | Visible |

The existing "Show hidden products" checkbox (currently tenant-admin-only, lines 437–452 of `GroupProductsTab.tsx`) is **removed**. Its function is replaced by the dedicated "Products with Active Enrollments" section, which is always visible to Agents/Tenants and never visible to group admins.

## Design

### 1. ASA Banner

**Placement:** Top of `GroupProductsTab.tsx`, above the products table. Replaces the per-row ASA pill column entirely.

**Layout (Tailwind, brand colors):**

```
┌────────────────────────────────────────────────────────────┐
│ ⚠ ASA signature required                                    │
│                                                              │
│ • MightyWELL Master Agent Sales Agreement       [ Sign ]    │
│ • Acme Health Vendor ASA                        [ Sign ]    │
└────────────────────────────────────────────────────────────┘
```

- Card: `bg-oe-light border border-oe-primary/30 rounded-lg p-4 mb-4`
- Title: bold, with a Lucide `AlertCircle` icon
- One row per **unsigned** document
- Each row: document name + "Sign" button (`bg-oe-primary hover:bg-oe-dark text-white`)
- Clicking Sign opens the existing `ASASigningModal.tsx` for that document
- After signing succeeds, that row disappears; when all rows are gone, the entire banner is hidden

**Read-only variant for Agents/Tenants:**

```
┌────────────────────────────────────────────────────────────┐
│ ⓘ Awaiting group admin signature on:                        │
│   • MightyWELL Master Agent Sales Agreement                  │
│   • Acme Health Vendor ASA                                   │
└────────────────────────────────────────────────────────────┘
```

- No Sign button; informational only
- Rendered with the same data, just with the action hidden

**Data source:** Reuse `GET /api/groups/:groupId/asa-status` (`backend/routes/group-asa-status.js`). The endpoint already returns per-product status; the frontend groups by `documentId` and shows one row per **unique unsigned document**. No backend change required.

**Removed UI:**
- The per-row ASA badge column (lines 158–218 of `GroupProductsTab.tsx`)
- The per-row "Sign Now" inline button
- Bundle subproduct expansion no longer shows nested ASA pills (lines 667–716)

### 2. Delete Flow

**Per-row button:** The current "Hide" / "Show" toggle button (lines 594–640) is replaced by a single **"Delete"** button. Visible to Agents/Tenants only; hidden for Group Admins.

- Button: `text-red-600 hover:bg-red-50 border border-gray-300` with Lucide `Trash2` icon
- One per active product row

**Confirmation modal (single component, copy adapts):**

When clicked, the frontend calls `GET /api/groups/:groupId/products/:productId/enrollment-count` to get the active enrollment count, then opens a modal:

- **No active enrollments:**

  > Remove **{Product Name}** from this group?
  >
  > It will no longer appear in enrollment links. You can re-add it anytime from the Add Product menu.
  >
  > [ Cancel ] [ Remove ]

- **Has active enrollments (count > 0):**

  > Remove **{Product Name}** from this group?
  >
  > **{N} member(s) are currently enrolled — their enrollments will continue unchanged.**
  >
  > The product will not appear in new enrollment links. You can re-add it anytime from the Add Product menu.
  >
  > [ Cancel ] [ Remove ]

Single "Remove" button (`bg-red-600 hover:bg-red-700 text-white`). Single "Cancel" button (secondary outline). On confirm, calls the existing `PATCH /api/groups/:groupId/products/:productId/visibility` endpoint with body `{ IsHidden: true }`.

**Backend behavior:** The PATCH endpoint already exists (`backend/routes/groupProducts.js` lines 1034–1106). Two changes:

1. **Tighten authorization** so only Agent and TenantAdmin (and SysAdmin) can call it. Group admins receive 403. (Today, group admins can call this endpoint via the Hide/Show toggle. After this change, the toggle is gone from their UI and the endpoint denies them at the middleware level.)
2. **No SQL change.** The endpoint already flips `GroupProducts.IsHidden` with the existing group-type-mismatch validation (`GROUPTYPE_PRODUCT_MISMATCH`, lines 1068–1081). That validation is preserved.

**Existing enrollments:** Unchanged. The enrollment-link query in `backend/routes/enrollment-links.js` (lines 1358–1359, 10103) already filters out `IsHidden = 1`, so deleted products simply stop appearing in new enrollment links. Existing member enrollments continue to bill, ship, and report normally — same as today's hide behavior.

### 3. Products with Active Enrollments Section

**Placement:** Below the active products list on `GroupProductsTab.tsx`. Visible to Agents/Tenants only. Hidden entirely for Group Admins.

**Layout:**

```
─────────────────────────────────────────────────────────────
Products with Active Enrollments

These products were removed from this group but still have
enrolled members. They are not available in new enrollment links.
─────────────────────────────────────────────────────────────

▶ MightyWELL Bronze         3 members enrolled
▶ MightyWELL Silver         1 member enrolled

(expanded)
▼ MightyWELL Bronze         3 members enrolled
   • Jane Doe       (enrolled 2026-01-15)
   • John Smith     (enrolled 2025-11-02)
   • Sarah Lee      (enrolled 2025-09-30)
```

- Section header: `text-lg font-semibold text-gray-900`
- Helper paragraph: `text-sm text-gray-600 mb-4`
- Each row: collapsed by default, expandable via Lucide `ChevronRight` / `ChevronDown` toggle
- Collapsed row: product name (left) + "{N} member(s) enrolled" (right)
- Expanded row: bulleted list of member names + enrollment date
- No actions on this section — it is read-only audit/context only
- If there are no products in this state, the entire section is hidden (no empty state)

**Data source:** New endpoint:

```
GET /api/groups/:groupId/products/hidden-with-enrollments

Response:
{
  success: true,
  data: [
    {
      productId: "...",
      productName: "MightyWELL Bronze",
      enrollmentCount: 3,
      members: [
        { memberId: "...", fullName: "Jane Doe",   enrolledDate: "2026-01-15" },
        { memberId: "...", fullName: "John Smith", enrolledDate: "2025-11-02" },
        { memberId: "...", fullName: "Sarah Lee",  enrolledDate: "2025-09-30" }
      ]
    },
    ...
  ]
}
```

Returns only products where `GroupProducts.IsHidden = 1` AND there is at least one active enrollment for the product within the group. Authorization: Agent / TenantAdmin / SysAdmin only — Group admins get 403.

### 4. Re-add (Unhide) Behavior

**From the agent's perspective:** A deleted product appears in the standard "Add Product to Group" flow exactly like any other available product. The agent ticks it; on save, it reappears in the active products list.

**Backend behavior:** The existing add-product flow in `backend/routes/groupProducts.js` (around lines 696–740) handles two paths:
- **Existing `GroupProducts` row** → currently runs an UPDATE that sets `IsActive = 1` and updates `CustomSettings`. **Change:** add `IsHidden = 0` to the UPDATE so the row is fully un-deleted.
- **No existing row** → INSERT path is unchanged. New rows are created with `IsHidden = NULL` (treated as `0`) by default.

This means the same endpoint that handles initial product assignment also handles re-add — no separate "unhide" endpoint, no separate UI button.

**Existing constraint preserved:** The group-type-mismatch validation (`GROUPTYPE_PRODUCT_MISMATCH`, lines 66–75 of `GroupProductsTab.tsx` and lines 1068–1081 of `groupProducts.js`) still applies. ListBill groups cannot un-hide Group-only products; Standard groups cannot un-hide Individual-only products. In practice, those incompatible products simply don't appear in the available-products picker for that group type.

## Backend Summary

**Endpoints — changes only:**

| Method | Route | Change |
|--------|-------|--------|
| `PATCH` | `/api/groups/:groupId/products/:productId/visibility` | Tighten auth: deny Group Admin (403). No SQL change. |
| `GET` | `/api/groups/:groupId/products/:productId/enrollment-count` | **New.** Returns `{ success, data: { count: number } }`. Used by the Delete confirmation modal. Auth: Agent/Tenant. |
| `GET` | `/api/groups/:groupId/products/hidden-with-enrollments` | **New.** Returns hidden products with active enrollments + member list. Auth: Agent/Tenant. |
| `POST` | `/api/groups/:groupId/products` (existing add-product flow) | Update the UPDATE branch (~line 711) to also set `IsHidden = 0`. |

**Endpoints unchanged but referenced:**

- `GET /api/groups/:groupId/asa-status` — drives the new ASA banner (frontend regroups by documentId)
- `POST /api/groups/:groupId/asa-sign` — drives the Sign button in the banner

**No schema migrations.** All changes use existing columns (`GroupProducts.IsHidden`, `GroupProducts.IsActive`, `Products.RequiredASA`, `SignedASAAgreements.*`).

## Frontend Summary

**File: `frontend/src/pages/groups/GroupProductsTab.tsx`**

Changes:
- **Add ASA banner component** at the top of the tab (above the table)
- **Remove** the per-row ASA badge column and its render logic (lines 158–218)
- **Remove** the per-row "Sign Now" inline button
- **Remove** the bundle-subproduct ASA badge (lines 667–716 — keep the bundle expansion, drop the ASA pill inside it)
- **Replace** the per-row Hide/Show toggle (lines 594–640) with a single Delete button (Agent/Tenant only)
- **Wire** the Delete button to a new confirmation modal (described above)
- **Remove** the "Show hidden products" checkbox (lines 437–452)
- **Add** the "Products with Active Enrollments" section below the active list (Agent/Tenant only)
- **Hide all delete-related UI** when `userType === 'GroupAdmin'`

**New component (suggested):** `frontend/src/components/groups/DeleteProductConfirmModal.tsx` — small modal that takes `{ productId, productName, enrollmentCount, onConfirm, onCancel }` and renders the adaptive copy. Uses native HTML elements + Tailwind only (per `CLAUDE.md` UI rules).

**New component (suggested):** `frontend/src/components/groups/ASARequiredBanner.tsx` — encapsulates the banner logic + read-only / interactive variants.

**New hook (suggested):** `frontend/src/hooks/groups/useHiddenProductsWithEnrollments.ts` — TanStack Query hook calling the new GET endpoint.

**Existing hooks reused:** the existing ASA-status hook for the banner data; the existing GroupProducts list hook (no longer takes a `showHidden` flag).

## Testing

**Backend (Jest, in `backend/`):**

- New test: `routes/__tests__/groupProducts.delete-permissions.test.js`
  - Agent calling `PATCH .../visibility` with `IsHidden: true` → 200, row updated
  - Group Admin calling the same endpoint → 403
  - Tenant Admin calling the same endpoint → 200
- New test: `routes/__tests__/groupProducts.hidden-with-enrollments.test.js`
  - Returns only products where `IsHidden = 1` AND active enrollments exist
  - Returns empty array when no qualifying products
  - Group Admin → 403
- New test: `routes/__tests__/groupProducts.enrollment-count.test.js`
  - Returns `{ count: 0 }` when no enrollments
  - Returns `{ count: N }` when N active enrollments exist for that product/group
- New test: `routes/__tests__/groupProducts.readd-unhides.test.js`
  - Adding a product whose `GroupProducts` row exists with `IsHidden = 1` → row updates with `IsHidden = 0` and `IsActive = 1`
  - Adding a brand-new product → INSERT path, `IsHidden` stays NULL/0

**Frontend (Vitest, in `frontend/`):**

- `src/components/groups/__tests__/ASARequiredBanner.test.tsx`
  - Renders nothing when all ASAs are signed
  - Renders one row per unsigned document
  - Group Admin variant shows Sign button; Agent variant shows informational text
- `src/components/groups/__tests__/DeleteProductConfirmModal.test.tsx`
  - Copy adapts based on `enrollmentCount` prop (0 vs N)
  - Calls `onConfirm` on Remove click; calls `onCancel` on Cancel click
- `src/pages/groups/__tests__/GroupProductsTab.test.tsx` (extend existing if present, else new)
  - Group Admin sees no Delete button, no "Products with Active Enrollments" section, no "Show hidden" checkbox
  - Agent sees Delete button on every active row
  - Agent sees "Products with Active Enrollments" section when API returns rows; section is hidden when API returns empty array

**Cypress (`frontend/cypress/e2e/groups/`):**

- `group-products-delete.cy.ts` — Agent navigates to a group's products tab, clicks Delete on a product with no enrollments, confirms, sees the row disappear from the active list. Re-adds via Add Product flow, sees it reappear.
- `group-products-delete-with-enrollments.cy.ts` — Agent deletes a product that has 2 active enrollments. Confirmation modal shows "2 members are currently enrolled — their enrollments will continue unchanged." On confirm, product moves out of the active list and into the "Products with Active Enrollments" section, expanded view shows the 2 member names.
- `group-products-asa-banner.cy.ts` — Group admin sees ASA banner with one Sign button per unsigned document. Clicking Sign opens the existing `ASASigningModal`. After signing all docs, banner disappears. Per-row ASA column does not exist.
- `group-products-group-admin-permissions.cy.ts` — Logged in as group admin, no Delete button anywhere, no "Products with Active Enrollments" section, no "Show hidden" checkbox.

**Per `CLAUDE.md` testing guidance:** these tests verify the functional behavior of the simplification (permission gating, copy adaptation, re-add round-trip, enrollment preservation). Visual-only details (banner color, modal padding) are not covered by Cypress.

## Rollout Notes

- This is a single-PR change targeting `staging`. No feature flag.
- No data migration required — existing `IsHidden = 1` rows automatically populate the new "Products with Active Enrollments" section if they have active enrollments, and otherwise are simply absent from the active list.
- The branch name (`group-updates/hide-clearity`) and commit history should reflect the conceptual shift from "hide" to "delete" in the UI vocabulary, while preserving `IsHidden` as the database-level mechanism.

## Open Questions

None — design locked per Joey's confirmation 2026-04-29.
