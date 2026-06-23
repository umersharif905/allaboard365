import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Lock, Search, Users, X } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';

export type MemberStatusValue = 'Active' | 'Terminated' | 'PendingMigration' | 'Inactive';

export interface MatchedMember {
  MemberId: string;
  FirstName: string;
  LastName: string;
  RelationshipType: string;
}

export interface RailMember {
  MemberId: string;
  HouseholdMemberID: string;
  RelationshipType: string;
  FirstName: string;
  LastName: string;
  MemberStatus?: MemberStatusValue;
  MigrationSourceSystem?: string | null;
  /** Household member(s) that matched the current search term (e.g. a dependent),
   *  shown as a sub-note under this primary's card. Empty unless searching. */
  MatchedMembers?: MatchedMember[];
}

/** A member who exists in AllAboard365 but is NOT on this vendor's plan.
 *  Surfaced only on a strict identity match (exact email / phone / full name /
 *  member id) and rendered non-clickable. */
export interface OffPlanMember {
  MemberId: string;
  FirstName: string;
  LastName: string;
  /** Vendor(s) whose active plan they're on, or null if no active plan. */
  OtherPlanVendorName: string | null;
}

type StatusFilter = 'All' | MemberStatusValue;

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface MemberListRailProps {
  selectedId?: string;
  onSelect: (memberId: string) => void;
  className?: string;
}

const RELATIONSHIP_LABEL: Record<string, string> = {
  P: 'Primary',
  S: 'Spouse',
  C: 'Dependent',
  Primary: 'Primary',
  Spouse: 'Spouse',
  Dependent: 'Dependent',
};

const RELATIONSHIP_BADGE: Record<string, string> = {
  P: 'bg-blue-100 text-blue-800',
  Primary: 'bg-blue-100 text-blue-800',
  S: 'bg-purple-100 text-purple-800',
  Spouse: 'bg-purple-100 text-purple-800',
  C: 'bg-gray-100 text-gray-800',
  Dependent: 'bg-gray-100 text-gray-800',
};

const MemberListRail = ({ selectedId, onSelect, className = '' }: MemberListRailProps) => {
  const [members, setMembers] = useState<RailMember[]>([]);
  const [offPlanMatches, setOffPlanMatches] = useState<OffPlanMember[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  }, [debouncedSearch, statusFilter]);

  const loadMembers = useCallback(async (signal: AbortSignal) => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
        ...(debouncedSearch && { search: debouncedSearch }),
        ...(statusFilter !== 'All' && { memberStatus: statusFilter }),
      });

      const response = await apiService.get<{
        success: boolean;
        data: RailMember[];
        offPlanMatches?: OffPlanMember[];
        pagination: Pagination;
      }>(`/api/me/vendor/members?${params}`, { signal });

      if (signal.aborted) return;

      if (response.success) {
        setMembers(response.data);
        setOffPlanMatches(response.offPlanMatches ?? []);
        setPagination(response.pagination);
      }
    } catch (err) {
      if (!signal.aborted) {
        console.error('Error loading members:', err);
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [pagination.page, pagination.limit, debouncedSearch, statusFilter]);

  useEffect(() => {
    const controller = new AbortController();
    loadMembers(controller.signal);
    return () => controller.abort();
  }, [loadMembers]);

  const initials = (m: RailMember) =>
    `${m.FirstName?.[0] ?? ''}${m.LastName?.[0] ?? ''}`.toUpperCase();

  return (
    <aside
      className={`flex flex-col w-full md:w-80 md:min-w-80 md:max-w-80 border-r border-gray-200 bg-white ${className}`}
    >
      <div className="p-3 border-b border-gray-200">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="search"
            placeholder="Search members..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            aria-label="Search members"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="w-full text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            aria-label="Filter by member status"
          >
            <option value="All">All members</option>
            <option value="Active">Active</option>
            <option value="Terminated">Terminated</option>
            <option value="PendingMigration">Pending migration (e123)</option>
            <option value="Inactive">Inactive</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="px-3 py-3 border-l-4 border-transparent flex items-center gap-3"
              >
                <Skeleton className="h-9 w-9" rounded="full" />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-2.5 w-14" />
                  </div>
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            ))}
          </div>
        ) : members.length === 0 && offPlanMatches.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No members found"
            description={debouncedSearch ? 'Try a different search term.' : 'No members are enrolled yet.'}
            tone="subtle"
          />
        ) : (
          <>
          {members.length > 0 && (
          <ul role="listbox" aria-label="Members" className="animate-fade-in-fast">
            {members.map((member) => {
              const isSelected = member.MemberId === selectedId;
              return (
                <li key={member.MemberId}>
                  <button
                    type="button"
                    onClick={() => onSelect(member.MemberId)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`group w-full text-left px-3 py-3 border-l-4 transition-all duration-150 flex items-center gap-3 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-oe-primary ${
                      isSelected
                        ? 'border-oe-primary bg-oe-light/60'
                        : 'border-transparent hover:bg-gray-50 hover:border-gray-200 active:bg-gray-100'
                    }`}
                  >
                    <div
                      className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transition-transform duration-150 group-hover:scale-105 ${
                        isSelected ? 'bg-oe-primary text-white' : 'bg-oe-light text-oe-primary'
                      }`}
                    >
                      <span className="text-sm font-semibold">{initials(member)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-gray-900 text-sm truncate">
                          {member.FirstName} {member.LastName}
                        </span>
                        <span className="text-[10px] font-mono text-gray-500 truncate max-w-[90px]">
                          {member.HouseholdMemberID}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        <span
                          className={`inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded ${
                            RELATIONSHIP_BADGE[member.RelationshipType] ?? 'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {RELATIONSHIP_LABEL[member.RelationshipType] ?? member.RelationshipType ?? 'Member'}
                        </span>
                        {member.MemberStatus === 'Terminated' && (
                          <span className="inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-100 text-red-700">
                            Terminated
                          </span>
                        )}
                        {member.MemberStatus === 'PendingMigration' && (
                          <span className="inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-100 text-amber-800">
                            Pending migration
                          </span>
                        )}
                        {member.MemberStatus === 'Inactive' && (
                          <span className="inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-200 text-gray-700">
                            Inactive
                          </span>
                        )}
                      </div>
                      {member.MatchedMembers && member.MatchedMembers.length > 0 && (
                        <div className="mt-1.5 pl-2 border-l-2 border-oe-light space-y-0.5">
                          <div className="text-[9px] font-medium uppercase tracking-wide text-gray-400">
                            Matched in household
                          </div>
                          {member.MatchedMembers.map((mm) => (
                            <div key={mm.MemberId} className="flex items-center gap-1.5">
                              <span className="text-[11px] text-gray-700 truncate">
                                {mm.FirstName} {mm.LastName}
                              </span>
                              <span
                                className={`shrink-0 inline-flex px-1 py-0.5 text-[9px] font-medium rounded ${
                                  RELATIONSHIP_BADGE[mm.RelationshipType] ?? 'bg-gray-100 text-gray-700'
                                }`}
                              >
                                {RELATIONSHIP_LABEL[mm.RelationshipType] ?? mm.RelationshipType}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          )}
          {offPlanMatches.length > 0 && (
            <div className="border-t border-gray-200">
              <div className="px-3 pt-3 pb-1 flex items-center gap-1.5">
                <Lock className="h-3 w-3 text-gray-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  In AllAboard365 — not on your plan
                </span>
              </div>
              <ul aria-label="Members not on your plan">
                {offPlanMatches.map((m) => (
                  <li key={m.MemberId}>
                    <div
                      className="w-full px-3 py-3 flex items-center gap-3 cursor-not-allowed select-none"
                      aria-disabled="true"
                      title="This member exists in AllAboard365 but isn't on your plan."
                    >
                      <div className="h-9 w-9 rounded-full flex items-center justify-center shrink-0 bg-gray-100 text-gray-400">
                        <span className="text-sm font-semibold">
                          {`${m.FirstName?.[0] ?? ''}${m.LastName?.[0] ?? ''}`.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-gray-500 text-sm truncate">
                            {m.FirstName} {m.LastName}
                          </span>
                          <Lock className="h-3 w-3 text-gray-400 shrink-0" />
                        </div>
                        <div className="mt-0.5 text-[11px] text-gray-400 truncate">
                          {m.OtherPlanVendorName ? `On ${m.OtherPlanVendorName}` : 'No active plan'}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          </>
        )}
      </div>

      {!loading && members.length > 0 && (
        <div className="border-t border-gray-200 px-3 py-2 flex items-center justify-between text-xs text-gray-600">
          <span>
            {(pagination.page - 1) * pagination.limit + 1}–
            {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPagination((prev) => ({ ...prev, page: prev.page - 1 }))}
              disabled={pagination.page === 1}
              className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-1">
              {pagination.page}/{pagination.totalPages || 1}
            </span>
            <button
              type="button"
              onClick={() => setPagination((prev) => ({ ...prev, page: prev.page + 1 }))}
              disabled={pagination.page >= pagination.totalPages}
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

export default MemberListRail;
