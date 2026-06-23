# Group Products: stop catalog-hidden products from leaking into the per-group "Removed" UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catalog-hidden products (`oe.Products.IsHidden = 1`) must never appear as "Removed / Add Back" rows in the per-group product UIs, and the Add Back button must never silently no-op on a catalog-hidden row.

**Architecture:** The bug is a flag collapse on the backend. `GET /api/groups/:groupId/products` returns the assigned-products row with `IsHidden = (GroupProducts.IsHidden) || (Products.IsHidden)`, conflating "this group removed it" with "the catalog hid it". The frontend reads that single field and renders any truthy value as "Removed" with an Add Back button that PATCHes only `GroupProducts.IsHidden`. After PATCH the catalog flag still wins on refetch, so the row keeps looking removed. Fix: split the two flags on the backend response, then drop catalog-hidden rows from both Group product UIs (active table + edit-modal selected list).

**Tech Stack:** Express + mssql backend, React 18 + TypeScript frontend, Jest (backend), Vitest (frontend), Tailwind for UI. No DB schema changes.

---

## File Structure

**Backend (1 file modified, 1 file added)**
- `backend/routes/groupProducts.js` — `GET /:groupId/products` response shape: split `IsHidden` into `IsHidden` (per-group) and `IsCatalogHidden` (catalog) on each `groupProducts[]` row.
- `backend/routes/__tests__/groupProducts.getProducts.flags.test.js` — new Jest test file pinning the split.

**Frontend (2 files modified)**
- `frontend/src/pages/groups/GroupsAddGroup.tsx` — propagate `IsCatalogHidden` through the two `setSelectedProductsData` mappers; drop catalog-hidden rows from the rendered Selected Products list.
- `frontend/src/pages/groups/GroupProductsTab.tsx` — extend the `filteredGroupProducts` filter to also drop catalog-hidden rows from the active products table.

**Out of scope (intentional):**
- The `hidden-with-enrollments` audit query already filters by `gp.IsHidden = 1` (per-group only). It's correct as-is — catalog-hidden products don't belong in that audit either.
- The picker modal (`fetchProductsForTenant`) already excludes catalog-hidden products via the `includeHidden` filter on `Products.IsHidden`. No change needed.
- `PATCH /products/:productId/visibility` and the bulk PUT — both touch only `GroupProducts.IsHidden`, which is the correct semantic. After the response shape fix, the user no longer sees the silent no-op because catalog-hidden rows aren't surfaced.

---

## Task 1: Backend — split `IsHidden` and `IsCatalogHidden` on the assigned-products response

**Files:**
- Modify: `backend/routes/groupProducts.js:523`
- Test: `backend/routes/__tests__/groupProducts.getProducts.flags.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/routes/__tests__/groupProducts.getProducts.flags.test.js`:

```javascript
/**
 * GET /api/groups/:groupId/products — IsHidden / IsCatalogHidden split.
 *
 * Each assigned-product row must expose two distinct flags:
 *   IsHidden        = oe.GroupProducts.IsHidden (per-group "removed")
 *   IsCatalogHidden = oe.Products.IsHidden      (global "hide from groups")
 *
 * Run: npx jest routes/__tests__/groupProducts.getProducts.flags
 */

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.error.mockRestore?.();
  console.warn.mockRestore?.();
});

const express = require('express');
const supertest = require('supertest');

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  sql: {
    NVarChar: 'NVarChar',
    UniqueIdentifier: 'UniqueIdentifier',
    Bit: 'Bit',
    Int: 'Int',
    DateTime2: 'DateTime2'
  }
}));

jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, res, next) => next(),
  requireTenantAccess: (req, res, next) => {
    req.tenantId = req.user?.TenantId || 'tenant-1';
    next();
  },
  getUserRoles: jest.fn((user) => user?.roles || ['TenantAdmin'])
}));

jest.mock('../uploads', () => ({
  authenticateUrls: jest.fn(async (obj) => obj),
  authenticateProductDocumentsArray: jest.fn(async (arr) => arr)
}));
jest.mock('../../services/shared/product-documents.service', () => ({
  getProductDocumentsForProductIds: jest.fn(async () => new Map())
}));
jest.mock('../../services/vendorGroupAccessService', () => ({
  vendorUserServesGroup: jest.fn()
}));
jest.mock('../../utils/groupRouteAccess', () => ({
  appendGroupScopeForTenantUsers: jest.fn((q) => q)
}));

function buildApp() {
  const router = require('../groupProducts');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { UserId: 'user-1', TenantId: 'tenant-1', roles: ['TenantAdmin'] };
    next();
  });
  app.use('/api/groups', router);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockInput.mockReturnThis();
  jest.clearAllMocks();
  mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
});

describe('GET /:groupId/products — IsHidden / IsCatalogHidden split', () => {
  test('per-group hidden + catalog visible → IsHidden=1, IsCatalogHidden=0', async () => {
    // Sequence: group lookup, available products, group products
    mockQuery
      .mockResolvedValueOnce({ recordset: [{ GroupId: 'g1', TenantId: 't1', Name: 'G', Status: 'Active' }] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({
        recordset: [{
          GroupProductId: 'gp1', GroupId: 'g1', ProductId: 'p1',
          IsActive: true, CustomSettings: null,
          CreatedDate: null, ModifiedDate: null, CreatedBy: null, ModifiedBy: null,
          GroupProductIsHidden: 1,
          Name: 'PerGroupHidden', ProductType: 'Healthcare', Description: '',
          ProductStatus: 'Active', MinAge: 0, MaxAge: 65, SalesType: 'Both',
          IsHidden: 0, IsBundle: 0,
          AllowedStates: null, ProductImageUrl: null, ProductLogoUrl: null,
          ProductDocumentUrl: null, RequiredDataFields: null,
          ProductOwner: 'Owner', BasePrice: 0
        }]
      });

    const res = await supertest(buildApp()).get('/api/groups/g1/products');
    expect(res.status).toBe(200);
    const row = res.body.data.groupProducts[0];
    expect(row.IsHidden).toBe(1);
    expect(row.IsCatalogHidden).toBe(0);
  });

  test('per-group visible + catalog hidden → IsHidden=0, IsCatalogHidden=1', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [{ GroupId: 'g1', TenantId: 't1', Name: 'G', Status: 'Active' }] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({
        recordset: [{
          GroupProductId: 'gp1', GroupId: 'g1', ProductId: 'p1',
          IsActive: true, CustomSettings: null,
          CreatedDate: null, ModifiedDate: null, CreatedBy: null, ModifiedBy: null,
          GroupProductIsHidden: 0,
          Name: 'CatalogHidden', ProductType: 'Healthcare', Description: '',
          ProductStatus: 'Active', MinAge: 0, MaxAge: 65, SalesType: 'Both',
          IsHidden: 1, IsBundle: 0,
          AllowedStates: null, ProductImageUrl: null, ProductLogoUrl: null,
          ProductDocumentUrl: null, RequiredDataFields: null,
          ProductOwner: 'Owner', BasePrice: 0
        }]
      });

    const res = await supertest(buildApp()).get('/api/groups/g1/products');
    expect(res.status).toBe(200);
    const row = res.body.data.groupProducts[0];
    expect(row.IsHidden).toBe(0);
    expect(row.IsCatalogHidden).toBe(1);
  });

  test('both flags set → IsHidden=1, IsCatalogHidden=1', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [{ GroupId: 'g1', TenantId: 't1', Name: 'G', Status: 'Active' }] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({
        recordset: [{
          GroupProductId: 'gp1', GroupId: 'g1', ProductId: 'p1',
          IsActive: true, CustomSettings: null,
          CreatedDate: null, ModifiedDate: null, CreatedBy: null, ModifiedBy: null,
          GroupProductIsHidden: 1,
          Name: 'Both', ProductType: 'Healthcare', Description: '',
          ProductStatus: 'Active', MinAge: 0, MaxAge: 65, SalesType: 'Both',
          IsHidden: 1, IsBundle: 0,
          AllowedStates: null, ProductImageUrl: null, ProductLogoUrl: null,
          ProductDocumentUrl: null, RequiredDataFields: null,
          ProductOwner: 'Owner', BasePrice: 0
        }]
      });

    const res = await supertest(buildApp()).get('/api/groups/g1/products');
    expect(res.status).toBe(200);
    const row = res.body.data.groupProducts[0];
    expect(row.IsHidden).toBe(1);
    expect(row.IsCatalogHidden).toBe(1);
  });

  test('neither flag → IsHidden=0, IsCatalogHidden=0', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [{ GroupId: 'g1', TenantId: 't1', Name: 'G', Status: 'Active' }] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({
        recordset: [{
          GroupProductId: 'gp1', GroupId: 'g1', ProductId: 'p1',
          IsActive: true, CustomSettings: null,
          CreatedDate: null, ModifiedDate: null, CreatedBy: null, ModifiedBy: null,
          GroupProductIsHidden: 0,
          Name: 'Visible', ProductType: 'Healthcare', Description: '',
          ProductStatus: 'Active', MinAge: 0, MaxAge: 65, SalesType: 'Both',
          IsHidden: 0, IsBundle: 0,
          AllowedStates: null, ProductImageUrl: null, ProductLogoUrl: null,
          ProductDocumentUrl: null, RequiredDataFields: null,
          ProductOwner: 'Owner', BasePrice: 0
        }]
      });

    const res = await supertest(buildApp()).get('/api/groups/g1/products');
    expect(res.status).toBe(200);
    const row = res.body.data.groupProducts[0];
    expect(row.IsHidden).toBe(0);
    expect(row.IsCatalogHidden).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest routes/__tests__/groupProducts.getProducts.flags`
Expected: tests fail (the response currently has `IsHidden: gp.GroupProductIsHidden || gp.IsHidden ? 1 : 0` and no `IsCatalogHidden`).

- [ ] **Step 3: Edit the response mapping**

In `backend/routes/groupProducts.js`, locate the assigned-products map at line 523. Replace the single `IsHidden:` line with two fields. The original is:

```javascript
IsHidden: gp.GroupProductIsHidden || gp.IsHidden ? 1 : 0,
```

Change it to:

```javascript
IsHidden: gp.GroupProductIsHidden ? 1 : 0,
IsCatalogHidden: gp.IsHidden ? 1 : 0,
```

Leave `availableProducts` (line 387) unchanged — that list already represents catalog `Products.IsHidden` correctly and is filtered upstream by `hiddenProductsFilter`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest routes/__tests__/groupProducts.getProducts.flags`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Run the existing groupProducts test files to verify no regressions**

Run:
```
cd backend && npx jest routes/__tests__/groupProducts.toggleHidden.test.js \
                       routes/__tests__/groupProducts.readdUnhides.test.js \
                       routes/__tests__/groupProducts.enrollmentCount.test.js \
                       routes/__tests__/groupProducts.hiddenWithEnrollments.test.js
```
Expected: all pass.

- [ ] **Step 6: Commit**

```
git add backend/routes/groupProducts.js \
        backend/routes/__tests__/groupProducts.getProducts.flags.test.js
git commit -m "fix(groups): split IsHidden into per-group + IsCatalogHidden on assigned-products response"
```

---

## Task 2: Frontend — propagate `IsCatalogHidden` through `selectedProductsData`

**Files:**
- Modify: `frontend/src/pages/groups/GroupsAddGroup.tsx` (two `setSelectedProductsData` map sites)

The Selected Products list in the edit modal renders from `selectedProductsData`. Today the mappers at lines ~455–466 (`processGroupProductsData`) and ~1110–1121 (`fetchGroupProducts`) copy `IsHidden` only. After Task 1 the backend exposes `IsCatalogHidden`; we need to carry it through so Task 3 can filter on it.

- [ ] **Step 1: Update `processGroupProductsData` mapper**

Read the current block at `frontend/src/pages/groups/GroupsAddGroup.tsx:455-466`. The original is:

```typescript
setSelectedProductsData(filteredSelectedProducts.map((gp: any) => ({
  ProductId: gp.ProductId,
  Name: gp.Name || gp.ProductName,
  ProductType: gp.ProductType,
  Description: gp.Description,
  ProductImageUrl: gp.ProductImageUrl,
  ProductLogoUrl: gp.ProductLogoUrl,
  ProductOwner: gp.ProductOwner,
  IsHidden: gp.IsHidden,
  IsBundle: gp.IsBundle,
  SalesType: gp.SalesType || gp.salesType
})));
```

Add `IsCatalogHidden: gp.IsCatalogHidden ?? 0,` directly under `IsHidden:`. Final block:

```typescript
setSelectedProductsData(filteredSelectedProducts.map((gp: any) => ({
  ProductId: gp.ProductId,
  Name: gp.Name || gp.ProductName,
  ProductType: gp.ProductType,
  Description: gp.Description,
  ProductImageUrl: gp.ProductImageUrl,
  ProductLogoUrl: gp.ProductLogoUrl,
  ProductOwner: gp.ProductOwner,
  IsHidden: gp.IsHidden,
  IsCatalogHidden: gp.IsCatalogHidden ?? 0,
  IsBundle: gp.IsBundle,
  SalesType: gp.SalesType || gp.salesType
})));
```

- [ ] **Step 2: Update `fetchGroupProducts` mapper (the second call site)**

Read the block at `frontend/src/pages/groups/GroupsAddGroup.tsx:1110-1121`. It has the same shape as Step 1's pre-state. Apply the same insertion: add `IsCatalogHidden: gp.IsCatalogHidden ?? 0,` directly under the `IsHidden: gp.IsHidden,` line.

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```
git add frontend/src/pages/groups/GroupsAddGroup.tsx
git commit -m "fix(groups): carry IsCatalogHidden through selectedProductsData mappers"
```

---

## Task 3: Frontend — drop catalog-hidden rows from the Selected Products list

**Files:**
- Modify: `frontend/src/pages/groups/GroupsAddGroup.tsx` (helper near line 151 + filter near line 1985)

Currently the list filter resolves a row, then renders it with a "Removed" pill if `IsHidden` is truthy. Even after Task 1 splits the flags, a catalog-hidden row would still pass through this list — it just wouldn't be marked "Removed" anymore (which is wrong too: it would look fully active and re-deletable). The correct behavior is to omit catalog-hidden saved rows from the list entirely.

- [ ] **Step 1: Add an `isProductCatalogHidden` helper**

Read the existing helper at `frontend/src/pages/groups/GroupsAddGroup.tsx:151-154`:

```typescript
const isProductHiddenForGroup = (p: any) =>
  p.IsHidden === true || p.IsHidden === 1 ||
  p.isHidden === true || p.isHidden === 1 ||
  p.IsHidden === 'true' || p.isHidden === 'true';
```

Add a sibling helper directly below it:

```typescript
const isProductCatalogHidden = (p: any) =>
  p.IsCatalogHidden === true || p.IsCatalogHidden === 1 ||
  p.isCatalogHidden === true || p.isCatalogHidden === 1 ||
  p.IsCatalogHidden === 'true' || p.isCatalogHidden === 'true';
```

- [ ] **Step 2: Update the Selected Products list filter to drop catalog-hidden rows**

Read the IIFE block at `frontend/src/pages/groups/GroupsAddGroup.tsx:1970-1985`. The current `.map(...)` over `selectedProducts` resolves each ID into `{ productId, product, isSavedToGroup, removed }` and then `.filter(item => item != null)`. Modify the filter so it also drops catalog-hidden saved rows. The original filter line is:

```typescript
.filter((item): item is { productId: string; product: any; isSavedToGroup: boolean; removed: boolean } => item != null);
```

Replace it with:

```typescript
.filter((item): item is { productId: string; product: any; isSavedToGroup: boolean; removed: boolean } => {
  if (item == null) return false;
  // Catalog-hidden products (Products.IsHidden = 1) are bundle-only / retired and
  // must never appear here as either an active row or a "Removed / Add Back" row —
  // the agent has no legitimate way to re-attach them at the catalog level.
  const groupProduct = selectedProductsData.find(p => p.ProductId === item.productId);
  if (item.isSavedToGroup && groupProduct && isProductCatalogHidden(groupProduct)) return false;
  return true;
});
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```
git add frontend/src/pages/groups/GroupsAddGroup.tsx
git commit -m "fix(groups): exclude catalog-hidden products from Selected Products list"
```

---

## Task 4: Frontend — drop catalog-hidden rows from the active Group Products table

**Files:**
- Modify: `frontend/src/pages/groups/GroupProductsTab.tsx` (helper near line 39 + filter at line 280)

After Task 1, `IsHidden` on the GET response is per-group only, so the existing filter at line 280 (`if (isProductHiddenForGroup(product)) return false;`) no longer suppresses catalog-hidden rows — they would surface in the active table with a working Delete icon. Add an explicit catalog-hidden check.

- [ ] **Step 1: Add a sibling `isProductCatalogHidden` helper**

Read the existing helper at `frontend/src/pages/groups/GroupProductsTab.tsx:38-42`:

```typescript
/** Same visibility rules as GroupsAddGroup — assigned group products may be catalog-hidden */
const isProductHiddenForGroup = (p: any) =>
  p.IsHidden === true || p.IsHidden === 1 ||
  p.isHidden === true || p.isHidden === 1 ||
  p.IsHidden === 'true' || p.isHidden === 'true';
```

Add directly below:

```typescript
/** Catalog-level hide (Products.IsHidden) — distinct from per-group GroupProducts.IsHidden. */
const isProductCatalogHidden = (p: any) =>
  p.IsCatalogHidden === true || p.IsCatalogHidden === 1 ||
  p.isCatalogHidden === true || p.isCatalogHidden === 1 ||
  p.IsCatalogHidden === 'true' || p.isCatalogHidden === 'true';
```

- [ ] **Step 2: Update the active products filter**

Read `frontend/src/pages/groups/GroupProductsTab.tsx:277-286`. The original filter is:

```typescript
const filteredGroupProducts = groupProducts.filter((product: any) => {
  // Hidden products live in the separate "Products with Active Enrollments"
  // section below; the active list never shows them.
  if (isProductHiddenForGroup(product)) return false;
  const matchesSearch = !searchTerm ||
    product.Name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    product.Description?.toLowerCase().includes(searchTerm.toLowerCase());
  const matchesType = !selectedProductType || product.ProductType === selectedProductType;
  return matchesSearch && matchesType;
}).sort(...);
```

Add a second `if` directly below the per-group check:

```typescript
const filteredGroupProducts = groupProducts.filter((product: any) => {
  // Hidden products live in the separate "Products with Active Enrollments"
  // section below; the active list never shows them.
  if (isProductHiddenForGroup(product)) return false;
  // Catalog-hidden (Products.IsHidden) products are bundle-only / retired —
  // never surface them as standalone manageable rows, even if a stale
  // GroupProducts row points at one.
  if (isProductCatalogHidden(product)) return false;
  const matchesSearch = !searchTerm ||
    product.Name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    product.Description?.toLowerCase().includes(searchTerm.toLowerCase());
  const matchesType = !selectedProductType || product.ProductType === selectedProductType;
  return matchesSearch && matchesType;
}).sort(...);
```

(Leave the existing `.sort(...)` call unchanged.)

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```
git add frontend/src/pages/groups/GroupProductsTab.tsx
git commit -m "fix(groups): exclude catalog-hidden products from active Products table"
```

---

## Task 5: Manual verification

The bug surfaces only with real data (a group with a `GroupProducts` row whose `Products.IsHidden = 1`). Automated coverage exists for the backend split (Task 1); the frontend filters are simple enough that we can verify with one walkthrough rather than mounting the 3000-line modal under Vitest.

- [ ] **Step 1: Start the dev servers**

```
# terminal A
cd backend && node app.js
# terminal B
cd frontend && npm run dev
```

- [ ] **Step 2: Pick a target group**

Use one of AJ's groups that previously surfaced the bug. If you need to confirm which groups are affected, run:

```
ai_scripts/db-query.sh "
  SELECT TOP 20 g.GroupId, g.Name AS GroupName, p.ProductId, p.Name AS ProductName,
         gp.IsHidden AS GroupHidden, p.IsHidden AS CatalogHidden
  FROM oe.GroupProducts gp
  INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
  INNER JOIN oe.Groups   g ON g.GroupId   = gp.GroupId
  WHERE gp.IsActive = 1 AND p.IsHidden = 1
  ORDER BY g.Name
" --testing
```

(Use `--alt` only if you need to inspect production state; do not edit prod rows.)

- [ ] **Step 3: Open the Group → Products tab as Agent**

Verify:
- The active Products table does NOT include any catalog-hidden product surfaced by the query above.
- Click "Add Product" → the edit modal opens in products-only mode.
- The Selected Products list does NOT show those products as "Removed" with an "Add Back" button.
- Per-group-deleted products (with `GroupProducts.IsHidden = 1` and `Products.IsHidden = 0`) DO still show as "Removed" with a working "Add Back" button.

- [ ] **Step 4: Confirm Add Back still works on a genuinely soft-deleted product**

Pick a group product, delete it from the active table (use the Delete icon, confirm). Reopen Add Product. The product should appear under Selected Products as "Removed" with "Add Back". Click Add Back. Verify the row flips back to active without a page refresh, and reopening the modal still shows it as active.

- [ ] **Step 5: Push the branch (do NOT open a PR yet)**

```
git push -u origin fix/group-products-catalog-hidden-leak
```

Wait for explicit approval before running `gh pr create`.
