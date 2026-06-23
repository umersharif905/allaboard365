import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Info, Loader2, Plus, X } from 'lucide-react';
import { useCreateImportJob, useUpdateImportJob } from '../../../hooks/vendor/useVendorImportJobs';
import { vendorSftpImportService } from '../../../services/vendorSftpImport.service';
import type {
  ImportJob,
  ImportJobFormValues,
  SftpConnection,
  TenantOption,
  FormatPreset,
} from '../../../types/vendor/vendorSftpImport.types';
import ImportJobScheduleFields from './ImportJobScheduleFields';

interface Props {
  isOpen: boolean;
  job: ImportJob | null;
  onClose: () => void;
}

const VendorImportJobModal: React.FC<Props> = ({ isOpen, job, onClose }) => {
  const isEdit = !!job;
  const createMutation = useCreateImportJob();
  const updateMutation = useUpdateImportJob();

  const [connections, setConnections] = useState<SftpConnection[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [loadingLookups, setLoadingLookups] = useState(true);

  const [connectionId, setConnectionId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [jobName, setJobName] = useState('');
  const [subFolderPath, setSubFolderPath] = useState('');
  const [formatSlug, setFormatSlug] = useState('');
  const [cronScheduleUtc, setCronScheduleUtc] = useState('');
  const [archiveFolder, setArchiveFolder] = useState('archived');
  const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(true);
  const [notifyOnFailure, setNotifyOnFailure] = useState(true);
  const [notifyOnNoFiles, setNotifyOnNoFiles] = useState(false);
  const [allowTenantMove, setAllowTenantMove] = useState(false);
  const [skipHouseholdWithUnmappedPlans, setSkipHouseholdWithUnmappedPlans] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLookups = useCallback(async () => {
    setLoadingLookups(true);
    try {
      const [conns, tnts, presetsData] = await Promise.all([
        vendorSftpImportService.listConnections(),
        vendorSftpImportService.listTenants(),
        vendorSftpImportService.listFormatPresets(),
      ]);
      setConnections(conns);
      setTenants(tnts);
      setPresets(presetsData);
    } catch {
      // Non-blocking — user can still submit but dropdowns are empty
    } finally {
      setLoadingLookups(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadLookups();
    if (job) {
      setConnectionId(job.connectionId);
      setTenantId(job.tenantId);
      setJobName(job.jobName?.trim() || job.tenantName || '');
      setSubFolderPath(job.subFolderPath ?? '');
      setFormatSlug(job.formatSlug);
      setCronScheduleUtc(job.cronScheduleUtc);
      setArchiveFolder(job.archiveFolder);
      setNotifyEmails(job.notifyEmails ?? []);
      setNotifyOnSuccess(job.notifyOnSuccess);
      setNotifyOnFailure(job.notifyOnFailure);
      setNotifyOnNoFiles(job.notifyOnNoFiles);
      setAllowTenantMove(job.allowTenantMove);
      setSkipHouseholdWithUnmappedPlans(job.skipHouseholdWithUnmappedPlans);
    } else {
      setConnectionId('');
      setTenantId('');
      setJobName('');
      setSubFolderPath('');
      setFormatSlug('');
      setCronScheduleUtc('0 0 14 * * *');
      setArchiveFolder('archived');
      setNotifyEmails([]);
      setNotifyOnSuccess(true);
      setNotifyOnFailure(true);
      setNotifyOnNoFiles(false);
      setAllowTenantMove(false);
      setSkipHouseholdWithUnmappedPlans(true);
    }
    setEmailInput('');
    setError(null);
  }, [isOpen, job, loadLookups]);

  if (!isOpen) return null;

  const addEmail = () => {
    const trimmed = emailInput.trim().toLowerCase();
    if (!trimmed || notifyEmails.includes(trimmed)) { setEmailInput(''); return; }
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(trimmed)) { setError('Invalid email address: ' + trimmed); return; }
    setNotifyEmails((prev) => [...prev, trimmed]);
    setEmailInput('');
    setError(null);
  };

  const removeEmail = (email: string) => {
    setNotifyEmails((prev) => prev.filter((e) => e !== email));
  };

  const handleEmailKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addEmail(); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (notifyEmails.length === 0) {
      setError('At least one notification email is required.');
      return;
    }
    if (!cronScheduleUtc.trim()) {
      setError('Schedule is required.');
      return;
    }
    const body: ImportJobFormValues = {
      connectionId,
      tenantId,
      jobName: jobName.trim() || undefined,
      subFolderPath: subFolderPath.trim() || undefined,
      formatSlug,
      cronScheduleUtc: cronScheduleUtc.trim(),
      archiveFolder: archiveFolder.trim() || 'archived',
      notifyEmails,
      notifyOnSuccess,
      notifyOnFailure,
      notifyOnNoFiles,
      allowTenantMove,
      skipHouseholdWithUnmappedPlans,
    };
    try {
      if (isEdit && job) {
        await updateMutation.mutateAsync({ jobId: job.jobId, body });
      } else {
        await createMutation.mutateAsync(body);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const isBusy = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">
            {isEdit ? 'Edit Import Job' : 'New Import Job'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-4">
          {loadingLookups && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading options…
            </div>
          )}

          {/* Job name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Job name</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={jobName}
              onChange={(e) => setJobName(e.target.value)}
              placeholder="Defaults to tenant name when creating"
            />
          </div>

          {/* SFTP Connection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">SFTP Connection</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              required
            >
              <option value="">Select a connection…</option>
              {connections.map((c) => (
                <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>
              ))}
            </select>
          </div>

          {/* Target tenant */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Target tenant</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={tenantId}
              onChange={(e) => {
                const id = e.target.value;
                setTenantId(id);
                if (!isEdit) {
                  const t = tenants.find((x) => x.tenantId === id);
                  if (t) setJobName(t.tenantName);
                }
              }}
              required
            >
              <option value="">Select a tenant…</option>
              {tenants.map((t) => (
                <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>
              ))}
            </select>
          </div>

          {/* Sub-folder */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Sub-folder <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={subFolderPath}
              onChange={(e) => setSubFolderPath(e.target.value)}
              placeholder="e.g. /Calstar"
            />
            <p className="text-xs text-gray-400 mt-0.5">Relative to connection's base directory. Leave blank to use base directory.</p>
          </div>

          {/* Format slug */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Format template</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={formatSlug}
              onChange={(e) => setFormatSlug(e.target.value)}
              required
            >
              <option value="">Select a format…</option>
              {presets.map((p) => (
                <option key={p.slug} value={p.slug}>{p.label}</option>
              ))}
            </select>
          </div>

          <ImportJobScheduleFields
            cronScheduleUtc={cronScheduleUtc}
            onChange={setCronScheduleUtc}
          />

          {/* Archive folder */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Archive folder name</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={archiveFolder}
              onChange={(e) => setArchiveFolder(e.target.value)}
              placeholder="archived"
            />
            <p className="text-xs text-gray-400 mt-0.5">Created automatically if missing. Files moved here after successful import.</p>
          </div>

          {/* Notify emails */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notification emails</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {notifyEmails.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-oe-light text-oe-primary text-xs rounded-full"
                >
                  {email}
                  <button
                    type="button"
                    onClick={() => removeEmail(email)}
                    className="hover:text-oe-dark"
                    aria-label={`Remove ${email}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="email"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={handleEmailKeyDown}
                placeholder="email@example.com"
              />
              <button
                type="button"
                onClick={addEmail}
                className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm flex items-center gap-1"
              >
                <Plus className="h-4 w-4" /> Add
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">Press Enter or comma to add. At least 1 required.</p>
          </div>

          {/* Import safety */}
          <div className="space-y-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
            <label className="block text-sm font-medium text-gray-700">Import behavior</label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={skipHouseholdWithUnmappedPlans}
                onChange={(e) => setSkipHouseholdWithUnmappedPlans(e.target.checked)}
                className="accent-oe-primary mt-0.5"
              />
              <span>
                <span className="font-medium text-gray-800">Skip household when any plan is unmapped</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  Recommended. If a CSV row has a product code with no pricing map (e.g. FM_1500), the whole household is skipped — no partial enrollments.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={allowTenantMove}
                onChange={(e) => setAllowTenantMove(e.target.checked)}
                className="accent-oe-primary mt-0.5"
              />
              <span>
                <span className="font-medium text-gray-800">Allow moving household to a different tenant</span>
                <span className="block text-xs text-amber-700 mt-0.5">
                  Dangerous — off by default. When enabled, members found under another tenant are moved into this job&apos;s tenant (shows as &quot;Moved tenant&quot; in run history).
                </span>
              </span>
            </label>
          </div>

          {/* Notify toggles */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Notify when…</label>
            {[
              { key: 'notifyOnSuccess', label: 'Import succeeds', value: notifyOnSuccess, set: setNotifyOnSuccess },
              { key: 'notifyOnFailure', label: 'Import fails', value: notifyOnFailure, set: setNotifyOnFailure },
              { key: 'notifyOnNoFiles', label: 'No files found', value: notifyOnNoFiles, set: setNotifyOnNoFiles },
            ].map(({ key, label, value, set }) => (
              <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(e) => set(e.target.checked)}
                  className="accent-oe-primary"
                />
                {label}
              </label>
            ))}
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
            </div>
          )}

          {/* Footer note */}
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
            <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>Jobs are created <strong>disabled</strong>. Enable the toggle after saving to activate scheduling.</span>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isBusy}
              className="px-4 py-2 text-sm bg-oe-primary hover:bg-oe-dark text-white rounded-lg disabled:opacity-50 flex items-center gap-1.5"
            >
              {isBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {isBusy ? 'Saving…' : isEdit ? 'Save changes' : 'Create job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default VendorImportJobModal;
