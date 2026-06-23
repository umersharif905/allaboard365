import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  ChevronRight,
  ClipboardList,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Send,
  Trash2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiService } from '../../../../services/api.service';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';
import {
  groupSubmissionsByInvitation,
  formatSubmissionDateTime,
} from '../../../../utils/formSubmissionGrouping';

interface MemberDocument {
  DocumentId: string;
  ShareRequestId: string;
  RequestNumber?: string;
  DocumentName?: string;
  DocumentType?: string;
  FileName?: string;
  FileSize?: number;
  MimeType?: string;
  BlobUrl?: string;
  Description?: string;
  CreatedDate?: string;
}

type MemberFormSubmission = {
  SubmissionId: string;
  FormTemplateId: string;
  ShareRequestId: string | null;
  CaseId: string | null;
  AuthMode: string | null;
  InvitationId: string | null;
  MemberMatchStatus: string | null;
  CreatedDate: string | null;
  FormTitle: string | null;
  FormKind: string | null;
  RequestNumber: string | null;
};

type MemberFormInvitation = {
  InvitationId: string;
  FormTemplateId: string;
  MemberId: string;
  Mode: string;
  LinkedShareRequestId: string | null;
  LinkedCaseId: string | null;
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
  SubmissionCount: number;
};

type FolderEntry =
  | { kind: 'share-request'; key: string; name: string; srId: string }
  | { kind: 'all-forms'; key: 'all-forms'; name: string };

const ALL_FORMS_KEY = 'all-forms';

interface MemberDocumentsTabProps {
  memberId: string;
}

const formatDate = (raw?: string) => {
  if (!raw) return '';
  try {
    return new Date(raw).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return raw;
  }
};

const formatSize = (bytes?: number) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const isInvitationActive = (i: MemberFormInvitation): boolean => {
  if (i.RevokedAt) return false;
  if (!i.ExpiresAt) return true;
  return new Date(i.ExpiresAt).getTime() > Date.now();
};

const MemberDocumentsTab = ({ memberId }: MemberDocumentsTabProps) => {
  const [docs, setDocs] = useState<MemberDocument[]>([]);
  const [formSubmissions, setFormSubmissions] = useState<MemberFormSubmission[]>([]);
  const [invitations, setInvitations] = useState<MemberFormInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [expandedSubmissionGroups, setExpandedSubmissionGroups] = useState<Set<string>>(
    new Set()
  );
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [extendingId, setExtendingId] = useState<string | null>(null);

  const toggleSubmissionGroup = (key: string) => {
    setExpandedSubmissionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiService.get<{ success: boolean; data: MemberDocument[] }>(
          `/api/me/vendor/members/${memberId}/documents`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (response.success) {
          setDocs(response.data ?? []);
        } else {
          setError('Unable to load documents');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Error loading documents:', err);
        setError('Unable to load documents');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [memberId]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await apiService.get<{ success: boolean; data: MemberFormSubmission[] }>(
          `/api/me/vendor/members/${memberId}/form-submissions`,
          { signal: controller.signal }
        );
        if (!controller.signal.aborted && res.success) {
          setFormSubmissions(res.data ?? []);
        }
      } catch {
        // Best-effort: an outage on form-submissions shouldn't break the tab.
      }
    })();
    return () => controller.abort();
  }, [memberId]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await apiService.get<{ success: boolean; data: MemberFormInvitation[] }>(
          `/api/me/vendor/members/${memberId}/form-invitations`,
          { signal: controller.signal }
        );
        if (!controller.signal.aborted && res.success) {
          setInvitations(res.data ?? []);
        }
      } catch {
        // Best-effort: invitations row is optional surface; failing this
        // endpoint should not break the rest of the tab.
      }
    })();
    return () => controller.abort();
  }, [memberId]);

  const folders: FolderEntry[] = useMemo(() => {
    // SR folders are the union of share requests referenced by any of:
    // attached documents, linked form submissions, or pending invitations.
    const srNames = new Map<string, string>();
    for (const d of docs) {
      if (d.ShareRequestId) {
        srNames.set(d.ShareRequestId, d.RequestNumber || d.ShareRequestId);
      }
    }
    for (const s of formSubmissions) {
      if (s.ShareRequestId && !srNames.has(s.ShareRequestId)) {
        srNames.set(s.ShareRequestId, s.RequestNumber || s.ShareRequestId);
      }
    }
    for (const i of invitations) {
      if (
        i.LinkedShareRequestId &&
        isInvitationActive(i) &&
        !srNames.has(i.LinkedShareRequestId)
      ) {
        srNames.set(i.LinkedShareRequestId, i.LinkedShareRequestId);
      }
    }
    const srFolders: FolderEntry[] = Array.from(srNames.entries())
      .map(([srId, name]) => ({
        kind: 'share-request' as const,
        key: `sr:${srId}`,
        name,
        srId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // "Form submissions" is always present as a consolidated sibling so the
    // care team can find every submission regardless of linkage.
    return [
      ...srFolders,
      { kind: 'all-forms', key: ALL_FORMS_KEY, name: 'Form submissions' },
    ];
  }, [docs, formSubmissions, invitations]);

  useEffect(() => {
    if (folders.length === 0) {
      if (activeFolder !== null) setActiveFolder(null);
      return;
    }
    if (!activeFolder || !folders.find((f) => f.key === activeFolder)) {
      setActiveFolder(folders[0].key);
    }
  }, [folders, activeFolder]);

  const activeFolderEntry = folders.find((f) => f.key === activeFolder) ?? null;

  // Strict isolation: a submission linked to SR #7 appears in the SR #7
  // folder and the consolidated "Form submissions" folder — never in SR #6
  // or SR #8.
  const activeDocs = useMemo(() => {
    if (!activeFolderEntry) return [];
    if (activeFolderEntry.kind !== 'share-request') return [];
    return docs.filter((d) => d.ShareRequestId === activeFolderEntry.srId);
  }, [activeFolderEntry, docs]);

  const activeSubmissions = useMemo(() => {
    if (!activeFolderEntry) return [];
    if (activeFolderEntry.kind === 'share-request') {
      return formSubmissions.filter(
        (s) => s.ShareRequestId === activeFolderEntry.srId
      );
    }
    return formSubmissions;
  }, [activeFolderEntry, formSubmissions]);

  const activeSubmissionGroups = useMemo(
    () => groupSubmissionsByInvitation(activeSubmissions),
    [activeSubmissions]
  );

  const activeInvitations = useMemo(() => {
    if (!activeFolderEntry) return [];
    const filtered =
      activeFolderEntry.kind === 'share-request'
        ? invitations.filter(
            (i) => i.LinkedShareRequestId === activeFolderEntry.srId
          )
        : invitations;
    return filtered.filter(isInvitationActive);
  }, [activeFolderEntry, invitations]);

  const handleExtend = useCallback(async (invitationId: string) => {
    // Push expiry out by 7 days. Matches the default issue cadence; a date
    // picker can come later if needed.
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
      const newExp = res.data.expiresAt;
      setInvitations((prev) =>
        prev.map((i) =>
          i.InvitationId === invitationId ? { ...i, ExpiresAt: newExp } : i
        )
      );
    } catch (err) {
      console.error('Extend invitation failed:', err);
      window.alert('Failed to extend invitation.');
    } finally {
      setExtendingId(null);
    }
  }, []);

  const handleRevoke = useCallback(async (invitationId: string) => {
    if (
      !window.confirm(
        "Revoke this invitation? The recipient won't be able to open the form. Existing submissions are kept."
      )
    ) {
      return;
    }
    setRevokingId(invitationId);
    try {
      await apiService.delete(
        `/api/me/vendor/public-forms/invitations/${invitationId}`
      );
      setInvitations((prev) =>
        prev.map((i) =>
          i.InvitationId === invitationId
            ? { ...i, RevokedAt: new Date().toISOString() }
            : i
        )
      );
    } catch (err) {
      console.error('Revoke invitation failed:', err);
      window.alert('Failed to revoke invitation.');
    } finally {
      setRevokingId(null);
    }
  }, []);

  if (loading) {
    return (
      <div className="p-6 flex gap-4 h-full min-h-0">
        <div className="w-56 shrink-0 space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
        <div className="flex-1 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return <EmptyState icon={FileText} title={error} tone="error" />;
  }

  if (
    docs.length === 0 &&
    formSubmissions.length === 0 &&
    invitations.length === 0
  ) {
    return (
      <EmptyState
        icon={FileText}
        title="No documents, forms, or invitations"
        description="Documents, form submissions, and pending invitations tied to this member will appear here."
      />
    );
  }

  return (
    <div className="p-6 flex gap-4 h-full min-h-0 animate-fade-up">
      <aside className="w-56 shrink-0 bg-white border border-gray-200 rounded-lg overflow-auto shadow-soft">
        <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
          Folders
        </div>
        <ul>
          {folders.map((f) => {
            const isActive = activeFolder === f.key;
            const Icon = isActive ? FolderOpen : Folder;
            const count =
              f.kind === 'share-request'
                ? docs.filter((d) => d.ShareRequestId === f.srId).length +
                  formSubmissions.filter((s) => s.ShareRequestId === f.srId).length
                : formSubmissions.length;
            return (
              <li key={f.key}>
                <button
                  type="button"
                  onClick={() => setActiveFolder(f.key)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                    isActive
                      ? 'bg-oe-light text-oe-dark font-medium'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      isActive ? 'text-oe-primary' : 'text-gray-400'
                    }`}
                  />
                  <span className="truncate">{f.name}</span>
                  <span
                    className={`ml-auto text-xs rounded-full px-1.5 py-0.5 ${
                      isActive ? 'bg-white text-oe-dark' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="flex-1 min-w-0 space-y-4 overflow-auto">
        {/* Pending invitations row — followup A.1.b. */}
        {activeInvitations.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg shadow-soft">
            <header className="px-4 py-2 border-b border-gray-200 flex items-center gap-2">
              <Send className="h-4 w-4 text-oe-primary" />
              <h3 className="text-sm font-semibold text-gray-900">
                Pending invitations
              </h3>
              <span className="text-xs text-gray-500">
                ({activeInvitations.length})
              </span>
            </header>
            <ul className="divide-y divide-gray-100">
              {activeInvitations.map((i) => (
                <li
                  key={i.InvitationId}
                  className="px-4 py-2 flex items-center gap-3"
                >
                  <Send className="h-4 w-4 text-gray-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {i.FormTitle || i.FormKind || 'Form invitation'}
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                      <span>Sent {formatSubmissionDateTime(i.CreatedDate)}</span>
                      <span>· {i.Mode}</span>
                      {i.SentToEmail && (
                        <span className="truncate">· to {i.SentToEmail}</span>
                      )}
                      {i.ExpiresAt && (
                        <span>· expires {formatDate(i.ExpiresAt)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleExtend(i.InvitationId)}
                      disabled={extendingId === i.InvitationId}
                      className="inline-flex items-center gap-1 text-xs text-oe-primary hover:bg-oe-light px-2 py-1 rounded disabled:opacity-50"
                      title="Push the expiry out by 7 days"
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      {extendingId === i.InvitationId ? 'Extending…' : 'Extend'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(i.InvitationId)}
                      disabled={revokingId === i.InvitationId}
                      className="inline-flex items-center gap-1 text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {revokingId === i.InvitationId ? 'Revoking…' : 'Revoke'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Documents table — only renders for SR folders. */}
        {activeFolderEntry?.kind === 'share-request' && (
          <div className="bg-white border border-gray-200 rounded-lg shadow-soft">
            {activeDocs.length === 0 ? (
              <div className="px-4 py-6 text-sm text-gray-500">
                No documents on file for this share request.
              </div>
            ) : (
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0 z-10">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                      Size
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                      Uploaded
                    </th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-100">
                  {activeDocs.map((d) => (
                    <tr
                      key={d.DocumentId}
                      className="text-sm transition-colors hover:bg-gray-50"
                    >
                      <td
                        className="px-4 py-2.5 text-gray-900 font-medium truncate"
                        title={d.DocumentName}
                      >
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-gray-400 shrink-0" />
                          <span className="truncate">
                            {d.DocumentName || d.FileName || 'Untitled'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-gray-700">
                        {d.DocumentType || ''}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700">
                        {formatSize(d.FileSize)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700">
                        {formatDate(d.CreatedDate)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {d.BlobUrl && (
                          <a
                            href={d.BlobUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-oe-primary hover:text-oe-dark hover:underline"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Open
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Form submissions section — applies inside the active folder. */}
        {activeSubmissions.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg shadow-soft">
            <header className="px-4 py-2 border-b border-gray-200 flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-oe-primary" />
              <h3 className="text-sm font-semibold text-gray-900">
                {activeFolderEntry?.kind === 'share-request'
                  ? 'Forms linked to this share request'
                  : 'All form submissions'}
              </h3>
              <span className="text-xs text-gray-500">
                ({activeSubmissions.length})
              </span>
            </header>
            <ul className="divide-y divide-gray-100">
              {activeSubmissionGroups.map((g) => {
                const isMulti = g.submissions.length > 1;
                const isExpanded = expandedSubmissionGroups.has(g.key);
                const latest = g.submissions[0];

                const renderRow = (
                  s: MemberFormSubmission,
                  isLatest: boolean
                ) => (
                  <div className="flex items-center gap-3">
                    <ClipboardList className="h-4 w-4 text-gray-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <Link
                        to={`/vendor/sharing-forms/submissions/${s.SubmissionId}`}
                        className="text-sm font-medium text-oe-primary hover:underline truncate block"
                      >
                        {s.FormTitle || s.FormKind || 'Form submission'}
                      </Link>
                      <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                        <span>{formatSubmissionDateTime(s.CreatedDate)}</span>
                        {isLatest && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-oe-light text-oe-dark">
                            Latest
                          </span>
                        )}
                        {/* In the consolidated folder, surface linkage so it's
                            clear where each submission belongs. SR folders
                            already have the SR as context. */}
                        {activeFolderEntry?.kind === 'all-forms' && (
                          <span>
                            ·{' '}
                            {s.RequestNumber
                              ? `linked to ${s.RequestNumber}`
                              : 'unlinked'}
                          </span>
                        )}
                        {s.AuthMode && <span>· {s.AuthMode}</span>}
                      </div>
                    </div>
                  </div>
                );

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
                          {latest.FormTitle || latest.FormKind || 'Form submission'}{' '}
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

        {/* Per-SR folder: if no docs, no submissions, no pending invitations,
            surface an explainer rather than an empty pane. */}
        {activeFolderEntry?.kind === 'share-request' &&
          activeDocs.length === 0 &&
          activeSubmissions.length === 0 &&
          activeInvitations.length === 0 && (
            <div className="bg-white border border-gray-200 rounded-lg shadow-soft px-4 py-6 text-sm text-gray-500">
              Nothing in this share request folder yet.
            </div>
          )}

        {activeFolderEntry?.kind === 'all-forms' &&
          activeSubmissions.length === 0 &&
          activeInvitations.length === 0 && (
            <div className="bg-white border border-gray-200 rounded-lg shadow-soft px-4 py-6 text-sm text-gray-500">
              No form submissions or pending invitations for this member yet.
            </div>
          )}
      </main>
    </div>
  );
};

export default MemberDocumentsTab;
