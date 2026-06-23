// Test scope filtering on key campaigns endpoints.
// Revised 2026-05-11: no-globals model — SysAdmin sees ANY; duplicate preserves source scope.
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
jest.mock('../../middleware/requireTenantAccess', () => (req, _res, next) => {
  req.tenantId = req.testUser?.TenantId || null;
  next();
});

const mockQueries = [];
let selectRecordsetByPredicate = null; // optional override for specific SELECT responses

const mockPool = {
  request: () => {
    const r = {
      _inputs: {},
      input: function (name, _type, value) { this._inputs[name] = value; return this; },
      query: jest.fn().mockImplementation(function (sqlText) {
        mockQueries.push({ sql: sqlText, inputs: { ...this._inputs } });
        if (sqlText.includes('SELECT COUNT')) return Promise.resolve({ recordset: [{ total: 0 }] });
        if (selectRecordsetByPredicate) {
          const override = selectRecordsetByPredicate(sqlText, this._inputs);
          if (override) return Promise.resolve(override);
        }
        return Promise.resolve({ recordset: [], rowsAffected: [1] });
      })
    };
    return r;
  }
};
jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue(mockPool),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: () => 'NVarChar', Int: 'Int', Bit: 'Bit' }
}));
jest.mock('../../services/messagingScope.service', () => ({
  resolveMessagingScope: jest.fn(async (req) => {
    if (req.user?.userType?.startsWith('Vendor')) return { vendorIdFilter: 'vendor-uuid-1', isVendor: true };
    return { vendorIdFilter: null, isVendor: false };
  }),
  ScopeError: class ScopeError extends Error {}
}));

const campaignsRouter = require('../campaigns');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-role']) {
      req.testUser = { UserId: 'u1', userType: req.headers['x-test-role'], TenantId: 't1', roles: [req.headers['x-test-role']] };
    }
    next();
  });
  app.use('/', campaignsRouter);
  return app;
}

beforeEach(() => { mockQueries.length = 0; selectRecordsetByPredicate = null; });

describe('campaigns scope (no-globals model)', () => {
  it('GET / — VendorAdmin scopes to VendorId = @vendorIdFilter (no TenantId clause; vendor rows have TenantId IS NULL)', async () => {
    const app = makeApp();
    await request(app).get('/').set('x-test-role', 'VendorAdmin').expect(200);
    const listQuery = mockQueries.find(q => q.sql.includes('FROM oe.Campaigns'));
    expect(listQuery.sql).toMatch(/VendorId\s*=\s*@vendorIdFilter/);
    expect(listQuery.sql).not.toMatch(/TenantId\s*=\s*@tenantId/);
  });

  it('GET / — TenantAdmin scopes to TenantId + VendorId IS NULL', async () => {
    const app = makeApp();
    await request(app).get('/').set('x-test-role', 'TenantAdmin').expect(200);
    const listQuery = mockQueries.find(q => q.sql.includes('FROM oe.Campaigns'));
    expect(listQuery.sql).toMatch(/VendorId\s+IS\s+NULL/);
    expect(listQuery.sql).toMatch(/TenantId\s*=\s*@tenantId/);
  });

  it('GET / — SysAdmin (no params) sees ANY rows (no base filter)', async () => {
    const app = makeApp();
    await request(app).get('/').set('x-test-role', 'SysAdmin').expect(200);
    const listQuery = mockQueries.find(q => q.sql.includes('FROM oe.Campaigns'));
    expect(listQuery.sql).not.toMatch(/c\.VendorId\s+IS\s+NULL/);
    expect(listQuery.sql).not.toMatch(/c\.VendorId\s+IS\s+NOT\s+NULL/);
    expect(listQuery.inputs.tenantId).toBeUndefined();
  });

  it('GET /?scope=tenant — SysAdmin narrows to VendorId IS NULL', async () => {
    const app = makeApp();
    await request(app).get('/?scope=tenant').set('x-test-role', 'SysAdmin').expect(200);
    const listQuery = mockQueries.find(q => q.sql.includes('FROM oe.Campaigns'));
    expect(listQuery.sql).toMatch(/c\.VendorId\s+IS\s+NULL/);
  });

  it('GET /?scope=vendor — SysAdmin narrows to VendorId IS NOT NULL', async () => {
    const app = makeApp();
    await request(app).get('/?scope=vendor').set('x-test-role', 'SysAdmin').expect(200);
    const listQuery = mockQueries.find(q => q.sql.includes('FROM oe.Campaigns'));
    expect(listQuery.sql).toMatch(/c\.VendorId\s+IS\s+NOT\s+NULL/);
  });

  it('GET / response payload includes VendorId column', async () => {
    const app = makeApp();
    await request(app).get('/').set('x-test-role', 'TenantAdmin').expect(200);
    const listQuery = mockQueries.find(q => q.sql.includes('FROM oe.Campaigns'));
    expect(listQuery.sql).toMatch(/c\.VendorId/);
  });

  it('POST / — VendorAdmin insert binds VendorId and stores TenantId IS NULL (XOR)', async () => {
    const app = makeApp();
    await request(app).post('/').set('x-test-role', 'VendorAdmin')
      .send({ campaignName: 'C', triggerType: 'EnrollmentCompletion' })
      .expect(201);
    const insert = mockQueries.find(q => q.sql.includes('INSERT INTO oe.Campaigns'));
    expect(insert.sql).toMatch(/VendorId/);
    expect(insert.inputs.vendorId).toBe('vendor-uuid-1');
    expect(insert.inputs.tenantId).toBeNull();
  });

  it('POST / — TenantAdmin insert binds VendorId to NULL', async () => {
    const app = makeApp();
    await request(app).post('/').set('x-test-role', 'TenantAdmin')
      .send({ campaignName: 'C', triggerType: 'EnrollmentCompletion' })
      .expect(201);
    const insert = mockQueries.find(q => q.sql.includes('INSERT INTO oe.Campaigns'));
    expect(insert.inputs.vendorId).toBeNull();
    expect(insert.inputs.tenantId).toBe('t1');
  });

  it('POST / — SysAdmin with createForVendorId creates a vendor campaign with TenantId IS NULL (XOR)', async () => {
    const app = makeApp();
    await request(app).post('/').set('x-test-role', 'SysAdmin')
      .send({
        campaignName: 'C',
        triggerType: 'EnrollmentCompletion',
        createForTenantId: 'tenant-IGNORED',
        createForVendorId: 'vendor-target'
      })
      .expect(201);
    const insert = mockQueries.find(q => q.sql.includes('INSERT INTO oe.Campaigns'));
    expect(insert.inputs.tenantId).toBeNull();
    expect(insert.inputs.vendorId).toBe('vendor-target');
    // No oe.Users lookup should have run (no inference needed under XOR).
    const lookup = mockQueries.find(q => /FROM\s+oe\.Users/i.test(q.sql) && /VendorId\s*=\s*@vendorId/.test(q.sql));
    expect(lookup).toBeUndefined();
  });

  it('POST / — SysAdmin with createForTenantId only binds VendorId to NULL', async () => {
    const app = makeApp();
    await request(app).post('/').set('x-test-role', 'SysAdmin')
      .send({
        campaignName: 'C',
        triggerType: 'EnrollmentCompletion',
        createForTenantId: 'tenant-target'
      })
      .expect(201);
    const insert = mockQueries.find(q => q.sql.includes('INSERT INTO oe.Campaigns'));
    expect(insert.inputs.tenantId).toBe('tenant-target');
    expect(insert.inputs.vendorId).toBeNull();
  });

  it('POST /:id/steps — rejects when campaign is out of scope', async () => {
    const app = makeApp();
    const res = await request(app).post('/some-campaign-id/steps').set('x-test-role', 'VendorAdmin')
      .send({ stepOrder: 1, delayDays: 0, emailTemplateId: null });
    expect([400, 403, 404]).toContain(res.status);
  });

  it('POST /:id/duplicate — copies source TenantId AND VendorId regardless of caller', async () => {
    const app = makeApp();
    // Pretend the source campaign is owned by a different tenant + a vendor.
    selectRecordsetByPredicate = (sqlText) => {
      if (sqlText.includes('SELECT * FROM oe.Campaigns') && sqlText.includes('CampaignId = @campaignId')) {
        return {
          recordset: [{
            CampaignId: 'src-1',
            TenantId: 'tenant-source',
            VendorId: 'vendor-source',
            CampaignName: 'Source Campaign',
            TriggerType: 'EnrollmentCompletion'
          }]
        };
      }
      if (sqlText.includes('FROM oe.CampaignSteps') && sqlText.includes('SELECT')) {
        return { recordset: [] };
      }
      return null;
    };

    // SysAdmin caller — would otherwise have no vendor scope; verify the duplicate preserves source.
    await request(app).post('/src-1/duplicate').set('x-test-role', 'SysAdmin').expect(201);
    const insert = mockQueries.find(q => q.sql.includes('INSERT INTO oe.Campaigns'));
    expect(insert).toBeDefined();
    expect(insert.inputs.tenantId).toBe('tenant-source');
    expect(insert.inputs.vendorId).toBe('vendor-source');
  });
});
