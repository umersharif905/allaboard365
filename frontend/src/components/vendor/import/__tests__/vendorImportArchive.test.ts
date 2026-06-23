import { describe, expect, it } from 'vitest';
import { archiveFailureDetail } from '../../../../utils/vendorImportArchive';
import type { ImportJobRunFile } from '../../../../types/vendor/vendorSftpImport.types';

const baseFile = (): ImportJobRunFile => ({
  fileId: 'f1',
  runId: 'r1',
  jobId: 'j1',
  vendorId: 'v1',
  fileName: 'test.csv',
  remotePath: '/test.csv',
  status: 'success',
  householdsCreated: 1,
  householdsUpdated: 0,
  householdsTerminated: 0,
  householdsSkipped: 0,
  rowErrors: null,
  archivePath: null,
  processedUtc: '2026-06-01T12:00:00Z',
});

describe('archiveFailureDetail', () => {
  it('returns stripped server message from rowErrors', () => {
    expect(archiveFailureDetail({
      ...baseFile(),
      rowErrors: [{ row: 0, message: 'Archive failed: EACCES permission denied' }],
    })).toBe('EACCES permission denied');
  });

  it('returns null when archived', () => {
    expect(archiveFailureDetail({
      ...baseFile(),
      archivePath: '/ALIGN/archived/test.csv',
    })).toBeNull();
  });

  it('returns null when import failed before archive', () => {
    expect(archiveFailureDetail({
      ...baseFile(),
      status: 'failed',
      householdsCreated: 0,
      rowErrors: [{ row: 0, message: 'Connection reset' }],
    })).toBeNull();
  });
});
