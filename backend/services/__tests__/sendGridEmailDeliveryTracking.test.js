/**
 * Tests for sendGridEmailDeliveryTracking.service.js — state machine transitions.
 * Mocks the mssql pool so we assert the SQL shape + which row-count path the
 * handler returned, without hitting a real DB.
 */

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = { input: mockInput, query: mockQuery };

jest.mock('../../config/database', () => ({
  getPool: jest.fn(() => Promise.resolve({ request: () => mockRequest })),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: (n) => `NVarChar(${n || 'default'})`,
    DateTime2: 'DateTime2',
    MAX: 'MAX'
  }
}));

const { applySendGridDeliveryEvent } = require('../sendGridEmailDeliveryTracking.service');

function buildEvent(overrides = {}) {
  return {
    event: 'delivered',
    sg_message_id: 'abc123xyz.recvd-foo-1',
    timestamp: 1712000000,
    ...overrides
  };
}

describe('applySendGridDeliveryEvent', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockInput.mockClear();
    mockQuery.mockResolvedValue({ rowsAffected: [1] });
  });

  test('rejects when event type or sg_message_id is missing', async () => {
    expect(await applySendGridDeliveryEvent({})).toEqual({ ok: false, reason: 'missing_fields' });
    expect(await applySendGridDeliveryEvent({ event: 'delivered' })).toEqual({ ok: false, reason: 'missing_fields' });
    expect(await applySendGridDeliveryEvent({ sg_message_id: 'x' })).toEqual({ ok: false, reason: 'missing_fields' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rejects unknown event types', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'unsubscribe' }));
    expect(res).toEqual({ ok: false, reason: 'not_delivery_event' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('processed event: append-only (no Status change)', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'processed' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('processed');
    const allSql = mockQuery.mock.calls.map(c => c[0]).join('\n');
    expect(allSql).not.toMatch(/SET\s+[^S]*Status\s*=/i);
  });

  test('deferred event: SQL guards Status IN (Sent) only', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'deferred' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('deferred');
    const mhSql = mockQuery.mock.calls.find(c => /UPDATE oe\.MessageHistory/i.test(c[0]))[0];
    expect(mhSql).toMatch(/Status\s*=\s*@st/);
    expect(mhSql).toMatch(/Status\s+IN\s*\(@from0\)/);
    const stBinding = mockInput.mock.calls.find(c => c[0] === 'st');
    const fromBinding = mockInput.mock.calls.find(c => c[0] === 'from0');
    expect(stBinding[2]).toBe('Deferred');
    expect(fromBinding[2]).toBe('Sent');
  });

  test('open event: SQL guards Status IN (Sent, Deferred, Delivered)', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'open' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('open');
    const mhSql = mockQuery.mock.calls.find(c => /UPDATE oe\.MessageHistory/i.test(c[0]))[0];
    expect(mhSql).toMatch(/Status\s+IN\s*\(@from0,@from1,@from2\)/);
    const fromValues = ['from0', 'from1', 'from2'].map(k =>
      mockInput.mock.calls.find(c => c[0] === k)[2]
    );
    expect(fromValues).toEqual(['Sent', 'Deferred', 'Delivered']);
    const stBinding = mockInput.mock.calls.find(c => c[0] === 'st');
    expect(stBinding[2]).toBe('Opened');
  });

  test('delivered event: uses terminal update (keeps Failed semantics)', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'delivered' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('delivered');
    const mhSql = mockQuery.mock.calls.find(c => /UPDATE oe\.MessageHistory/i.test(c[0]))[0];
    expect(mhSql).toMatch(/WHEN @st = N'Delivered' AND Status = N'Failed' THEN Status/);
  });

  test('bounce event: terminal update with Failed', async () => {
    const res = await applySendGridDeliveryEvent(buildEvent({ event: 'bounce' }));
    expect(res.ok).toBe(true);
    expect(res.event).toBe('bounce');
    const stBinding = mockInput.mock.calls.find(c => c[0] === 'st');
    expect(stBinding[2]).toBe('Failed');
  });
});
