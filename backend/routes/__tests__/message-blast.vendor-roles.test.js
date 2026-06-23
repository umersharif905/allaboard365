// Confirm vendor roles can pass auth on message-blast endpoints.
// All other behavior is unchanged. /send is intentionally NOT exercised at runtime.
const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = req.testUser; next(); },
  authorize: (allowed) => (req, res, next) => {
    const role = req.user?.userType;
    if (!allowed.includes(role)) return res.status(403).json({ success: false });
    next();
  },
  getUserRoles: (u) => u?.roles || [u?.userType]
}));

jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue({
    request: () => ({
      input: function () { return this; },
      query: jest.fn().mockResolvedValue({ recordset: [] })
    })
  }),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: () => 'NVarChar' }
}));

jest.mock('../../services/messageQueue.service', () => ({
  enqueueBlast: jest.fn().mockResolvedValue({ batchId: 'batch-1' })
}));

// Critical safety: prevent twilio from initializing for real
jest.mock('twilio', () => () => ({}));

const blastRouter = require('../me/tenant-admin/message-blast');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-role']) {
      req.user = { UserId: 'u1', userType: req.headers['x-test-role'], TenantId: 't1', roles: [req.headers['x-test-role']] };
      req.tenantId = 't1';
    }
    next();
  });
  app.use('/', blastRouter);
  return app;
}

describe('message-blast authorize() includes vendor roles', () => {
  const endpoints = [
    { method: 'get', path: '/agents' },
    { method: 'post', path: '/estimate', body: { sendSMS: false, phoneCount: 0 } },
    { method: 'post', path: '/actual-cost', body: { batchId: 'x' } }
    // /send intentionally NOT tested at runtime — would invoke real send paths.
  ];

  for (const role of ['VendorAdmin', 'VendorAgent']) {
    for (const ep of endpoints) {
      it(`${role} passes auth on ${ep.method.toUpperCase()} ${ep.path}`, async () => {
        const app = makeApp();
        const req = request(app)[ep.method](ep.path).set('x-test-role', role);
        const res = ep.body ? await req.send(ep.body) : await req;
        expect(res.status).not.toBe(403);
      });
    }
  }

  it('VendorAccounting is rejected (not in allowlist)', async () => {
    const app = makeApp();
    await request(app).get('/agents').set('x-test-role', 'VendorAccounting').expect(403);
  });
});
