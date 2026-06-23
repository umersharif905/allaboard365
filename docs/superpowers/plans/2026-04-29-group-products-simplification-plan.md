# Group Products Tab Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the Group Products tab by replacing per-row ASA pills with a single banner and replacing the Hide/Show toggle with an Agent/Tenant-only "Delete" button, plus adding a read-only "Products with Active Enrollments" section. Group admins lose all visibility controls.

**Architecture:** Backend reuses `GroupProducts.IsHidden` as the soft-delete flag — no schema changes. Two new GET endpoints surface enrollment counts and the hidden-with-enrollments list. The existing PATCH visibility endpoint is reused for delete (it already excludes Group Admins via `authorize(['SysAdmin', 'TenantAdmin', 'Agent'])`). The existing add-product UPDATE branch flips `IsHidden = 0` so re-add is automatic. Frontend extracts three new components (`ASARequiredBanner`, `DeleteProductConfirmModal`, `HiddenProductsSection`) and refactors `GroupProductsTab.tsx` to consume them.

**Tech Stack:** Express + MSSQL (backend); React 18 + TypeScript + TanStack Query + Tailwind + Lucide icons (frontend); Jest (backend tests); Vitest (frontend unit tests); Cypress (e2e).

**Spec:** `docs/superpowers/specs/2026-04-29-group-products-simplification-design.md`

**Branch:** `group-updates/hide-clearity` (already checked out — work directly on this branch).

---

## File Structure

**Backend — modify:**
- `backend/routes/groupProducts.js`
  - **No-op (already correct):** PATCH `/:groupId/products/:productId/visibility` already excludes Group Admin via `authorize(['SysAdmin', 'TenantAdmin', 'Agent'])` (line 1034). No change needed.
  - **Add:** GET `/:groupId/products/:productId/enrollment-count`
  - **Add:** GET `/:groupId/products/hidden-with-enrollments`
  - **Modify:** UPDATE branch in the bulk assignment endpoint (~lines 711–718) — add `IsHidden = 0` to the SET clause so re-add un-hides automatically.

**Backend — new tests:**
- `backend/routes/__tests__/groupProducts.enrollmentCount.test.js`
- `backend/routes/__tests__/groupProducts.hiddenWithEnrollments.test.js`
- `backend/routes/__tests__/groupProducts.readdUnhides.test.js`

**Frontend — new files:**
- `frontend/src/components/groups/ASARequiredBanner.tsx`
- `frontend/src/components/groups/DeleteProductConfirmModal.tsx`
- `frontend/src/components/groups/HiddenProductsSection.tsx`
- `frontend/src/hooks/groups/useHiddenProductsWithEnrollments.ts`
- `frontend/src/hooks/groups/useGroupProductEnrollmentCount.ts`
- `frontend/src/components/groups/__tests__/ASARequiredBanner.test.tsx`
- `frontend/src/components/groups/__tests__/DeleteProductConfirmModal.test.tsx`
- `frontend/src/components/groups/__tests__/HiddenProductsSection.test.tsx`

**Frontend — modify:**
- `frontend/src/services/group-products.service.ts` — add `getEnrollmentCount`, `getHiddenWithEnrollments` service methods, extend `deleteFromGroup` (alias of existing visibility setter to `isHidden: true`).
- `frontend/src/pages/groups/GroupProductsTab.tsx`:
  - Remove the per-row ASA pill column (lines 158–218 region) and the bundle-subproduct ASA badge (~lines 667–716).
  - Remove the "Show hidden products" checkbox (lines 437–452).
  - Replace per-row Hide/Show toggle (lines 594–640) with a Delete button gated to Agent/Tenant.
  - Render `ASARequiredBanner` at top.
  - Render `HiddenProductsSection` below the active products list (Agent/Tenant only).
  - Wire `DeleteProductConfirmModal` to the Delete button.

**Cypress — new specs:**
- `frontend/cypress/e2e/groups/group-products-delete.cy.ts`
- `frontend/cypress/e2e/groups/group-products-delete-with-enrollments.cy.ts`
- `frontend/cypress/e2e/groups/group-products-asa-banner.cy.ts`
- `frontend/cypress/e2e/groups/group-products-group-admin-permissions.cy.ts`

---

## Task 1: Backend — GET enrollment count endpoint

**Files:**
- Modify: `backend/routes/groupProducts.js` (insert new route handler after the existing PATCH visibility handler, around line 1107)
- Test: `backend/routes/__tests__/groupProducts.enrollmentCount.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/routes/__tests__/groupProducts.enrollmentCount.test.js`:

```javascript
/**
 * GET /api/groups/:groupId/products/:productId/enrollment-count
 *
 * Returns the count of active enrollments for the given product within the group.
 * Used by the Delete confirmation modal to show "N members are currently enrolled".
 *
 * Run: npx jest routes/__tests__/groupProducts.enrollmentCount
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
  authenticateUrls: jest.fn(),
  authenticateProductDocumentsArray: jest.fn()
}));
jest.mock('../../services/shared/product-documents.service', () => ({
  getProductDocumentsForProductIds: jest.fn()
}));
jest.mock('../../services/vendorGroupAccessService', () => ({
  vendorUserServesGroup: jest.fn()
}));
jest.mock('../../utils/groupRouteAccess', () => ({
  appendGroupScopeForTenantUsers: jest.fn()
}));

function buildApp() {
  const router = require('../groupProducts');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { UserId: 'user-1', TenantId: 'tenant-1', roles: ['Agent'] };
    next();
  });
  app.use('/api/groups', router);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockInput.mockClear();
  mockRequest.mockClear();
});

describe('GET /api/groups/:groupId/products/:productId/enrollment-count', () => {
  test('returns 0 when no active enrollments exist', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [{ count: 0 }] });
    const app = buildApp();
    const res = await supertest(app)
      .get('/api/groups/group-1/products/product-1/enrollment-count')
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { count: 0 } });
  });

  test('returns the active enrollment count', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [{ count: 7 }] });
    const app = buildApp();
    const res = await supertest(app)
      .get('/api/groups/group-1/products/product-1/enrollment-count')
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { count: 7 } });
  });

  test('returns 500 on database error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp();
    const res = await supertest(app)
      .get('/api/groups/group-1/products/product-1/enrollment-count')
      .expect(500);
    expect(res.body.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest routes/__tests__/groupProducts.enrollmentCount`
Expected: FAIL — endpoint not registered, returns 404.

- [ ] **Step 3: Implement the route handler**

In `backend/routes/groupProducts.js`, insert this handler immediately after the closing `});` of the PATCH visibility handler (after line 1106):

```javascript
// GET /:groupId/products/:productId/enrollment-count
// Returns the count of active enrollments for the given product within the group.
// Used by the Delete confirmation modal to show "N members are currently enrolled".
// Auth: SysAdmin, TenantAdmin, Agent (Group Admin denied).
router.get('/:groupId/products/:productId/enrollment-count', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId, productId } = req.params;
        const pool = await getPool();

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('productId', sql.UniqueIdentifier, productId)
            .query(`
                SELECT COUNT(*) AS count
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON m.MemberId = e.MemberId
                WHERE m.GroupId = @groupId
                  AND e.ProductId = @productId
                  AND e.Status = 'Active'
            `);

        const count = result.recordset?.[0]?.count ?? 0;
        res.json({ success: true, data: { count } });
    } catch (error) {
        console.error('Error fetching enrollment count:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch enrollment count' });
    }
});
```

> **Note on schema:** Verify the actual table/column names by reading `backend/routes/enrollment-links.js` lines 1358–1359 (the existing `IsHidden` filter join) — it shows the canonical Enrollments ↔ Members ↔ Groups join. If `e.Status` is stored as something other than `'Active'` (e.g., `IsActive` flag), match the convention used by the enrollment-links query.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest routes/__tests__/groupProducts.enrollmentCount`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/groupProducts.js backend/routes/__tests__/groupProducts.enrollmentCount.test.js
git commit -m "feat(groups): add enrollment count endpoint for delete modal"
```

---

## Task 2: Backend — GET hidden-with-enrollments endpoint

**Files:**
- Modify: `backend/routes/groupProducts.js` (insert new route handler after Task 1's handler)
- Test: `backend/routes/__tests__/groupProducts.hiddenWithEnrollments.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/routes/__tests__/groupProducts.hiddenWithEnrollments.test.js`:

```javascript
/**
 * GET /api/groups/:groupId/products/hidden-with-enrollments
 *
 * Returns hidden products (GroupProducts.IsHidden = 1) that still have at least
 * one active enrollment. Powers the "Products with Active Enrollments" section.
 *
 * Run: npx jest routes/__tests__/groupProducts.hiddenWithEnrollments
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
  authenticateUrls: jest.fn(),
  authenticateProductDocumentsArray: jest.fn()
}));
jest.mock('../../services/shared/product-documents.service', () => ({
  getProductDocumentsForProductIds: jest.fn()
}));
jest.mock('../../services/vendorGroupAccessService', () => ({
  vendorUserServesGroup: jest.fn()
}));
jest.mock('../../utils/groupRouteAccess', () => ({
  appendGroupScopeForTenantUsers: jest.fn()
}));

function buildApp() {
  const router = require('../groupProducts');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { UserId: 'user-1', TenantId: 'tenant-1', roles: ['Agent'] };
    next();
  });
  app.use('/api/groups', router);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockInput.mockClear();
  mockRequest.mockClear();
});

describe('GET /api/groups/:groupId/products/hidden-with-enrollments', () => {
  test('returns empty array when no hidden products have active enrollments', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    const app = buildApp();
    const res = await supertest(app)
      .get('/api/groups/group-1/products/hidden-with-enrollments')
      .expect(200);
    expect(res.body).toEqual({ success: true, data: [] });
  });

  test('groups members under each hidden product', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [
        { ProductId: 'p-1', ProductName: 'Bronze', MemberId: 'm-1', FullName: 'Jane Doe',  EnrolledDate: '2026-01-15T00:00:00.000Z' },
        { ProductId: 'p-1', ProductName: 'Bronze', MemberId: 'm-2', FullName: 'John Smith', EnrolledDate: '2025-11-02T00:00:00.000Z' },
        { ProductId: 'p-2', ProductName: 'Silver', MemberId: 'm-3', FullName: 'Sarah Lee',  EnrolledDate: '2025-09-30T00:00:00.000Z' }
      ]
    });
    const app = buildApp();
    const res = await supertest(app)
      .get('/api/groups/group-1/products/hidden-with-enrollments')
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      productId: 'p-1',
      productName: 'Bronze',
      enrollmentCount: 2,
      members: [
        { memberId: 'm-1', fullName: 'Jane Doe',   enrolledDate: '2026-01-15T00:00:00.000Z' },
        { memberId: 'm-2', fullName: 'John Smith', enrolledDate: '2025-11-02T00:00:00.000Z' }
      ]
    });
    expect(res.body.data[1]).toMatchObject({
      productId: 'p-2',
      productName: 'Silver',
      enrollmentCount: 1
    });
  });

  test('returns 500 on database error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp();
    const res = await supertest(app)
      .get('/api/groups/group-1/products/hidden-with-enrollments')
      .expect(500);
    expect(res.body.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest routes/__tests__/groupProducts.hiddenWithEnrollments`
Expected: FAIL — endpoint not registered, returns 404.

- [ ] **Step 3: Implement the route handler**

In `backend/routes/groupProducts.js`, insert this handler immediately after the Task 1 handler:

```javascript
// GET /:groupId/products/hidden-with-enrollments
// Returns hidden products (GroupProducts.IsHidden = 1) that still have at least
// one active enrollment, with the enrolled member list per product. Powers the
// "Products with Active Enrollments" section on the Group Products tab.
// Auth: SysAdmin, TenantAdmin, Agent (Group Admin denied).
router.get('/:groupId/products/hidden-with-enrollments', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();

        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT
                    p.ProductId,
                    p.Name AS ProductName,
                    m.MemberId,
                    LTRIM(RTRIM(CONCAT(m.FirstName, ' ', m.LastName))) AS FullName,
                    e.EnrolledDate
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
                INNER JOIN oe.Enrollments e ON e.ProductId = gp.ProductId
                INNER JOIN oe.Members m ON m.MemberId = e.MemberId
                WHERE gp.GroupId = @groupId
                  AND gp.IsHidden = 1
                  AND m.GroupId = @groupId
                  AND e.Status = 'Active'
                ORDER BY p.Name, e.EnrolledDate DESC
            `);

        // Group rows by product
        const byProduct = new Map();
        for (const row of result.recordset || []) {
            if (!byProduct.has(row.ProductId)) {
                byProduct.set(row.ProductId, {
                    productId: row.ProductId,
                    productName: row.ProductName,
                    members: []
                });
            }
            byProduct.get(row.ProductId).members.push({
                memberId: row.MemberId,
                fullName: row.FullName,
                enrolledDate: row.EnrolledDate
            });
        }
        const data = Array.from(byProduct.values()).map(p => ({
            ...p,
            enrollmentCount: p.members.length
        }));

        res.json({ success: true, data });
    } catch (error) {
        console.error('Error fetching hidden products with enrollments:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch hidden products with enrollments' });
    }
});
```

> **Note on schema:** Cross-check the column names (`m.FirstName`, `m.LastName`, `e.EnrolledDate`, `e.Status`) against an existing query that joins these tables — for example `backend/routes/enrollment-links.js` around line 1358 or any service in `backend/services/` that reads enrollments. Adjust column names to match the canonical pattern in this codebase.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest routes/__tests__/groupProducts.hiddenWithEnrollments`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/groupProducts.js backend/routes/__tests__/groupProducts.hiddenWithEnrollments.test.js
git commit -m "feat(groups): add hidden-with-enrollments endpoint for audit section"
```

---

## Task 3: Backend — Re-add un-hides via UPDATE branch

**Files:**
- Modify: `backend/routes/groupProducts.js` (the bulk assignment endpoint UPDATE branch around line 711–718)
- Test: `backend/routes/__tests__/groupProducts.readdUnhides.test.js`

The existing UPDATE branch sets `IsActive = 1` but leaves `IsHidden` untouched. We need to also set `IsHidden = 0` so re-adding a deleted product un-hides it.

- [ ] **Step 1: Write the failing test**

Create `backend/routes/__tests__/groupProducts.readdUnhides.test.js`:

```javascript
/**
 * Re-add (unhide) behavior for the bulk assignment endpoint.
 *
 * When a GroupProducts row already exists with IsHidden = 1, calling the
 * assignment endpoint with IsAssigned: true must flip IsHidden = 0 in the
 * SAME UPDATE statement (alongside IsActive = 1). This makes "delete then
 * re-add" a single round-trip from the agent's perspective.
 *
 * Run: npx jest routes/__tests__/groupProducts.readdUnhides
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

const mockBegin = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({
    request: mockRequest,
    transaction: jest.fn(() => ({
      begin: mockBegin,
      commit: mockCommit,
      rollback: mockRollback,
      request: mockRequest
    }))
  })),
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
  authenticateUrls: jest.fn(),
  authenticateProductDocumentsArray: jest.fn()
}));
jest.mock('../../services/shared/product-documents.service', () => ({
  getProductDocumentsForProductIds: jest.fn()
}));
jest.mock('../../services/vendorGroupAccessService', () => ({
  vendorUserServesGroup: jest.fn()
}));
jest.mock('../../utils/groupRouteAccess', () => ({
  appendGroupScopeForTenantUsers: jest.fn()
}));

function buildApp() {
  const router = require('../groupProducts');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { UserId: 'user-1', TenantId: 'tenant-1', roles: ['Agent'] };
    next();
  });
  app.use('/api/groups', router);
  return app;
}

describe('Re-add unhides existing GroupProducts row', () => {
  test('UPDATE branch sets IsHidden = 0 alongside IsActive = 1', async () => {
    // The existing endpoint runs many queries — we only care that some UPDATE
    // statement targeting GroupProducts includes both IsActive AND IsHidden.
    // Capture every query string.
    const seenQueries = [];
    mockQuery.mockImplementation(async (queryStr) => {
      seenQueries.push(queryStr);
      // Group lookup, product existence, etc. — return permissive defaults.
      if (/SELECT.*FROM oe\.Groups/i.test(queryStr)) {
        return { recordset: [{ GroupId: 'group-1', TenantId: 'tenant-1', GroupType: 'Standard', GroupName: 'Test', GroupAgentId: null }] };
      }
      if (/SELECT.*FROM oe\.GroupProducts.*WHERE.*GroupId.*ProductId/i.test(queryStr)) {
        // Existing row exists → triggers UPDATE branch
        return { recordset: [{ GroupProductId: 'gp-1' }] };
      }
      return { recordset: [], rowsAffected: [1] };
    });
    mockBegin.mockResolvedValue();
    mockCommit.mockResolvedValue();

    const app = buildApp();
    await supertest(app)
      .post('/api/groups/group-1/products')
      .send({ updates: [{ ProductId: 'product-1', IsAssigned: true, CustomSettings: null }] });

    const updateStmt = seenQueries.find(q => /UPDATE oe\.GroupProducts/i.test(q));
    expect(updateStmt).toBeDefined();
    expect(updateStmt).toMatch(/IsActive\s*=\s*@isActive/i);
    expect(updateStmt).toMatch(/IsHidden\s*=\s*0/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest routes/__tests__/groupProducts.readdUnhides`
Expected: FAIL — UPDATE statement does not include `IsHidden = 0`.

> **If the route path / payload shape in the test doesn't match the actual bulk-assignment endpoint:** read the route definition around lines 660–740 of `backend/routes/groupProducts.js` and adjust the supertest call (path + body) to match. The point of the test is the UPDATE statement contents, not the exact request shape.

- [ ] **Step 3: Modify the UPDATE branch**

In `backend/routes/groupProducts.js`, find the UPDATE statement that runs in the existing-row branch (around lines 711–718):

```javascript
// BEFORE
await updateRequest.query(`
    UPDATE oe.GroupProducts 
    SET IsActive = @isActive,
        CustomSettings = @customSettings,
        ModifiedDate = GETDATE(),
        ModifiedBy = @modifiedBy
    WHERE GroupId = @groupId AND ProductId = @productId
`);
```

Change it to:

```javascript
// AFTER — re-adding a previously deleted product flips IsHidden back to 0
// so the product reappears in enrollment links automatically. The agent
// experiences "delete then re-add" as a single un-hide round-trip.
await updateRequest.query(`
    UPDATE oe.GroupProducts 
    SET IsActive = @isActive,
        IsHidden = 0,
        CustomSettings = @customSettings,
        ModifiedDate = GETDATE(),
        ModifiedBy = @modifiedBy
    WHERE GroupId = @groupId AND ProductId = @productId
`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest routes/__tests__/groupProducts.readdUnhides`
Expected: PASS.

- [ ] **Step 5: Sanity-check the existing toggleHidden tests still pass**

Run: `cd backend && npx jest routes/__tests__/groupProducts.toggleHidden`
Expected: PASS — no regression.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/groupProducts.js backend/routes/__tests__/groupProducts.readdUnhides.test.js
git commit -m "feat(groups): re-add unhides existing GroupProducts row"
```

---

## Task 4: Frontend service methods

**Files:**
- Modify: `frontend/src/services/group-products.service.ts`

> **Read the existing file first** to match its style (function declarations, axios usage, return types). Add the new methods alongside the existing `setVisibility` (or whatever the current visibility-PATCH wrapper is called).

- [ ] **Step 1: Add `getEnrollmentCount` and `getHiddenWithEnrollments` to the service**

In `frontend/src/services/group-products.service.ts`, add these methods to the `GroupProductsService` (or as exported functions, matching the file's existing export style):

```typescript
/**
 * GET /api/groups/:groupId/products/:productId/enrollment-count
 * Used by the Delete confirmation modal.
 */
export async function getEnrollmentCount(
  groupId: string,
  productId: string
): Promise<{ count: number }> {
  const res = await apiClient.get(
    `/api/groups/${groupId}/products/${productId}/enrollment-count`
  );
  return res.data.data;
}

export interface HiddenProductWithEnrollments {
  productId: string;
  productName: string;
  enrollmentCount: number;
  members: Array<{
    memberId: string;
    fullName: string;
    enrolledDate: string;
  }>;
}

/**
 * GET /api/groups/:groupId/products/hidden-with-enrollments
 * Used by the "Products with Active Enrollments" section.
 */
export async function getHiddenWithEnrollments(
  groupId: string
): Promise<HiddenProductWithEnrollments[]> {
  const res = await apiClient.get(
    `/api/groups/${groupId}/products/hidden-with-enrollments`
  );
  return res.data.data;
}
```

If the file uses class methods on `GroupProductsService` instead of free functions, add these as static methods on the class with the same signatures.

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/group-products.service.ts
git commit -m "feat(groups): add enrollment-count and hidden-with-enrollments service methods"
```

---

## Task 5: Frontend hook — useGroupProductEnrollmentCount

**Files:**
- Create: `frontend/src/hooks/groups/useGroupProductEnrollmentCount.ts`

> If `frontend/src/hooks/groups/` doesn't exist yet, create the directory.

- [ ] **Step 1: Create the hook**

```typescript
// frontend/src/hooks/groups/useGroupProductEnrollmentCount.ts
import { useQuery } from '@tanstack/react-query';
import { getEnrollmentCount } from '../../services/group-products.service';

export function useGroupProductEnrollmentCount(
  groupId: string,
  productId: string | null
) {
  return useQuery({
    queryKey: ['group-product-enrollment-count', groupId, productId],
    queryFn: () => getEnrollmentCount(groupId, productId!),
    enabled: !!productId,
    staleTime: 0,
  });
}
```

The hook returns `{ data: { count: number } | undefined, isLoading, isError }`. It is enabled only when `productId` is non-null (i.e., the Delete modal is open for a specific product).

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/groups/useGroupProductEnrollmentCount.ts
git commit -m "feat(groups): add useGroupProductEnrollmentCount hook"
```

---

## Task 6: Frontend hook — useHiddenProductsWithEnrollments

**Files:**
- Create: `frontend/src/hooks/groups/useHiddenProductsWithEnrollments.ts`

- [ ] **Step 1: Create the hook**

```typescript
// frontend/src/hooks/groups/useHiddenProductsWithEnrollments.ts
import { useQuery } from '@tanstack/react-query';
import {
  getHiddenWithEnrollments,
  HiddenProductWithEnrollments
} from '../../services/group-products.service';

export function useHiddenProductsWithEnrollments(
  groupId: string,
  enabled: boolean = true
) {
  return useQuery<HiddenProductWithEnrollments[]>({
    queryKey: ['group-hidden-with-enrollments', groupId],
    queryFn: () => getHiddenWithEnrollments(groupId),
    enabled: enabled && !!groupId,
    staleTime: 30_000,
  });
}
```

The `enabled` parameter is gated by the caller — pass `false` for Group Admins so the request never fires.

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/groups/useHiddenProductsWithEnrollments.ts
git commit -m "feat(groups): add useHiddenProductsWithEnrollments hook"
```

---

## Task 7: Frontend component — DeleteProductConfirmModal

**Files:**
- Create: `frontend/src/components/groups/DeleteProductConfirmModal.tsx`
- Test: `frontend/src/components/groups/__tests__/DeleteProductConfirmModal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/groups/__tests__/DeleteProductConfirmModal.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeleteProductConfirmModal from '../DeleteProductConfirmModal';

describe('DeleteProductConfirmModal', () => {
  it('shows no-enrollment copy when count is 0', () => {
    render(
      <DeleteProductConfirmModal
        productName="Bronze Plan"
        enrollmentCount={0}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.getByText(/Remove .*Bronze Plan.* from this group/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/will no longer appear in enrollment links/i)).toBeInTheDocument();
    expect(screen.queryByText(/currently enrolled/i)).not.toBeInTheDocument();
  });

  it('shows enrollment-impact copy when count > 0', () => {
    render(
      <DeleteProductConfirmModal
        productName="Silver Plan"
        enrollmentCount={3}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.getByText(/3 members are currently enrolled/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/their enrollments will continue unchanged/i)
    ).toBeInTheDocument();
  });

  it('uses singular "member" when count is 1', () => {
    render(
      <DeleteProductConfirmModal
        productName="Silver Plan"
        enrollmentCount={1}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/1 member is currently enrolled/i)).toBeInTheDocument();
  });

  it('calls onConfirm when Remove is clicked', async () => {
    const onConfirm = vi.fn();
    render(
      <DeleteProductConfirmModal
        productName="Bronze Plan"
        enrollmentCount={0}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    render(
      <DeleteProductConfirmModal
        productName="Bronze Plan"
        enrollmentCount={0}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state when isLoading is true', () => {
    render(
      <DeleteProductConfirmModal
        productName="Bronze Plan"
        enrollmentCount={null}
        isLoading
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Checking enrollments/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/groups/__tests__/DeleteProductConfirmModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/components/groups/DeleteProductConfirmModal.tsx
import React from 'react';
import { Trash2 } from 'lucide-react';

interface DeleteProductConfirmModalProps {
  productName: string;
  /** null when still loading the count */
  enrollmentCount: number | null;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const DeleteProductConfirmModal: React.FC<DeleteProductConfirmModalProps> = ({
  productName,
  enrollmentCount,
  isLoading = false,
  onConfirm,
  onCancel,
}) => {
  const hasEnrollments = !isLoading && (enrollmentCount ?? 0) > 0;
  const memberWord = enrollmentCount === 1 ? 'member is' : 'members are';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-xl">
        <div className="p-6">
          <div className="flex items-start gap-3">
            <Trash2 className="h-5 w-5 text-red-600 mt-0.5" aria-hidden />
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900">
                Remove <span className="font-bold">{productName}</span> from this group?
              </h3>

              {isLoading ? (
                <p className="mt-3 text-sm text-gray-600">Checking enrollments…</p>
              ) : hasEnrollments ? (
                <>
                  <p className="mt-3 text-sm text-gray-700 font-medium">
                    {enrollmentCount} {memberWord} currently enrolled — their enrollments will continue unchanged.
                  </p>
                  <p className="mt-2 text-sm text-gray-600">
                    The product will not appear in new enrollment links. You can re-add it anytime from the Add Product menu.
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-gray-600">
                  It will no longer appear in enrollment links. You can re-add it anytime from the Add Product menu.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 pb-6">
          <button
            type="button"
            onClick={onCancel}
            className="border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md px-4 py-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="bg-red-600 hover:bg-red-700 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteProductConfirmModal;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/groups/__tests__/DeleteProductConfirmModal.test.tsx`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/groups/DeleteProductConfirmModal.tsx frontend/src/components/groups/__tests__/DeleteProductConfirmModal.test.tsx
git commit -m "feat(groups): add DeleteProductConfirmModal component"
```

---

## Task 8: Frontend component — ASARequiredBanner

**Files:**
- Create: `frontend/src/components/groups/ASARequiredBanner.tsx`
- Test: `frontend/src/components/groups/__tests__/ASARequiredBanner.test.tsx`

The banner takes the existing `asaStatus` shape (the same one returned by `useGroupASAStatus`), groups by `documentId`, and renders one row per **unique unsigned document**. Group admins see a "Sign" button per row; agents/tenants see read-only text.

> **Read `frontend/src/hooks/useGroupASAStatus.ts` and `backend/routes/group-asa-status.js`** to confirm the exact field names returned. The component should accept the raw status array as a prop and group by document on render.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/groups/__tests__/ASARequiredBanner.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ASARequiredBanner, { ASAStatusItem } from '../ASARequiredBanner';

const item = (over: Partial<ASAStatusItem> = {}): ASAStatusItem => ({
  productId: 'p-1',
  productName: 'Bronze',
  documentId: 'doc-1',
  documentName: 'MightyWELL Master ASA',
  documentUrl: 'https://example.com/asa.pdf',
  signed: false,
  ...over,
});

describe('ASARequiredBanner', () => {
  it('renders nothing when there are no unsigned documents', () => {
    const { container } = render(
      <ASARequiredBanner
        asaStatus={[item({ signed: true })]}
        canSign={false}
        onSign={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the status array is empty', () => {
    const { container } = render(
      <ASARequiredBanner asaStatus={[]} canSign={false} onSign={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows one row per unique unsigned document', () => {
    render(
      <ASARequiredBanner
        asaStatus={[
          item({ productId: 'p-1', documentId: 'doc-1', documentName: 'MightyWELL Master ASA' }),
          item({ productId: 'p-2', documentId: 'doc-1', documentName: 'MightyWELL Master ASA' }),
          item({ productId: 'p-3', documentId: 'doc-2', documentName: 'Acme Vendor ASA' }),
        ]}
        canSign={false}
        onSign={vi.fn()}
      />
    );
    expect(screen.getAllByText('MightyWELL Master ASA')).toHaveLength(1);
    expect(screen.getByText('Acme Vendor ASA')).toBeInTheDocument();
  });

  it('shows Sign buttons in the canSign variant', () => {
    render(
      <ASARequiredBanner
        asaStatus={[item()]}
        canSign={true}
        onSign={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /Sign/ })).toBeInTheDocument();
  });

  it('shows informational text in the read-only variant', () => {
    render(
      <ASARequiredBanner
        asaStatus={[item()]}
        canSign={false}
        onSign={vi.fn()}
      />
    );
    expect(screen.getByText(/Awaiting group admin signature/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign/ })).not.toBeInTheDocument();
  });

  it('invokes onSign with the correct documentId when Sign is clicked', async () => {
    const onSign = vi.fn();
    render(
      <ASARequiredBanner
        asaStatus={[item({ documentId: 'doc-42', documentName: 'Doc 42' })]}
        canSign={true}
        onSign={onSign}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Sign/ }));
    expect(onSign).toHaveBeenCalledWith('doc-42');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/groups/__tests__/ASARequiredBanner.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/components/groups/ASARequiredBanner.tsx
import React from 'react';
import { AlertCircle, Info } from 'lucide-react';

export interface ASAStatusItem {
  productId: string;
  productName: string;
  documentId: string;
  documentName: string;
  documentUrl?: string;
  signed: boolean;
}

interface ASARequiredBannerProps {
  asaStatus: ASAStatusItem[];
  /** True for Group Admin (can sign); false for Agent / Tenant (read-only). */
  canSign: boolean;
  onSign: (documentId: string) => void;
}

/**
 * Groups the ASA status array by documentId and returns one row per unique
 * unsigned document. Many products often share one ASA; we surface the document
 * once with a single Sign action.
 */
function uniqueUnsignedDocuments(asaStatus: ASAStatusItem[]): ASAStatusItem[] {
  const byDoc = new Map<string, ASAStatusItem>();
  for (const item of asaStatus) {
    if (item.signed) continue;
    if (!byDoc.has(item.documentId)) {
      byDoc.set(item.documentId, item);
    }
  }
  return Array.from(byDoc.values());
}

const ASARequiredBanner: React.FC<ASARequiredBannerProps> = ({
  asaStatus,
  canSign,
  onSign,
}) => {
  const unsigned = uniqueUnsignedDocuments(asaStatus);
  if (unsigned.length === 0) return null;

  if (!canSign) {
    return (
      <div className="bg-oe-light border border-oe-primary/30 rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-oe-primary mt-0.5" aria-hidden />
          <div>
            <p className="font-semibold text-gray-900">Awaiting group admin signature on:</p>
            <ul className="mt-2 list-disc list-inside text-sm text-gray-700">
              {unsigned.map((doc) => (
                <li key={doc.documentId}>{doc.documentName}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-oe-light border border-oe-primary/30 rounded-lg p-4 mb-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-oe-primary mt-0.5" aria-hidden />
        <div className="flex-1">
          <p className="font-semibold text-gray-900">ASA signature required</p>
          <p className="text-sm text-gray-600 mt-1">Sign these documents to enable enrollment for the affected products.</p>

          <ul className="mt-3 space-y-2">
            {unsigned.map((doc) => (
              <li key={doc.documentId} className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-900">{doc.documentName}</span>
                <button
                  type="button"
                  onClick={() => onSign(doc.documentId)}
                  className="bg-oe-primary hover:bg-oe-dark text-white rounded-md px-3 py-1.5 text-sm font-medium"
                >
                  Sign
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default ASARequiredBanner;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/groups/__tests__/ASARequiredBanner.test.tsx`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/groups/ASARequiredBanner.tsx frontend/src/components/groups/__tests__/ASARequiredBanner.test.tsx
git commit -m "feat(groups): add ASARequiredBanner component"
```

---

## Task 9: Frontend component — HiddenProductsSection

**Files:**
- Create: `frontend/src/components/groups/HiddenProductsSection.tsx`
- Test: `frontend/src/components/groups/__tests__/HiddenProductsSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/groups/__tests__/HiddenProductsSection.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HiddenProductsSection from '../HiddenProductsSection';
import type { HiddenProductWithEnrollments } from '../../../services/group-products.service';

const product = (over: Partial<HiddenProductWithEnrollments> = {}): HiddenProductWithEnrollments => ({
  productId: 'p-1',
  productName: 'Bronze',
  enrollmentCount: 1,
  members: [{ memberId: 'm-1', fullName: 'Jane Doe', enrolledDate: '2026-01-15T00:00:00.000Z' }],
  ...over,
});

describe('HiddenProductsSection', () => {
  it('renders nothing when the products array is empty', () => {
    const { container } = render(<HiddenProductsSection products={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one collapsed row per product with the count', () => {
    render(
      <HiddenProductsSection
        products={[
          product({ productId: 'p-1', productName: 'Bronze', enrollmentCount: 3 }),
          product({ productId: 'p-2', productName: 'Silver', enrollmentCount: 1 }),
        ]}
      />
    );
    expect(screen.getByText('Bronze')).toBeInTheDocument();
    expect(screen.getByText(/3 members enrolled/)).toBeInTheDocument();
    expect(screen.getByText('Silver')).toBeInTheDocument();
    expect(screen.getByText(/1 member enrolled/)).toBeInTheDocument();
  });

  it('expands a row to show member names and enrolled dates', async () => {
    render(
      <HiddenProductsSection
        products={[
          product({
            productName: 'Bronze',
            enrollmentCount: 2,
            members: [
              { memberId: 'm-1', fullName: 'Jane Doe',   enrolledDate: '2026-01-15T00:00:00.000Z' },
              { memberId: 'm-2', fullName: 'John Smith', enrolledDate: '2025-11-02T00:00:00.000Z' },
            ],
          }),
        ]}
      />
    );
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Bronze/ }));
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/groups/__tests__/HiddenProductsSection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/components/groups/HiddenProductsSection.tsx
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { HiddenProductWithEnrollments } from '../../services/group-products.service';

interface HiddenProductsSectionProps {
  products: HiddenProductWithEnrollments[];
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

const HiddenProductsSection: React.FC<HiddenProductsSectionProps> = ({ products }) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (products.length === 0) return null;

  const toggle = (productId: string) =>
    setExpanded((prev) => ({ ...prev, [productId]: !prev[productId] }));

  return (
    <section className="mt-8">
      <h3 className="text-lg font-semibold text-gray-900">Products with Active Enrollments</h3>
      <p className="text-sm text-gray-600 mb-4">
        These products were removed from this group but still have enrolled members.
        They are not available in new enrollment links.
      </p>

      <ul className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-200">
        {products.map((p) => {
          const isOpen = !!expanded[p.productId];
          const memberWord = p.enrollmentCount === 1 ? 'member' : 'members';
          return (
            <li key={p.productId}>
              <button
                type="button"
                onClick={() => toggle(p.productId)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
                aria-expanded={isOpen}
              >
                <span className="flex items-center gap-2">
                  {isOpen
                    ? <ChevronDown className="h-4 w-4 text-gray-500" aria-hidden />
                    : <ChevronRight className="h-4 w-4 text-gray-500" aria-hidden />}
                  <span className="font-medium text-gray-900">{p.productName}</span>
                </span>
                <span className="text-sm text-gray-600">
                  {p.enrollmentCount} {memberWord} enrolled
                </span>
              </button>

              {isOpen && (
                <ul className="px-10 pb-3 text-sm text-gray-700 list-disc">
                  {p.members.map((m) => (
                    <li key={m.memberId} className="py-1">
                      {m.fullName}
                      <span className="text-gray-500"> (enrolled {formatDate(m.enrolledDate)})</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default HiddenProductsSection;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/groups/__tests__/HiddenProductsSection.test.tsx`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/groups/HiddenProductsSection.tsx frontend/src/components/groups/__tests__/HiddenProductsSection.test.tsx
git commit -m "feat(groups): add HiddenProductsSection component"
```

---

## Task 10: Wire ASA banner into GroupProductsTab + remove per-row ASA pills

**Files:**
- Modify: `frontend/src/pages/groups/GroupProductsTab.tsx`

> **Before editing:** Read `frontend/src/pages/groups/GroupProductsTab.tsx` end-to-end so you understand the current ASA-pill render and the bundle-row render. The exact line numbers below are approximate; rely on the surrounding code as the source of truth.

- [ ] **Step 1: Determine `canSign` based on user role**

In the body of `GroupProductsTab` (after the existing role flags around line 85), add:

```tsx
const canSignASA = user?.currentRole === 'GroupAdmin';
```

- [ ] **Step 2: Render the banner above the table**

Find the JSX where the products table is rendered (around the `<table>` or grid container, search for the existing per-row ASA pill). **Before** that container, add:

```tsx
import ASARequiredBanner from '../../components/groups/ASARequiredBanner';

// ... in the JSX, just above the products table:
<ASARequiredBanner
  asaStatus={Array.isArray(asaStatus) ? asaStatus : (asaStatus?.products ?? [])}
  canSign={canSignASA}
  onSign={(documentId) => {
    // open the existing ASASigningModal for this document
    setActiveASADocument(documentId);
  }}
/>
```

The `setActiveASADocument` setter should reuse whatever existing state already drives `<ASASigningModal>`. If the existing modal opens by product, switch it to open by `documentId` — the modal already takes a document id internally per `frontend/src/components/groups/ASASigningModal.tsx`.

> **Field-name nudge:** The `useGroupASAStatus` hook today returns either an array or `{ products: [...] }`. Use the safe extraction shown above; once you confirm the actual shape, simplify to a single accessor.

- [ ] **Step 3: Remove the per-row ASA pill column**

Search the file for `Signed`, `Pending`, and `No ASA Required` (the badge labels at lines ~158–218). Delete the entire column header and cell in the products table. If there's an `<th>` for ASA, remove it; remove the matching `<td>` in the row render.

Also remove the inline "Sign Now" button that lives in the per-row ASA cell.

- [ ] **Step 4: Remove the bundle-subproduct ASA badge**

Find the bundle expansion render (lines ~667–716). Remove only the per-subproduct ASA badge — keep the rest of the bundle expansion (subproduct names, deductible config, etc.) intact.

- [ ] **Step 5: Type-check + run tab tests**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

(There may not be an existing GroupProductsTab unit test. If there is, run it; if not, skip.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/groups/GroupProductsTab.tsx
git commit -m "refactor(groups): replace per-row ASA pills with single banner"
```

---

## Task 11: Replace Hide/Show toggle with Delete button

**Files:**
- Modify: `frontend/src/pages/groups/GroupProductsTab.tsx`

- [ ] **Step 1: Add Delete state and modal wiring**

At the top of `GroupProductsTab`, alongside other `useState` calls, add:

```tsx
import DeleteProductConfirmModal from '../../components/groups/DeleteProductConfirmModal';
import { useGroupProductEnrollmentCount } from '../../hooks/groups/useGroupProductEnrollmentCount';

// state
const [productPendingDelete, setProductPendingDelete] = useState<{
  productId: string;
  productName: string;
} | null>(null);

const { data: enrollmentCountData, isLoading: enrollmentCountLoading } =
  useGroupProductEnrollmentCount(groupId, productPendingDelete?.productId ?? null);
```

- [ ] **Step 2: Replace the Hide/Show toggle button with a Delete button**

Find the per-row Hide/Show toggle (around lines 594–640, where it renders the `Eye` / `EyeOff` icon and calls a visibility-PATCH service method). Replace the entire button with:

```tsx
{canEditProducts && (
  <button
    type="button"
    onClick={() => setProductPendingDelete({
      productId: product.ProductId,
      productName: product.Name,
    })}
    className="text-red-600 hover:bg-red-50 border border-gray-300 rounded-md px-3 py-1.5 text-sm font-medium inline-flex items-center gap-1"
    aria-label={`Delete ${product.Name}`}
  >
    <Trash2 className="h-4 w-4" aria-hidden />
    Delete
  </button>
)}
```

Add `Trash2` to the lucide-react imports at the top of the file. Remove `Eye` and `EyeOff` from the imports if they're no longer used elsewhere in the file (search to confirm).

- [ ] **Step 3: Remove the "Show hidden products" checkbox**

Find the "Show hidden products" checkbox (lines 437–452) and delete the entire block. Also remove any `showHidden` state, the corresponding query-param wiring, and any conditional rendering that depended on it. The `useGroupProducts` hook should always fetch the visible (un-hidden) list now — read its source and adjust the call if it currently takes a `showHidden` flag (drop the flag).

- [ ] **Step 4: Render the modal at the bottom of the tab JSX**

```tsx
{productPendingDelete && (
  <DeleteProductConfirmModal
    productName={productPendingDelete.productName}
    enrollmentCount={enrollmentCountData?.count ?? null}
    isLoading={enrollmentCountLoading}
    onCancel={() => setProductPendingDelete(null)}
    onConfirm={async () => {
      await GroupProductsService.setVisibility(
        groupId,
        productPendingDelete.productId,
        true /* isHidden */
      );
      setProductPendingDelete(null);
      await refetch();
      await queryClient.invalidateQueries({
        queryKey: ['group-hidden-with-enrollments', groupId],
      });
    }}
  />
)}
```

> **Method-name nudge:** Use whatever the existing service wrapper for `PATCH .../visibility` is named in `group-products.service.ts`. If there isn't one, add a thin wrapper:
>
> ```typescript
> export async function setVisibility(groupId: string, productId: string, isHidden: boolean): Promise<void> {
>   await apiClient.patch(`/api/groups/${groupId}/products/${productId}/visibility`, { isHidden });
> }
> ```
>
> Note the request body uses `isHidden` (lowercase first letter) — the backend explicitly checks for that key (see `backend/routes/groupProducts.js` line 1037).

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/groups/GroupProductsTab.tsx frontend/src/services/group-products.service.ts
git commit -m "refactor(groups): replace Hide/Show toggle with Delete button"
```

---

## Task 12: Add Hidden Products section below active list

**Files:**
- Modify: `frontend/src/pages/groups/GroupProductsTab.tsx`

- [ ] **Step 1: Wire the hook**

Near the other hooks at the top of the component, add:

```tsx
import HiddenProductsSection from '../../components/groups/HiddenProductsSection';
import { useHiddenProductsWithEnrollments } from '../../hooks/groups/useHiddenProductsWithEnrollments';

// existing role flag canEditProducts is true for Agent / TenantAdmin / SysAdmin
const { data: hiddenWithEnrollments = [] } = useHiddenProductsWithEnrollments(
  groupId,
  canEditProducts /* enabled */
);
```

- [ ] **Step 2: Render the section below the products table**

Find the closing tag of the products table (or its wrapping div) and immediately after it, render:

```tsx
{canEditProducts && (
  <HiddenProductsSection products={hiddenWithEnrollments} />
)}
```

- [ ] **Step 3: Invalidate the hidden-with-enrollments query when re-adding**

Locate the existing add/assign-products flow (the function that calls `POST /api/groups/:groupId/products`). After a successful save, add:

```tsx
await queryClient.invalidateQueries({
  queryKey: ['group-hidden-with-enrollments', groupId],
});
```

This ensures that when the agent re-adds a previously deleted product, it disappears from the "Products with Active Enrollments" section.

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manual smoke test**

Start the dev servers (per CLAUDE.md and project_worktree_ports memory: this worktree is wt3 — check `project_worktree_ports.md` if uncertain about ports). Log in as an Agent, navigate to a group with at least one hidden product that has an active enrollment. Verify:
- ASA banner appears at top if any unsigned ASAs exist
- No per-row ASA badges
- Active products show a Delete button (no Hide/Show)
- Below the active list: "Products with Active Enrollments" section with the hidden product expanded showing the member name
- Clicking Delete on an active product opens the modal; cancelling closes it; confirming moves the product to the hidden section (with member count)
- Re-adding the product through the normal Add Product flow makes it reappear in the active list and disappear from the hidden section

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/groups/GroupProductsTab.tsx
git commit -m "feat(groups): add 'Products with Active Enrollments' section"
```

---

## Task 13: Cypress e2e — group-products-delete (no enrollments path)

**Files:**
- Create: `frontend/cypress/e2e/groups/group-products-delete.cy.ts`

> **Stub-driven, like the other Cypress specs in this repo.** Read `frontend/cypress/e2e/enrollment/cart-fees-row.cy.ts` (committed earlier in this branch) for the stubbing pattern this codebase uses.

- [ ] **Step 1: Write the spec**

```typescript
// frontend/cypress/e2e/groups/group-products-delete.cy.ts
describe('Group Products: Agent deletes a product (no enrollments)', () => {
  beforeEach(() => {
    cy.intercept('GET', '/api/groups/group-1*', {
      body: { success: true, data: { GroupId: 'group-1', GroupName: 'Acme', GroupType: 'Standard' } },
    }).as('getGroup');

    cy.intercept('GET', '/api/groups/group-1/products*', {
      body: { success: true, data: [
        { ProductId: 'p-1', Name: 'Bronze', SalesType: 'Both', IsHidden: false }
      ] },
    }).as('getProducts');

    cy.intercept('GET', '/api/groups/group-1/asa-status*', {
      body: { success: true, data: [] },
    }).as('getAsa');

    cy.intercept('GET', '/api/groups/group-1/products/hidden-with-enrollments', {
      body: { success: true, data: [] },
    }).as('getHidden');

    cy.intercept('GET', '/api/groups/group-1/products/p-1/enrollment-count', {
      body: { success: true, data: { count: 0 } },
    }).as('getCount');

    cy.intercept('PATCH', '/api/groups/group-1/products/p-1/visibility', {
      statusCode: 200,
      body: { success: true, message: 'Product hidden from new enrollments' },
    }).as('patchVisibility');

    // Log in as Agent — adapt to whatever auth-stub helper this codebase uses.
    cy.loginAsAgent?.();
    cy.visit('/groups/group-1/products');
    cy.wait(['@getGroup', '@getProducts', '@getAsa']);
  });

  it('opens the delete modal and confirms removal', () => {
    cy.findByRole('button', { name: /Delete Bronze/ }).click();
    cy.wait('@getCount');

    cy.findByText(/Remove Bronze from this group\?/).should('exist');
    cy.findByText(/will no longer appear in enrollment links/).should('exist');
    cy.findByText(/currently enrolled/).should('not.exist');

    cy.findByRole('button', { name: /^Remove$/ }).click();
    cy.wait('@patchVisibility').its('request.body').should('deep.equal', { isHidden: true });
  });

  it('cancel closes the modal without calling the API', () => {
    cy.findByRole('button', { name: /Delete Bronze/ }).click();
    cy.findByRole('button', { name: /Cancel/ }).click();
    cy.findByText(/Remove Bronze from this group/).should('not.exist');
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx cypress run --spec "cypress/e2e/groups/group-products-delete.cy.ts"`
Expected: PASS.

> If `cy.loginAsAgent()` and `cy.findByRole` don't exist in this codebase, adapt to the local helpers (e.g., `cy.login(...)`, `cy.contains(...)`).

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/groups/group-products-delete.cy.ts
git commit -m "test(groups): cypress spec for delete with no enrollments"
```

---

## Task 14: Cypress e2e — group-products-delete-with-enrollments

**Files:**
- Create: `frontend/cypress/e2e/groups/group-products-delete-with-enrollments.cy.ts`

- [ ] **Step 1: Write the spec**

```typescript
describe('Group Products: Agent deletes a product (has enrollments)', () => {
  beforeEach(() => {
    cy.intercept('GET', '/api/groups/group-1*', {
      body: { success: true, data: { GroupId: 'group-1', GroupName: 'Acme', GroupType: 'Standard' } },
    }).as('getGroup');

    cy.intercept('GET', '/api/groups/group-1/products*', (req) => {
      // First response shows Bronze active, after delete it's gone.
      req.reply({ success: true, data: [
        { ProductId: 'p-1', Name: 'Bronze', SalesType: 'Both', IsHidden: false }
      ] });
    }).as('getProducts');

    cy.intercept('GET', '/api/groups/group-1/asa-status*', { body: { success: true, data: [] } });

    let hiddenWithEnrollments: any[] = [];
    cy.intercept('GET', '/api/groups/group-1/products/hidden-with-enrollments', (req) => {
      req.reply({ success: true, data: hiddenWithEnrollments });
    });

    cy.intercept('GET', '/api/groups/group-1/products/p-1/enrollment-count', {
      body: { success: true, data: { count: 2 } },
    }).as('getCount');

    cy.intercept('PATCH', '/api/groups/group-1/products/p-1/visibility', (req) => {
      hiddenWithEnrollments = [{
        productId: 'p-1',
        productName: 'Bronze',
        enrollmentCount: 2,
        members: [
          { memberId: 'm-1', fullName: 'Jane Doe',   enrolledDate: '2026-01-15T00:00:00.000Z' },
          { memberId: 'm-2', fullName: 'John Smith', enrolledDate: '2025-11-02T00:00:00.000Z' },
        ],
      }];
      req.reply({ success: true });
    }).as('patchVisibility');

    cy.loginAsAgent?.();
    cy.visit('/groups/group-1/products');
  });

  it('shows enrolled count, deletes, and surfaces the product in the audit section', () => {
    cy.findByRole('button', { name: /Delete Bronze/ }).click();
    cy.wait('@getCount');
    cy.findByText(/2 members are currently enrolled/).should('exist');
    cy.findByRole('button', { name: /^Remove$/ }).click();
    cy.wait('@patchVisibility');

    cy.findByText(/Products with Active Enrollments/).should('exist');
    cy.findByRole('button', { name: /Bronze/ }).click(); // expand
    cy.findByText('Jane Doe').should('exist');
    cy.findByText('John Smith').should('exist');
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx cypress run --spec "cypress/e2e/groups/group-products-delete-with-enrollments.cy.ts"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/groups/group-products-delete-with-enrollments.cy.ts
git commit -m "test(groups): cypress spec for delete with active enrollments"
```

---

## Task 15: Cypress e2e — ASA banner

**Files:**
- Create: `frontend/cypress/e2e/groups/group-products-asa-banner.cy.ts`

- [ ] **Step 1: Write the spec**

```typescript
describe('Group Products: ASA banner replaces per-row pills', () => {
  beforeEach(() => {
    cy.intercept('GET', '/api/groups/group-1*', {
      body: { success: true, data: { GroupId: 'group-1', GroupName: 'Acme', GroupType: 'Standard' } },
    });
    cy.intercept('GET', '/api/groups/group-1/products*', {
      body: { success: true, data: [
        { ProductId: 'p-1', Name: 'Bronze', SalesType: 'Both', IsHidden: false },
        { ProductId: 'p-2', Name: 'Silver', SalesType: 'Both', IsHidden: false },
      ] },
    });
    cy.intercept('GET', '/api/groups/group-1/products/hidden-with-enrollments', {
      body: { success: true, data: [] },
    });
    cy.intercept('GET', '/api/groups/group-1/asa-status*', {
      body: { success: true, data: [
        { productId: 'p-1', productName: 'Bronze', documentId: 'doc-1', documentName: 'Master ASA', signed: false },
        { productId: 'p-2', productName: 'Silver', documentId: 'doc-1', documentName: 'Master ASA', signed: false },
      ] },
    });
  });

  it('group admin sees one Sign button for the shared document', () => {
    cy.loginAsGroupAdmin?.();
    cy.visit('/groups/group-1/products');
    cy.findAllByText('Master ASA').should('have.length', 1);
    cy.findAllByRole('button', { name: /^Sign$/ }).should('have.length', 1);
    cy.findByText(/Signed/).should('not.exist');
    cy.findByText(/No ASA Required/).should('not.exist');
  });

  it('agent sees the read-only awaiting-signature variant', () => {
    cy.loginAsAgent?.();
    cy.visit('/groups/group-1/products');
    cy.findByText(/Awaiting group admin signature on:/).should('exist');
    cy.findAllByText('Master ASA').should('have.length', 1);
    cy.findAllByRole('button', { name: /^Sign$/ }).should('not.exist');
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx cypress run --spec "cypress/e2e/groups/group-products-asa-banner.cy.ts"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/groups/group-products-asa-banner.cy.ts
git commit -m "test(groups): cypress spec for ASA banner replacing per-row pills"
```

---

## Task 16: Cypress e2e — Group admin permissions

**Files:**
- Create: `frontend/cypress/e2e/groups/group-products-group-admin-permissions.cy.ts`

- [ ] **Step 1: Write the spec**

```typescript
describe('Group Products: Group Admin sees no delete UI', () => {
  beforeEach(() => {
    cy.intercept('GET', '/api/groups/group-1*', {
      body: { success: true, data: { GroupId: 'group-1', GroupName: 'Acme', GroupType: 'Standard' } },
    });
    cy.intercept('GET', '/api/groups/group-1/products*', {
      body: { success: true, data: [
        { ProductId: 'p-1', Name: 'Bronze', SalesType: 'Both', IsHidden: false },
      ] },
    });
    cy.intercept('GET', '/api/groups/group-1/asa-status*', { body: { success: true, data: [] } });

    cy.intercept('GET', '/api/groups/group-1/products/hidden-with-enrollments', (req) => {
      // The frontend should NOT call this endpoint for Group Admins.
      throw new Error('Group Admin should not request hidden-with-enrollments');
    });
  });

  it('group admin sees no Delete buttons, no audit section, no Show-hidden checkbox', () => {
    cy.loginAsGroupAdmin?.();
    cy.visit('/groups/group-1/products');

    cy.findByText('Bronze').should('exist');
    cy.findByRole('button', { name: /Delete Bronze/ }).should('not.exist');
    cy.findByText(/Products with Active Enrollments/).should('not.exist');
    cy.findByText(/Show hidden products/).should('not.exist');
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npx cypress run --spec "cypress/e2e/groups/group-products-group-admin-permissions.cy.ts"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/groups/group-products-group-admin-permissions.cy.ts
git commit -m "test(groups): cypress spec for group admin permissions on products tab"
```

---

## Task 17: Final integration check + lint

- [ ] **Step 1: Run the full backend test file changed in this branch**

Run: `cd backend && npx jest routes/__tests__/groupProducts`
Expected: PASS — all groupProducts tests (existing + 3 new) green.

- [ ] **Step 2: Run the frontend component tests**

Run: `cd frontend && npx vitest run src/components/groups/__tests__/`
Expected: PASS — all 3 new component test files green.

- [ ] **Step 3: Lint**

Run:
```bash
cd backend && npx eslint routes/groupProducts.js routes/__tests__/groupProducts.*.test.js
cd frontend && npx eslint src/components/groups/ASARequiredBanner.tsx src/components/groups/DeleteProductConfirmModal.tsx src/components/groups/HiddenProductsSection.tsx src/pages/groups/GroupProductsTab.tsx
```
Expected: no errors.

- [ ] **Step 4: Type-check (frontend)**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual end-to-end smoke**

Start the dev servers (this worktree's port pair). Walk the full happy path as Agent then as Group Admin, verifying everything in Task 12 Step 5 plus:
- Group Admin can sign an ASA from the banner; banner disappears after all signed
- Group Admin sees no Delete button anywhere
- Network tab confirms `hidden-with-enrollments` is never called when logged in as Group Admin

- [ ] **Step 6: No commit needed if everything passes** — the previous tasks already committed each unit.

---

## Open questions / nudges for the implementing agent

1. **Schema names in the backend SQL** — the queries in Tasks 1 and 2 reference `oe.Enrollments.Status`, `oe.Enrollments.EnrolledDate`, `oe.Enrollments.ProductId`, and `oe.Members.GroupId`/`FirstName`/`LastName`. These match common conventions in this codebase, but verify against an existing query (e.g., `backend/routes/enrollment-links.js` lines 1358–1359 or any service in `backend/services/` that reads enrollments) and adjust if the actual columns differ.

2. **Existing `useGroupASAStatus` shape** — the banner test mocks an array shape; the live hook may wrap it as `{ products: [...] }`. Adjust the JSX accessor in Task 10 Step 2 to match what the hook actually returns.

3. **Existing service method name** — `GroupProductsService.setVisibility` may be named differently. Search `frontend/src/services/group-products.service.ts` for the existing PATCH visibility wrapper and use that name (or add the wrapper if it doesn't exist).

4. **Role flag `canEditProducts`** — already declared at line 86 of `GroupProductsTab.tsx` as `Agent / TenantAdmin / SysAdmin`. Reuse it for both the Delete button and the HiddenProductsSection gate.

5. **PR target:** per memory `feedback_default_pr_branch.md`, PRs target `staging` by default. Do not open a PR until the user explicitly approves (per `feedback_no_pr_without_approval.md`). PR body should follow `feedback_pr_description_format.md` (strategy paragraph + per-file breakdown), no test plan section.

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-04-29-group-products-simplification-design.md` is covered:
  - Permission matrix → Tasks 11, 12, 16
  - ASA banner → Tasks 8, 10, 15
  - Delete flow + modal copy → Tasks 7, 11, 13, 14
  - "Products with Active Enrollments" section → Tasks 9, 12, 14
  - Re-add behavior → Task 3, plus invalidation in Task 12 Step 3
  - Backend changes (2 new endpoints, 1 SQL tweak, no auth tightening because already correct) → Tasks 1, 2, 3
  - Tests (Jest, Vitest, Cypress) → Tasks 1, 2, 3, 7, 8, 9, 13, 14, 15, 16
- **Auth tightening note:** the spec said to "deny Group Admin (403)" on the visibility PATCH. Verified at `backend/routes/groupProducts.js:1034` that `authorize(['SysAdmin', 'TenantAdmin', 'Agent'])` already denies Group Admin. No change needed; this plan reflects that.
- **Type consistency:** `enrollmentCount`, `enrolledDate`, `documentId`, `productId`, `productName`, `members`, `fullName` are used identically across the backend response shape, the service interface, and the React component props.
- **Placeholders:** scanned — no TBD/TODO/handwave. Every test and component shows the actual code.
