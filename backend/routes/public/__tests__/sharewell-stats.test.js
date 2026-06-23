const express = require('express');
const request = require('supertest');

jest.mock('../../../services/shareWellStatsService', () => ({
  getShareWellStats: jest.fn(),
}));

const { getShareWellStats } = require('../../../services/shareWellStatsService');
const shareWellStatsRoutes = require('../sharewell-stats');

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.error.mockRestore();
});
beforeEach(() => jest.clearAllMocks());

function buildApp() {
  const app = express();
  app.use('/api/public/sharewell-stats', shareWellStatsRoutes);
  return app;
}

const SAMPLE = {
  totalShared: 1826778.35,
  totalNegotiated: 2309973.18,
  avgPercentReduced: 45,
  totalRequests: 499,
  requestsShared: 182,
  since: '2024-10-06T00:00:00.000Z',
  sinceLabel: 'October 2024',
  asOf: '2026-06-08T00:00:00.000Z',
  asOfLabel: 'June 2026',
  updatedAt: '2026-06-09T00:00:00.000Z',
  cached: false,
};

describe('GET /api/public/sharewell-stats', () => {
  test('returns aggregate sharing stats in { success, data } shape', async () => {
    getShareWellStats.mockResolvedValue(SAMPLE);
    const res = await request(buildApp()).get('/api/public/sharewell-stats').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalShared).toBe(1826778.35);
    expect(res.body.data.totalNegotiated).toBe(2309973.18);
    expect(res.body.data.avgPercentReduced).toBe(45);
    expect(res.body.data.sinceLabel).toBe('October 2024');
  });

  test('exposes aggregate request counts', async () => {
    getShareWellStats.mockResolvedValue(SAMPLE);
    const res = await request(buildApp()).get('/api/public/sharewell-stats').expect(200);
    expect(res.body.data.totalRequests).toBe(499);
    expect(res.body.data.requestsShared).toBe(182);
  });

  test('does NOT expose internal-only billing detail', async () => {
    getShareWellStats.mockResolvedValue(SAMPLE);
    const res = await request(buildApp()).get('/api/public/sharewell-stats').expect(200);
    expect(res.body.data.totalBilled).toBeUndefined();
    expect(res.body.data.billedInternal).toBeUndefined();
    expect(res.body.data.memberResponsibility).toBeUndefined();
  });

  test('sets a public cache-control header', async () => {
    getShareWellStats.mockResolvedValue(SAMPLE);
    const res = await request(buildApp()).get('/api/public/sharewell-stats').expect(200);
    expect(res.headers['cache-control']).toMatch(/public/);
  });

  test('returns 500 with success:false when the service throws', async () => {
    getShareWellStats.mockRejectedValue(new Error('db down'));
    const res = await request(buildApp()).get('/api/public/sharewell-stats').expect(500);
    expect(res.body.success).toBe(false);
  });
});
