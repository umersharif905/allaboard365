const express = require('express');
const request = require('supertest');

jest.mock('../services/caseStudyService', () => ({
  listPublished: jest.fn(),
}));
const CaseStudyService = require('../services/caseStudyService');
const router = require('../routes/public/case-studies');

function makeApp() {
  const app = express();
  app.use('/api/public/case-studies', router);
  return app;
}

describe('GET /api/public/case-studies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns published studies for the requested brand', async () => {
    CaseStudyService.listPublished.mockResolvedValue([{ caseStudyId: 'cs-1', brand: 'MightyWELL', headline: 'H', vendorId: 'v-1', createdBy: 'u-1' }]);
    const res = await request(makeApp()).get('/api/public/case-studies?brand=MightyWELL');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(CaseStudyService.listPublished).toHaveBeenCalledWith({ brand: 'MightyWELL' });
    expect(res.body.data[0]).not.toHaveProperty('vendorId');
    expect(res.body.data[0]).not.toHaveProperty('createdBy');
    expect(res.body.data[0].headline).toBe('H');
  });

  it('rejects an unknown brand with 400', async () => {
    const res = await request(makeApp()).get('/api/public/case-studies?brand=Bogus');
    expect(res.status).toBe(400);
    expect(CaseStudyService.listPublished).not.toHaveBeenCalled();
  });

  it('defaults to MightyWELL when no brand is supplied', async () => {
    CaseStudyService.listPublished.mockResolvedValue([]);
    await request(makeApp()).get('/api/public/case-studies');
    expect(CaseStudyService.listPublished).toHaveBeenCalledWith({ brand: 'MightyWELL' });
  });

  it('returns a generic 500 (no internal leak) on service error', async () => {
    CaseStudyService.listPublished.mockRejectedValue(new Error('DB down'));
    const res = await request(makeApp()).get('/api/public/case-studies?brand=MightyWELL');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Failed to list case studies');
  });
});
