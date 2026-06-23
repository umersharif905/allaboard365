/**
 * Public validate-code rejects commission codes whose GrantTierLevel is not
 * configured for the tenant. Mocked DB only.
 */

const request = require('supertest');
const express = require('express');

const TENANT_ID = '55EB7262-4DB6-4614-82A8-23FC2E91203B';
const LINK_ID = '25BF3CF4-DFEE-4275-9999-C188070B1331';
const LINK_TOKEN = '50f59834aeeb23e6e677c4f34a7d8dda';
const ALLOWED_SORT_ORDERS = [0, 1, 2, 3];

jest.mock('../../../config/database', () => ({
  getPool: jest.fn(),
  sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock('../../../services/onboardingLinkGrantTierValidation.service', () => ({
  assertGrantTierAllowed: jest.fn()
}));

const { getPool } = require('../../../config/database');
const { assertGrantTierAllowed } = require('../../../services/onboardingLinkGrantTierValidation.service');

function makePool({ grantTierLevel = -2, tierValid = false } = {}) {
  let call = 0;
  return {
    request() {
      const self = {
        input() {
          return self;
        },
        async query(sqlText) {
          call += 1;
          if (String(sqlText).includes('AgentOnboardingLinks')) {
            return {
              recordset: [
                {
                  LinkId: LINK_ID,
                  LinkToken: LINK_TOKEN,
                  IsActive: true,
                  LinkName: 'Test Link',
                  TenantId: TENANT_ID,
                  AgencyId: null
                }
              ]
            };
          }
          if (String(sqlText).includes('OnboardingLinkCommissionCodes')) {
            return {
              recordset: [
                {
                  CodeId: 'code-1',
                  CommissionCode: 'KWJXS',
                  CommissionGroupId: null,
                  GrantTierLevel: grantTierLevel,
                  CommissionGroupName: null
                }
              ]
            };
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

describe('POST /api/public/onboarding/validate-code grant tier', () => {
  let app;

  beforeAll(() => {
    const onboardingRouter = require('../onboarding');
    app = express();
    app.use(express.json());
    app.use('/api/public/onboarding', onboardingRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockResolvedValue(makePool());
    assertGrantTierAllowed.mockResolvedValue({
      valid: false,
      message: 'Grant tier level is not a valid commission tier for this organization.'
    });
  });

  it('returns 400 when GrantTierLevel is not a tenant commission tier', async () => {
    const res = await request(app)
      .post('/api/public/onboarding/validate-code')
      .send({ linkToken: LINK_TOKEN, commissionCode: 'KWJXS' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/no longer valid for onboarding/i);
    expect(assertGrantTierAllowed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_ID,
        grantTierLevel: -2
      })
    );
  });

  it('returns success when grant tier validation passes', async () => {
    assertGrantTierAllowed.mockResolvedValue({ valid: true });
    getPool.mockResolvedValue(makePool({ grantTierLevel: 0, tierValid: true }));

    const res = await request(app)
      .post('/api/public/onboarding/validate-code')
      .send({ linkToken: LINK_TOKEN, commissionCode: 'WEEER' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
