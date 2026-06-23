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
        { ProductId: 'p-1', ProductName: 'Bronze', MemberId: 'm-1', FullName: 'Jane Doe',   EnrolledDate: '2026-01-15T00:00:00.000Z' },
        { ProductId: 'p-1', ProductName: 'Bronze', MemberId: 'm-2', FullName: 'John Smith',  EnrolledDate: '2025-11-02T00:00:00.000Z' },
        { ProductId: 'p-2', ProductName: 'Silver', MemberId: 'm-3', FullName: 'Sarah Lee',   EnrolledDate: '2025-09-30T00:00:00.000Z' }
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
        { memberId: 'm-2', fullName: 'John Smith',  enrolledDate: '2025-11-02T00:00:00.000Z' }
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
