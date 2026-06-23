import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle, Upload } from 'lucide-react';
import VendorImportProgressPanel from './VendorImportProgressPanel';
import { importDisplayName, sanitizeUserFacingText } from './importDisplay';
import { runVendorImportJob, type VendorImportProgressEvent } from '../../../utils/vendorImportStream';

interface Props {
  vendorId: string;
}

type SharePreviewRow = {
  legacyId: string;
  requestName: string;
  action: string;
  status?: string;
  memberId?: string | null;
  memberName?: string | null;
  billCount?: number;
  noteCount?: number;
  shareRequestId?: string | null;
};

type SharePreview = {
  statistics: Record<string, number>;
  rows: SharePreviewRow[];
};

type ShareImportResult = {
  imported: number;
  resynced?: number;
  queued: number;
  skipped: number;
  errors: Array<{ legacyId: string; message: string }>;
  shareRequestIds: string[];
};

const VendorImportShareRequestsWizard: React.FC<Props> = ({ vendorId: _vendorId }) => {
  const [file, setFile] = useState<File | null>(null);
  const [queueUnlinked, setQueueUnlinked] = useState(false);
  const [resyncExisting, setResyncExisting] = useState(true);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [bundleDir, setBundleDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Preview import');
  const [progress, setProgress] = useState<VendorImportProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShareImportResult | null>(null);

  const resyncCount = preview?.statistics.resync ?? 0;
  const newImportCount = preview?.statistics.import ?? 0;

  const actionableRows = useMemo(() => {
    if (!preview) return [];
    return preview.rows.filter((row) => {
      if (!row.memberId) return false;
      if (row.action === 'import') return true;
      return resyncExisting && row.action === 'resync';
    });
  }, [preview, resyncExisting]);

  const runPreview = async () => {
    if (!file) return;
    setLoading(true);
    setLoadingLabel('Preview import');
    setProgress({ message: 'Uploading ZIP…' });
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      const form = new FormData();
      form.append('queueUnlinked', queueUnlinked ? 'true' : 'false');
      form.append('file', file);
      const res = await runVendorImportJob<SharePreview>(
        '/api/me/vendor/import/share-requests/parse',
        form,
        setProgress
      );
      setPreview(res.data);
      setBundleDir(res.bundleDir || '');
      setProgress(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Preview failed';
      setError(msg);
      console.error('[vendor-import] preview failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const commit = async () => {
    if (!bundleDir || !preview) return;
    setLoading(true);
    setLoadingLabel('Importing…');
    setProgress({ message: 'Starting import…' });
    setError(null);
    try {
      const res = await runVendorImportJob<ShareImportResult>(
        '/api/me/vendor/import/share-requests/commit',
        {
          bundleDir,
          queueUnlinked,
          resyncExisting,
          previewRows: actionableRows,
        },
        setProgress
      );
      setResult(res.data);
      setProgress(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Import failed';
      setError(msg);
      console.error('[vendor-import] commit failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const errorLegacyIds = new Set(result?.errors.map((e) => e.legacyId) ?? []);
  const succeededRows = actionableRows.filter((r) => !errorLegacyIds.has(r.legacyId));
  const failedRows = actionableRows.filter((r) => errorLegacyIds.has(r.legacyId));

  const commitLabel = useMemo(() => {
    if (!preview) return 'Import';
    const parts: string[] = [];
    if (newImportCount > 0) parts.push(`${newImportCount} new`);
    if (resyncExisting && resyncCount > 0) parts.push(`${resyncCount} resync`);
    if (!parts.length) return 'Nothing to import';
    return `Import ${parts.join(', ')}`;
  }, [preview, newImportCount, resyncExisting, resyncCount]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Upload a Sharewell export ZIP from{' '}
        <code className="text-xs bg-gray-100 px-1 rounded">export-sharewell-share-requests.sh</code>.
        Requests are linked to members via{' '}
        <code className="text-xs bg-gray-100 px-1 rounded">MemberSourceKeys</code>{' '}
        from the eligibility import (Sharewell member IDs).
      </p>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={resyncExisting}
            onChange={(e) => setResyncExisting(e.target.checked)}
          />
          {preview
            ? `Resync pre-existing requests (${resyncCount})`
            : 'Resync pre-existing requests'}
        </label>
        <p className="text-xs text-gray-500 ml-6">
          Updates share requests already imported from a prior run (same legacy ID). Use this after a
          partial failure — the header may have saved even if bills or notes errored.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={queueUnlinked} onChange={(e) => setQueueUnlinked(e.target.checked)} />
          Queue unlinked requests (not recommended)
        </label>
      </div>

      <div className="border border-dashed border-gray-300 rounded-lg p-6">
        <input type="file" accept=".zip" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <button
          type="button"
          disabled={!file || loading}
          onClick={() => void runPreview()}
          className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50"
        >
          <Upload className="h-4 w-4" />
          {loading && loadingLabel === 'Preview import' ? 'Previewing…' : 'Preview import'}
        </button>
      </div>

      {loading && progress && (
        <VendorImportProgressPanel progress={progress} title={loadingLabel} />
      )}

      {preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-sm">
            {Object.entries(preview.statistics).map(([k, v]) => (
              <div key={k} className="bg-gray-50 p-3 rounded-lg capitalize">
                {k.replace(/([A-Z])/g, ' $1')}: {v}
              </div>
            ))}
          </div>

          {resyncCount > 0 && !resyncExisting && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
              {resyncCount} request{resyncCount === 1 ? '' : 's'} already imported and will be skipped.
              Enable <strong>Resync pre-existing requests</strong> to refresh them from this export.
            </p>
          )}

          {actionableRows.length > 0 ? (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-sm font-medium text-gray-800">
                Requests to process ({actionableRows.length})
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-white sticky top-0 border-b border-gray-200">
                    <tr className="text-left text-gray-600">
                      <th className="px-4 py-2 font-medium">Request name</th>
                      <th className="px-4 py-2 font-medium">Member</th>
                      <th className="px-4 py-2 font-medium">Action</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium text-right">Bills</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionableRows.map((row) => (
                      <tr key={row.legacyId} className="border-b border-gray-100 last:border-0">
                        <td className="px-4 py-2 text-gray-900">{importDisplayName(row.requestName)}</td>
                        <td className="px-4 py-2 text-gray-700">{row.memberName || '—'}</td>
                        <td className="px-4 py-2 text-gray-600 capitalize">
                          {row.action === 'resync' ? 'Resync' : 'New import'}
                        </td>
                        <td className="px-4 py-2 text-gray-600 capitalize">{row.status || '—'}</td>
                        <td className="px-4 py-2 text-gray-600 text-right">{row.billCount ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
              {newImportCount === 0 && resyncCount === 0
                ? (
                  <>
                    No linked members found. Import members first (eligibility tab) so Sharewell member IDs are in{' '}
                    <code className="text-xs bg-white px-1 rounded">MemberSourceKeys</code>.
                  </>
                )
                : 'No requests selected for import. Enable resync or link more members.'}
            </p>
          )}

          <button
            type="button"
            disabled={loading || actionableRows.length === 0}
            onClick={() => void commit()}
            className="px-4 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50"
          >
            {loading && loadingLabel === 'Importing…' ? 'Importing…' : commitLabel}
          </button>
        </div>
      )}

      {result && (
        <div className={`rounded-lg border p-4 text-sm ${
          (result.imported + (result.resynced ?? 0)) > 0 && result.errors.length === 0
            ? 'bg-green-50 border-green-200'
            : (result.imported + (result.resynced ?? 0)) > 0
              ? 'bg-amber-50 border-amber-200'
              : 'bg-red-50 border-red-200'
        }`}>
          <div className="flex items-start gap-2">
            <CheckCircle className={`h-5 w-5 shrink-0 ${
              (result.imported + (result.resynced ?? 0)) > 0 && result.errors.length === 0
                ? 'text-green-600'
                : (result.imported + (result.resynced ?? 0)) > 0
                  ? 'text-amber-600'
                  : 'text-red-600'
            }`} />
            <div className="flex-1 space-y-3">
              <div>
                <p className="font-medium text-gray-900">
                  {(result.imported + (result.resynced ?? 0)) > 0 && result.errors.length === 0
                    ? 'Import complete'
                    : (result.imported + (result.resynced ?? 0)) > 0
                      ? 'Import partially complete'
                      : 'Import failed'}
                </p>
                <p className="mt-1 text-gray-700">
                  {result.imported > 0 && (
                    <span>{result.imported} new share request{result.imported === 1 ? '' : 's'}. </span>
                  )}
                  {(result.resynced ?? 0) > 0 && (
                    <span>{result.resynced} resynced. </span>
                  )}
                  {result.queued > 0 && (
                    <span>{result.queued} queued for later linking. </span>
                  )}
                  {result.errors.length > 0 && (
                    <span>{result.errors.length} failed.</span>
                  )}
                </p>
              </div>

              {succeededRows.length > 0 && (
                <div>
                  <p className="font-medium text-gray-800 mb-1">Completed</p>
                  <ul className="list-disc list-inside space-y-0.5 text-gray-700">
                    {succeededRows.map((row, i) => (
                      <li key={row.legacyId}>
                        {importDisplayName(row.requestName)}
                        {row.memberName ? ` — ${importDisplayName(row.memberName, 'Unknown member')}` : ''}
                        {row.action === 'resync' ? ' (resynced)' : ''}
                        {result.shareRequestIds[i] && (
                          <Link
                            to={`/vendor/share-requests/${result.shareRequestIds[i]}`}
                            className="ml-2 text-oe-primary hover:underline"
                          >
                            View
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.errors.length > 0 && (
                <div>
                  <p className="font-medium text-red-800 mb-1">Errors</p>
                  <ul className="space-y-1 text-red-800">
                    {result.errors.map((err) => {
                      const row = failedRows.find((r) => r.legacyId === err.legacyId)
                        || actionableRows.find((r) => r.legacyId === err.legacyId);
                      return (
                        <li key={err.legacyId}>
                          <span className="font-medium">{importDisplayName(row?.requestName)}</span>
                          {' — '}
                          {sanitizeUserFacingText(err.message)}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Import failed</p>
            <p className="mt-1">{sanitizeUserFacingText(error)}</p>
            {progress?.message && (
              <p className="mt-2 text-xs text-red-700">
                Last progress: {sanitizeUserFacingText(progress.message)}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default VendorImportShareRequestsWizard;
