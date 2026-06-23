/**
 * ZoomPhoneService.storeSyncedCall — bulk-sync row write.
 *
 * Pins:
 *   - extracts caller/callee from nested OR flat sync-API shape
 *   - writes AgentUserId / ZoomUserId / AgentEmail / AnsweredBy
 *   - skips duplicates by ExternalCallId
 *
 * Run: npx jest zoomPhoneService.storeSyncedCall
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');
const { getPool } = require('../../config/database');

describe('ZoomPhoneService.storeSyncedCall', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
  const config = { autoMatchEnabled: true };

  beforeEach(() => {
    jest.spyOn(ZoomPhoneService, 'matchPhoneToMemberForSync').mockResolvedValue(null);
    jest.spyOn(ZoomPhoneService, 'resolveAgentUserId').mockResolvedValue('internal-uid');
  });

  afterEach(() => jest.restoreAllMocks());

  test('nested-shape inbound call: writes agent attribution + AnsweredBy', async () => {
    const captured = {};
    const req = {
      input: jest.fn(function (key, _type, value) { captured[key] = value; return this; }),
      query: jest.fn(async (sqlText) => {
        if (/SELECT CallLogId/i.test(sqlText)) return { recordset: [] }; // dedup miss
        return { recordset: [], rowsAffected: [1] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.storeSyncedCall(vendorId, {
      id: 'sync-call-1',
      direction: 'inbound',
      caller: { phone_number: '+18005551212' },
      callee: { user_id: 'zoomU1', email: 'a@v.com', extension_number: '102', extension_type: 'user' },
      duration: 30,
      result: 'answered',
    }, config);

    expect(captured.agentUserId).toBe('internal-uid');
    expect(captured.zoomUserId).toBe('zoomU1');
    expect(captured.agentEmail).toBe('a@v.com');
    expect(captured.answeredBy).toBe('User');
    expect(captured.callerNumber).toBe('+18005551212');
  });

  test('flat-shape outbound call: extracts caller fields from flat keys', async () => {
    const captured = {};
    const req = {
      input: jest.fn(function (key, _type, value) { captured[key] = value; return this; }),
      query: jest.fn(async (sqlText) => {
        if (/SELECT CallLogId/i.test(sqlText)) return { recordset: [] };
        return { recordset: [], rowsAffected: [1] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.storeSyncedCall(vendorId, {
      id: 'sync-call-2',
      direction: 'outbound',
      caller_number: '+13105550000',
      callee_number: '+14005550000',
      caller_name: 'Agent A',
      duration: 12,
      result: 'connected',
    }, config);

    expect(captured.callerNumber).toBe('+13105550000');
    expect(captured.calleeNumber).toBe('+14005550000');
  });

  test('skips duplicate (ExternalCallId already exists)', async () => {
    const req = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn(async (sqlText) => {
        if (/SELECT CallLogId/i.test(sqlText)) return { recordset: [{ CallLogId: 'x' }] };
        throw new Error('Should not have INSERTed');
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const result = await ZoomPhoneService.storeSyncedCall(vendorId, {
      id: 'sync-call-3',
      direction: 'inbound',
    }, config);
    expect(result).toEqual({ skipped: true });
  });

  test('AR-handled inbound: extension_type=auto_receptionist → AnsweredBy=AutoReceptionist', async () => {
    ZoomPhoneService.resolveAgentUserId.mockResolvedValue(null);
    const captured = {};
    const req = {
      input: jest.fn(function (key, _type, value) { captured[key] = value; return this; }),
      query: jest.fn(async (sqlText) => {
        if (/SELECT CallLogId/i.test(sqlText)) return { recordset: [] };
        return { recordset: [], rowsAffected: [1] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.storeSyncedCall(vendorId, {
      id: 'sync-call-4',
      direction: 'inbound',
      caller: { phone_number: '+18005551212' },
      callee: { extension_type: 'auto_receptionist', name: 'Main AR' },
      duration: 45,
      result: 'answered',
    }, config);

    expect(captured.agentUserId).toBeNull();
    expect(captured.answeredBy).toBe('AutoReceptionist');
  });
});
