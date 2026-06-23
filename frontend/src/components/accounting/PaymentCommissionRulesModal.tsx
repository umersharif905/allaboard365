// frontend/src/components/accounting/PaymentCommissionRulesModal.tsx
import { DollarSign, FileText, Hash, Percent, X } from 'lucide-react';
import React from 'react';

interface CommissionRule {
  RuleId: string;
  RuleName: string;
  Amount: number;
  CommissionType?: string; // 'Percentage', 'Flat', or 'Tiered'
  CommissionRate?: number; // Percentage rate (e.g., 0.05 for 5%)
  FlatAmount?: number; // Fixed dollar amount
  EntityType?: string; // 'Agent', 'Agency', 'Tier', or 'Split'
  TierLevel?: number; // Hierarchy level (0-5)
  Priority?: number; // Rule precedence
  SplitDetails?: {
    isSplit: boolean;
    primaryAgentId?: string;
    primaryAgentName?: string;
    agents?: Array<{
      agentId: string;
      agentName?: string;
      percentage?: number;
      flatAmount?: number;
    }>;
    splitPartnerAgentId?: string;
    splitPartnerName?: string;
    splitPercentage?: number;
    isPrimaryInSplit?: boolean;
  } | null;
}

interface PaymentCommissionRulesModalProps {
  paymentId: string | null;
  rules: CommissionRule[];
  paymentAmount: number;
  isOpen: boolean;
  onClose: () => void;
}

const PaymentCommissionRulesModal: React.FC<PaymentCommissionRulesModalProps> = ({
  paymentId,
  rules,
  paymentAmount,
  isOpen,
  onClose
}) => {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  const formatPercentage = (percentage: number) => {
    return `${percentage.toFixed(2)}%`;
  };

  if (!isOpen || !paymentId) return null;

  const totalCommission = rules.reduce((sum, rule) => sum + rule.Amount, 0);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <FileText className="w-6 h-6 text-oe-primary" />
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Commission Rules Applied</h2>
              <p className="text-sm text-gray-600 mt-1">
                {rules.length} rule{rules.length !== 1 ? 's' : ''} applied to this payment
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4">
            {/* Summary */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Payment Amount</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">{formatCurrency(paymentAmount)}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Total Commission</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">{formatCurrency(totalCommission)}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Commission Rate</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">
                    {paymentAmount > 0 ? formatPercentage((totalCommission / paymentAmount) * 100) : '0%'}
                  </p>
                </div>
              </div>
            </div>

            {/* Rules List */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Rules Applied (in order)</h3>
              <div className="space-y-3">
                {rules.map((rule, index) => (
                  <div
                    key={rule.RuleId || index}
                    className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 flex-1">
                        <div className="flex-shrink-0 w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                          <span className="text-sm font-semibold text-oe-primary">{index + 1}</span>
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <FileText className="w-4 h-4 text-gray-500" />
                            <h4 className="text-base font-semibold text-gray-900">{rule.RuleName || 'Unnamed Rule'}</h4>
                          </div>
                          {rule.RuleId && (
                            <p className="text-xs text-gray-500 font-mono mb-2">
                              ID: {rule.RuleId.substring(0, 8)}...
                            </p>
                          )}
                          <div className="grid grid-cols-2 gap-4 mt-3">
                            <div className="flex items-center gap-2">
                              <DollarSign className="w-4 h-4 text-green-600" />
                              <div>
                                <label className="text-xs text-gray-600">Amount Paid</label>
                                <p className="text-sm font-semibold text-gray-900">{formatCurrency(rule.Amount)}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Hash className="w-4 h-4 text-oe-primary" />
                              <div>
                                <label className="text-xs text-gray-600">Rule Type</label>
                                <p className="text-sm font-semibold text-gray-900">
                                  {rule.CommissionType || 'Unknown'}
                                  {rule.CommissionType === 'Percentage' && rule.CommissionRate && (
                                    <span className="text-gray-600 ml-1">
                                      ({formatPercentage(rule.CommissionRate * 100)})
                                    </span>
                                  )}
                                  {rule.CommissionType === 'Flat' && rule.FlatAmount && (
                                    <span className="text-gray-600 ml-1">
                                      ({formatCurrency(rule.FlatAmount)})
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>
                          </div>
                          {/* Split Commission Details */}
                          {rule.SplitDetails && rule.SplitDetails.isSplit && (
                            <div className="mt-3 pt-3 border-t border-orange-200 bg-orange-50 rounded-lg p-3">
                              <div className="flex items-center gap-2 mb-2">
                                <Percent className="w-4 h-4 text-orange-600" />
                                <h5 className="text-sm font-semibold text-orange-900">Split Commission</h5>
                              </div>
                              {rule.SplitDetails.agents && rule.SplitDetails.agents.length > 0 && (
                                <div className="space-y-2">
                                  {rule.SplitDetails.agents.map((agent, idx) => (
                                    <div key={idx} className="flex items-center justify-between text-sm">
                                      <span className="text-gray-700">
                                        {agent.agentName || `Agent ${idx + 1}`}
                                        {rule.SplitDetails?.primaryAgentId === agent.agentId && (
                                          <span className="ml-2 text-xs text-orange-600 font-medium">(Primary)</span>
                                        )}
                                      </span>
                                      <span className="font-semibold text-gray-900">
                                        {agent.percentage !== undefined 
                                          ? `${(agent.percentage * 100).toFixed(1)}%`
                                          : agent.flatAmount !== undefined
                                            ? formatCurrency(agent.flatAmount)
                                            : 'N/A'}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {rule.SplitDetails.splitPartnerName && (
                                <div className="mt-2 pt-2 border-t border-orange-200">
                                  <div className="text-xs text-gray-600">
                                    {rule.SplitDetails.isPrimaryInSplit ? 'Splitting with' : 'Split from'}:{' '}
                                    <span className="font-semibold text-gray-900">
                                      {rule.SplitDetails.splitPartnerName}
                                    </span>
                                    {rule.SplitDetails.splitPercentage !== null && rule.SplitDetails.splitPercentage !== undefined && (
                                      <span className="ml-2 text-gray-600">
                                        ({formatPercentage(rule.SplitDetails.splitPercentage * 100)})
                                      </span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          
                          {(rule.EntityType || rule.TierLevel !== undefined || rule.Priority !== undefined) && (
                            <div className="grid grid-cols-3 gap-4 mt-2 pt-2 border-t border-gray-100">
                              {rule.EntityType && (
                                <div>
                                  <label className="text-xs text-gray-600">Entity Type</label>
                                  <p className="text-sm text-gray-900">{rule.EntityType}</p>
                                </div>
                              )}
                              {rule.TierLevel !== undefined && (
                                <div>
                                  <label className="text-xs text-gray-600">Tier Level</label>
                                  <p className="text-sm text-gray-900">{rule.TierLevel}</p>
                                </div>
                              )}
                              {rule.Priority !== undefined && (
                                <div>
                                  <label className="text-xs text-gray-600">Priority</label>
                                  <p className="text-sm text-gray-900">{rule.Priority}</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {rules.length === 0 && (
              <div className="text-center py-8">
                <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">No commission rules found for this payment</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 p-4 bg-gray-50">
          <div className="flex items-center justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PaymentCommissionRulesModal;

