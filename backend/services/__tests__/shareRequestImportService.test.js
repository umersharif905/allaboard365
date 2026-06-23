'use strict';

const {
  mapStatus,
  mapDetermination,
  parseImportDateUtc,
  parseImportDateTimeUtc,
  filterCommitPreviewRows,
  parseSharewellNoteDates,
  resolveShareRequestImportHeader,
} = require('../shareRequestImportService');

describe('shareRequestImportService helpers', () => {
  test('mapStatus normalizes sharewell values', () => {
    expect(mapStatus('In Review')).toBe('In Review');
    expect(mapStatus('completed')).toBe('Completed');
    expect(mapStatus('Complete')).toBe('Completed');
    expect(mapStatus('Intake')).toBe('In Review');
    expect(mapStatus('Other')).toBe('Processing');
    expect(mapStatus('')).toBeNull();
    expect(mapStatus('unknown')).toBe('In Review');
  });

  test('mapDetermination maps Sharewell determination labels', () => {
    expect(mapDetermination('Not Eligible')).toBe('Not Eligible');
    expect(mapDetermination('Eligible')).toBe('Eligible');
    expect(mapDetermination('Pending')).toBe('Pending');
    expect(mapDetermination('Undetermined')).toBe('Undetermined');
    expect(mapDetermination('')).toBe('Pending');
    expect(mapDetermination('some long medical narrative that is not a valid code')).toBe('Undetermined');
  });

  test('parseImportDateUtc parses ISO date-only as UTC midnight', () => {
    const d = parseImportDateUtc('2026-03-22');
    expect(d).not.toBeNull();
    expect(d.toISOString()).toBe('2026-03-22T00:00:00.000Z');
  });

  test('parseSharewellNoteDates extracts earliest note timestamps', () => {
    const dates = parseSharewellNoteDates('03-17-2025 12:04:35 PM - Aliya Sam: follow up');
    expect(dates).toHaveLength(1);
    expect(dates[0].getUTCFullYear()).toBe(2025);
    expect(dates[0].getUTCMonth()).toBe(2);
    expect(dates[0].getUTCDate()).toBe(17);
  });

  test('resolveShareRequestImportHeader infers completed legacy request from notes', () => {
    const bundle = { notes: [], providerBills: [] };
    const sr = {
      id: 'legacy-1',
      status: '',
      create_date: '',
      determination: 'Not Eligible',
      request_name: 'Kaylani Rapp - Gallbladder Removal',
      next_steps: '',
      notes: '04-07-2025 01:42:44 PM - Aliya Sam: Sharing Request is complete.',
      eligibility_notes: '',
      subtype: 'Inpatient Procedure',
      type: 'Regular UA',
    };
    const header = resolveShareRequestImportHeader(sr, 'type-id', bundle, 'legacy-1');
    expect(header.status).toBe('Completed');
    expect(header.determination).toBe('Not Eligible');
    expect(header.submittedDate).not.toBeNull();
    expect(header.submittedDate.getUTCFullYear()).toBe(2025);
    expect(header.completedDate).not.toBeNull();
  });

  test('resolveShareRequestImportHeader uses explicit Sharewell create_date and status', () => {
    const bundle = { notes: [], providerBills: [] };
    const sr = {
      id: 'legacy-2',
      status: 'Complete',
      create_date: 'Wed Apr 02 2025 12:07:13 GMT-0400 (Eastern Daylight Time)',
      determination: 'Eligible',
      request_name: 'Lori Erickson Doctor Visit',
      notes: '',
      next_steps: '',
      eligibility_notes: '',
      subtype: '',
      type: 'Regular UA',
    };
    const header = resolveShareRequestImportHeader(sr, 'type-id', bundle, 'legacy-2');
    expect(header.status).toBe('Completed');
    expect(header.determination).toBe('Eligible');
    expect(header.submittedDate).not.toBeNull();
    expect(header.submittedDate.getUTCFullYear()).toBe(2025);
  });

  test('parseImportDateTimeUtc treats date-only as UTC midnight', () => {
    const d = parseImportDateTimeUtc('2026-05-20');
    expect(d.toISOString()).toBe('2026-05-20T00:00:00.000Z');
  });

  test('loadBundleFromDir parses multiline quoted CSV fields as single rows', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { loadBundleFromDir } = require('../shareRequestImportService');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-import-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ rowCounts: { share_requests: 1 } }));
    fs.writeFileSync(
      path.join(dir, 'share_requests.csv'),
      'id,request_name,notes,status,create_date\r\n'
      + '11111111-1111-1111-1111-111111111111,Test Request,"03-17-2025 12:04:35 PM - Staff:\r\nsecond line of note",,\r\n'
    );
    for (const f of ['providers.csv', 'share_request_provider.csv', 'provider_bills.csv', 'provider_bill_ledger.csv', 'notes.csv']) {
      fs.writeFileSync(path.join(dir, f), 'id\r\n');
    }
    const bundle = loadBundleFromDir(dir);
    expect(bundle.shareRequests).toHaveLength(1);
    expect(bundle.shareRequests[0].id).toBe('11111111-1111-1111-1111-111111111111');
    expect(bundle.shareRequests[0].notes).toContain('second line of note');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('filterCommitPreviewRows includes resync rows when enabled', () => {
    const rows = [
      { legacyId: 'a', action: 'import', memberId: '1' },
      { legacyId: 'b', action: 'resync', memberId: '2', shareRequestId: 'sr-2' },
      { legacyId: 'c', action: 'skip_duplicate' },
    ];
    expect(filterCommitPreviewRows(rows, true)).toHaveLength(2);
    expect(filterCommitPreviewRows(rows, false)).toHaveLength(1);
  });
});
