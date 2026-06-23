// frontend/src/types/vendor/vendorSftpImport.types.ts

import type { VendorImportRules } from './vendorImportRules.types';

export type SftpAuthType = 'password' | 'privateKey';

export interface SftpConnection {
  connectionId: string;
  vendorId: string;
  displayName: string;
  host: string;
  port: number;
  username: string;
  authType: SftpAuthType;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  baseDirectory: string | null;
  isActive: boolean;
  createdUtc: string;
  modifiedUtc: string;
}

export interface SftpConnectionFormValues {
  displayName: string;
  host: string;
  port: number;
  username: string;
  authType: SftpAuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  baseDirectory?: string;
}

export interface SftpTestResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
}

/** Optional connectionId + form fields sent when testing (saved creds used when secrets blank on edit). */
export interface SftpTestConnectionParams {
  connectionId?: string;
  host?: string;
  port?: number;
  username?: string;
  authType?: SftpAuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export type ImportJobRunStatus =
  | 'running'
  | 'success'
  | 'partial'
  | 'failed'
  | 'no-files'
  | 'skipped';

export interface ImportJob {
  jobId: string;
  vendorId: string;
  connectionId: string;
  connectionName?: string;
  tenantId: string;
  tenantName?: string;
  jobName: string;
  legacyProcessorKey?: string | null;
  subFolderPath: string | null;
  formatSlug: string;
  cronScheduleUtc: string;
  archiveFolder: string;
  notifyEmails: string[];
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnNoFiles: boolean;
  /** When true, import may move an existing household to this job's tenant (dangerous). Default false. */
  allowTenantMove: boolean;
  /** When true, skip entire household if any CSV product row has no vendor pricing map. Default true. */
  skipHouseholdWithUnmappedPlans: boolean;
  isEnabled: boolean;
  isRunning: boolean;
  lastRunAtUtc: string | null;
  lastRunStatus?: ImportJobRunStatus | null;
  createdUtc: string;
  modifiedUtc: string;
}

export interface ImportJobFormValues {
  connectionId: string;
  tenantId: string;
  jobName?: string;
  subFolderPath?: string;
  formatSlug: string;
  cronScheduleUtc: string;
  archiveFolder?: string;
  notifyEmails: string[];
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnNoFiles: boolean;
  allowTenantMove?: boolean;
  skipHouseholdWithUnmappedPlans?: boolean;
}

export interface ImportJobRun {
  runId: string;
  jobId: string;
  vendorId: string;
  tenantId: string;
  triggerType: 'scheduled' | 'manual';
  status: ImportJobRunStatus;
  filesFound: number;
  filesImported: number;
  filesFailed: number;
  householdsCreated: number;
  householdsUpdated: number;
  householdsTerminated: number;
  householdsSkipped: number;
  errorSummary: string | null;
  startedUtc: string;
  completedUtc: string | null;
  files?: ImportJobRunFile[];
}

export interface ImportHouseholdSummary {
  name: string;
  memberId?: string | null;
  action: 'created' | 'updated' | 'moved' | 'skipped';
  plans?: string[];
  unmappedPlans?: string[];
  skipReason?: 'unmapped_plans' | 'tenant_mismatch' | string;
}

export interface ImportJobRunFileImportSummary {
  households?: ImportHouseholdSummary[];
  archivePath?: string | null;
}

export interface ImportJobRunFile {
  fileId: string;
  runId: string;
  jobId: string;
  vendorId: string;
  fileName: string;
  remotePath: string;
  status: 'success' | 'failed' | 'skipped';
  householdsCreated: number;
  householdsUpdated: number;
  householdsTerminated: number;
  householdsSkipped: number;
  rowErrors: Array<{ row: number; message: string }> | null;
  importSummary?: ImportJobRunFileImportSummary | ImportHouseholdSummary[] | null;
  archivePath: string | null;
  processedUtc: string;
}

export interface RunHistoryFilters {
  jobId?: string;
  status?: ImportJobRunStatus;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

export interface RunHistoryPage {
  runs: ImportJobRun[];
  pagination: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
  };
}

export interface TenantOption {
  tenantId: string;
  tenantName: string;
}

export interface FormatPreset {
  slug: string;
  label: string;
  template?: string;
  sortOrder?: number;
  importRules?: VendorImportRules;
  tobaccoCsvColumn?: string;
  tobaccoYesValues?: string[];
}
