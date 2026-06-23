/**
 * vendors.minimum.test.js
 *
 * Tests that the vendor API correctly accepts, validates, persists, and
 * returns the `minimumEmployeesPerGroup` field (DB column:
 * MinimumEmployeesPerGroup) introduced in Task 2.1.
 *
 * Bootstrap pattern follows enrollment-links.send-verification-code.test.js.
 */

// Keep jest silent about console noise from the route's logger.
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
const request = require('supertest');

// ---------- Database mock ----------
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

// sql.Transaction mock — vendors.js uses `new sql.Transaction(pool)` for PUT/POST
const mockTransactionBegin = jest.fn().mockResolvedValue(undefined);
const mockTransactionCommit = jest.fn().mockResolvedValue(undefined);
const mockTransactionRollback = jest.fn().mockResolvedValue(undefined);
const mockTransactionRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

// Track Transaction instances for inspection
function MockTransaction() {
  this.begin = mockTransactionBegin;
  this.commit = mockTransactionCommit;
  this.rollback = mockTransactionRollback;
  this.request = mockTransactionRequest;
  this._aborted = false;
}
MockTransaction.prototype.request = function () {
  return { input: mockInput, query: mockQuery };
};

const mockPool = {
  request: mockRequest,
};

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => mockPool),
  sql: {
    NVarChar: jest.fn((n) => `NVarChar(${n})`),
    UniqueIdentifier: 'UniqueIdentifier',
    Int: 'Int',
    Bit: 'Bit',
    Float: 'Float',
    VarChar: 'VarChar',
    MAX: 'MAX',
    Decimal: jest.fn(() => 'Decimal'),
    DateTime2: 'DateTime2',
    Transaction: MockTransaction,
    Request: jest.fn(() => ({ input: mockInput, query: mockQuery })),
  },
}));

// mssql module — vendors.js does `const sql = require('mssql')` at the top.
// We need sql.Transaction and sql.Request to be constructable.
jest.mock('mssql', () => ({
  NVarChar: jest.fn((n) => `NVarChar(${n})`),
  UniqueIdentifier: 'UniqueIdentifier',
  Int: 'Int',
  Bit: 'Bit',
  Float: 'Float',
  VarChar: 'VarChar',
  MAX: 'MAX',
  Decimal: jest.fn(() => 'Decimal'),
  DateTime2: 'DateTime2',
  Transaction: MockTransaction,
  Request: jest.fn(() => ({ input: mockInput, query: mockQuery })),
}));

// ---------- Auth middleware mock ----------
jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, res, next) => next(),
  authorizeVendorDetail: () => (req, res, next) => {
    req.user = { userId: 'user-uuid-1' };
    next();
  },
  getUserRoles: jest.fn(),
  optionalAuth: (req, res, next) => next(),
}));

// ---------- Service mocks that vendors.js imports ----------
jest.mock('../../services/encryptionService', () => ({
  encrypt: jest.fn((v) => `enc:${v}`),
  decrypt: jest.fn((v) => (typeof v === 'string' ? v.replace(/^enc:/, '') : v)),
}));

jest.mock('../../services/vendorExportService', () => ({
  getLastEligibilitySentAt: jest.fn().mockResolvedValue(null),
  exportVendorData: jest.fn(),
}));

jest.mock('../../services/newGroupFormScheduledJobService', () => ({
  executeNewGroupFormScheduledJob: jest.fn(),
}));

jest.mock('../../services/vendorServedGroupsService', () => ({
  listVendorServedGroups: jest.fn(),
  loadVendorIdsApplicable: jest.fn(),
}));

jest.mock('../../services/vendorGroupAccessService', () => ({
  vendorServesGroup: jest.fn(),
}));

jest.mock('../../services/newGroupFormGenerationService', () => ({
  generatePdfBuffer: jest.fn(),
  recordNewGroupFormHistory: jest.fn(),
}));

jest.mock('../../services/vendorGroupIdService', () => ({}));

jest.mock('../../services/shared/user-roles.service', () => ({}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('uuid', () => ({ v4: jest.fn(() => 'new-vendor-uuid') }));

jest.mock('./shared/asa-agreements.factory', () => ({
  createAsaAgreementsRouter: jest.fn(() => {
    const r = require('express').Router();
    return r;
  }),
}), { virtual: true });

// The factory is actually at routes/shared/asa-agreements.factory
jest.mock('../shared/asa-agreements.factory', () => ({
  createAsaAgreementsRouter: jest.fn(() => {
    const r = require('express').Router();
    return r;
  }),
}));

// ---------- Now require the route and build the app ----------
const vendorsRoutes = require('../vendors');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/vendors', vendorsRoutes);
  return app;
}

// Helper: a minimal vendor DB row (as returned from the DB after UPDATE/INSERT)
function vendorRow(overrides = {}) {
  return {
    Id: 'vendor-uuid-1',
    VendorId: 'vendor-uuid-1',
    VendorName: 'Test Vendor',
    Address1: null,
    Address2: null,
    City: null,
    State: null,
    ZipCode: null,
    ContactName: null,
    Phone: null,
    Email: null,
    CreatedDate: new Date().toISOString(),
    ModifiedDate: new Date().toISOString(),
    MinimumEmployeesPerGroup: null,
    ...overrides,
  };
}

// Helper: minimal vendor row for GET /:id — uses v.* which returns DB column names
function vendorDetailRow(overrides = {}) {
  return {
    Id: 'vendor-uuid-1',
    VendorId: 'vendor-uuid-1',
    VendorName: 'Test Vendor',
    Address1: null,
    Address2: null,
    City: null,
    State: null,
    ZipCode: null,
    ContactName: null,
    Phone: null,
    Email: null,
    SftpPassword: null,
    ApiToken: null,
    CreatedDate: new Date().toISOString(),
    ModifiedDate: new Date().toISOString(),
    MinimumEmployeesPerGroup: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: input() returns `this` for chaining
  mockInput.mockReturnThis();
});

// ---------------------------------------------------------------------------
// PUT /api/vendors/:id — minimumEmployeesPerGroup
// ---------------------------------------------------------------------------
describe('PUT /api/vendors/:id — minimumEmployeesPerGroup', () => {
  const VENDOR_ID = 'vendor-uuid-1';

  function setupPutMocks({ fetchRow = null } = {}) {
    // 1st query: SELECT VendorId (vendor-exists check via pool.request())
    mockQuery.mockResolvedValueOnce({ recordset: [{ VendorId: VENDOR_ID }] });
    // 2nd query: UPDATE via new sql.Request(transaction)
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    // 3rd query: re-fetch SELECT after commit (pool.request())
    mockQuery.mockResolvedValueOnce({
      recordset: [fetchRow ?? vendorRow({ MinimumEmployeesPerGroup: 5 })],
    });
    // 4th query: fetchVendorAchAccounts (pool.request()) - called when achAccounts is empty
    mockQuery.mockResolvedValueOnce({ recordset: [] });
  }

  test('accepts minimumEmployeesPerGroup in body and persists it', async () => {
    setupPutMocks({ fetchRow: vendorRow({ MinimumEmployeesPerGroup: 5 }) });

    const res = await request(buildApp())
      .put(`/api/vendors/${VENDOR_ID}`)
      .send({
        vendorName: 'Test Vendor',
        minimumEmployeesPerGroup: 5,
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.MinimumEmployeesPerGroup).toBe(5);

    // Verify the UPDATE included MinimumEmployeesPerGroup
    const updateCallArgs = mockQuery.mock.calls
      .map((c) => c[0])
      .find((q) => typeof q === 'string' && q.includes('UPDATE oe.Vendors'));

    expect(updateCallArgs).toBeDefined();
    expect(updateCallArgs).toContain('MinimumEmployeesPerGroup');

    // Verify the parameter was bound
    const inputCalls = mockInput.mock.calls.map((c) => c[0]);
    expect(inputCalls).toContain('minimumEmployeesPerGroup');
  });

  test('accepts null to clear the value', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [{ VendorId: VENDOR_ID }] });
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    mockQuery.mockResolvedValueOnce({
      recordset: [vendorRow({ MinimumEmployeesPerGroup: null })],
    });
    mockQuery.mockResolvedValueOnce({ recordset: [] }); // fetchVendorAchAccounts

    const res = await request(buildApp())
      .put(`/api/vendors/${VENDOR_ID}`)
      .send({
        vendorName: 'Test Vendor',
        minimumEmployeesPerGroup: null,
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.MinimumEmployeesPerGroup).toBeNull();

    // The UPDATE should still include the field (null is a valid value)
    const updateCallArgs = mockQuery.mock.calls
      .map((c) => c[0])
      .find((q) => typeof q === 'string' && q.includes('UPDATE oe.Vendors'));

    expect(updateCallArgs).toContain('MinimumEmployeesPerGroup');
  });

  test('rejects negative numbers with 400', async () => {
    const res = await request(buildApp())
      .put(`/api/vendors/${VENDOR_ID}`)
      .send({
        vendorName: 'Test Vendor',
        minimumEmployeesPerGroup: -1,
      })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/minimum/i);

    // No DB queries should have been made (validation happens before DB access)
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rejects non-integer numbers with 400', async () => {
    const res = await request(buildApp())
      .put(`/api/vendors/${VENDOR_ID}`)
      .send({
        vendorName: 'Test Vendor',
        minimumEmployeesPerGroup: 2.5,
      })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/minimum/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('accepts 0 (treated as no minimum)', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [{ VendorId: VENDOR_ID }] });
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    mockQuery.mockResolvedValueOnce({
      recordset: [vendorRow({ MinimumEmployeesPerGroup: 0 })],
    });
    mockQuery.mockResolvedValueOnce({ recordset: [] }); // fetchVendorAchAccounts

    const res = await request(buildApp())
      .put(`/api/vendors/${VENDOR_ID}`)
      .send({
        vendorName: 'Test Vendor',
        minimumEmployeesPerGroup: 0,
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.MinimumEmployeesPerGroup).toBe(0);
  });

  test('omitting minimumEmployeesPerGroup does not include it in UPDATE', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [{ VendorId: VENDOR_ID }] });
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    mockQuery.mockResolvedValueOnce({
      recordset: [vendorRow({ MinimumEmployeesPerGroup: null })],
    });
    mockQuery.mockResolvedValueOnce({ recordset: [] }); // fetchVendorAchAccounts

    const res = await request(buildApp())
      .put(`/api/vendors/${VENDOR_ID}`)
      .send({ vendorName: 'Test Vendor' })
      .expect(200);

    expect(res.body.success).toBe(true);
    // When omitted, MinimumEmployeesPerGroup should NOT appear in the UPDATE
    const updateCallArgs = mockQuery.mock.calls
      .map((c) => c[0])
      .find((q) => typeof q === 'string' && q.includes('UPDATE oe.Vendors'));

    expect(updateCallArgs).not.toContain('MinimumEmployeesPerGroup');
  });
});

// ---------------------------------------------------------------------------
// GET /api/vendors/:id — minimumEmployeesPerGroup
// ---------------------------------------------------------------------------
describe('GET /api/vendors/:id', () => {
  const VENDOR_ID = 'vendor-uuid-1';

  test('returns minimumEmployeesPerGroup in response when set', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [vendorDetailRow({ MinimumEmployeesPerGroup: 5 })],
    });

    const res = await request(buildApp())
      .get(`/api/vendors/${VENDOR_ID}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.MinimumEmployeesPerGroup).toBe(5);
  });

  test('returns null for minimumEmployeesPerGroup when not set', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [vendorDetailRow({ MinimumEmployeesPerGroup: null })],
    });

    const res = await request(buildApp())
      .get(`/api/vendors/${VENDOR_ID}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.MinimumEmployeesPerGroup).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/vendors — minimumEmployeesPerGroup in list
// ---------------------------------------------------------------------------
describe('GET /api/vendors (list)', () => {
  test('returns minimumEmployeesPerGroup in list results', async () => {
    // 1st query: COUNT
    mockQuery.mockResolvedValueOnce({ recordset: [{ total: 1 }] });
    // 2nd query: SELECT list
    mockQuery.mockResolvedValueOnce({
      recordset: [
        {
          Id: 'vendor-uuid-1',
          VendorName: 'Test Vendor',
          MinimumEmployeesPerGroup: 10,
        },
      ],
    });

    const res = await request(buildApp())
      .get('/api/vendors')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].MinimumEmployeesPerGroup).toBe(10);
  });
});
