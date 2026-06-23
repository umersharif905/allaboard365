// CaseWorkspace — back-office Tickets page. Mirrors ShareRequestWorkspace's
// rail-plus-detail layout. Routes:
//   /vendor/cases       → rail visible, detail panel shows the empty state.
//   /vendor/cases/:id   → rail visible, detail panel shows header + tabs.
// The "New case" button lives inside the rail header.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, Plus } from 'lucide-react';
import { apiService } from '../../services/api.service';
import CaseListRail, {
  type CaseRailFilters,
  type ClaimTab,
} from '../../components/vendor/cases/CaseListRail';
import CaseHeaderCard from '../../components/vendor/cases/CaseHeaderCard';
import CaseWorkspaceTabs, {
  DEFAULT_CASE_TAB,
  isCaseTabKey,
  type CaseTabKey,
} from '../../components/vendor/cases/CaseWorkspaceTabs';
import CaseNewModal from '../../components/vendor/cases/CaseNewModal';
import CaseSettings from '../../components/vendor/cases/CaseSettings';
import { useAuth } from '../../contexts/AuthContext';
import { type CaseRow, type CaseStatus, CASE_STATUSES } from '../../types/case.types';

interface GetResp { success: boolean; data: CaseRow }

const DEFAULT_LIMIT = 25;

const isClaimTab = (v: string | null): v is ClaimTab =>
  v === 'unclaimed' || v === 'claimed' || v === 'all';

const isStatus = (v: string | null): v is CaseStatus =>
  !!v && (CASE_STATUSES as string[]).includes(v);

const CaseWorkspace = () => {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const isVendorAdmin = Array.isArray(user?.roles) && user!.roles.includes('VendorAdmin');
  const isSettingsRoute = location.pathname.endsWith('/cases/settings');

  const tabParam = searchParams.get('tab');
  // `encounters` was its own top-level tab before being folded into the
  // Communications tab; bookmarked links keep working by redirecting here.
  const coercedTabParam = tabParam === 'encounters' ? 'communications' : tabParam;
  const activeTab: CaseTabKey = isCaseTabKey(coercedTabParam) ? coercedTabParam : DEFAULT_CASE_TAB;

  // Rail filters come from URL so back/forward replays them.
  const filters = useMemo<CaseRailFilters>(() => {
    const status = searchParams.get('status');
    const claim = searchParams.get('claim');
    const pageRaw = parseInt(searchParams.get('page') ?? '1', 10);
    const limitRaw = parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
    return {
      q: searchParams.get('q') ?? '',
      status: isStatus(status) ? status : undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
      claimTab: isClaimTab(claim) ? claim : 'unclaimed',
    };
  }, [searchParams]);

  const handleFiltersChange = useCallback((next: CaseRailFilters) => {
    setSearchParams((prev) => {
      const out = new URLSearchParams(prev);
      const setOrDelete = (k: string, v: string | undefined) => {
        if (v === undefined || v === '' || v === null) out.delete(k);
        else out.set(k, v);
      };
      setOrDelete('q', next.q || undefined);
      setOrDelete('status', next.status);
      setOrDelete('from', next.from);
      setOrDelete('to', next.to);
      if (next.claimTab === 'unclaimed') out.delete('claim');
      else out.set('claim', next.claimTab);
      if (next.page === 1) out.delete('page');
      else out.set('page', String(next.page));
      if (next.limit === DEFAULT_LIMIT) out.delete('limit');
      else out.set('limit', String(next.limit));
      return out;
    }, { replace: true });
  }, [setSearchParams]);

  const handleSelect = useCallback((caseId: string) => {
    const next = new URLSearchParams(searchParams);
    navigate({
      pathname: `/vendor/cases/${caseId}`,
      search: next.toString() ? `?${next.toString()}` : '',
    });
  }, [navigate, searchParams]);

  const handleTabChange = useCallback((tab: CaseTabKey) => {
    setSearchParams((prev) => {
      const out = new URLSearchParams(prev);
      if (tab === DEFAULT_CASE_TAB) out.delete('tab');
      else out.set('tab', tab);
      return out;
    }, { replace: true });
  }, [setSearchParams]);

  const handleBackToList = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    navigate({
      pathname: '/vendor/cases',
      search: next.toString() ? `?${next.toString()}` : '',
    });
  }, [navigate, searchParams]);

  // Detail state for the right panel.
  const [caseRow, setTicketRow] = useState<CaseRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Bumped whenever any claim/status/create mutation happens; the rail and
  // detail both refetch on change.
  const [refreshVersion, setRefreshVersion] = useState(0);
  const onMutated = useCallback(() => setRefreshVersion((v) => v + 1), []);

  // Create-modal state.
  const [showNew, setShowNew] = useState(false);
  const handleCreated = useCallback((row: CaseRow) => {
    setShowNew(false);
    onMutated();
    navigate(`/vendor/cases/${row.CaseId}`);
  }, [navigate, onMutated]);

  // Load the selected case.
  useEffect(() => {
    if (!id) {
      setTicketRow(null);
      setDetailError(null);
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    (async () => {
      try {
        const resp = await apiService.get<GetResp>(`/api/me/vendor/cases/${id}`, { signal: ac.signal });
        if (cancelled || ac.signal.aborted) return;
        if (resp.success) setTicketRow(resp.data);
        else setDetailError('Failed to load ticket');
      } catch (e) {
        if (cancelled || ac.signal.aborted) return;
        setDetailError(e instanceof Error ? e.message : 'Failed to load ticket');
      } finally {
        if (!cancelled && !ac.signal.aborted) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; ac.abort(); };
  }, [id, refreshVersion]);

  const onCaseUpdated = useCallback((next: CaseRow) => setTicketRow(next), []);

  return (
    <div className="flex h-full min-h-0 bg-white overflow-hidden">
      <CaseListRail
        selectedId={id}
        onSelect={handleSelect}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        refreshVersion={refreshVersion}
        onNewCase={() => setShowNew(true)}
        onOpenSettings={isVendorAdmin ? () => navigate('/vendor/cases/settings') : undefined}
        className={(id || isSettingsRoute) ? 'hidden md:flex' : 'flex'}
      />

      <main className={`flex-1 min-w-0 min-h-0 flex-col ${(id || isSettingsRoute) ? 'flex' : 'hidden md:flex'}`}>
        {isSettingsRoute && isVendorAdmin ? (
          <div className="flex-1 overflow-y-auto">
            <button
              type="button"
              onClick={() => navigate('/vendor/cases')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border-b border-gray-200 md:hidden"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to cases
            </button>
            <CaseSettings />
          </div>
        ) : isSettingsRoute && !isVendorAdmin ? (
          <div className="flex-1 p-6">
            <div className="bg-amber-50 border border-amber-200 rounded p-4 text-sm text-amber-800">
              Case settings are restricted to vendor admins.
            </div>
          </div>
        ) : id ? (
          <>
            <button
              type="button"
              onClick={handleBackToList}
              className="md:hidden inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border-b border-gray-200"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to case
            </button>
            {detailLoading ? (
              <div className="flex-1 p-6 text-sm text-gray-500">Loading...</div>
            ) : detailError ? (
              <div className="flex-1 p-6">
                <div className="bg-red-50 border border-red-200 rounded p-4 text-sm text-red-700">{detailError}</div>
              </div>
            ) : !caseRow ? (
              <div className="flex-1 p-6 text-sm text-gray-500">Case not found.</div>
            ) : (
              <>
                <CaseHeaderCard caseId={caseRow.CaseId} refreshVersion={refreshVersion} onMutated={onMutated} />
                <CaseWorkspaceTabs
                  caseRow={caseRow}
                  onCaseUpdated={onCaseUpdated}
                  activeTab={activeTab}
                  onTabChange={handleTabChange}
                />
              </>
            )}
          </>
        ) : (
          <CaseEmptyState onNew={() => setShowNew(true)} />
        )}
      </main>

      <CaseNewModal open={showNew} onClose={() => setShowNew(false)} onCreated={handleCreated} />
    </div>
  );
};

const CaseEmptyState = ({ onNew }: { onNew: () => void }) => (
  <div className="flex flex-col items-center justify-center text-center h-full py-16 px-6 animate-fade-in">
    <div className="relative mb-5">
      <div className="absolute inset-0 rounded-full bg-oe-light blur-2xl opacity-70" />
      <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-oe-light to-white border border-oe-light flex items-center justify-center shadow-soft">
        <Briefcase className="h-9 w-9 text-oe-primary" />
      </div>
    </div>
    <h2 className="text-lg font-semibold text-gray-900 mb-1.5">Select a case</h2>
    <p className="text-sm text-gray-500 max-w-sm leading-relaxed">
      Pick a case from the list to view its details, providers, plans, documents, communications, and notes.
    </p>
    <button
      type="button"
      onClick={onNew}
      className="mt-5 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
    >
      <Plus className="h-4 w-4" />
      New case
    </button>
    <p className="mt-6 text-xs text-gray-400 inline-flex items-center gap-1.5">
      <ArrowLeft className="h-3.5 w-3.5" />
      Use the list on the left
    </p>
  </div>
);

export default CaseWorkspace;
