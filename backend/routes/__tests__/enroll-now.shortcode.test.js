/**
 * GET /api/enroll-now/:shortCode — allow-list guard + lifecycle errors.
 *
 * Asserts the public short-code resolver only returns a linkToken for
 * active, non-expired, under-limit Agent-Static or Marketing links.
 * All other states produce structured error bodies, not 500s.
 *
 * Run: npx jest enroll-now.shortcode
 */

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  sql: { NVarChar: 'NVarChar' }
}));

// Note: config/posthog.js is now self-stubbing under NODE_ENV=test (see
// backend/config/posthog.js), so we don't need a per-suite jest.mock here.

const enrollNowRoutes = require('../enroll-now');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/enroll-now', enrollNowRoutes);
  return app;
}

function activeLink(overrides = {}) {
  return {
    LinkId: 'link-1',
    LinkToken: 'enroll_abc_123',
    LinkUrl: 'https://example.com/enroll/enroll_abc_123',
    LinkType: 'Agent-Static',
    ShortCode: 'ag_jeremy_francis_2',
    IsActive: true,
    ExpiresAt: null,
    MaxUsage: null,
    UsageCount: 0,
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Clear queued mockResolvedValueOnce / mockRejectedValueOnce (clearAllMocks does not)
  mockQuery.mockReset();
  mockInput.mockReset();
  mockInput.mockReturnThis();
  mockRequest.mockReset();
  mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
});

describe('GET /api/enroll-now/:shortCode', () => {
  test('resolves Agent-Static short code to linkToken (happy path)', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [activeLink()] });

    const res = await request(buildApp())
      .get('/api/enroll-now/ag_jeremy_francis_2')
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: {
        linkToken: 'enroll_abc_123',
        linkType: 'Agent-Static',
        shortCode: 'ag_jeremy_francis_2'
      }
    });
  });

  test('resolves Marketing short code (second allowed LinkType)', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({ LinkType: 'Marketing', ShortCode: 'mk_open_enroll' })]
    });

    const res = await request(buildApp())
      .get('/api/enroll-now/mk_open_enroll')
      .expect(200);

    expect(res.body.data.linkType).toBe('Marketing');
  });

  test('returns 404 LINK_NOT_FOUND when short code is unknown', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] });

    const res = await request(buildApp())
      .get('/api/enroll-now/ag_does_not_exist')
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('LINK_NOT_FOUND');
  });

  test('returns 400 LINK_INACTIVE when IsActive is false', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({ IsActive: false })]
    });

    const res = await request(buildApp())
      .get('/api/enroll-now/ag_inactive_link')
      .expect(400);

    expect(res.body.error.code).toBe('LINK_INACTIVE');
  });

  test('returns 400 LINK_EXPIRED when ExpiresAt is in the past', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({
        ExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      })]
    });

    const res = await request(buildApp())
      .get('/api/enroll-now/ag_expired_link')
      .expect(400);

    expect(res.body.error.code).toBe('LINK_EXPIRED');
  });

  test('accepts link when ExpiresAt is in the future', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({
        ExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      })]
    });

    await request(buildApp())
      .get('/api/enroll-now/ag_future_expiry')
      .expect(200);
  });

  test('returns 400 USAGE_LIMIT_REACHED when UsageCount >= MaxUsage', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({ MaxUsage: 5, UsageCount: 5 })]
    });

    const res = await request(buildApp())
      .get('/api/enroll-now/ag_maxed_out')
      .expect(400);

    expect(res.body.error.code).toBe('USAGE_LIMIT_REACHED');
  });

  test('allows link when MaxUsage is null (unlimited)', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({ MaxUsage: null, UsageCount: 9999 })]
    });

    await request(buildApp())
      .get('/api/enroll-now/ag_unlimited')
      .expect(200);
  });

  test('returns 400 INVALID_LINK_TYPE for Group link accessed via short code', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({ LinkType: 'Group' })]
    });

    const res = await request(buildApp())
      .get('/api/enroll-now/grp_acme_2026')
      .expect(400);

    expect(res.body.error.code).toBe('INVALID_LINK_TYPE');
  });

  test('returns 400 INVALID_LINK_TYPE for Member link accessed via short code', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({ LinkType: 'Member' })]
    });

    const res = await request(buildApp())
      .get('/api/enroll-now/mbr_shortcode')
      .expect(400);

    expect(res.body.error.code).toBe('INVALID_LINK_TYPE');
  });

  test('prioritizes inactive error over expired error (first-match order)', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({
        IsActive: false,
        ExpiresAt: new Date(Date.now() - 1000).toISOString()
      })]
    });

    const res = await request(buildApp())
      .get('/api/enroll-now/ag_inactive_and_expired')
      .expect(400);

    expect(res.body.error.code).toBe('LINK_INACTIVE');
  });

  test('prioritizes expired over usage limit (guard order)', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [activeLink({
        ExpiresAt: new Date(Date.now() - 1000).toISOString(),
        MaxUsage: 5,
        UsageCount: 10
      })]
    });

    const res = await request(buildApp())
      .get('/api/enroll-now/ag_expired_and_maxed')
      .expect(400);

    expect(res.body.error.code).toBe('LINK_EXPIRED');
  });

  test('returns 500 RESOLVE_SHORTCODE_ERROR on DB throw', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(buildApp())
      .get('/api/enroll-now/ag_db_boom')
      .expect(500);

    expect(res.body.error.code).toBe('RESOLVE_SHORTCODE_ERROR');
    expect(res.body.error.message).toBe('connection refused');
  });
});
