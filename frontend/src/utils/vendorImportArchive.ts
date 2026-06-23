import type { ImportJobRunFile } from '../types/vendor/vendorSftpImport.types';

/** File imported successfully but left on SFTP (no archive path). */
function fileShouldHaveBeenArchived(file: ImportJobRunFile): boolean {
  if (file.archivePath) return false;
  if (file.status === 'failed' || file.status === 'skipped') return false;
  const touched = (file.householdsCreated ?? 0) + (file.householdsUpdated ?? 0)
    + (file.householdsTerminated ?? 0);
  return file.status === 'success' || touched > 0;
}

function archiveFailureMessages(file: ImportJobRunFile): string[] {
  const rowErrors = Array.isArray(file.rowErrors) ? file.rowErrors : [];
  return rowErrors
    .filter((e) => /archive failed/i.test(e.message || ''))
    .map((e) => {
      const msg = String(e.message || '').trim();
      const stripped = msg.replace(/^Archive failed:\s*/i, '').trim();
      return stripped || msg;
    });
}

/** Human-readable reason the file was not moved to archive (null if archived or import failed before archive). */
export function archiveFailureDetail(file: ImportJobRunFile): string | null {
  if (!fileShouldHaveBeenArchived(file)) return null;
  const explicit = archiveFailureMessages(file);
  if (explicit.length) return explicit.join(' — ');
  return 'Archive step did not complete; the file may still be on SFTP.';
}

export function importRowErrorsExcludingArchive(
  file: ImportJobRunFile,
): Array<{ row: number; message: string }> {
  const rowErrors = Array.isArray(file.rowErrors) ? file.rowErrors : [];
  return rowErrors.filter((e) => !/archive failed/i.test(e.message || ''));
}
