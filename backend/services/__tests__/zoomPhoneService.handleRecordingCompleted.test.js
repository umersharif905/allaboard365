/**
 * ZoomPhoneService.handleRecordingCompleted — recording webhook handler.
 *
 * Pins:
 *   - reads recordings[] array shape (current Zoom Phone payload)
 *   - falls back to flat download_url/recording_url for legacy/voicemail
 *   - updates VendorCallLogs by ExternalCallId
 *
 * Run: npx jest zoomPhoneService.handleRecordingCompleted
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn(),
}));

const ZoomPhoneService = require('../zoomPhoneService');
const { getPool } = require('../../config/database');

function makePool({ updateResult = { recordset: [{ CallLogId: 'cl-1' }] } } = {}) {
  const captured = {};
  const req = {
    input: jest.fn(function (k, _t, v) { captured[k] = v; return this; }),
    query: jest.fn(async () => updateResult),
  };
  getPool.mockResolvedValue({ request: () => req });
  return { captured };
}

describe('ZoomPhoneService.handleRecordingCompleted', () => {
  const vendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

  beforeEach(() => {
    jest.spyOn(ZoomPhoneService, 'mirrorCallLogToEncounter').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('current Zoom shape: recordings[] array → uses first recording', async () => {
    const { captured } = makePool();
    const payload = {
      object: {
        call_id: 'call-123',
        recordings: [
          { download_url: 'https://zoom.us/dl/abc', duration: 42, id: 'rec-1' },
        ],
      },
    };
    const r = await ZoomPhoneService.handleRecordingCompleted(vendorId, payload);
    expect(r.handled).toBe(true);
    expect(captured.recordingUrl).toBe('https://zoom.us/dl/abc');
    expect(captured.duration).toBe(42);
    expect(captured.externalCallId).toBe('call-123');
  });

  test('legacy flat shape: download_url at object level (voicemail-style)', async () => {
    const { captured } = makePool();
    const payload = {
      object: {
        call_id: 'call-legacy',
        download_url: 'https://zoom.us/dl/legacy',
        duration: 10,
      },
    };
    const r = await ZoomPhoneService.handleRecordingCompleted(vendorId, payload);
    expect(r.handled).toBe(true);
    expect(captured.recordingUrl).toBe('https://zoom.us/dl/legacy');
    expect(captured.duration).toBe(10);
  });

  test('recordings[] empty array → still updates HasRecording flag false, no URL', async () => {
    const { captured } = makePool();
    const payload = {
      object: { call_id: 'call-empty', recordings: [] },
    };
    const r = await ZoomPhoneService.handleRecordingCompleted(vendorId, payload);
    // We do update the row (so we don't lose the event), but URL stays null
    expect(r.handled).toBe(true);
    expect(captured.recordingUrl).toBeNull();
  });

  test('payload missing call_id but has call_log_id → uses fallback', async () => {
    const { captured } = makePool();
    const payload = {
      object: {
        call_log_id: 'cl-fallback',
        recordings: [{ download_url: 'https://zoom.us/dl/x', duration: 5 }],
      },
    };
    await ZoomPhoneService.handleRecordingCompleted(vendorId, payload);
    expect(captured.externalCallId).toBe('cl-fallback');
  });
});
