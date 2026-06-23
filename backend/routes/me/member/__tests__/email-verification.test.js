const request = require('supertest');
const express = require('express');

// Captured query handlers per `request()` call. (Names must start with "mock"
// so Jest's hoisting allows them to be referenced in jest.mock factories.)
const mockQueryQueue = [];
let mockLastInputs = {};

jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(() => Promise.resolve({
    request: jest.fn(() => {
      const inputs = {};
      mockLastInputs = inputs;
      const r = {
        input: jest.fn((name, _type, value) => {
          inputs[name] = value;
          return r;
        }),
        query: jest.fn(async () => {
          if (mockQueryQueue.length === 0) return { recordset: [], rowsAffected: [0] };
          const next = mockQueryQueue.shift();
          return typeof next === 'function' ? next(inputs) : next;
        })
      };
      return r;
    })
  })),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
    Int: 'Int'
  }
}));

// Don't actually queue any emails.
jest.mock('../../../../services/email-verification-mailer', () => ({
  queueVerificationEmail: jest.fn(() => Promise.resolve('msg-1'))
}));

// Use the real service so we exercise the real INSERT/UPDATE flow against
// the mocked pool.
const emailVerificationRoutes = require('../email-verification');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { UserId: 'user-1' };
  next();
});
app.use('/email-verification', emailVerificationRoutes);

const PRIMARY_CTX = {
  UserId: 'user-1',
  Email: 'real@example.com',
  EmailVerified: false,
  TenantId: 'tenant-1',
  RelationshipType: 'P',
  MemberSequence: 1,
  TenantName: 'Acme Health'
};

describe('GET /email-verification/status', () => {
  beforeEach(() => { mockQueryQueue.length = 0; });

  it('returns isPrimary=false when user is not a primary member', async () => {
    mockQueryQueue.push({ recordset: [] }); // primary lookup returns nothing
    const res = await request(app).get('/email-verification/status');
    expect(res.status).toBe(200);
    expect(res.body.data.isPrimary).toBe(false);
    expect(res.body.data.emailVerified).toBe(true);
  });

  it('returns the verified flag for a primary member', async () => {
    mockQueryQueue.push({ recordset: [{ ...PRIMARY_CTX, EmailVerified: true }] });
    const res = await request(app).get('/email-verification/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      isPrimary: true,
      emailVerified: true,
      email: 'real@example.com',
      syntheticEmail: false
    });
  });

  it('flags synthetic emails', async () => {
    mockQueryQueue.push({
      recordset: [{ ...PRIMARY_CTX, Email: 'dependent-uuid@noemail.com' }]
    });
    const res = await request(app).get('/email-verification/status');
    expect(res.body.data.syntheticEmail).toBe(true);
  });
});

describe('POST /email-verification/send', () => {
  beforeEach(() => { mockQueryQueue.length = 0; });

  it('rejects non-primary members', async () => {
    mockQueryQueue.push({ recordset: [] });
    const res = await request(app).post('/email-verification/send').send({});
    expect(res.status).toBe(403);
  });

  it('rejects synthetic emails when no override is provided', async () => {
    mockQueryQueue.push({
      recordset: [{ ...PRIMARY_CTX, Email: 'dependent-uuid@noemail.com' }]
    });
    const res = await request(app).post('/email-verification/send').send({});
    expect(res.status).toBe(400);
  });

  it('sends a code for the happy path', async () => {
    mockQueryQueue.push({ recordset: [{ ...PRIMARY_CTX }] });          // getPrimaryContext
    mockQueryQueue.push({ recordset: [{ SendCount: 0 }] });             // isRateLimited
    mockQueryQueue.push({ rowsAffected: [0] });                          // delete prior unverified
    mockQueryQueue.push({ rowsAffected: [1] });                          // insert
    const res = await request(app).post('/email-verification/send').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe('real@example.com');
    expect(res.body.data.expiresIn).toBeGreaterThan(0);
  });

  it('returns 429 when rate-limited', async () => {
    mockQueryQueue.push({ recordset: [{ ...PRIMARY_CTX }] });           // getPrimaryContext
    mockQueryQueue.push({ recordset: [{ SendCount: 99 }] });             // isRateLimited true
    const res = await request(app).post('/email-verification/send').send({});
    expect(res.status).toBe(429);
  });
});

describe('POST /email-verification/verify', () => {
  beforeEach(() => { mockQueryQueue.length = 0; });

  it('rejects malformed code', async () => {
    const res = await request(app).post('/email-verification/verify').send({ code: 'abc' });
    expect(res.status).toBe(400);
  });

  it('returns success and flips Users.EmailVerified on a correct code', async () => {
    mockQueryQueue.push({ recordset: [{ ...PRIMARY_CTX }] });           // getPrimaryContext
    mockQueryQueue.push({                                                // verifyPostEnrollmentCode lookup
      recordset: [{
        VerificationId: 'v-1',
        Code: 'ABC123',
        ExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        Verified: false,
        Attempts: 0
      }]
    });
    mockQueryQueue.push({ rowsAffected: [1] });                          // increment attempts
    mockQueryQueue.push({ rowsAffected: [1] });                          // mark verified
    mockQueryQueue.push({ rowsAffected: [1] });                          // _markUserEmailVerified

    const res = await request(app)
      .post('/email-verification/verify')
      .send({ code: 'ABC123' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.verified).toBe(true);
  });

  it('returns 400 with attempts-remaining on a wrong code', async () => {
    mockQueryQueue.push({ recordset: [{ ...PRIMARY_CTX }] });
    mockQueryQueue.push({
      recordset: [{
        VerificationId: 'v-1',
        Code: 'ABC123',
        ExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        Verified: false,
        Attempts: 0
      }]
    });
    mockQueryQueue.push({ rowsAffected: [1] });

    const res = await request(app)
      .post('/email-verification/verify')
      .send({ code: 'XYZXYZ' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Incorrect/i);
  });

  it('returns 400 when code has expired', async () => {
    mockQueryQueue.push({ recordset: [{ ...PRIMARY_CTX }] });
    mockQueryQueue.push({
      recordset: [{
        VerificationId: 'v-1',
        Code: 'ABC123',
        ExpiresAt: new Date(Date.now() - 60 * 1000),
        Verified: false,
        Attempts: 0
      }]
    });
    const res = await request(app)
      .post('/email-verification/verify')
      .send({ code: 'ABC123' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/i);
  });
});
