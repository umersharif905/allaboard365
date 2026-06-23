# Vendor Resource Library

Replace the vendor portal's flat "Documents" page with a folder/file Resource Library that mirrors the agent Resource Library pattern.

## Goal

Vendor back-office users (VendorAdmin, VendorAgent) need the same hierarchical resource library agents already have — folders, files, reorder, copy-from-MightyWell — but scoped per-vendor with a tighter permission model.

## Scope

Per-vendor (each vendor company has its own library, isolated from other vendors in the tenant). Mirrors the agency pattern.

## Data model

Two new tables paralleling `oe.AgencyMarketingFolders/Resources`, with `VendorId` swapped for `AgencyId`:

- `oe.VendorMarketingFolders` — `FolderId, TenantId, VendorId, ParentFolderId, Name, Description, SortOrder, CreatedDate, CreatedBy, UpdatedDate, Status`
- `oe.VendorMarketingResources` — same columns as `oe.AgencyMarketingResources`, with `VendorId` replacing `AgencyId`

No `UseCustomResourceLibrary` toggle — vendors always have their own library and populate it via the copy-from-MightyWell flow.

## Backend

New file `backend/routes/me/vendor/resource-library.js` mounted at `/api/me/vendor/resource-library`. Endpoints mirror the agency routes; permission matrix:

| Endpoint | VendorAdmin | VendorAgent |
|---|---|---|
| `GET /folders` | ✓ | ✓ |
| `POST /folders` | ✓ | ✓ |
| `PATCH /folders/:id` (rename, reorder, move) | ✓ | ✓ |
| `DELETE /folders/:id` | ✓ | ✗ |
| `GET /resources` | ✓ | ✓ |
| `POST /resources` | ✓ | ✓ |
| `PATCH /resources/:id` | ✓ | ✓ |
| `DELETE /resources/:id` | ✓ | ✗ |
| `GET /organization-catalog` | ✓ | ✗ |
| `POST /copy-from-organization` | ✓ | ✗ |

All routes filter by `TenantId` AND `VendorId` resolved from `req.user`. VendorAdmin-only endpoints use `authorize(['VendorAdmin'])`; shared endpoints use `authorize(['VendorAdmin','VendorAgent'])`.

Old routes (`backend/routes/me/vendor/documents.js`) are removed along with their `app.js` mount.

## Frontend

- Refactor `MarketingDocumentsTab` to accept its API base + permission flags as props (or via a small `useResourceLibraryApi({ scope })` hook). Both the existing agency consumer and the new vendor consumer pass their own scope. One component, two scopes.
- New page `frontend/src/pages/vendor/VendorResourceLibraryPage.tsx` renders the refactored component with vendor scope, passing:
  - `canEdit`: VendorAdmin || VendorAgent
  - `canDelete`: VendorAdmin only
  - `canCopyFromOrg`: VendorAdmin only
- `VendorNavigation.tsx`: rename the "Documents" sidebar entry to "Resource Library", switch icon to `FolderOpen`, change path to `/vendor/resource-library`.
- `App.tsx`: replace the `/vendor/documents` route registration with `/vendor/resource-library` pointing at the new page. Allowed roles: `['VendorAdmin','VendorAgent']`.
- Remove `frontend/src/pages/vendor/VendorDocuments.tsx`.

## Data migration

None. Old rows in `oe.FileUploads` with `UploadType='agreements'` are left untouched (unreachable from new UI). Per the request, content is scrapped; VendorAdmins repopulate via Copy-from-MightyWell.

## Out of scope

- Tests (per request).
- Migrating existing FileUploads rows into the new tables.
- Read-through / sync from MightyWell library (one-time copy only).
- VendorAccounting / VendorIT roles — already collapsed into VendorAdmin/VendorAgent in a prior PR.
