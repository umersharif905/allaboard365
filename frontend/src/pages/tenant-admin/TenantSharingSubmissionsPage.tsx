import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle,
  Download,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  apiService,
  getAuthHeadersWithTenant,
  withTenantScope,
} from '../../services/api.service';
import { API_CONFIG } from '../../config/api';
import { authService } from '../../services/auth.service';
import { usePublicFormsContext } from '../../hooks/usePublicFormsContext';
import {
  groupSubmissionsByInvitation,
  formatSubmissionDateTime,
} from '../../utils/formSubmissionGrouping';
import { hasSubmittedMemberId, resolutionStatus } from '../../utils/submissionStatus';

type Template = {
  FormTemplateId: string;
  Title: string;
};

type SubRow = {
  SubmissionId: string;
  FormTemplateId: string;
  FormKind: string;
  FormTitle?: string | null;
  CreatedDate: string;
  MemberId: string | null;
  MemberMatchStatus: string;
  SubmittedMemberIdText: string | null;
  ShareRequestId: string | null;
  CaseId: string | null;
  LinkedCaseId: string | null;
  AuthMode: string | null;
  InvitationId: string | null;
  LinkError: string | null;
  RequestNumber: string | null;
  CaseNumber: string | null;
  AnonymousLinkFirstViewedAt?: string | null;
  SecondsToLinkView?: number | null;
  PayloadFirstName?: string | null;
  PayloadLastName?: string | null;
  MemberFirstName?: string | null;
  MemberLastName?: string | null;
};

type ListResponse = {
  data: SubRow[];
  total: number;
  page: number;
  limit: number;
  nextCursor?: { createdDate: string; submissionId: string } | null;
};

type ResolutionFilter = 'all' | 'unresolved' | 'resolved-not-linked' | 'resolved-linked';
type SourceFilter = 'all' | 'anonymous' | 'targeted' | 'authenticated';

const PAGE_SIZES = [10, 25, 50, 100];

function normalizeSubmissionId(submissionId: unknown): string {
  return String(submissionId ?? '')
    .replace(/[{}]/g, '')
    .trim();
}

function isoDateInput(value: string): string {
  return value;
}

function isoStartOfDay(yyyyMmDd: string): string {
  return new Date(`${yyyyMmDd}T00:00:00`).toISOString();
}

function isoEndOfDay(yyyyMmDd: string): string {
  return new Date(`${yyyyMmDd}T23:59:59.999`).toISOString();
}

function defaultFromDate(): string {
  const d = new Date(Date.now() - 30 * 86400000);
  return d.toISOString().slice(0, 10);
}

function defaultToDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const SOURCE_CLASSES: Record<string, string> = {
  anonymous: 'bg-gray-100 text-gray-700 border-gray-200',
  targeted: 'bg-oe-light text-oe-dark border-oe-primary',
  authenticated: 'bg-green-50 text-green-800 border-green-200',
};

const SOURCE_LABELS: Record<string, string> = {
  anonymous: 'Public',
  targeted: 'Personal',
  authenticated: 'Secure',
};

/** Linked-to cell content — clickable share-request and/or case number, or em-dash. */
function LinkedToCell({
  requestNumber,
  caseId,
  caseNumber,
  shareRequestId
}: {
  requestNumber: string | null;
  caseId: string | null;
  caseNumber: string | null;
  shareRequestId: string | null;
}) {
  const links: ReactNode[] = [];
  if (requestNumber && shareRequestId) {
    links.push(
      <Link
        key="sr"
        to={`/share-requests/${shareRequestId}`}
        className="text-oe-primary hover:text-oe-dark hover:underline"
      >
        {requestNumber}
      </Link>
    );
  }
  if (caseId) {
    links.push(
      <Link
        key="case"
        to={`/vendor/cases/${caseId}`}
        className="text-oe-primary hover:text-oe-dark hover:underline"
      >
        {caseNumber ? `Case ${caseNumber}` : 'Case'}
      </Link>
    );
  }
  if (links.length === 0) return <span className="text-gray-400">—</span>;
  return <span className="inline-flex flex-wrap items-center gap-x-2">{links}</span>;
}

export default function TenantSharingSubmissionsPage() {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const tenantReq = useMemo(() => withTenantScope(activeTenantId), [activeTenantId]);
  const { apiBase, routeBase } = usePublicFormsContext();

  const [searchParams, setSearchParams] = useSearchParams();

  // Filter state is URL-driven so the care team can bookmark / share views.
  const dateFrom = searchParams.get('from') || defaultFromDate();
  const dateTo = searchParams.get('to') || defaultToDate();
  const formTemplateId = searchParams.get('formTemplateId') || '';
  const resolutionFilter =
    (searchParams.get('status') as ResolutionFilter | null) || 'unresolved';
  const sourceFilter = (searchParams.get('source') as SourceFilter | null) || 'all';
  const firstNameQ = searchParams.get('firstName') || '';
  const lastNameQ = searchParams.get('lastName') || '';
  const keyword = searchParams.get('q') || '';
  const page = Math.max(parseInt(searchParams.get('page') || '1', 10) || 1, 1);
  const pageSize = (() => {
    const p = parseInt(searchParams.get('pageSize') || '25', 10);
    return PAGE_SIZES.includes(p) ? p : 25;
  })();

  // Local input state for non-immediate fields. Search button commits.
  const [pendingFirstName, setPendingFirstName] = useState(firstNameQ);
  const [pendingLastName, setPendingLastName] = useState(lastNameQ);
  const [pendingKeyword, setPendingKeyword] = useState(keyword);
  useEffect(() => {
    setPendingFirstName(firstNameQ);
    setPendingLastName(lastNameQ);
    setPendingKeyword(keyword);
  }, [firstNameQ, lastNameQ, keyword]);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [rows, setRows] = useState<SubRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const updateFilter = (updates: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === '') next.delete(k);
        else next.set(k, v);
      }
      // Reset to page 1 on any filter change (page kept only when changing page).
      if (!('page' in updates)) next.delete('page');
      return next;
    });
  };

  const resetFilters = () => {
    setSearchParams(new URLSearchParams());
    setPendingFirstName('');
    setPendingLastName('');
    setPendingKeyword('');
  };

  const loadTemplates = useCallback(async () => {
    const tRes = await apiService.get<{ success: boolean; data: Template[] }>(
      `${apiBase}/templates`,
      tenantReq
    );
    if (tRes.success) setTemplates(tRes.data || []);
  }, [tenantReq, apiBase]);

  const buildQuery = useCallback(
    (pageIndex: number, pageSizeArg: number) => {
      const params = new URLSearchParams();
      params.set('page', String(pageIndex));
      params.set('limit', String(pageSizeArg));
      if (dateFrom) params.set('from', isoStartOfDay(dateFrom));
      if (dateTo) params.set('to', isoEndOfDay(dateTo));
      if (formTemplateId) params.set('formTemplateId', formTemplateId);
      if (resolutionFilter && resolutionFilter !== 'all') {
        params.set('resolutionStatus', resolutionFilter);
      }
      if (sourceFilter && sourceFilter !== 'all') params.set('source', sourceFilter);
      if (firstNameQ.trim()) params.set('firstName', firstNameQ.trim());
      if (lastNameQ.trim()) params.set('lastName', lastNameQ.trim());
      if (keyword.trim()) params.set('q', keyword.trim());
      return params.toString();
    },
    [dateFrom, dateTo, formTemplateId, resolutionFilter, sourceFilter, firstNameQ, lastNameQ, keyword]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = buildQuery(page, pageSize);
      const sRes = await apiService.get<{ success: boolean; data: ListResponse }>(
        `${apiBase}/submissions?${qs}`,
        tenantReq
      );
      if (!sRes.success || !sRes.data) {
        setErr('Failed to load submissions');
        return;
      }
      setRows(sRes.data.data || []);
      setTotal(Number(sRes.data.total) || 0);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [buildQuery, page, pageSize, apiBase, tenantReq]);

  useEffect(() => {
    loadTemplates().catch(() => {});
  }, [loadTemplates]);

  useEffect(() => {
    load();
  }, [load]);

  const runSearch = () => {
    updateFilter({
      firstName: pendingFirstName.trim() || null,
      lastName: pendingLastName.trim() || null,
      q: pendingKeyword.trim() || null,
    });
  };

  const exportCsv = async () => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('from', isoStartOfDay(dateFrom));
    if (dateTo) params.set('to', isoEndOfDay(dateTo));
    if (formTemplateId) params.set('formTemplateId', formTemplateId);
    if (resolutionFilter && resolutionFilter !== 'all') {
      params.set('resolutionStatus', resolutionFilter);
    }
    if (sourceFilter && sourceFilter !== 'all') params.set('source', sourceFilter);
    if (firstNameQ.trim()) params.set('firstName', firstNameQ.trim());
    if (lastNameQ.trim()) params.set('lastName', lastNameQ.trim());
    if (keyword.trim()) params.set('q', keyword.trim());
    params.set('maxRows', '25000');
    const token = await authService.getAccessToken();
    const url = `${API_CONFIG.BASE_URL}${apiBase}/submissions/export?${params.toString()}`;
    const res = await globalThis.fetch(url, {
      headers: getAuthHeadersWithTenant(token, activeTenantId),
    });
    if (!res.ok) {
      setErr('Export failed');
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'public-form-submissions.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    setSuccessMsg('CSV exported.');
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submissionGroups = useMemo(() => groupSubmissionsByInvitation(rows), [rows]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Form submissions</h1>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-1.5 border border-gray-300 bg-white px-3 py-1.5 rounded text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Download className="h-4 w-4" /> Export CSV
        </button>
      </div>

      {successMsg && (
        <div className="rounded border border-green-200 bg-green-50 text-green-800 px-3 py-2 text-sm flex items-start gap-2">
          <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">{successMsg}</div>
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            className="text-green-700 hover:text-green-900"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {err && (
        <div className="rounded border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-sm flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">{err}</div>
          <button
            type="button"
            onClick={() => setErr(null)}
            className="text-red-700 hover:text-red-900"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Filter bar */}
      <div className="bg-white border border-gray-200 rounded-lg p-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-gray-600 mb-0.5">From</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => updateFilter({ from: isoDateInput(e.target.value) })}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-0.5">To</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => updateFilter({ to: isoDateInput(e.target.value) })}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-0.5">Form</span>
          <select
            value={formTemplateId}
            onChange={(e) => updateFilter({ formTemplateId: e.target.value || null })}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm min-w-[180px]"
          >
            <option value="">All forms</option>
            {templates.map((t) => (
              <option key={t.FormTemplateId} value={t.FormTemplateId}>
                {t.Title}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-0.5">Resolution</span>
          <select
            value={resolutionFilter}
            onChange={(e) => updateFilter({ status: e.target.value })}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="unresolved">Needs attention</option>
            <option value="resolved-not-linked">Resolved · not linked</option>
            <option value="resolved-linked">Resolved · linked</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-0.5">Source</span>
          <select
            value={sourceFilter}
            onChange={(e) => updateFilter({ source: e.target.value === 'all' ? null : e.target.value })}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="anonymous">Public</option>
            <option value="targeted">Personal (no login)</option>
            <option value="authenticated">Secure (requires login)</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-0.5">First name</span>
          <input
            type="text"
            value={pendingFirstName}
            onChange={(e) => setPendingFirstName(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-0.5">Last name</span>
          <input
            type="text"
            value={pendingLastName}
            onChange={(e) => setPendingLastName(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm flex-1 min-w-[200px]">
          <span className="block text-gray-600 mb-0.5">Keyword in answers</span>
          <input
            type="text"
            value={pendingKeyword}
            onChange={(e) => setPendingKeyword(e.target.value)}
            placeholder="searches name + answers + member ID"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
          />
        </label>
        <div className="flex items-center gap-2 self-end">
          <button
            type="button"
            onClick={runSearch}
            className="inline-flex items-center gap-1.5 bg-oe-primary hover:bg-oe-dark text-white text-sm font-medium px-3 py-1.5 rounded"
          >
            <Search className="h-3.5 w-3.5" /> Search
          </button>
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex items-center gap-1.5 border border-gray-300 text-gray-700 text-sm font-medium px-3 py-1.5 rounded hover:bg-gray-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : submissionGroups.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            No submissions match the current filters.
          </div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-700 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Submitted</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Form</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Source</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Member</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-center">Status</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider">Linked to</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-center">Member ID</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {submissionGroups.map((g) => {
                const isMulti = g.submissions.length > 1;
                const isExpanded = expandedGroups.has(g.key);
                const rowsToShow: { sub: SubRow; isLatest: boolean; nested: boolean }[] = [];

                if (!isMulti) {
                  rowsToShow.push({ sub: g.submissions[0], isLatest: false, nested: false });
                } else {
                  rowsToShow.push({ sub: g.submissions[0], isLatest: false, nested: false });
                  if (isExpanded) {
                    for (let idx = 0; idx < g.submissions.length; idx++) {
                      rowsToShow.push({
                        sub: g.submissions[idx],
                        isLatest: idx === 0,
                        nested: true,
                      });
                    }
                  }
                }

                return rowsToShow.map(({ sub: s, isLatest, nested }, idx) => {
                  const sid = normalizeSubmissionId(s.SubmissionId);
                  const isParentRow = isMulti && idx === 0;
                  if (isParentRow) {
                    return (
                      <tr
                        key={`${g.key}-parent`}
                        className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => toggleGroup(g.key)}
                      >
                        <td className="px-3 py-2 text-gray-700 border-l-4 border-transparent">
                          {formatSubmissionDateTime(s.CreatedDate)}
                        </td>
                        <td className="px-3 py-2 text-gray-900 font-medium" colSpan={6}>
                          {s.FormTitle || 'Form submission'}{' '}
                          <span className="text-gray-500 font-normal">
                            — {g.submissions.length} submissions ({isExpanded ? 'collapse' : 'expand'})
                          </span>
                        </td>
                        <td className="px-3 py-2"></td>
                      </tr>
                    );
                  }

                  // Prefer the resolved member's profile name (targeted /
                  // authenticated submissions don't populate the payload
                  // name fields). Fall back to payload, then em-dash.
                  const memberName =
                    [s.MemberFirstName, s.MemberLastName].filter(Boolean).join(' ').trim() ||
                    [s.PayloadFirstName, s.PayloadLastName].filter(Boolean).join(' ').trim() ||
                    '—';
                  const status = resolutionStatus(s);
                  const memberIdProvided = hasSubmittedMemberId(s);
                  const sourceLabel = (s.AuthMode || 'anonymous').toLowerCase();
                  const accentCls = status.needsAttention
                    ? 'border-l-4 border-amber-400'
                    : 'border-l-4 border-transparent';
                  return (
                    <tr
                      key={sid}
                      className={`hover:bg-gray-50 ${nested ? 'bg-gray-50/50' : ''}`}
                    >
                      <td className={`px-3 py-2 text-gray-700 ${nested ? 'pl-8' : ''} ${accentCls}`}>
                        <span>{formatSubmissionDateTime(s.CreatedDate)}</span>
                        {isLatest && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-oe-light text-oe-dark">
                            Latest
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1">
                          <span className="text-gray-900">{s.FormTitle || '—'}</span>
                          <Link
                            to={`${routeBase}/template/${s.FormTemplateId}/preview`}
                            onClick={(e) => e.stopPropagation()}
                            title="Open the form (preview)"
                            className="text-gray-400 hover:text-oe-primary"
                          >
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </Link>
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                            SOURCE_CLASSES[sourceLabel] || SOURCE_CLASSES.anonymous
                          }`}
                          title={
                            sourceLabel === 'authenticated' ? 'Requires login'
                            : sourceLabel === 'targeted' ? 'No login required'
                            : 'Anyone with the link can fill this form'
                          }
                        >
                          {SOURCE_LABELS[sourceLabel] || SOURCE_LABELS.anonymous}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-900">{memberName}</td>
                      <td className="px-3 py-2 text-center">
                        <span title={status.label} className="inline-flex">
                          {status.isResolved ? (
                            <CheckCircle
                              className="h-4 w-4 text-green-600"
                              aria-label={status.label}
                            />
                          ) : (
                            <AlertTriangle
                              className="h-4 w-4 text-amber-500"
                              aria-label={status.label}
                            />
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <LinkedToCell
                          requestNumber={s.RequestNumber}
                          caseId={s.CaseId || s.LinkedCaseId}
                          caseNumber={s.CaseNumber}
                          shareRequestId={s.ShareRequestId}
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span
                          title={
                            memberIdProvided
                              ? `Member ID provided: ${s.SubmittedMemberIdText}`
                              : 'No member ID provided'
                          }
                          className="inline-flex"
                        >
                          {memberIdProvided ? (
                            <Check
                              className="h-4 w-4 text-green-600"
                              aria-label="Member ID provided"
                            />
                          ) : (
                            <X
                              className="h-4 w-4 text-gray-300"
                              aria-label="No member ID provided"
                            />
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          to={`${routeBase}/submissions/${sid}`}
                          className="inline-flex items-center bg-oe-primary hover:bg-oe-dark text-white text-xs font-medium px-3 py-1.5 rounded"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-700">
        <div>
          Page {page} of {pageCount} · {total} total
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span>Rows</span>
            <select
              value={pageSize}
              onChange={(e) => updateFilter({ pageSize: e.target.value, page: '1' })}
              className="border border-gray-300 rounded px-2 py-1 text-sm"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => updateFilter({ page: String(Math.max(1, page - 1)) })}
            disabled={page <= 1}
            className="border border-gray-300 px-2 py-1 rounded hover:bg-gray-50 disabled:opacity-50"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => updateFilter({ page: String(Math.min(pageCount, page + 1)) })}
            disabled={page >= pageCount}
            className="border border-gray-300 px-2 py-1 rounded hover:bg-gray-50 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
