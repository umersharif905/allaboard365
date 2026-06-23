import { useEffect, useState } from 'react';
import {
  Briefcase,
  ClipboardList,
  DollarSign,
  FileText,
  Home,
  MessageSquare,
  Package,
  Plus,
  StickyNote,
  User,
} from 'lucide-react';
import type { IconComponent } from '../../../types/icon';
import { apiService } from '../../../services/api.service';
import MemberStatusBanner, { type MemberStatus } from './MemberStatusBanner';
import MemberDetailsTab from './tabs/MemberDetailsTab';
import MemberHouseholdTab from './tabs/MemberHouseholdTab';
import MemberNewRequestTab from './tabs/MemberNewRequestTab';
import MemberNotesTab from './tabs/MemberNotesTab';
import MemberDocumentsTab from './tabs/MemberDocumentsTab';
import MemberShareRequestsTab from './tabs/MemberShareRequestsTab';
import MemberCasesTab from './tabs/MemberCasesTab';
import MemberFinancesTab from './tabs/MemberFinancesTab';
import CombinedPlansTab from '../shared/CombinedPlansTab';
import CommunicationsWithSubtabs from '../shared/CommunicationsWithSubtabs';

export type TabKey =
  | 'details'
  | 'household'
  | 'plans'
  | 'new-request'
  | 'communications'
  | 'notes'
  | 'documents'
  | 'share-requests'
  | 'cases'
  | 'finances';

interface TabDef {
  key: TabKey;
  label: string;
  icon: IconComponent;
  shareRequestGated?: boolean;
}

const TABS: TabDef[] = [
  { key: 'details', label: 'Details', icon: User },
  { key: 'household', label: 'Household', icon: Home },
  { key: 'plans', label: 'Plans', icon: Package },
  { key: 'new-request', label: 'New Request', icon: Plus, shareRequestGated: true },
  { key: 'communications', label: 'Communications', icon: MessageSquare },
  { key: 'notes', label: 'Notes', icon: StickyNote },
  { key: 'documents', label: 'Documents', icon: FileText },
  { key: 'share-requests', label: 'Share Requests', icon: ClipboardList, shareRequestGated: true },
  { key: 'cases', label: 'Cases', icon: Briefcase, shareRequestGated: true },
  { key: 'finances', label: 'Finances', icon: DollarSign, shareRequestGated: true },
];

interface MemberWorkspaceTabsProps {
  memberId: string;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

interface MemberHeader {
  MemberStatus?: MemberStatus | string;
  MigrationSourceSystem?: string | null;
  MemberRawStatus?: string | null;
}

const MemberWorkspaceTabs = ({ memberId, activeTab, onTabChange }: MemberWorkspaceTabsProps) => {
  const [shareRequestEnabled, setShareRequestEnabled] = useState<boolean | null>(null);
  const [memberHeader, setMemberHeader] = useState<MemberHeader | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await apiService.get<{ success: boolean }>(
        '/api/me/vendor/share-requests/dashboard'
        );
        if (!cancelled) setShareRequestEnabled(response.success === true);
      } catch {
        if (!cancelled) setShareRequestEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMemberHeader(null);
    (async () => {
      try {
        const r = await apiService.get<{ success: boolean; data: MemberHeader }>(
          `/api/me/vendor/members/${memberId}`
        );
        if (!cancelled && r.success) {
          setMemberHeader({
            MemberStatus: r.data?.MemberStatus,
            MigrationSourceSystem: r.data?.MigrationSourceSystem,
            MemberRawStatus: r.data?.MemberRawStatus,
          });
        }
      } catch {
        // Banner is non-critical; failure to load shouldn't break the workspace.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  const visibleTabs = TABS.filter(
    (tab) => !tab.shareRequestGated || shareRequestEnabled !== false
  );

  // If active tab was hidden by feature flag, snap back to details.
  useEffect(() => {
    if (shareRequestEnabled === false) {
      const def = TABS.find((t) => t.key === activeTab);
      if (def?.shareRequestGated) onTabChange('details');
    }
  }, [shareRequestEnabled, activeTab, onTabChange]);

  const renderActive = () => {
    switch (activeTab) {
      case 'details':
        return <MemberDetailsTab memberId={memberId} />;
      case 'household':
        return <MemberHouseholdTab memberId={memberId} />;
      case 'plans':
        return <CombinedPlansTab memberId={memberId} />;
      case 'new-request':
        return <MemberNewRequestTab memberId={memberId} />;
      case 'communications':
        return (
          <CommunicationsWithSubtabs
            encountersScope={{ kind: 'member', memberId }}
            communicationsBasePath={`/api/me/vendor/members/${memberId}/communications`}
          />
        );
      case 'notes':
        return <MemberNotesTab memberId={memberId} />;
      case 'documents':
        return <MemberDocumentsTab memberId={memberId} />;
      case 'share-requests':
        return <MemberShareRequestsTab memberId={memberId} />;
      case 'cases':
        return <MemberCasesTab memberId={memberId} />;
      case 'finances':
        return <MemberFinancesTab memberId={memberId} />;
      default:
        return <MemberDetailsTab memberId={memberId} />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {memberHeader?.MemberStatus && memberHeader.MemberStatus !== 'Active' && (
        <MemberStatusBanner
          status={memberHeader.MemberStatus}
          migrationSource={memberHeader.MigrationSourceSystem}
          rawStatus={memberHeader.MemberRawStatus}
        />
      )}
      <div className="border-b border-gray-200 bg-white">
        <nav
          role="tablist"
          aria-label="Member sections"
          className="flex overflow-x-auto px-2 scrollbar-thin"
        >
          {visibleTabs.map((tab) => {
            const isActive = activeTab === tab.key;
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`tabpanel-${tab.key}`}
                id={`tab-${tab.key}`}
                onClick={() => onTabChange(tab.key)}
                className={`group relative shrink-0 px-4 py-3 text-sm font-medium transition-colors flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oe-primary ${
                  isActive
                    ? 'text-oe-primary'
                    : 'text-gray-500 hover:text-gray-800'
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
          })}
        </nav>
      </div>

      <div
        role="tabpanel"
        id={`tabpanel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        className="flex-1 overflow-y-auto bg-gradient-to-b from-gray-50/40 to-white"
      >
        {/* Re-mount tab body when memberId changes so per-tab AbortControllers reset cleanly. */}
        <div key={`${memberId}-${activeTab}`} className="animate-fade-in-fast h-full">
          {renderActive()}
        </div>
      </div>
    </div>
  );
};

export default MemberWorkspaceTabs;
