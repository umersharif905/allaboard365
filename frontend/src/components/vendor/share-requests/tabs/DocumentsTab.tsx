import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import {
  CalendarClock,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Copy,
  Download,
  FileText,
  FolderTree,
  Mail,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { copyToClipboard } from '../../../../utils/clipboard';
import { SubmissionPreviewModal } from '../SubmissionPreviewModal';
import { apiService } from '../../../../services/api.service';
import { type ShareRequestDocument } from '../../../../types/shareRequest.types';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';
import {
  formatNameWithDiff,
  formatEmailWithDiff,
  formatPhoneWithDiff,
} from '../../../../utils/formMemberDiff';
import {
  groupSubmissionsByInvitation,
  formatSubmissionDateTime,
} from '../../../../utils/formSubmissionGrouping';

type LinkedFormSubmission = {
  SubmissionId: string;
  FormTemplateId: string;
  AuthMode: string | null;
  InvitationId: string | null;
  MemberMatchStatus: string | null;
  MemberId: string | null;
  CreatedDate: string | null;
  FormTitle: string | null;
  FormKind: string | null;
  PayloadFirstName: string | null;
  PayloadLastName: string | null;
  PayloadEmail: string | null;
  PayloadPhone: string | null;
  MemberFirstName: string | null;
  MemberLastName: string | null;
  MemberEmail: string | null;
  MemberPhone: string | null;
};

type LinkedFormInvitation = {
  InvitationId: string;
  FormTemplateId: string;
  MemberId: string | null;
  Mode: string;
  LinkedShareRequestId: string | null;
  ExpiresAt: string | null;
  FirstUsedAt: string | null;
  DeliveryMethod: string;
  RevokedAt: string | null;
  SentByUserId: string | null;
  SentToEmail: string | null;
  CreatedDate: string;
  FormTitle: string | null;
  FormKind: string | null;
  SentByName: string | null;
};

interface DocumentsTabProps {
  shareRequestId: string;
}

interface DocumentsResponse {
  success: boolean;
  data: ShareRequestDocument[];
}

const DOC_TYPES = [
  'General',
  'Medical Records',
  'Bills',
  'EOB',
  'Itemized Statement',
  'Identification',
  'Other',
];

const fmtDate = (v?: string) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const fmtSize = (bytes?: number) => {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const DocumentsTab = ({ shareRequestId }: DocumentsTabProps) => {
  const [docs, setDocs] = useState<ShareRequestDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [docType, setDocType] = useState('General');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [formSubmissions, setFormSubmissions] = useState<LinkedFormSubmission[]>([]);
  const [formInvitations, setFormInvitations] = useState<LinkedFormInvitation[]>([]);
  const [expandedSubmissionGroups, setExpandedSubmissionGroups] = useState<Set<string>>(
    new Set()
  );
  const [extendingId, setExtendingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [previewSubmissionId, setPreviewSubmissionId] = useState<string | null>(null);
  const [resendModal, setResendModal] = useState<{
    invitationId: string;
    recipientEmail: string | null;
    formTitle: string | null;
  } | null>(null);
  const [resendBusy, setResendBusy] = useState<'email' | 'copy' | null>(null);
  const [resendDone, setResendDone] = useState<'email' | 'copy' | null>(null);

  const submissionGroups = useMemo(
    () => groupSubmissionsByInvitation(formSubmissions),
    [formSubmissions]
  );

  const toggleSubmissionGroup = (key: string) => {
    setExpandedSubmissionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiService.get<DocumentsResponse>(
          `/api/me/vendor/share-requests/${shareRequestId}/documents`,
          signal ? { signal } : undefined
        );
        if (signal?.aborted) return;
        if (response.success) setDocs(response.data);
        else setError('load_failed');
      } catch (err) {
        if (signal?.aborted) return;
        console.error('share-request DocumentsTab load failed', err);
        setError('load_failed');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [shareRequestId]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Linked form submissions + pending invitations (forms-redesign Section 5
  // + B-016). Loaded in parallel — independent of the documents request — so
  // a slow query doesn't block the docs tab rendering.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const [subsRes, invsRes] = await Promise.all([
          apiService.get<{ success: boolean; data: LinkedFormSubmission[] }>(
            `/api/me/vendor/share-requests/${shareRequestId}/form-submissions`,
            { signal: controller.signal }
          ),
          apiService.get<{ success: boolean; data: LinkedFormInvitation[] }>(
            `/api/me/vendor/share-requests/${shareRequestId}/form-invitations`,
            { signal: controller.signal }
          ),
        ]);
        if (!controller.signal.aborted) {
          if (subsRes.success) setFormSubmissions(subsRes.data || []);
          if (invsRes.success) setFormInvitations(invsRes.data || []);
        }
      } catch {
        // Best-effort; an outage shouldn't break the docs tab.
      }
    })();
    return () => controller.abort();
  }, [shareRequestId]);

  // B-028: Resend modal handlers. Renew the invitation (revokes old +
  // issues fresh token) and either email it or copy to clipboard.
  const reloadInvitations = async () => {
    try {
      const res = await apiService.get<{ success: boolean; data: LinkedFormInvitation[] }>(
        `/api/me/vendor/share-requests/${shareRequestId}/form-invitations`
      );
      if (res.success) setFormInvitations(res.data || []);
    } catch {
      // best-effort
    }
  };

  const handleResend = async (mode: 'email' | 'copy') => {
    if (!resendModal) return;
    setResendBusy(mode);
    setResendDone(null);
    try {
      const res = await apiService.post<{
        success: boolean;
        data?: { invitationId: string; url: string; expiresAt: string };
        message?: string;
      }>(
        `/api/me/vendor/public-forms/invitations/${resendModal.invitationId}/renew`,
        { deliveryMethod: mode }
      );
      if (!res.success || !res.data?.url) {
        window.alert(res.message || 'Resend failed');
        return;
      }
      if (mode === 'copy') {
        const ok = await copyToClipboard(res.data.url);
        if (!ok) {
          window.alert(`Couldn't access clipboard. Copy this URL manually:\n${res.data.url}`);
        }
      }
      setResendDone(mode);
      await reloadInvitations();
    } catch (err) {
      console.error('Resend failed:', err);
      window.alert(err instanceof Error ? err.message : 'Resend failed.');
    } finally {
      setResendBusy(null);
    }
  };

  const handleExtendInvitation = async (invitationId: string) => {
    const next = new Date(Date.now() + 7 * 86400000).toISOString();
    setExtendingId(invitationId);
    try {
      const res = await apiService.patch<{
        success: boolean;
        data?: { expiresAt: string };
        message?: string;
      }>(`/api/me/vendor/public-forms/invitations/${invitationId}`, { expiresAt: next });
      if (!res.success || !res.data?.expiresAt) {
        window.alert(res.message || 'Failed to extend invitation.');
        return;
      }
      setFormInvitations((prev) =>
        prev.map((i) =>
          i.InvitationId === invitationId ? { ...i, ExpiresAt: res.data!.expiresAt } : i
        )
      );
    } catch (err) {
      console.error('Extend invitation failed:', err);
      window.alert('Failed to extend invitation.');
    } finally {
      setExtendingId(null);
    }
  };

  const handleRevokeInvitation = async (invitationId: string) => {
    if (
      !window.confirm(
        "Revoke this invitation? The recipient won't be able to open the form. Existing submissions are kept."
      )
    ) {
      return;
    }
    setRevokingId(invitationId);
    try {
      await apiService.delete(`/api/me/vendor/public-forms/invitations/${invitationId}`);
      // Revoked invitations are filtered out of the SR list by the backend,
      // so drop locally too.
      setFormInvitations((prev) => prev.filter((i) => i.InvitationId !== invitationId));
    } catch (err) {
      console.error('Revoke invitation failed:', err);
      window.alert('Failed to revoke invitation.');
    } finally {
      setRevokingId(null);
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, ShareRequestDocument[]>();
    for (const d of docs) {
      const type = d.DocumentType ?? 'General';
      const list = map.get(type) ?? [];
      list.push(d);
      map.set(type, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [docs]);

  const visibleGroups = selectedType
    ? grouped.filter(([type]) => type === selectedType)
    : grouped;

  const handleFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list) return;
    setFiles(Array.from(list));
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      setUploadError('Pick at least one file');
      return;
    }
    const srId = shareRequestId;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      for (const f of files) formData.append('files', f);
      formData.append('documentType', docType);
      if (description) formData.append('description', description);
      const result = await apiService.post<{ success: boolean; message?: string }>(
        `/api/me/vendor/share-requests/${srId}/documents/upload`,
        formData
      );
      if (!result.success) throw new Error(result.message ?? 'Upload failed');
      setShowUpload(false);
      setFiles([]);
      setDocType('General');
      setDescription('');
      await load();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (documentId: string) => {
    if (!window.confirm('Delete this document?')) return;
    const srId = shareRequestId;
    try {
      await apiService.delete(`/api/me/vendor/share-requests/${srId}/documents/${documentId}`);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete document');
    }
  };

  const handleDownload = (doc: ShareRequestDocument) => {
    const url = doc.AuthenticatedUrl ?? doc.BlobUrl;
    if (!url) {
      window.alert('No download URL available');
      return;
    }
    window.open(url, '_blank', 'noopener');
  };

  // Open every document in its own new tab, the same way the per-row
  // download button does. Browsers gate multi-window.open on a user
  // gesture, so this runs synchronously inside the click handler.
  const handleDownloadAll = () => {
    const urls = docs
      .map((doc) => doc.AuthenticatedUrl ?? doc.BlobUrl)
      .filter((url): url is string => !!url);
    if (urls.length === 0) {
      window.alert('No documents to download');
      return;
    }
    urls.forEach((url) => window.open(url, '_blank', 'noopener'));
  };

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Documents and forms</h2>
        <div className="flex items-center gap-2">
          {docs.length > 0 && (
            <button
              type="button"
              onClick={handleDownloadAll}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
            >
              <Download className="h-4 w-4" />
              Download all
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
          >
            <Upload className="h-4 w-4" />
            Upload
          </button>
        </div>
      </div>

      {/* Type filter chips */}
      {grouped.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSelectedType(null)}
            className={`px-3 py-1 text-xs rounded-full border ${
              selectedType === null
                ? 'bg-oe-primary text-white border-oe-primary'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            All ({docs.length})
          </button>
          {grouped.map(([type, group]) => (
            <button
              key={type}
              type="button"
              onClick={() => setSelectedType(type)}
              className={`px-3 py-1 text-xs rounded-full border ${
                selectedType === type
                  ? 'bg-oe-primary text-white border-oe-primary'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {type} ({group.length})
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        // Empty state wins over a transient load error so the panel stays calm on
        // first paint. Failures are logged to the console; users can retry via
        // Upload or by refreshing.
        <EmptyState
          icon={FolderTree}
          title={error ? "Couldn't load documents" : 'No documents'}
          description={error ? 'Try refreshing the page.' : 'Upload the first document.'}
          tone="subtle"
        />
      ) : (
        <div className="space-y-3">
          {visibleGroups.map(([type, group]) => (
            <section key={type} className="bg-white border border-gray-200 rounded-lg">
              <header className="px-4 py-2 border-b border-gray-200 flex items-center gap-2">
                <FolderTree className="h-4 w-4 text-oe-primary" />
                <h3 className="text-sm font-semibold text-gray-900">{type}</h3>
                <span className="text-xs text-gray-500">({group.length})</span>
              </header>
              <ul className="divide-y divide-gray-200">
                {group.map((doc) => (
                  <li key={doc.DocumentId} className="px-4 py-2 flex items-center gap-3">
                    <FileText className="h-4 w-4 text-gray-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {doc.DocumentName ?? doc.FileName}
                      </div>
                      <div className="text-xs text-gray-500">
                        {fmtDate(doc.CreatedDate)} · {fmtSize(doc.FileSize)}
                        {doc.Description ? ` · ${doc.Description}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDownload(doc)}
                      className="p-1 text-gray-400 hover:text-oe-primary rounded"
                      aria-label="Download document"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(doc.DocumentId)}
                      className="p-1 text-gray-400 hover:text-red-600 rounded"
                      aria-label="Delete document"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* B-028: Forms section combines pending invitations and submitted
          forms under one heading with two sub-sections so the visual
          separation between "we sent it" and "they filled it out" stays
          but the care team can scan it as one list. */}
      {(formInvitations.length > 0 || formSubmissions.length > 0) && (
        <section className="bg-white border border-gray-200 rounded-lg">
          <header className="px-4 py-2 border-b border-gray-200 flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-oe-primary" />
            <h3 className="text-sm font-semibold text-gray-900">Forms</h3>
            <span className="text-xs text-gray-500">
              ({formInvitations.length + formSubmissions.length})
            </span>
          </header>

          {formInvitations.length > 0 && (
            <div>
              <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Pending submission
                </h4>
                <span className="text-[11px] text-gray-500">({formInvitations.length})</span>
              </div>
              <ul className="divide-y divide-gray-100">
                {formInvitations.map((i) => {
                  const opened = !!i.FirstUsedAt;
                  return (
                    <li key={i.InvitationId} className="px-4 py-2 flex items-center gap-3">
                      <Send className="h-4 w-4 text-gray-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {i.FormTitle || 'Form invitation'}
                        </div>
                        <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                              opened
                                ? 'bg-oe-light text-oe-dark border-oe-primary'
                                : 'bg-amber-50 text-amber-800 border-amber-200'
                            }`}
                          >
                            {opened ? 'Opened' : 'Awaiting submission'}
                          </span>
                          <span>Sent {formatSubmissionDateTime(i.CreatedDate)}</span>
                          <span>· {i.Mode}</span>
                          {i.SentToEmail && <span className="truncate">· to {i.SentToEmail}</span>}
                          {i.ExpiresAt && <span>· expires {fmtDate(i.ExpiresAt)}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            setResendModal({
                              invitationId: i.InvitationId,
                              recipientEmail: i.SentToEmail,
                              formTitle: i.FormTitle,
                            })
                          }
                          className="inline-flex items-center gap-1 text-xs text-oe-primary hover:bg-oe-light px-2 py-1 rounded"
                          title="Issue a fresh link and re-send"
                        >
                          <Send className="h-3.5 w-3.5" />
                          Resend
                        </button>
                        <button
                          type="button"
                          onClick={() => handleExtendInvitation(i.InvitationId)}
                          disabled={extendingId === i.InvitationId}
                          className="inline-flex items-center gap-1 text-xs text-oe-primary hover:bg-oe-light px-2 py-1 rounded disabled:opacity-50"
                          title="Push the expiry out by 7 days"
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                          {extendingId === i.InvitationId ? 'Extending…' : 'Extend'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRevokeInvitation(i.InvitationId)}
                          disabled={revokingId === i.InvitationId}
                          className="inline-flex items-center gap-1 text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {revokingId === i.InvitationId ? 'Revoking…' : 'Revoke'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {formSubmissions.length > 0 && (
            <div>
              <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100 border-t border-gray-100 flex items-center gap-2">
                <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Submitted
                </h4>
                <span className="text-[11px] text-gray-500">({formSubmissions.length})</span>
              </div>
          <ul className="divide-y divide-gray-200">
            {submissionGroups.map((g) => {
              const isMulti = g.submissions.length > 1;
              const isExpanded = expandedSubmissionGroups.has(g.key);
              const latest = g.submissions[0];

              const renderRow = (s: LinkedFormSubmission, isLatest: boolean) => {
                // Surface payload-vs-profile divergence regardless of
                // AuthMode (B-022). The diff is purely informational; the
                // utility returns the account value unchanged when normalized
                // values match, so server-pinned targeted/authenticated rows
                // simply don't render parens unless the recipient typed
                // something different.
                const showDiff = !!s.MemberId;
                const memberName = showDiff
                  ? formatNameWithDiff(
                      s.MemberFirstName,
                      s.MemberLastName,
                      s.PayloadFirstName,
                      s.PayloadLastName
                    )
                  : [s.MemberFirstName, s.MemberLastName].filter(Boolean).join(' ');
                const memberEmail = showDiff
                  ? formatEmailWithDiff(s.MemberEmail, s.PayloadEmail)
                  : s.MemberEmail || '';
                const memberPhone = showDiff
                  ? formatPhoneWithDiff(s.MemberPhone, s.PayloadPhone)
                  : s.MemberPhone || '';
                const memberLine = [memberName, memberEmail, memberPhone]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <div className="flex items-center gap-3">
                    <ClipboardList className="h-4 w-4 text-gray-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <button
                        type="button"
                        onClick={() => setPreviewSubmissionId(s.SubmissionId)}
                        className="text-sm font-medium text-oe-primary hover:underline truncate block text-left w-full"
                      >
                        {s.FormTitle || 'Form submission'}
                      </button>
                      <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                        <span>{formatSubmissionDateTime(s.CreatedDate)}</span>
                        {isLatest && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-oe-light text-oe-dark">
                            Latest
                          </span>
                        )}
                        {s.AuthMode && <span>· {s.AuthMode}</span>}
                      </div>
                      {memberLine && (
                        <div className="text-xs text-gray-500 truncate">{memberLine}</div>
                      )}
                    </div>
                  </div>
                );
              };

              if (!isMulti) {
                return (
                  <li key={g.key} className="px-4 py-2">
                    {renderRow(latest, false)}
                  </li>
                );
              }

              return (
                <li key={g.key} className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => toggleSubmissionGroup(g.key)}
                    className="w-full flex items-center gap-3 text-left rounded hover:bg-gray-50 -mx-2 px-2 py-1"
                    aria-expanded={isExpanded}
                  >
                    <ChevronRight
                      className={`h-4 w-4 text-gray-400 shrink-0 transition-transform ${
                        isExpanded ? 'rotate-90' : ''
                      }`}
                    />
                    <ClipboardList className="h-4 w-4 text-gray-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {latest.FormTitle || 'Form submission'}{' '}
                        <span className="text-xs text-gray-500 font-normal">
                          — {g.submissions.length} submissions
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        Latest {formatSubmissionDateTime(latest.CreatedDate)}
                      </div>
                    </div>
                  </button>
                  {isExpanded && (
                    <ul className="mt-2 ml-7 space-y-2">
                      {g.submissions.map((s, idx) => (
                        <li key={s.SubmissionId}>{renderRow(s, idx === 0)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
            </div>
          )}
        </section>
      )}

      {showUpload && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="upload-title"
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowUpload(false);
          }}
        >
          <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-4 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 id="upload-title" className="text-base font-semibold text-gray-900">
                Upload documents
              </h3>
              <button
                type="button"
                onClick={() => setShowUpload(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <Field label="Document type">
              <select
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
              >
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Description">
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
              />
            </Field>

            <Field label="Files">
              <input
                type="file"
                multiple
                onChange={handleFiles}
                className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-oe-light file:text-oe-dark hover:file:bg-oe-primary hover:file:text-white"
              />
              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((f, i) => (
                    <li key={i} className="text-xs text-gray-600 truncate">
                      {f.name} <span className="text-gray-400">({fmtSize(f.size)})</span>
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            {uploadError && (
              <div className="flex items-center gap-1.5 text-xs text-red-600">
                <CircleAlert className="h-3.5 w-3.5" />
                {uploadError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowUpload(false)}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleUpload}
                disabled={uploading || files.length === 0}
                className="px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SubmissionPreviewModal
        submissionId={previewSubmissionId}
        detailRouteBase="/vendor/sharing-forms"
        apiBase="/api/me/vendor/public-forms"
        onClose={() => setPreviewSubmissionId(null)}
      />

      {resendModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !resendBusy) {
              setResendModal(null);
              setResendDone(null);
            }
          }}
        >
          <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-gray-900 truncate">
                Resend {resendModal.formTitle || 'invitation'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  if (resendBusy) return;
                  setResendModal(null);
                  setResendDone(null);
                }}
                disabled={!!resendBusy}
                className="text-gray-400 hover:text-gray-600 p-1 rounded disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-gray-600 leading-relaxed">
              Resending issues a fresh link and revokes the old one — the
              original link stops working immediately. Choose how you want
              to deliver the new link.
            </p>
            {resendModal.recipientEmail && (
              <p className="text-xs text-gray-500">
                Recipient on file:{' '}
                <span className="font-medium text-gray-700">{resendModal.recipientEmail}</span>
              </p>
            )}
            {resendDone === 'email' && (
              <div className="rounded border border-green-200 bg-green-50 text-green-800 px-3 py-2 text-xs">
                Email queued to {resendModal.recipientEmail || 'the recipient'}.
              </div>
            )}
            {resendDone === 'copy' && (
              <div className="rounded border border-green-200 bg-green-50 text-green-800 px-3 py-2 text-xs">
                Fresh link copied to clipboard. The old link no longer works.
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => handleResend('copy')}
                disabled={!!resendBusy}
                className="inline-flex items-center justify-center gap-1.5 border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 px-3 py-2 rounded text-sm disabled:opacity-50"
              >
                <Copy className="h-3.5 w-3.5" />
                {resendBusy === 'copy' ? 'Copying…' : 'Copy new link'}
              </button>
              <button
                type="button"
                onClick={() => handleResend('email')}
                disabled={!!resendBusy || !resendModal.recipientEmail}
                className="inline-flex items-center justify-center gap-1.5 bg-oe-primary hover:bg-oe-dark text-white px-3 py-2 rounded text-sm disabled:opacity-50"
                title={
                  !resendModal.recipientEmail
                    ? 'No recipient email on file; copy the new link instead.'
                    : ''
                }
              >
                <Mail className="h-3.5 w-3.5" />
                {resendBusy === 'email' ? 'Sending…' : 'Email new link'}
              </button>
            </div>
            {resendDone && (
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setResendModal(null);
                    setResendDone(null);
                  }}
                  className="text-xs text-gray-600 hover:underline"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
    {children}
  </div>
);

export default DocumentsTab;
