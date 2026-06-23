const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: { NVarChar: 'nvarchar', UniqueIdentifier: 'uuid' },
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { UserId: 'u1', TenantId: 't1', userType: 'SysAdmin' };
    next();
  },
}));
const mockEnqueue = jest.fn().mockResolvedValue();
jest.mock('../../services/extractionQueue', () => ({ enqueueExtraction: mockEnqueue }));

const { getPool } = require('../../config/database');
const router = require('../product-chunks');

const app = express();
app.use(express.json());
app.use('/api/products', router);

beforeEach(() => jest.clearAllMocks());

describe('POST /api/products/:productId/documents/:documentId/regenerate-chunks', () => {
  it('deletes AI chunks for the doc and enqueues a new extraction', async () => {
    let deletedSql = '';
    const req_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
        .mockImplementationOnce(async () => ({ recordset: [{
          ProductDocumentId: 'd1', ProductId: 'p1', TenantId: 't1',
          DocumentUrl: 'https://blob/foo.pdf', DisplayName: 'foo.pdf',
        }] }))
        .mockImplementationOnce(async (q) => { deletedSql = q; return { rowsAffected: [3] }; })
        .mockImplementationOnce(async () => ({ rowsAffected: [1] })),
    };
    getPool.mockResolvedValue({ request: () => req_ });

    const res = await request(app)
      .post('/api/products/p1/documents/d1/regenerate-chunks');

    expect(res.status).toBe(202);
    expect(deletedSql).toMatch(/Source\s*=\s*'ai'/i);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      productDocumentId: 'd1', productId: 'p1', tenantId: 't1',
    }));
  });
});

describe('POST /api/products/:productId/chunks/regenerate-all', () => {
  it('deletes all AI chunks for the product and enqueues each doc', async () => {
    const req_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
        .mockImplementationOnce(async () => ({ rowsAffected: [12] }))
        .mockImplementationOnce(async () => ({ recordset: [
          { ProductDocumentId: 'd1', ProductId: 'p1', TenantId: 't1', DocumentUrl: 'a.pdf', DisplayName: 'a.pdf' },
          { ProductDocumentId: 'd2', ProductId: 'p1', TenantId: 't1', DocumentUrl: 'b.pdf', DisplayName: 'b.pdf' },
        ] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] })),
    };
    getPool.mockResolvedValue({ request: () => req_ });

    const res = await request(app).post('/api/products/p1/chunks/regenerate-all');

    expect(res.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });
});
