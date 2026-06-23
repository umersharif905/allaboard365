/**
 * Unit tests for tenant admin removal + primary tenant swap helpers.
 */

const UserManagementService = require('../shared/user-management.service');

describe('UserManagementService tenant admin helpers', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';
  const tenantC = '33333333-3333-3333-3333-333333333333';

  describe('buildPrimaryTenantSwap', () => {
    it('returns unchanged when new primary matches current primary', () => {
      const result = UserManagementService.buildPrimaryTenantSwap(tenantA, [tenantB], tenantA);
      expect(result.newPrimaryTenantId).toBe(tenantA);
      expect(result.additionalTenantIds).toEqual([tenantB]);
    });

    it('promotes an additional tenant and moves old primary into additional list', () => {
      const result = UserManagementService.buildPrimaryTenantSwap(tenantA, [tenantB, tenantC], tenantB);
      expect(result.newPrimaryTenantId).toBe(tenantB);
      expect(result.additionalTenantIds).toEqual(expect.arrayContaining([tenantA, tenantC]));
      expect(result.additionalTenantIds).toHaveLength(2);
    });

    it('rejects invalid primary selection', () => {
      expect(() =>
        UserManagementService.buildPrimaryTenantSwap(tenantA, [tenantB], tenantC)
      ).toThrow(/invalid primary tenant/i);
    });
  });

  describe('deleteUserDependentRows', () => {
    it('deletes RefreshTokens, UserSessions, and UserRoles before user row', async () => {
      const queries = [];
      const pool = {
        request: () => {
          const req = {
            input: jest.fn().mockReturnThis(),
            query: jest.fn(async (sqlText) => {
              queries.push(sqlText);
              return { recordset: [], rowsAffected: [1] };
            })
          };
          return req;
        }
      };

      await UserManagementService.deleteUserRecord(pool, tenantA);

      expect(queries.some((q) => /DELETE FROM oe\.RefreshTokens/i.test(q))).toBe(true);
      expect(queries.some((q) => /DELETE FROM oe\.UserSessions/i.test(q))).toBe(true);
      expect(queries.some((q) => /DELETE FROM oe\.UserRoles/i.test(q))).toBe(true);
      expect(queries.some((q) => /DELETE FROM oe\.Users/i.test(q))).toBe(true);
      expect(queries.indexOf(queries.find((q) => /DELETE FROM oe\.Users/i.test(q)))).toBeGreaterThan(
        queries.findIndex((q) => /DELETE FROM oe\.RefreshTokens/i.test(q))
      );
    });
  });
});
