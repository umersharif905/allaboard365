import React from 'react';
import { X } from 'lucide-react';
import AgentCommissionPayoutsView from './AgentCommissionPayoutsView';

interface AgentCommissionPayoutsModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  agentName?: string;
}

const AgentCommissionPayoutsModal: React.FC<AgentCommissionPayoutsModalProps> = ({
  isOpen,
  onClose,
  agentId,
  agentName,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center px-4 py-8">
        <button
          type="button"
          className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
          aria-label="Close"
          onClick={onClose}
        />
        <div className="relative bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col border border-gray-200">
          <div className="flex items-center justify-between p-6 border-b border-gray-200 shrink-0">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Commission Payouts</h2>
              {agentName && <p className="text-sm text-gray-500 mt-0.5">{agentName}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="p-6 overflow-y-auto flex-1">
            <AgentCommissionPayoutsView agentId={agentId} agentName={agentName} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentCommissionPayoutsModal;
