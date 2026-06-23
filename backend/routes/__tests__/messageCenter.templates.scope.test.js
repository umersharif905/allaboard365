// Test the scope filtering on /api/message-center/templates handlers.
// Mocks the DB pool and asserts that the right WHERE/INSERT clauses are sent.
//
// Revised 2026-05-11 (no-globals model):
//   - Vendor caller: TenantId = userTenantId AND VendorId = vendorIdFilter
//   - TenantAdmin:   TenantId = userTenantId AND VendorId IS NULL
//   - SysAdmin:      no base filter — narrowed only via ?scope= and ?tenantId=
const request = require('supertest');
const express = require('express');

// Mock auth + DB before requiring the router
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

const mockQueries = [];
const mockPool = {
  request: () => {
    const r = {
      _inputs: {},
      input: function (name, _type, value) { this._inputs[name] = value; return this; },
      query: jest.fn().mockImplementation(function (sqlText) {
        mockQueries.push({ sql: sqlText, inputs: { ...this._inputs } });
        if (sqlText.includes('COUNT(*)')) return Promise.resolve({ recordset: [{ total: 0 }] });
        if (sqlText.trim().startsWith('INSERT')) return Promise.resolve({ recordset: [], rowsAffected: [1] });
        return Promise.resolve({ recordset: [] });
      })
    };
    return r;
  }
};
jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue(mockPool),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: (len) => `NVarChar(${len})`,
    Int: 'Int',
    Bit: 'Bit',
    MAX: 'MAX'
  }
}));

jest.mock('../../services/messagingScope.service', () => {
  const actual = jest.requireActual('../../services/messagingScope.service');
  return {
    ...actual,
    resolveMessagingScope: jest.fn(async (req) => {
      if (req.user?.userType === 'VendorAdmin' || req.user?.userType === 'VendorAgent') {
        return { vendorIdFilter: 'vendor-uuid-1', isVendor: true };
      }
      return { vendorIdFilter: null, isVendor: false };
    })
  };
});

const messageCenterRouter = require('../messageCenter');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-role']) {
      req.testUser = {
        UserId: 'user-1',
        userType: req.headers['x-test-role'],
        TenantId: 'tenant-1',
        roles: [req.headers['x-test-role']]
      };
    }
    next();
  });
  app.use('/api/message-center', messageCenterRouter);
  return app;
}

beforeEach(() => { mockQueries.length = 0; });

describe('GET /api/message-center/templates — scope', () => {
  it('VendorAdmin filters by VendorId only (XOR — vendor templates have TenantId IS NULL)', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates').set('x-test-role', 'VendorAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery).toBeDefined();
    expect(dataQuery.sql).toMatch(/VendorId\s*=\s*@vendorIdFilter/);
    expect(dataQuery.inputs.vendorIdFilter).toBe('vendor-uuid-1');
    expect(dataQuery.inputs.tenantId).toBeUndefined();
    expect(dataQuery.sql).not.toMatch(/TenantId\s*=\s*@tenantId/);
  });

  it('TenantAdmin gets VendorId IS NULL AND TenantId = @tenantId in WHERE clause', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates').set('x-test-role', 'TenantAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery.sql).toMatch(/VendorId\s+IS\s+NULL/);
    expect(dataQuery.sql).toMatch(/TenantId\s*=\s*@tenantId/);
    expect(dataQuery.inputs.vendorIdFilter).toBeUndefined();
    expect(dataQuery.inputs.tenantId).toBe('tenant-1');
  });

  it('SysAdmin (no params) has no base TenantId/VendorId WHERE clause', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates').set('x-test-role', 'SysAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery).toBeDefined();
    // SysAdmin sees everything by default — no TenantId or VendorId clause
    expect(dataQuery.sql).not.toMatch(/VendorId\s+IS\s+NULL/);
    expect(dataQuery.sql).not.toMatch(/VendorId\s+IS\s+NOT\s+NULL/);
    expect(dataQuery.sql).not.toMatch(/VendorId\s*=\s*@vendorIdFilter/);
    expect(dataQuery.inputs.tenantId).toBeUndefined();
  });

  it('SysAdmin ?scope=tenant narrows to VendorId IS NULL', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates?scope=tenant').set('x-test-role', 'SysAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery.sql).toMatch(/VendorId\s+IS\s+NULL/);
  });

  it('SysAdmin ?scope=vendor narrows to VendorId IS NOT NULL', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates?scope=vendor').set('x-test-role', 'SysAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery.sql).toMatch(/VendorId\s+IS\s+NOT\s+NULL/);
  });

  it('SysAdmin ?tenantId=<uuid> narrows to that tenant', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates?tenantId=tenant-X').set('x-test-role', 'SysAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery.sql).toMatch(/TenantId\s*=\s*@tenantId/);
    expect(dataQuery.inputs.tenantId).toBe('tenant-X');
  });

  it('Response payload includes VendorId column', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates').set('x-test-role', 'TenantAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery.sql).toMatch(/VendorId\s+as\s+vendorId/i);
  });

  it('VendorAccounting is forbidden (not in allowlist)', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates').set('x-test-role', 'VendorAccounting').expect(403);
  });
});

describe('POST /api/message-center/templates — scope', () => {
  it('VendorAdmin insert binds VendorId and stores TenantId IS NULL (XOR)', async () => {
    const app = makeApp();
    await request(app).post('/api/message-center/templates')
      .set('x-test-role', 'VendorAdmin')
      .send({ templateName: 'X', messageType: 'Email', subject: 'S', body: 'B' })
      .expect(200);
    const insert = mockQueries.find(q => q.sql.trim().startsWith('INSERT') && q.sql.includes('MessageTemplates'));
    expect(insert).toBeDefined();
    expect(insert.sql).toMatch(/VendorId/);
    expect(insert.inputs.vendorId).toBe('vendor-uuid-1');
    expect(insert.inputs.tenantId).toBeNull();
  });

  it('TenantAdmin insert binds VendorId to NULL', async () => {
    const app = makeApp();
    await request(app).post('/api/message-center/templates')
      .set('x-test-role', 'TenantAdmin')
      .send({ templateName: 'Y', messageType: 'Email', subject: 'S', body: 'B' })
      .expect(200);
    const insert = mockQueries.find(q => q.sql.trim().startsWith('INSERT') && q.sql.includes('MessageTemplates'));
    expect(insert).toBeDefined();
    expect(insert.sql).toMatch(/VendorId/);
    expect(insert.inputs.vendorId).toBeNull();
    expect(insert.inputs.tenantId).toBe('tenant-1');
  });

  it('SysAdmin with createForVendorId creates a vendor template with TenantId IS NULL (XOR)', async () => {
    const app = makeApp();
    await request(app).post('/api/message-center/templates')
      .set('x-test-role', 'SysAdmin')
      .send({
        templateName: 'Z',
        messageType: 'Email',
        subject: 'S',
        body: 'B',
        // Client-supplied createForTenantId is ignored when vendor is present (XOR).
        createForTenantId: 'tenant-IGNORED',
        createForVendorId: 'vendor-target'
      })
      .expect(200);

    const insert = mockQueries.find(q => q.sql.trim().startsWith('INSERT') && q.sql.includes('MessageTemplates'));
    expect(insert).toBeDefined();
    expect(insert.inputs.tenantId).toBeNull();
    expect(insert.inputs.vendorId).toBe('vendor-target');

    // No oe.Users lookup should have run — TenantId is just NULL.
    const lookup = mockQueries.find(q => /FROM\s+oe\.Users/i.test(q.sql) && /VendorId\s*=\s*@vendorId/.test(q.sql));
    expect(lookup).toBeUndefined();
  });

  it('SysAdmin with createForTenantId only (no vendor) binds VendorId to NULL', async () => {
    const app = makeApp();
    await request(app).post('/api/message-center/templates')
      .set('x-test-role', 'SysAdmin')
      .send({
        templateName: 'W',
        messageType: 'Email',
        subject: 'S',
        body: 'B',
        createForTenantId: 'tenant-target'
      })
      .expect(200);
    const insert = mockQueries.find(q => q.sql.trim().startsWith('INSERT') && q.sql.includes('MessageTemplates'));
    expect(insert).toBeDefined();
    expect(insert.inputs.tenantId).toBe('tenant-target');
    expect(insert.inputs.vendorId).toBeNull();
  });
});

describe('PUT /api/message-center/templates/:id — scope gate', () => {
  it('TenantAdmin gate restricts to their tenant + VendorId IS NULL', async () => {
    const originalPoolRequest = mockPool.request;
    mockPool.request = () => {
      const r = {
        _inputs: {},
        input: function (name, _type, value) { this._inputs[name] = value; return this; },
        query: jest.fn().mockImplementation(function (sqlText) {
          mockQueries.push({ sql: sqlText, inputs: { ...this._inputs } });
          const trimmed = sqlText.trim();
          if (trimmed.startsWith('SELECT TemplateId') && sqlText.includes('FROM oe.MessageTemplates')) {
            return Promise.resolve({ recordset: [{ TemplateId: 'tpl-1' }] });
          }
          if (trimmed.startsWith('UPDATE')) return Promise.resolve({ recordset: [], rowsAffected: [1] });
          return Promise.resolve({ recordset: [] });
        })
      };
      return r;
    };

    try {
      const app = makeApp();
      await request(app)
        .put('/api/message-center/templates/tpl-1')
        .set('x-test-role', 'TenantAdmin')
        .send({ subject: 'Updated' })
        .expect(200);

      const selectGate = mockQueries.find(q =>
        q.sql.trim().startsWith('SELECT TemplateId') && q.sql.includes('FROM oe.MessageTemplates'));
      expect(selectGate).toBeDefined();
      // No-globals: TenantAdmin gate is strict (TenantId = @tenantId AND VendorId IS NULL)
      expect(selectGate.sql).toMatch(/TenantId\s*=\s*@tenantId/);
      expect(selectGate.sql).toMatch(/VendorId\s+IS\s+NULL/);
      // Must NOT include the legacy "OR TenantId IS NULL" branch
      expect(selectGate.sql).not.toMatch(/OR\s+TenantId\s+IS\s+NULL/);
    } finally {
      mockPool.request = originalPoolRequest;
    }
  });

  it('SysAdmin PUT gate is unrestricted (sees ANY template)', async () => {
    const originalPoolRequest = mockPool.request;
    mockPool.request = () => {
      const r = {
        _inputs: {},
        input: function (name, _type, value) { this._inputs[name] = value; return this; },
        query: jest.fn().mockImplementation(function (sqlText) {
          mockQueries.push({ sql: sqlText, inputs: { ...this._inputs } });
          const trimmed = sqlText.trim();
          if (trimmed.startsWith('SELECT TemplateId') && sqlText.includes('FROM oe.MessageTemplates')) {
            return Promise.resolve({ recordset: [{ TemplateId: 'tpl-any-1' }] });
          }
          if (trimmed.startsWith('UPDATE')) return Promise.resolve({ recordset: [], rowsAffected: [1] });
          return Promise.resolve({ recordset: [] });
        })
      };
      return r;
    };

    try {
      const app = makeApp();
      await request(app)
        .put('/api/message-center/templates/tpl-any-1')
        .set('x-test-role', 'SysAdmin')
        .send({ subject: 'Updated' })
        .expect(200);

      const selectGate = mockQueries.find(q =>
        q.sql.trim().startsWith('SELECT TemplateId') && q.sql.includes('FROM oe.MessageTemplates'));
      expect(selectGate).toBeDefined();
      // No-globals: SysAdmin has no TenantId/VendorId scope clause
      expect(selectGate.sql).not.toMatch(/VendorId\s+IS\s+NULL/);
      expect(selectGate.sql).not.toMatch(/TenantId\s*=/);
      expect(selectGate.inputs.tenantId).toBeUndefined();
    } finally {
      mockPool.request = originalPoolRequest;
    }
  });

  it('VendorAdmin PUT gate filters by VendorId only (XOR — no TenantId clause)', async () => {
    const originalPoolRequest = mockPool.request;
    mockPool.request = () => {
      const r = {
        _inputs: {},
        input: function (name, _type, value) { this._inputs[name] = value; return this; },
        query: jest.fn().mockImplementation(function (sqlText) {
          mockQueries.push({ sql: sqlText, inputs: { ...this._inputs } });
          const trimmed = sqlText.trim();
          if (trimmed.startsWith('SELECT TemplateId') && sqlText.includes('FROM oe.MessageTemplates')) {
            return Promise.resolve({ recordset: [{ TemplateId: 'tpl-vendor-1' }] });
          }
          if (trimmed.startsWith('UPDATE')) return Promise.resolve({ recordset: [], rowsAffected: [1] });
          return Promise.resolve({ recordset: [] });
        })
      };
      return r;
    };

    try {
      const app = makeApp();
      await request(app)
        .put('/api/message-center/templates/tpl-vendor-1')
        .set('x-test-role', 'VendorAdmin')
        .send({ subject: 'Updated' })
        .expect(200);

      const selectGate = mockQueries.find(q =>
        q.sql.trim().startsWith('SELECT TemplateId') && q.sql.includes('FROM oe.MessageTemplates'));
      expect(selectGate).toBeDefined();
      expect(selectGate.sql).toMatch(/VendorId\s*=\s*@vendorIdFilter/);
      expect(selectGate.sql).not.toMatch(/TenantId\s*=\s*@tenantId/);
      expect(selectGate.inputs.vendorIdFilter).toBe('vendor-uuid-1');
      expect(selectGate.inputs.tenantId).toBeUndefined();
    } finally {
      mockPool.request = originalPoolRequest;
    }
  });
});
