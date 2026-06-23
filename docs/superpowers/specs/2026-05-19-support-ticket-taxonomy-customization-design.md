# Vendor-customizable Support Ticket taxonomy

**Date:** 2026-05-19
**Branch:** `fix/backoffice/rename-cases-to-support-tickets`
**Builds on:** `2026-05-19-rename-cases-to-support-tickets-design.md`

## Why

Open-Enroll is white-label software. Different vendors need different ticket types and subcategories. Hardcoded constants in the backend + frontend block that. This change makes the taxonomy (types + subcategories) editable per vendor by `VendorAdmin`, with the existing 5 defaults pre-seeded for every vendor.

## Scope (MVP)

VendorAdmin can:
- **Add** a new type or subcategory
- **Rename** a type's or subcategory's display label (code stays stable)
- **Toggle `IsActive`** (soft-disable; existing tickets keep their tag)
- **Reorder** types and subcategories via `SortOrder`

Out of scope this PR: hard-delete, per-type colors/icons, code editing, importing/exporting taxonomies, vendor-creation auto-seeding (a separate hook later).

## Data model

Two new tables in `oe`:

### `oe.SupportTicketTypes`

| Column | Type | Notes |
|---|---|---|
| `TypeId` | `UNIQUEIDENTIFIER PK` | `NEWID()` default |
| `VendorId` | `UNIQUEIDENTIFIER NOT NULL` | FK → `oe.Vendors(VendorId)`, indexed |
| `Code` | `NVARCHAR(50) NOT NULL` | Stable slug. Unique per `(VendorId, Code)`. |
| `Label` | `NVARCHAR(100) NOT NULL` | Display string — editable |
| `IsActive` | `BIT NOT NULL DEFAULT 1` | Soft-disable |
| `SortOrder` | `INT NOT NULL DEFAULT 0` | For drag-reorder |
| `CreatedDate` | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | |
| `CreatedBy` | `UNIQUEIDENTIFIER NULL` | FK → `oe.Users` |
| `ModifiedDate` | `DATETIME2 NULL` | |
| `ModifiedBy` | `UNIQUEIDENTIFIER NULL` | |

### `oe.SupportTicketSubcategories`

Same shape, plus `TypeId UNIQUEIDENTIFIER NOT NULL` FK → `oe.SupportTicketTypes(TypeId) ON DELETE CASCADE`. `Code` is unique per `(VendorId, TypeId, Code)`.

### Why codes stay stable

Existing `oe.SupportTickets.TicketType` and `TicketSubcategory` keep `NVARCHAR(50)` storing the **code** (not a TypeId FK). Renaming a label leaves existing tickets untouched. Soft-disabling a type doesn't orphan existing rows. App-layer validation on create/update checks the code exists and is `IsActive=1` for that vendor.

The hardcoded DB CHECK constraints (`CK_SupportTickets_TicketType`, `CK_SupportTickets_TicketSubcategory`) are dropped — the lookup tables are the new source of truth.

## Seeding

For every existing row in `oe.Vendors`, the migration inserts the 5 default types + their subcategories with these codes/labels:

| Code | Label | Subcategories (code → label) |
|---|---|---|
| `reimbursement` | Reimbursement | `oon_copay` → OON Copay, `preventative` → Preventative, `other` → Other |
| `billing` | Billing | `provider_invoice` → Provider Invoice, `negotiation` → Negotiation, `recovery` → Recovery, `claims_cob` → Claims / COB |
| `encounter_escalation` | Encounter Escalation | `needs_follow_up` → Needs Follow Up, `issue_raised` → Issue Raised, `routed_to_team` → Routed to Team |
| `complaint` | Complaint | `service_quality` → Service Quality, `process_outcome` → Process / Outcome, `privacy` → Privacy |
| `appeals` | Appeals | `denied_share` → Denied Share, `denied_reimbursement` → Denied Reimbursement, `amount_dispute` → Amount Dispute, `second_level` → 2nd Level |

`SortOrder` is assigned in the order shown above (10, 20, 30, ...). New vendors created after this migration will need to be seeded by a follow-up hook (not in this PR — flagged as out of scope).

## Migration file

**Path:** `sql-changes/2026-05-19-support-ticket-taxonomy.sql`

1. Create `oe.SupportTicketTypes` (with FK, UNIQUE index on `(VendorId, Code)`, IX on `VendorId`).
2. Create `oe.SupportTicketSubcategories` (with FK to types `ON DELETE CASCADE`, UNIQUE on `(VendorId, TypeId, Code)`, IX on `(VendorId, TypeId)`).
3. Drop `CK_SupportTickets_TicketType` and `CK_SupportTickets_TicketSubcategory`.
4. Seed: for each `VendorId` in `oe.Vendors`, insert the 5 types and their subcategories. Idempotent via `WHERE NOT EXISTS` on `(VendorId, Code)`.
5. Verification SELECT counts types/subcategories per vendor.
6. Rollback block (commented).

## API

### Read (everyone allowed in the workspace — VendorAdmin and VendorAgent)

- `GET /api/me/vendor/support-tickets/taxonomy` — returns active types and their active subcategories for the current vendor. Shape:
  ```json
  {
    "success": true,
    "data": {
      "types": [
        {
          "typeId": "...", "code": "reimbursement", "label": "Reimbursement", "sortOrder": 10,
          "subcategories": [
            { "subcategoryId": "...", "code": "oon_copay", "label": "OON Copay", "sortOrder": 10 },
            ...
          ]
        },
        ...
      ]
    }
  }
  ```
- Replaces the current `/taxonomy` endpoint (which served the hardcoded map).

### Admin (VendorAdmin only) — base path `/api/me/vendor/support-tickets/admin`

- `GET /taxonomy` — full list including inactive rows. Shape mirrors read but with `isActive` on each item.
- `POST /types` — body `{ label, sortOrder? }`. Auto-generates `code` by slugifying `label`; on collision appends `-2`, `-3`, etc. Returns the created row.
- `PUT /types/:typeId` — body any of `{ label, isActive, sortOrder }`. 404 if not in this vendor.
- `PUT /types/reorder` — body `{ orderedTypeIds: ["..", ".."] }`. Sets `SortOrder = 10, 20, 30, ...` in the order given. All ids must belong to this vendor.
- `POST /types/:typeId/subcategories` — body `{ label, sortOrder? }`. Code auto-slugified, unique per `(VendorId, TypeId)`.
- `PUT /subcategories/:subcategoryId` — body any of `{ label, isActive, sortOrder }`.
- `PUT /subcategories/reorder` — body `{ typeId, orderedSubcategoryIds: [..] }`.

All admin routes enforced by `authorize(['VendorAdmin'])` middleware. `attachVendorContext` scopes everything to the requester's vendor.

### Validation flow

`supportTicketService.validateTicketTypeAndSubcategory(vendorId, type, subcategory)` is rewritten to query the DB:
1. Type must exist with that code, `IsActive=1`, for this vendor.
2. If subcategory non-null, it must exist with that code under that type, `IsActive=1`, for this vendor.

Called on every create and update. CHECK constraints are gone, so this is the only validation gate.

## Backend code changes

- **New service**: `backend/services/supportTicketTaxonomyService.js` — CRUD + reorder + slug helper.
- **`backend/services/supportTicketService.js`**:
  - Remove the hardcoded `TICKET_TYPE_SUBCATEGORIES` map.
  - Rewrite `validateTicketTypeAndSubcategory(vendorId, ...)` to query the new tables.
  - Update `/taxonomy` endpoint handler to return the new shape.
- **`backend/routes/me/vendor/support-tickets.js`**:
  - `/taxonomy` returns vendor-scoped active items.
  - Add the admin endpoints above, all guarded by `authorize(['VendorAdmin'])`.

## Frontend code changes

- **Remove hardcoded constants in `frontend/src/constants/supportTicketTaxonomy.ts`**:
  - Keep the file but reduce it to a tiny fallback label map (only the 5 well-known codes) so the rail/HeaderCard can render labels for legacy data even before the taxonomy hook resolves. Mark clearly as fallback-only.
  - Drop the `TICKET_TYPES` array and `TICKET_TYPE_SUBCATEGORIES` map from the constant file.
- **New hook `useTicketTaxonomy()`**: React Query hook fetching `/api/me/vendor/support-tickets/taxonomy`. 5-minute staleTime. Returns `{ types, isLoading, error }` plus a helper `getLabel(code)` for type and subcategory display.
- **Wire through dropdowns** — replace hardcoded map references in:
  - `SupportTicketNewModal.tsx`
  - `SupportTicketDetailsTab.tsx`
  - `SupportTicketHeaderCard.tsx` (label rendering only — use the fallback for legacy codes)
  - `EncounterDetailCard.tsx` (convert dialog)
- **Type changes** in `frontend/src/types/supportTicket.types.ts`:
  - `TicketType` and `TicketSubcategory` become `string` aliases (no longer literal unions, since codes are now dynamic).
- **New `SupportTicketSettingsTab.tsx`**: VendorAdmin-only tab in the workspace. Layout:
  - List of types (drag-reorder, edit Label inline, toggle IsActive, "Add type" at top)
  - Each type expands to show its subcategories (same controls + "Add subcategory")
  - Save-as-you-go (per-row PUT, optimistic UI with React Query invalidation)
- **`SupportTicketWorkspaceTabs.tsx`**: add a `'settings'` tab key, render only when `user.roles` includes `VendorAdmin`. Icon: `Settings` from lucide-react.

## Permission gating

- All `/admin/*` endpoints require `VendorAdmin`. `VendorAgent` gets a 403.
- Frontend hides the Settings tab for non-VendorAdmin via `useAuth()`.
- The non-admin `/taxonomy` endpoint is open to both VendorAdmin and VendorAgent — they need it to render the create modal.

## Deployment order

1. Apply `sql-changes/2026-05-19-support-ticket-taxonomy.sql` (after the rename migration). Creates tables, drops CHECKs, seeds 8 existing vendors.
2. Deploy backend + frontend together. Backend serves the new taxonomy endpoint; frontend uses it.
3. Smoke-test as VendorAdmin: open Settings tab, rename "Reimbursement" → "Refund", verify the rail filter dropdown and New Ticket modal show "Refund".
4. Smoke-test as VendorAgent: Settings tab hidden; create modal still works.

## Out of scope (follow-ups)

- Auto-seeding the 5 defaults when a brand-new vendor is created (handled by a follow-up service hook, not this PR).
- Code editing (renaming the underlying code; would require a migration step to rewrite `oe.SupportTickets` rows).
- Color/icon customization per type.
- Hard-delete with FK-style protection (currently soft-disable only).
- Import/export of a vendor's taxonomy.
- Translating labels (i18n).
