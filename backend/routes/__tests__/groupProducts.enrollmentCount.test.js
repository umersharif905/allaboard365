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
