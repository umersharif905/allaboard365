'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
  createSessionTokensForUser: jest.fn().mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    roles: ['Agent'],
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@test.com',
  }),
}));

jest.mock('../activateUserAfterLogin.service', () => ({
  activateUserAfterSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../memberHouseholdLoginContext.service', () => ({
  getLoginMetadataForUser: jest.fn().mockResolvedValue({
    memberId: 'member-guid',
    householdMemberId: 'SW1234567',
  }),
}));

jest.mock('../mobileAb365LoginEligibility.service', () => ({
  userCanCompleteAb365MemberLogin: jest.fn().mockResolvedValue(true),
}));

const { getPool } = require('../../config/database');
const UserRolesService = require('../shared/user-roles.service');
const { getLoginMetadataForUser } = require('../memberHouseholdLoginContext.service');
const LoginOtpService = require('../login-otp.service');

const SERVICE_PATH = path.join(__dirname, '../login-otp.service.js');

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function mockVerifyOtpPool({ challengeId, userId, code }) {
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
                CodeHash: hashCode(code),
                ExpiresAt: new Date(Date.now() + 600000),
                Verified: 0,
                Attempts: 0,
                ConsumedAt: null,
              }],
            };
          }
          if (sqlText.includes('UPDATE oe.LoginOtpCodes SET Attempts')) {
            return { recordset: [] };
          }
          if (sqlText.includes('FROM oe.Users u')) {
            return {
              recordset: [{
                UserId: userId,
                Email: 'user@test.com',
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
}

describe('login-otp.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('module wiring', () => {
    it('imports getLoginMetadataForUser from memberHouseholdLoginContext.service', () => {
      const source = fs.readFileSync(SERVICE_PATH, 'utf8');
      expect(source).toContain(
        "const { getLoginMetadataForUser } = require('./memberHouseholdLoginContext.service');"
      );
    });
  });

  describe('verifyOtp', () => {
    const code = '123456';
    const challengeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const userId = '11111111-2222-3333-4444-555555555555';
    const req = { ip: '127.0.0.1', headers: { 'user-agent': 'jest' } };

    it('returns tokens and login metadata for portal verify (regression: missing import caused 500)', async () => {
      UserRolesService.getUserRoleNames.mockResolvedValue(['Agent']);
      mockVerifyOtpPool({ challengeId, userId, code });

      const result = await LoginOtpService.verifyOtp(req, {
        challengeId,
        code,
        client: 'portal',
      });

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('access-token');
      expect(result.memberId).toBe('member-guid');
      expect(result.householdMemberId).toBe('SW1234567');
      expect(getLoginMetadataForUser).toHaveBeenCalledWith(userId);
    });

    it('returns tokens and login metadata for mobile member verify', async () => {
      UserRolesService.getUserRoleNames.mockResolvedValue(['Member']);
      mockVerifyOtpPool({ challengeId, userId, code });

      const result = await LoginOtpService.verifyOtp(req, {
        challengeId,
        code,
        client: 'mobile',
      });

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('access-token');
      expect(result.memberId).toBe('member-guid');
      expect(result.householdMemberId).toBe('SW1234567');
      expect(getLoginMetadataForUser).toHaveBeenCalledWith(userId);
    });
  });
});
