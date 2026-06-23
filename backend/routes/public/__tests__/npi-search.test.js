const express = require('express');
const request = require('supertest');

jest.mock('../../../services/publicFormAdminService', () => ({
  getPublishedDefinitionByTemplateId: jest.fn()
}));
jest.mock('../../../services/publicNpiSearch.service', () => ({
  searchProviders: jest.fn(),
  findCoLocatedOrganizations: jest.fn()
}));

const publicFormAdminService = require('../../../services/publicFormAdminService');
const { searchProviders, findCoLocatedOrganizations } = require('../../../services/publicNpiSearch.service');
const npiSearchRoutes = require('../npi-search');

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.error.mockRestore();
});
beforeEach(() => jest.clearAllMocks());

function buildApp() {
  const app = express();
  app.use('/api/public/npi', npiSearchRoutes);
  return app;
}

const VALID_FORM = '11111111-1111-4111-8111-111111111111';

describe('GET /api/public/npi/search', () => {
  test('400 on a missing/invalid form id', async () => {
    const res = await request(buildApp())
      .get('/api/public/npi/search?mode=individual&lastName=Smith&zip=06770')
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  test('401 when the form is not found or unpublished', async () => {
    publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .get(`/api/public/npi/search?form=${VALID_FORM}&mode=individual&lastName=Smith&zip=06770`)
      .expect(401);
    expect(res.body.success).toBe(false);
  });

  test('200 returns providers for a valid published form', async () => {
    publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValueOnce({ FormTemplateId: VALID_FORM });
    searchProviders.mockResolvedValueOnce({
      providers: [{ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD', zip: '06770' }],
      widened: true
    });
    const res = await request(buildApp())
      .get(`/api/public/npi/search?form=${VALID_FORM}&mode=individual&lastName=Smith&zip=06770`)
      .expect(200);
    expect(res.body).toEqual({
      success: true,
      count: 1,
      widened: true,
      data: [{ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD', zip: '06770' }]
    });
    expect(searchProviders).toHaveBeenCalledWith({
      mode: 'individual', lastName: 'Smith', firstName: '', organizationName: '', zip: '06770'
    });
  });
});

describe('GET /api/public/npi/co-located', () => {
  test('400 on a missing/invalid form id', async () => {
    const res = await request(buildApp())
      .get('/api/public/npi/co-located?address1=1%20Main%20St&zip=06770')
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  test('401 when the form is not found or unpublished', async () => {
    publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .get(`/api/public/npi/co-located?form=${VALID_FORM}&address1=1%20Main%20St&zip=06770`)
      .expect(401);
    expect(res.body.success).toBe(false);
  });

  test('200 returns co-located organizations for a valid form', async () => {
    publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValueOnce({ FormTemplateId: VALID_FORM });
    findCoLocatedOrganizations.mockResolvedValueOnce({
      providers: [{ source: 'registry', npi: '8000000001', name: 'Co-Located Surgery Center' }]
    });
    const res = await request(buildApp())
      .get(`/api/public/npi/co-located?form=${VALID_FORM}&address1=1%20Prestige%20Dr&zip=06770`)
      .expect(200);
    expect(res.body).toEqual({
      success: true,
      count: 1,
      data: [{ source: 'registry', npi: '8000000001', name: 'Co-Located Surgery Center' }]
    });
    expect(findCoLocatedOrganizations).toHaveBeenCalledWith({ address1: '1 Prestige Dr', zip: '06770' });
  });
});
