/**
 * ZoomPhoneService.handleAiCallSummaryChanged — Zoom's native AI summary
 * webhook (April 2025 changelog). Distinct from our OpenAI summary path.
 *
 * Run: npx jest zoomPhoneService.handleAiCallSummary
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');
const { getPool } = require('../../config/database');

describe('ZoomPhoneService.handleAiCallSummaryChanged', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

  beforeEach(() => {
    jest.spyOn(ZoomPhoneService, 'mirrorCallLogToEncounter').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('persists summary to ZoomAISummary column and stamps ReceivedAt', async () => {
    const captured = {};
    const req = {
      input: jest.fn(function (k, _t, v) { captured[k] = v; return this; }),
      query: jest.fn(async (sqlText) => {
        if (/UPDATE oe\.VendorCallLogs/i.test(sqlText)) {
          return { recordset: [{ CallLogId: 'cl-1' }] };
        }
        return { recordset: [] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const payload = {
      object: {
        call_id: 'call-123',
        ai_summary: {
          summary: 'Member called to ask about HSA eligibility for upcoming knee surgery.',
          next_steps: ['Send HSA enrollment form'],
        },
      },
    };
    const r = await ZoomPhoneService.handleAiCallSummaryChanged(vendorId, payload);
    expect(r.handled).toBe(true);
    expect(captured.zoomAISummary).toContain('HSA');
    expect(captured.externalCallId).toBe('call-123');
  });

  test('handles flat top-level summary string', async () => {
    const captured = {};
    const req = {
      input: jest.fn(function (k, _t, v) { captured[k] = v; return this; }),
      query: jest.fn(async () => ({ recordset: [{ CallLogId: 'cl-1' }] })),
    };
    getPool.mockResolvedValue({ request: () => req });

    const payload = { object: { call_id: 'call-flat', summary: 'Short summary text.' } };
    await ZoomPhoneService.handleAiCallSummaryChanged(vendorId, payload);
    expect(captured.zoomAISummary).toBe('Short summary text.');
  });
});
