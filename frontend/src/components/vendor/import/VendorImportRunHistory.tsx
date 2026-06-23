import React, { useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import {
  useVendorImportJobRun,
  useVendorImportJobRuns,
} from '../../../hooks/vendor/useVendorImportJobRuns';
import type {
  ImportHouseholdSummary,
  ImportJobRun,
  ImportJobRunFile,
  ImportJobRunStatus,
  RunHistoryFilters,
} from '../../../types/vendor/vendorSftpImport.types';
import {
  formatImportUtcInLocalTime,
  getBrowserTimeZoneShortLabel,
} from './importDisplay';
import {
  archiveFailureDetail,
  importRowErrorsExcludingArchive,
} from '../../../utils/vendorImportArchive';

const STATUS_CLASSES: Record<ImportJobRunStatus, string> = {
  running: 'bg-blue-50 text-blue-700 border-blue-200',
  success: 'bg-green-50 text-green-700 border-green-200',
  partial: 'bg-amber-50 text-amber-700 border-amber-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  'no-files': 'bg-gray-100 text-gray-600 border-gray-200',
  skipped: 'bg-gray-100 text-gray-500 border-gray-200',
};

const STATUS_LABELS: Record<ImportJobRunStatus, string> = {
  running: 'Running',
  success: 'Success',
  partial: 'Partial',
  failed: 'Failed',
  'no-files': 'No files',
  skipped: 'Skipped',
};

const FILE_STATUS_CLASSES: Record<string, string> = {
  success: 'bg-green-50 text-green-700 border-green-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  skipped: 'bg-gray-100 text-gray-500 border-gray-200',
};

const HOUSEHOLD_ACTION_LABELS: Record<string, string> = {
  created: 'Created',
  updated: 'Updated',
  moved: 'Moved tenant',
  skipped: 'Skipped',
};

const SKIP_REASON_LABELS: Record<string, string> = {
  unmapped_plans: 'Unmapped plan in file — household not imported',
  tenant_mismatch: 'Member exists under another tenant — enable “Allow tenant move” in AB365 import options',
};

const StatusBadge: React.FC<{ status: ImportJobRunStatus }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border font-medium ${STATUS_CLASSES[status] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}>
    {status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
    {STATUS_LABELS[status] ?? status}
  </span>
);

function householdsFromFile(file: ImportJobRunFile): ImportHouseholdSummary[] {
  const summary = file.importSummary;
  if (!summary) return [];
  if (Array.isArray(summary)) return summary;
  return summary.households ?? [];
}

const HouseholdSummaryTable: React.FC<{ households: ImportHouseholdSummary[] }> = ({ households }) => {
  if (!households.length) return null;
  const shown = households.slice(0, 100);
  const more = households.length - shown.length;

  return (
    <div className="mt-2 overflow-x-auto max-h-64 overflow-y-auto border border-gray-100 rounded">
      <table className="w-full text-left text-xs">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            <th className="px-2 py-1.5 font-medium text-gray-500">Member</th>
            <th className="px-2 py-1.5 font-medium text-gray-500">ID</th>
            <th className="px-2 py-1.5 font-medium text-gray-500">Action</th>
            <th className="px-2 py-1.5 font-medium text-gray-500">Plans</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {shown.map((h, i) => (
            <tr key={`${h.memberId ?? h.name}-${i}`} className="hover:bg-gray-50">
              <td className="px-2 py-1 text-gray-800 whitespace-nowrap">{h.name || '—'}</td>
              <td className="px-2 py-1 font-mono text-gray-500 whitespace-nowrap">{h.memberId || '—'}</td>
              <td className="px-2 py-1 whitespace-nowrap">
                <span className={h.action === 'skipped' ? 'text-gray-500' : 'text-gray-700'}>
                  {HOUSEHOLD_ACTION_LABELS[h.action] ?? h.action}
                </span>
                {h.skipReason && (
                  <span className="block text-amber-700 mt-0.5 max-w-xs">
                    {SKIP_REASON_LABELS[h.skipReason] ?? h.skipReason}
                  </span>
                )}
              </td>
              <td className="px-2 py-1 text-gray-700">
                {(h.plans?.length ?? 0) > 0 ? h.plans!.join(', ') : '—'}
                {(h.unmappedPlans?.length ?? 0) > 0 && (
                  <span className="block text-amber-700 mt-0.5">
                    Unmapped: {h.unmappedPlans!.join(', ')}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && (
        <p className="px-2 py-1 text-xs text-gray-400 border-t border-gray-100">
          +{more} more household{more !== 1 ? 's' : ''} (showing first 100)
        </p>
      )}
    </div>
  );
};

const RunFileRow: React.FC<{ file: ImportJobRunFile }> = ({ file }) => {
  const [expanded, setExpanded] = useState(false);
  const statusClass = FILE_STATUS_CLASSES[file.status] ?? 'bg-gray-100 text-gray-500 border-gray-200';
  const households = householdsFromFile(file);
  const archiveIssue = archiveFailureDetail(file);
  const importErrors = importRowErrorsExcludingArchive(file);
  const hasDetail = importErrors.length > 0 || households.length > 0 || Boolean(archiveIssue);

  return (
    <div className="bg-white border border-gray-200 rounded p-3 text-xs">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-medium text-gray-800">{file.fileName}</span>
            <span className={`px-1.5 py-0.5 rounded border text-xs ${statusClass}`}>{file.status}</span>
          </div>
          <div className="flex flex-wrap gap-3 mt-1 text-gray-500">
            {file.householdsCreated > 0 && <span>{file.householdsCreated} created</span>}
            {file.householdsUpdated > 0 && <span>{file.householdsUpdated} updated</span>}
            {file.householdsTerminated > 0 && <span className="text-amber-700">{file.householdsTerminated} termed</span>}
            {file.householdsSkipped > 0 && <span>{file.householdsSkipped} skipped</span>}
            {file.archivePath && <span className="text-gray-400">Archived → {file.archivePath}</span>}
          </div>
          {archiveIssue && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-amber-950">
              <p className="font-medium">Imported but not moved to archive</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words">{archiveIssue}</p>
            </div>
          )}
          {households.length > 0 && !expanded && (
            <p className="mt-1 text-gray-500">{households.length} household{households.length !== 1 ? 's' : ''} processed</p>
          )}
        </div>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-gray-600 hover:underline whitespace-nowrap flex-shrink-0"
          >
            {expanded ? 'Hide details' : 'Show details'}
            {expanded ? <ChevronDown className="inline h-3 w-3 ml-1" /> : <ChevronRight className="inline h-3 w-3 ml-1" />}
          </button>
        )}
      </div>
      {expanded && (
        <>
          <HouseholdSummaryTable households={households} />
          {importErrors.length > 0 && (
            <div className="mt-2 bg-red-50 border border-red-100 rounded p-2 space-y-0.5">
              <p className="text-xs font-medium text-red-900 mb-1">Import errors</p>
              {importErrors.map((err, i) => (
                <div key={i} className="text-red-700">
                  {err.row > 0 ? `Row ${err.row}: ` : ''}{err.message}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const RunRow: React.FC<{ run: ImportJobRun }> = ({ run }) => {
  const [expanded, setExpanded] = useState(false);
  const { data: runDetail, isLoading: detailLoading } = useVendorImportJobRun(
    expanded ? run.runId : null
  );
  const displayRun = runDetail ?? run;
  const files = displayRun.files ?? [];

  const errorBannerClass =
    displayRun.status === 'running'
      ? 'bg-blue-50 border-blue-200 text-blue-800'
      : displayRun.status === 'partial'
        ? 'bg-amber-50 border-amber-200 text-amber-800'
        : 'bg-red-50 border-red-200 text-red-700';

  return (
    <>
      <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {formatImportUtcInLocalTime(run.startedUtc)}
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <StatusBadge status={run.status} />
        </td>
        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
          {run.triggerType === 'manual' ? 'Manual' : 'Scheduled'}
        </td>
        <td className="px-4 py-3 text-xs text-gray-700 whitespace-nowrap">
          {run.status === 'running' && run.errorSummary ? (
            <span className="text-blue-700">{run.errorSummary}</span>
          ) : (
            <>
              {run.filesFound} found / {run.filesImported} imported
              {run.filesFailed > 0 && <span className="text-red-600 ml-1">({run.filesFailed} failed)</span>}
            </>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
          {run.householdsCreated > 0 && <span className="mr-2">{run.householdsCreated} created</span>}
          {run.householdsUpdated > 0 && <span className="mr-2">{run.householdsUpdated} updated</span>}
          {run.householdsTerminated > 0 && <span className="text-amber-700 mr-2">{run.householdsTerminated} termed</span>}
        </td>
        <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
          {formatImportUtcInLocalTime(run.completedUtc)}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="px-4 pb-4 bg-gray-50 border-b border-gray-100">
            {displayRun.errorSummary && (
              <div className={`flex items-start gap-2 p-2.5 mb-2 rounded text-xs border ${errorBannerClass}`}>
                {displayRun.status === 'running' ? (
                  <Loader2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 animate-spin" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                )}
                <span className="whitespace-pre-wrap">{displayRun.errorSummary}</span>
              </div>
            )}
            {detailLoading && (
              <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading file details…
              </div>
            )}
            {!detailLoading && files.length > 0 ? (
              <div className="space-y-2 mt-2">
                {files.map((f) => (
                  <RunFileRow key={f.fileId} file={f} />
                ))}
              </div>
            ) : !detailLoading ? (
              <p className="text-xs text-gray-400 py-2">No file details available.</p>
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
};

interface Props {
  filters?: RunHistoryFilters;
  jobName?: string;
}

const VendorImportRunHistory: React.FC<Props> = ({ filters: initialFilters = {}, jobName }) => {
  const [filters, setFilters] = useState<RunHistoryFilters>(initialFilters);
  const localTzLabel = getBrowserTimeZoneShortLabel();

  const { data, isLoading, isError } = useVendorImportJobRuns(filters);
  const runs = data?.runs ?? [];
  const pagination = data?.pagination;

  const updateFilter = <K extends keyof RunHistoryFilters>(key: K, value: RunHistoryFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value, page: 1 }));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {jobName && (
          <span className="text-sm font-medium text-gray-700">
            Run history — <span className="font-semibold">{jobName}</span>
          </span>
        )}
        <select
          className="border border-gray-300 rounded px-2 py-1 text-xs"
          value={filters.status ?? ''}
          onChange={(e) => updateFilter('status', (e.target.value as ImportJobRunStatus) || undefined)}
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="success">Success</option>
          <option value="partial">Partial</option>
          <option value="failed">Failed</option>
          <option value="no-files">No files</option>
          <option value="skipped">Skipped</option>
        </select>
        <input
          type="date"
          className="border border-gray-300 rounded px-2 py-1 text-xs"
          value={filters.fromDate ?? ''}
          onChange={(e) => updateFilter('fromDate', e.target.value || undefined)}
          title="From date"
        />
        <input
          type="date"
          className="border border-gray-300 rounded px-2 py-1 text-xs"
          value={filters.toDate ?? ''}
          onChange={(e) => updateFilter('toDate', e.target.value || undefined)}
          title="To date"
        />
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading run history…
        </div>
      )}
      {isError && (
        <div className="flex items-center gap-2 text-sm text-red-600 py-4">
          <AlertCircle className="h-4 w-4" /> Failed to load run history.
        </div>
      )}

      {!isLoading && !isError && runs.length === 0 && (
        <div className="text-center py-10 border border-dashed border-gray-300 rounded-lg">
          <CalendarClock className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No runs yet.</p>
        </div>
      )}

      {runs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Started ({localTzLabel})</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Trigger</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Files</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Households</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Completed ({localTzLabel})</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((run) => (
                <RunRow key={run.runId} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{pagination.totalCount} total runs</span>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => setFilters((p) => ({ ...p, page: (p.page ?? 1) - 1 }))}
              className="px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="px-2 py-1">
              {pagination.page} / {pagination.totalPages}
            </span>
            <button
              type="button"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setFilters((p) => ({ ...p, page: (p.page ?? 1) + 1 }))}
              className="px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VendorImportRunHistory;
