import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Filter,
  Pencil,
  Search,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { useAuth } from '../../../contexts/AuthContext';
import { shareRequestClaimService } from '../../../services/share-request-claim.service';
import { vendorRequestTypesService } from '../../../services/vendorRequestTypes.service';
import {
  type ShareRequestListItem,
  type ShareRequestListResponse,
  type ShareRequestStatus,
  type ShareRequestDetermination,
  type ClaimTab,
  type ClaimerOption,
  type VendorRequestType,
  SHARE_REQUEST_STATUSES,
  SHARE_REQUEST_DETERMINATIONS,
  STATUS_COLORS,
} from '../../../types/shareRequest.types';
import { getUserColorStyle } from '../../../types/userColor';
import { requestForName } from '../../../utils/shareRequestPatient';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';

/**
 * claimerFilter values:
 *  - 'me'     → backend filters by current user (default when on Claimed tab)
 *  - 'anyone' → no claimer filter (show everyone's claims)
 *  - <uuid>   → specific user
 */
export type ClaimerFilter = 'me' | 'anyone' | string;

export interface RailFilters {
  q: string;
  status?: ShareRequestStatus;
  determination?: ShareRequestDetermination;
  typeId?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  claimTab: ClaimTab;
  claimerFilter: ClaimerFilter;
}

interface ShareRequestListRailProps {
  selectedId: string | undefined;
  onSelect: (shareRequestId: string) => void;
  filters: RailFilters;
  onFiltersChange: (next: RailFilters) => void;
  /** Bumped by the workspace whenever any claim mutation occurs. */
  claimVersion: number;
  /** Called after the rail performs a claim so other panels re-fetch. */
  className?: string;
}

const fmtDate = (v?: string) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
};

const ShareRequestListRail = ({
  selectedId,
  onSelect,
  filters,
  onFiltersChange,
  claimVersion,
  className = '',
}: ShareRequestListRailProps) => {
  const { user } = useAuth();
  const currentUserId = user?.userId;

  const [requests, setRequests] = useState<ShareRequestListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const [claimers, setClaimers] = useState<ClaimerOption[]>([]);
  const [requestTypes, setRequestTypes] = useState<VendorRequestType[]>([]);

  useEffect(() => {
    let cancelled = false;
    vendorRequestTypesService.list()
      .then((rows) => { if (!cancelled) setRequestTypes(rows); })
      .catch((err) => console.error('Error loading request types:', err));
    return () => { cancelled = true; };
  }, []);
  // Bumps whenever the user updates their profile (e.g., picks a new
  // PreferredColor) so we refetch and the existing claimer pills repaint
  // with the new hex.
  const [profileVersion, setProfileVersion] = useState(0);

  useEffect(() => {
    const handler = () => setProfileVersion((v) => v + 1);
    window.addEventListener('oe-user-profile-updated', handler);
    return () => window.removeEventListener('oe-user-profile-updated', handler);
  }, []);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [debouncedSearch, setDebouncedSearch] = useState(filters.q);

  // Sync local input when URL filters change externally (back/forward).
  useEffect(() => {
    setSearchInput(filters.q);
  }, [filters.q]);

  // Debounce search input -> debouncedSearch.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // When debounced search changes, push to parent (resets page to 1).
  useEffect(() => {
    if (debouncedSearch === filters.q) return;
    onFiltersChange({ ...filters, q: debouncedSearch, page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // Fetch list on filter change.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const params = new URLSearchParams();
        if (filters.q) params.set('search', filters.q);
        if (filters.status) params.set('status', filters.status);
        if (filters.determination) params.set('determination', filters.determination);
        if (filters.typeId) params.set('requestTypeId', filters.typeId);
        if (filters.from) params.set('dateFrom', filters.from);
        if (filters.to) params.set('dateTo', filters.to);
        params.set('page', String(filters.page));
        params.set('limit', String(filters.limit));
        params.set('sortBy', 'SubmittedDate');
        params.set('sortOrder', 'DESC');

        // Claim tab filters. 'all' omits the claimed param so backend returns
        // both claimed and unclaimed SRs. The claimer dropdown is only
        // relevant on the 'claimed' tab.
        if (filters.claimTab === 'unclaimed') {
          params.set('claimed', 'false');
        } else if (filters.claimTab === 'claimed') {
          params.set('claimed', 'true');
          if (filters.claimerFilter && filters.claimerFilter !== 'anyone') {
            params.set('claimedByUserId', filters.claimerFilter);
          }
        }

        const response = await apiService.get<ShareRequestListResponse>(
          `/api/me/vendor/share-requests?${params.toString()}`,
          { signal: controller.signal }
        );

        if (cancelled || controller.signal.aborted) return;
        if (response.success) {
          setRequests(response.data);
          setTotal(response.pagination.total);
          setTotalPages(response.pagination.totalPages);
        } else {
          setError('Failed to load share requests');
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load share requests');
      } finally {
        if (!cancelled && !controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    filters.q,
    filters.status,
    filters.determination,
    filters.typeId,
    filters.from,
    filters.to,
    filters.page,
    filters.limit,
    filters.claimTab,
    filters.claimerFilter,
    claimVersion,
    profileVersion,
  ]);

  // Fetch claimers (roster + counts) on mount and after each mutation anywhere.
  // profileVersion is included so a color change refreshes the roster too —
  // future-proofing for when the dropdown options also show user colors.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await shareRequestClaimService.getClaimers();
        if (!cancelled) setClaimers(data);
      } catch {
        // Non-fatal — dropdown will show only "Me" / "Anyone".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [claimVersion, profileVersion]);

  const hasActiveChips = useMemo(
    () => Boolean(filters.status || filters.determination || filters.typeId || filters.from || filters.to),
    [filters.status, filters.determination, filters.typeId, filters.from, filters.to]
  );

  const clearChips = useCallback(() => {
    onFiltersChange({
      ...filters,
      q: filters.q,
      status: undefined,
      determination: undefined,
      typeId: undefined,
      from: undefined,
      to: undefined,
      page: 1,
    });
  }, [filters, onFiltersChange]);

  const setPage = useCallback(
    (page: number) => onFiltersChange({ ...filters, page }),
    [filters, onFiltersChange]
  );

  const setClaimTab = useCallback(
    (tab: ClaimTab) => {
      onFiltersChange({
        ...filters,
        claimTab: tab,
        // Reset claimer filter to default 'me' when switching tabs.
        claimerFilter: tab === 'claimed' ? 'me' : 'me',
        page: 1,
      });
    },
    [filters, onFiltersChange]
  );

  const setClaimerFilter = useCallback(
    (val: ClaimerFilter) => {
      onFiltersChange({ ...filters, claimerFilter: val, page: 1 });
    },
    [filters, onFiltersChange]
  );

  // Build the dropdown options. Me is always first; Anyone second; then the roster.
  const dropdownOptions = useMemo(() => {
    const meEntry = claimers.find((c) => c.userId === currentUserId);
    const others = claimers.filter((c) => c.userId !== currentUserId);
    return {
      meCount: meEntry?.claimedCount ?? 0,
      others,
    };
  }, [claimers, currentUserId]);

  return (
    <aside
      className={`flex flex-col w-full md:w-72 md:min-w-72 md:max-w-72 lg:w-80 lg:min-w-80 lg:max-w-80 border-r border-gray-200 bg-white min-h-0 ${className}`}
    >
      {/* Claim tab strip */}
      <div className="p-3 border-b border-gray-200 space-y-2">
        <div role="tablist" aria-label="Assignment filter" className="inline-flex w-full rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          <button
            type="button"
            role="tab"
            aria-selected={filters.claimTab === 'unclaimed'}
            onClick={() => setClaimTab('unclaimed')}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filters.claimTab === 'unclaimed'
                ? 'bg-white text-oe-dark shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Unassigned
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filters.claimTab === 'claimed'}
            onClick={() => setClaimTab('claimed')}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filters.claimTab === 'claimed'
                ? 'bg-white text-oe-dark shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <UserCheck className="h-3.5 w-3.5" />
            Assigned
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filters.claimTab === 'all'}
            onClick={() => setClaimTab('all')}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filters.claimTab === 'all'
                ? 'bg-white text-oe-dark shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <ClipboardList className="h-3.5 w-3.5" />
            All
          </button>
        </div>

      </div>

      {/* Search + filter toggle */}
      <div className="p-3 border-b border-gray-200 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="search"
              placeholder="Search share requests..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              aria-label="Search share requests"
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
            {/* Claimer filter — only meaningful on the Claimed tab. Tucked
                inside the funnel so it doesn't take up always-visible
                vertical space on the rail. */}
            {filters.claimTab === 'claimed' && (
              <select
                value={filters.claimerFilter}
                onChange={(e) => setClaimerFilter(e.target.value as ClaimerFilter)}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
                aria-label="Filter by assignee"
              >
                <option value="me">Me — ({dropdownOptions.meCount})</option>
                <option value="anyone">Show All</option>
                {dropdownOptions.others.map((c) => {
                  const lastInitial = c.lastName ? `${c.lastName.charAt(0).toUpperCase()}.` : '';
                  const label = `${c.firstName ?? ''} ${lastInitial} — (${c.claimedCount})`.trim();
                  return (
                    <option
                      key={c.userId}
                      value={c.userId}
                      className={c.claimedCount === 0 ? 'text-gray-400' : ''}
                    >
                      {label}
                    </option>
                  );
                })}
              </select>
            )}
            <select
              value={filters.status ?? ''}
              onChange={(e) =>
                onFiltersChange({
                  ...filters,
                  status: (e.target.value || undefined) as ShareRequestStatus | undefined,
                  page: 1,
                })
              }
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
              aria-label="Status filter"
            >
              <option value="">All statuses</option>
              {SHARE_REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={filters.determination ?? ''}
              onChange={(e) =>
                onFiltersChange({
                  ...filters,
                  determination: (e.target.value || undefined) as ShareRequestDetermination | undefined,
                  page: 1,
                })
              }
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
              aria-label="Determination filter"
            >
              <option value="">All determinations</option>
              {SHARE_REQUEST_DETERMINATIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              value={filters.typeId ?? ''}
              onChange={(e) =>
                onFiltersChange({
                  ...filters,
                  typeId: e.target.value || undefined,
                  page: 1,
                })
              }
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
              aria-label="Type filter"
            >
              <option value="">All types</option>
              {requestTypes.map((t) => (
                <option key={t.TypeId} value={t.TypeId}>{t.Name}</option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={filters.from ?? ''}
                onChange={(e) =>
                  onFiltersChange({ ...filters, from: e.target.value || undefined, page: 1 })
                }
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded"
                aria-label="From date"
              />
              <input
                type="date"
                value={filters.to ?? ''}
                onChange={(e) =>
                  onFiltersChange({ ...filters, to: e.target.value || undefined, page: 1 })
                }
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
                <X className="h-3 w-3" />
                Clear filters
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
          <EmptyState
            icon={ClipboardList}
            title="Couldn't load share requests"
            description={error}
            tone="error"
          />
        ) : requests.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={
              filters.claimTab === 'unclaimed'
                ? 'No unassigned share requests'
                : filters.claimTab === 'all'
                  ? 'No share requests'
                  : filters.claimerFilter === 'me'
                    ? "You haven't been assigned any share requests yet"
                    : 'Nothing assigned to this user'
            }
            description={
              filters.q || hasActiveChips
                ? 'Try a different search or filter.'
                : filters.claimTab === 'unclaimed'
                  ? 'All caught up — nice.'
                  : ''
            }
            tone="subtle"
          />
        ) : (
          <ul role="listbox" aria-label="Share requests" className="animate-fade-in-fast">
            {requests.map((req) => {
              const isSelected = req.ShareRequestId === selectedId;
              const statusColors = STATUS_COLORS[req.Status] ?? STATUS_COLORS.New;
              const isUnmatched = !!req.NeedsMemberMatch;
              // Show who the request is for: the captured name when it's an actual
              // person, otherwise the primary holder.
              const memberName = requestForName({
                patientName: req.PatientName,
                requestName: req.RequestName,
                memberFirstName: req.MemberFirstName,
                memberLastName: req.MemberLastName,
              });
              const claimerName = req.ClaimedByFirstName
                ? `${req.ClaimedByFirstName ?? ''} ${
                    req.ClaimedByLastName ? `${req.ClaimedByLastName.charAt(0).toUpperCase()}.` : ''
                  }`.trim()
                : null;
              return (
                <li key={req.ShareRequestId} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => onSelect(req.ShareRequestId)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`w-full text-left px-3 py-3 border-l-4 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-oe-primary ${
                      isSelected
                        ? 'border-oe-primary bg-oe-light/60'
                        : 'border-transparent hover:bg-gray-50 hover:border-gray-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[13px] font-semibold text-gray-900 truncate">
                        {req.RequestNumber}
                      </span>
                      <span className="text-[10px] text-gray-500 truncate">
                        {fmtDate(req.SubmittedDate)}
                      </span>
                    </div>
                    <div className="text-xs text-gray-700 mt-0.5 truncate flex items-center gap-1.5">
                      {isUnmatched && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 shrink-0">
                          Unmatched
                        </span>
                      )}
                      <span className="truncate">{memberName || '—'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      {claimerName ? (
                        (() => {
                          const c = getUserColorStyle(req.ClaimedByColor);
                          return (
                            <span
                              style={c.style}
                              className={`text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-medium truncate ${c.className}`}
                            >
                              <UserCheck className="h-2.5 w-2.5" />
                              {claimerName}
                            </span>
                          );
                        })()
                      ) : req.CreatedByFirstName ? (
                        <span className="text-[11px] text-gray-500 inline-flex items-center gap-1 truncate">
                          <Pencil className="h-2.5 w-2.5" />
                          {req.CreatedByFirstName}
                        </span>
                      ) : (
                        <span />
                      )}
                      <span
                        className={`inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded ${statusColors.bg} ${statusColors.text}`}
                      >
                        {req.Status}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!loading && !error && requests.length > 0 && (
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

export default ShareRequestListRail;
