// Tab nav + body switcher for the Case detail page: Case Details, Providers,
// Documents, Plans, Communications (Encounters + System Email/SMS sub-tabs),
// Notes, History.

import { useState } from 'react';
import {
  Activity,
  FileText,
  FolderTree,
  MessageSquare,
  Package,
  StickyNote,
  Stethoscope,
  Wallet,
} from 'lucide-react';
import type { IconComponent } from '../../../types/icon';
import type { CaseRow } from '../../../types/case.types';
import CaseDetailsTab from './tabs/CaseDetailsTab';
import CaseProvidersTab from './tabs/CaseProvidersTab';
import CaseFinancesTab from './tabs/CaseFinancesTab';
import CaseDocumentsTab from './tabs/CaseDocumentsTab';
import CaseNotesTab from './tabs/CaseNotesTab';
import CombinedPlansTab from '../shared/CombinedPlansTab';
import CommunicationsWithSubtabs from '../shared/CommunicationsWithSubtabs';
import HistoryTimeline from '../shared/HistoryTimeline';

export type CaseTabKey =
  | 'case-details'
  | 'providers'
  | 'finances'
  | 'documents'
  | 'plans'
  | 'communications'
  | 'notes'
  | 'history';

interface TabDef { key: CaseTabKey; label: string; icon: IconComponent }

const TABS: readonly TabDef[] = [
  { key: 'case-details',   label: 'Case Details',   icon: FileText },
  { key: 'providers',      label: 'Providers',      icon: Stethoscope },
  { key: 'finances',       label: 'Finances',       icon: Wallet },
  { key: 'documents',      label: 'Documents and Forms', icon: FolderTree },
  { key: 'plans',          label: 'Plans',          icon: Package },
  { key: 'communications', label: 'Communications', icon: MessageSquare },
  { key: 'notes',          label: 'Notes',          icon: StickyNote },
  { key: 'history',        label: 'History',        icon: Activity },
];

export const DEFAULT_CASE_TAB: CaseTabKey = 'case-details';

export const isCaseTabKey = (v: string | null | undefined): v is CaseTabKey =>
  !!v && TABS.some((t) => t.key === v);

interface CaseWorkspaceTabsProps {
  caseRow: CaseRow;
  onCaseUpdated: (next: CaseRow) => void;
  activeTab?: CaseTabKey;
  onTabChange?: (k: CaseTabKey) => void;
}

const CaseWorkspaceTabs = ({
  caseRow,
  onCaseUpdated,
  activeTab: activeTabProp,
  onTabChange,
}: CaseWorkspaceTabsProps) => {
  const [internalTab, setInternalTab] = useState<CaseTabKey>(DEFAULT_CASE_TAB);
  const activeTab = activeTabProp ?? internalTab;
  const setActive = (k: CaseTabKey) => {
    if (onTabChange) onTabChange(k);
    else setInternalTab(k);
  };

  const renderBody = () => {
    switch (activeTab) {
      case 'case-details':
        return <CaseDetailsTab caseRow={caseRow} onCaseUpdated={onCaseUpdated} />;
      case 'providers':
        return <CaseProvidersTab caseId={caseRow.CaseId} />;
      case 'finances':
        return <CaseFinancesTab caseId={caseRow.CaseId} />;
      case 'documents':
        return <CaseDocumentsTab caseId={caseRow.CaseId} />;
      case 'plans':
        return <CombinedPlansTab memberId={caseRow.MemberId} />;
      case 'communications':
        return (
          <CommunicationsWithSubtabs
            encountersScope={{ kind: 'case', caseId: caseRow.CaseId, memberId: caseRow.MemberId }}
            communicationsBasePath={`/api/me/vendor/members/${caseRow.MemberId}/communications`}
          />
        );
      case 'notes':
        return <CaseNotesTab caseId={caseRow.CaseId} />;
      case 'history':
        return <HistoryTimeline entityType="case" entityId={caseRow.CaseId} />;
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="border-b border-gray-200 bg-white shrink-0">
        <nav role="tablist" aria-label="Case sections" className="flex overflow-x-auto px-2 scrollbar-thin">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(tab.key)}
                className={`group relative shrink-0 px-4 py-3 text-sm font-medium transition-colors flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oe-primary ${
                  isActive ? 'text-oe-primary' : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                <Icon className={`h-4 w-4 transition-transform duration-150 ${isActive ? 'scale-110' : 'group-hover:scale-110'}`} />
                <span>{tab.label}</span>
                <span
                  aria-hidden
                  className={`pointer-events-none absolute left-2 right-2 -bottom-px h-0.5 rounded-full transition-all duration-200 ${
                    isActive ? 'bg-oe-primary opacity-100 scale-x-100' : 'bg-gray-300 opacity-0 group-hover:opacity-50 scale-x-50'
                  }`}
                />
              </button>
            );
          })}
        </nav>
      </div>

      <div role="tabpanel" className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-gradient-to-b from-gray-50/40 to-white">
        <div key={`${caseRow.CaseId}-${activeTab}`} className="animate-fade-in-fast h-full">
          {renderBody()}
        </div>
      </div>
    </div>
  );
};

export default CaseWorkspaceTabs;
