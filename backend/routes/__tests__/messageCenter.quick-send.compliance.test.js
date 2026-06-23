/**
 * POST /api/message-center/quick-send — marketing compliance (Joey's two bugs).
 *
 * Bug #1: Quick Send of a MARKETING template must attach the CAN-SPAM footer +
 *         List-Unsubscribe (i.e. pass `marketingCompliance` to queueEmail).
 * Bug #2: Quick Send must RESPECT a member's email-marketing opt-out — an
 *         unsubscribed member is skipped, not emailed.
 *
 * SYSTEM (transactional) templates ignore opt-out and carry no footer.
 *
 * The router requires its collaborators inline, so jest.mock intercepts them.
 *
 * Run: npx jest routes/__tests__/messageCenter.quick-send.compliance.test.js
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = req.testUser; next(); },
  authorize: (allowed) => (req, res, next) => {
    const role = req.user?.userType;
    if (!allowed.includes(role)) return res.status(403).json({ success: false, message: 'forbidden' });
    next();
  },
  getUserRoles: (user) => user?.roles || [user?.userType]
}));
jest.mock('../../middleware/requireTenantAccess', () => (req, _res, next) => {
  req.tenantId = req.testUser?.TenantId || null;
  next();
});
jest.mock('../../services/messagingScope.service', () => ({
  resolveMessagingScope: jest.fn(async () => ({ vendorIdFilter: null, isVendor: false }))
}));

// Member directory used by the quick-send recipient lookup.
// email -> { MemberId, ... } ; absent email => non-member (Users fallback empty).
const mockMembers = {
  'optedin@example.com': { MemberId: 'member-in', UserId: 'user-in', TenantId: 'tenant-1' },
  'optedout@example.com': { MemberId: 'member-out', UserId: 'user-out', TenantId: 'tenant-1' }
};
const mockOptedOut = new Set(['member-out']);

// Template registry for the scope-check query.
let mockTemplate = { TemplateId: 'tpl-mkt', MessageCategory: 'Marketing' };

const mockQueueEmail = jest.fn(async () => 'msg-' + Math.random().toString(36).slice(2));

jest.mock('../../services/messageQueue.service', () => ({
  queueEmail: (...args) => mockQueueEmail(...args)
}));
jest.mock('../../services/memberCommunicationPreferences.service', () => ({
  isEmailMarketingOptedOut: jest.fn(async (memberId) => mockOptedOut.has(memberId))
}));
jest.mock('../../services/welcomeEmail.service', () => ({
  substituteVariables: (s) => s,
  loadAgentContext: jest.fn(async () => ({})),
  loadTenantContext: jest.fn(async () => ({ Name: 'Tenant One' })),
  loadGroupContext: jest.fn(async () => ({}))
}));
jest.mock('../../services/shared/variableSubstitution', () => ({
  SQL_MEMBER_EFFECTIVE_TERMINATION_DATE: 'NULL',
  substituteVariables: (s) => s
}));

const mockPool = {
  request: () => {
    const r = {
      _inputs: {},
      input(name, _type, value) { this._inputs[name] = value !== undefined ? value : _type; return this; },
      query: jest.fn(async function (sqlText) {
        // 1) Template scope check (now also selects MessageCategory)
        if (/FROM oe\.MessageTemplates/i.test(sqlText) && /MessageCategory/i.test(sqlText)) {
          return { recordset: mockTemplate ? [mockTemplate] : [] };
        }
        // 2) Recipient member lookup by email
        if (/FROM oe\.Members/i.test(sqlText) && /LOWER\(u\.Email\)/i.test(sqlText)) {
          const email = String(this._inputs.email || '').toLowerCase();
          const m = mockMembers[email];
          return { recordset: m ? [{ ...m, FirstName: 'T', LastName: 'U', Email: email, PhoneNumber: '' }] : [] };
        }
        // 3) Users fallback (non-member recipients)
        if (/FROM oe\.Users/i.test(sqlText)) {
          return { recordset: [] };
        }
        // 4) Tenant footer fields
        if (/FROM oe\.Tenants/i.test(sqlText)) {
          return { recordset: [{ Name: 'Tenant One', PrimaryAddress: '1 A St', PrimaryCity: 'Town', PrimaryState: 'TS', PrimaryZip: '00000' }] };
        }
        return { recordset: [] };
      })
    };
    return r;
  }
};
jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue(mockPool),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: () => 'NVarChar', Int: 'Int', Bit: 'Bit', MAX: 'MAX' }
}));

const messageCenterRouter = require('../messageCenter');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.testUser = { UserId: 'admin-1', userType: 'TenantAdmin', TenantId: 'tenant-1', roles: ['TenantAdmin'] };
    next();
  });
  app.use('/api/message-center', messageCenterRouter);
  return app;
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.(); console.warn.mockRestore?.(); console.error.mockRestore?.();
});
beforeEach(() => {
  mockQueueEmail.mockClear();
  mockTemplate = { TemplateId: 'tpl-mkt', MessageCategory: 'Marketing' };
});

describe('quick-send — Bug #2: respects member email-marketing opt-out (Marketing template)', () => {
  it('skips an opted-out member and does NOT queue an email', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/message-center/quick-send')
      .send({ templateId: 'tpl-mkt', recipientEmails: ['optedout@example.com'], subject: 'S', body: 'B' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.skippedEmails).toContain('optedout@example.com');
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });

  it('queues for an opted-in member WITH marketingCompliance (footer + List-Unsubscribe) — Bug #1', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/message-center/quick-send')
      .send({ templateId: 'tpl-mkt', recipientEmails: ['optedin@example.com'], subject: 'S', body: 'B' })
      .expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    const arg = mockQueueEmail.mock.calls[0][0];
    expect(arg.marketingCompliance).toBeTruthy();
    expect(arg.marketingCompliance.memberId).toBe('member-in');
    expect(arg.marketingCompliance.tenantId).toBe('tenant-1');
    // CAN-SPAM postal line assembled from tenant address fields
    expect(arg.marketingCompliance.postalLine).toContain('1 A St');
  });

  it('mixed batch queues only the opted-in member and reports the skip', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/message-center/quick-send')
      .send({ templateId: 'tpl-mkt', recipientEmails: ['optedin@example.com', 'optedout@example.com'], subject: 'S', body: 'B' })
      .expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    expect(mockQueueEmail.mock.calls[0][0].toEmail).toBe('optedin@example.com');
  });
});

describe('quick-send — System (transactional) template', () => {
  beforeEach(() => { mockTemplate = { TemplateId: 'tpl-sys', MessageCategory: 'System' }; });

  it('sends to an opted-out member (opt-out ignored) and attaches NO marketing footer', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/message-center/quick-send')
      .send({ templateId: 'tpl-sys', recipientEmails: ['optedout@example.com'], subject: 'S', body: 'B' })
      .expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    expect(mockQueueEmail.mock.calls[0][0].marketingCompliance).toBeNull();
  });
});

describe('quick-send — free-form (no templateId) is treated as System', () => {
  it('does not attach a footer and does not skip', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/message-center/quick-send')
      .send({ recipientEmails: ['optedout@example.com'], subject: 'S', body: 'Hello' })
      .expect(200);

    expect(res.body.count).toBe(1);
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    expect(mockQueueEmail.mock.calls[0][0].marketingCompliance).toBeNull();
  });
});

describe('quick-send — validation & auth', () => {
  it('rejects when no valid recipient email', async () => {
    const app = makeApp();
    await request(app).post('/api/message-center/quick-send')
      .send({ templateId: 'tpl-mkt', recipientEmails: ['not-an-email'], subject: 'S', body: 'B' })
      .expect(400);
  });

  it('forbids a role outside the allowlist (Member)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.testUser = { UserId: 'm', userType: 'Member', TenantId: 'tenant-1', roles: ['Member'] }; next(); });
    app.use('/api/message-center', messageCenterRouter);
    await request(app).post('/api/message-center/quick-send')
      .send({ templateId: 'tpl-mkt', recipientEmails: ['optedin@example.com'], subject: 'S', body: 'B' })
      .expect(403);
  });
});
