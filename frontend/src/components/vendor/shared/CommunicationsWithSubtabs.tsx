// Combined Communications surface — one tab in the SR / Case workspace that
// hosts both Encounters (member-team interactions logged by staff) and the
// System Email/SMS feed (the old standalone Communications tab). Sub-tab
// state lives locally; defaults to Encounters per UX preference.

import { useState } from 'react';
import { MessageCircle, MessageSquare } from 'lucide-react';
import EncountersList from '../encounters/EncountersList';
import CommunicationsTab from './CommunicationsTab';
import type { EncounterScope } from '../../../types/encounter.types';

type SubTab = 'encounters' | 'system';

interface CommunicationsWithSubtabsProps {
  encountersScope: EncounterScope;
  /** Same prop CommunicationsTab takes today — the base URL for the
   *  workspace-scoped system email/SMS feed (e.g.
   *  `/api/me/vendor/share-requests/{id}/communications`). */
  communicationsBasePath: string;
}

const CommunicationsWithSubtabs = ({
  encountersScope,
  communicationsBasePath,
}: CommunicationsWithSubtabsProps) => {
  const [sub, setSub] = useState<SubTab>('encounters');

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="border-b border-gray-200 bg-white shrink-0 px-2">
        <nav role="tablist" aria-label="Communications sub-tabs" className="flex gap-1">
          <SubTabButton
            active={sub === 'encounters'}
            onClick={() => setSub('encounters')}
            icon={MessageCircle}
            label="Encounters"
          />
          <SubTabButton
            active={sub === 'system'}
            onClick={() => setSub('system')}
            icon={MessageSquare}
            label="System Email/SMS"
          />
        </nav>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {sub === 'encounters' ? (
          <EncountersList scope={encountersScope} />
        ) : (
          <CommunicationsTab basePath={communicationsBasePath} />
        )}
      </div>
    </div>
  );
};

interface SubTabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: typeof MessageCircle;
  label: string;
}

const SubTabButton = ({ active, onClick, icon: Icon, label }: SubTabButtonProps) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={`group relative px-3 py-2 text-xs font-medium transition-colors inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oe-primary ${
      active ? 'text-oe-primary' : 'text-gray-500 hover:text-gray-800'
    }`}
  >
    <Icon className="h-3.5 w-3.5" />
    <span>{label}</span>
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute left-2 right-2 -bottom-px h-0.5 rounded-full transition-all duration-150 ${
        active ? 'bg-oe-primary opacity-100' : 'bg-gray-300 opacity-0 group-hover:opacity-50'
      }`}
    />
  </button>
);

export default CommunicationsWithSubtabs;
