/**
 * /api/prospect-tags — list / create / delete with agency-shared visibility.
 * Service is mocked; this exercises route logic (admin vs agent scoping, delete guard).
 * Run: npx jest routes/__tests__/prospect-tags.routes.test.js
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
  listTags: jest.fn(),
  createTag: jest.fn(),
  getTag: jest.fn(),
  deleteTag: jest.fn(),
}));

const prospectService = require('../../services/prospect.service');
const tagsRouter = require('../prospect-tags');

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterAll(() => console.error.mockRestore?.());

let currentUser = null;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; req.tenantId = currentUser ? currentUser.TenantId : null; next(); });
  app.use('/api/prospect-tags', tagsRouter);
  return app;
}

const AGENT = { UserId: 'u-agent', TenantId: 't1', roles: ['Agent'] };
const ADMIN = { UserId: 'u-ta', TenantId: 't1', roles: ['TenantAdmin'] };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  // getMyAgentContext → agent in agency ag1.
  mockQuery.mockResolvedValue({ recordset: [{ AgentId: 'agent-self', AgencyId: 'ag1' }] });
});

describe('GET /api/prospect-tags', () => {
  test('agent: scoped to their agency (isAdmin false)', async () => {
    currentUser = AGENT;
    prospectService.listTags.mockResolvedValue([{ ProspectTagId: 'tag-1', Name: 'Hot', Color: 'red' }]);
    const res = await request(buildApp()).get('/api/prospect-tags');
    expect(res.status).toBe(200);
    expect(prospectService.listTags).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ tenantId: 't1', agencyId: 'ag1', isAdmin: false })
    );
  });

  test('admin: sees all tenant tags (isAdmin true)', async () => {
    currentUser = ADMIN;
    prospectService.listTags.mockResolvedValue([]);
    await request(buildApp()).get('/api/prospect-tags');
    expect(prospectService.listTags).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ tenantId: 't1', isAdmin: true })
    );
  });
});

describe('POST /api/prospect-tags', () => {
  test('400 when name is empty', async () => {
    currentUser = AGENT;
    const res = await request(buildApp()).post('/api/prospect-tags').send({ name: '  ' });
    expect(res.status).toBe(400);
  });

  test('agent create scopes the tag to their agency', async () => {
    currentUser = AGENT;
    prospectService.createTag.mockResolvedValue({ ProspectTagId: 'tag-new', Name: 'Hot', Color: 'red', AgencyId: 'ag1' });
    const res = await request(buildApp()).post('/api/prospect-tags').send({ name: 'Hot', color: 'red' });
    expect(res.status).toBe(201);
    expect(prospectService.createTag).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ tenantId: 't1', agencyId: 'ag1', name: 'Hot', color: 'red' })
    );
  });

  test('admin create makes a tenant-wide tag (agencyId null)', async () => {
    currentUser = ADMIN;
    prospectService.createTag.mockResolvedValue({ ProspectTagId: 'tag-new', Name: 'VIP', Color: 'purple', AgencyId: null });
    await request(buildApp()).post('/api/prospect-tags').send({ name: 'VIP', color: 'purple' });
    expect(prospectService.createTag).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ agencyId: null, name: 'VIP' })
    );
  });
});

describe('DELETE /api/prospect-tags/:id', () => {
  test('404 when tag not found in tenant', async () => {
    currentUser = ADMIN;
    prospectService.getTag.mockResolvedValue(null);
    const res = await request(buildApp()).delete('/api/prospect-tags/tag-x');
    expect(res.status).toBe(404);
  });

  test('agent cannot delete a tenant-wide tag (AgencyId null) → 403', async () => {
    currentUser = AGENT;
    prospectService.getTag.mockResolvedValue({ ProspectTagId: 'tag-1', TenantId: 't1', AgencyId: null });
    const res = await request(buildApp()).delete('/api/prospect-tags/tag-1');
    expect(res.status).toBe(403);
    expect(prospectService.deleteTag).not.toHaveBeenCalled();
  });

  test('agent deletes a tag in their own agency', async () => {
    currentUser = AGENT;
    prospectService.getTag.mockResolvedValue({ ProspectTagId: 'tag-1', TenantId: 't1', AgencyId: 'ag1' });
    prospectService.deleteTag.mockResolvedValue(true);
    const res = await request(buildApp()).delete('/api/prospect-tags/tag-1');
    expect(res.status).toBe(200);
    expect(prospectService.deleteTag).toHaveBeenCalled();
  });

  test('admin deletes any tenant tag', async () => {
    currentUser = ADMIN;
    prospectService.getTag.mockResolvedValue({ ProspectTagId: 'tag-1', TenantId: 't1', AgencyId: 'ag9' });
    prospectService.deleteTag.mockResolvedValue(true);
    const res = await request(buildApp()).delete('/api/prospect-tags/tag-1');
    expect(res.status).toBe(200);
  });
});
