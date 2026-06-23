'use strict';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: { UniqueIdentifier: 'UniqueIdentifier' },
}));

jest.mock('../shared/user-roles.service', () => ({
  getUserRoleNames: jest.fn(),
}));

jest.mock('../mobileLoginDeferLegacy.service', () => ({
  userShouldDeferMobileLoginToLegacy: jest.fn(),
}));

const { getPool } = require('../../config/database');
const UserRolesService = require('../shared/user-roles.service');
const { userShouldDeferMobileLoginToLegacy } = require('../mobileLoginDeferLegacy.service');
const {
  userCanCompleteAb365MemberLogin,
  userHasLinkedNonTerminatedMember,
  shouldGateAb365MemberPasswordLogin,
} = require('../mobileAb365LoginEligibility.service');

describe('mobileAb365LoginEligibility.service', () => {
  const userId = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockMemberExists(exists) {
    getPool.mockResolvedValue({
      request: () => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue({ recordset: exists ? [{ ok: 1 }] : [] }),
      }),
    });
  }

  it('userHasLinkedNonTerminatedMember returns true when member row exists', async () => {
    mockMemberExists(true);
    await expect(userHasLinkedNonTerminatedMember(userId)).resolves.toBe(true);
  });

  it('userHasLinkedNonTerminatedMember returns false when no member row', async () => {
    mockMemberExists(false);
    await expect(userHasLinkedNonTerminatedMember(userId)).resolves.toBe(false);
  });

  it('userCanCompleteAb365MemberLogin false without Member role', async () => {
    UserRolesService.getUserRoleNames.mockResolvedValue(['Agent']);
    mockMemberExists(true);
    userShouldDeferMobileLoginToLegacy.mockResolvedValue(false);
    await expect(userCanCompleteAb365MemberLogin(userId)).resolves.toBe(false);
  });

  it('userCanCompleteAb365MemberLogin false without linked member (Steve orphan)', async () => {
    UserRolesService.getUserRoleNames.mockResolvedValue(['Member']);
    mockMemberExists(false);
    await expect(userCanCompleteAb365MemberLogin(userId)).resolves.toBe(false);
    expect(userShouldDeferMobileLoginToLegacy).not.toHaveBeenCalled();
  });

  it('userCanCompleteAb365MemberLogin false when pending migration defer', async () => {
    UserRolesService.getUserRoleNames.mockResolvedValue(['Member']);
    mockMemberExists(true);
    userShouldDeferMobileLoginToLegacy.mockResolvedValue(true);
    await expect(userCanCompleteAb365MemberLogin(userId)).resolves.toBe(false);
  });

  it('userCanCompleteAb365MemberLogin true for go-live member', async () => {
    UserRolesService.getUserRoleNames.mockResolvedValue(['Member']);
    mockMemberExists(true);
    userShouldDeferMobileLoginToLegacy.mockResolvedValue(false);
    await expect(userCanCompleteAb365MemberLogin(userId)).resolves.toBe(true);
  });

  it('shouldGateAb365MemberPasswordLogin false for TenantAdmin+Member', () => {
    expect(shouldGateAb365MemberPasswordLogin(['TenantAdmin', 'Member'])).toBe(false);
    expect(shouldGateAb365MemberPasswordLogin(['Member'])).toBe(true);
    expect(shouldGateAb365MemberPasswordLogin(['Agent'])).toBe(false);
  });
});
