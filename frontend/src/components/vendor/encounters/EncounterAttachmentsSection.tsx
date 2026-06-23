// EncounterAttachmentsSection — drop zone + list, mirrors CaseDocuments.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Paperclip, Trash2, Upload } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import type { EncounterAttachment } from '../../../types/encounter.types';
import Skeleton from '../ui/Skeleton';

interface ListResp { success: boolean; data: EncounterAttachment[] }

interface Props { encounterId: string }

const fmtSize = (bytes?: number | null) => {
  if (!bytes) return '';
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

const fmtDate = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const EncounterAttachmentsSection = ({ encounterId }: Props) => {
  const [items, setItems] = useState<EncounterAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const resp = await apiService.get<ListResp>(
        `/api/me/vendor/encounters/${encounterId}/attachments`,
        signal ? { signal } : undefined
      );
      if (signal?.aborted) return;
      if (resp.success) setItems(resp.data);
    } catch (e) {
      if (signal?.aborted) return;
      console.error('attachments load', e);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [encounterId]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append('files', f));
      await apiService.post(`/api/me/vendor/encounters/${encounterId}/attachments`, fd);
      await load();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [encounterId, load]);

  const handleDelete = useCallback(async (attachmentId: string) => {
    if (!window.confirm('Remove this attachment?')) return;
    try {
      await apiService.delete(`/api/me/vendor/encounters/${encounterId}/attachments/${attachmentId}`);
      setItems((prev) => prev.filter((a) => a.AttachmentId !== attachmentId));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }, [encounterId]);

  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-oe-primary" />
          <h3 className="text-sm font-semibold text-gray-900">Attachments</h3>
        </div>
        <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors ${
          uploading
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : 'bg-oe-primary text-white hover:bg-oe-dark'
        }`}>
          <Upload className="h-3.5 w-3.5" />
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            disabled={uploading}
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
          />
        </label>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded" />)}
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs text-gray-500">No attachments yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {items.map((a) => (
              <li key={a.AttachmentId} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900 truncate">{a.FileName}</div>
                  <div className="text-[11px] text-gray-500">
                    {fmtSize(a.FileSize)}{a.FileSize ? ' · ' : ''}{fmtDate(a.CreatedDate)}{a.UploadedBy ? ` · ${a.UploadedBy}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {a.AuthenticatedUrl && (
                    <a
                      href={a.AuthenticatedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="p-1.5 text-gray-500 hover:text-oe-primary rounded"
                      aria-label={`Download ${a.FileName}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDelete(a.AttachmentId)}
                    className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                    aria-label={`Remove ${a.FileName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default EncounterAttachmentsSection;
