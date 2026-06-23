import React, { useState } from 'react';
import { CalendarClock, FileUp, Server, Share2, Settings2 } from 'lucide-react';
import VendorImportMembersWizard from './VendorImportMembersWizard';
import VendorImportShareRequestsWizard from './VendorImportShareRequestsWizard';
import VendorImportFormatsPanel from './VendorImportFormatsPanel';
import VendorSftpConnectionsManager from './VendorSftpConnectionsManager';
import VendorScheduledImportsManager from './VendorScheduledImportsManager';

interface Props {
  vendorId: string;
}

type Section = 'members' | 'formats' | 'share-requests' | 'sftp-connections' | 'scheduled-imports';

const VendorImportPanel: React.FC<Props> = ({ vendorId }) => {
  const [section, setSection] = useState<Section>('members');

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-gray-200">
        <button
          type="button"
          data-import-tab="members"
          onClick={() => setSection('members')}
          className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px ${
            section === 'members' ? 'border-oe-primary text-oe-primary font-medium' : 'border-transparent text-gray-500'
          }`}
        >
          <FileUp className="h-4 w-4" /> Members (eligibility)
        </button>
        <button
          type="button"
          onClick={() => setSection('formats')}
          className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px ${
            section === 'formats' ? 'border-oe-primary text-oe-primary font-medium' : 'border-transparent text-gray-500'
          }`}
        >
          <Settings2 className="h-4 w-4" /> Formats
        </button>
        <button
          type="button"
          onClick={() => setSection('share-requests')}
          className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px ${
            section === 'share-requests' ? 'border-oe-primary text-oe-primary font-medium' : 'border-transparent text-gray-500'
          }`}
        >
          <Share2 className="h-4 w-4" /> Sharing requests
        </button>
        <button
          type="button"
          onClick={() => setSection('sftp-connections')}
          className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px ${
            section === 'sftp-connections' ? 'border-oe-primary text-oe-primary font-medium' : 'border-transparent text-gray-500'
          }`}
        >
          <Server className="h-4 w-4" /> SFTP connections
        </button>
        <button
          type="button"
          onClick={() => setSection('scheduled-imports')}
          className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px ${
            section === 'scheduled-imports' ? 'border-oe-primary text-oe-primary font-medium' : 'border-transparent text-gray-500'
          }`}
        >
          <CalendarClock className="h-4 w-4" /> Scheduled imports
        </button>
      </div>

      {section === 'members' && <VendorImportMembersWizard vendorId={vendorId} />}
      {section === 'formats' && <VendorImportFormatsPanel vendorId={vendorId} />}
      {section === 'share-requests' && <VendorImportShareRequestsWizard vendorId={vendorId} />}
      {section === 'sftp-connections' && <VendorSftpConnectionsManager />}
      {section === 'scheduled-imports' && <VendorScheduledImportsManager />}
    </div>
  );
};

export default VendorImportPanel;
