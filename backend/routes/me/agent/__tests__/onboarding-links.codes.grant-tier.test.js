/**
 * Agent onboarding link add-code rejects orphan GrantTierLevel. Mocked DB only.
 */

const request = require('supertest');
const express = require('express');

const TENANT_ID = '55EB7262-4DB6-4614-82A8-23FC2E91203B';
const LINK_ID = '25BF3CF4-DFEE-4275-9999-C188070B1331';
const AGENT_ID = 'A88E3E2B-41AD-44F9-9885-1E36BF2130F6';
const USER_ID = '2175DB76-1E27-4FE8-A97B-F1F9785E47C9';

jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(),
  sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

jest.mock('../../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock('../../../../middleware/auth', () => ({
  authorize: () => (_req, _res, next) => next()
}));

jest.mock('../../../../utils/agentHierarchy', () => ({
  isUplineAncestor: jest.fn(),
  isAgencyAdmin: jest.fn()
}));

jest.mock('../../../../services/onboardingLinkCommissionAutoGenerate.service', () => ({
  runAutoGenerateCommissionCodes: jest.fn()
}));

jest.mock('../../../../services/onboardingLinkGrantTierValidation.service', () => ({
  assertGrantTierAllowed: jest.fn()
}));

const { getPool } = require('../../../../config/database');
const { assertGrantTierAllowed } = require('../../../../services/onboardingLinkGrantTierValidation.service');

function makePool() {
  return {
    request() {
      const self = {
        input() {
          return self;
        },
        async query(sqlText) {
          const s = String(sqlText);
          if (s.includes('FROM oe.Agents') && s.includes('UserId')) {
            return { recordset: [{ AgentId: AGENT_ID }] };
          }
          if (s.includes('FROM oe.AgentOnboardingLinks') && s.includes('AgentId')) {
            return {
              recordset: [{ AgentId: AGENT_ID, AgencyId: '3BD2BE1C-EB7E-4D6A-93AA-3453C5809EF3' }]
            };
          }
          if (s.includes('FROM oe.Agents') && s.includes('CommissionTierLevel')) {
            return {
              recordset: [{ CommissionTierLevel: 1, CommissionGroupId: null }]
            };
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

describe('POST /api/me/agent/onboarding-links/:linkId/codes grant tier', () => {
  let app;

  beforeAll(() => {
    const router = require('../onboarding-links');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { UserId: USER_ID, TenantId: TENANT_ID, currentRole: 'Agent', roles: ['Agent'] };
      next();
    });
    app.use('/api/me/agent/onboarding-links', router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockResolvedValue(makePool());
    assertGrantTierAllowed.mockResolvedValue({
      valid: false,
      message: 'Grant tier level is not a valid commission tier for this organization.'
    });
  });

  it('returns 400 when grantTierLevel is not a tenant commission tier', async () => {
    const res = await request(app)
      .post(`/api/me/agent/onboarding-links/${LINK_ID}/codes`)
      .send({ commissionCode: 'BAD01', grantTierLevel: -2 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not a valid commission tier/i);
    expect(assertGrantTierAllowed).toHaveBeenCalled();
  });
});
