/**
 * /api/prospects route wiring — visibility resolution, CRUD guards, communications,
 * and the CSV report. The service + hierarchy helpers are mocked; this exercises the
 * route logic (resolveVisibility, canAccessProspect, validation, status codes, route
 * ordering of /report vs /:id).
 *
 * Run: npx jest routes/__tests__/prospects.routes.test.js
 */

const express = require('express');
const request = require('supertest');

// --- Mocks ---
const mockQuery = jest.fn();
const fakePool = {
  request: () => {
    const r = { input: () => r, query: (sql) => mockQuery(sql) };
    return r;
  },
};

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => fakePool),
  sql: require('mssql'),
}));

let mockCurrentUser = null;
jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, res, next) => next(),
  getUserRoles: (user) => {
    if (!user) return [];
    if (Array.isArray(user.roles) && user.roles.length) return user.roles;
    if (user.currentRole) return [user.currentRole];
    return [];
  },
}));

jest.mock('../../utils/agentHierarchy', () => ({
  getSelfAndDownlineAgentIds: jest.fn(),
  getAgentIdsForAgency: jest.fn(),
  getDirectDownlineAgentIds: jest.fn(),
}));
jest.mock('../../utils/agencyAdmins', () => ({
  isAgencyAdmin: jest.fn(),
}));
jest.mock('../../services/messageQueue.service', () => ({
  queueEmail: jest.fn(async () => 'msg-email-1'),
  queueMessage: jest.fn(async () => 'msg-sms-1'),
}));
jest.mock('../../services/sendGridEmailService', () => ({
  getTenantEmailConfig: jest.fn(async () => ({
    tenantName: 'Test Tenant',
    dkimEnabled: false,
    customFromAddress: null,
  })),
}));
jest.mock('../../services/prospect.service', () => ({
  PROSPECT_STATUSES: ['New', 'Contacted', 'Proposal Sent', 'Closed', 'Lost'],
  normalizeEmail: (e) => (e ? e.toLowerCase() : null),
  normalizePhone: (p) => (p ? String(p).replace(/\D/g, '').slice(-10) : null),
  listProspects: jest.fn(),
  getProspectStats: jest.fn(),
  getProspect: jest.fn(),
  getProspectRow: jest.fn(),
  getProspectsForReport: jest.fn(),
  findOrCreateProspect: jest.fn(),
  confirmMemberLink: jest.fn(),
  deleteProspect: jest.fn(),
  getProspectCommunications: jest.fn(),
  getProspectProposals: jest.fn(),
  tagMessageWithProspect: jest.fn(),
  stampLastContacted: jest.fn(),
  reassignAgent: jest.fn(),
  getTag: jest.fn(),
  assignTag: jest.fn(),
  unassignTag: jest.fn(),
}));

const agentHierarchy = require('../../utils/agentHierarchy');
const agencyAdmins = require('../../utils/agencyAdmins');
const prospectService = require('../../services/prospect.service');
const MessageQueueService = require('../../services/messageQueue.service');
const prospectsRouter = require('../prospects');

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => console.error.mockRestore?.());

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = mockCurrentUser;
    req.tenantId = mockCurrentUser ? mockCurrentUser.TenantId : null;
    next();
  });
  app.use('/api/prospects', prospectsRouter);
  return app;
}

const AGENT_USER = { UserId: 'u-agent', TenantId: 't1', roles: ['Agent'], currentRole: 'Agent' };
const TENANT_ADMIN = { UserId: 'u-ta', TenantId: 't1', roles: ['TenantAdmin'], currentRole: 'TenantAdmin' };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  // Default: getMyAgentContext returns this agent in agency ag1.
  mockQuery.mockResolvedValue({ recordset: [{ AgentId: 'agent-self', AgencyId: 'ag1' }] });
  agentHierarchy.getSelfAndDownlineAgentIds.mockResolvedValue(['agent-self', 'agent-down']);
  agentHierarchy.getAgentIdsForAgency.mockResolvedValue(['agent-self', 'agent-down', 'agent-peer']);
  agentHierarchy.getDirectDownlineAgentIds.mockResolvedValue(['agent-down']);
  agencyAdmins.isAgencyAdmin.mockResolvedValue(false);
});

describe('GET /api/prospects (visibility)', () => {
  test('Agent default scope = self + downline', async () => {
    mockCurrentUser = AGENT_USER;
    prospectService.listProspects.mockResolvedValue({ prospects: [], total: 0 });
    const res = await request(buildApp()).get('/api/prospects');
    expect(res.status).toBe(200);
    expect(prospectService.listProspects).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', agentIds: ['agent-self', 'agent-down'] })
    );
  });

  test('Agent scope=self restricts to own agent id', async () => {
    mockCurrentUser = AGENT_USER;
    prospectService.listProspects.mockResolvedValue({ prospects: [], total: 0 });
    await request(buildApp()).get('/api/prospects?scope=self');
    expect(prospectService.listProspects).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ['agent-self'] })
    );
  });

  test('Agent requesting an agent outside their set → 403', async () => {
    mockCurrentUser = AGENT_USER;
    const res = await request(buildApp()).get('/api/prospects?agentId=stranger');
    expect(res.status).toBe(403);
    expect(prospectService.listProspects).not.toHaveBeenCalled();
  });

  test('TenantAdmin gets no agent restriction (whole tenant)', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.listProspects.mockResolvedValue({ prospects: [], total: 0 });
    await request(buildApp()).get('/api/prospects');
    expect(prospectService.listProspects).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: null })
    );
  });

  test('TenantAdmin with agencyId filters to that agency', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.listProspects.mockResolvedValue({ prospects: [], total: 0 });
    await request(buildApp()).get('/api/prospects?agencyId=ag9');
    expect(agentHierarchy.getAgentIdsForAgency).toHaveBeenCalledWith(expect.anything(), 'ag9');
  });
});

describe('GET /api/prospects/:id (access control)', () => {
  test('404 when prospect not in tenant', async () => {
    mockCurrentUser = AGENT_USER;
    prospectService.getProspect.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/prospects/p1');
    expect(res.status).toBe(404);
  });

  test('403 when owning agent is outside the requester downline', async () => {
    mockCurrentUser = AGENT_USER;
    prospectService.getProspect.mockResolvedValue({ prospect: { ProspectId: 'p1', AgentId: 'stranger' }, products: [], member: null });
    const res = await request(buildApp()).get('/api/prospects/p1');
    expect(res.status).toBe(403);
  });

  test('200 when owning agent is in the downline', async () => {
    mockCurrentUser = AGENT_USER;
    prospectService.getProspect.mockResolvedValue({ prospect: { ProspectId: 'p1', AgentId: 'agent-down' }, products: [], member: null });
    const res = await request(buildApp()).get('/api/prospects/p1');
    expect(res.status).toBe(200);
    expect(res.body.data.prospect.ProspectId).toBe('p1');
  });
});

describe('POST /api/prospects (create)', () => {
  test('400 when no name/email/phone', async () => {
    mockCurrentUser = AGENT_USER;
    const res = await request(buildApp()).post('/api/prospects').send({});
    expect(res.status).toBe(400);
  });

  test('agent create uses their own agent id', async () => {
    mockCurrentUser = AGENT_USER;
    prospectService.findOrCreateProspect.mockResolvedValue({ prospect: { ProspectId: 'new' }, created: true });
    const res = await request(buildApp()).post('/api/prospects').send({ email: 'a@b.com' });
    expect(res.status).toBe(201);
    expect(prospectService.findOrCreateProspect).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', agentId: 'agent-self', source: 'Manual' })
    );
  });
});

describe('PUT /api/prospects/:id', () => {
  test('400 on invalid status', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null });
    const res = await request(buildApp()).put('/api/prospects/p1').send({ status: 'Bogus' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/prospects/:id/confirm-member-link', () => {
  test('uses SuggestedMemberId when no memberId provided', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null, SuggestedMemberId: 'm-sug' });
    prospectService.confirmMemberLink.mockResolvedValue(true);
    prospectService.getProspect.mockResolvedValue({ prospect: { ProspectId: 'p1' }, products: [], member: null });
    const res = await request(buildApp()).post('/api/prospects/p1/confirm-member-link').send({});
    expect(res.status).toBe(200);
    expect(prospectService.confirmMemberLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberId: 'm-sug', tenantId: 't1' })
    );
  });

  test('400 when nothing to link', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null, SuggestedMemberId: null });
    const res = await request(buildApp()).post('/api/prospects/p1/confirm-member-link').send({});
    expect(res.status).toBe(400);
  });
});

describe('communications', () => {
  test('POST email channel queues an email and tags it', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null, Email: 'a@b.com', FirstName: 'A', LastName: 'B' });
    mockQuery
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({
        recordset: [{ FirstName: 'Tenant', LastName: 'Admin', Email: 'ta@test.com' }],
      });
    const res = await request(buildApp()).post('/api/prospects/p1/communications').send({ channel: 'email', subject: 'Hi', body: 'hello' });
    expect(res.status).toBe(200);
    expect(MessageQueueService.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: 'a@b.com',
        tenantId: 't1',
        replyToEmail: expect.any(String),
        fromEmail: expect.any(String),
        fromName: expect.any(String),
      })
    );
    expect(prospectService.tagMessageWithProspect).toHaveBeenCalledWith(expect.anything(), 'msg-email-1', 'p1');
  });

  test('POST email channel 400 when prospect has no email', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null, Email: null });
    const res = await request(buildApp()).post('/api/prospects/p1/communications').send({ channel: 'email', body: 'hello' });
    expect(res.status).toBe(400);
  });

  test('GET communications returns the merged list', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null });
    prospectService.getProspectCommunications.mockResolvedValue([{ messageId: 'm1', messageType: 'Email' }]);
    const res = await request(buildApp()).get('/api/prospects/p1/communications');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('GET /api/prospects/report (route ordering + CSV)', () => {
  test('returns CSV (not treated as /:id) with a header row', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectsForReport.mockResolvedValue([
      { FirstName: 'Jane', LastName: 'Doe', Email: 'jane@x.com', Phone: '2015551234', Status: 'New', ReferralName: 'Web', PremiumAmount: 250, Products: 'Plan A', AgentFirstName: 'Ag', AgentLastName: 'Ent', Source: 'Manual', IsMember: 'No', CreatedDate: '2026-05-20T00:00:00Z' },
    ]);
    const res = await request(buildApp()).get('/api/prospects/report');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/);
    expect(res.text.split('\n')[0]).toContain('First Name');
    expect(res.text).toContain('jane@x.com');
    // /:id detail must NOT have been used for "report"
    expect(prospectService.getProspect).not.toHaveBeenCalled();
  });

  test('quotes a field containing a comma', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectsForReport.mockResolvedValue([
      { FirstName: 'Jane', LastName: 'Doe', Email: 'j@x.com', Phone: '', Status: 'New', ReferralName: 'Smith, John', PremiumAmount: null, Products: 'A; B', AgentFirstName: '', AgentLastName: '', Source: 'Manual', IsMember: 'No', CreatedDate: '2026-05-20T00:00:00Z' },
    ]);
    const res = await request(buildApp()).get('/api/prospects/report');
    expect(res.text).toContain('"Smith, John"');
  });
});

describe('DELETE /api/prospects/:id', () => {
  test('deletes when accessible', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null });
    prospectService.deleteProspect.mockResolvedValue(true);
    const res = await request(buildApp()).delete('/api/prospects/p1');
    expect(res.status).toBe(200);
    expect(prospectService.deleteProspect).toHaveBeenCalled();
  });
});

describe('GET /api/prospects (sort / tag / follow-up params)', () => {
  test('forwards sortBy, sortDir, tags, followUp to the service', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.listProspects.mockResolvedValue({ prospects: [], total: 0 });
    await request(buildApp()).get('/api/prospects?sortBy=premium&sortDir=asc&tags=tag-1,tag-2&followUp=overdue');
    expect(prospectService.listProspects).toHaveBeenCalledWith(
      expect.objectContaining({
        sortBy: 'premium', sortDir: 'asc', tagIds: ['tag-1', 'tag-2'], followUp: 'overdue',
      })
    );
  });

  test('forwards the source filter to the service', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.listProspects.mockResolvedValue({ prospects: [], total: 0 });
    await request(buildApp()).get('/api/prospects?source=MightyWELL%20Website');
    expect(prospectService.listProspects).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'MightyWELL Website' })
    );
  });
});

describe('GET /api/prospects/stats (route ordering + visibility)', () => {
  test('returns stats and is NOT treated as /:id', async () => {
    mockCurrentUser = TENANT_ADMIN;
    const stats = {
      bySourceMonth: [{ month: '2026-05', source: 'Manual', count: 2 }],
      bySource: [{ source: 'Manual', count: 2 }],
      byStatus: [{ status: 'New', count: 2 }],
      totals: { total: 2, newThisMonth: 1, sources: 1 },
    };
    prospectService.getProspectStats.mockResolvedValue(stats);
    const res = await request(buildApp()).get('/api/prospects/stats');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(stats);
    expect(prospectService.getProspect).not.toHaveBeenCalled();
    expect(prospectService.getProspectStats).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', agentIds: null })
    );
  });

  test('Agent stats are scoped to self + downline', async () => {
    mockCurrentUser = AGENT_USER;
    prospectService.getProspectStats.mockResolvedValue({ bySourceMonth: [], bySource: [], byStatus: [], totals: { total: 0, newThisMonth: 0, sources: 0 } });
    await request(buildApp()).get('/api/prospects/stats');
    expect(prospectService.getProspectStats).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ['agent-self', 'agent-down'] })
    );
  });

  test('parses from/to into Date objects', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectStats.mockResolvedValue({ bySourceMonth: [], bySource: [], byStatus: [], totals: { total: 0, newThisMonth: 0, sources: 0 } });
    await request(buildApp()).get('/api/prospects/stats?from=2026-01-01&to=2026-06-01');
    const arg = prospectService.getProspectStats.mock.calls[0][0];
    expect(arg.from).toBeInstanceOf(Date);
    expect(arg.to).toBeInstanceOf(Date);
  });
});

describe('PUT /api/prospects/:id (follow-up date)', () => {
  test('400 on an invalid nextFollowUpDate', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null, Status: 'New' });
    const res = await request(buildApp()).put('/api/prospects/p1').send({ nextFollowUpDate: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/prospects/:id/reassign', () => {
  test('400 when agentId is missing', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null });
    const res = await request(buildApp()).post('/api/prospects/p1/reassign').send({});
    expect(res.status).toBe(400);
  });

  test('admin reassigns to a valid tenant agent', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: 'a-old' });
    prospectService.reassignAgent.mockResolvedValue(true);
    prospectService.getProspect.mockResolvedValue({ prospect: { ProspectId: 'p1', AgentId: 'a-new' }, products: [], member: null });
    // validateAgentInTenant query returns a row → valid.
    mockQuery.mockResolvedValue({ recordset: [{ AgentId: 'a-new' }] });
    const res = await request(buildApp()).post('/api/prospects/p1/reassign').send({ agentId: 'a-new' });
    expect(res.status).toBe(200);
    expect(prospectService.reassignAgent).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ prospectId: 'p1', agentId: 'a-new', tenantId: 't1' })
    );
  });
});

describe('tags assignment', () => {
  test('POST /:id/tags 400 when tag not in tenant', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null });
    prospectService.getTag.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/prospects/p1/tags').send({ tagId: 'tag-x' });
    expect(res.status).toBe(400);
    expect(prospectService.assignTag).not.toHaveBeenCalled();
  });

  test('POST /:id/tags assigns and returns detail', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null });
    prospectService.getTag.mockResolvedValue({ ProspectTagId: 'tag-1', TenantId: 't1' });
    prospectService.getProspect.mockResolvedValue({ prospect: { ProspectId: 'p1' }, products: [], member: null, tags: [{ ProspectTagId: 'tag-1' }] });
    const res = await request(buildApp()).post('/api/prospects/p1/tags').send({ tagId: 'tag-1' });
    expect(res.status).toBe(200);
    expect(prospectService.assignTag).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ prospectId: 'p1', tagId: 'tag-1', tenantId: 't1' })
    );
  });

  test('DELETE /:id/tags/:tagId unassigns', async () => {
    mockCurrentUser = TENANT_ADMIN;
    prospectService.getProspectRow.mockResolvedValue({ ProspectId: 'p1', TenantId: 't1', AgentId: null });
    prospectService.getProspect.mockResolvedValue({ prospect: { ProspectId: 'p1' }, products: [], member: null, tags: [] });
    const res = await request(buildApp()).delete('/api/prospects/p1/tags/tag-1');
    expect(res.status).toBe(200);
    expect(prospectService.unassignTag).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ prospectId: 'p1', tagId: 'tag-1' })
    );
  });
});
