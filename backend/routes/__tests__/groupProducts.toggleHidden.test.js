/**
 * PATCH /api/groupProducts/:groupId/products/:productId/visibility
 *
 * Constraint: un-hiding a product must respect the group's GroupType.
 *   - GroupType='ListBill' + product.SalesType='Group'      → 409
 *   - GroupType='Standard' + product.SalesType='Individual' → 409
 *   - SalesType='Both'                                      → always allowed
 *   - Hiding is always allowed.
 *
 * Also covers:
 *   - 400 when isHidden missing/non-boolean
 *   - 404 when the GroupProducts row doesn't exist
 *   - happy paths (legal combinations) → 200
 *
 * Run: npx jest routes/__tests__/groupProducts.toggleHidden
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

// ---------- Database mock ----------
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

// ---------- Auth + middleware mocks ----------
jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, res, next) => next(),
  requireTenantAccess: (req, res, next) => {
    req.tenantId = req.user?.TenantId || 'tenant-1';
    next();
  },
  getUserRoles: jest.fn((user) => user?.roles || ['TenantAdmin'])
}));

// ---------- Other groupProducts.js dependencies ----------
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

// ---------- Build app ----------
function buildApp(userOverrides = {}) {
  const router = require('../groupProducts');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      UserId: 'user-1',
      TenantId: 'tenant-1',
      roles: ['TenantAdmin'],
      ...userOverrides
    };
    next();
  });
  app.use('/api/groupProducts', router);
  return app;
}

// ---------- Helpers ----------
function makeLookupRow(overrides = {}) {
  return {
    GroupType: 'Standard',
    SalesType: 'Group',
    ProductName: 'Test Product',
    ...overrides
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockInput.mockReturnThis();
  jest.clearAllMocks();
  mockInput.mockReturnThis();
  mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
});

// ============================================================================
// Tests
// ============================================================================

describe('PATCH /:groupId/products/:productId/visibility — body validation', () => {
  test('returns 400 when isHidden is missing', async () => {
    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/isHidden/i);
  });

  test('returns 400 when isHidden is a string', async () => {
    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: 'true' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/boolean/i);
  });
});

describe('PATCH /:groupId/products/:productId/visibility — 404', () => {
  test('returns 404 when the GroupProducts row does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] }); // lookup returns nothing

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/missing-product/visibility')
      .send({ isHidden: false });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });
});

describe('PATCH /:groupId/products/:productId/visibility — un-hide constraint', () => {
  test('blocks un-hide of Group-only product on a ListBill group (409)', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [makeLookupRow({ GroupType: 'ListBill', SalesType: 'Group', ProductName: 'MightyWELL Silver' })]
    });

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: false });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('GROUPTYPE_PRODUCT_MISMATCH');
    expect(res.body.message).toMatch(/MightyWELL Silver/);
    expect(res.body.message).toMatch(/Group-only/i);
    expect(res.body.message).toMatch(/List Bill/i);
    // The UPDATE SQL must NOT have run — only the lookup query did
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('blocks un-hide of Individual-only product on a Standard group (409)', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [makeLookupRow({ GroupType: 'Standard', SalesType: 'Individual', ProductName: 'MightyWELL CoPay (Individual)' })]
    });

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: false });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GROUPTYPE_PRODUCT_MISMATCH');
    expect(res.body.message).toMatch(/MightyWELL CoPay/);
    expect(res.body.message).toMatch(/Individual-only/i);
    expect(res.body.message).toMatch(/Standard/i);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("allows un-hide of SalesType='Both' on ListBill group (200)", async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeLookupRow({ GroupType: 'ListBill', SalesType: 'Both' })] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/visible/i);
  });

  test("allows un-hide of SalesType='Both' on Standard group (200)", async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeLookupRow({ GroupType: 'Standard', SalesType: 'Both' })] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("allows un-hide of Group product on Standard group (200)", async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeLookupRow({ GroupType: 'Standard', SalesType: 'Group' })] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: false });

    expect(res.status).toBe(200);
  });

  test("allows un-hide of Individual product on ListBill group (200)", async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeLookupRow({ GroupType: 'ListBill', SalesType: 'Individual' })] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: false });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /:groupId/products/:productId/visibility — hide is always allowed', () => {
  test.each([
    ['ListBill', 'Group'],
    ['ListBill', 'Individual'],
    ['ListBill', 'Both'],
    ['Standard', 'Group'],
    ['Standard', 'Individual'],
    ['Standard', 'Both']
  ])('hides product (group=%s, sales=%s) returns 200 regardless of mismatch', async (GroupType, SalesType) => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeLookupRow({ GroupType, SalesType })] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: true });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/hidden/i);
  });
});

describe('PATCH /:groupId/products/:productId/visibility — UPDATE returns 0 rows', () => {
  test('returns 404 when UPDATE affects 0 rows (race with delete/deactivate)', async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [makeLookupRow({ GroupType: 'Standard', SalesType: 'Both' })] })
      .mockResolvedValueOnce({ rowsAffected: [0] });

    const res = await supertest(buildApp())
      .patch('/api/groupProducts/group-1/products/product-1/visibility')
      .send({ isHidden: true });

    expect(res.status).toBe(404);
  });
});
