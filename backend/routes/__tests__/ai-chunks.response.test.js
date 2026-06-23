const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: { NVarChar: 'nvarchar', UniqueIdentifier: 'uuid' },
}));

const { getPool } = require('../../config/database');
const aiChunksRouter = require('../ai-chunks');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiChunksRouter);
  return app;
};

describe('POST /api/ai/chunks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns new chunk fields (ChunkType, Source, Title, Question, SourceDocumentId, ChunkText)', async () => {
    const request_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [{
          AIChunkId: 'a1', SystemArea: 'Product', ProductId: 'p1',
          AgentId: null, MemberId: null,
          ChunkText: 'The deductible is $500.',
          ChunkType: 'prose', Source: 'ai',
          SourceDocumentId: 'd1', Question: null,
          Title: 'Deductible explanation',
          CreatedDate: '2026-05-18',
        }],
      }),
    };
    getPool.mockResolvedValue({ request: () => request_ });

    const res = await request(makeApp()).post('/api/ai/chunks').send({});
    expect(res.status).toBe(200);
    expect(res.body.chunks[0]).toMatchObject({
      AIChunkId: 'a1',
      ChunkType: 'prose',
      Source: 'ai',
      SourceDocumentId: 'd1',
      Question: null,
      Title: 'Deductible explanation',
      ChunkText: 'The deductible is $500.',
    });
  });
});
