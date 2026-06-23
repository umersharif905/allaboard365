import {
  Activity,
  FileText,
  FolderTree,
  MessageSquare,
  Package,
  Stethoscope,
  StickyNote,
  Wallet,
} from 'lucide-react';
import type { IconComponent } from '../../../types/icon';
import RequestDetailsTab from './tabs/RequestDetailsTab';
import PlansTab from './tabs/PlansTab';
import ProvidersTab from './tabs/ProvidersTab';
import NotesTab from './tabs/NotesTab';
import HistoryTab from './tabs/HistoryTab';
import FinancesTab from './tabs/FinancesTab';
import DocumentsTab from './tabs/DocumentsTab';
import CommunicationsWithSubtabs from '../shared/CommunicationsWithSubtabs';

export type TabKey =
  | 'request-details'
  | 'providers'
  | 'finances'
  | 'documents'
  | 'plans'
  | 'communications'
  | 'notes'
  | 'history';

interface TabDef {
  key: TabKey;
  label: string;
  icon: IconComponent;
}

// `as const satisfies` keeps literal narrowness so isTabKey can derive TabKey
// at compile time. No drift between TabKey union and runtime list.
export const TABS = [
  { key: 'request-details', label: 'Request Details',     icon: FileText },
  { key: 'providers',       label: 'Providers',           icon: Stethoscope },
  { key: 'finances',        label: 'Finances',            icon: Wallet },
  { key: 'documents',       label: 'Documents and Forms', icon: FolderTree },
  { key: 'plans',           label: 'Plans',               icon: Package },
  { key: 'communications',  label: 'Communications',      icon: MessageSquare },
  { key: 'notes',           label: 'Notes',               icon: StickyNote },
  { key: 'history',         label: 'History',             icon: Activity },
] as const satisfies readonly TabDef[];

export const isTabKey = (v: string | null | undefined): v is TabKey =>
  !!v && TABS.some((t) => t.key === v);

export const DEFAULT_TAB: TabKey = 'request-details';

interface ShareRequestWorkspaceTabsProps {
  shareRequestId: string;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  /**
   * Bumps when a claim/status mutation happens — passed to the HistoryTab
   * so it re-fetches the activity log without needing the user to tab away
   * and back.
   */
  claimVersion: number;
}

const ShareRequestWorkspaceTabs = ({
  shareRequestId,
  activeTab,
  onTabChange,
  claimVersion,
}: ShareRequestWorkspaceTabsProps) => {
  const renderActive = () => {
    switch (activeTab) {
      case 'request-details':
        return <RequestDetailsTab shareRequestId={shareRequestId} />;
      case 'providers':
        return <ProvidersTab shareRequestId={shareRequestId} />;
      case 'plans':
        return <PlansTab shareRequestId={shareRequestId} />;
      case 'finances':
        return <FinancesTab shareRequestId={shareRequestId} />;
      case 'documents':
        return <DocumentsTab shareRequestId={shareRequestId} />;
      case 'communications':
        return (
          <CommunicationsWithSubtabs
            encountersScope={{ kind: 'shareRequest', shareRequestId }}
            communicationsBasePath={`/api/me/vendor/share-requests/${shareRequestId}/communications`}
          />
        );
      case 'notes':
        return <NotesTab shareRequestId={shareRequestId} />;
      case 'history':
        return <HistoryTab shareRequestId={shareRequestId} claimVersion={claimVersion} />;
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="border-b border-gray-200 bg-white shrink-0">
        <nav
          role="tablist"
          aria-label="Share request sections"
          className="flex overflow-x-auto px-2 scrollbar-thin"
        >
          {TABS.map((tab) => (
            <TabButton
              key={tab.key}
              tab={tab}
              isActive={activeTab === tab.key}
              onClick={() => onTabChange(tab.key)}
            />
          ))}
        </nav>
      </div>

      <div
        role="tabpanel"
        id={`tabpanel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-gradient-to-b from-gray-50/40 to-white"
      >
        {/* Re-mount tab body when shareRequestId or tab changes so per-tab AbortControllers reset cleanly. */}
        <div key={`${shareRequestId}-${activeTab}`} className="animate-fade-in-fast h-full">
          {renderActive()}
        </div>
      </div>
    </div>
  );
};

interface TabButtonProps {
  tab: { key: TabKey; label: string; icon: IconComponent };
  isActive: boolean;
  onClick: () => void;
}

const TabButton = ({ tab, isActive, onClick }: TabButtonProps) => {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={`tabpanel-${tab.key}`}
      id={`tab-${tab.key}`}
      onClick={onClick}
      className={`group relative shrink-0 px-4 py-3 text-sm font-medium transition-colors flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oe-primary ${
        isActive ? 'text-oe-primary' : 'text-gray-500 hover:text-gray-800'
      }`}
    >
      <Icon
        className={`h-4 w-4 transition-transform duration-150 ${
          isActive ? 'scale-110' : 'group-hover:scale-110'
        }`}
      />
      <span>{tab.label}</span>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-2 right-2 -bottom-px h-0.5 rounded-full transition-all duration-200 ${
          isActive
            ? 'bg-oe-primary opacity-100 scale-x-100'
            : 'bg-gray-300 opacity-0 group-hover:opacity-50 scale-x-50'
        }`}
      />
    </button>
  );
};

export default ShareRequestWorkspaceTabs;
