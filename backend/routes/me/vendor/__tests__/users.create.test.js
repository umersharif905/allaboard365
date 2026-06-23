/**
 * POST /api/me/vendor/users — exercises the "attach role to existing user" path
 * added so a VendorAdmin can grant VendorAgent access to someone who already
 * has a login in the same tenant (e.g. a TenantAdmin).
 *
 * Strategy: scripted SQL fake pool + stubbed UserRolesService / MessageQueueService.
 * No real DB. Run: npx jest routes/me/vendor/__tests__/users.create.test.js
 */

const express = require('express');
const request = require('supertest');

// ---------- Constants reused across tests ----------
const ACTING_USER_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const VENDOR_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_VENDOR_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_TENANT_ID = '55555555-5555-5555-5555-555555555555';
const EXISTING_USER_ID = '66666666-6666-6666-6666-666666666666';

// ---------- Scripted SQL fake pool ----------
// mockEmailLookup is set per test to drive the existence/path branching.
let mockEmailLookup = { recordset: [] };
// mockUpdateCalls records the parameters of the UPDATE oe.Users statement on the existing-user path.
let mockUpdateCalls = [];
// mockInsertCalls records new-user INSERT params.
let mockInsertCalls = [];

function scriptedQuery(sqlText, params) {
  const t = sqlText.replace(/\s+/g, ' ').trim();
  if (/SELECT VendorId, TenantId FROM oe\.Users/i.test(t)) {
    return { recordset: [{ VendorId: VENDOR_ID, TenantId: TENANT_ID }] };
  }
  if (/SELECT VendorName FROM oe\.Vendors/i.test(t)) {
    return { recordset: [{ VendorName: 'ShareWELL' }] };
  }
  if (/FROM oe\.Users WHERE LOWER\(Email\) = @email/i.test(t)) {
    return mockEmailLookup;
  }
  if (/^UPDATE oe\.Users/i.test(t)) {
    mockUpdateCalls.push({ ...params });
    return { rowsAffected: [1] };
  }
  if (/^INSERT INTO oe\.Users/i.test(t)) {
    mockInsertCalls.push({ ...params });
    return { rowsAffected: [1] };
  }
  if (/SELECT UserId, FirstName, LastName, Email, PhoneNumber, Status, CreatedDate FROM oe\.Users/i.test(t)) {
    // Fetch-after-insert for new user path.
    return {
      recordset: [
        {
          UserId: params.userId,
          FirstName: 'New',
          LastName: 'Person',
          Email: 'new@example.com',
          PhoneNumber: null,
          Status: 'Active',
          CreatedDate: new Date().toISOString()
        }
      ]
    };
  }
  throw new Error(`[test fake pool] Unexpected SQL:\n${sqlText}\nparams=${JSON.stringify(params)}`);
}

function makeRequest() {
  const params = {};
  const self = {
    input(name, _type, value) { params[name] = value; return self; },
    async query(text) { return scriptedQuery(text, params); }
  };
  return self;
}

const mockFakePool = { request: () => makeRequest() };

// ---------- Mocks ----------
jest.mock('mssql', () => {
  // sql.Transaction constructor stub with begin/commit/rollback/request.
  function Transaction() {
    this.begin = jest.fn().mockResolvedValue();
    this.commit = jest.fn().mockResolvedValue();
    this.rollback = jest.fn().mockResolvedValue();
    this.request = () => {
      const params = {};
      const self = {
        input(name, _type, value) { params[name] = value; return self; },
        async query(text) {
          // Delegate to the scripted router so UPDATE on attach-path is captured.
          const t = text.replace(/\s+/g, ' ').trim();
          if (/^UPDATE oe\.Users/i.test(t)) {
            mockUpdateCalls.push({ ...params });
            return { rowsAffected: [1] };
          }
          if (/^INSERT INTO oe\.Users/i.test(t)) {
            mockInsertCalls.push({ ...params });
            return { rowsAffected: [1] };
          }
          throw new Error(`[test fake tx] Unexpected SQL:\n${text}`);
        }
      };
      return self;
    };
  }
  return {
    Transaction,
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: () => 'NVarChar',
    DateTime2: 'DateTime2'
  };
});

jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(async () => mockFakePool)
}));

jest.mock('../../../../middleware/auth', () => ({
  authorize: () => (req, _res, next) => {
    req.user = { UserId: ACTING_USER_ID, userId: ACTING_USER_ID };
    next();
  }
}));

const mockAssignRoleToUser = jest.fn();
const mockGetUserRoleNames = jest.fn();
jest.mock('../../../../services/shared/user-roles.service', () => ({
  assignRoleToUser: (...args) => mockAssignRoleToUser(...args),
  getUserRoleNames: (...args) => mockGetUserRoleNames(...args)
}));

const mockSendUserWelcome = jest.fn();
const mockQueueEmail = jest.fn();
jest.mock('../../../../services/messageQueue.service', () => ({
  sendUserWelcome: (...args) => mockSendUserWelcome(...args),
  queueEmail: (...args) => mockQueueEmail(...args)
}));

// bcrypt and uuid don't need mocking — they're pure utilities.
// crypto.randomUUID is built-in.

const vendorUsersRoutes = require('../users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/me/vendor/users', vendorUsersRoutes);
  return app;
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEmailLookup = { recordset: [] };
  mockUpdateCalls = [];
  mockInsertCalls = [];
  mockAssignRoleToUser.mockResolvedValue({ userRoleId: 'role-row-id', alreadyAssigned: false });
  mockGetUserRoleNames.mockResolvedValue(['VendorAgent']);
  mockSendUserWelcome.mockResolvedValue('welcome-msg-id');
  mockQueueEmail.mockResolvedValue('queued-msg-id');
});

const basePayload = {
  firstName: 'Chaslyn',
  lastName: 'Salamone',
  email: 'chaslyn@example.com',
  roles: ['VendorAgent'],
  sendWelcomeEmail: true
};

describe('POST /api/me/vendor/users — existing-user attach path', () => {
  test('rejects existing user in a DIFFERENT tenant with 400', async () => {
    mockEmailLookup = {
      recordset: [{
        UserId: EXISTING_USER_ID,
        FirstName: 'X', LastName: 'Y',
        Email: 'chaslyn@example.com',
        PhoneNumber: null,
        TenantId: OTHER_TENANT_ID,
        VendorId: null,
        Status: 'Active',
        PasswordHash: 'hash'
      }]
    };

    const res = await request(buildApp())
      .post('/api/me/vendor/users')
      .send(basePayload)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/different tenant/i);
    expect(mockAssignRoleToUser).not.toHaveBeenCalled();
    expect(mockUpdateCalls).toHaveLength(0);
  });

  test('rejects existing user already attached to a DIFFERENT vendor with 400', async () => {
    mockEmailLookup = {
      recordset: [{
        UserId: EXISTING_USER_ID,
        FirstName: 'X', LastName: 'Y',
        Email: 'chaslyn@example.com',
        PhoneNumber: null,
        TenantId: TENANT_ID,
        VendorId: OTHER_VENDOR_ID,
        Status: 'Active',
        PasswordHash: 'hash'
      }]
    };

    const res = await request(buildApp())
      .post('/api/me/vendor/users')
      .send(basePayload)
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/another vendor/i);
    expect(mockAssignRoleToUser).not.toHaveBeenCalled();
  });

  test('existing same-tenant user WITH password: attaches role, sets VendorId, queues "access granted" email (no setup link)', async () => {
    mockEmailLookup = {
      recordset: [{
        UserId: EXISTING_USER_ID,
        FirstName: 'Brittney', LastName: 'Hampton',
        Email: 'brittney@example.com',
        PhoneNumber: null,
        TenantId: TENANT_ID,
        VendorId: null,
        Status: 'Active',
        PasswordHash: '$2b$12$alreadySet'
      }]
    };
    mockGetUserRoleNames.mockResolvedValue(['TenantAdmin', 'VendorAgent']);

    const res = await request(buildApp())
      .post('/api/me/vendor/users')
      .send({ ...basePayload, email: 'brittney@example.com', firstName: 'Brittney', lastName: 'Hampton' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.isExistingUser).toBe(true);
    expect(res.body.data.passwordSetupRequired).toBe(false);
    expect(res.body.data.passwordSetupLink).toBeNull();
    expect(res.body.data.roles).toEqual(['TenantAdmin', 'VendorAgent']);

    // Role attached
    expect(mockAssignRoleToUser).toHaveBeenCalledWith(EXISTING_USER_ID, 'VendorAgent', ACTING_USER_ID, expect.anything());

    // VendorId set on the existing user, no reset token issued
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0].vendorId).toBe(VENDOR_ID);
    expect(mockUpdateCalls[0].passwordResetToken).toBeUndefined();

    // "Access granted" email, not the welcome-with-setup-link email
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    expect(mockSendUserWelcome).not.toHaveBeenCalled();
  });

  test('existing same-tenant user WITHOUT password (Pending): attaches role, issues fresh setup token, sends welcome email with link', async () => {
    mockEmailLookup = {
      recordset: [{
        UserId: EXISTING_USER_ID,
        FirstName: 'Pending', LastName: 'Person',
        Email: 'pending@example.com',
        PhoneNumber: null,
        TenantId: TENANT_ID,
        VendorId: null,
        Status: 'Pending',
        PasswordHash: null
      }]
    };

    const res = await request(buildApp())
      .post('/api/me/vendor/users')
      .send({ ...basePayload, email: 'pending@example.com' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.isExistingUser).toBe(true);
    expect(res.body.data.passwordSetupRequired).toBe(true);
    expect(typeof res.body.data.passwordSetupLink).toBe('string');
    expect(res.body.data.passwordSetupLink).toMatch(/\/setup-password\//);

    // Update writes both VendorId and the new reset token/expiry
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0].vendorId).toBe(VENDOR_ID);
    expect(mockUpdateCalls[0].passwordResetToken).toBeTruthy();
    expect(mockUpdateCalls[0].passwordResetExpiry).toBeInstanceOf(Date);

    // Welcome email (with setup link), not the generic "access granted" email
    expect(mockSendUserWelcome).toHaveBeenCalledTimes(1);
    expect(mockQueueEmail).not.toHaveBeenCalled();
    expect(mockSendUserWelcome.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT_ID,
      userId: EXISTING_USER_ID,
      userEmail: 'pending@example.com',
      setupUrl: expect.stringMatching(/\/setup-password\//)
    });
  });

  test('existing user who ALREADY has the role and has a password: no-op, "no changes needed", no email', async () => {
    mockEmailLookup = {
      recordset: [{
        UserId: EXISTING_USER_ID,
        FirstName: 'Already', LastName: 'There',
        Email: 'already@example.com',
        PhoneNumber: null,
        TenantId: TENANT_ID,
        VendorId: VENDOR_ID,
        Status: 'Active',
        PasswordHash: '$2b$12$alreadySet'
      }]
    };
    mockAssignRoleToUser.mockResolvedValue({ userRoleId: 'role-row-id', alreadyAssigned: true });

    const res = await request(buildApp())
      .post('/api/me/vendor/users')
      .send({ ...basePayload, email: 'already@example.com' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.isExistingUser).toBe(true);
    expect(res.body.data.roleAlreadyAssigned).toBe(true);
    expect(res.body.message).toMatch(/no changes were needed/i);
    expect(mockQueueEmail).not.toHaveBeenCalled();
    expect(mockSendUserWelcome).not.toHaveBeenCalled();
  });
});

describe('POST /api/me/vendor/users — new-user happy path (regression)', () => {
  test('creates a new user when email is not in use', async () => {
    mockEmailLookup = { recordset: [] };

    const res = await request(buildApp())
      .post('/api/me/vendor/users')
      .send({ ...basePayload, email: 'new@example.com' })
      .expect(200);

    expect(res.body.success).toBe(true);
    // Not the existing-user path
    expect(res.body.data.isExistingUser).toBeUndefined();
    expect(mockInsertCalls).toHaveLength(1);
    expect(mockInsertCalls[0].email).toBe('new@example.com');
    expect(mockInsertCalls[0].vendorId).toBe(VENDOR_ID);
    expect(mockInsertCalls[0].tenantId).toBe(TENANT_ID);
    expect(mockSendUserWelcome).toHaveBeenCalledTimes(1);
  });
});
