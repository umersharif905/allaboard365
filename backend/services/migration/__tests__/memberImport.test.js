'use strict';

const {
  allocateMigrationUserEmail,
  normalizeMigrationEmailKey,
  resolvePrimaryMigrationEmail,
  formatSkippedDependentsNote
} = require('../memberImport.service');

describe('memberImport migration emails', () => {
  test('normalizeMigrationEmailKey lowercases and trims', () => {
    expect(normalizeMigrationEmailKey('  Joe@Example.COM ')).toBe('joe@example.com');
    expect(normalizeMigrationEmailKey('')).toBeNull();
  });

  test('allocateMigrationUserEmail reuses primary email once then assigns dependents unique fallbacks', () => {
    const used = new Set();
    const primary = allocateMigrationUserEmail({
      preferredEmail: 'joemcg30@gmail.com',
      householdMemberId: 'SW0530092',
      usedEmailKeys: used,
      slotKey: 'primary'
    });
    const dep1 = allocateMigrationUserEmail({
      preferredEmail: 'joemcg30@gmail.com',
      householdMemberId: 'SW0530092',
      usedEmailKeys: used,
      slotKey: 'dep-1'
    });
    const dep2 = allocateMigrationUserEmail({
      preferredEmail: 'joemcg30@gmail.com',
      householdMemberId: 'SW0530092',
      usedEmailKeys: used,
      slotKey: 'dep-2'
    });

    expect(primary).toBe('joemcg30@gmail.com');
    expect(dep1).toBe('sw0530092+dep-1@noemail.com');
    expect(dep2).toBe('sw0530092+dep-2@noemail.com');
    expect(dep1).not.toBe(dep2);
  });

  test('resolvePrimaryMigrationEmail falls back when email already exists in oe.Users', async () => {
    let queryCount = 0;
    const mockPool = {
      request: () => {
        const chain = {
          input() {
            return chain;
          },
          query: async () => {
            queryCount += 1;
            if (queryCount === 1) {
              return { recordset: [{ UserId: 'existing-user' }] };
            }
            return { recordset: [] };
          },
        };
        return chain;
      },
    };
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const email = await resolvePrimaryMigrationEmail(mockPool, {
      householdMemberId: 'SW0530092',
      primary: { email: 'joemcg30@gmail.com' }
    }, new Set(), tenantId);
    expect(email).toBe('sw0530092+primary@noemail.com');
  });

  test('resolvePrimaryMigrationEmail keeps preferred email for agent-only user', async () => {
    const tenantId = '11111111-1111-1111-1111-111111111111';
    let queryCount = 0;
    const mockPool = {
      request: () => {
        const chain = {
          input() {
            return chain;
          },
          query: async () => {
            queryCount += 1;
            if (queryCount === 1) {
              return { recordset: [{ UserId: 'agent-user-id' }] };
            }
            return { recordset: [{ UserId: 'agent-user-id', AgentId: 'agent-id' }] };
          },
        };
        return chain;
      },
    };
    const email = await resolvePrimaryMigrationEmail(mockPool, {
      householdMemberId: 'SW2471851',
      primary: { email: 'rostarks@gmail.com' }
    }, new Set(), tenantId);
    expect(email).toBe('rostarks@gmail.com');
  });

  test('formatSkippedDependentsNote summarizes skipped dependents', () => {
    expect(formatSkippedDependentsNote([])).toBe('');
    expect(formatSkippedDependentsNote(['Daniel Sanderson'])).toBe(
      ' (1 dependent already in AB365 skipped: Daniel Sanderson)'
    );
  });
});
