import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  CopyPlus,
  Edit3,
  ExternalLink,
  Eye,
  ListChecks,
  MoreVertical,
  Plus,
  Power,
  Search,
  Send,
  Trash2,
} from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, withTenantScope } from '../../services/api.service';
import { usePublicFormsContext } from '../../hooks/usePublicFormsContext';
import { SendToMemberModal } from '../../components/tenant-admin/public-form-builder/SendToMemberModal';
import { copyToClipboard } from '../../utils/clipboard';

type Template = {
  FormTemplateId: string;
  FormKind: string;
  Title: string;
  IsPublished: boolean;
  PublishedVersion: number | null;
  NotifyEmails: string;
  KindLabel?: string | null;
  /** SQL bit may deserialize as boolean or 0/1 */
  IsActive?: boolean | number | null;
  AllowAnonymous?: boolean | number | null;
  AllowTargeted?: boolean | number | null;
  AllowAuthenticated?: boolean | number | null;
  CreatesShareRequestOnSubmit?: boolean | number | null;
  CreatesCaseOnSubmit?: boolean | number | null;
  ModifiedDate?: string | null;
  CreatedDate?: string | null;
  SubmissionCount?: number;
  ActiveInvitationCount?: number;
};

type StatusFilter = 'active' | 'inactive' | 'all';
type DeliveryMode = 'anonymous' | 'targeted' | 'authenticated';

const ALL_MODES: DeliveryMode[] = ['anonymous', 'targeted', 'authenticated'];

const MODE_LABELS: Record<DeliveryMode, string> = {
  anonymous: 'Public',
  targeted: 'Personal',
  authenticated: 'Secure',
};

function normalizeGuid(s: string | undefined | null): string {
  return String(s ?? '')
    .replace(/[{}]/g, '')
    .trim()
    .toLowerCase();
}

function formatRelative(raw: string | null | undefined): string {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'Updated just now';
  if (diff < 3_600_000) {
    const m = Math.floor(diff / 60_000);
    return `Updated ${m}m ago`;
  }
  const day = 86_400_000;
  if (diff < day) {
    const h = Math.floor(diff / 3_600_000);
    return `Updated ${h}h ago`;
  }
  const days = Math.floor(diff / day);
  if (days < 30) return `Updated ${days}d ago`;
  if (days < 365) return `Updated ${Math.floor(days / 30)}mo ago`;
  return `Updated ${Math.floor(days / 365)}y ago`;
}

function templateHasMode(t: Template, mode: DeliveryMode): boolean {
  if (mode === 'anonymous') return t.AllowAnonymous == null || Boolean(t.AllowAnonymous);
  if (mode === 'targeted') return Boolean(t.AllowTargeted);
  return Boolean(t.AllowAuthenticated);
}

export default function TenantSharingFormsPage() {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const tenantReq = useMemo(() => withTenantScope(activeTenantId), [activeTenantId]);
  const { apiBase, routeBase, membersApiBase, canDelete, canEdit } = usePublicFormsContext();
  const navigate = useNavigate();
  const [savedSearchParams, setSavedSearchParams] = useSearchParams();
  const savedVersion = savedSearchParams.get('saved');

  const [templates, setTemplates] = useState<Template[]>([]);
  const [resolvedMeta, setResolvedMeta] = useState<{
    tenantId?: string;
    tenantName?: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendModalTemplate, setSendModalTemplate] = useState<Template | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [modeFilter, setModeFilter] = useState<Set<DeliveryMode>>(new Set(ALL_MODES));
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Clear the ?saved= banner after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!savedVersion) return;
    const t = setTimeout(() => {
      setSavedSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('saved');
          return next;
        },
        { replace: true }
      );
    }, 4000);
    return () => clearTimeout(t);
  }, [savedVersion, setSavedSearchParams]);

  // Close the kebab menu on outside click.
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openMenuId) return;
    const handler = (e: MouseEvent) => {
      if (!menuContainerRef.current) return;
      if (!menuContainerRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openMenuId]);

  const loadTemplates = useCallback(async () => {
    setErr(null);
    const tRes = await apiService.get<{
      success: boolean;
      data: Template[];
      meta?: { tenantId?: string; tenantName?: string | null };
    }>(`${apiBase}/templates`, tenantReq);
    if (tRes.success) {
      setTemplates(tRes.data || []);
      setResolvedMeta(tRes.meta || null);
    }
  }, [tenantReq, apiBase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        await loadTemplates();
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTemplates]);

  // B-027: clicking "+ New form" creates a stub draft and immediately
  // takes the user to the editor where they rename + author. Skips the
  // inline title-prompt step entirely.
  const createForm = async () => {
    setErr(null);
    setCreating(true);
    try {
      // Backend still requires kindLabel; derive from the default title
      // until the editor redesign retires Kind from authoring entirely.
      const title = 'Untitled form';
      const res = await apiService.post<{ success: boolean; data?: { formTemplateId: string } }>(
        `${apiBase}/templates`,
        { title, kindLabel: title },
        tenantReq
      );
      if (!res.success || !res.data?.formTemplateId) {
        setErr('Could not create form');
        return;
      }
      // Mark the navigation as a fresh "+ New form" landing so the editor
      // can offer a Discard affordance for the I-clicked-this-by-accident case.
      navigate(`${routeBase}/template/${res.data.formTemplateId}`, {
        state: { justCreated: true }
      });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to create form');
    } finally {
      setCreating(false);
    }
  };

  const setActive = async (t: Template, next: boolean) => {
    setErr(null);
    setBusyId(t.FormTemplateId);
    setOpenMenuId(null);
    try {
      await apiService.patch(
        `${apiBase}/templates/${t.FormTemplateId}`,
        { isActive: next },
        tenantReq
      );
      await loadTemplates();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setBusyId(null);
    }
  };

  const removeTemplate = async (t: Template) => {
    setOpenMenuId(null);
    const ok = window.confirm(
      `Delete “${t.Title || 'Untitled'}”? This cannot be undone. Forms with submissions cannot be deleted.`
    );
    if (!ok) return;
    setErr(null);
    setBusyId(t.FormTemplateId);
    try {
      await apiService.delete(`${apiBase}/templates/${t.FormTemplateId}`, tenantReq);
      await loadTemplates();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  // Duplicate a form: copies all settings + the latest definition into a new
  // unpublished draft titled "<original> (Copy)". Stays on the list and
  // refreshes so the copy appears in place.
  const duplicateForm = async (t: Template) => {
    setOpenMenuId(null);
    setErr(null);
    setBusyId(t.FormTemplateId);
    try {
      const res = await apiService.post<{ success: boolean; data?: { formTemplateId: string } }>(
        `${apiBase}/templates/${t.FormTemplateId}/duplicate`,
        {},
        tenantReq
      );
      if (!res.success || !res.data?.formTemplateId) {
        setErr('Could not duplicate form');
        return;
      }
      await loadTemplates();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to duplicate form');
    } finally {
      setBusyId(null);
    }
  };

  const copyShareLink = async (t: Template) => {
    setOpenMenuId(null);
    const ok = await copyToClipboard(`${base}/forms/${t.FormTemplateId}`);
    if (ok) {
      setCopiedId(t.FormTemplateId);
      setTimeout(() => setCopiedId((id) => (id === t.FormTemplateId ? null : id)), 1500);
    }
  };

  const base =
    (typeof window !== 'undefined' && `${window.location.protocol}//${window.location.host}`) || '';

  const storedTenantId =
    typeof window !== 'undefined'
      ? window.localStorage.getItem('currentTenantId') || window.localStorage.getItem('tenantId')
      : null;
  const tenantMismatch =
    resolvedMeta?.tenantId &&
    storedTenantId &&
    normalizeGuid(resolvedMeta.tenantId) !== normalizeGuid(storedTenantId);

  const visibleTemplates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = templates.filter((t) => {
      if (q && !(t.Title || '').toLowerCase().includes(q)) return false;
      const raw = t.IsActive;
      const isActive = raw == null || Boolean(raw);
      if (statusFilter === 'active' && !isActive) return false;
      if (statusFilter === 'inactive' && isActive) return false;
      const matchesAnyMode = ALL_MODES.some(
        (m) => modeFilter.has(m) && templateHasMode(t, m)
      );
      if (!matchesAnyMode) return false;
      return true;
    });
    // Default sort: forms that spawn a share request first (the headline intake
    // forms), then forms that spawn a case, then by submission count descending
    // (proxy for "how often this form is used"), then title as a stable tiebreaker.
    const sorted = [...filtered].sort((a, b) => {
      const aSr = a.CreatesShareRequestOnSubmit ? 1 : 0;
      const bSr = b.CreatesShareRequestOnSubmit ? 1 : 0;
      if (aSr !== bSr) return bSr - aSr;
      const aCase = a.CreatesCaseOnSubmit ? 1 : 0;
      const bCase = b.CreatesCaseOnSubmit ? 1 : 0;
      if (aCase !== bCase) return bCase - aCase;
      const aCount = a.SubmissionCount ?? 0;
      const bCount = b.SubmissionCount ?? 0;
      if (aCount !== bCount) return bCount - aCount;
      return (a.Title || '').localeCompare(b.Title || '');
    });
    return sorted;
  }, [templates, searchQuery, statusFilter, modeFilter]);

  const toggleMode = (m: DeliveryMode) => {
    setModeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };

  if (loading) {
    return <div className="p-6 text-gray-600">Loading…</div>;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {savedVersion && (
        <div className="rounded border border-green-200 bg-green-50 text-green-800 px-3 py-2 text-sm flex items-center gap-2">
          <Check className="h-4 w-4" />
          <span>Saved and published version {savedVersion}.</span>
        </div>
      )}
      {err && <p className="text-red-600 text-sm">{err}</p>}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Forms</h1>
          {resolvedMeta?.tenantName && (
            <p className="text-sm text-gray-600">
              Showing forms for{' '}
              <span className="font-medium text-gray-800">{resolvedMeta.tenantName}</span>
            </p>
          )}
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={createForm}
            disabled={creating}
            className="inline-flex items-center gap-1.5 bg-oe-primary hover:bg-oe-dark disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5 rounded"
          >
            <Plus className="h-4 w-4" />
            {creating ? 'Creating…' : 'New form'}
          </button>
        )}
      </div>

      {tenantMismatch ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Active tenant in this browser does not match the server response. Try switching tenant
          again or refresh the page.
        </p>
      ) : null}

      <SendToMemberModal
        open={sendModalTemplate !== null}
        onClose={() => setSendModalTemplate(null)}
        apiBase={apiBase}
        membersApiBase={membersApiBase}
        tenantId={activeTenantId}
        template={sendModalTemplate || { FormTemplateId: '', Title: '' }}
      />

      <section className="space-y-3">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3 bg-white border border-gray-200 rounded-lg p-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title"
              className="w-full border border-gray-300 rounded pl-9 pr-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary"
            />
          </div>
          <label className="text-sm flex items-center gap-2">
            <span className="text-gray-600">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-600">Mode</span>
            {ALL_MODES.map((m) => {
              const on = modeFilter.has(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleMode(m)}
                  title={
                    m === 'authenticated' ? 'Requires login'
                    : m === 'targeted' ? 'No login required'
                    : 'Anyone with the link can fill this form'
                  }
                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                    on
                      ? 'bg-oe-light text-oe-dark border-oe-primary'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {MODE_LABELS[m]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Template rows */}
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {visibleTemplates.length === 0 ? (
            <div className="px-4 py-8 text-sm text-gray-500 text-center">
              No forms match the current filters.
            </div>
          ) : (
            visibleTemplates.map((t) => {
              const raw = t.IsActive;
              const isActive = raw == null || Boolean(raw);
              const rowBusy = busyId === t.FormTemplateId;
              const isExpanded = expandedRowId === t.FormTemplateId;
              const isMenuOpen = openMenuId === t.FormTemplateId;
              const allowAnon = t.AllowAnonymous == null || Boolean(t.AllowAnonymous);
              const allowTargeted = Boolean(t.AllowTargeted);
              const allowAuth = Boolean(t.AllowAuthenticated);
              const createsSr = Boolean(t.CreatesShareRequestOnSubmit);
              const createsCase = Boolean(t.CreatesCaseOnSubmit);
              const canSendToMember = (allowTargeted || allowAuth) && t.IsPublished;
              const publicFormUrl = `${base}/forms/${t.FormTemplateId}`;
              const previewHref = `${routeBase}/template/${t.FormTemplateId}/preview`;
              const editHref = `${routeBase}/template/${t.FormTemplateId}`;
              const submissionCount = t.SubmissionCount ?? 0;
              const invitationCount = t.ActiveInvitationCount ?? 0;

              return (
                <div
                  key={t.FormTemplateId}
                  className={`px-3 py-3 ${!isActive ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRowId((id) =>
                          id === t.FormTemplateId ? null : t.FormTemplateId
                        )
                      }
                      className="text-gray-400 hover:text-gray-600 mt-0.5"
                      aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                      aria-expanded={isExpanded}
                    >
                      <ChevronRight
                        className={`h-4 w-4 transition-transform ${
                          isExpanded ? 'rotate-90' : ''
                        }`}
                      />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <Link
                            to={previewHref}
                            className="text-base font-semibold text-gray-900 hover:text-oe-dark hover:underline truncate block"
                          >
                            {t.Title || 'Untitled form'}
                          </Link>
                          <div className="text-xs text-gray-500 flex flex-wrap items-center gap-1.5 mt-0.5">
                            {!isActive && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700">
                                Inactive
                              </span>
                            )}
                            {!t.IsPublished && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
                                Draft
                              </span>
                            )}
                            {t.IsPublished && (
                              <span className="text-[11px] text-gray-500">
                                v{t.PublishedVersion}
                              </span>
                            )}
                            {/* Mode badges */}
                            {allowAnon && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700"
                                title="Anyone with the link can fill this form"
                              >
                                Public
                              </span>
                            )}
                            {allowTargeted && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700"
                                title="No login required"
                              >
                                Personal
                              </span>
                            )}
                            {allowAuth && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700"
                                title="Requires login"
                              >
                                Secure
                              </span>
                            )}
                            {/* Warning badges */}
                            {createsSr && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-200"
                                title="Submissions to this form spawn a share request automatically."
                              >
                                <AlertTriangle className="h-2.5 w-2.5" />
                                Spawns SR
                              </span>
                            )}
                            {createsCase && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-oe-light text-oe-dark border border-oe-primary"
                                title="Submissions to this form spawn a reimbursement case automatically."
                              >
                                <AlertTriangle className="h-2.5 w-2.5" />
                                Spawns case
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {submissionCount} submission{submissionCount === 1 ? '' : 's'} ·{' '}
                            <Link
                              to={`${routeBase}/template/${t.FormTemplateId}/invitations`}
                              className="text-oe-primary hover:underline"
                            >
                              {invitationCount} active invitation
                              {invitationCount === 1 ? '' : 's'}
                            </Link>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-xs text-gray-500 whitespace-nowrap mr-2">
                            {formatRelative(t.ModifiedDate || t.CreatedDate)}
                          </span>
                          {/* B-010 + B-025: fixed-width slots for View / Send /
                              Copy so missing actions leave a placeholder
                              instead of shifting siblings. Care team's eyes
                              learn the right side: View | Send | Copy. */}
                          <div className="w-[72px] flex justify-start">
                            <Link
                              to={previewHref}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-700 hover:bg-gray-100"
                              title="View (preview)"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">View</span>
                            </Link>
                          </div>
                          <div className="w-[72px] flex justify-start">
                            {canSendToMember ? (
                              <button
                                type="button"
                                onClick={() => setSendModalTemplate(t)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-oe-primary hover:bg-oe-light"
                                title="Send to member"
                              >
                                <Send className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">Send</span>
                              </button>
                            ) : (
                              <span aria-hidden className="invisible select-none px-2 py-1 text-xs">
                                Send
                              </span>
                            )}
                          </div>
                          <div className="w-[80px] flex justify-start">
                            {allowAnon ? (
                              <button
                                type="button"
                                onClick={() => copyShareLink(t)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-700 hover:bg-gray-100"
                                title="Copy share link"
                              >
                                {copiedId === t.FormTemplateId ? (
                                  <>
                                    <Check className="h-3.5 w-3.5 text-oe-success" />
                                    <span className="hidden sm:inline">Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3.5 w-3.5" />
                                    <span className="hidden sm:inline">Copy</span>
                                  </>
                                )}
                              </button>
                            ) : (
                              <span aria-hidden className="invisible select-none px-2 py-1 text-xs">
                                Copy
                              </span>
                            )}
                          </div>
                          <div className="relative" ref={isMenuOpen ? menuContainerRef : undefined}>
                            <button
                              type="button"
                              onClick={() =>
                                setOpenMenuId((id) =>
                                  id === t.FormTemplateId ? null : t.FormTemplateId
                                )
                              }
                              className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-50"
                              aria-label="More actions"
                              aria-expanded={isMenuOpen}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                            {isMenuOpen && (
                              <div className="absolute right-0 mt-1 w-56 bg-white rounded-md shadow-lg ring-1 ring-black ring-opacity-5 z-10 py-1">
                                {/* B-010: View / Send / Copy moved out to direct
                                    row buttons. Kebab keeps the longer-tail
                                    actions. */}
                                {allowAnon && (
                                  <a
                                    href={publicFormUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => setOpenMenuId(null)}
                                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" /> Open share link in new tab
                                  </a>
                                )}
                                <Link
                                  to={`${routeBase}/template/${t.FormTemplateId}/invitations`}
                                  onClick={() => setOpenMenuId(null)}
                                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                                >
                                  <ListChecks className="h-3.5 w-3.5" /> View invitations
                                </Link>
                                {canEdit && (
                                  <>
                                    <div className="border-t border-gray-100 my-1" />
                                    <Link
                                      to={editHref}
                                      onClick={() => setOpenMenuId(null)}
                                      className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                                    >
                                      <Edit3 className="h-3.5 w-3.5" /> Edit
                                    </Link>
                                    <button
                                      type="button"
                                      disabled={rowBusy}
                                      onClick={() => setActive(t, !isActive)}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 text-left disabled:opacity-50"
                                    >
                                      <Power className="h-3.5 w-3.5" />
                                      {isActive ? 'Deactivate' : 'Activate'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={rowBusy}
                                      onClick={() => duplicateForm(t)}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 text-left disabled:opacity-50"
                                    >
                                      <CopyPlus className="h-3.5 w-3.5" /> Duplicate
                                    </button>
                                  </>
                                )}
                                {canDelete && (
                                  <>
                                    <div className="border-t border-gray-100 my-1" />
                                    <button
                                      type="button"
                                      disabled={rowBusy}
                                      onClick={() => removeTemplate(t)}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 text-left disabled:opacity-50"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" /> Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mt-3 ml-0 space-y-2 text-xs">
                          {allowAnon ? (
                            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                              <code className="block bg-gray-100 px-2 py-1 rounded break-all text-gray-800 min-w-0 flex-1">
                                {publicFormUrl}
                              </code>
                              <button
                                type="button"
                                onClick={() => copyShareLink(t)}
                                className="inline-flex shrink-0 items-center gap-1 self-start border border-gray-300 bg-white px-2 py-1 rounded text-xs font-medium text-gray-700 hover:bg-gray-50"
                              >
                                {copiedId === t.FormTemplateId ? (
                                  <>
                                    <Check className="h-3 w-3 text-oe-success" /> Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3 w-3" /> Copy
                                  </>
                                )}
                              </button>
                            </div>
                          ) : (
                            <p className="text-gray-500 italic">Public link disabled.</p>
                          )}
                          {createsSr && (
                            <p className="text-amber-800">
                              Submissions to this form spawn a fresh share request automatically.
                            </p>
                          )}
                          {createsCase && (
                            <p className="text-oe-dark">
                              Submissions to this form spawn a fresh reimbursement case automatically.
                            </p>
                          )}
                          {invitationCount > 0 && (
                            <p className="text-gray-600">
                              {invitationCount} active invitation
                              {invitationCount === 1 ? '' : 's'} outstanding.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
