/**
 * POST /auth/login — keepMeSignedIn controls refresh token persistentSession and JWT expiry window.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-local-auth-login-tests-only';
process.env.PERSISTENT_SESSION_DAYS = '90';
process.env.ABSOLUTE_SESSION_HOURS = '12';
process.env.ACCESS_TOKEN_EXPIRY = '1h';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomUUID: jest.fn(() => '11111111-1111-1111-1111-111111111111'),
  };
});

const mockUserRow = {
  UserId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
  Email: 'persist-test@example.com',
  FirstName: 'Test',
  LastName: 'User',
  TenantId: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
  PhoneNumber: null,
  PasswordHash: bcrypt.hashSync('correct-password', 8),
  Status: 'Active',
};

const mockQuery = jest.fn();
const mockRequest = jest.fn(() => ({
  input: jest.fn().mockReturnThis(),
  query: mockQuery,
}));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({
    request: mockRequest,
  })),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n) => `NVarChar(${n})`),
  },
}));

jest.mock('../../services/shared/user-roles.service', () => ({
  getUserRoleNames: jest.fn().mockResolvedValue(['Member']),
}));

jest.mock('../../services/mobileAb365LoginEligibility.service', () => ({
  userCanCompleteAb365MemberLogin: jest.fn().mockResolvedValue(true),
  shouldGateAb365MemberPasswordLogin: jest.fn((roles) =>
    Array.isArray(roles) && roles.includes('Member') && !roles.some((r) =>
      ['SysAdmin', 'TenantAdmin', 'VendorAdmin', 'VendorAgent', 'Agent', 'AgencyOwner', 'GroupAdmin'].includes(r)
    )
  ),
}));

const { userCanCompleteAb365MemberLogin } = require('../../services/mobileAb365LoginEligibility.service');
const localAuthRoutes = require('../local-auth');

describe('local-auth POST /login', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    userCanCompleteAb365MemberLogin.mockResolvedValue(true);
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ recordset: [mockUserRow] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValue({ recordset: [] });

    app = express();
    app.use(express.json());
    app.use('/auth', localAuthRoutes);
  });

  async function assertRefreshTokenPersistent(body, expectedPersistent) {
    const { refreshToken } = body;
    expect(refreshToken).toBeTruthy();
    const decoded = jwt.decode(refreshToken);
    expect(decoded.persistentSession).toBe(expectedPersistent);
    expect(decoded.type).toBe('refresh');

    const jwtJson = jwt.decode(refreshToken, { complete: true });
    const exp = jwtJson.payload.exp;
    const iat = jwtJson.payload.iat;
    const ttlSeconds = exp - iat;
    if (expectedPersistent) {
      expect(ttlSeconds).toBeGreaterThanOrEqual(89 * 24 * 60 * 60);
      expect(ttlSeconds).toBeLessThanOrEqual(91 * 24 * 60 * 60);
    } else {
      expect(ttlSeconds).toBeGreaterThanOrEqual(11 * 60 * 60);
      expect(ttlSeconds).toBeLessThanOrEqual(13 * 60 * 60);
    }
  }

  it('sets persistentSession true and long refresh TTL when keepMeSignedIn is true', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({
        email: 'persist-test@example.com',
        password: 'correct-password',
        keepMeSignedIn: true,
      })
      .expect(200);

    expect(res.body.accessToken).toBeTruthy();
    await assertRefreshTokenPersistent(res.body, true);
  });

  it('sets persistentSession false and short refresh TTL when keepMeSignedIn is false', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({
        email: 'persist-test@example.com',
        password: 'correct-password',
        keepMeSignedIn: false,
      })
      .expect(200);

    await assertRefreshTokenPersistent(res.body, false);
  });

  it('treats string "true" as not persistent (strict boolean)', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({
        email: 'persist-test@example.com',
        password: 'correct-password',
        keepMeSignedIn: 'true',
      })
      .expect(200);

    await assertRefreshTokenPersistent(res.body, false);
  });

  it('returns 401 for Member without complete AB365 member context after valid password', async () => {
    userCanCompleteAb365MemberLogin.mockResolvedValue(false);

    const res = await request(app)
      .post('/auth/login')
      .send({
        email: 'persist-test@example.com',
        password: 'correct-password',
      })
      .expect(401);

    expect(res.body.message).toBe('Invalid email or password');
  });

  it('allows Agent-only login when AB365 member eligibility is false', async () => {
    const UserRolesService = require('../../services/shared/user-roles.service');
    UserRolesService.getUserRoleNames.mockResolvedValue(['Agent']);
    userCanCompleteAb365MemberLogin.mockResolvedValue(false);

    const res = await request(app)
      .post('/auth/login')
      .send({
        email: 'persist-test@example.com',
        password: 'correct-password',
      })
      .expect(200);

    expect(res.body.accessToken).toBeTruthy();
  });

  it('allows TenantAdmin+Member login when AB365 member eligibility is false', async () => {
    const UserRolesService = require('../../services/shared/user-roles.service');
    UserRolesService.getUserRoleNames.mockResolvedValue(['TenantAdmin', 'Member']);
    userCanCompleteAb365MemberLogin.mockResolvedValue(false);

    const res = await request(app)
      .post('/auth/login')
      .send({
        email: 'persist-test@example.com',
        password: 'correct-password',
      })
      .expect(200);

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.roles).toContain('TenantAdmin');
  });
});
