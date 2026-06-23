/**
 * /api/prospect-sources — unit tests for validation and happy paths.
 *
 * Strategy: mock the DB pool (same idiom as enroll-now.shortcode.test.js) AND
 * mock the service module so we can control createSource return values without
 * wiring all the link-code / API-key generation internals.
 *
 * Run: npx jest routes/__tests__/prospect-sources
 */

const express = require('express');
const request = require('supertest');

// ── DB mock ────────────────────────────────────────────────────────────────────
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
  },
}));

// ── Auth middleware mock ───────────────────────────────────────────────────────
// authorize() returns a pass-through middleware so routes run without a real JWT.
jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, _res, next) => next(),
}));

// ── Service mock ───────────────────────────────────────────────────────────────
const mockCreateSource = jest.fn();
const mockListSources = jest.fn();
const mockUpdateSource = jest.fn();
const mockArchiveSource = jest.fn();

jest.mock('../../services/prospectSource.service', () => ({
  SOURCE_TYPES: ['website', 'landing', 'api'],
  buildPublicLink: jest.fn((destUrl, idParam, agentCode, linkCode) =>
    `${destUrl}?${idParam}=${agentCode}_${linkCode}`),
  listSources: (...args) => mockListSources(...args),
  createSource: (...args) => mockCreateSource(...args),
  updateSource: (...args) => mockUpdateSource(...args),
  archiveSource: (...args) => mockArchiveSource(...args),
}));

// Load route AFTER mocks are established
const prospectSourcesRoutes = require('../prospect-sources');

// ── App builder ────────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  // Inject a fake authenticated user via middleware before the router
  app.use((req, _res, next) => {
    req.user = { UserId: 'user-uuid-1', TenantId: 'tenant-uuid-1' };
    req.tenantId = 'tenant-uuid-1';
    next();
  });
  app.use('/api/prospect-sources', prospectSourcesRoutes);
  return app;
}

// ── Shared fixtures ────────────────────────────────────────────────────────────
const AGENT_ROW = { AgentId: 'agent-uuid-1', AgentCode: 'JSMITH' };
const TENANT_WITH_WEBSITE_DEST = JSON.stringify({
  marketingLink: {
    idParam: 'ref',
    destinations: [
      { type: 'website', label: 'Home', url: 'https://example.com' },
      { type: 'landing', label: 'Quote', url: 'https://example.com/quote' },
    ],
  },
});
const TENANT_NO_DESTINATIONS = JSON.stringify({ marketingLink: { idParam: 'ref', destinations: [] } });

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockInput.mockReset();
  mockInput.mockReturnThis();
  mockRequest.mockReset();
  mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
});

// ── POST tests ─────────────────────────────────────────────────────────────────
describe('POST /api/prospect-sources', () => {
  test('400 when name is missing', async () => {
    // getAgentCtx → returns agent
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });

    const res = await request(buildApp())
      .post('/api/prospect-sources')
      .send({ type: 'website' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/name is required/i);
  });

  test('400 when name is empty string', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });

    const res = await request(buildApp())
      .post('/api/prospect-sources')
      .send({ name: '   ', type: 'website' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/name is required/i);
  });

  test('400 when type is invalid', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });

    const res = await request(buildApp())
      .post('/api/prospect-sources')
      .send({ name: 'My Source', type: 'unknown' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid type/i);
  });

  test('400 when type=website but tenant has no matching destination', async () => {
    // getAgentCtx → agent found
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });
    // getMarketingConfig → tenant with no destinations
    mockQuery.mockResolvedValueOnce({ recordset: [{ AdvancedSettings: TENANT_NO_DESTINATIONS }] });

    const res = await request(buildApp())
      .post('/api/prospect-sources')
      .send({ name: 'My Website Source', type: 'website' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/no website destination configured/i);
  });

  test('400 when type=landing but tenant has no landing destination', async () => {
    const noLanding = JSON.stringify({
      marketingLink: { idParam: 'ref', destinations: [{ type: 'website', label: 'Home', url: 'https://example.com' }] },
    });
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });
    mockQuery.mockResolvedValueOnce({ recordset: [{ AdvancedSettings: noLanding }] });

    const res = await request(buildApp())
      .post('/api/prospect-sources')
      .send({ name: 'Landing Source', type: 'landing' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/no landing destination configured/i);
  });

  test('201 + data.apiKey present for type=api (key shown once)', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });
    // getMarketingConfig (api type skips destinations check but still queries tenant)
    mockQuery.mockResolvedValueOnce({ recordset: [{ AdvancedSettings: TENANT_WITH_WEBSITE_DEST }] });

    const fakeKey = 'sk_live_testkey1234';
    mockCreateSource.mockResolvedValueOnce({
      sourceId: 'src-uuid-1',
      name: 'API Source',
      tag: null,
      type: 'api',
      link: null,
      linkCode: null,
      apiKey: fakeKey,
    });

    const res = await request(buildApp())
      .post('/api/prospect-sources')
      .send({ name: 'API Source', type: 'api' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.apiKey).toBe(fakeKey);
    expect(res.body.data.sourceId).toBe('src-uuid-1');
  });

  test('201 for type=website when tenant has a matching destination', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });
    mockQuery.mockResolvedValueOnce({ recordset: [{ AdvancedSettings: TENANT_WITH_WEBSITE_DEST }] });

    mockCreateSource.mockResolvedValueOnce({
      sourceId: 'src-uuid-2',
      name: 'Home Website',
      tag: null,
      type: 'website',
      link: 'https://example.com?ref=JSMITH_abc123',
      linkCode: 'abc123',
      apiKey: null,
    });

    const res = await request(buildApp())
      .post('/api/prospect-sources')
      .send({ name: 'Home Website', type: 'website' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.type).toBe('website');
    // createSource should have been called with destinationUrl from the tenant config
    expect(mockCreateSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destinationUrl: 'https://example.com', type: 'website' })
    );
  });

  test('403 when no agent profile exists', async () => {
    // getAgentCtx → no rows
    mockQuery.mockResolvedValueOnce({ recordset: [] });

    const res = await request(buildApp())
      .post('/api/prospect-sources')
      .send({ name: 'Test', type: 'api' })
      .expect(403);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/agent profile required/i);
  });
});

// ── GET tests ──────────────────────────────────────────────────────────────────
describe('GET /api/prospect-sources', () => {
  test('returns empty array when no agent profile', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] }); // no agent

    const res = await request(buildApp())
      .get('/api/prospect-sources')
      .expect(200);

    expect(res.body).toEqual({ success: true, data: [] });
  });

  test('returns mapped source list', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });
    mockQuery.mockResolvedValueOnce({ recordset: [{ AdvancedSettings: TENANT_WITH_WEBSITE_DEST }] });
    mockListSources.mockResolvedValueOnce([
      {
        SourceId: 'src-1',
        Name: 'Home',
        Tag: null,
        Type: 'website',
        DestinationUrl: 'https://example.com',
        LinkCode: 'abc123',
        ApiPartialKey: null,
        LeadCount: 5,
        CreatedDate: '2025-01-01',
      },
    ]);

    const res = await request(buildApp())
      .get('/api/prospect-sources')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sourceId).toBe('src-1');
    expect(res.body.data[0].link).toMatch(/abc123/);
  });
});

// ── PATCH tests ────────────────────────────────────────────────────────────────
describe('PATCH /api/prospect-sources/:id', () => {
  test('404 when source not found', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });
    mockUpdateSource.mockResolvedValueOnce(false);

    const res = await request(buildApp())
      .patch('/api/prospect-sources/nonexistent-id')
      .send({ name: 'Updated' })
      .expect(404);

    expect(res.body.success).toBe(false);
  });

  test('200 on successful update', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] });
    mockUpdateSource.mockResolvedValueOnce(true);

    const res = await request(buildApp())
      .patch('/api/prospect-sources/src-uuid-1')
      .send({ name: 'Renamed' })
      .expect(200);

    expect(res.body.success).toBe(true);
  });
});

// ── DELETE tests ───────────────────────────────────────────────────────────────
describe('DELETE /api/prospect-sources/:id', () => {
  test('404 when source not found', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] }); // getAgentCtx
    mockQuery.mockResolvedValueOnce({ recordset: [] }); // IsDefault precheck (not found)
    mockArchiveSource.mockResolvedValueOnce(false);

    const res = await request(buildApp())
      .delete('/api/prospect-sources/nonexistent-id')
      .expect(404);

    expect(res.body.success).toBe(false);
  });

  test('200 on successful archive', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] }); // getAgentCtx
    mockQuery.mockResolvedValueOnce({ recordset: [{ IsDefault: false }] }); // IsDefault precheck
    mockArchiveSource.mockResolvedValueOnce(true);

    const res = await request(buildApp())
      .delete('/api/prospect-sources/src-uuid-1')
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  test('400 when archiving a default source', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [AGENT_ROW] }); // getAgentCtx
    mockQuery.mockResolvedValueOnce({ recordset: [{ IsDefault: true }] }); // IsDefault precheck

    const res = await request(buildApp())
      .delete('/api/prospect-sources/src-uuid-default')
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/default sources cannot be removed/i);
    expect(mockArchiveSource).not.toHaveBeenCalled();
  });
});
