# Employee-Facing Documents — Design Spec

**Date:** 2026-04-22
**Branch:** `employee-facing-docs`
**Author:** Joey Desai + Claude Opus 4.7

## Summary

Add a third category (`Employee`) to the existing ProposalDocuments system so admins can upload employee-facing document templates (e.g. "Employee Facing (Gold)", "Employee Facing (HSA)"). These templates are distributed to employees by a group's business owner/agent and contain the group's specific product pricing, the employer's per-tier contribution, the employee's out-of-pocket cost per tier, and an enrollment link back to the group's auto-created enrollment link. Generation is one-click (no modal, no form); every field auto-populates from the group's existing data. Documents are never persisted server-side — every download recalculates.

## Goals

- Agents and GroupAdmins can download an employee-facing PDF for any of their groups in one click, directly from the group's Members tab.
- Zero manual input at generation time — all data resolves automatically from the group, its contribution rules, its products, the agent, the tenant, and the group's auto-created enrollment link.
- Templates live in the existing `oe.ProposalDocuments` infrastructure and are uploaded / edited through the same admin modal that handles Business and General templates.
- Employee-category docs never appear in the BusinessProposalModal or SendProposalModal flows (strict category filtering).
- Document builder filters its AutoFillType picker to types that make sense for employee-facing docs, so template authors can't accidentally place fields that won't render.

## Non-Goals

- **Persistence.** No `oe.ProposalSends` row, no Azure Blob upload of the final PDF, no download history. Every click recomputes and streams.
- **Scenario inputs.** No "how many employees currently on X", "switch counts", "projected enrollment" — those are business-sale content that belongs on business proposals only.
- **New tables.** No schema additions beyond a new enum value on `ProposalDocuments.Category`.
- **Retroactive migration of the 23 inactive historical "Employee Facing" docs.** They remain archived (`IsActive=false`, `Category='Business'`). Admins re-upload fresh templates for the new system.
- **Age-banded or tobacco-specific pricing on the PDF.** Reuse the existing default (age=30, tobacco=false) that `ProposalGeneratorService.generateProposalPDF` already applies.

## Scope

One cohesive feature covering five slices:
1. **Schema/category** — extend `ProposalDocuments.Category` to accept `'Employee'`.
2. **Admin UX** — move category control from the in-builder checkmark to the settings modal dropdown (3 options, `General` default). Filter the builder's AutoFillType picker when category is Employee.
3. **Backend** — 8 new AutoFillType identifiers + resolver; a new endpoint that lists applicable Employee docs for a group; a new endpoint that generates the PDF for a (group, employee doc) pair.
4. **Frontend** — new green "Download employee doc" button (or dropdown) on `GroupMembersTab.tsx`, visible to all four roles that share that page.
5. **Tests** — unit tests for the autofill resolver and the applicability computation; a Cypress smoke test covering "agent clicks button, PDF opens in new tab."

## Architecture

### Data model

**Reuse, don't invent.**

```
oe.ProposalDocuments
  Category              nvarchar   — extend allowed values from {Business, General} to {Business, General, Employee}
  IsActive, Name, Description, DocumentId (FK → oe.FileUploads), CreatedBy/Date, ModifiedDate
      (unchanged)

oe.ProposalDocumentProducts        (unchanged)
  ProposalDocumentId   FK
  ProductId            FK          — template ↔ product link (supports many-to-many)
  IsPrimary            bit         — applicability uses this exclusively for Employee docs
  SlotNumber           int

oe.ProposalDocumentTenants         (unchanged) — tenant scoping applies to Employee docs identically

oe.ProposalFields                  (unchanged) — template-placed fields with coordinates & AutoFillType
  AutoFillType         nvarchar    — 8 new values registered (see below)
  LinkType='enrollment_link' + EnrollmentLinkTemplateId — already supported; reused for the bottom enrollment link

oe.GroupProducts                   (unchanged) — GroupId × ProductId × IsActive × IsHidden

oe.GroupContributions              (unchanged) — group contribution rules, tierContributions JSON

oe.EnrollmentLinkTemplates         (unchanged) — auto-created one-per-group (since 2026-04-10, commit c97725e1)
  GroupId, TemplateType='Group'
```

**No schema migration.** `Category` is already free-text `NVARCHAR` with no constraint; we add enum validation at the service layer (`ProposalDocumentService.saveProposalDocument`) to reject anything outside `{General, Business, Employee}`. Historical docs unaffected.

### 8 new AutoFillTypes

| AutoFillType          | Resolves to                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `groupContributionEE` | Employer contribution for EE tier from `GroupContributions.tierContributions.EE` (`$` or `%` handled) |
| `groupContributionES` | Same, ES tier                                                        |
| `groupContributionEC` | Same, EC tier                                                        |
| `groupContributionEF` | Same, EF tier                                                        |
| `employeeCostEE`      | `productPriceEE − groupContributionEE`, clamped at `max($0, …)`       |
| `employeeCostES`      | Same, ES                                                              |
| `employeeCostEC`      | Same, EC                                                              |
| `employeeCostEF`      | Same, EF                                                              |

If the group has no contribution rule for a tier, the contribution resolves to `$0.00` and the employee cost equals the full product price. Percentage-type contributions apply to the product price at resolve time (`contributionDollar = price × percentage`).

### Category-aware field picker

Frontend constant `categoryAllowedAutoFillTypes`:

```ts
const EMPLOYEE_ALLOWED: Set<AutoFillType> = new Set([
  // company / group info
  'companyName', 'companyAddressLine1', 'companyCity', 'companyState', 'companyZip',
  // agent info
  'agentFirstName', 'agentLastName', 'agentPhone', 'agentEmail', 'agentPhoto', 'agentTitle',
  // product info
  'productName', 'productLogo', 'productPriceEE', 'productPriceES', 'productPriceEC', 'productPriceEF',
  // new — group-scoped
  'groupContributionEE', 'groupContributionES', 'groupContributionEC', 'groupContributionEF',
  'employeeCostEE', 'employeeCostES', 'employeeCostEC', 'employeeCostEF',
  // tenant branding
  'tenantLogo', 'tenantName', 'tenantColor',
  // non-autofill "fields" that are always allowed
  'customText', 'customImage', 'staticShape', 'date',
  // enrollment link (the field uses LinkType='enrollment_link', not AutoFillType; always allowed)
]);

function getAllowedAutoFillTypes(category: 'General' | 'Business' | 'Employee'): Set<AutoFillType> {
  if (category === 'Employee') return EMPLOYEE_ALLOWED;
  return ALL_AUTOFILL_TYPES; // General & Business unchanged
}
```

The builder's AutoFillType dropdown filters through this when placing or editing a field. Fields already placed with disallowed types are preserved (never auto-deleted) but render a warning badge `"⚠ Won't populate for Employee category"`.

### Backend

**New service:** `backend/services/employeeFacingDoc.service.js`

```
export async function getApplicableEmployeeDocsForGroup(groupId, tenantId):
  Promise<Array<{proposalDocumentId, name, productId, productName}>>

  1. Load group's active+non-hidden products: SELECT ProductId FROM oe.GroupProducts
     WHERE GroupId=@groupId AND IsActive=1 AND IsHidden=0
  2. Load Employee-category docs visible to this tenant:
     SELECT pd.* FROM oe.ProposalDocuments pd
     JOIN oe.ProposalDocumentTenants pdt ON pdt.ProposalDocumentId=pd.ProposalDocumentId
     WHERE pd.Category='Employee' AND pd.IsActive=1 AND pdt.TenantId=@tenantId
  3. For each doc, load its primary product:
     SELECT ProductId FROM oe.ProposalDocumentProducts
     WHERE ProposalDocumentId=@docId AND IsPrimary=1
  4. Return docs whose primary ProductId is in the group's product set.

export async function generateEmployeeFacingPDF(groupId, proposalDocumentId, requesterUserId):
  Promise<Buffer>

  1. AuthN/Z: verify requester is agent of the group OR group admin OR tenant admin/sysadmin
     of the group's tenant.
  2. Reassert applicability (guard against stale UI): the doc's primary product must be in
     oe.GroupProducts for this group.
  3. Load: group, group.agent, group.tenant, group contributions, primary product + pricing.
  4. Resolve EnrollmentLinkTemplateId for group: SELECT TemplateId FROM oe.EnrollmentLinkTemplates
     WHERE GroupId=@groupId AND TemplateType='Group' AND IsActive=1 (auto-created one).
  5. Build autoFillValues map covering the 8 new types + all existing types the template uses.
  6. Call ProposalGeneratorService.generateProposalPDF(docId, agentId, groupId, companyInfo,
     'EE', false, 30, { enrollmentLinkUrl }, autoFillValues).  Age=30, tobacco=false default.
  7. Return the PDF buffer. DO NOT upload to blob, DO NOT insert into oe.ProposalSends.
```

**New routes:** one set of routes at the group level, protected by a `requireGroupAccess` middleware that accepts all four roles (Agent who owns the group, GroupAdmin assigned to it, TenantAdmin/SysAdmin of the group's tenant).

```
GET  /api/groups/:groupId/employee-docs
     Returns { success, data: [{proposalDocumentId, name, productId, productName}] }

GET  /api/groups/:groupId/employee-docs/:proposalDocumentId/download
     Returns application/pdf stream (inline, not attachment — so it opens in new tab)
     Query params: none
```

Role-specific endpoints were rejected in favor of one generic set because `GroupMembersTab.tsx` is rendered for all four roles and branching fetch URLs per role on the frontend doubles the surface area unnecessarily. The middleware centralizes the "can this user act on this group?" decision in one place (mirrors the pattern already used by `GET /api/groups/:groupId/products`).

**Middleware:** `backend/middleware/requireGroupAccess.js` (new, unless an equivalent already exists — investigate during implementation before creating). Resolves group → tenant, then checks:
- `req.user.userId === group.AgentId` (agent owner), or
- user has `GroupAdmin` role AND is assigned to this group (via whatever `oe.Users.Roles` / group-admin linkage exists), or
- user has `TenantAdmin` or `SysAdmin` role AND `req.user.tenantId === group.TenantId`.

Returns 403 on failure. All other validation (doc category, applicability, etc.) stays in the service.

**Category validation:** `ProposalDocumentService.saveProposalDocument()` enforces:
```js
const ALLOWED_CATEGORIES = new Set(['General', 'Business', 'Employee']);
if (!ALLOWED_CATEGORIES.has(data.category)) throw new Error('Invalid category');
```

### Frontend

**Settings modal — `ProposalDocumentsManagementModal.tsx`**
- Remove the existing in-builder category checkmark (wherever it lives today — exact file TBD during implementation).
- Add a `<select>` with options `General (default)`, `Business`, `Employee` to the form next to Name / Description fields.
- Submit payload includes `category` string.

**Document builder — AutoFillType picker**
- Read the current template's category from props/state.
- Filter dropdown options through `getAllowedAutoFillTypes(category)`.
- Pre-placed fields outside the allowed set render a `⚠ Won't populate` badge but remain editable.

**Group Members tab — new button**

Location: `frontend/src/pages/groups/GroupMembersTab.tsx`, between "Send Message" and "Add Member" in the action button stack (~lines 3390-3523).

Button mechanics:
1. On tab mount, fetch `GET /api/groups/:groupId/employee-docs` and cache with React Query (single hook `useGroupEmployeeDocs(groupId)` usable by all four roles).
2. **0 results** → green button disabled, tooltip `"No employee documents are configured for this group's products."`
3. **1 result** → single green button `Download employee doc` → clicking opens `/api/groups/:groupId/employee-docs/:docId/download` in a new tab (`window.open(downloadUrl, '_blank')`).
4. **N results** → green dropdown button `Download employee doc ▾` → menu with each doc's Name; clicking a menu item opens that doc's download URL in a new tab.

Styling: green to match `text-oe-success` (#4caf50). Because `GroupMembersTab.tsx` is legacy MUI, we use MUI `<Button color="success">` to match surrounding styles (this deviates from the Tailwind-only CLAUDE.md rule, but the file is already an MUI island and mixing would look worse than consistency with neighbors).

**Role coverage:**
Since `GroupMembersTab.tsx` is rendered for Agent, TenantAdmin, SysAdmin, *and* GroupAdmin (via `/group-admin/groups/:groupId` → `GroupDetails` → Members tab), the single insertion point covers all four roles. Because the backend route is one generic set gated by `requireGroupAccess`, the frontend does not branch URLs by role — same endpoint for everyone.

**Download flow (one-click):**
- `<a href={downloadUrl} target="_blank" rel="noopener">` wrapping the MUI button for single-doc case.
- Dropdown items call `window.open(downloadUrl, '_blank')`.
- Backend sets `Content-Disposition: inline; filename="<group-name>-<doc-name>.pdf"` so browsers open rather than download. Employee can then save manually.

### Data flow summary (one generation)

```
User clicks green button
  → Frontend opens `/api/groups/:groupId/employee-docs/:docId/download` in new tab
  → Backend: requireAuth → requireGroupAccess → employeeFacingDoc.service.generateEmployeeFacingPDF()
       → SELECT group, group.agent, group.tenant, GroupContributions, primary product
       → SELECT EnrollmentLinkTemplate for group → resolve URL from short code
       → Build autoFillValues (8 new + all existing types the template references)
       → ProposalGeneratorService.generateProposalPDF(...) returns Buffer
  → Backend streams PDF with `Content-Disposition: inline`
  → Browser renders PDF in new tab, user downloads manually if desired
  → Nothing persists. Next click recomputes.
```

## Error handling

| Condition                                                         | Behavior                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| No products intersect group × employee-docs                       | Button disabled + tooltip                                                    |
| Group has matching doc but no `GroupContributions` row            | Generate; contribution fields render $0, employee cost = full product price |
| Primary product has no pricing for a tier                         | (Assumed not to happen; if it does, render `—` — safe fallback)              |
| Enrollment link template missing for group (shouldn't happen, auto-created) | Generate; any enrollment-link field renders empty, log warning server-side   |
| Requester not authorized                                          | 403 via existing auth middleware                                             |
| `proposalDocumentId` invalid / not Employee category              | 404                                                                          |
| Doc's primary product no longer in group's products (race)        | 409 with message; UI refetches the list                                      |

## Testing

### Unit (backend)

`backend/services/__tests__/employeeFacingDoc.service.test.js`
- `getApplicableEmployeeDocsForGroup`: group with 3 products, 5 employee docs, expect correct intersection.
- `getApplicableEmployeeDocsForGroup`: hidden product in `GroupProducts.IsHidden=1` excluded.
- `getApplicableEmployeeDocsForGroup`: inactive doc excluded, wrong-tenant doc excluded.
- Autofill resolver: $-contribution, %-contribution, missing tier (null → $0), null GroupContributions row (all $0).
- Employee-cost derivation: contribution > price → clamped at $0 (not negative).

`backend/routes/__tests__/employee-docs.download.test.js`
- 200 with `application/pdf` + `Content-Disposition: inline` on happy path.
- 403 when requester has no relation to the group.
- 404 for non-Employee category doc.
- 409 when product was removed from group between list and download.
- No row inserted into `oe.ProposalSends` after success.

### Unit (frontend)

`frontend/src/components/proposals/__tests__/ProposalDocumentsManagementModal.test.tsx`
- Category dropdown shows three options, defaults to General.
- Submit payload includes selected category.

`frontend/src/components/proposals/__tests__/ProposalBuilderFieldPicker.test.tsx` (file may need renaming to match actual picker component)
- Category=Employee filters out business-only types; keeps the 8 new + shared types.
- Category=Business / General show full list.

`frontend/src/pages/groups/__tests__/GroupMembersTab.employeeDoc.test.tsx`
- 0 results → button disabled, tooltip visible.
- 1 result → renders single button, click opens `/api/me/agent/groups/.../download` in new tab (spy on `window.open`).
- N results → renders dropdown with N items, each with correct download URL.
- GroupAdmin role uses `/api/me/group-admin/...` URL prefix.

### E2E (Cypress)

`frontend/cypress/e2e/employee-facing-doc-download.cy.ts`
- Log in as seeded agent, open My Groups, select group with 1 employee doc, click button, assert new tab URL hits download endpoint, assert PDF Content-Type.
- Verify no `ProposalSends` DB row after the click (DB assertion via cypress-task).

## Rollout

1. **Migration:** none.
2. **Seed data:**
   - Admin manually uploads the 4 production templates (gold / silver / HSA / base) via the updated settings modal with `Category='Employee'`.
   - Admin places ProposalFields inside each template using the filtered picker; positions the enrollment link field at the bottom.
   - Admin sets each template's `ProposalDocumentProducts` entry with the correct primary product.
3. **Testing environment:** no GroupAdmin user exists in `allaboard-testing` today. During implementation we add a one-off seed script / insert to create `groupadmin@allaboard365.com` (Roles='GroupAdmin', pointed at one existing test group) so the role can be exercised.
4. **Rollback:** revert the feature branch; admin-uploaded Employee docs become invisible (no UI consumes them) but remain in DB harmlessly.

## File changes (summary)

### New files
- `backend/services/employeeFacingDoc.service.js`
- `backend/services/__tests__/employeeFacingDoc.service.test.js`
- `backend/routes/groups.employee-docs.js` (or extended into existing `backend/routes/groups.js` — decide during implementation)
- `backend/middleware/requireGroupAccess.js` (unless equivalent already exists)
- `backend/routes/__tests__/employee-docs.download.test.js`
- `frontend/src/hooks/groups/useGroupEmployeeDocs.ts`
- `frontend/src/pages/groups/__tests__/GroupMembersTab.employeeDoc.test.tsx`
- `frontend/cypress/e2e/employee-facing-doc-download.cy.ts`

### Modified files
- `backend/services/proposalDocument.service.js` — add `Employee` to allowed categories, throw on unknown.
- `backend/services/proposalGenerator.service.js` — register the 8 new AutoFillType resolvers.
- `backend/app.js` — mount the two new routers.
- `frontend/src/components/proposals/ProposalDocumentsManagementModal.tsx` — category dropdown, 3 options.
- `frontend/src/components/proposals/<builder-field-picker>.tsx` — category-aware filter (exact filename resolved during implementation).
- `frontend/src/pages/groups/GroupMembersTab.tsx` — add green button / dropdown.
- `frontend/src/services/proposal.service.ts` — add `category: 'Employee'` to type union.
- `frontend/src/constants/proposalAutoFillTypes.ts` (or similar) — register 8 new identifiers + `categoryAllowedAutoFillTypes` map.

## Open items (tactical, resolved during implementation)

- Exact file that currently hosts the in-builder category checkmark (to move/remove it).
- Exact current filename of the AutoFillType picker component.
- Exact field-name conventions for existing pricing autofills (`productPriceEE` is assumed; real name may differ slightly — e.g. `productPrice_EE`).
