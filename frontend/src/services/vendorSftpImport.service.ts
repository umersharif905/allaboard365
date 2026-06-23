// frontend/src/services/vendorSftpImport.service.ts
import { apiService } from './api.service';
import type {
  SftpConnection,
  SftpConnectionFormValues,
  SftpTestResult,
  SftpTestConnectionParams,
  ImportJob,
  ImportJobFormValues,
  ImportJobRun,
  RunHistoryFilters,
  RunHistoryPage,
  TenantOption,
  FormatPreset,
} from '../types/vendor/vendorSftpImport.types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

const SFTP_CONN_BASE = '/api/me/vendor/sftp-connections';
const IMPORT_JOBS_BASE = '/api/me/vendor/import-jobs';
const JOB_RUNS_BASE = '/api/me/vendor/import-job-runs';

/** Map PascalCase fields from API response to camelCase SftpConnection */
function mapConnection(raw: Record<string, unknown>): SftpConnection {
  return {
    connectionId: (raw.ConnectionId ?? raw.connectionId) as string,
    vendorId: (raw.VendorId ?? raw.vendorId) as string,
    displayName: (raw.DisplayName ?? raw.displayName) as string,
    host: (raw.Host ?? raw.host) as string,
    port: (raw.Port ?? raw.port ?? 22) as number,
    username: (raw.Username ?? raw.username) as string,
    authType: (raw.AuthType ?? raw.authType ?? 'password') as SftpConnection['authType'],
    hasPassword: Boolean(raw.HasPassword ?? raw.hasPassword),
    hasPrivateKey: Boolean(raw.HasPrivateKey ?? raw.hasPrivateKey),
    hasPassphrase: Boolean(raw.HasPassphrase ?? raw.hasPassphrase),
    baseDirectory: (raw.BaseDirectory ?? raw.baseDirectory ?? null) as string | null,
    isActive: Boolean(raw.IsActive ?? raw.isActive ?? true),
    createdUtc: (raw.CreatedUtc ?? raw.createdUtc ?? '') as string,
    modifiedUtc: (raw.ModifiedUtc ?? raw.modifiedUtc ?? '') as string,
  };
}

/** Map PascalCase fields from API response to camelCase ImportJob */
function mapJob(raw: Record<string, unknown>): ImportJob {
  const notifyEmails = raw.NotifyEmails ?? raw.notifyEmails;
  let emails: string[] = [];
  if (typeof notifyEmails === 'string') {
    try {
      emails = JSON.parse(notifyEmails);
    } catch {
      emails = notifyEmails.split(',').map((e: string) => e.trim()).filter(Boolean);
    }
  } else if (Array.isArray(notifyEmails)) {
    emails = notifyEmails as string[];
  }

  return {
    jobId: (raw.JobId ?? raw.jobId) as string,
    vendorId: (raw.VendorId ?? raw.vendorId) as string,
    connectionId: (raw.ConnectionId ?? raw.connectionId) as string,
    connectionName: (raw.ConnectionDisplayName ?? raw.connectionDisplayName
      ?? raw.ConnectionName ?? raw.connectionName) as string | undefined,
    tenantId: (raw.TenantId ?? raw.tenantId) as string,
    tenantName: (raw.TenantName ?? raw.tenantName) as string | undefined,
    jobName: (raw.JobName ?? raw.jobName ?? '') as string,
    legacyProcessorKey: (raw.LegacyProcessorKey ?? raw.legacyProcessorKey ?? null) as string | null,
    subFolderPath: (raw.SubFolderPath ?? raw.subFolderPath ?? null) as string | null,
    formatSlug: (raw.FormatSlug ?? raw.formatSlug) as string,
    cronScheduleUtc: (raw.CronScheduleUtc ?? raw.cronScheduleUtc) as string,
    archiveFolder: (raw.ArchiveFolder ?? raw.archiveFolder ?? 'archived') as string,
    notifyEmails: emails,
    notifyOnSuccess: Boolean(raw.NotifyOnSuccess ?? raw.notifyOnSuccess ?? true),
    notifyOnFailure: Boolean(raw.NotifyOnFailure ?? raw.notifyOnFailure ?? true),
    notifyOnNoFiles: Boolean(raw.NotifyOnNoFiles ?? raw.notifyOnNoFiles ?? false),
    allowTenantMove: Boolean(raw.AllowTenantMove ?? raw.allowTenantMove),
    skipHouseholdWithUnmappedPlans: raw.SkipHouseholdWithUnmappedPlans == null
      && raw.skipHouseholdWithUnmappedPlans == null
      ? true
      : Boolean(raw.SkipHouseholdWithUnmappedPlans ?? raw.skipHouseholdWithUnmappedPlans),
    isEnabled: Boolean(raw.IsEnabled ?? raw.isEnabled),
    isRunning: Boolean(raw.IsRunning ?? raw.isRunning),
    lastRunAtUtc: (raw.LastRunAtUtc ?? raw.lastRunAtUtc ?? null) as string | null,
    lastRunStatus: (raw.LastRunStatus ?? raw.lastRunStatus ?? null) as ImportJob['lastRunStatus'],
    createdUtc: (raw.CreatedUtc ?? raw.createdUtc ?? '') as string,
    modifiedUtc: (raw.ModifiedUtc ?? raw.modifiedUtc ?? '') as string,
  };
}

/** Map PascalCase fields to camelCase ImportJobRun */
function mapRun(raw: Record<string, unknown>): ImportJobRun {
  return {
    runId: (raw.RunId ?? raw.runId) as string,
    jobId: (raw.JobId ?? raw.jobId) as string,
    vendorId: (raw.VendorId ?? raw.vendorId) as string,
    tenantId: (raw.TenantId ?? raw.tenantId) as string,
    triggerType: (raw.TriggerType ?? raw.triggerType ?? 'scheduled') as ImportJobRun['triggerType'],
    status: (raw.Status ?? raw.status) as ImportJobRun['status'],
    filesFound: (raw.FilesFound ?? raw.filesFound ?? 0) as number,
    filesImported: (raw.FilesImported ?? raw.filesImported ?? 0) as number,
    filesFailed: (raw.FilesFailed ?? raw.filesFailed ?? 0) as number,
    householdsCreated: (raw.HouseholdsCreated ?? raw.householdsCreated ?? 0) as number,
    householdsUpdated: (raw.HouseholdsUpdated ?? raw.householdsUpdated ?? 0) as number,
    householdsTerminated: (raw.HouseholdsTerminated ?? raw.householdsTerminated ?? 0) as number,
    householdsSkipped: (raw.HouseholdsSkipped ?? raw.householdsSkipped ?? 0) as number,
    errorSummary: (raw.ErrorSummary ?? raw.errorSummary ?? null) as string | null,
    startedUtc: (raw.StartedUtc ?? raw.startedUtc ?? '') as string,
    completedUtc: (raw.CompletedUtc ?? raw.completedUtc ?? null) as string | null,
    files: Array.isArray(raw.files ?? raw.Files)
      ? ((raw.files ?? raw.Files) as Record<string, unknown>[]).map(mapRunFile)
      : undefined,
  };
}

function mapRunFile(raw: Record<string, unknown>) {
  let rowErrors = null;
  const re = raw.RowErrors ?? raw.rowErrors;
  if (typeof re === 'string') {
    try { rowErrors = JSON.parse(re); } catch { rowErrors = null; }
  } else if (Array.isArray(re)) {
    rowErrors = re;
  }
  let importSummary = null;
  const is = raw.ImportSummary ?? raw.importSummary;
  if (typeof is === 'string') {
    try { importSummary = JSON.parse(is); } catch { importSummary = null; }
  } else if (is && typeof is === 'object') {
    importSummary = is;
  }
  return {
    fileId: (raw.FileId ?? raw.fileId) as string,
    runId: (raw.RunId ?? raw.runId) as string,
    jobId: (raw.JobId ?? raw.jobId) as string,
    vendorId: (raw.VendorId ?? raw.vendorId) as string,
    fileName: (raw.FileName ?? raw.fileName) as string,
    remotePath: (raw.RemotePath ?? raw.remotePath) as string,
    status: (raw.Status ?? raw.status) as 'success' | 'failed' | 'skipped',
    householdsCreated: (raw.HouseholdsCreated ?? raw.householdsCreated ?? 0) as number,
    householdsUpdated: (raw.HouseholdsUpdated ?? raw.householdsUpdated ?? 0) as number,
    householdsTerminated: (raw.HouseholdsTerminated ?? raw.householdsTerminated ?? 0) as number,
    householdsSkipped: (raw.HouseholdsSkipped ?? raw.householdsSkipped ?? 0) as number,
    rowErrors,
    importSummary,
    archivePath: (raw.ArchivePath ?? raw.archivePath ?? null) as string | null,
    processedUtc: (raw.ProcessedUtc ?? raw.processedUtc ?? '') as string,
  };
}

export const vendorSftpImportService = {
  // ── SFTP Connections ──────────────────────────────────────────────
  listConnections: async (): Promise<SftpConnection[]> => {
    const res = await apiService.get<ApiResponse<Record<string, unknown>[]>>(SFTP_CONN_BASE);
    if (!res.success) throw new Error(res.message || 'Failed to load connections');
    return (res.data ?? []).map(mapConnection);
  },

  getConnection: async (connectionId: string): Promise<SftpConnection> => {
    const res = await apiService.get<ApiResponse<Record<string, unknown>>>(`${SFTP_CONN_BASE}/${connectionId}`);
    if (!res.success) throw new Error(res.message || 'Failed to load connection');
    return mapConnection(res.data);
  },

  createConnection: async (body: SftpConnectionFormValues): Promise<SftpConnection> => {
    const res = await apiService.post<ApiResponse<Record<string, unknown>>>(SFTP_CONN_BASE, body);
    if (!res.success) throw new Error(res.message || 'Failed to create connection');
    return mapConnection(res.data);
  },

  updateConnection: async (connectionId: string, body: Partial<SftpConnectionFormValues>): Promise<SftpConnection> => {
    const res = await apiService.put<ApiResponse<Record<string, unknown>>>(`${SFTP_CONN_BASE}/${connectionId}`, body);
    if (!res.success) throw new Error(res.message || 'Failed to update connection');
    return mapConnection(res.data);
  },

  deleteConnection: async (connectionId: string): Promise<void> => {
    const res = await apiService.delete<ApiResponse<null>>(`${SFTP_CONN_BASE}/${connectionId}`);
    if (!res.success) throw new Error(res.message || 'Failed to delete connection');
  },

  testConnection: async (params: SftpTestConnectionParams): Promise<SftpTestResult> => {
    const { connectionId, ...body } = params;
    const url = connectionId ? `${SFTP_CONN_BASE}/${connectionId}/test` : `${SFTP_CONN_BASE}/test`;
    const res = await apiService.post<ApiResponse<SftpTestResult>>(url, body);
    if (!res.success) throw new Error(res.message || 'Test failed');
    return res.data ?? { success: false, error: res.message };
  },

  // ── Import Jobs ───────────────────────────────────────────────────
  listJobs: async (): Promise<ImportJob[]> => {
    const res = await apiService.get<ApiResponse<Record<string, unknown>[]>>(IMPORT_JOBS_BASE);
    if (!res.success) throw new Error(res.message || 'Failed to load jobs');
    return (res.data ?? []).map(mapJob);
  },

  getJob: async (jobId: string): Promise<ImportJob> => {
    const res = await apiService.get<ApiResponse<Record<string, unknown>>>(`${IMPORT_JOBS_BASE}/${jobId}`);
    if (!res.success) throw new Error(res.message || 'Failed to load job');
    return mapJob(res.data);
  },

  createJob: async (body: ImportJobFormValues): Promise<ImportJob> => {
    const res = await apiService.post<ApiResponse<Record<string, unknown>>>(IMPORT_JOBS_BASE, body);
    if (!res.success) throw new Error(res.message || 'Failed to create job');
    return mapJob(res.data);
  },

  updateJob: async (jobId: string, body: Partial<ImportJobFormValues>): Promise<ImportJob> => {
    const res = await apiService.put<ApiResponse<Record<string, unknown>>>(`${IMPORT_JOBS_BASE}/${jobId}`, body);
    if (!res.success) throw new Error(res.message || 'Failed to update job');
    return mapJob(res.data);
  },

  deleteJob: async (jobId: string): Promise<void> => {
    const res = await apiService.delete<ApiResponse<null>>(`${IMPORT_JOBS_BASE}/${jobId}`);
    if (!res.success) throw new Error(res.message || 'Failed to delete job');
  },

  setJobEnabled: async (jobId: string, enabled: boolean): Promise<void> => {
    const res = await apiService.patch<ApiResponse<unknown>>(`${IMPORT_JOBS_BASE}/${jobId}/enable`, { enabled });
    if (!res.success) throw new Error(res.message || 'Failed to update job status');
  },

  runJobNow: async (jobId: string): Promise<{ runId: string }> => {
    const res = await apiService.post<ApiResponse<{ runId: string }>>(`${IMPORT_JOBS_BASE}/${jobId}/run-now`, {});
    if (!res.success) throw new Error(res.message || 'Failed to trigger run');
    return res.data;
  },

  cancelJobRun: async (jobId: string): Promise<{ cancelledRuns: number }> => {
    const res = await apiService.post<ApiResponse<{ cancelledRuns: number }>>(
      `${IMPORT_JOBS_BASE}/${jobId}/cancel-run`,
      {}
    );
    if (!res.success) throw new Error(res.message || 'Failed to stop run');
    return res.data ?? { cancelledRuns: 0 };
  },

  // ── Run History ───────────────────────────────────────────────────
  listRuns: async (filters: RunHistoryFilters = {}): Promise<RunHistoryPage> => {
    const params = new URLSearchParams();
    if (filters.jobId) params.set('jobId', filters.jobId);
    if (filters.status) params.set('status', filters.status);
    if (filters.fromDate) params.set('fromDate', filters.fromDate);
    if (filters.toDate) params.set('toDate', filters.toDate);
    if (filters.page) params.set('page', String(filters.page));
    if (filters.limit) params.set('limit', String(filters.limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    type ListRunsResponse = ApiResponse<Record<string, unknown>[]> & {
      pagination?: { page?: number; limit?: number; total?: number; totalCount?: number; totalPages?: number };
    };
    const res = await apiService.get<ListRunsResponse>(`${JOB_RUNS_BASE}${query}`);
    if (!res.success) throw new Error(res.message || 'Failed to load run history');
    const runRows = Array.isArray(res.data) ? res.data : (res.data as { runs?: Record<string, unknown>[] })?.runs ?? [];
    const pag = res.pagination;
    const total = pag?.totalCount ?? pag?.total ?? 0;
    return {
      runs: runRows.map(mapRun),
      pagination: {
        page: pag?.page ?? 1,
        limit: pag?.limit ?? 25,
        totalCount: total,
        totalPages: pag?.totalPages ?? (total ? Math.ceil(total / (pag?.limit ?? 25)) : 0),
      },
    };
  },

  getRun: async (runId: string): Promise<ImportJobRun> => {
    const res = await apiService.get<ApiResponse<Record<string, unknown>>>(`${JOB_RUNS_BASE}/${runId}`);
    if (!res.success) throw new Error(res.message || 'Failed to load run');
    return mapRun(res.data);
  },

  // ── Lookups (reused from existing vendor import routes) ───────────
  listTenants: async (): Promise<TenantOption[]> => {
    const res = await apiService.get<ApiResponse<Array<Record<string, unknown>>>>('/api/me/vendor/import/tenants');
    if (!res.success) throw new Error(res.message || 'Failed to load tenants');
    return (res.data ?? []).map((t) => ({
      tenantId: (t.TenantId ?? t.tenantId) as string,
      tenantName: (t.TenantName ?? t.tenantName) as string,
    }));
  },

  listFormatPresets: async (): Promise<FormatPreset[]> => {
    const res = await apiService.get<ApiResponse<Array<Record<string, unknown>>>>('/api/me/vendor/import/format-presets');
    if (!res.success) throw new Error(res.message || 'Failed to load presets');
    return (res.data ?? []).map((p) => ({
      slug: (p.slug ?? p.Slug) as string,
      label: (p.label ?? p.Label) as string,
    }));
  },
};
