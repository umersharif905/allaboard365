/**
 * Commission preview downline-agent route + service tests.
 * Mocked DB only — no live writes (prod DB policy).
 */

const request = require('supertest');
const express = require('express');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';
const VIEWER_AGENT_ID = '33333333-3333-3333-3333-333333333333';
const SUBJECT_AGENT_ID = '44444444-4444-4444-4444-444444444444';
const GROUP_ID = '55555555-5555-5555-5555-555555555555';

jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(),
  sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

jest.mock('../../../../middleware/auth', () => ({
  authorize: () => (_req, _res, next) => next(),
  authenticate: (_req, _res, next) => next(),
  getUserRoles: (user) => user?.roles || ['Agent']
}));

jest.mock('../../../../middleware/requireTenantAccess', () => {
  return (req, _res, next) => {
    if (!req.user) {
      req.user = {
        UserId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        TenantId: TENANT_ID,
        currentRole: 'Agent',
        roles: ['Agent']
      };
    }
    req.tenantId = TENANT_ID;
    next();
  };
});

jest.mock('../../../../utils/agentHierarchy', () => ({
  isUplineAncestor: jest.fn()
}));

jest.mock('../../../../services/agentProductCommissionPreview.service', () => ({
  getAgentProductCommissionPreview: jest.fn(),
  getDownlineAgentProductCommissionPreview: jest.fn(),
  getTenantProductCommissionPreview: jest.fn(),
  listTenantCommissionGroups: jest.fn()
}));

jest.mock('../../../uploads', () => ({
  authenticateUrls: jest.fn(),
  authenticateProductDocumentsArray: jest.fn()
}));
jest.mock('../../../../services/shared/product-documents.service', () => ({
  getProductDocumentsForProductIds: jest.fn()
}));
jest.mock('../../../../services/quickQuotePdf.service', () => ({
  generateQuickQuotePdfBuffer: jest.fn()
}));
jest.mock('../../../../services/proposalGenerator.service', () => ({}));
jest.mock('../../../../services/sendGridEmailService', () => ({}));
jest.mock('../../../../services/sendGridEmailDeliveryTracking.service', () => ({}));
jest.mock('../../../../services/messageQueue.service', () => ({}));

const { getPool } = require('../../../../config/database');
const { isUplineAncestor } = require('../../../../utils/agentHierarchy');
const {
  getAgentProductCommissionPreview,
  getDownlineAgentProductCommissionPreview,
  getTenantProductCommissionPreview
} = require('../../../../services/agentProductCommissionPreview.service');

function makeAgentLookupPool(agentId = VIEWER_AGENT_ID) {
  return {
    request() {
      const self = {
        input() {
          return self;
        },
        async query(sql) {
          if (/FROM oe\.Agents/i.test(sql) && /UserId = @UserId/i.test(sql)) {
            return { recordset: [{ AgentId: agentId }] };
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

function buildApp(userOverrides = {}) {
  const routes = require('../products');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      UserId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      TenantId: TENANT_ID,
      currentRole: 'Agent',
      roles: ['Agent'],
      ...userOverrides
    };
    req.tenantId = TENANT_ID;
    next();
  });
  app.use('/api/me/agent/products', routes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  getPool.mockImplementation(async () => makeAgentLookupPool());
});

describe('GET /api/me/agent/products/:productId/commission-preview downlineAgentId', () => {
  test('returns downline preview when subject is in viewer downline', async () => {
    isUplineAncestor.mockResolvedValue(true);
    getDownlineAgentProductCommissionPreview.mockResolvedValue({
      hasPayout: true,
      viewerRole: 'downlineAgent',
      subjectAgentName: 'Jane Smith',
      agentsCanViewOtherCommissionLevels: true,
      agentLevel: { sortOrder: 2, displayName: 'Agent' },
      ruleName: 'Standard',
      ruleSource: 'product',
      rows: [
        { levelSortOrder: 1, label: 'GA', isAgentLevel: false, payoutMode: 'flat', flatAmount: 10 },
        { levelSortOrder: 2, label: 'Agent', isAgentLevel: true, payoutMode: 'flat', flatAmount: 25 }
      ],
      message: null
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/me/agent/products/${PRODUCT_ID}/commission-preview`)
      .query({ downlineAgentId: SUBJECT_AGENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.viewerRole).toBe('downlineAgent');
    expect(res.body.data.subjectAgentName).toBe('Jane Smith');
    expect(getDownlineAgentProductCommissionPreview).toHaveBeenCalledWith({
      viewerAgentId: VIEWER_AGENT_ID,
      subjectAgentId: SUBJECT_AGENT_ID,
      tenantId: TENANT_ID,
      productId: PRODUCT_ID
    });
    expect(getAgentProductCommissionPreview).not.toHaveBeenCalled();
  });

  test('returns 403 when subject is not in viewer downline', async () => {
    isUplineAncestor.mockResolvedValue(false);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/me/agent/products/${PRODUCT_ID}/commission-preview`)
      .query({ downlineAgentId: SUBJECT_AGENT_ID });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/downline/i);
    expect(getDownlineAgentProductCommissionPreview).not.toHaveBeenCalled();
  });

  test('falls through to self preview when downlineAgentId equals caller agentId', async () => {
    getAgentProductCommissionPreview.mockResolvedValue({
      hasPayout: true,
      agentsCanViewOtherCommissionLevels: false,
      agentLevel: { sortOrder: 1, displayName: 'GA' },
      ruleName: 'Self',
      ruleSource: 'product',
      rows: [{ levelSortOrder: 1, label: 'GA', isAgentLevel: true, payoutMode: 'flat', flatAmount: 10 }],
      message: null
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/me/agent/products/${PRODUCT_ID}/commission-preview`)
      .query({ downlineAgentId: VIEWER_AGENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.viewerRole).toBe('agent');
    expect(getAgentProductCommissionPreview).toHaveBeenCalled();
    expect(getDownlineAgentProductCommissionPreview).not.toHaveBeenCalled();
    expect(isUplineAncestor).not.toHaveBeenCalled();
  });

  test('returns self preview when downlineAgentId is absent', async () => {
    getAgentProductCommissionPreview.mockResolvedValue({
      hasPayout: true,
      agentsCanViewOtherCommissionLevels: false,
      agentLevel: { sortOrder: 1, displayName: 'GA' },
      ruleName: 'Self',
      ruleSource: 'product',
      rows: [],
      message: null
    });

    const app = buildApp();
    const res = await request(app).get(`/api/me/agent/products/${PRODUCT_ID}/commission-preview`);

    expect(res.status).toBe(200);
    expect(res.body.data.viewerRole).toBe('agent');
    expect(getAgentProductCommissionPreview).toHaveBeenCalled();
    expect(getDownlineAgentProductCommissionPreview).not.toHaveBeenCalled();
  });

  test('TenantAdmin uses tenant path and ignores downlineAgentId', async () => {
    getTenantProductCommissionPreview.mockResolvedValue({
      hasPayout: true,
      agentsCanViewOtherCommissionLevels: true,
      agentLevel: { sortOrder: 0, displayName: 'All levels' },
      ruleName: 'Tenant rule',
      ruleSource: 'product',
      rows: [{ levelSortOrder: 0, label: 'All', isAgentLevel: false, payoutMode: 'flat', flatAmount: 5 }],
      message: null,
      commissionGroupName: 'Default Group'
    });

    const app = buildApp({ currentRole: 'TenantAdmin', roles: ['TenantAdmin'] });
    const res = await request(app)
      .get(`/api/me/agent/products/${PRODUCT_ID}/commission-preview`)
      .query({ commissionGroupId: GROUP_ID, downlineAgentId: SUBJECT_AGENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.viewerRole).toBe('tenant');
    expect(getTenantProductCommissionPreview).toHaveBeenCalled();
    expect(getDownlineAgentProductCommissionPreview).not.toHaveBeenCalled();
    expect(isUplineAncestor).not.toHaveBeenCalled();
  });
});
