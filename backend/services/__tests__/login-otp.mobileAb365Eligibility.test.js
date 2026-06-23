'use strict';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
    Bit: 'Bit',
  },
}));

jest.mock('../shared/user-roles.service', () => ({
  getUserRoleNames: jest.fn(),
}));

jest.mock('../auth-session.service', () => ({
  createSessionTokensForUser: jest.fn(),
}));

jest.mock('../activateUserAfterLogin.service', () => ({
  activateUserAfterSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../memberHouseholdLoginContext.service', () => ({
  getLoginMetadataForUser: jest.fn().mockResolvedValue({}),
}));

jest.mock('../login-otp-mailer', () => ({
  sendLoginOtpEmail: jest.fn(),
  sendLoginOtpSms: jest.fn(),
  isSyntheticEmail: jest.fn().mockReturnValue(false),
}));

jest.mock('../tenant-messaging-credentials.service', () => ({
  getTenantMessagingCredentials: jest.fn(),
}));

const mockUserCanCompleteAb365MemberLogin = jest.fn().mockResolvedValue(true);

jest.mock('../mobileAb365LoginEligibility.service', () => ({
  userCanCompleteAb365MemberLogin: (...args) => mockUserCanCompleteAb365MemberLogin(...args),
}));

const LoginOtpService = require('../login-otp.service');

describe('login-otp mobile AB365 eligibility', () => {
  const req = { ip: '127.0.0.1', headers: { 'user-agent': 'jest' } };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserCanCompleteAb365MemberLogin.mockResolvedValue(true);
  });

  it('verifyOtp rejects mobile when user cannot complete AB365 member login', async () => {
    mockUserCanCompleteAb365MemberLogin.mockResolvedValue(false);

    const crypto = require('crypto');
    const { getPool } = require('../../config/database');
    const challengeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const userId = '11111111-2222-3333-4444-555555555555';
    const codeHash = crypto.createHash('sha256').update('123456').digest('hex');

    getPool.mockResolvedValue({
      request: () => {
        const chain = {
          input: jest.fn().mockReturnThis(),
          query: jest.fn().mockImplementation(async (sqlText) => {
            if (sqlText.includes('FROM oe.LoginOtpCodes') && sqlText.includes('ChallengeId')) {
              return {
                recordset: [{
                  ChallengeId: challengeId,
                  UserId: userId,
                  CodeHash: codeHash,
                  ExpiresAt: new Date(Date.now() + 600000),
                  Verified: 0,
                  Attempts: 0,
                  ConsumedAt: null,
                }],
              };
            }
            if (sqlText.includes('FROM oe.Users u')) {
              return {
                recordset: [{
                  UserId: userId,
                  Email: 'orphan@test.com',
                  FirstName: 'Test',
                  LastName: 'User',
                  PhoneNumber: null,
                  TenantId: '22222222-3333-4444-5555-666666666666',
                  Status: 'Active',
                }],
              };
            }
            if (sqlText.includes('UPDATE oe.LoginOtpCodes SET Attempts')) {
              return { recordset: [] };
            }
            if (sqlText.includes('INSERT INTO oe.AuthLog')) {
              return { recordset: [] };
            }
            return { recordset: [] };
          }),
        };
        return chain;
      },
    });

    const result = await LoginOtpService.verifyOtp(req, {
      challengeId,
      code: '123456',
      client: 'mobile',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(mockUserCanCompleteAb365MemberLogin).toHaveBeenCalledWith(userId);
  });

  it('verifyOtp allows portal when user cannot complete AB365 member login', async () => {
    mockUserCanCompleteAb365MemberLogin.mockResolvedValue(false);

    const crypto = require('crypto');
    const { getPool } = require('../../config/database');
    const UserRolesService = require('../shared/user-roles.service');
    const { createSessionTokensForUser } = require('../auth-session.service');

    const challengeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const userId = '11111111-2222-3333-4444-555555555555';
    const codeHash = crypto.createHash('sha256').update('123456').digest('hex');

    UserRolesService.getUserRoleNames.mockResolvedValue(['Member']);
    createSessionTokensForUser.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });

    getPool.mockResolvedValue({
      request: () => {
        const chain = {
          input: jest.fn().mockReturnThis(),
          query: jest.fn().mockImplementation(async (sqlText) => {
            if (sqlText.includes('FROM oe.LoginOtpCodes') && sqlText.includes('ChallengeId')) {
              return {
                recordset: [{
                  ChallengeId: challengeId,
                  UserId: userId,
                  CodeHash: codeHash,
                  ExpiresAt: new Date(Date.now() + 600000),
                  Verified: 0,
                  Attempts: 0,
                  ConsumedAt: null,
                }],
              };
            }
            if (sqlText.includes('FROM oe.Users u')) {
              return {
                recordset: [{
                  UserId: userId,
                  Email: 'member@test.com',
                  FirstName: 'Test',
                  LastName: 'User',
                  PhoneNumber: null,
                  TenantId: '22222222-3333-4444-5555-666666666666',
                  Status: 'Active',
                }],
              };
            }
            if (sqlText.includes('Verified = 1')) {
              return { recordset: [] };
            }
            if (sqlText.includes('INSERT INTO oe.AuthLog')) {
              return { recordset: [] };
            }
            return { recordset: [] };
          }),
        };
        return chain;
      },
    });

    const result = await LoginOtpService.verifyOtp(req, {
      challengeId,
      code: '123456',
      client: 'portal',
    });

    expect(result.success).toBe(true);
    expect(mockUserCanCompleteAb365MemberLogin).not.toHaveBeenCalled();
  });
});
