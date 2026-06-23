import { useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import MemberListRail from '../../components/vendor/members/MemberListRail';
import MemberWorkspaceEmptyState from '../../components/vendor/members/MemberWorkspaceEmptyState';
import MemberWorkspaceTabs, {
  type TabKey,
} from '../../components/vendor/members/MemberWorkspaceTabs';

const VALID_TABS: TabKey[] = [
  'details',
  'household',
  'plans',
  'new-request',
  'communications',
  'notes',
  'documents',
  'share-requests',
  'cases',
  'finances',
];

const VendorMembersWorkspace = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawTabParam = searchParams.get('tab');
  // Legacy: id-cards tab was merged into plans; encounters was folded into the
  // Communications tab as a sub-tab. Old bookmarks land on the new home.
  const coercedTabParam =
    rawTabParam === 'id-cards'
      ? 'plans'
      : rawTabParam === 'encounters'
        ? 'communications'
        : rawTabParam;
  const tabParam = coercedTabParam as TabKey | null;
  const activeTab: TabKey =
    tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'details';

  const handleSelect = useCallback(
    (memberId: string) => {
      navigate(`/vendor/members/${memberId}?tab=${activeTab}`);
    },
    [navigate, activeTab]
  );

  const handleTabChange = useCallback(
    (tab: TabKey) => {
      const next = new URLSearchParams(searchParams);
      if (tab === 'details') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const handleBackToList = useCallback(() => {
    navigate('/vendor/members');
  }, [navigate]);

  return (
    <div className="flex h-full min-h-0 bg-white">
      <MemberListRail
        selectedId={id}
        onSelect={handleSelect}
        className={id ? 'hidden md:flex' : 'flex'}
      />

      <main className={`flex-1 min-w-0 flex-col ${id ? 'flex' : 'hidden md:flex'}`}>
        {id ? (
          <>
            <button
              type="button"
              onClick={handleBackToList}
              className="md:hidden inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border-b border-gray-200"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to members
            </button>
            <MemberWorkspaceTabs
              memberId={id}
              activeTab={activeTab}
              onTabChange={handleTabChange}
            />
          </>
        ) : (
          <MemberWorkspaceEmptyState />
        )}
      </main>
    </div>
  );
};

export default VendorMembersWorkspace;
