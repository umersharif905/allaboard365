jest.mock('../../services/employeeFacingDoc.service');
jest.mock('../../utils/groupRouteAccess', () => ({
  appendGroupScopeForTenantUsers: (q) => q
}));
jest.mock('../../config/database', () => ({
  getPool: jest.fn()
}));
jest.mock('../../middleware/auth', () => ({
  authorize: () => (_req, _res, next) => next(),
  requireTenantAccess: (req, _res, next) => { req.tenantId = 'T1'; next(); },
  getUserRoles: () => ['Agent']
}));

const request = require('supertest');
const express = require('express');
const svc = require('../../services/employeeFacingDoc.service');
const { getPool } = require('../../config/database');
const router = require('../groups.employee-docs');

function makePool(group) {
  return {
    request: () => ({
      input: function() { return this; },
      query: async () => ({ recordset: group ? [group] : [] })
    })
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { UserId: 'A1', TenantId: 'T1' }; next(); });
  app.use(router);
  return app;
}

describe('GET /api/groups/:groupId/employee-docs', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns applicable docs when group is accessible', async () => {
    getPool.mockResolvedValue(makePool({ GroupId: 'g1', TenantId: 'T1', AgentId: 'A1', Name: 'G', Status: 'Active' }));
    svc.getApplicableEmployeeDocsForGroup.mockResolvedValue([
      { proposalDocumentId: 'd1', name: 'Gold', productId: 'p1', productName: 'Gold' }
    ]);
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(svc.getApplicableEmployeeDocsForGroup).toHaveBeenCalledWith('g1', 'T1');
  });

  it('404s when group is not found or not accessible', async () => {
    getPool.mockResolvedValue(makePool(null));
    const res = await request(makeApp()).get('/api/groups/gX/employee-docs');
    expect(res.status).toBe(404);
    expect(svc.getApplicableEmployeeDocsForGroup).not.toHaveBeenCalled();
  });
});

describe('GET /api/groups/:groupId/employee-docs/:docId/download', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('streams PDF with inline disposition on success', async () => {
    getPool.mockResolvedValue(makePool({ GroupId: 'g1', TenantId: 'T1', AgentId: 'A1', Name: 'G', Status: 'Active' }));
    svc.generateEmployeeFacingPDF.mockResolvedValue({ buffer: Buffer.from('%PDF-test'), filename: 'G-Gold.pdf' });
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs/d1/download');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/inline/);
    expect(res.headers['content-disposition']).toContain('G-Gold.pdf');
  });

  it('404 when group not accessible (before hitting service)', async () => {
    getPool.mockResolvedValue(makePool(null));
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs/d1/download');
    expect(res.status).toBe(404);
    expect(svc.generateEmployeeFacingPDF).not.toHaveBeenCalled();
  });

  it('404 when service throws 404', async () => {
    getPool.mockResolvedValue(makePool({ GroupId: 'g1', TenantId: 'T1', AgentId: 'A1', Name: 'G', Status: 'Active' }));
    svc.generateEmployeeFacingPDF.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 404 }));
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs/d1/download');
    expect(res.status).toBe(404);
  });

  it('409 when service throws 409', async () => {
    getPool.mockResolvedValue(makePool({ GroupId: 'g1', TenantId: 'T1', AgentId: 'A1', Name: 'G', Status: 'Active' }));
    svc.generateEmployeeFacingPDF.mockRejectedValue(Object.assign(new Error('race'), { statusCode: 409 }));
    const res = await request(makeApp()).get('/api/groups/g1/employee-docs/d1/download');
    expect(res.status).toBe(409);
  });
});
