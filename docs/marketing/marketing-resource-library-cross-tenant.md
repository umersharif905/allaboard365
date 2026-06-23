# Marketing resource library: cross-tenant policy

**Cross-tenant marketing folders are copy-only, sysadmin-only.** We do not use the
`oe.TenantMarketingFolderTenantAccess` sharing table from the abandoned
`feat/cross-tenant-resources` branch.

## Why copy, not share

Sharing means two tenants reference the same logical folder; an edit on the source
silently changes what the other tenant sees, and a delete is destructive across
tenants. Copying creates an independent snapshot — new `FolderId` and `ResourceId`
rows owned by the target tenant, plus new `oe.FileUploads` rows and freshly
duplicated blobs for file resources. The agency-scoped library uses the same
isolation model (see
[`backend/services/shared/agency-marketing-library.service.js`](../backend/services/shared/agency-marketing-library.service.js)).

## How to copy between tenants

- UI: SysAdmin → "Copy Marketing Library" (`/admin/marketing-resources/copy`).
  Pick a source tenant, a target tenant, and the folders to copy.
- API: `POST /api/me/sysadmin/marketing-resources/copy-between-tenants`
  with `{ sourceTenantId, targetTenantId, folderIds: string[] }`.

The service runs in a single transaction (see `copyFoldersBetweenTenants` in
[`backend/services/shared/tenant-marketing-library.service.js`](../backend/services/shared/tenant-marketing-library.service.js))
and reuses `copyDocumentsBlobToNewName` from
[`backend/routes/uploads.js`](../backend/routes/uploads.js) for blob duplication.

## Migration policy

If any environment ever applied the abandoned sharing migration, drop the
`oe.TenantMarketingFolderTenantAccess` table and its seed rows in a follow-up
SQL change before consolidating the schema. This repo never created the table,
so most environments need no action.
