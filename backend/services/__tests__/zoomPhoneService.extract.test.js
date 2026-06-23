/**
 * ZoomPhoneService.extractWebhookCall — normalizes Zoom webhook call objects.
 *
 * Pins the behavior the live-call + attribution paths depend on:
 *   - nested caller/callee objects (current Zoom payload shape)
 *   - legacy flat fields (caller_number/callee_number)
 *   - correct "agent party" selection: callee on inbound, caller on outbound
 *
 * Run: npx jest zoomPhoneService.extract
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');

describe('ZoomPhoneService.extractWebhookCall', () => {
  test('nested payload, inbound → agent is the callee', () => {
    const obj = {
      call_id: 'abc',
      duration: 42,
      handup_result: 'Call Connected',
      caller: { phone_number: '+13105551212', name: 'Jane Member' },
      callee: {
        phone_number: '+13235550000',
        name: 'Agent Bob',
        user_id: 'zoomU1',
        email: 'bob@vendor.com',
        extension_number: '102',
      },
    };
    const r = ZoomPhoneService.extractWebhookCall(obj, true);
    expect(r.callId).toBe('abc');
    expect(r.callerNumber).toBe('+13105551212');
    expect(r.calleeNumber).toBe('+13235550000');
    expect(r.durationSeconds).toBe(42);
    expect(r.handupResult).toBe('Call Connected');
    expect(r.agent.userId).toBe('zoomU1');
    expect(r.agent.email).toBe('bob@vendor.com');
    expect(r.agent.extension).toBe('102');
  });

  test('flat legacy payload, outbound → agent is the caller', () => {
    const obj = {
      id: 'xyz',
      caller_number: '+13001112222',
      callee_number: '+14005556666',
      caller_name: 'Agent Caller',
      callee_name: 'Member',
    };
    const r = ZoomPhoneService.extractWebhookCall(obj, false);
    expect(r.callId).toBe('xyz');
    expect(r.callerNumber).toBe('+13001112222');
    expect(r.calleeNumber).toBe('+14005556666');
    expect(r.callerName).toBe('Agent Caller');
    // No nested agent identity in the flat shape
    expect(r.agent.userId).toBeNull();
  });

  test('handles empty object without throwing', () => {
    const r = ZoomPhoneService.extractWebhookCall({}, true);
    expect(r.callId).toBeNull();
    expect(r.callerNumber).toBeNull();
    expect(r.agent).toBeDefined();
  });
});
