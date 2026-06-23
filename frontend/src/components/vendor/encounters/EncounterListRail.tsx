// EncounterListRail — left-side list for the /vendor/encounters dashboard.
// Top: 2-pill quick filter (All | Opened by me).
// Below: search + filter button. Filter dropdown holds No-member toggle,
// Follow-up toggle, and Channel.
// Rows show encounter number, member (or No member italic), channel,
// creator, summary preview, follow-up badge.

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  MessageCircle,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { apiService } from '../../../services/api.service';
import {
  CHANNEL_LABELS,
  ENCOUNTER_CHANNELS,
  channelLabel,
  type EncounterChannel,
  type EncounterRow,
} from '../../../types/encounter.types';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';
import EncounterFollowUpBadge from './EncounterFollowUpBadge';

export type EncounterRailQuickFilter = 'all' | 'mine';

export interface EncounterRailFilters {
  q: string;
  quick: EncounterRailQuickFilter;
  channel?: EncounterChannel;
  noMember: boolean;
  followUp: boolean;
  page: number;
  limit: number;
}

interface ListResp {
  success: boolean;
  data: EncounterRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface Props {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  filters: EncounterRailFilters;
  onFiltersChange: (next: EncounterRailFilters) => void;
  refreshVersion: number;
  onNew: () => void;
  className?: string;
}

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
};

const QUICK_TABS: { key: EncounterRailQuickFilter; label: string }[] = [
  { key: 'all',  label: 'All' },
  { key: 'mine', label: 'Opened by me' },
];

const EncounterListRail = ({
  selectedId,
  onSelect,
  filters,
  onFiltersChange,
  refreshVersion,
  onNew,
  className = '',
}: Props) => {
  const [rows, setRows] = useState<EncounterRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [debouncedSearch, setDebouncedSearch] = useState(filters.q);

  useEffect(() => { setSearchInput(filters.q); }, [filters.q]);

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
        if (filters.channel) params.set('channel', filters.channel);
        params.set('page', String(filters.page));
        params.set('limit', String(filters.limit));

        if (filters.quick === 'mine') params.set('mine', 'true');
        if (filters.noMember)         params.set('triage', 'true');
        if (filters.followUp)         params.set('followUp', 'open');

        const resp = await apiService.get<ListResp>(
          `/api/me/vendor/encounters?${params.toString()}`,
          { signal: ac.signal }
        );
        if (cancelled || ac.signal.aborted) return;
        if (resp.success) {
          setRows(resp.data);
          setTotal(resp.pagination.total);
          setTotalPages(resp.pagination.totalPages);
        } else {
          setError('Failed to load encounters');
        }
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load encounters');
      } finally {
        if (!cancelled && !ac.signal.aborted) setLoading(false);
      }
    })();

    return () => { cancelled = true; ac.abort(); };
  }, [filters.q, filters.channel, filters.page, filters.limit, filters.quick, filters.noMember, filters.followUp, refreshVersion]);

  const activeFilterCount =
    (filters.channel ? 1 : 0) + (filters.noMember ? 1 : 0) + (filters.followUp ? 1 : 0);

  const setQuick = useCallback((quick: EncounterRailQuickFilter) => {
    onFiltersChange({ ...filters, quick, page: 1 });
  }, [filters, onFiltersChange]);

  const setPage = useCallback((page: number) => onFiltersChange({ ...filters, page }), [filters, onFiltersChange]);

  return (
    <aside
      className={`flex flex-col w-full md:w-72 md:min-w-72 md:max-w-72 lg:w-80 lg:min-w-80 lg:max-w-80 border-r border-gray-200 bg-white min-h-0 ${className}`}
    >
      <div className="p-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-oe-primary" />
          <h2 className="text-sm font-semibold text-gray-900">Encounters</h2>
        </div>
        <button
          type="button"
          onClick={onNew}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md"
        >
          <Plus className="h-3.5 w-3.5" /> New
        </button>
      </div>

      <div className="p-3 border-b border-gray-200">
        <div role="tablist" aria-label="Quick filter" className="inline-flex w-full rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          {QUICK_TABS.map(({ key, label }) => {
            const active = filters.quick === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setQuick(key)}
                className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  active ? 'bg-white text-oe-dark shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-3 border-b border-gray-200 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="search"
              placeholder="Search encounters…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              aria-label="Search encounters"
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
            className={`relative p-2 rounded-lg border transition-colors ${
              activeFilterCount > 0
                ? 'border-oe-primary bg-oe-light text-oe-dark'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
            aria-label="Toggle filters"
            aria-expanded={showFilters}
          >
            <Filter className="h-4 w-4" />
            {activeFilterCount > 0 && (
              <span className="absolute -top-1 -right-1 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-oe-primary text-white text-[10px] font-semibold">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {showFilters && (
          <div className="space-y-2 pt-2">
            <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filters.noMember}
                onChange={(e) => onFiltersChange({ ...filters, noMember: e.target.checked, page: 1 })}
                className="h-3.5 w-3.5 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              <span>No member</span>
              <span className="text-[10px] text-gray-400">Not yet matched to a member</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filters.followUp}
                onChange={(e) => onFiltersChange({ ...filters, followUp: e.target.checked, page: 1 })}
                className="h-3.5 w-3.5 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              <span>Open follow-ups</span>
            </label>
            <select
              value={filters.channel ?? ''}
              onChange={(e) =>
                onFiltersChange({
                  ...filters,
                  channel: (e.target.value || undefined) as EncounterChannel | undefined,
                  page: 1,
                })
              }
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
              aria-label="Channel filter"
            >
              <option value="">All channels</option>
              {ENCOUNTER_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
            </select>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={() =>
                  onFiltersChange({ ...filters, channel: undefined, noMember: false, followUp: false, page: 1 })
                }
                className="w-full text-xs text-gray-600 hover:text-gray-900 inline-flex items-center justify-center gap-1 py-1"
              >
                <X className="h-3 w-3" /> Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="px-3 py-3 border-l-4 border-transparent space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-2.5 w-12" />
                </div>
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        ) : error ? (
          <EmptyState icon={MessageCircle} title="Couldn't load encounters" description={error} tone="error" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={MessageCircle}
            title={
              filters.quick === 'mine' ? "You haven't opened any encounters"
              : filters.noMember       ? 'No unmatched encounters'
              : filters.followUp       ? 'No open follow-ups'
              : 'No encounters'
            }
            description={filters.q ? 'Try a different search.' : ''}
            tone="subtle"
          />
        ) : (
          <ul role="listbox" aria-label="Encounters" className="animate-fade-in-fast">
            {rows.map((r) => {
              const isSelected = r.EncounterId === selectedId;
              const memberName = `${r.MemberFirstName || ''} ${r.MemberLastName || ''}`.trim();
              const occurred = r.OccurredAt || r.CreatedDate;
              return (
                <li key={r.EncounterId} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => onSelect(r.EncounterId)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`w-full text-left px-3 py-3 border-l-4 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-oe-primary ${
                      isSelected
                        ? 'border-oe-primary bg-oe-light/60'
                        : 'border-transparent hover:bg-gray-50 hover:border-gray-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12px] font-semibold text-gray-900 truncate">
                        {r.EncounterNumber}
                      </span>
                      <span className="text-[10px] text-gray-500 truncate">{fmtDate(occurred)}</span>
                    </div>
                    <div className="text-xs text-gray-700 mt-0.5 truncate">
                      {memberName || <span className="italic text-amber-700">No member</span>}
                    </div>
                    <p className="text-[11px] text-gray-600 mt-1 line-clamp-2 whitespace-pre-wrap">
                      {r.Summary}
                    </p>
                    <div className="flex items-center justify-between mt-1.5 gap-1">
                      <span className="text-[10px] text-gray-500 truncate">
                        {channelLabel(r.Channel)}
                        {r.CreatedByName && (
                          <> · <span className="text-gray-600">By {r.CreatedByName}</span></>
                        )}
                      </span>
                      <EncounterFollowUpBadge encounter={r} />
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
              className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-1">{filters.page}/{totalPages || 1}</span>
            <button
              type="button"
              onClick={() => setPage(filters.page + 1)}
              disabled={filters.page >= totalPages}
              className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40"
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

export default EncounterListRail;
