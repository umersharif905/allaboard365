// CaseListRail — left-side list of case for the vendor.
// Mirrors ShareRequestListRail but simpler: no determination / request type /
// claimer dropdown — just claim tab strip, search, status filter, date range,
// inline Claim button on each card.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Filter,
  Plus,
  Search,
  Settings as SettingsIcon,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { useAuth } from '../../../contexts/AuthContext';
import {
  type CaseRow,
  type CaseStatus,
  CASE_STATUSES,
  STATUS_COLORS,
} from '../../../types/case.types';
import { getUserColorStyle } from '../../../types/userColor';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';

export type ClaimTab = 'unclaimed' | 'claimed' | 'all';

export interface CaseRailFilters {
  q: string;
  status?: CaseStatus;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  claimTab: ClaimTab;
}

interface ListResp {
  success: boolean;
  data: CaseRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface CaseListRailProps {
  selectedId: string | undefined;
  onSelect: (caseId: string) => void;
  filters: CaseRailFilters;
  onFiltersChange: (next: CaseRailFilters) => void;
  /** Bumped by the workspace when claim / status / create mutations occur. */
  refreshVersion: number;
  /** Called after the rail performs a claim or create so other panels re-fetch. */
  /** Opens the New Case modal — controlled by the workspace. */
  onNewCase: () => void;
  /** VendorAdmin only — navigates to /vendor/cases/settings. Hidden when undefined. */
  onOpenSettings?: () => void;
  className?: string;
}

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
};

const CaseListRail = ({
  selectedId,
  onSelect,
  filters,
  onFiltersChange,
  refreshVersion,
  onNewCase,
  onOpenSettings,
  className = '',
}: CaseListRailProps) => {
  const { user } = useAuth();
  const currentUserId = user?.userId;

  const [rows, setRows] = useState<CaseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [debouncedSearch, setDebouncedSearch] = useState(filters.q);

  useEffect(() => {
    setSearchInput(filters.q);
  }, [filters.q]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (debouncedSearch === filters.q) return;
    onFiltersChange({ ...filters, q: debouncedSearch, page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const params = new URLSearchParams();
        if (filters.q) params.set('q', filters.q);
        if (filters.status) params.set('status', filters.status);
        if (filters.from) params.set('from', filters.from);
        if (filters.to) params.set('to', filters.to);
        params.set('page', String(filters.page));
        params.set('limit', String(filters.limit));
        if (filters.claimTab === 'unclaimed') params.set('claimed', 'false');
        else if (filters.claimTab === 'claimed') params.set('claimed', 'true');

        const resp = await apiService.get<ListResp>(
          `/api/me/vendor/cases?${params.toString()}`,
          { signal: ac.signal }
        );
        if (cancelled || ac.signal.aborted) return;
        if (resp.success) {
          setRows(resp.data);
          setTotal(resp.pagination.total);
          setTotalPages(resp.pagination.totalPages);
        } else {
          setError('Failed to load cases');
        }
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load cases');
      } finally {
        if (!cancelled && !ac.signal.aborted) setLoading(false);
      }
    })();

    return () => { cancelled = true; ac.abort(); };
  }, [
    filters.q, filters.status, filters.from, filters.to,
    filters.page, filters.limit, filters.claimTab,
    refreshVersion,
  ]);

  const hasActiveChips = useMemo(
    () => Boolean(filters.status || filters.from || filters.to),
    [filters.status, filters.from, filters.to]
  );

  const clearChips = useCallback(() => {
    onFiltersChange({
      ...filters, status: undefined, from: undefined, to: undefined, page: 1,
    });
  }, [filters, onFiltersChange]);

  const setPage = useCallback(
    (page: number) => onFiltersChange({ ...filters, page }),
    [filters, onFiltersChange]
  );

  const setClaimTab = useCallback((tab: ClaimTab) => {
    onFiltersChange({ ...filters, claimTab: tab, page: 1 });
  }, [filters, onFiltersChange]);

  return (
    <aside
      className={`flex flex-col w-full md:w-72 md:min-w-72 md:max-w-72 lg:w-80 lg:min-w-80 lg:max-w-80 border-r border-gray-200 bg-white min-h-0 ${className}`}
    >
      {/* Header with New Case button + Settings (VendorAdmin only) */}
      <div className="p-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-oe-primary" />
          <h2 className="text-sm font-semibold text-gray-900">Cases</h2>
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="Support ticket settings"
              title="Settings (admin)"
              className="p-1.5 text-gray-500 hover:text-oe-dark hover:bg-oe-light/40 rounded-md"
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onNewCase}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
        </div>
      </div>

      {/* Claim tab strip */}
      <div className="p-3 border-b border-gray-200">
        <div role="tablist" aria-label="Assignment filter" className="inline-flex w-full rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          {(['unclaimed', 'claimed', 'all'] as ClaimTab[]).map((tab) => {
            const Icon = tab === 'unclaimed' ? UserPlus : tab === 'claimed' ? UserCheck : Briefcase;
            const label = tab === 'unclaimed' ? 'Unassigned' : tab === 'claimed' ? 'Assigned' : 'All';
            const active = filters.claimTab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setClaimTab(tab)}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  active ? 'bg-white text-oe-dark shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Search + filter toggle */}
      <div className="p-3 border-b border-gray-200 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="search"
              placeholder="Search cases..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              aria-label="Search cases"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={`p-2 rounded-lg border transition-colors ${
              hasActiveChips
                ? 'border-oe-primary bg-oe-light text-oe-dark'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
            aria-label="Toggle filters"
            aria-expanded={showFilters}
          >
            <Filter className="h-4 w-4" />
          </button>
        </div>

        {showFilters && (
          <div className="space-y-2 pt-1">
            <select
              value={filters.status ?? ''}
              onChange={(e) =>
                onFiltersChange({ ...filters, status: (e.target.value || undefined) as CaseStatus | undefined, page: 1 })
              }
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
              aria-label="Status filter"
            >
              <option value="">All statuses</option>
              {CASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={filters.from ?? ''}
                onChange={(e) => onFiltersChange({ ...filters, from: e.target.value || undefined, page: 1 })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded"
                aria-label="From date"
              />
              <input
                type="date"
                value={filters.to ?? ''}
                onChange={(e) => onFiltersChange({ ...filters, to: e.target.value || undefined, page: 1 })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded"
                aria-label="To date"
              />
            </div>
            {hasActiveChips && (
              <button
                type="button"
                onClick={clearChips}
                className="w-full text-xs text-gray-600 hover:text-gray-900 inline-flex items-center justify-center gap-1 py-1"
              >
                <X className="h-3 w-3" /> Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="px-3 py-3 border-l-4 border-transparent space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-2.5 w-14" />
                </div>
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
        ) : error ? (
          <EmptyState icon={Briefcase} title="Couldn't load cases" description={error} tone="error" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title={
              filters.claimTab === 'unclaimed'
                ? 'No unassigned cases'
                : filters.claimTab === 'all'
                  ? 'No cases'
                  : "You haven't been assigned any cases yet"
            }
            description={filters.q || hasActiveChips ? 'Try a different search or filter.' : ''}
            tone="subtle"
          />
        ) : (
          <ul role="listbox" aria-label="Cases" className="animate-fade-in-fast">
            {rows.map((r) => {
              const isSelected = r.CaseId === selectedId;
              const sc = STATUS_COLORS[r.Status] ?? { bg: 'bg-gray-100', text: 'text-gray-800' };
              const isUnmatched = !!r.NeedsMemberMatch;
              const memberName = `${r.MemberFirstName || ''} ${r.MemberLastName || ''}`.trim() || '—';
              const claimerName = r.ClaimedByUserId
                ? `${r.ClaimedByFirstName || ''} ${r.ClaimedByLastName ? `${r.ClaimedByLastName.charAt(0).toUpperCase()}.` : ''}`.trim() || 'Unknown'
                : null;
              const claimedByMe = !!currentUserId && r.ClaimedByUserId === currentUserId;
              return (
                <li key={r.CaseId} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => onSelect(r.CaseId)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`w-full text-left px-3 py-3 border-l-4 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-oe-primary ${
                      isSelected
                        ? 'border-oe-primary bg-oe-light/60'
                        : 'border-transparent hover:bg-gray-50 hover:border-gray-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[13px] font-semibold text-gray-900 truncate">
                        {r.CaseNumber}
                      </span>
                      <span className="text-[10px] text-gray-500 truncate">
                        {fmtDate(r.SubmittedDate)}
                      </span>
                    </div>
                    <div className="text-xs text-gray-700 mt-0.5 truncate flex items-center gap-1.5">
                      {isUnmatched && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 shrink-0">
                          Unmatched
                        </span>
                      )}
                      {r.ForwardingTarget && (
                        <span
                          className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-purple-100 text-purple-800 shrink-0"
                          title={`Forwardable to ${r.ForwardingTarget.label}`}
                        >
                          {r.ForwardingTarget.label}
                        </span>
                      )}
                      <span className="truncate">{memberName}</span>
                    </div>
                    {r.Title && (
                      <div className="text-[11px] text-gray-500 mt-0.5 truncate">{r.Title}</div>
                    )}
                    <div className="flex items-center justify-between gap-2 mt-1">
                      {claimerName ? (
                        (() => {
                          const cc = getUserColorStyle(r.ClaimedByColor);
                          return (
                            <span
                              style={cc.style}
                              className={`text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-medium truncate ${cc.className}`}
                            >
                              <UserCheck className="h-2.5 w-2.5" />
                              {claimedByMe ? 'You' : claimerName}
                            </span>
                          );
                        })()
                      ) : (
                        <span />
                      )}
                      <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded ${sc.bg} ${sc.text}`}>
                        {r.Status}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!loading && !error && rows.length > 0 && (
        <div className="border-t border-gray-200 px-3 py-2 flex items-center justify-between text-xs text-gray-600">
          <span>
            {(filters.page - 1) * filters.limit + 1}–
            {Math.min(filters.page * filters.limit, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(filters.page - 1)}
              disabled={filters.page === 1}
              className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-1">
              {filters.page}/{totalPages || 1}
            </span>
            <button
              type="button"
              onClick={() => setPage(filters.page + 1)}
              disabled={filters.page >= totalPages}
              className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
};

export default CaseListRail;
