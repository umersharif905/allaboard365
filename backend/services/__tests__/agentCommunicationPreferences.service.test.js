/**
 * AgentCommunicationPreferences service — agent notification opt-out logic.
 *
 * Pins the contract the agent settings page + payment-failure notice rely on:
 *   - no preference row => subscribed to everything (opt-out = false)
 *   - isAgentNotificationOptedOut reflects the per-category bit and fails open
 *   - updatePreferencesForAgent inserts on first save and preserves flags left
 *     undefined (partial update)
 *   - resolveAgentByUserId maps a UserId -> { agentId, tenantId }
 *
 * Run: npx jest agentCommunicationPreferences.service
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, getPool: jest.fn() };
});

const { getPool } = require('../../config/database');
const {
  getPreferencesForAgent,
  isAgentNotificationOptedOut,
  resolveAgentByUserId,
  updatePreferencesForAgent
} = require('../agentCommunicationPreferences.service');

/**
 * Stateful fake pool. `prefRow` is the current AgentCommunicationPreferences row
 * (or null). SELECTs return it; INSERT/UPDATE mutate it. `agentRow` answers the
 * oe.Agents lookup.
 */
function buildFakePool({ prefRow = null, agentRow = null } = {}) {
  const state = { prefRow };
  const makeRequest = () => {
    const params = {};
    const req = {
      input: jest.fn((name, _type, val) => {
        // mssql .input(name, type, value) — also tolerate (name, value)
        params[name] = val !== undefined ? val : _type;
        return req;
      }),
      query: jest.fn(async (text) => {
        if (/FROM oe\.Agents/i.test(text)) {
          return { recordset: agentRow ? [agentRow] : [] };
        }
        if (/SELECT[\s\S]*FROM oe\.AgentCommunicationPreferences/i.test(text)) {
          return { recordset: state.prefRow ? [state.prefRow] : [] };
        }
        if (/INSERT INTO oe\.AgentCommunicationPreferences/i.test(text)) {
          state.prefRow = {
            PreferenceId: 'pref-1',
            AgentId: params.AgentId,
            TenantId: params.TenantId,
            EnrollmentNotificationsOptOut: params.EnrollmentNotificationsOptOut,
            PaymentAlertsOptOut: params.PaymentAlertsOptOut,
            MarketingOptOut: params.MarketingOptOut
          };
          return { rowsAffected: [1] };
        }
        if (/UPDATE oe\.AgentCommunicationPreferences/i.test(text)) {
          state.prefRow = {
            ...state.prefRow,
            EnrollmentNotificationsOptOut: params.EnrollmentNotificationsOptOut,
            PaymentAlertsOptOut: params.PaymentAlertsOptOut,
            MarketingOptOut: params.MarketingOptOut
          };
          return { rowsAffected: [1] };
        }
        return { recordset: [] };
      })
    };
    return req;
  };
  return { state, request: jest.fn(makeRequest) };
}

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.warn.mockRestore?.();
  console.error.mockRestore?.();
});
beforeEach(() => jest.clearAllMocks());

describe('getPreferencesForAgent', () => {
  test('no row => subscribed to everything', async () => {
    getPool.mockResolvedValue(buildFakePool({ prefRow: null }));
    const prefs = await getPreferencesForAgent('agent-1');
    expect(prefs).toEqual({
      enrollmentNotificationsEnabled: true,
      paymentAlertsEnabled: true,
      marketingEnabled: true
    });
  });

  test('reflects stored opt-out bits', async () => {
    getPool.mockResolvedValue(buildFakePool({
      prefRow: { EnrollmentNotificationsOptOut: false, PaymentAlertsOptOut: true, MarketingOptOut: true }
    }));
    const prefs = await getPreferencesForAgent('agent-1');
    expect(prefs).toEqual({
      enrollmentNotificationsEnabled: true,
      paymentAlertsEnabled: false,
      marketingEnabled: false
    });
  });
});

describe('isAgentNotificationOptedOut', () => {
  test('false when no row exists', async () => {
    getPool.mockResolvedValue(buildFakePool({ prefRow: null }));
    expect(await isAgentNotificationOptedOut('agent-1', 'payment')).toBe(false);
  });

  test('true when the category bit is set', async () => {
    getPool.mockResolvedValue(buildFakePool({ prefRow: { PaymentAlertsOptOut: true } }));
    expect(await isAgentNotificationOptedOut('agent-1', 'payment')).toBe(true);
  });

  test('fails open (false) for unknown category or missing agentId — no DB hit', async () => {
    getPool.mockResolvedValue(buildFakePool({ prefRow: { PaymentAlertsOptOut: true } }));
    expect(await isAgentNotificationOptedOut('agent-1', 'bogus')).toBe(false);
    expect(await isAgentNotificationOptedOut(null, 'payment')).toBe(false);
    expect(getPool).not.toHaveBeenCalled();
  });
});

describe('resolveAgentByUserId', () => {
  test('maps UserId to agentId + tenantId', async () => {
    getPool.mockResolvedValue(buildFakePool({ agentRow: { AgentId: 'agent-9', TenantId: 'tenant-9' } }));
    expect(await resolveAgentByUserId('user-9')).toEqual({ agentId: 'agent-9', tenantId: 'tenant-9' });
  });

  test('returns null when the user is not an agent', async () => {
    getPool.mockResolvedValue(buildFakePool({ agentRow: null }));
    expect(await resolveAgentByUserId('user-x')).toBeNull();
  });
});

describe('updatePreferencesForAgent', () => {
  test('inserts a row on first save and reflects the new values', async () => {
    const pool = buildFakePool({ prefRow: null });
    getPool.mockResolvedValue(pool);
    const result = await updatePreferencesForAgent('agent-1', 'tenant-1', {
      enrollmentNotificationsEnabled: true,
      paymentAlertsEnabled: false,
      marketingEnabled: false
    });
    expect(result).toEqual({
      enrollmentNotificationsEnabled: true,
      paymentAlertsEnabled: false,
      marketingEnabled: false
    });
    expect(pool.state.prefRow.PaymentAlertsOptOut).toBe(1);
    expect(pool.state.prefRow.MarketingOptOut).toBe(1);
    expect(pool.state.prefRow.EnrollmentNotificationsOptOut).toBe(0);
  });

  test('partial update preserves flags left undefined', async () => {
    const pool = buildFakePool({
      prefRow: { EnrollmentNotificationsOptOut: true, PaymentAlertsOptOut: false, MarketingOptOut: false }
    });
    getPool.mockResolvedValue(pool);
    // Only flip marketing off; the other two must be preserved.
    const result = await updatePreferencesForAgent('agent-1', 'tenant-1', { marketingEnabled: false });
    expect(result.enrollmentNotificationsEnabled).toBe(false); // was opted out -> stays opted out
    expect(result.paymentAlertsEnabled).toBe(true);            // was subscribed -> stays subscribed
    expect(result.marketingEnabled).toBe(false);
  });
});
