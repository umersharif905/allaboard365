/**
 * EncounterService.createFromCallLog — auto-create an encounter from a
 * VendorCallLogs row. Triggered from Zoom webhook handlers.
 *
 * Run: npx jest encounterService.createFromCallLog
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const EncounterService = require('../encounterService');
const { getPool } = require('../../config/database');

describe('EncounterService.createFromCallLog', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
  const callLogId = 'CL-0001';

  test('creates encounter with Source=zoom_phone, ExternalRef=callLogId, Channel=phone', async () => {
    const captured = {};
    const queries = [];
    const req = {
      input: jest.fn(function (k, _t, v) { captured[k] = v; return this; }),
      query: jest.fn(async (sqlText) => {
        queries.push(sqlText);
        // Dedup check — WHERE ... Source='zoom_phone' AND ExternalRef=@externalRef
        if (/FROM oe\.Encounters/i.test(sqlText) && /Source='zoom_phone'/i.test(sqlText)) return { recordset: [] };
        // Encounter number count (generateEncounterNumber) — EncounterNumber LIKE @prefix
        if (/FROM oe\.Encounters/i.test(sqlText) && /EncounterNumber LIKE/i.test(sqlText)) {
          return { recordset: [{ Count: 0 }] };
        }
        // SELECT from VendorCallLogs (load source row)
        if (/FROM oe\.VendorCallLogs/i.test(sqlText)) {
          return { recordset: [{
            CallLogId: callLogId,
            VendorId: vendorId,
            CallType: 'Inbound',
            CallStatus: 'Completed',
            CallerName: 'Jane Member',
            CallerNumber: '+13105551212',
            CalleeName: 'Stephanie Hollis',
            CallStartTime: new Date('2026-05-26T16:00:00Z'),
            CallDurationSeconds: 184,
            MemberId: 'MEM-0001',
            AgentUserId: 'USR-0001',
            AnsweredBy: 'User',
            HasRecording: true,
            RecordingUrl: 'https://zoom.us/dl/x',
            TranscriptText: null,
            AISummary: null,
            ZoomAISummary: null,
          }]};
        }
        // INSERT into Encounters
        if (/INSERT INTO oe\.Encounters/i.test(sqlText)) {
          return { recordset: [{ EncounterId: 'ENC-0001' }] };
        }
        // getEncounterById — the full SELECT with JOINs (returns r.recordset[0])
        if (/FROM oe\.Encounters e/i.test(sqlText)) {
          return { recordset: [{ EncounterId: 'ENC-0001', Source: 'zoom_phone' }] };
        }
        return { recordset: [] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const result = await EncounterService.createFromCallLog(vendorId, callLogId);
    expect(result).toBeTruthy();
    expect(captured.source).toBe('zoom_phone');
    expect(captured.externalRef).toBe(callLogId);
    expect(captured.channel).toBe('phone');
    expect(captured.direction).toBe('inbound');
    expect(captured.memberId).toBe('MEM-0001');
    expect(captured.assignedToUserId).toBe('USR-0001');
    expect(captured.durationSeconds).toBe(184);
    expect(captured.summary).toMatch(/Inbound call/i);
  });

  test('idempotent: if encounter already exists for this CallLogId, returns existing', async () => {
    const req = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn(async (sqlText) => {
        if (/FROM oe\.Encounters/i.test(sqlText) && /Source='zoom_phone'/i.test(sqlText)) {
          return { recordset: [{ EncounterId: 'ENC-EXISTING' }] };
        }
        return { recordset: [] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const result = await EncounterService.createFromCallLog(vendorId, callLogId);
    expect(result.EncounterId).toBe('ENC-EXISTING');
  });

  // Helper: build a minimal call-log mock that skips the dedup check and returns
  // the supplied row from VendorCallLogs. Throws if INSERT is attempted.
  function makeSkipReq(row) {
    return {
      input: jest.fn().mockReturnThis(),
      query: jest.fn(async (sqlText) => {
        if (/Source='zoom_phone'/i.test(sqlText)) return { recordset: [] };
        if (/FROM oe\.VendorCallLogs/i.test(sqlText)) return { recordset: [row] };
        throw new Error(`Unexpected SQL (should have returned null before INSERT): ${sqlText.slice(0, 80)}`);
      }),
    };
  }

  const baseRow = {
    CallLogId: 'CL-SKIP',
    VendorId: vendorId,
    CallType: 'Inbound',
    CallStatus: 'Completed',
    CallerName: 'Jane Member',
    CallerNumber: '+13105551212',
    CalleeName: 'Agent',
    CalleeNumber: '+18005550000',
    CallStartTime: new Date(),
    CallDurationSeconds: 60,
    MemberId: null,
    AgentUserId: null,
    AnsweredBy: 'User',
    HasRecording: false,
    RecordingUrl: null,
    TranscriptText: null,
    AISummary: null,
    ZoomAISummary: null,
  };

  test('skips AR-only calls (AnsweredBy=AutoReceptionist)', async () => {
    getPool.mockResolvedValue({ request: () => makeSkipReq({ ...baseRow, AnsweredBy: 'AutoReceptionist' }) });
    expect(await EncounterService.createFromCallLog(vendorId, 'CL-SKIP')).toBeNull();
  });

  test('skips Missed calls', async () => {
    getPool.mockResolvedValue({ request: () => makeSkipReq({ ...baseRow, CallType: 'Missed', CallDurationSeconds: 0 }) });
    expect(await EncounterService.createFromCallLog(vendorId, 'CL-SKIP')).toBeNull();
  });

  test('skips Voicemail calls', async () => {
    getPool.mockResolvedValue({ request: () => makeSkipReq({ ...baseRow, CallType: 'Voicemail', CallDurationSeconds: 30 }) });
    expect(await EncounterService.createFromCallLog(vendorId, 'CL-SKIP')).toBeNull();
  });

  test('skips calls with duration < 10s', async () => {
    getPool.mockResolvedValue({ request: () => makeSkipReq({ ...baseRow, CallDurationSeconds: 7 }) });
    expect(await EncounterService.createFromCallLog(vendorId, 'CL-SKIP')).toBeNull();
  });

  test('skips non-Completed calls (e.g. CallStatus=Pending)', async () => {
    getPool.mockResolvedValue({ request: () => makeSkipReq({ ...baseRow, CallStatus: 'Pending' }) });
    expect(await EncounterService.createFromCallLog(vendorId, 'CL-SKIP')).toBeNull();
  });

  test('missing call log returns null', async () => {
    const req = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn(async (sqlText) => {
        if (/FROM oe\.Encounters/i.test(sqlText) && /Source='zoom_phone'/i.test(sqlText)) return { recordset: [] };
        if (/FROM oe\.VendorCallLogs/i.test(sqlText)) return { recordset: [] };
        return { recordset: [] };
      }),
    };
    getPool.mockResolvedValue({ request: () => req });

    const result = await EncounterService.createFromCallLog(vendorId, 'NONEXISTENT');
    expect(result).toBeNull();
  });
});
