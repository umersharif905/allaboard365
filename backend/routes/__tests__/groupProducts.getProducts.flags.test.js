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
  mockInput.mockReturnThis();
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
