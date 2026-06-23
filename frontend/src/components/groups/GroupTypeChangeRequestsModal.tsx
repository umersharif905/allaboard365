import { ArrowLeftRight, X } from 'lucide-react';
import React from 'react';
import GroupTypeChangeRequests from '../../pages/tenant-admin/GroupTypeChangeRequests';

/** Tenant-admin queue for Standard ↔ List Bill type changes; nested dialogs use a higher z-index than this shell. */
export interface GroupTypeChangeRequestsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const GroupTypeChangeRequestsModal: React.FC<GroupTypeChangeRequestsModalProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      aria-hidden={false}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        aria-label="Close change requests"
        onClick={onClose}
      />
      <div
        className="relative bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden"
        role="document"
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-200 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-gray-900">
              <ArrowLeftRight className="h-5 w-5 shrink-0 text-oe-primary" aria-hidden />
              <h2 id="group-type-change-requests-modal-title" className="text-lg font-semibold">
                Group Type Change Requests
              </h2>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              Review and act on agent requests to convert groups between Standard and List Bill.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 pt-3">
          <GroupTypeChangeRequests
            layout="embedded"
            approveDenyOverlayZClass="z-[110]"
            crossTenant={false}
          />
        </div>
      </div>
    </div>
  );
};

export default GroupTypeChangeRequestsModal;
