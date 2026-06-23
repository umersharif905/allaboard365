/**
 * ZoomPhoneService.classifyAnsweredBy — derives who/what answered (or was the
 * internal party on) a Zoom call from the raw webhook payload object.
 *
 * Run: npx jest zoomPhoneService.classifyAnsweredBy
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');

describe('ZoomPhoneService.classifyAnsweredBy', () => {
  test('nested inbound payload with user callee → "User"', () => {
    const obj = {
      caller: { phone_number: '+18005551212', extension_type: 'pstn' },
      callee: { user_id: 'zoomU1', extension_type: 'user', extension_number: '102' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('User');
  });

  test('nested inbound payload with autoReceptionist callee → "AutoReceptionist"', () => {
    const obj = {
      caller: { phone_number: '+18005551212', extension_type: 'pstn' },
      callee: { extension_type: 'autoReceptionist', phone_number: '+18002691451', name: 'Main Auto Receptionist' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('AutoReceptionist');
  });

  test('nested inbound payload with callQueue callee → "CallQueue"', () => {
    const obj = {
      caller: { phone_number: '+18005551212' },
      callee: { extension_type: 'callQueue', name: 'Member Care Team' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('CallQueue');
  });

  test('outbound (isInbound=false) reads from caller party', () => {
    const obj = {
      caller: { user_id: 'zoomU1', extension_type: 'user' },
      callee: { phone_number: '+18005551212', extension_type: 'pstn' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, false)).toBe('User');
  });

  test('flat legacy voicemail payload with callee_user_id → "User"', () => {
    const obj = {
      caller_number: '+18005551212',
      callee_user_id: 'zoomU1',
      callee_extension_type: 'user',
      owner: { type: 'user', id: 'zoomU1' },
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('User');
  });

  test('empty object → null', () => {
    expect(ZoomPhoneService.classifyAnsweredBy({}, true)).toBeNull();
  });

  test('sync-API row with callee.extension_type "auto_receptionist" (snake_case) → "AutoReceptionist"', () => {
    const obj = {
      callee: { extension_type: 'auto_receptionist', name: 'Main AR' },
      callee_ext_type: 'auto_receptionist',
    };
    expect(ZoomPhoneService.classifyAnsweredBy(obj, true)).toBe('AutoReceptionist');
  });
});
