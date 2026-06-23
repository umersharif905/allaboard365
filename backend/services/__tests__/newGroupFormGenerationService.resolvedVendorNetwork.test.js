/**
 * Tests for loadResolvedVendorNetworkForGroup — explicit group selection vs vendor default vs empty.
 */

const { loadResolvedVendorNetworkForGroup } = require('../newGroupFormGenerationService');

describe('loadResolvedVendorNetworkForGroup', () => {
  const groupId = '11111111-1111-1111-1111-111111111111';
  const vendorId = '22222222-2222-2222-2222-222222222222';

  test('returns explicit group network when active row exists', async () => {
    let calls = 0;
    const pool = {
      request() {
        calls += 1;
        return {
          input() {
            return this;
          },
          async query() {
            if (calls === 1) {
              return {
                recordset: [{ Title: ' PPO East ' }]
              };
            }
            throw new Error('should not query default when explicit matches');
          }
        };
      }
    };
    const result = await loadResolvedVendorNetworkForGroup(pool, groupId, vendorId);
    expect(result).toEqual({ title: 'PPO East' });
    expect(calls).toBe(1);
  });

  test('falls back to vendor default when no explicit active selection', async () => {
    let calls = 0;
    const pool = {
      request() {
        calls += 1;
        return {
          input() {
            return this;
          },
          async query() {
            if (calls === 1) {
              return { recordset: [] };
            }
            return {
              recordset: [{ Title: 'Default Net' }]
            };
          }
        };
      }
    };
    const result = await loadResolvedVendorNetworkForGroup(pool, groupId, vendorId);
    expect(result).toEqual({ title: 'Default Net' });
    expect(calls).toBe(2);
  });

  test('returns empty when neither explicit nor default exists', async () => {
    let calls = 0;
    const pool = {
      request() {
        calls += 1;
        return {
          input() {
            return this;
          },
          async query() {
            return { recordset: [] };
          }
        };
      }
    };
    const result = await loadResolvedVendorNetworkForGroup(pool, groupId, vendorId);
    expect(result).toEqual({ title: '' });
    expect(calls).toBe(2);
  });

  test('explicit query failure still attempts default', async () => {
    let calls = 0;
    const pool = {
      request() {
        calls += 1;
        return {
          input() {
            return this;
          },
          async query() {
            if (calls === 1) {
              throw new Error('db offline');
            }
            return {
              recordset: [{ Title: 'Fallback Default' }]
            };
          }
        };
      }
    };
    const result = await loadResolvedVendorNetworkForGroup(pool, groupId, vendorId);
    expect(result).toEqual({ title: 'Fallback Default' });
    expect(calls).toBe(2);
  });
});
