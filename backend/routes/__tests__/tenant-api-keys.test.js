/**
 * /api/tenant-api-keys — tenant-level Website Integration API key management.
 * Asserts: POST mints a website-integration key (AgentId NULL, Scope 'website-integration')
 * and returns the raw key exactly once; GET lists only this tenant's website keys in the
 * frontend contract shape; DELETE revokes; role gating rejects non-admins.
 *
 * Run: npx jest routes/__tests__/tenant-api-keys.test.js
 */

const express = require('express');
const request = require('supertest');

// --- Mock the DB layer ---------------------------------------------------
const mockQuery = jest.fn();
const mockInput = jest.fn(function () { return this; });
const mockRequest = { input: mockInput, query: mockQuery };
const mockPool = { request: () => mockRequest };

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => mockPool),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
    Bit: 'Bit',
  },
}));

// --- Mock authorize so we can drive role gating from the test ------------
jest.mock('../../middleware/auth', () => ({
  authorize: (allowedRoles) => (req, res, next) => {
    const roles = (req.user && req.user.roles) || [];
    const ok = allowedRoles.some((r) => roles.includes(r));
    if (!ok) return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    next();
  },
}));

const tenantApiKeysRouter = require('../tenant-api-keys');

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterAll(() => console.error.mockRestore?.());

let currentUser = null;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/tenant-api-keys', tenantApiKeysRouter);
  return app;
}

const ADMIN = { UserId: 'admin-user-1', TenantId: 'tenant-1', roles: ['TenantAdmin'] };

beforeEach(() => {
  jest.clearAllMocks();
  mockInput.mockImplementation(function () { return this; });
});

// -------------------------------------------------------------------------
test('POST mints a website-integration key with AgentId NULL and returns the key once', async () => {
  currentUser = ADMIN;
  mockQuery.mockResolvedValue({ rowsAffected: [1] });

  const res = await request(buildApp())
    .post('/api/tenant-api-keys')
    .send({ keyName: 'MightyWELL site' });

  expect(res.status).toBe(201);
  expect(res.body.success).toBe(true);
  expect(res.body.data).toEqual(
    expect.objectContaining({
      apiKeyId: expect.any(String),
      key: expect.stringMatching(/^sk_live_[0-9a-f]{48}$/),
      partialKey: expect.any(String),
      keyName: 'MightyWELL site',
    })
  );
  // partialKey is the last 4 of the full key
  expect(res.body.data.key.slice(-4)).toBe(res.body.data.partialKey);

  // INSERT bound the tenant, the website-integration scope, and never an agent id.
  const inputs = Object.fromEntries(mockInput.mock.calls.map(([name, , val]) => [name, val]));
  expect(inputs.tenantId).toBe('tenant-1');
  expect(inputs.scope).toBe('website-integration');
  expect(inputs.createdBy).toBe('admin-user-1');
  expect(inputs).not.toHaveProperty('agentId'); // AgentId is a literal NULL in the SQL

  const insertSql = mockQuery.mock.calls[0][0];
  expect(insertSql).toMatch(/INSERT INTO oe\.TenantApiKeys/i);
  expect(insertSql).toMatch(/NULL, @scope/); // AgentId, Scope -> NULL, @scope
});

test('GET lists only this tenant\'s website keys in the frontend contract shape', async () => {
  currentUser = ADMIN;
  mockQuery.mockResolvedValue({
    recordset: [
      {
        ApiKeyId: 'k1',
        KeyName: 'site key',
        PartialKey: 'ab12',
        Status: 'active',
        LastUsedDate: null,
        CreatedDate: '2026-06-04T00:00:00Z',
      },
    ],
  });

  const res = await request(buildApp()).get('/api/tenant-api-keys');

  expect(res.status).toBe(200);
  expect(res.body.data).toEqual([
    {
      apiKeyId: 'k1',
      keyName: 'site key',
      partialKey: 'ab12',
      status: 'active',
      lastUsedDate: null,
      createdDate: '2026-06-04T00:00:00Z',
    },
  ]);

  const inputs = Object.fromEntries(mockInput.mock.calls.map(([name, , val]) => [name, val]));
  expect(inputs.tenantId).toBe('tenant-1');
  expect(inputs.scope).toBe('website-integration');

  const listSql = mockQuery.mock.calls[0][0];
  expect(listSql).toMatch(/WHERE TenantId = @tenantId AND Scope = @scope/i);
  expect(listSql).not.toMatch(/KeyHash/i); // never expose the hash
});

test('DELETE revokes a key scoped to tenant + website-integration', async () => {
  currentUser = ADMIN;
  mockQuery.mockResolvedValue({ rowsAffected: [1] });

  const res = await request(buildApp()).delete('/api/tenant-api-keys/k1');

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);

  const inputs = Object.fromEntries(mockInput.mock.calls.map(([name, , val]) => [name, val]));
  expect(inputs.apiKeyId).toBe('k1');
  expect(inputs.tenantId).toBe('tenant-1');
  expect(inputs.scope).toBe('website-integration');

  const sqlText = mockQuery.mock.calls[0][0];
  expect(sqlText).toMatch(/UPDATE oe\.TenantApiKeys SET Status = 'revoked'/i);
  expect(sqlText).toMatch(/AND Scope = @scope/i);
});

test('DELETE returns 404 when nothing was revoked', async () => {
  currentUser = ADMIN;
  mockQuery.mockResolvedValue({ rowsAffected: [0] });

  const res = await request(buildApp()).delete('/api/tenant-api-keys/missing');
  expect(res.status).toBe(404);
});

test('role gating: a non-admin (Agent) is rejected on POST', async () => {
  currentUser = { UserId: 'u2', TenantId: 'tenant-1', roles: ['Agent'] };
  const res = await request(buildApp()).post('/api/tenant-api-keys').send({ keyName: 'x' });
  expect(res.status).toBe(403);
  expect(mockQuery).not.toHaveBeenCalled();
});

test('role gating: a non-admin (Agent) is rejected on GET', async () => {
  currentUser = { UserId: 'u2', TenantId: 'tenant-1', roles: ['Agent'] };
  const res = await request(buildApp()).get('/api/tenant-api-keys');
  expect(res.status).toBe(403);
});

test('SysAdmin is allowed to mint', async () => {
  currentUser = { UserId: 'sa', TenantId: 'tenant-1', roles: ['SysAdmin'] };
  mockQuery.mockResolvedValue({ rowsAffected: [1] });
  const res = await request(buildApp()).post('/api/tenant-api-keys').send({ keyName: 'x' });
  expect(res.status).toBe(201);
});
