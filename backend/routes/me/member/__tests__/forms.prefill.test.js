/**
 * GET /api/me/member/forms/prefill — household-authorized autofill.
 *
 * Run: npx jest routes/me/member/__tests__/forms.prefill
 */

const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: () => 'NVarChar' }
}));

// forms.js pulls in routes/uploads (for uploadToAzureBlob); stub it so the
// suite doesn't transitively parse that module.
jest.mock('../../../uploads', () => ({ uploadToAzureBlob: jest.fn() }));

const mockBuildPrefill = jest.fn();
jest.mock('../../../../services/publicFormInvitationPrefillService', () => ({
  buildPrefillForMember: (...args) => mockBuildPrefill(...args),
  mapRelationToPrimary: () => 'self'
}));

const formsRouter = require('../forms');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

const SELF = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const STRANGER = '99999999-9999-9999-9999-999999999999';
const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function buildApp(role = 'Member') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { UserId: 'user-1', currentRole: role };
    next();
  });
  app.use('/api/me/member/forms', formsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  // findHouseholdMembersForUser → self + child share the household.
  mockQuery.mockResolvedValue({
    recordset: [
      { MemberId: SELF, TenantId: TENANT },
      { MemberId: CHILD, TenantId: TENANT }
    ]
  });
});

it('400s when memberId is missing or malformed', async () => {
  const res = await request(buildApp()).get('/api/me/member/forms/prefill?memberId=nope');
  expect(res.status).toBe(400);
});

it('403s for a non-Member role', async () => {
  const res = await request(buildApp('TenantAdmin')).get(`/api/me/member/forms/prefill?memberId=${SELF}`);
  expect(res.status).toBe(403);
});

it('403s when the member is outside the caller household', async () => {
  const res = await request(buildApp()).get(`/api/me/member/forms/prefill?memberId=${STRANGER}`);
  expect(res.status).toBe(403);
  expect(mockBuildPrefill).not.toHaveBeenCalled();
});

it('returns prefill for a household dependent (child)', async () => {
  mockBuildPrefill.mockResolvedValue({ firstName: 'Kid', relationToPrimary: 'child', uaTier: '2500' });
  const res = await request(buildApp()).get(`/api/me/member/forms/prefill?memberId=${CHILD}`);
  expect(res.status).toBe(200);
  expect(res.body.data.prefill.firstName).toBe('Kid');
  expect(res.body.data.prefill.uaTier).toBe('2500');
  expect(mockBuildPrefill).toHaveBeenCalledWith({ memberId: CHILD, tenantId: TENANT });
});
