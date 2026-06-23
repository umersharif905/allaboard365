/**
 * Shared admin "in-progress drafts" endpoints.
 * Run: npx jest routes/me/__tests__/draftAdminRoutes
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../uploads', () => ({ deleteAzureBlob: jest.fn() }));
const mockSvc = {
  listDraftsForTenant: jest.fn(),
  getDraftForTenant: jest.fn(),
  deleteDraftForTenant: jest.fn()
};
jest.mock('../../../services/publicFormDraftService', () => mockSvc);

const { registerDraftAdminRoutes } = require('../draftAdminRoutes');

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => console.error.mockRestore());

const DRAFT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Build an app whose router already applied tenant context (req.tenantId), like
// the real surfaces do via requireTenantAccess.
function buildApp({ tenantId = 'tenant-1', deleteMiddleware } = {}) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use((req, _res, next) => {
    req.tenantId = tenantId;
    next();
  });
  registerDraftAdminRoutes(router, { deleteMiddleware });
  app.use('/api/forms', router);
  return app;
}

beforeEach(() => jest.clearAllMocks());

it('GET /drafts returns the tenant drafts', async () => {
  mockSvc.listDraftsForTenant.mockResolvedValue([{ DraftId: DRAFT, FileCount: 2 }]);
  const res = await request(buildApp()).get('/api/forms/drafts');
  expect(res.status).toBe(200);
  expect(res.body.data.drafts).toHaveLength(1);
  expect(mockSvc.listDraftsForTenant).toHaveBeenCalledWith('tenant-1');
});

it('GET /drafts 400s without tenant context', async () => {
  const res = await request(buildApp({ tenantId: null })).get('/api/forms/drafts');
  expect(res.status).toBe(400);
});

it('GET /drafts/:id returns the decrypted draft', async () => {
  mockSvc.getDraftForTenant.mockResolvedValue({ draftId: DRAFT, payload: { a: 1 }, files: [] });
  const res = await request(buildApp()).get(`/api/forms/drafts/${DRAFT}`);
  expect(res.status).toBe(200);
  expect(res.body.data.draft.draftId).toBe(DRAFT);
  expect(mockSvc.getDraftForTenant).toHaveBeenCalledWith(DRAFT, 'tenant-1');
});

it('GET /drafts/:id 404s when not in tenant', async () => {
  mockSvc.getDraftForTenant.mockResolvedValue(null);
  const res = await request(buildApp()).get(`/api/forms/drafts/${DRAFT}`);
  expect(res.status).toBe(404);
});

it('DELETE /drafts/:id deletes and purges', async () => {
  mockSvc.deleteDraftForTenant.mockResolvedValue({ deleted: true, blobPaths: ['c/x'] });
  const res = await request(buildApp()).delete(`/api/forms/drafts/${DRAFT}`);
  expect(res.status).toBe(200);
  expect(mockSvc.deleteDraftForTenant).toHaveBeenCalledWith(DRAFT, 'tenant-1');
});

it('DELETE /drafts/:id 404s when the draft is not in the tenant', async () => {
  mockSvc.deleteDraftForTenant.mockResolvedValue({ deleted: false, blobPaths: [] });
  const res = await request(buildApp()).delete(`/api/forms/drafts/${DRAFT}`);
  expect(res.status).toBe(404);
});

it('DELETE /drafts/:id 400s on a bad id', async () => {
  const res = await request(buildApp()).delete('/api/forms/drafts/nope');
  expect(res.status).toBe(400);
});

it('DELETE honors an extra deleteMiddleware guard (e.g. vendor write-role)', async () => {
  const block = (_req, res) => res.status(403).json({ success: false });
  const res = await request(buildApp({ deleteMiddleware: block })).delete(`/api/forms/drafts/${DRAFT}`);
  expect(res.status).toBe(403);
  expect(mockSvc.deleteDraftForTenant).not.toHaveBeenCalled();
});
