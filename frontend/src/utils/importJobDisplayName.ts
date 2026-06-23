import type { ImportJob } from '../types/vendor/vendorSftpImport.types';

/** Human-readable job title — never show raw GUIDs in the UI. */
export function importJobDisplayName(
  job: Pick<ImportJob, 'jobName' | 'tenantName' | 'subFolderPath' | 'legacyProcessorKey' | 'connectionName'>,
): string {
  const trimmed = job.jobName?.trim();
  if (trimmed) return trimmed;
  if (job.tenantName) {
    return job.subFolderPath ? `${job.tenantName} · ${job.subFolderPath}` : job.tenantName;
  }
  if (job.legacyProcessorKey) {
    return job.legacyProcessorKey.replace(/Processor$/i, '');
  }
  if (job.connectionName) return job.connectionName;
  return 'Import job';
}
