import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList, Plus } from 'lucide-react';
import ShareRequestListRail, {
  type RailFilters,
  type ClaimerFilter,
} from '../../components/vendor/share-requests/ShareRequestListRail';
import ShareRequestHeaderCard from '../../components/vendor/share-requests/ShareRequestHeaderCard';
import ShareRequestWorkspaceTabs, {
  DEFAULT_TAB,
  isTabKey,
  type TabKey,
} from '../../components/vendor/share-requests/ShareRequestWorkspaceTabs';
import {
  type ShareRequestStatus,
  type ShareRequestDetermination,
  type ClaimTab,
  SHARE_REQUEST_STATUSES,
  SHARE_REQUEST_DETERMINATIONS,
} from '../../types/shareRequest.types';

const DEFAULT_LIMIT = 25;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isStatus = (v: string | null): v is ShareRequestStatus =>
  !!v && (SHARE_REQUEST_STATUSES as string[]).includes(v);
const isDetermination = (v: string | null): v is ShareRequestDetermination =>
  !!v && (SHARE_REQUEST_DETERMINATIONS as string[]).includes(v);
const isTypeId = (v: string | null): v is string => !!v && GUID_RE.test(v);

const isClaimTab = (v: string | null): v is ClaimTab =>
  v === 'unclaimed' || v === 'claimed' || v === 'all';
const parseClaimerFilter = (v: string | null): ClaimerFilter =>
  v && v.trim() ? v : 'me';

const ShareRequestWorkspace = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab');
  // `encounters` was its own top-level tab before being folded into the
  // Communications tab; bookmarked links keep working by redirecting here.
  const coercedTabParam = tabParam === 'encounters' ? 'communications' : tabParam;
  const activeTab: TabKey = isTabKey(coercedTabParam) ? coercedTabParam : DEFAULT_TAB;

  const filters = useMemo<RailFilters>(() => {
    const status = searchParams.get('status');
    const determination = searchParams.get('determination');
    const typeId = searchParams.get('typeId');
    const claimTabRaw = searchParams.get('claim');
    const pageRaw = parseInt(searchParams.get('page') ?? '1', 10);
    const limitRaw = parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
    return {
      q: searchParams.get('q') ?? '',
      status: isStatus(status) ? status : undefined,
      determination: isDetermination(determination) ? determination : undefined,
      typeId: isTypeId(typeId) ? typeId : undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
      claimTab: isClaimTab(claimTabRaw) ? claimTabRaw : 'unclaimed',
      claimerFilter: parseClaimerFilter(searchParams.get('claimedBy')),
    };
  }, [searchParams]);

  const handleFiltersChange = useCallback(
    (next: RailFilters) => {
      setSearchParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          const setOrDelete = (key: string, value: string | undefined) => {
            if (value === undefined || value === '' || value === null) {
              out.delete(key);
            } else {
              out.set(key, value);
            }
          };
          setOrDelete('q', next.q || undefined);
          setOrDelete('status', next.status);
          setOrDelete('determination', next.determination);
          setOrDelete('typeId', next.typeId);
          setOrDelete('from', next.from);
          setOrDelete('to', next.to);
          // Claim tab + claimer filter. Defaults are 'unclaimed' + 'me'.
          if (next.claimTab === 'unclaimed') out.delete('claim');
          else out.set('claim', next.claimTab);
          if (next.claimTab === 'unclaimed' || next.claimerFilter === 'me') {
            out.delete('claimedBy');
          } else {
            out.set('claimedBy', next.claimerFilter);
          }
          if (next.page === 1) out.delete('page');
          else out.set('page', String(next.page));
          if (next.limit === DEFAULT_LIMIT) out.delete('limit');
          else out.set('limit', String(next.limit));
          return out;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const handleSelect = useCallback(
    (shareRequestId: string) => {
      // Preserve current rail filters + tab in the new URL.
      const next = new URLSearchParams(searchParams);
      navigate({
        pathname: `/vendor/share-requests/${shareRequestId}`,
        search: next.toString() ? `?${next.toString()}` : '',
      });
    },
    [navigate, searchParams]
  );

  const handleTabChange = useCallback(
    (tab: TabKey) => {
      setSearchParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (tab === DEFAULT_TAB) {
            out.delete('tab');
          } else {
            out.set('tab', tab);
          }
          return out;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  // Bumped whenever a claim mutation happens anywhere (rail or header).
  // Both the rail and the header re-fetch (list + claimers + detail) on change.
  const [claimVersion, setClaimVersion] = useState(0);
  const onClaimMutated = useCallback(() => setClaimVersion((v) => v + 1), []);

  const handleBackToList = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    navigate({
      pathname: '/vendor/share-requests',
      search: next.toString() ? `?${next.toString()}` : '',
    });
  }, [navigate, searchParams]);

  return (
    <div className="flex h-full min-h-0 bg-white overflow-hidden">
      <ShareRequestListRail
        selectedId={id}
        onSelect={handleSelect}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        claimVersion={claimVersion}
        className={id ? 'hidden md:flex' : 'flex'}
      />

      <main
        className={`flex-1 min-w-0 min-h-0 flex-col ${id ? 'flex' : 'hidden md:flex'}`}
      >
        {id ? (
          <>
            <button
              type="button"
              onClick={handleBackToList}
              className="md:hidden inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border-b border-gray-200"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to share requests
            </button>
            <ShareRequestHeaderCard
              shareRequestId={id}
              claimVersion={claimVersion}
              onClaimMutated={onClaimMutated}
            />
            <ShareRequestWorkspaceTabs
              shareRequestId={id}
              activeTab={activeTab}
              onTabChange={handleTabChange}
              claimVersion={claimVersion}
            />
          </>
        ) : (
          <ShareRequestWorkspaceEmptyState onNew={() => navigate('/vendor/share-requests/new')} />
        )}
      </main>
    </div>
  );
};

const ShareRequestWorkspaceEmptyState = ({ onNew }: { onNew: () => void }) => (
  <div className="flex flex-col items-center justify-center text-center h-full py-16 px-6 animate-fade-in">
    <div className="relative mb-5">
      <div className="absolute inset-0 rounded-full bg-oe-light blur-2xl opacity-70" />
      <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-oe-light to-white border border-oe-light flex items-center justify-center shadow-soft">
        <ClipboardList className="h-9 w-9 text-oe-primary" />
      </div>
    </div>
    <h2 className="text-lg font-semibold text-gray-900 mb-1.5">Select a share request</h2>
    <p className="text-sm text-gray-500 max-w-sm leading-relaxed">
      Pick a share request from the list to view its details, providers, bills, ledger,
      documents, plans, and notes.
    </p>
    <button
      type="button"
      onClick={onNew}
      className="mt-5 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
    >
      <Plus className="h-4 w-4" />
      New share request
    </button>
    <p className="mt-6 text-xs text-gray-400 inline-flex items-center gap-1.5">
      <ArrowLeft className="h-3.5 w-3.5" />
      Use the rail on the left
    </p>
  </div>
);

export default ShareRequestWorkspace;
