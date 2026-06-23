'use strict';

process.env.JWT_SECRET = 'test-jwt-secret';

const express = require('express');
const request = require('supertest');

const VENDOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONN_ID   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---- Auth middleware mock ----
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    req.user = JSON.parse(Buffer.from(token.split('.')[1] || 'e30=', 'base64').toString());
    next();
  },
  authorize: (roles) => (req, res, next) => {
    if (!roles.some((r) => (req.user?.roles || []).includes(r))) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    next();
  },
}));

// ---- Connection service mock ----
const mockList   = jest.fn();
const mockCreate = jest.fn();
const mockGet    = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockTest   = jest.fn();

jest.mock('../../services/sftpConnectionService', () => ({
  listConnections:    (...a) => mockList(...a),
  createConnection:   (...a) => mockCreate(...a),
  getConnection:      (...a) => mockGet(...a),
  updateConnection:   (...a) => mockUpdate(...a),
  deleteConnection:   (...a) => mockDelete(...a),
  testConnection:     (...a) => mockTest(...a),
  decryptConnectionCreds: jest.fn(),
}));

const router = require('../me/vendor/sftp-connections');
const app = express();
app.use(express.json());
app.use('/', router);

function vendorAdminToken() {
  const payload = { UserId: USER_ID, VendorId: VENDOR_ID, roles: ['VendorAdmin'] };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `Bearer.${b64}.sig`;
}

function nonVendorToken() {
  const payload = { UserId: USER_ID, roles: ['Member'] };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `Bearer.${b64}.sig`;
}

function connFixture(overrides = {}) {
  return {
    connectionId: CONN_ID,
    vendorId: VENDOR_ID,
    displayName: 'Test SFTP',
    host: 'sftp.example.com',
    port: 22,
    username: 'user',
    authType: 'password',
    hasPassword: true,
    hasPrivateKey: false,
    hasPassphrase: false,
    isActive: true,
    ...overrides,
  };
}

describe('GET / — list connections', () => {
  test('401 without JWT', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(401);
  });

  test('403 when not VendorAdmin', async () => {
    const res = await request(app).get('/').set('Authorization', nonVendorToken());
    expect(res.status).toBe(403);
  });

  test('200 with correct shape', async () => {
    mockList.mockResolvedValueOnce([connFixture()]);
    const res = await request(app).get('/').set('Authorization', vendorAdminToken());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).not.toHaveProperty('PasswordEncrypted');
    expect(res.body.data[0].hasPassword).toBe(true);
  });
});

describe('POST / — create connection', () => {
  test('201 with created connection (no creds in response)', async () => {
    mockCreate.mockResolvedValueOnce(connFixture());
    const res = await request(app)
      .post('/')
      .set('Authorization', vendorAdminToken())
      .send({ displayName: 'Test SFTP', host: 'sftp.example.com', username: 'user', authType: 'password', password: 'secret' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).not.toHaveProperty('PasswordEncrypted');
  });

  test('400 when service throws required error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('displayName required'));
    const res = await request(app)
      .post('/')
      .set('Authorization', vendorAdminToken())
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /:connectionId', () => {
  test('200 for existing connection', async () => {
    mockGet.mockResolvedValueOnce(connFixture());
    const res = await request(app)
      .get(`/${CONN_ID}`)
      .set('Authorization', vendorAdminToken());
    expect(res.status).toBe(200);
    expect(res.body.data.connectionId).toBe(CONN_ID);
  });

  test('404 when not found', async () => {
    mockGet.mockResolvedValueOnce(null);
    const res = await request(app)
      .get(`/${CONN_ID}`)
      .set('Authorization', vendorAdminToken());
    expect(res.status).toBe(404);
  });
});

describe('DELETE /:connectionId', () => {
  test('409 when service throws 409', async () => {
    const err = new Error('jobs reference this connection');
    err.statusCode = 409;
    mockDelete.mockRejectedValueOnce(err);
    const res = await request(app)
      .delete(`/${CONN_ID}`)
      .set('Authorization', vendorAdminToken());
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test('200 on successful delete', async () => {
    mockDelete.mockResolvedValueOnce(undefined);
    const res = await request(app)
      .delete(`/${CONN_ID}`)
      .set('Authorization', vendorAdminToken());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /test — draft credentials', () => {
  test('200 and forwards body to service', async () => {
    mockTest.mockResolvedValueOnce({ success: true, latencyMs: 12 });
    const res = await request(app)
      .post('/test')
      .set('Authorization', vendorAdminToken())
      .send({ host: 'draft.example.com', username: 'u', authType: 'password', password: 'p' });
    expect(res.status).toBe(200);
    expect(mockTest).toHaveBeenCalledWith(
      null,
      VENDOR_ID,
      expect.objectContaining({ host: 'draft.example.com', username: 'u', password: 'p' })
    );
  });
});

describe('POST /:connectionId/test', () => {
  test('returns test result with latencyMs', async () => {
    mockTest.mockResolvedValueOnce({ success: true, latencyMs: 42 });
    const res = await request(app)
      .post(`/${CONN_ID}/test`)
      .set('Authorization', vendorAdminToken());
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.latencyMs).toBe(42);
  });

  test('forwards form overrides in request body', async () => {
    mockTest.mockResolvedValueOnce({ success: true, latencyMs: 30 });
    const res = await request(app)
      .post(`/${CONN_ID}/test`)
      .set('Authorization', vendorAdminToken())
      .send({ host: 'typed.host.com', username: 'typeduser', password: 'typedpass' });
    expect(res.status).toBe(200);
    expect(mockTest).toHaveBeenCalledWith(
      CONN_ID,
      VENDOR_ID,
      expect.objectContaining({ host: 'typed.host.com', username: 'typeduser', password: 'typedpass' })
    );
  });

  test('returns success=false with error message on failure', async () => {
    mockTest.mockResolvedValueOnce({ success: false, error: 'Connection refused' });
    const res = await request(app)
      .post(`/${CONN_ID}/test`)
      .set('Authorization', vendorAdminToken());
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(false);
    expect(res.body.data.error).toMatch(/Connection refused/);
  });
});
