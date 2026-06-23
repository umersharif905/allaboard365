const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'nvarchar',
    UniqueIdentifier: 'uuid',
    Int: 'int',
    Decimal: jest.fn(() => 'decimal'),
  },
}));

const { getPool } = require('../../config/database');
const router = require('../ai-tenant-knowledge');
const loadRouter = () => router;

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const makeApp = (router, user = { UserId: 'u1', TenantId: TENANT_ID, Roles: ['TenantAdmin'] }) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/ai/tenant-knowledge', router);
  return app;
};

// Build a pool whose request.query() returns successive results from `queryResults`,
// each entry matched in order. Useful for capturing the sequence of queries the
// route fires (table-existence check, chunk list, ratings aggregate, ...).
const mockPool = (queryResults) => {
  let i = 0;
  const req = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(() => {
      const result = queryResults[i] || { recordset: [] };
      i += 1;
      return Promise.resolve(result);
    }),
  };
  getPool.mockResolvedValue({ request: () => req });
  return req;
};

beforeEach(() => jest.clearAllMocks());

describe('GET /api/ai/tenant-knowledge/chunks', () => {
  it('returns chunks merged with ratings when AIChunkRatings exists', async () => {
    const router = loadRouter();
    const req_ = mockPool([
      { recordset: [
        {
          AIChunkId: 'c1', ProductId: 'p1', ProductName: 'Lyric', ProductIsBundle: 0,
          ChunkType: 'faq', Source: 'ai',
          Question: 'Does Lyric cover specialists?', Title: null,
          ChunkText: 'Lyric covers primary care only.',
          SourceDocumentId: 'd1',
          CreatedDate: '2026-04-12', ModifiedDate: '2026-04-12',
        },
        {
          AIChunkId: 'c2', ProductId: 'p2', ProductName: 'Bundle X', ProductIsBundle: 1,
          ChunkType: 'prose', Source: 'manual',
          Question: null, Title: 'Coverage details',
          ChunkText: 'Bundle X includes...',
          SourceDocumentId: null,
          CreatedDate: '2026-04-10', ModifiedDate: '2026-04-11',
        },
      ] },
      { recordset: [{ ObjectId: 123 }] },
      { recordset: [
        { AIChunkId: 'c1', AvgRating: 4.5, RatingCount: 8 },
      ] },
    ]);

    const res = await request(makeApp(router)).get('/api/ai/tenant-knowledge/chunks');
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(2);
    expect(res.body.chunks[0]).toMatchObject({
      AIChunkId: 'c1',
      ProductIsBundle: false,
      AvgRating: 4.5,
      RatingCount: 8,
    });
    expect(res.body.chunks[1]).toMatchObject({
      AIChunkId: 'c2',
      ProductIsBundle: true,
      AvgRating: null,
      RatingCount: 0,
    });
    expect(req_.input).toHaveBeenCalledWith('tenantId', 'uuid', TENANT_ID);
  });

  it('returns chunks with null ratings when AIChunkRatings table is missing', async () => {
    const router = loadRouter();
    mockPool([
      { recordset: [
        {
          AIChunkId: 'c1', ProductId: 'p1', ProductName: 'Lyric', ProductIsBundle: 0,
          ChunkType: 'prose', Source: 'manual',
          Question: null, Title: null,
          ChunkText: 'Note',
          SourceDocumentId: null,
          CreatedDate: '2026-04-12', ModifiedDate: '2026-04-12',
        },
      ] },
      { recordset: [{ ObjectId: null }] },
    ]);
    const res = await request(makeApp(router)).get('/api/ai/tenant-knowledge/chunks');
    expect(res.status).toBe(200);
    expect(res.body.chunks).toHaveLength(1);
    expect(res.body.chunks[0]).toMatchObject({ AvgRating: null, RatingCount: 0 });
  });

  it('passes search param as LIKE pattern', async () => {
    const router = loadRouter();
    const req_ = mockPool([
      { recordset: [] },
      { recordset: [{ ObjectId: null }] },
    ]);
    const res = await request(makeApp(router))
      .get('/api/ai/tenant-knowledge/chunks')
      .query({ search: 'Lyric' });
    expect(res.status).toBe(200);
    expect(req_.input).toHaveBeenCalledWith('search', 'nvarchar', '%Lyric%');
  });

  it('clamps pageSize above 200', async () => {
    const router = loadRouter();
    mockPool([{ recordset: [] }, { recordset: [{ ObjectId: null }] }]);
    const res = await request(makeApp(router))
      .get('/api/ai/tenant-knowledge/chunks')
      .query({ pageSize: 9999 });
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(200);
  });

  it('returns 403 when TenantId is missing', async () => {
    const router = loadRouter();
    const res = await request(makeApp(router, { UserId: 'u1' }))
      .get('/api/ai/tenant-knowledge/chunks');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/ai/tenant-knowledge/stats', () => {
  it('aggregates counts from chunk + rating queries', async () => {
    const router = loadRouter();
    mockPool([
      { recordset: [
        { AIChunkId: 'c1', ProductId: 'p1', ChunkType: 'prose', Source: 'ai' },
        { AIChunkId: 'c2', ProductId: 'p1', ChunkType: 'faq',   Source: 'manual' },
        { AIChunkId: 'c3', ProductId: 'p2', ChunkType: 'prose', Source: 'ai' },
      ] },
      { recordset: [{ ObjectId: 123 }] },
      { recordset: [
        { AIChunkId: 'c1', AvgRating: 4, RatingCount: 2 },
        { AIChunkId: 'c2', AvgRating: 5, RatingCount: 3 },
      ] },
    ]);
    const res = await request(makeApp(router)).get('/api/ai/tenant-knowledge/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({
      totalChunks: 3,
      byType: { prose: 2, faq: 1 },
      bySource: { ai: 2, manual: 1 },
      productsWithChunks: 2,
      ratedChunks: 2,
      overallAvgRating: 4.5,
    });
  });

  it('returns null overallAvgRating when ratings table is missing', async () => {
    const router = loadRouter();
    mockPool([
      { recordset: [
        { AIChunkId: 'c1', ProductId: 'p1', ChunkType: 'faq', Source: 'ai' },
      ] },
      { recordset: [{ ObjectId: null }] },
    ]);
    const res = await request(makeApp(router)).get('/api/ai/tenant-knowledge/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats.overallAvgRating).toBeNull();
    expect(res.body.stats.ratedChunks).toBe(0);
    expect(res.body.stats.totalChunks).toBe(1);
  });
});

describe('GET /api/ai/tenant-knowledge/products', () => {
  it('groups chunks by product and computes avg rating', async () => {
    const router = loadRouter();
    mockPool([
      { recordset: [
        { ProductId: 'p1', Name: 'Lyric',    IsBundle: 0, AIChunkId: 'c1' },
        { ProductId: 'p1', Name: 'Lyric',    IsBundle: 0, AIChunkId: 'c2' },
        { ProductId: 'p2', Name: 'Bundle X', IsBundle: 1, AIChunkId: 'c3' },
      ] },
      { recordset: [{ ObjectId: 123 }] },
      { recordset: [
        { AIChunkId: 'c1', AvgRating: 4, RatingCount: 1 },
        { AIChunkId: 'c2', AvgRating: 5, RatingCount: 2 },
      ] },
    ]);
    const res = await request(makeApp(router)).get('/api/ai/tenant-knowledge/products');
    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([
      { productId: 'p2', name: 'Bundle X', isBundle: true,  chunkCount: 1, avgRating: null },
      { productId: 'p1', name: 'Lyric',    isBundle: false, chunkCount: 2, avgRating: 4.5 },
    ]);
  });
});
