/**
 * optOutEmailMarketingFromUnsubscribe — public unsubscribe opt-out.
 *
 * Regression: an unsubscribe token whose member was deleted must NOT FK-crash
 * the public endpoint — it returns { memberMissing: true } instead of throwing.
 * Also pins the happy path (insert) and the idempotent already-opted-out path.
 *
 * Run: npx jest services/__tests__/memberCommunicationPreferences.optOut.test.js
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, getPool: jest.fn() };
});

const { getPool } = require('../../config/database');
const { optOutEmailMarketingFromUnsubscribe } = require('../memberCommunicationPreferences.service');

/**
 * @param {object} opts
 * @param {object|null} opts.prefRow  existing MemberCommunicationPreferences row (or null)
 * @param {boolean} opts.memberExists whether oe.Members has the MemberId
 */
function buildFakePool({ prefRow = null, memberExists = true } = {}) {
  const state = { prefRow, inserts: 0, updates: 0, consentLogs: 0 };
  const makeRequest = () => {
    const req = {
      input() { return req; },
      query: jest.fn(async (text) => {
        if (/SELECT[\s\S]*FROM oe\.MemberCommunicationPreferences/i.test(text)) {
          return { recordset: state.prefRow ? [state.prefRow] : [] };
        }
        if (/SELECT 1 AS ok FROM oe\.Members/i.test(text)) {
          return { recordset: memberExists ? [{ ok: 1 }] : [] };
        }
        if (/INSERT INTO oe\.MemberCommunicationPreferences/i.test(text)) {
          state.inserts++; return { rowsAffected: [1] };
        }
        if (/UPDATE oe\.MemberCommunicationPreferences/i.test(text)) {
          state.updates++; return { rowsAffected: [1] };
        }
        if (/INSERT INTO oe\.MemberConsentLog/i.test(text)) {
          state.consentLogs++; return { rowsAffected: [1] };
        }
        return { recordset: [] };
      })
    };
    return req;
  };
  return { state, request: jest.fn(makeRequest) };
}

beforeEach(() => jest.clearAllMocks());

it('returns { memberMissing: true } and writes nothing when the member was deleted', async () => {
  const pool = buildFakePool({ prefRow: null, memberExists: false });
  getPool.mockResolvedValue(pool);

  const result = await optOutEmailMarketingFromUnsubscribe('gone-member', 'ten-1');

  expect(result).toEqual({ memberMissing: true });
  expect(pool.state.inserts).toBe(0);
  expect(pool.state.consentLogs).toBe(0);
});

it('inserts an opt-out row + consent log for an existing member with no prefs yet', async () => {
  const pool = buildFakePool({ prefRow: null, memberExists: true });
  getPool.mockResolvedValue(pool);

  const result = await optOutEmailMarketingFromUnsubscribe('mem-1', 'ten-1');

  expect(result).toEqual({ success: true });
  expect(pool.state.inserts).toBe(1);
  expect(pool.state.consentLogs).toBe(1);
});

it('is idempotent — already opted out short-circuits with no writes', async () => {
  const pool = buildFakePool({ prefRow: { EmailMarketingOptOut: true }, memberExists: true });
  getPool.mockResolvedValue(pool);

  const result = await optOutEmailMarketingFromUnsubscribe('mem-1', 'ten-1');

  expect(result).toEqual({ alreadyOptedOut: true });
  expect(pool.state.inserts).toBe(0);
  expect(pool.state.updates).toBe(0);
});
