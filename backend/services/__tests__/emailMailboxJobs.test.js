/**
 * emailMailboxJobs.service — renewal "due" logic + per-vendor error isolation.
 * Run: npx jest services/__tests__/emailMailboxJobs.test.js
 */

jest.mock('../../config/database', () => ({ sql: require('mssql'), getPool: jest.fn() }));
jest.mock('../emailSubscriptionService');
jest.mock('../emailSyncService');

const { getPool } = require('../../config/database');
const emailSubscriptionService = require('../emailSubscriptionService');
const emailSyncService = require('../emailSyncService');
const jobs = require('../emailMailboxJobs.service');

const mockVendors = (ids) => {
  getPool.mockResolvedValue({
    request: () => ({ query: async () => ({ recordset: ids.map((VendorId) => ({ VendorId })) }) }),
  });
};

beforeEach(() => jest.clearAllMocks());

describe('renewDueSubscriptions', () => {
  test('renews when missing or near expiry, skips when far off, isolates errors', async () => {
    mockVendors(['v-missing', 'v-soon', 'v-far', 'v-error']);
    emailSyncService.getSyncState.mockImplementation(async (id) => {
      if (id === 'v-missing') return null;
      if (id === 'v-soon') return { SubscriptionId: 's', SubscriptionExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }; // 1h
      if (id === 'v-far') return { SubscriptionId: 's', SubscriptionExpiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString() }; // 6d
      if (id === 'v-error') return { SubscriptionId: 's', SubscriptionExpiresAt: new Date(Date.now() - 1000).toISOString() }; // expired
      return null;
    });
    emailSubscriptionService.renewSubscription.mockImplementation(async (id) => {
      if (id === 'v-error') throw new Error('graph down');
      return { expirationDateTime: 'later' };
    });

    const { vendors, results } = await jobs.renewDueSubscriptions();

    expect(vendors).toBe(4);
    const byId = Object.fromEntries(results.map((r) => [r.vendorId, r.action]));
    expect(byId['v-missing']).toBe('renewed');
    expect(byId['v-soon']).toBe('renewed');
    expect(byId['v-far']).toBe('skipped');
    expect(byId['v-error']).toBe('error');
    // far-off vendor is never renewed
    expect(emailSubscriptionService.renewSubscription).not.toHaveBeenCalledWith('v-far');
  });
});

describe('reconcileAllMailboxes', () => {
  test('reconciles each vendor and isolates failures', async () => {
    mockVendors(['a', 'b']);
    emailSyncService.reconcileDelta.mockImplementation(async (id) => {
      if (id === 'b') throw new Error('boom');
      return { ingested: 3 };
    });
    emailSyncService.reconcileSentDelta.mockImplementation(async (id) => {
      if (id === 'b') throw new Error('boom');
      return { ingested: 0 };
    });

    const { vendors, results } = await jobs.reconcileAllMailboxes();

    expect(vendors).toBe(2);
    expect(results.find((r) => r.vendorId === 'a')).toMatchObject({ action: 'reconciled', ingested: 3 });
    expect(results.find((r) => r.vendorId === 'b')).toMatchObject({ action: 'error' });
  });
});
