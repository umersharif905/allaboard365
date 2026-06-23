// Filtered-group audience endpoints on the message-blast route:
//   - GET  /audience-options  -> products/bundles + agencies
//   - POST /audience-count    -> resolved counts + opt-out exclusions; maps AudienceError to 400
//   - POST /send              -> enforces the per-channel recipient cap
const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = req.testUser; next(); },
  authorize: (allowed) => (req, res, next) => {
    const role = req.user?.userType;
    if (!allowed.includes(role)) return res.status(403).json({ success: false });
    next();
  },
  getUserRoles: (u) => u?.roles || [u?.userType]
}));

jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue({
    request: () => ({
      input: function () { return this; },
      query: jest.fn().mockResolvedValue({ recordset: [] })
    })
  }),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: Object.assign(() => 'NVarChar', { MAX: 'MAX' }),
    Int: 'Int'
  }
}));

const mockResolveAudience = jest.fn();
const mockGetAudienceOptions = jest.fn();
jest.mock('../../services/blastAudience.service', () => {
  // Real AudienceError class (defined inside the factory) so `instanceof`
  // checks in the route resolve against the same constructor.
  class AudienceError extends Error {
    constructor(m) { super(m); this.name = 'AudienceError'; }
  }
  return {
    AudienceError,
    BLAST_MAX_RECIPIENTS: 2, // tiny cap so tests can trip it easily
    resolveAudience: (...a) => mockResolveAudience(...a),
    getAudienceOptions: (...a) => mockGetAudienceOptions(...a)
  };
});
// Pull the in-factory class back so tests can construct AudienceError instances.
const { AudienceError } = require('../../services/blastAudience.service');

jest.mock('../../services/messagingScope.service', () => ({
  resolveMessagingScope: jest.fn().mockResolvedValue({ vendorIdFilter: null, isVendor: false })
}));

const mockQueueBulk = jest.fn().mockResolvedValue('bulk-msg-1');
jest.mock('../../services/messageQueue.service', () => ({
  queueBulkBatchMessage: (...a) => mockQueueBulk(...a)
}));

jest.mock('twilio', () => () => ({}));

const blastRouter = require('../me/tenant-admin/message-blast');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { UserId: 'u1', userType: 'TenantAdmin', TenantId: 't1', roles: ['TenantAdmin'] };
    req.tenantId = 't1';
    next();
  });
  app.use('/', blastRouter);
  return app;
}

beforeEach(() => {
  mockResolveAudience.mockReset();
  mockGetAudienceOptions.mockReset();
  mockQueueBulk.mockClear();
});

describe('GET /audience-options', () => {
  it('returns products and agencies', async () => {
    mockGetAudienceOptions.mockResolvedValue({
      products: [{ id: 'p1', name: 'Dental', isBundle: false }],
      agencies: [{ id: 'a1', name: 'Acme' }]
    });
    const res = await request(makeApp()).get('/audience-options');
    expect(res.status).toBe(200);
    expect(res.body.data.products).toHaveLength(1);
    expect(res.body.data.agencies[0].name).toBe('Acme');
  });
});

describe('POST /audience-count', () => {
  it('returns resolved counts + opt-out exclusions', async () => {
    mockResolveAudience.mockResolvedValue({
      emails: ['a@x.com', 'b@x.com'],
      phones: ['+15550000001'],
      emailOptedOut: 3,
      smsOptedOut: 1
    });
    const res = await request(makeApp())
      .post('/audience-count')
      .send({ audienceType: 'active_members' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      emailRecipients: 2,
      smsRecipients: 1,
      emailOptedOut: 3,
      smsOptedOut: 1,
      maxRecipients: 2
    });
  });

  it('maps AudienceError to HTTP 400', async () => {
    mockResolveAudience.mockRejectedValue(new AudienceError('Select at least one product or bundle'));
    const res = await request(makeApp())
      .post('/audience-count')
      .send({ audienceType: 'members_by_product', productIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/product or bundle/i);
  });
});

describe('POST /send — cap enforcement', () => {
  it('rejects when audience exceeds the per-channel cap', async () => {
    // 3 emails > cap of 2
    mockResolveAudience.mockResolvedValue({
      emails: ['a@x.com', 'b@x.com', 'c@x.com'],
      phones: [],
      emailOptedOut: 0,
      smsOptedOut: 0
    });
    const res = await request(makeApp())
      .post('/send')
      .send({
        sendEmail: true,
        sendSMS: false,
        body: '<p>hi</p>',
        audience: { audienceType: 'active_members' }
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/limit is 2/i);
    expect(mockQueueBulk).not.toHaveBeenCalled();
  });

  it('queues a bulk job when within the cap', async () => {
    mockResolveAudience.mockResolvedValue({
      emails: ['a@x.com', 'b@x.com'],
      phones: [],
      emailOptedOut: 0,
      smsOptedOut: 0
    });
    const res = await request(makeApp())
      .post('/send')
      .send({
        sendEmail: true,
        sendSMS: false,
        body: '<p>hi</p>',
        audience: { audienceType: 'active_members' }
      });
    expect(res.status).toBe(200);
    expect(res.body.data.emailsQueued).toBe(2);
    expect(mockQueueBulk).toHaveBeenCalledTimes(1);
  });
});
