const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'nvarchar', UniqueIdentifier: 'uuid', Int: 'int', Bit: 'bit',
  },
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { UserId: 'u1', TenantId: 't1', userType: 'SysAdmin' };
    next();
  },
}));

const { getPool } = require('../../config/database');
const router = require('../product-chunks');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/products', router);
  return app;
};

const mkRequest = (queryImpl) => ({
  input: jest.fn().mockReturnThis(),
  query: jest.fn().mockImplementation(queryImpl),
});

describe('POST /api/products/:productId/chunks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a manual prose chunk', async () => {
    const req_ = mkRequest(async () => ({ rowsAffected: [1] }));
    getPool.mockResolvedValue({ request: () => req_ });
    const res = await request(makeApp())
      .post('/api/products/p1/chunks')
      .send({ chunkType: 'prose', chunkText: 'Hello world' });
    expect(res.status).toBe(201);
    expect(res.body.chunk).toMatchObject({
      ProductId: 'p1', Source: 'manual', ChunkType: 'prose', ChunkText: 'Hello world',
    });
  });

  it('inserts a manual FAQ chunk requiring a question', async () => {
    const req_ = mkRequest(async () => ({ rowsAffected: [1] }));
    getPool.mockResolvedValue({ request: () => req_ });
    const res = await request(makeApp())
      .post('/api/products/p1/chunks')
      .send({ chunkType: 'faq', question: 'How?', chunkText: 'Like this.' });
    expect(res.status).toBe(201);
    expect(res.body.chunk).toMatchObject({ ChunkType: 'faq', Question: 'How?' });
  });

  it('rejects an FAQ chunk without a question', async () => {
    const res = await request(makeApp())
      .post('/api/products/p1/chunks')
      .send({ chunkType: 'faq', chunkText: 'Like this.' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/products/:productId/chunks/:chunkId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('edits an AI chunk by converting to manual', async () => {
    const req_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
        .mockImplementationOnce(async () => ({ recordset: [{
          AIChunkId: 'c1', ProductId: 'p1', TenantId: 't1',
          SystemArea: 'Product', ChunkType: 'prose', Source: 'ai',
          SourceDocumentId: 'd1', Question: null, Title: 'Old title', ChunkText: 'Old',
        }] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] })),
    };
    getPool.mockResolvedValue({ request: () => req_ });

    const res = await request(makeApp())
      .put('/api/products/p1/chunks/c1')
      .send({ chunkText: 'New', title: 'New title' });

    expect(res.status).toBe(200);
    expect(res.body.chunk.Source).toBe('manual');
    expect(res.body.chunk.ChunkText).toBe('New');
  });

  it('edits a manual chunk in place (no source flip)', async () => {
    const req_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
        .mockImplementationOnce(async () => ({ recordset: [{
          AIChunkId: 'c2', ProductId: 'p1', TenantId: 't1',
          SystemArea: 'Product', ChunkType: 'prose', Source: 'manual',
          SourceDocumentId: null, Question: null, Title: null, ChunkText: 'Old',
        }] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] })),
    };
    getPool.mockResolvedValue({ request: () => req_ });

    const res = await request(makeApp())
      .put('/api/products/p1/chunks/c2')
      .send({ chunkText: 'New' });

    expect(res.status).toBe(200);
    expect(res.body.chunk.Source).toBe('manual');
    expect(res.body.chunk.ChunkText).toBe('New');
  });
});

describe('DELETE /api/products/:productId/chunks/:chunkId', () => {
  it('soft-deletes by setting IsActive=0', async () => {
    const req_ = mkRequest(async () => ({ rowsAffected: [1] }));
    getPool.mockResolvedValue({ request: () => req_ });
    const res = await request(makeApp())
      .delete('/api/products/p1/chunks/c1');
    expect(res.status).toBe(204);
  });
});
