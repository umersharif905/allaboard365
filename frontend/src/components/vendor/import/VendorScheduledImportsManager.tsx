import React, { useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  useVendorImportJobs,
  useDeleteImportJob,
  useSetImportJobEnabled,
  useRunImportJobNow,
  useCancelImportJobRun,
} from '../../../hooks/vendor/useVendorImportJobs';
import { useVendorImportJobRun } from '../../../hooks/vendor/useVendorImportJobRuns';
import VendorImportJobModal from './VendorImportJobModal';
import VendorImportRunHistory from './VendorImportRunHistory';
import type { ImportJob, ImportJobRunStatus } from '../../../types/vendor/vendorSftpImport.types';
import { importJobDisplayName } from '../../../utils/importJobDisplayName';
import { formatScheduleSummary } from '../../../utils/vendorImportJobSchedule';
import { formatImportUtcInLocalTime } from './importDisplay';

const LAST_RUN_STATUS_CLASSES: Record<ImportJobRunStatus, string> = {
  running: 'bg-blue-50 text-blue-700 border-blue-200',
  success: 'bg-green-50 text-green-700 border-green-200',
  partial: 'bg-amber-50 text-amber-700 border-amber-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  'no-files': 'bg-gray-100 text-gray-600 border-gray-200',
  skipped: 'bg-gray-100 text-gray-500 border-gray-200',
};

const formatUtcRelative = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const EnableToggle: React.FC<{ job: ImportJob }> = ({ job }) => {
  const setEnabled = useSetImportJobEnabled();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={job.isEnabled}
      onClick={(e) => {
        e.stopPropagation();
        setEnabled.mutate({ jobId: job.jobId, enabled: !job.isEnabled });
      }}
      disabled={setEnabled.isPending}
      title={job.isEnabled ? 'Disable job' : 'Enable job'}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
        job.isEnabled ? 'bg-oe-primary' : 'bg-gray-300'
      } ${setEnabled.isPending ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          job.isEnabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
};

const JobRow: React.FC<{
  job: ImportJob;
  onEdit: (job: ImportJob) => void;
  onDelete: (job: ImportJob) => void;
  onRunNow: (job: ImportJob) => void;
}> = ({ job, onEdit, onDelete, onRunNow }) => {
  const [historyOpen, setHistoryOpen] = useState(false);
  const runNowMutation = useRunImportJobNow();
  const cancelMutation = useCancelImportJobRun();
  const appearsRunning = job.isRunning || job.lastRunStatus === 'running';

  const handleRunNow = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRunNow(job);
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    cancelMutation.mutate(job.jobId);
  };

  return (
    <>
      <tr className="hover:bg-gray-50">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="text-gray-400 hover:text-gray-600"
              aria-label="Toggle run history"
            >
              {historyOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            <div>
              <div className="text-sm font-medium text-gray-900">
                {importJobDisplayName(job)}
              </div>
              <div className="text-xs text-gray-500">
                {job.connectionName ?? 'SFTP connection'}
                {job.subFolderPath ? ` · ${job.subFolderPath}` : ''}
                {' · '}{job.formatSlug}
              </div>
            </div>
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="text-sm text-gray-800">{formatScheduleSummary(job.cronScheduleUtc)}</div>
          <code className="text-xs text-gray-400 font-mono">{job.cronScheduleUtc}</code>
        </td>
        <td className="px-4 py-3 text-center">
          <EnableToggle job={job} />
        </td>
        <td className="px-4 py-3">
          {job.lastRunAtUtc ? (
            <div className="text-xs text-gray-500">
              <div>{formatImportUtcInLocalTime(job.lastRunAtUtc)}</div>
              {formatUtcRelative(job.lastRunAtUtc) && (
                <div className="text-gray-400">{formatUtcRelative(job.lastRunAtUtc)}</div>
              )}
              {job.lastRunStatus && (
                <span className={`ml-2 px-1.5 py-0.5 rounded border text-xs font-medium ${LAST_RUN_STATUS_CLASSES[job.lastRunStatus] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                  {job.lastRunStatus}
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-gray-400">Never</span>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1">
            {appearsRunning ? (
              <button
                type="button"
                onClick={handleStop}
                disabled={cancelMutation.isPending}
                title="Stop run and clear lock"
                className="p-1.5 text-amber-700 hover:bg-amber-50 rounded disabled:opacity-50"
              >
                {cancelMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4 fill-current" />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleRunNow}
                disabled={runNowMutation.isPending}
                title="Run Now"
                className="p-1.5 text-oe-primary hover:bg-oe-light rounded disabled:opacity-50"
              >
                {runNowMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onEdit(job); }}
              title="Edit"
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(job); }}
              title="Delete"
              className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
      {historyOpen && (
        <tr>
          <td colSpan={5} className="bg-gray-50 px-6 pb-4 border-b border-gray-100">
            <div className="pt-3">
              <VendorImportRunHistory
                filters={{ jobId: job.jobId }}
                jobName={importJobDisplayName(job)}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

const VendorScheduledImportsManager: React.FC = () => {
  const { data: jobs = [], isLoading, isError } = useVendorImportJobs();
  const deleteMutation = useDeleteImportJob();
  const runNowMutation = useRunImportJobNow();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<ImportJob | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ImportJob | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [runNowResult, setRunNowResult] = useState<{ jobId: string; runId: string } | null>(null);
  const { data: activeRun } = useVendorImportJobRun(runNowResult?.runId ?? null);

  const handleAdd = () => { setEditingJob(null); setModalOpen(true); };
  const handleEdit = (job: ImportJob) => { setEditingJob(job); setModalOpen(true); };

  const handleRunNow = async (job: ImportJob) => {
    try {
      const { runId } = await runNowMutation.mutateAsync(job.jobId);
      setRunNowResult({ jobId: job.jobId, runId });
    } catch {
      // surfaced via mutation error state
    }
  };

  // Clear banner once the polled run finishes
  React.useEffect(() => {
    if (activeRun && activeRun.status !== 'running' && runNowResult) {
      const t = setTimeout(() => setRunNowResult(null), 8000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [activeRun?.status, runNowResult]);

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(deleteTarget.jobId);
      setDeleteTarget(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading scheduled imports…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600 py-4">
        <AlertCircle className="h-4 w-4" /> Failed to load scheduled import jobs.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Scheduled Imports</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Recurring jobs that pull CSV files from SFTP on a cron schedule and import them automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-oe-primary hover:bg-oe-dark text-white rounded-lg"
        >
          <Plus className="h-4 w-4" /> Add job
        </button>
      </div>

      {runNowResult && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg text-sm border ${
            activeRun?.status === 'running'
              ? 'bg-blue-50 border-blue-200 text-blue-900'
              : activeRun?.status === 'success' || activeRun?.status === 'no-files'
                ? 'bg-green-50 border-green-200 text-green-800'
                : activeRun?.status === 'partial'
                  ? 'bg-amber-50 border-amber-200 text-amber-900'
                  : activeRun?.status === 'failed'
                    ? 'bg-red-50 border-red-200 text-red-800'
                    : 'bg-gray-50 border-gray-200 text-gray-800'
          }`}
        >
          {activeRun?.status === 'running' ? (
            <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin mt-0.5" />
          ) : (
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            {activeRun?.status === 'running' ? (
              <>
                <div className="font-medium">Import in progress…</div>
                {activeRun.errorSummary && (
                  <div className="text-xs mt-0.5 opacity-90">{activeRun.errorSummary}</div>
                )}
                {(activeRun.filesFound > 0 || activeRun.filesImported > 0) && (
                  <div className="text-xs mt-0.5">
                    {activeRun.filesFound} file(s) found
                    {activeRun.filesImported > 0 ? ` · ${activeRun.filesImported} imported` : ''}
                    {activeRun.householdsCreated > 0 ? ` · ${activeRun.householdsCreated} households created` : ''}
                  </div>
                )}
              </>
            ) : activeRun ? (
              <>
                <div className="font-medium">
                  Run finished: {activeRun.status}
                  {activeRun.filesImported > 0 ? ` · ${activeRun.filesImported} file(s) imported` : ''}
                </div>
                {activeRun.completedUtc && (
                  <div className="text-xs mt-0.5 opacity-90">
                    Completed {formatImportUtcInLocalTime(activeRun.completedUtc)}
                  </div>
                )}
                {activeRun.errorSummary && activeRun.status !== 'success' && (
                  <div className="text-xs mt-0.5 whitespace-pre-wrap">{activeRun.errorSummary}</div>
                )}
              </>
            ) : (
              <div className="font-medium">Run started — loading status…</div>
            )}
            <p className="text-xs mt-1 opacity-75">Expand the job row below for full run history.</p>
          </div>
          <button type="button" onClick={() => setRunNowResult(null)} className="ml-2 opacity-60 hover:opacity-100">
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-gray-300 rounded-lg">
          <CalendarClock className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No scheduled import jobs configured yet.</p>
          <button type="button" onClick={handleAdd} className="mt-3 text-sm text-oe-primary hover:underline">
            Create your first job
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Job</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Schedule (UTC)</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide text-center">Enabled</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Last run</th>
                <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map((job) => (
                <JobRow
                  key={job.jobId}
                  job={job}
                  onEdit={handleEdit}
                  onDelete={(j) => { setDeleteTarget(j); setDeleteError(null); }}
                  onRunNow={(j) => void handleRunNow(j)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-base font-semibold text-gray-900">Delete import job?</h3>
            <p className="text-sm text-gray-600">
              This will permanently delete the job and all associated run history records.
              {deleteTarget.isRunning && (
                <span className="block mt-1 text-red-600 font-medium">This job is currently running — delete is blocked.</span>
              )}
            </p>
            {deleteError && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" /> {deleteError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteConfirm()}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <VendorImportJobModal
        isOpen={modalOpen}
        job={editingJob}
        onClose={() => { setModalOpen(false); setEditingJob(null); }}
      />
    </div>
  );
};

export default VendorScheduledImportsManager;
