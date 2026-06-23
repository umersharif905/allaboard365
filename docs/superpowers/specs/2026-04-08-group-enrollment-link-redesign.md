# Group Enrollment Link Redesign

## Problem

Two independent sources of truth for which products a group offers:
1. `oe.GroupProducts` — the actual products assigned to a group
2. `oe.EnrollmentLinkTemplates.LinkMetaData.products` — a JSON blob that independently lists products for the enrollment wizard

These can drift apart, causing members to see products during enrollment that differ from what the group actually offers.

## Design

### Core Change
For group-type enrollment links, the EnrollmentWizard pulls products from `oe.GroupProducts` at runtime instead of from `LinkMetaData.products`. The template still holds household settings (collectSSN, collectDOB, etc.) but products are never stored on it for group links.

### Auto-Generation
When the first product is added to a group via GroupProductsTab, an enrollment link template is auto-generated with:
- `TemplateType = 'Group'`
- `GroupId` set to the group
- `LinkMetaData` containing only household settings (defaults: all false)
- `IsActive = 1`

If a template already exists for the group, no new one is created.

### Backend Changes

**1. Enrollment data endpoint** (`/api/enrollment-links/:linkToken/enrollment-data`):
- When template has `TemplateType = 'Group'` and a `GroupId`:
  - Query `oe.GroupProducts gp JOIN oe.Products p ON gp.ProductId = p.ProductId WHERE gp.GroupId = @groupId AND gp.IsActive = 1`
  - Organize products into sections by `p.ProductType`
  - Ignore `LinkMetaData.products` entirely
- When template is Individual: existing behavior unchanged

**2. Group products route** (`/api/groups/:groupId/products` PUT):
- After updating group products, check if a group enrollment link template exists
- If no template exists and products were added, auto-generate one
- No sync of LinkMetaData needed since products are pulled at runtime

### Frontend Changes

**1. Enrollment Links tab** (agent/tenant-admin):
- Remove the group/individual filter toggle
- Only show Individual-type templates
- Remove ability to create group-type enrollment link templates
- Hide any existing group templates from the list

**2. GroupProductsTab**:
- Show enrollment link URL as read-only (copyable)
- Add collapsible "Enrollment Settings" section with toggles for household fields (collectSSN, collectDOB, collectGender, collectAddress, collectPhone)
- Saving enrollment settings updates `LinkMetaData.household` on the template
- Remove any "edit enrollment link" buttons/flows
- If no template exists yet (no products), show nothing

**3. EnrollmentLinkWizard** (template creation/editing):
- When creating: only allow `TemplateType = 'Individual'`
- Remove group-type option from template creation flow

### What Stays The Same
- Individual enrollment links: fully unchanged
- `LinkMetaData.household` settings: still stored on template, still used by wizard
- Enrollment submission flow: unchanged
- Member enrollment experience: unchanged (they see products, select, enroll)

### Product Section Organization
Products organized into sections by `ProductType` field from `oe.Products` table:
- Page name derived from ProductType (e.g., "Healthcare" -> "Healthcare Plans")
- Products within a section ordered by product name
- Bundles grouped into their own section
