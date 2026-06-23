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
// Build a chainable request object: .input(...).input(...).query(...) all work.
const mockRequestObj = {
  input: jest.fn(),
  query: mockQuery
};
mockRequestObj.input.mockReturnValue(mockRequestObj);
const mockRequest = jest.fn(() => mockRequestObj);

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
  appendGroupScopeForTenantUsers: jest.fn((query) => query)
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
      if (/FROM oe\.Groups/i.test(queryStr)) {
        return { recordset: [{ GroupId: 'group-1', TenantId: 'tenant-1', GroupType: 'Standard', GroupName: 'Test', GroupAgentId: null }] };
      }
      if (/FROM oe\.GroupProducts/i.test(queryStr) && /WHERE/i.test(queryStr)) {
        // Existing row exists → triggers UPDATE branch
        return { recordset: [{ GroupProductId: 'gp-1' }] };
      }
      return { recordset: [], rowsAffected: [1] };
    });
    mockBegin.mockResolvedValue();
    mockCommit.mockResolvedValue();

    const app = buildApp();
    await supertest(app)
      .put('/api/groups/group-1/products')
      .send({ updates: [{ productId: 'product-1', IsAssigned: true, CustomSettings: null }] });

    const updateStmt = seenQueries.find(q => typeof q === 'string' && /UPDATE oe\.GroupProducts/i.test(q));
    expect(updateStmt).toBeDefined();
    expect(updateStmt).toMatch(/IsActive\s*=\s*@isActive/i);
    expect(updateStmt).toMatch(/IsHidden\s*=\s*0/i);
  });
});
