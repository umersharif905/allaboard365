// Support ticket documents — list uploaded documents (with authenticated SAS URLs),
// upload new ones, soft-delete with confirm.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, ExternalLink, FileText, FolderTree, Trash2, Upload } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import type { CaseDocumentRow } from '../../../../types/case.types';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface ListResp { success: boolean; data: CaseDocumentRow[] }

interface LinkedFormSubmission {
  SubmissionId: string;
  FormTitle: string | null;
  FormKind: string | null;
  CreatedDate: string | null;
  MemberMatchStatus: string | null;
}

interface CaseDocumentsTabProps { caseId: string }

const fmtSize = (b?: number | null) => {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const CaseDocumentsTab = ({ caseId }: CaseDocumentsTabProps) => {
  const [rows, setRows] = useState<CaseDocumentRow[]>([]);
  const [formSubs, setFormSubs] = useState<LinkedFormSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [resp, formResp] = await Promise.all([
        apiService.get<ListResp>(`/api/me/vendor/cases/${caseId}/documents`, { signal }),
        apiService.get<{ success: boolean; data: LinkedFormSubmission[] }>(
          `/api/me/vendor/cases/${caseId}/form-submissions`,
          { signal }
        )
      ]);
      if (signal?.aborted) return;
      if (resp.success) setRows(resp.data);
      else setError('load_failed');
      if (formResp.success) setFormSubs(formResp.data);
    } catch (e) {
      if (signal?.aborted) return;
      console.error('CaseDocumentsTab load failed', e);
      setError('load_failed');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append('files', f));
    setUploading(true);
    try {
      await apiService.post(`/api/me/vendor/cases/${caseId}/documents/upload`, form);
      await load();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Open every document in its own new tab, the same as clicking each
  // document link. Browsers gate multi-window.open on a user gesture, so
  // this runs synchronously inside the click handler.
  const handleOpenAll = () => {
    const urls = rows
      .map((r) => r.AuthenticatedUrl)
      .filter((url): url is string => !!url);
    if (urls.length === 0) {
      window.alert('No documents to open');
      return;
    }
    urls.forEach((url) => window.open(url, '_blank', 'noopener'));
  };

  const handleDelete = async (documentId: string) => {
    if (!window.confirm('Delete this document?')) return;
    try {
      await apiService.delete(`/api/me/vendor/cases/${caseId}/documents/${documentId}`);
      setRows((prev) => prev.filter((r) => r.DocumentId !== documentId));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderTree className="h-4 w-4 text-oe-primary" />
            <h3 className="text-sm font-semibold text-gray-900">Documents</h3>
          </div>
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <button
                type="button"
                onClick={handleOpenAll}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md"
              >
                <ExternalLink className="h-4 w-4" />
                Open all
              </button>
            )}
            <label className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white rounded-md cursor-pointer ${uploading ? 'bg-gray-400' : 'bg-oe-primary hover:bg-oe-dark'}`}>
              <Upload className="h-4 w-4" />
              {uploading ? 'Uploading...' : 'Upload'}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleUpload(e.target.files)}
                disabled={uploading}
              />
            </label>
          </div>
        </div>

        {loading ? (
          <div className="p-5 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded" />)}
          </div>
        ) : rows.length === 0 ? (
          // Empty state wins over a transient load error so first-paint stays calm.
          // Load failures are logged to console; users can retry via Upload or refresh.
          <div className="p-5">
            <EmptyState
              icon={FolderTree}
              title={error ? "Couldn't load documents" : 'No documents'}
              description={error ? 'Try refreshing the page.' : 'Upload files using the button above.'}
              tone="subtle"
            />
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((d) => (
              <li key={d.DocumentId} className="p-4 flex items-center justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <FileText className="h-5 w-5 text-gray-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    {d.AuthenticatedUrl ? (
                      <a
                        href={d.AuthenticatedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-oe-primary hover:underline truncate block"
                      >
                        {d.DocumentName}
                      </a>
                    ) : (
                      <div className="text-sm font-medium text-gray-900 truncate">{d.DocumentName}</div>
                    )}
                    <div className="text-xs text-gray-500">
                      {fmtSize(d.FileSize)} · {fmtDate(d.CreatedDate)}
                      {d.DocumentType && ` · ${d.DocumentType}`}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(d.DocumentId)}
                  className="text-xs text-red-600 hover:text-red-700 inline-flex items-center gap-1 shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {formSubs.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-5 py-3 border-b border-gray-200 flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-oe-primary" />
            <h3 className="text-sm font-semibold text-gray-900">Form submissions</h3>
          </div>
          <ul className="divide-y divide-gray-100">
            {formSubs.map((f) => (
              <li key={f.SubmissionId} className="p-4 flex items-center justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <FileText className="h-5 w-5 text-gray-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <Link
                      to={`/vendor/sharing-forms/submissions/${f.SubmissionId}`}
                      className="text-sm font-medium text-oe-primary hover:underline truncate block"
                    >
                      {f.FormTitle || 'Form submission'}
                    </Link>
                    <div className="text-xs text-gray-500">Submitted {fmtDate(f.CreatedDate)}</div>
                  </div>
                </div>
                <Link
                  to={`/vendor/sharing-forms/submissions/${f.SubmissionId}`}
                  className="text-xs text-oe-primary hover:underline inline-flex items-center gap-1 shrink-0"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> View
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default CaseDocumentsTab;
