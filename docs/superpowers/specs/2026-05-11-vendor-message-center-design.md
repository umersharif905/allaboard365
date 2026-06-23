# Vendor Message Center — Design

**Date:** 2026-05-11 (revised 2026-05-11 — see "Revision: no globals + SysAdmin scope pill" section)
**Branch:** `feat/back-office-message-center`
**Status:** Implementation in progress
**Supersedes:** `docs/vendor-portal/messaging-plan.md` (earlier "fully isolated" approach — deleted)

---

## Summary

Add a Message Center to the vendor portal containing **Templates**, **Message Blast**, and **Campaigns**. All vendor users of a given vendor share the same view of that vendor's templates and campaigns (it is per-vendor, not per-user); tenant users see only the tenant's templates and campaigns. Storage, backend routes, and page components are all shared between the two portals — scoping is enforced via a single `VendorId` column on the existing tables, resolved at the route layer from the caller's role.

The previous plan proposed fully separate tables, routes, and page components for the vendor side. That created more code than the problem warrants. This design uses the codebase's existing pattern (a shared route whose `authorize()` allowlist names every role that may call it; scope derived from the caller) and a discriminator column for data ownership.

## Scope

**In scope (v1):**
- Vendor portal sidebar gains a "Message Center" entry.
- Three tabs: Templates (CRUD + preview), Message Blast (send), Campaigns (CRUD + steps + actually-fires-against-members).
- `VendorAdmin` and `VendorAgent` can access.
- **Delete the existing vendor "Email Templates" page completely** — table is empty, page is unused. See "Removing the legacy vendor Email Templates" below.

**Out of scope:**
- No changes to the tenant Message Center UI (it keeps its existing Proposals, Scheduled, Queue, History, Analytics tabs).
- No new tenant-side features.
- Other vendor roles (`VendorAccounting`, `VendorIT`) — those are being removed in a separate PR.

## Architecture

### Storage

Two ALTER TABLEs. No new tables.

```sql
ALTER TABLE oe.MessageTemplates ADD VendorId UNIQUEIDENTIFIER NULL;
CREATE INDEX IX_MessageTemplates_TenantId_VendorId ON oe.MessageTemplates (TenantId, VendorId);

ALTER TABLE oe.Campaigns ADD VendorId UNIQUEIDENTIFIER NULL;
CREATE INDEX IX_Campaigns_TenantId_VendorId_IsActive ON oe.Campaigns (TenantId, VendorId, IsActive);
```

Semantics:
- `VendorId IS NULL` → tenant-owned (current behavior; all existing rows backfill to NULL).
- `VendorId IS NOT NULL` → vendor-owned; the value identifies which vendor.

Untouched: `oe.CampaignSteps`, `oe.CampaignEnrollments`, `oe.CampaignMessageLog` (all scoping derived from the parent `CampaignId`).

Migration file: `sql-changes/2026-05-11-vendor-messaging-scope.sql`. Idempotent — checks for column existence before ALTER. No backfill needed; nulls are correct.

### Scope helper

A single helper on the backend resolves "what messaging scope does this caller operate in" from the request:

```js
// backend/services/messagingScope.service.js (new file)
async function resolveMessagingScope(req) {
  const roles = getUserRoles(req.user);
  if (roles.includes('VendorAdmin') || roles.includes('VendorAgent')) {
    const vendorId = await getVendorIdForUser(req.user);
    if (!vendorId) throw new ScopeError('Vendor user has no VendorId');
    return { vendorIdFilter: vendorId, isVendor: true };
  }
  // TenantAdmin / SysAdmin / future roles — tenant scope
  return { vendorIdFilter: null, isVendor: false };
}
```

`getVendorIdForUser` follows the existing pattern in `backend/routes/me/vendor/profile.js:17-25` (lookup `oe.Users.VendorId` by `UserId`).

Every templates and campaigns query splices the scope into its WHERE clause:

- Vendor caller: `WHERE TenantId = @tenantId AND VendorId = @vendorIdFilter`
- Tenant caller: `WHERE TenantId = @tenantId AND VendorId IS NULL`

Inserts: vendor inserts set `VendorId = @vendorIdFilter`; tenant inserts leave it `NULL`.

### Backend routes

All three feature areas use shared endpoints; auth allowlists expand to include vendor roles.

**Templates (`backend/routes/messageCenter.js`, lines 317–926):**
- Endpoints: `GET/POST/PUT/DELETE /api/message-center/templates`, `POST .../templates/:id/test`, `POST .../templates/:id/preview-group`, `POST .../quick-send`.
- Current auth: most are `authenticate + requireTenantAccess` with no explicit `authorize()`. Add `authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent'])` to each.
- Splice scope helper into every query.

**Campaigns (`backend/routes/campaigns.js`, mounted at `/api/message-center/campaigns` via `messageCenter.js:2140-2141`):**
- Endpoints: campaign CRUD + steps reorder + enrollments listing (~11 routes).
- Same auth allowlist addition. Same scope helper splice.

**Message Blast (`backend/routes/me/tenant-admin/message-blast.js`):**
- Endpoints: `GET /agents`, `POST /estimate`, `POST /send`, `POST /actual-cost`.
- Current auth: `authorize(['TenantAdmin', 'SysAdmin'])` on each. Add `VendorAdmin` and `VendorAgent`.
- No scoping change needed — the existing route already filters recipients by tenant, and vendor users are tenant-scoped via `oe.Users.TenantId`. Confirmed by user: "all recipient lists should be the same since they're within the same system."

### Frontend

**Vendor navigation (`frontend/src/components/vendor/VendorNavigation.tsx:136`):**
Replace the existing "Email Templates" entry with:
- `{ path: '/vendor/messaging', label: 'Message Center', icon: <MessageSquare /> }`

**Vendor routes (`frontend/src/App.tsx`, inside the `/vendor/*` `ProtectedRoute` block at lines 564–594):**
Replace `<Route path="email-templates" element={<VendorEmailTemplates />} />` with:
```tsx
<Route path="messaging" element={<VendorMessageCenterLayout />}>
  <Route index element={<Navigate to="templates" replace />} />
  <Route path="templates" element={<MessageTemplatesPage />} />
  <Route path="blast" element={<MessageBlastPage />} />
  <Route path="campaigns" element={<CampaignsPage />} />
</Route>
```
Also remove the `const VendorEmailTemplates = lazy(() => import('./pages/vendor/VendorEmailTemplates'))` declaration at `App.tsx:142`.

The parent `/vendor/*` `ProtectedRoute` already covers `VendorAdmin`/`VendorAgent`. No nested guard is required since the four currently-allowed vendor roles will become two once the cleanup PR lands.

**Vendor layout (`frontend/src/components/layout/VendorMessageCenterLayout.tsx`, new):**
Forked from `MessageCenterLayout.tsx` but with three nav items (Templates, Message Blast, Campaigns) instead of the tenant's eight. Same styling — Tailwind only, brand colors, `bg-oe-primary`/`bg-oe-dark`. Reuses `MessageSquare`, `Send`, `Mail` Lucide icons from the existing layout.

**Page components are reused as-is.** `MessageTemplatesPage` (from `frontend/src/pages/message-center/`), `MessageBlastPage` (from `frontend/src/pages/tenant-admin/`), and `CampaignsPage` (from `frontend/src/pages/message-center/`) already hit `/api/message-center/*` and `/api/me/tenant-admin/message-blast/*`. With backend scope resolution, they automatically render the vendor's data when a vendor user is logged in.

Earlier in design discussion the team considered passing a `scope: 'tenant' | 'vendor'` prop into the pages. That became unnecessary once we landed on shared backend routes — the API decides scope from the JWT, so the page is genuinely scope-agnostic. The vendor-specific behavior lives entirely in the layout (which renders three nav items instead of eight).

The page-component locations are slightly awkward — `MessageBlastPage` lives under `pages/tenant-admin/` even though the vendor portal now imports it. Renaming/relocating those files to a shared `pages/message-center/` folder is an attractive cleanup but is out of scope for this PR.

### Visibility model (per vendor, not per user)

All vendor users of the same vendor see the same templates and campaigns. The same is true on the tenant side — all tenant admins see the same data.

Mechanism: every query is scoped by `(TenantId, VendorId)` or `(TenantId, VendorId IS NULL)`. **No query is scoped by `CreatedBy` or `UserId`.** Authorship is recorded for audit (`CreatedBy`, `ModifiedBy`) but does not filter visibility.

Concretely:
- Vendor Agent A and Vendor Agent B, both belonging to Vendor X under Tenant Y, will see identical lists of templates and campaigns. Either can edit or delete records the other created.
- Vendor Admin under Vendor X cannot see templates owned by Vendor Z (different `VendorId`).
- TenantAdmin under Tenant Y cannot see vendor-owned templates (their query has `VendorId IS NULL`).
- Editing concurrency between two vendor users in the same vendor is no different from two tenant admins editing the same tenant template today — last-write-wins, no row-level locking.

This is the intended behavior. There is no per-user template or per-user campaign concept.

### Removing the legacy vendor Email Templates

The current `/vendor/email-templates` page and its backing table (`oe.VendorEmailTemplates`) are unused: the table contains **zero rows** in the testing database, and `oe.ShareRequestEmails` (the only table that references it via a nullable `TemplateId`) also contains zero rows. The two `LEFT JOIN` references inside `graphEmailService.js` (lines 490, 518) always produce `NULL` for the joined columns today.

Full removal is part of this PR:

| Step | Change |
|---|---|
| 1 | Delete `frontend/src/pages/vendor/VendorEmailTemplates.tsx`. |
| 2 | Remove the `lazy(() => import('./pages/vendor/VendorEmailTemplates'))` import in `frontend/src/App.tsx:142` and the `<Route path="email-templates" .../>` line. |
| 3 | Remove the "Email Templates" entry in `frontend/src/components/vendor/VendorNavigation.tsx:136` (replaced by the Message Center entry above). |
| 4 | Delete `backend/routes/me/vendor/email-templates.js`. |
| 5 | In `backend/routes/me/vendor/index.js`: remove the `require('./email-templates')` line (~line 18) and the `router.use('/email-templates', …)` mount (~line 45). |
| 6 | In `backend/services/graphEmailService.js`: remove the two `LEFT JOIN oe.VendorEmailTemplates t ON e.TemplateId = t.TemplateId` clauses and the `t.TemplateName` column from the SELECT list in both spots (lines ~490 and ~518). |
| 7 | In the SQL migration: drop the FK from `oe.ShareRequestEmails.TemplateId` if one exists, drop the column itself (no data to migrate), then `DROP TABLE oe.VendorEmailTemplates`. |

The `graphEmailService` itself is **kept untouched otherwise**. It is the Microsoft Graph API integration for share-request communications — it sends emails from each vendor's Office 365 shared mailbox, configured per-vendor in `oe.Vendors`. It is completely separate from the SendGrid/Twilio-backed Message Center. Other share-request files that depend on it (`routes/me/vendor/share-requests.js`, `routes/me/vendor/profile.js`, `services/shareRequestESSService.js`) are not touched.

### Trigger engine

The campaign trigger engine (in `enrollment-jobs/` or wherever it polls active campaigns) doesn't need any change. It processes `oe.Campaigns WHERE IsActive = 1` and enrolls eligible members. With the shared table, vendor campaigns participate automatically as soon as they're marked active.

## Data flow examples

**Vendor user lists templates:**
1. `GET /api/message-center/templates`, JWT contains `userType = VendorAdmin`.
2. `authenticate` + `requireTenantAccess` populate `req.user` and `req.tenantId`.
3. `authorize(['TenantAdmin','SysAdmin','VendorAdmin','VendorAgent'])` admits the call.
4. Handler calls `resolveMessagingScope(req)` → `{ vendorIdFilter: '<vendor-uuid>' }`.
5. Query: `SELECT ... FROM oe.MessageTemplates WHERE TenantId = @tenantId AND VendorId = @vendorIdFilter`.
6. Returns the vendor's templates only.

**Tenant user lists templates:** same flow, but step 4 returns `{ vendorIdFilter: null }`, query becomes `... AND VendorId IS NULL`. Returns tenant-owned templates only.

**Vendor user sends a blast:**
1. `POST /api/me/tenant-admin/message-blast/send`.
2. Auth allows `VendorAdmin`/`VendorAgent`.
3. Existing handler runs unchanged — recipient list is already tenant-scoped, vendor user is tenant-scoped, results match expectation.

## Failure modes

- **Vendor user with no `VendorId` on their `oe.Users` row:** scope helper throws `ScopeError`, handler returns 400 with a clear message. Should not happen for well-provisioned users; covered by Jest test.
- **A campaign step references a template the user can't see:** existing handlers already validate that referenced templates belong to the same tenant. Add an equivalent check that the referenced template's `VendorId` matches the campaign's `VendorId` (both NULL or both equal).
- **Tenant route query missing `AND VendorId IS NULL`:** would leak vendor data to a tenant view (or vice versa). Mitigation: a small linter test that greps the routes for queries against `MessageTemplates` or `Campaigns` and asserts a `VendorId` clause is present.

## Safety: no real sends during testing

This project has **no `DRY_RUN`, `TEST_MODE`, or environment-based suppression on the messaging send paths**. SendGrid/Twilio/Microsoft Graph calls go through if their credentials are present. The discipline is purely behavioral.

Rules for this PR's testing:
- **Never invoke the real send endpoints** during ad-hoc verification: `POST /api/me/tenant-admin/message-blast/send`, `POST /api/message-center/quick-send`, the campaigns runtime endpoint, or anything that ultimately calls the provider clients.
- **Cypress tests stub every send call** via `cy.intercept()`. Tests assert the request payload shape but never let it reach the real handler.
- **Manual sanity checks** (if absolutely necessary) use the author's own email/phone as recipient. Never a real customer's address.
- **No new env-var or feature-flag** is added to enable a dry-run mode. The author of the PR is responsible for not pressing the button.

This rule is recorded in `amar.md` at the repo root.

## Testing

**Backend (Jest):**
- `services/__tests__/messagingScope.service.test.js` — `VendorAdmin`/`VendorAgent` resolves to user's `VendorId`; `TenantAdmin` resolves to null; missing `VendorId` throws.
- `routes/__tests__/messageCenter.templates.scope.test.js` — vendor caller sees only their templates, tenant caller sees only tenant templates, cross-vendor isolation works.
- Same shape for `routes/__tests__/campaigns.scope.test.js`.
- `routes/__tests__/message-blast.vendor-roles.test.js` — vendor roles pass auth on all four blast endpoints.

**Frontend (Vitest):** No new vitest coverage needed — pages are unchanged.

**Cypress:**
- `cypress/e2e/vendor/messaging-templates.cy.ts` — vendor user CRUDs a template, confirms it doesn't appear in tenant view. CRUD calls hit real backend (safe, no provider calls).
- `cypress/e2e/vendor/messaging-blast.cy.ts` — vendor user composes a blast and submits. **The `POST .../message-blast/send` call is stubbed via `cy.intercept()`** — the test asserts the outbound payload shape, no real send.
- `cypress/e2e/vendor/messaging-campaigns.cy.ts` — vendor user creates a campaign with two steps. **No engine-fire integration test in Cypress** (that would require an enrolled member, which would trigger real sends). Engine-fire correctness is covered by a separate Jest integration test that mocks the SendGrid/Twilio clients at the service boundary.
- Regression: existing `cypress/e2e/messaging/*` tenant specs continue to pass.

## Implementation order

1. **SQL migration** (`sql-changes/2026-05-11-vendor-messaging-scope.sql`) — add `VendorId` columns + indexes on `oe.MessageTemplates` and `oe.Campaigns`; drop FK + column from `oe.ShareRequestEmails.TemplateId`; `DROP TABLE oe.VendorEmailTemplates`.
2. **Scope helper** (`backend/services/messagingScope.service.js`) — pure function + Jest tests.
3. **Backend route updates** — splice helper into templates handlers, campaigns handlers, expand blast auth. Add `authorize()` allowlists. Jest tests for each.
4. **Legacy backend removal** — delete `routes/me/vendor/email-templates.js`, remove its mount in `routes/me/vendor/index.js`, remove the two `LEFT JOIN oe.VendorEmailTemplates` clauses in `services/graphEmailService.js`.
5. **Frontend layout** — `VendorMessageCenterLayout.tsx`.
6. **Frontend routing + nav swap** — `App.tsx` (remove `VendorEmailTemplates` lazy import and route; add Message Center routes) and `VendorNavigation.tsx`.
7. **Legacy frontend removal** — delete `frontend/src/pages/vendor/VendorEmailTemplates.tsx`.
8. **Cypress smoke tests** — three vendor specs (sends stubbed) + regression check on tenant specs.
9. **Verify trigger engine** picks up a vendor campaign via a Jest integration test that mocks the SendGrid/Twilio clients (no real sends).

## Open items to verify during implementation

- Confirm `oe.Users.VendorId` is non-null for every active `VendorAdmin` and `VendorAgent` in the testing DB before shipping (so the scope helper doesn't throw in production for legitimate users).
- Confirm the campaign trigger engine doesn't have an implicit "tenant-only" filter beyond `oe.Campaigns.IsActive` — quick read through `enrollment-jobs/` or the cron host that processes campaigns.
- Confirm `oe.MessageTemplates` `Subject` column at `NVARCHAR(200)` is sufficient for the vendor use cases (no change needed, but verify product hasn't requested longer subjects).

## Revision: no globals + SysAdmin scope pill (added 2026-05-11)

After initial implementation it became clear that the "global templates" concept (`oe.MessageTemplates.TenantId IS NULL`) added complexity without enough payoff: it required a 3-way branch in every mutating handler, opened a privilege-boundary inconsistency (TenantAdmin could duplicate a global into another global), and made the visibility model harder to explain. The decision is to eliminate globals entirely. All templates and campaigns belong to exactly one (TenantId, optional VendorId) pair.

### Data model changes

- **Backfill** the single existing `oe.MessageTemplates` row with `TenantId IS NULL` (the "Welcome Email" template) to MightyWELL Health (`TenantId = 1CD92AF7-B6F2-4E48-A8F3-EC6316158826`) — that's the tenant Amar nominated to absorb existing globals.
- **`ALTER COLUMN oe.MessageTemplates.TenantId UNIQUEIDENTIFIER NOT NULL`** after backfill.
- `oe.Campaigns.TenantId` is already `NOT NULL` — no change there.
- `oe.MessageTemplates.VendorId` and `oe.Campaigns.VendorId` stay nullable (NULL = tenant-owned, non-NULL = vendor-owned).

### Visibility model (revised)

| Caller | Visibility | Mechanism |
|---|---|---|
| `VendorAdmin` / `VendorAgent` | Only their vendor's rows within their tenant | `WHERE TenantId = @userTenantId AND VendorId = @userVendorId` |
| `TenantAdmin` | Their tenant's rows that are NOT owned by any vendor | `WHERE TenantId = @userTenantId AND VendorId IS NULL` |
| `SysAdmin` | **Everything across all tenants and vendors** | No WHERE clause filter (filtered only by query-param scope/tenant) |

The previous "global view" branches (`?allTenants=true`, `?globalOnly=true`) for SysAdmin are removed. SysAdmin now sees all rows by default. To narrow:
- `?scope=tenant` → `AND VendorId IS NULL`
- `?scope=vendor` → `AND VendorId IS NOT NULL`
- `?tenantId=<uuid>` → `AND TenantId = @x` (can combine with `?scope=`)
- No params → all rows

### UI changes

**Templates list page and Campaigns list page (`pages/message-center/`):**
- Each row renders a small pill: `Tenant` (gray) or `Vendor` (oe-light/oe-dark). Pill is only meaningful to SysAdmin (TenantAdmin only ever sees `Tenant` rows; VendorAdmin only ever sees `Vendor` rows). For consistency, render the pill in all three portals.
- Above the list, a **scope filter dropdown**: `All` / `Tenant` / `Vendor`. For TenantAdmin and VendorAdmin this dropdown is hidden (their scope is fixed by their role). For SysAdmin it's visible and drives the `?scope=` query param.

**SysAdmin Create Template / Create Campaign modal:**
- New required field at the top: **"Create for"** with two options (radio or segmented control):
  - **Tenant:** picks from a Tenant dropdown. New record has `TenantId = picked, VendorId = NULL`.
  - **Vendor:** **single vendor dropdown** listing all vendors from `oe.Vendors`. Vendors with at least one `oe.Users` row are selectable; vendors with zero users are disabled (grayed out, hover tooltip "No portal users yet"). The TenantId for the new record is inferred from the picked vendor's `oe.Users.TenantId`. No tenant picker is shown for the vendor flow. Revised 2026-05-11 per Amar: vendors are tenant-agnostic entities; `oe.VendorTenantTpaServices` is intentionally not consulted (separate business concern). See [[vendor-tenant-relationship]] memory.

**TenantAdmin Create modal:** unchanged. New record always has `TenantId = req.user.TenantId, VendorId = NULL`. The "Create for" field is not shown.

**VendorAdmin Create modal:** unchanged. New record always has `TenantId = req.user.TenantId, VendorId = req.user.VendorId`. The "Create for" field is not shown.

### Duplicate preserves scope (always)

`POST /api/message-center/templates/:id/duplicate` and `POST /api/message-center/campaigns/:id/duplicate` ALWAYS copy `TenantId` AND `VendorId` from the source row. The caller does not choose a target. Authorization rules:
- VendorAdmin can only duplicate rows in their own scope.
- TenantAdmin can only duplicate rows in their tenant where `VendorId IS NULL`.
- SysAdmin can duplicate any row. If they duplicate a vendor template, the copy is a vendor template (same VendorId).

No more "TenantAdmin duplicates a global" loophole — globals don't exist.

### New endpoint

`GET /api/me/sysadmin/vendors?tenantId=<uuid>` — returns the list of vendors that have at least one user in the given tenant. SysAdmin-only. Used by the "Create for Vendor" cascading dropdown.

### Handler refactor — what gets simpler

In `messageCenter.js` and `campaigns.js`, the previous SysAdmin global-list branches (`wantsAllTenants(req)`, `req.query.globalOnly`) become unused. They can be deleted from the scope-determination flow. The 3-way SELECT-guard pattern in PUT/DELETE/duplicate becomes 2-way (vendor strict, non-vendor permissive — for SysAdmin the row is fetched without TenantId/VendorId constraint; for TenantAdmin with `TenantId = @userTenantId AND VendorId IS NULL`).

### Migration

Follow-up SQL migration file: `sql-changes/2026-05-12-no-global-templates.sql` (date is one day after the first migration so deploy order is unambiguous):

```sql
SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- Backfill: assign all NULL-tenant templates to MightyWELL Health
UPDATE oe.MessageTemplates
   SET TenantId = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'
 WHERE TenantId IS NULL;
-- Expected: 1 row affected (the "Welcome Email" template).

-- Now make the column NOT NULL.
ALTER TABLE oe.MessageTemplates ALTER COLUMN TenantId UNIQUEIDENTIFIER NOT NULL;

COMMIT TRANSACTION;
```

This migration is its own file because:
1. It depends on `2026-05-11-vendor-messaging-scope.sql` having run first (the `VendorId` column it added is referenced by the new visibility model).
2. Separating it makes the rollback story clearer.

### Comparison to the previous plan

| Concern | Previous plan | This design |
|---|---|---|
| Templates storage | New `oe.VendorMessageTemplates` table | Add `VendorId` column to `oe.MessageTemplates` |
| Campaigns storage | New `oe.VendorCampaigns` + `oe.VendorCampaignSteps` | Add `VendorId` column to `oe.Campaigns`; `CampaignSteps` unchanged |
| Backend routes | New `/me/vendor/messaging/*` route files | Existing `/message-center/*` routes get scope helper + expanded `authorize()` |
| Page components | Forked into `pages/vendor/messaging/` | Existing pages reused as-is |
| Layout | New `VendorMessagingLayout` (3 tabs) | New `VendorMessageCenterLayout` (3 tabs) — only this is forked |
| Trigger engine | Required parallel runtime tables + engine fork | No change to engine or runtime tables |
| Lines of new code (rough) | ~2000 | ~400 |
