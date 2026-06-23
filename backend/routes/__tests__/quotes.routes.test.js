/**
 * /api/quotes — create (auto-creates/links a prospect, no dup) + list.
 * Run: npx jest routes/__tests__/quotes.routes.test.js
 */

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
const fakePool = {
  request: () => {
    const r = { input: () => r, query: (sql) => mockQuery(sql) };
    return r;
  },
};

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => fakePool),
  sql: require('mssql'),
}));
jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, res, next) => next(),
  getUserRoles: (user) => (user && user.roles) || [],
}));
jest.mock('../../services/prospect.service', () => ({
  recordProposalProspect: jest.fn(),
  advanceStatus: jest.fn(),
}));

const prospectService = require('../../services/prospect.service');
const quotesRouter = require('../quotes');

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterAll(() => console.error.mockRestore?.());

let currentUser = null;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; req.tenantId = currentUser ? currentUser.TenantId : null; next(); });
  app.use('/api/quotes', quotesRouter);
  return app;
}

const AGENT = { UserId: 'u-agent', TenantId: 't1', roles: ['Agent'] };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  // Agent lookup returns an agent; inserts/list return empty recordsets.
  mockQuery.mockResolvedValue({ recordset: [{ AgentId: 'agent-self' }] });
  prospectService.recordProposalProspect.mockResolvedValue('prospect-new');
});

test('400 when no prospect name/email/phone', async () => {
  currentUser = AGENT;
  const res = await request(buildApp()).post('/api/quotes').send({ lineItems: [{ premium: 100 }] });
  expect(res.status).toBe(400);
});

test('creates a quote and auto-creates/links a prospect (source Quote)', async () => {
  currentUser = AGENT;
  const res = await request(buildApp())
    .post('/api/quotes')
    .send({ prospectName: 'Jane Doe', prospectEmail: 'jane@x.com', lineItems: [{ productName: 'Plan A', premium: 120 }, { premium: 30 }] });
  expect(res.status).toBe(201);
  expect(res.body.data.quoteId).toBeDefined();
  expect(res.body.data.prospectId).toBe('prospect-new');
  expect(res.body.data.totalPremium).toBe(150);
  expect(prospectService.recordProposalProspect).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: 't1', source: 'Quote', name: 'Jane Doe' })
  );
  // An INSERT INTO oe.Quotes must have run.
  expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO oe\.Quotes/.test(sql))).toBe(true);
});

test('GET list returns the recordset', async () => {
  currentUser = AGENT;
  mockQuery.mockResolvedValueOnce({ recordset: [{ QuoteId: 'q1', ProspectName: 'Jane' }] });
  const res = await request(buildApp()).get('/api/quotes?prospectId=p1');
  expect(res.status).toBe(200);
  expect(res.body.data[0].QuoteId).toBe('q1');
});
