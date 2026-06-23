import { useCallback, useEffect, useState } from 'react';
import { Trash2, FileText, RefreshCw, Eye, X } from 'lucide-react';
import { apiService } from '../../services/api.service';
import { usePublicFormsContext } from '../../hooks/usePublicFormsContext';

type DraftRow = {
  DraftId: string;
  FormTitle: string | null;
  OwnerFirstName: string | null;
  OwnerLastName: string | null;
  ForFirstName: string | null;
  ForLastName: string | null;
  CreatedDate: string;
  UpdatedDate: string;
  FileCount: number;
  TotalBytes: number;
};

function fullName(first: string | null, last: string | null): string {
  return `${first || ''} ${last || ''}`.trim() || '—';
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function ageDays(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
}

/**
 * "In Progress" tab — in-progress form drafts (autosaved by signed-in members).
 * Admins can review counts/age/size and delete stale drafts (purging their
 * staged Azure files). Shared by the tenant-admin and vendor forms surfaces.
 */
export default function TenantSharingDraftsPage() {
  const { apiBase } = usePublicFormsContext();
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{
    draftId: string;
    payload: Record<string, unknown>;
    files: Array<{ OriginalFileName: string; FieldName: string }>;
  } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.get<{ success: boolean; data?: { drafts: DraftRow[] } }>(
        `${apiBase}/drafts`
      );
      setDrafts(res.success && res.data ? res.data.drafts : []);
    } catch {
      setError('Could not load in-progress forms.');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    load();
  }, [load]);

  const onView = async (id: string) => {
    setViewLoading(true);
    try {
      const res = await apiService.get<{
        success: boolean;
        data?: { draft: { draftId: string; payload: Record<string, unknown>; files: Array<{ OriginalFileName: string; FieldName: string }> } };
      }>(`${apiBase}/drafts/${id}`);
      if (res.success && res.data) setViewing(res.data.draft);
    } catch {
      setError('Could not load that draft.');
    } finally {
      setViewLoading(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this in-progress form and its uploaded files? This cannot be undone.')) {
      return;
    }
    setDeletingId(id);
    try {
      await apiService.delete(`${apiBase}/drafts/${id}`);
      setDrafts((prev) => prev.filter((d) => d.DraftId !== id));
    } catch {
      setError('Could not delete that draft.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">In-progress forms</h2>
          <p className="text-sm text-gray-500">
            Drafts members started but haven't submitted. Delete stale ones to free up storage.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1.5 text-sm border border-gray-300 text-gray-700 bg-white rounded px-3 py-1.5 hover:bg-gray-50"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : drafts.length === 0 ? (
        <p className="text-sm text-gray-500">No in-progress forms right now.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4 font-medium">Started by</th>
                <th className="py-2 pr-4 font-medium">For</th>
                <th className="py-2 pr-4 font-medium">Form</th>
                <th className="py-2 pr-4 font-medium">Last updated</th>
                <th className="py-2 pr-4 font-medium">Files</th>
                <th className="py-2 pr-4 font-medium">Size</th>
                <th className="py-2 pr-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => {
                const days = ageDays(d.UpdatedDate);
                return (
                  <tr key={d.DraftId} className="border-b border-gray-100">
                    <td className="py-2 pr-4 text-gray-800">{fullName(d.OwnerFirstName, d.OwnerLastName)}</td>
                    <td className="py-2 pr-4 text-gray-800">{fullName(d.ForFirstName, d.ForLastName)}</td>
                    <td className="py-2 pr-4 text-gray-800">{d.FormTitle || '—'}</td>
                    <td className="py-2 pr-4 text-gray-600">
                      {new Date(d.UpdatedDate).toLocaleDateString()}
                      <span
                        className={`ml-2 inline-block rounded-full px-2 py-0.5 text-xs ${
                          days >= 30 ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {days}d ago
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-600">
                      <span className="inline-flex items-center gap-1">
                        <FileText className="h-3.5 w-3.5" /> {d.FileCount}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-600">{formatBytes(d.TotalBytes)}</td>
                    <td className="py-2 pr-2 text-right">
                      <button
                        type="button"
                        onClick={() => onView(d.DraftId)}
                        disabled={viewLoading}
                        className="inline-flex items-center gap-1 text-gray-700 hover:bg-gray-100 rounded px-2 py-1 mr-1 disabled:opacity-50"
                      >
                        <Eye className="h-4 w-4" /> View
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(d.DraftId)}
                        disabled={deletingId === d.DraftId}
                        className="inline-flex items-center gap-1 text-red-600 hover:bg-red-50 rounded px-2 py-1 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" /> Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {viewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg max-h-[80vh] overflow-auto rounded-lg bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold text-gray-900">Draft contents (read-only)</h3>
              <button
                type="button"
                onClick={() => setViewing(null)}
                aria-label="Close"
                className="text-gray-400 hover:text-gray-600 rounded p-0.5"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <dl className="space-y-1.5 text-sm">
              {Object.entries(viewing.payload || {})
                .filter(([k]) => !k.startsWith('__'))
                .map(([k, v]) => (
                  <div key={k} className="grid grid-cols-3 gap-2">
                    <dt className="text-gray-500 truncate">{k}</dt>
                    <dd className="col-span-2 text-gray-800 break-words">
                      {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}
                    </dd>
                  </div>
                ))}
            </dl>
            <div className="mt-4 border-t border-gray-100 pt-3">
              <p className="text-xs font-medium text-gray-500 uppercase mb-1">
                Uploaded files ({viewing.files?.length || 0})
              </p>
              {viewing.files && viewing.files.length > 0 ? (
                <ul className="space-y-1">
                  {viewing.files.map((f, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm text-gray-700">
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{f.OriginalFileName}</span>
                      <span className="text-xs text-gray-400">({f.FieldName})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No files uploaded yet.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
