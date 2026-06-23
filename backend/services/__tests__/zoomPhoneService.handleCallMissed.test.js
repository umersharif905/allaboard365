/**
 * ZoomPhoneService.handleCallMissed — handles phone.callee_missed webhook.
 *
 * Pins:
 *   - reads nested caller{}/callee{} shape (real Zoom payload)
 *   - resolves AgentUserId via VendorPhoneAgentMap
 *   - classifies AnsweredBy = 'User' when callee.extension_type='user'
 *   - dedupes when same ExternalCallId is already logged
 *
 * Run: npx jest zoomPhoneService.handleCallMissed
 */

jest.mock('../../config/database', () => {
  const sql = require('mssql');
  return { sql, getPool: jest.fn() };
});

const ZoomPhoneService = require('../zoomPhoneService');
const { getPool } = require('../../config/database');

function makeRequestMock(responseMap) {
  // Each query() returns the next queued result in order it's called.
  const queries = [];
  const req = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(async (sqlText) => {
      const matched = responseMap.find((r) => r.match.test(sqlText));
      queries.push({ sqlText, matched: !!matched });
      if (!matched) return { recordset: [], rowsAffected: [0] };
      const result = typeof matched.result === 'function' ? matched.result(sqlText) : matched.result;
      return result;
    }),
  };
  return { req, queries };
}

describe('ZoomPhoneService.handleCallMissed', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

  beforeEach(() => {
    jest.spyOn(ZoomPhoneService, 'getVendorConfig').mockResolvedValue({ autoMatchEnabled: true });
    jest.spyOn(ZoomPhoneService, 'recordCallLog').mockResolvedValue('new-log-id');
    jest.spyOn(ZoomPhoneService, 'matchPhoneToMember').mockResolvedValue(null);
    jest.spyOn(ZoomPhoneService, 'resolveAgentUserId').mockResolvedValue('internal-user-id');
  });

  afterEach(() => jest.restoreAllMocks());

  test('nested payload: extracts caller/callee, resolves agent, classifies AnsweredBy=User', async () => {
    // Real prod payload shape from CallLogId 62D67D06
    const payload = {
      object: {
        call_id: '7644236094002219380',
        caller: {
          extension_type: 'autoReceptionist',
          phone_number: '+18282131111',
          extension_number: 18282131111,
        },
        callee: {
          extension_type: 'user',
          user_id: 'z4W4cRjDTyqkZb23rgytCg',
          extension_number: 813,
          phone_number: '813',
        },
        forwarded_by: { name: 'Member Care Team', extension_type: 'callQueue' },
        handup_result: 'No Answer',
      },
    };

    // Pool only consulted for dedup check
    const { req } = makeRequestMock([
      { match: /SELECT CallLogId FROM oe\.VendorCallLogs/i, result: { recordset: [] } },
    ]);
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.handleCallMissed(vendorId, payload);

    expect(ZoomPhoneService.resolveAgentUserId).toHaveBeenCalledWith(
      vendorId,
      expect.objectContaining({ userId: 'z4W4cRjDTyqkZb23rgytCg', extension: '813' }),
    );

    expect(ZoomPhoneService.recordCallLog).toHaveBeenCalledWith(
      vendorId,
      expect.objectContaining({
        callType: 'Missed',
        callStatus: 'Missed',
        callerNumber: '+18282131111',
        agentUserId: 'internal-user-id',
        zoomUserId: 'z4W4cRjDTyqkZb23rgytCg',
        answeredBy: 'User',
        externalCallId: '7644236094002219380',
      }),
    );
  });

  test('clears the live row: marks VendorActiveCalls Ended for the call_id', async () => {
    const payload = {
      object: {
        call_id: '7644553530738110878',
        caller: { phone_number: '+16153163000', extension_type: 'pstn' },
        callee: { user_id: 'zU', extension_type: 'user', extension_number: 813 },
        handup_result: 'No Answer',
      },
    };

    const { req, queries } = makeRequestMock([
      { match: /SELECT CallLogId FROM oe\.VendorCallLogs/i, result: { recordset: [] } },
    ]);
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.handleCallMissed(vendorId, payload);

    const cleared = queries.some((q) =>
      /UPDATE oe\.VendorActiveCalls/i.test(q.sqlText) &&
      /CallStatus = 'Ended'/i.test(q.sqlText) &&
      /ExternalCallId = @externalCallId/i.test(q.sqlText));
    expect(cleared).toBe(true);
  });

  test('clears the live row even on a deduped (already-logged) missed event', async () => {
    const payload = {
      object: {
        call_id: 'already-logged',
        caller: { phone_number: '+15555550000' },
        callee: { user_id: 'zU', extension_type: 'user' },
      },
    };

    const { req, queries } = makeRequestMock([
      {
        match: /SELECT CallLogId FROM oe\.VendorCallLogs/i,
        result: { recordset: [{ CallLogId: 'existing-id' }] },
      },
    ]);
    getPool.mockResolvedValue({ request: () => req });

    const result = await ZoomPhoneService.handleCallMissed(vendorId, payload);

    expect(result).toEqual({ handled: true, callLogId: 'existing-id', deduped: true });
    const cleared = queries.some((q) => /UPDATE oe\.VendorActiveCalls/i.test(q.sqlText));
    expect(cleared).toBe(true);
  });

  test('dedup: when ExternalCallId already logged, skips insert', async () => {
    const payload = {
      object: {
        call_id: 'already-logged',
        caller: { phone_number: '+15555550000' },
        callee: { user_id: 'zU', extension_type: 'user' },
      },
    };

    const { req } = makeRequestMock([
      {
        match: /SELECT CallLogId FROM oe\.VendorCallLogs/i,
        result: { recordset: [{ CallLogId: 'existing-id' }] },
      },
    ]);
    getPool.mockResolvedValue({ request: () => req });

    const result = await ZoomPhoneService.handleCallMissed(vendorId, payload);

    expect(ZoomPhoneService.recordCallLog).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, callLogId: 'existing-id', deduped: true });
  });

  test('AR-only missed (no human user_id on callee) → AnsweredBy=AutoReceptionist, agentUserId=null', async () => {
    ZoomPhoneService.resolveAgentUserId.mockResolvedValue(null);
    const payload = {
      object: {
        call_id: 'ar-only',
        caller: { phone_number: '+18002691451', extension_type: 'pstn' },
        callee: { extension_type: 'autoReceptionist', name: 'Main Auto Receptionist' },
        handup_result: 'No Answer',
      },
    };

    const { req } = makeRequestMock([
      { match: /SELECT CallLogId FROM oe\.VendorCallLogs/i, result: { recordset: [] } },
    ]);
    getPool.mockResolvedValue({ request: () => req });

    await ZoomPhoneService.handleCallMissed(vendorId, payload);

    expect(ZoomPhoneService.recordCallLog).toHaveBeenCalledWith(
      vendorId,
      expect.objectContaining({
        agentUserId: null,
        answeredBy: 'AutoReceptionist',
      }),
    );
  });
});
