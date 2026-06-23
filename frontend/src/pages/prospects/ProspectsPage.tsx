// frontend/src/pages/prospects/ProspectsPage.tsx
// Prospects CRM list (Phase 1). Visibility filter (self / downline / agency / specific
// agent) mirrors the Members, Groups, and Commissions pages via useDownlineAgentsForFilter.

import { BarChart3, CalendarClock, ChevronDown, ChevronUp, Download, Filter, List, Plus, Radio, Search, UserCheck, Users } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  AGENT_FILTER_SCOPE_AGENCY,
  AGENT_FILTER_SCOPE_DIRECT_DOWNLINE,
  AGENT_FILTER_SHOW_ALL,
  getInitialAgentFilterIdFromStorage,
  isAgentFilterScopeSentinel,
} from '../../constants/agentFilterScope';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import {
  useProspects,
  useProspectTags,
  useTenantAgencies,
  useTenantAgentsForFilter,
} from '../../hooks/useProspects';
import {
  FollowUpFilter,
  PROSPECT_SOURCES,
  PROSPECT_STATUSES,
  ProspectListParams,
  ProspectStatsParams,
  ProspectStatus,
  SortByField,
  SortDir,
} from '../../services/prospect.service';
import ProspectService from '../../services/prospect.service';
import ProspectCreateModal from './ProspectCreateModal';
import ProspectDetailModal from './ProspectDetailModal';
import ProspectsInsightsTab from './ProspectsInsightsTab';
import ProspectSourcesTab from './ProspectSourcesTab';
import { getSourceColor } from './sourceColors';
import { statusBadgeClass, tagChipClass } from './prospectStatus';

const PAGE_SIZE = 25;

const fullName = (first?: string | null, last?: string | null) =>
  [first, last].filter(Boolean).join(' ').trim() || 'Unnamed';

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/** Convert the toolbar filter value into API scope/agentId params. */
function toVisibilityParams(agentFilter: string, isAgentPortal: boolean): Pick<ProspectListParams, 'scope' | 'agentId'> {
  if (!isAgentPortal) return {}; // TenantAdmin/SysAdmin: whole tenant
  if (agentFilter === AGENT_FILTER_SHOW_ALL) return { scope: 'downline' };
  if (agentFilter === AGENT_FILTER_SCOPE_AGENCY) return { scope: 'agency' };
  if (agentFilter === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE) return { scope: 'direct' };
  if (!agentFilter) return { scope: 'self' };
  if (isAgentFilterScopeSentinel(agentFilter)) return {};
  return { agentId: agentFilter };
}

const fmtFollowUp = (dateStr: string | null | undefined): { label: string; overdue: boolean } => {
  if (!dateStr) return { label: '', overdue: false };
  const d = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return {
    label: new Date(dateStr).toLocaleDateString(),
    overdue: d < today,
  };
};

export default function ProspectsPage() {
  const { user } = useAuth();
  const isAgentPortal = user?.currentRole === 'Agent' || user?.currentRole === 'AgencyOwner';

  const [activeTab, setActiveTab] = useState<'list' | 'sources' | 'insights'>('list');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProspectStatus | ''>('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState(() => getInitialAgentFilterIdFromStorage());
  const [adminAgencyId, setAdminAgencyId] = useState('');
  const [adminAgentId, setAdminAgentId] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Phase 2: sort, tag filter, follow-up filter
  const [sortBy, setSortBy] = useState<SortByField>('createdDate');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [followUpFilter, setFollowUpFilter] = useState<FollowUpFilter | ''>('');

  const { data: downlineAgentOptions = [], isLoading: isLoadingAgents } = useDownlineAgentsForFilter({
    includeShowAllOption: true,
    agencyOwnerFilter: true,
  });

  // Tags for filter
  const { data: availableTags = [] } = useProspectTags();

  // Admin (TenantAdmin/SysAdmin) agency + agent selectors.
  const { data: agencies = [] } = useTenantAgencies(!isAgentPortal);
  const { data: adminAgents = [] } = useTenantAgentsForFilter(!isAgentPortal);
  const adminAgentOptions = useMemo(
    () => adminAgents.filter((a) => !adminAgencyId || a.AgencyId === adminAgencyId),
    [adminAgents, adminAgencyId]
  );

  // Visibility scope (agent/agency) shared by the list params and the insights tab.
  const visibility: Pick<ProspectListParams, 'scope' | 'agentId' | 'agencyId'> = useMemo(
    () =>
      isAgentPortal
        ? toVisibilityParams(agentFilter, true)
        : { agentId: adminAgentId || undefined, agencyId: !adminAgentId && adminAgencyId ? adminAgencyId : undefined },
    [isAgentPortal, agentFilter, adminAgentId, adminAgencyId]
  );

  const statsParams: ProspectStatsParams = useMemo(
    () => ({ scope: visibility.scope, agentId: visibility.agentId, agencyId: visibility.agencyId }),
    [visibility]
  );

  const params: ProspectListParams = useMemo(() => {
    return {
      ...visibility,
      status: statusFilter || undefined,
      source: sourceFilter || undefined,
      search: search.trim() || undefined,
      page,
      pageSize: PAGE_SIZE,
      sortBy,
      sortDir,
      tags: selectedTagIds.length > 0 ? selectedTagIds.join(',') : undefined,
      followUp: followUpFilter || undefined,
    };
  }, [visibility, statusFilter, sourceFilter, search, page, sortBy, sortDir, selectedTagIds, followUpFilter]);

  const { data, isLoading } = useProspects(params);
  const prospects = useMemo(() => data?.prospects || [], [data]);
  const total = data?.total || 0;

  const handleSort = (col: SortByField) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
    setPage(1);
  };

  const toggleTagFilter = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
    setPage(1);
  };

  const SortIcon = ({ col }: { col: SortByField }) => {
    if (sortBy !== col) return null;
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 inline ml-0.5" />
      : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const metrics = useMemo(() => ({
    total,
    proposalSent: prospects.filter((p) => p.Status === 'Proposal Sent').length,
    closed: prospects.filter((p) => p.Status === 'Closed').length,
    matches: prospects.filter((p) => p.SuggestedMemberId && !p.MemberId).length,
  }), [prospects, total]);

  return (
    <div className="p-6 space-y-6" data-testid="prospects-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Prospects</h1>
          <p className="text-sm text-gray-500 mt-1">Leads and their journey to enrollment.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setExporting(true);
              try { await ProspectService.downloadReport(params); } finally { setExporting(false); }
            }}
            disabled={exporting}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg disabled:opacity-60"
          >
            <Download className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <button
            data-testid="prospect-add"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg"
          >
            <Plus className="w-4 h-4" /> Add Prospect
          </button>
        </div>
      </div>

      {/* Tabs: List | Insights */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6" aria-label="Prospects views">
          <button
            data-testid="tab-list"
            onClick={() => setActiveTab('list')}
            className={`flex items-center gap-1.5 -mb-px px-1 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'list'
                ? 'border-oe-primary text-oe-dark'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <List className="w-4 h-4" /> List
          </button>
          <button
            data-testid="tab-sources"
            onClick={() => setActiveTab('sources')}
            className={`flex items-center gap-1.5 -mb-px px-1 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'sources'
                ? 'border-oe-primary text-oe-dark'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <Radio className="w-4 h-4" /> Sources
          </button>
          <button
            data-testid="tab-insights"
            onClick={() => setActiveTab('insights')}
            className={`flex items-center gap-1.5 -mb-px px-1 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'insights'
                ? 'border-oe-primary text-oe-dark'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <BarChart3 className="w-4 h-4" /> Insights
          </button>
        </nav>
      </div>

      {activeTab === 'insights' ? (
        <ProspectsInsightsTab scope={statsParams} />
      ) : activeTab === 'sources' ? (
        <ProspectSourcesTab />
      ) : (
        <>
      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard icon={<Users className="w-5 h-5 text-oe-primary" />} label="Total (page scope)" value={metrics.total} />
        <MetricCard label="Proposal Sent" value={metrics.proposalSent} />
        <MetricCard label="Closed" value={metrics.closed} />
        <MetricCard icon={<UserCheck className="w-5 h-5 text-oe-dark" />} label="Member matches" value={metrics.matches} />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search name, email, phone, referral…"
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as ProspectStatus | ''); setPage(1); }}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
        >
          <option value="">All statuses</option>
          {PROSPECT_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          data-testid="source-filter"
          value={sourceFilter}
          onChange={(e) => { setSourceFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
        >
          <option value="">All sources</option>
          {PROSPECT_SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {isAgentPortal && (
          <div className="min-w-[200px]">
            <SearchableDropdown
              options={downlineAgentOptions.map((opt) => ({
                id: opt.id,
                label: opt.label,
                value: opt.value,
                email: opt.email,
              }))}
              value={agentFilter}
              onChange={(value) => { setAgentFilter(value); setPage(1); }}
              placeholder="Me or specific agent"
              searchPlaceholder="Search agents…"
              loading={isLoadingAgents}
              showEmail
              className="w-full"
            />
          </div>
        )}

        {!isAgentPortal && (
          <>
            <select
              value={adminAgencyId}
              onChange={(e) => { setAdminAgencyId(e.target.value); setAdminAgentId(''); setPage(1); }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary min-w-[160px]"
            >
              <option value="">All agencies</option>
              {agencies.map((a) => (
                <option key={a.AgencyId} value={a.AgencyId}>{a.AgencyName}</option>
              ))}
            </select>
            <div className="min-w-[200px]">
              <SearchableDropdown
                options={[
                  { id: '', label: 'All agents', value: '' },
                  ...adminAgentOptions.map((a) => ({
                    id: a.AgentId,
                    label: [a.FirstName, a.LastName].filter(Boolean).join(' ').trim() || a.Email || 'Agent',
                    value: a.AgentId,
                    email: a.Email || undefined,
                  })),
                ]}
                value={adminAgentId}
                onChange={(value) => { setAdminAgentId(value); setPage(1); }}
                placeholder="All agents"
                searchPlaceholder="Search agents…"
                showEmail
                className="w-full"
              />
            </div>
          </>
        )}

        {/* Follow-up filter */}
        <select
          value={followUpFilter}
          onChange={(e) => { setFollowUpFilter(e.target.value as FollowUpFilter | ''); setPage(1); }}
          className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
        >
          <option value="">All follow-ups</option>
          <option value="overdue">Overdue</option>
          <option value="upcoming">Upcoming</option>
          <option value="any">Has follow-up</option>
        </select>

        {/* Tag filter */}
        {availableTags.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setTagFilterOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 border rounded-lg text-sm font-medium ${
                selectedTagIds.length > 0
                  ? 'border-oe-primary text-oe-dark bg-oe-light'
                  : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
              }`}
            >
              <Filter className="w-4 h-4" />
              Tags {selectedTagIds.length > 0 && `(${selectedTagIds.length})`}
            </button>
            {tagFilterOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-lg p-3 w-max min-w-[200px] max-w-[280px] space-y-1.5">
                {availableTags.map((tag) => (
                  <label
                    key={tag.ProspectTagId}
                    className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTagIds.includes(tag.ProspectTagId)}
                      onChange={() => toggleTagFilter(tag.ProspectTagId)}
                      className="shrink-0 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                    />
                    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full truncate ${tagChipClass(tag.Color)}`}>
                      {tag.Name}
                    </span>
                  </label>
                ))}
                {selectedTagIds.length > 0 && (
                  <button
                    onClick={() => { setSelectedTagIds([]); setPage(1); }}
                    className="text-xs text-gray-400 hover:text-gray-600 mt-1 w-full text-right"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
            <tr>
              <th
                className="px-4 py-3 cursor-pointer select-none hover:text-gray-700"
                onClick={() => handleSort('name')}
              >
                Name <SortIcon col="name" />
              </th>
              <th className="px-4 py-3">Contact</th>
              <th
                className="px-4 py-3 cursor-pointer select-none hover:text-gray-700"
                onClick={() => handleSort('status')}
              >
                Status <SortIcon col="status" />
              </th>
              <th
                className="px-4 py-3 cursor-pointer select-none hover:text-gray-700"
                onClick={() => handleSort('source')}
              >
                Source <SortIcon col="source" />
              </th>
              <th className="px-4 py-3">Agent</th>
              <th className="px-4 py-3">Referral</th>
              <th
                className="px-4 py-3 cursor-pointer select-none hover:text-gray-700"
                onClick={() => handleSort('createdDate')}
              >
                Created <SortIcon col="createdDate" />
              </th>
              <th
                className="px-4 py-3 cursor-pointer select-none hover:text-gray-700"
                onClick={() => handleSort('followUp')}
              >
                Follow-up <SortIcon col="followUp" />
              </th>
              <th
                className="px-4 py-3 text-right cursor-pointer select-none hover:text-gray-700"
                onClick={() => handleSort('premium')}
              >
                Premium <SortIcon col="premium" />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-500">Loading…</td></tr>
            ) : prospects.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-500">No prospects found.</td></tr>
            ) : (
              prospects.map((p) => {
                const followUp = fmtFollowUp(p.NextFollowUpDate);
                return (
                  <tr
                    key={p.ProspectId}
                    data-testid="prospect-row"
                    onClick={() => setSelectedId(p.ProspectId)}
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-gray-900">{fullName(p.FirstName, p.LastName)}</span>
                        {p.SuggestedMemberId && !p.MemberId && (
                          <UserCheck className="w-4 h-4 text-oe-dark" aria-label="Possible member match" />
                        )}
                        {p.Tags && p.Tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {p.Tags.map((tag) => (
                              <span
                                key={tag.ProspectTagId}
                                className={`inline-block px-1.5 py-0.5 text-xs font-medium rounded-full ${tagChipClass(tag.Color)}`}
                              >
                                {tag.Name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      <div>{p.Email || '—'}</div>
                      <div className="text-gray-400">{p.Phone || ''}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${statusBadgeClass(p.Status)}`}>
                        {p.Status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${getSourceColor(p.SourceColor)?.chip ?? 'bg-gray-100 text-gray-700'}`}>
                        {p.Source || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{fullName(p.AgentFirstName, p.AgentLastName)}</td>
                    <td className="px-4 py-3 text-gray-600">{p.ReferralName || '—'}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(p.CreatedDate).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {followUp.label ? (
                        <span className={`flex items-center gap-1 ${followUp.overdue ? 'text-red-600' : 'text-oe-dark'}`}>
                          <CalendarClock className="w-3.5 h-3.5 flex-shrink-0" />
                          {followUp.label}
                          {followUp.overdue && <span className="text-xs font-medium ml-0.5">(Overdue)</span>}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">{fmtMoney(p.PremiumAmount)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>{total} prospect{total === 1 ? '' : 's'}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50"
            >
              Previous
            </button>
            <span>Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
        </>
      )}

      {/* Modals */}
      {showCreate && (
        <ProspectCreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(prospectId) => { setShowCreate(false); setSelectedId(prospectId); }}
        />
      )}
      {selectedId && (
        <ProspectDetailModal prospectId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function MetricCard({ icon, label, value }: { icon?: ReactNode; label: string; value: number }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        {icon}
        <span>{label}</span>
      </div>
      <p className="text-2xl font-semibold text-gray-900 mt-2">{value}</p>
    </div>
  );
}
