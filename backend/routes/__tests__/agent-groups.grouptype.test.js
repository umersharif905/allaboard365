/**
 * agent-groups.grouptype.test.js
 *
 * TDD tests for GroupType support in group routes (Task 2.2).
 *
 * Covers:
 *   - POST /api/agents/groups: defaults to Standard, accepts ListBill, rejects unknown
 *   - GET /api/me/tenant-admin/groups: returns groupType in each row
 *   - GET /api/me/sysadmin/groups: returns GroupType in each row
 *   - GET /api/me/sysadmin/groups?groupType=ListBill: filters by GroupType
 *   - GET /api/me/tenant-admin/groups?groupType=ListBill: filters by GroupType
 *
 * Bootstrap pattern: enrollment-links.send-verification-code.test.js
 *
 * Run: npx jest routes/__tests__/agent-groups.grouptype.test.js
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
const request = require('supertest');

// ---------- Database mock ----------
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  sql: {
    NVarChar: 'NVarChar',
    UniqueIdentifier: 'UniqueIdentifier',
    DateTime2: 'DateTime2',
    Date: 'Date',
    Decimal: jest.fn(() => 'Decimal'),
    Int: 'Int',
    Bit: 'Bit',
    Float: 'Float',
    VarChar: 'VarChar',
    MAX: 'MAX'
  }
}));

// ---------- Auth middleware mock ----------
jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, res, next) => next(),
  requireTenantAccess: (req, res, next) => {
    req.tenantId = req.user?.TenantId || 'tenant-1';
    next();
  },
  getUserRoles: jest.fn()
}));

// ---------- Other imports needed by agent-groups.js and sysadmin/tenant-admin groups.js ----------
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock('../uploads', () => ({
  authenticateUrls: jest.fn(),
  authenticateProductDocumentsArray: jest.fn()
}));

jest.mock('../../services/PaymentMethodService', () => ({
  ensureDimeCustomer: jest.fn(),
  createPaymentMethod: jest.fn(),
  insertPaymentMethod: jest.fn(),
  updatePaymentMethodDefaults: jest.fn()
}));

jest.mock('../../utils/sqlDuplicateKey', () => ({
  isSqlServerDuplicateKeyError: jest.fn(() => false)
}));

// ---------- Build apps ----------

function buildAgentGroupsApp(userOverrides = {}) {
  const agentGroupsRoutes = require('../agent/agent-groups');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      UserId: 'user-1',
      TenantId: 'tenant-1',
      ...userOverrides
    };
    next();
  });
  app.use('/api/agents/groups', agentGroupsRoutes);
  return app;
}

function buildTenantAdminGroupsApp() {
  const tenantAdminGroupsRoutes = require('../me/tenant-admin/groups');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { UserId: 'user-1', TenantId: 'tenant-1' };
    req.tenantId = 'tenant-1';
    next();
  });
  app.use('/api/me/tenant-admin/groups', tenantAdminGroupsRoutes);
  return app;
}

function buildSysadminGroupsApp() {
  const sysadminGroupsRoutes = require('../me/sysadmin/groups');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { UserId: 'user-1', TenantId: 'tenant-1' };
    next();
  });
  app.use('/api/me/sysadmin/groups', sysadminGroupsRoutes);
  return app;
}

// ---------- Helpers ----------

/** Mock agent lookup: resolve AgentId from UserId */
function mockAgentLookup(agentId = 'agent-1') {
  return { recordset: [{ AgentId: agentId }] };
}

function mockGroupRow(overrides = {}) {
  return {
    GroupId: 'grp-1',
    Name: 'Test Group',
    Status: 'Active',
    GroupType: 'Standard',
    CreatedDate: new Date().toISOString(),
    TotalMembers: 0,
    MonthlyPremium: 0,
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
});

// =============================================================================
// POST /api/agents/groups — GroupType validation
// =============================================================================

describe('POST /api/agents/groups — GroupType', () => {
  const baseBody = {
    name: 'Acme Corp',
    contactEmail: 'admin@acme.com',
    primaryContact: 'Jane Doe'
  };

  test('defaults to Standard when groupType is not provided', async () => {
    // Arrange: agent lookup succeeds, INSERT succeeds, location INSERT succeeds
    mockQuery
      .mockResolvedValueOnce(mockAgentLookup())  // agent lookup
      .mockResolvedValueOnce({ rowsAffected: [1] }) // INSERT Groups
      .mockResolvedValueOnce({ rowsAffected: [1] }); // INSERT GroupLocations

    const app = buildAgentGroupsApp();
    const res = await request(app)
      .post('/api/agents/groups')
      .send(baseBody)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.groupType).toBe('Standard');

    // Assert: @GroupType parameter was bound with value 'Standard'
    // mockInput args: (name, sqlType, value) — value is at index [2]
    const inputCalls = mockInput.mock.calls;
    const groupTypeCall = inputCalls.find(c => c[0] === 'GroupType');
    expect(groupTypeCall).toBeDefined();
    expect(groupTypeCall[2]).toBe('Standard');

    // Assert: INSERT SQL includes GroupType column
    const insertCall = mockQuery.mock.calls.find(c => c[0].includes('INSERT INTO oe.Groups'));
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toMatch(/GroupType/);
    expect(insertCall[0]).toMatch(/@GroupType/);
  });

  test('accepts ListBill when provided, returns groupType in response', async () => {
    mockQuery
      .mockResolvedValueOnce(mockAgentLookup())
      .mockResolvedValueOnce({ rowsAffected: [1] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const app = buildAgentGroupsApp();
    const res = await request(app)
      .post('/api/agents/groups')
      .send({ ...baseBody, groupType: 'ListBill' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.groupType).toBe('ListBill');

    // Args: (name, sqlType, value) — value is at index [2]
    const inputCalls = mockInput.mock.calls;
    const groupTypeCall = inputCalls.find(c => c[0] === 'GroupType');
    expect(groupTypeCall).toBeDefined();
    expect(groupTypeCall[2]).toBe('ListBill');
  });

  test('accepts Standard explicitly when provided', async () => {
    mockQuery
      .mockResolvedValueOnce(mockAgentLookup())
      .mockResolvedValueOnce({ rowsAffected: [1] })
      .mockResolvedValueOnce({ rowsAffected: [1] });

    const app = buildAgentGroupsApp();
    const res = await request(app)
      .post('/api/agents/groups')
      .send({ ...baseBody, groupType: 'Standard' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.groupType).toBe('Standard');
  });

  test('rejects unknown groupType values with 400', async () => {
    const app = buildAgentGroupsApp();
    const res = await request(app)
      .post('/api/agents/groups')
      .send({ ...baseBody, groupType: 'Foo' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid grouptype/i);
    // DB should NOT have been called for the insert
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rejects empty-string groupType with 400', async () => {
    const app = buildAgentGroupsApp();
    const res = await request(app)
      .post('/api/agents/groups')
      .send({ ...baseBody, groupType: '' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid grouptype/i);
  });
});

// =============================================================================
// GET /api/me/tenant-admin/groups — returns groupType in each row
// =============================================================================

describe('GET /api/me/tenant-admin/groups', () => {
  test('response includes groupType for each row', async () => {
    const rows = [
      mockGroupRow({ GroupId: 'grp-1', GroupType: 'Standard' }),
      mockGroupRow({ GroupId: 'grp-2', GroupType: 'ListBill' })
    ];
    mockQuery.mockResolvedValueOnce({ recordset: rows });

    const app = buildTenantAdminGroupsApp();
    const res = await request(app)
      .get('/api/me/tenant-admin/groups')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    // groupType should be present and camelCase-mapped
    expect(res.body.data[0].GroupType).toBe('Standard');
    expect(res.body.data[1].GroupType).toBe('ListBill');

    // Assert SELECT includes GroupType column
    const selectCall = mockQuery.mock.calls.find(c => c[0].includes('SELECT'));
    expect(selectCall).toBeDefined();
    expect(selectCall[0]).toMatch(/GroupType/);
  });

  test('filters by groupType=Standard when query param provided', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [mockGroupRow({ GroupType: 'Standard' })] });

    const app = buildTenantAdminGroupsApp();
    const res = await request(app)
      .get('/api/me/tenant-admin/groups?groupType=Standard')
      .expect(200);

    expect(res.body.success).toBe(true);

    // Assert that @groupTypeFilter parameter was bound (args: name, sqlType, value)
    const inputCalls = mockInput.mock.calls;
    const filterCall = inputCalls.find(c => c[0] === 'groupTypeFilter');
    expect(filterCall).toBeDefined();
    expect(filterCall[2]).toBe('Standard');

    // Assert: SQL WHERE clause includes GroupType filter
    const selectCall = mockQuery.mock.calls.find(c => c[0].includes('SELECT'));
    expect(selectCall[0]).toMatch(/g\.GroupType\s*=\s*@groupTypeFilter/);
  });

  test('filters by groupType=ListBill when query param provided', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [mockGroupRow({ GroupType: 'ListBill' })] });

    const app = buildTenantAdminGroupsApp();
    const res = await request(app)
      .get('/api/me/tenant-admin/groups?groupType=ListBill')
      .expect(200);

    expect(res.body.success).toBe(true);

    const inputCalls = mockInput.mock.calls;
    const filterCall = inputCalls.find(c => c[0] === 'groupTypeFilter');
    expect(filterCall).toBeDefined();
    expect(filterCall[2]).toBe('ListBill');
  });

  test('ignores invalid groupType query param (no filter applied)', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [mockGroupRow()] });

    const app = buildTenantAdminGroupsApp();
    const res = await request(app)
      .get('/api/me/tenant-admin/groups?groupType=Unknown')
      .expect(200);

    expect(res.body.success).toBe(true);

    // No groupTypeFilter binding should have occurred
    const inputCalls = mockInput.mock.calls;
    const filterCall = inputCalls.find(c => c[0] === 'groupTypeFilter');
    expect(filterCall).toBeUndefined();
  });
});

// =============================================================================
// GET /api/me/sysadmin/groups — returns GroupType in each row
// =============================================================================

describe('GET /api/me/sysadmin/groups', () => {
  test('response SELECT includes GroupType column', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [
        mockGroupRow({ GroupId: 'grp-1', TenantId: 'tenant-1', TenantName: 'Demo', GroupType: 'Standard' }),
        mockGroupRow({ GroupId: 'grp-2', TenantId: 'tenant-1', TenantName: 'Demo', GroupType: 'ListBill' })
      ]
    });

    const app = buildSysadminGroupsApp();
    const res = await request(app)
      .get('/api/me/sysadmin/groups')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].GroupType).toBe('Standard');
    expect(res.body.data[1].GroupType).toBe('ListBill');

    const selectCall = mockQuery.mock.calls.find(c => c[0].includes('SELECT'));
    expect(selectCall).toBeDefined();
    expect(selectCall[0]).toMatch(/GroupType/);
  });

  test('filters by groupType=ListBill when query param provided', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [mockGroupRow({ GroupType: 'ListBill', TenantId: 'tenant-1', TenantName: 'Demo' })]
    });

    const app = buildSysadminGroupsApp();
    const res = await request(app)
      .get('/api/me/sysadmin/groups?groupType=ListBill')
      .expect(200);

    expect(res.body.success).toBe(true);

    // Args: name, sqlType, value — value is at index [2]
    const inputCalls = mockInput.mock.calls;
    const filterCall = inputCalls.find(c => c[0] === 'groupTypeFilter');
    expect(filterCall).toBeDefined();
    expect(filterCall[2]).toBe('ListBill');

    const selectCall = mockQuery.mock.calls.find(c => c[0].includes('SELECT'));
    expect(selectCall[0]).toMatch(/g\.GroupType\s*=\s*@groupTypeFilter/);
  });

  test('ignores invalid groupType query param', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] });

    const app = buildSysadminGroupsApp();
    const res = await request(app)
      .get('/api/me/sysadmin/groups?groupType=Nope')
      .expect(200);

    expect(res.body.success).toBe(true);

    const inputCalls = mockInput.mock.calls;
    const filterCall = inputCalls.find(c => c[0] === 'groupTypeFilter');
    expect(filterCall).toBeUndefined();
  });
});
