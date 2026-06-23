/**
 * POST /api/lead-ingest — agent-scoped API-key lead intake.
 * Asserts the auth gating (API key + agent scope) and that valid leads are de-duped
 * through prospect.service.findOrCreateProspect attributed to the key's agent.
 *
 * Run: npx jest routes/__tests__/lead-ingest.test.js
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../services/prospect.service', () => ({
  findOrCreateProspect: jest.fn(),
}));

const prospectService = require('../../services/prospect.service');
const leadIngestRouter = require('../lead-ingest');

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterAll(() => console.error.mockRestore?.());

let currentUser = null;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/lead-ingest', leadIngestRouter);
  return app;
}

const AGENT_KEY_USER = {
  AuthType: 'ApiKey', AgentId: 'agent-1', UserId: 'u1', TenantId: 't1', ApiKeyScope: 'lead-ingest',
};

beforeEach(() => jest.clearAllMocks());

test('401 without an API key', async () => {
  currentUser = { UserId: 'u', roles: ['Agent'] }; // JWT, not ApiKey
  const res = await request(buildApp()).post('/api/lead-ingest').send({ email: 'a@b.com' });
  expect(res.status).toBe(401);
});

test('403 for a tenant-level key with no AgentId', async () => {
  currentUser = { AuthType: 'ApiKey', TenantId: 't1', roles: ['TenantAdmin'] };
  const res = await request(buildApp()).post('/api/lead-ingest').send({ email: 'a@b.com' });
  expect(res.status).toBe(403);
});

test('403 when the key scope is not lead-ingest', async () => {
  currentUser = { ...AGENT_KEY_USER, ApiKeyScope: 'something-else' };
  const res = await request(buildApp()).post('/api/lead-ingest').send({ email: 'a@b.com' });
  expect(res.status).toBe(403);
});

test('400 when no name/email/phone', async () => {
  currentUser = AGENT_KEY_USER;
  const res = await request(buildApp()).post('/api/lead-ingest').send({ referralName: 'Web' });
  expect(res.status).toBe(400);
});

test('201 on new lead, attributed to the key agent + tenant', async () => {
  currentUser = AGENT_KEY_USER;
  prospectService.findOrCreateProspect.mockResolvedValue({ prospect: { ProspectId: 'p1' }, created: true });
  const res = await request(buildApp()).post('/api/lead-ingest').send({ email: 'lead@x.com', firstName: 'Lead' });
  expect(res.status).toBe(201);
  expect(res.body.data).toEqual({ prospectId: 'p1', created: true });
  expect(prospectService.findOrCreateProspect).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: 't1', agentId: 'agent-1', source: 'ApiIngest' })
  );
});

test('200 on duplicate lead (created=false)', async () => {
  currentUser = AGENT_KEY_USER;
  prospectService.findOrCreateProspect.mockResolvedValue({ prospect: { ProspectId: 'p1' }, created: false });
  const res = await request(buildApp()).post('/api/lead-ingest').send({ email: 'lead@x.com' });
  expect(res.status).toBe(200);
  expect(res.body.data.created).toBe(false);
});
