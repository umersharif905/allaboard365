// frontend/src/components/accounting/NACHAPayoutRulesModal.tsx
import { FileText, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import { nachaService } from '../../services/nachaService';

interface CommissionRule {
  RuleId: string;
  RuleName: string;
  ProductId?: string;
  ProductName?: string;
  CommissionType?: string;
  CommissionRate?: number;
  FlatAmount?: number;
  TierLevel?: number;
  Priority?: number;
  CommissionJson?: string | any; // For tiered rules
}

interface RuleAggregation {
  ruleId: string;
  rule: CommissionRule | null;
  paymentCount: number;
  totalAmount: number;
  loading: boolean;
  tierLevelUsed?: number | null; // The tier level used for this agent/agency
}

interface NACHAPayoutRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityType: string;
  entityId: string;
  totalAmount: number;
  recipientName: string;
  startDate: string;
  endDate: string;
}

const NACHAPayoutRulesModal: React.FC<NACHAPayoutRulesModalProps> = ({
  isOpen,
  onClose,
  entityType,
  entityId,
  totalAmount,
  recipientName,
  startDate,
  endDate
}) => {
  const [rules, setRules] = useState<RuleAggregation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && (entityType === 'Agent' || entityType === 'Agency')) {
      fetchRulesFromPayments();
    } else {
      setRules([]);
      setError(null);
    }
  }, [isOpen, entityType, entityId, startDate, endDate]);

  const fetchRulesFromPayments = async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch payment details for this recipient
      const response = await nachaService.getPreviewRecipientPayments(
        entityType,
        entityId,
        startDate,
        endDate
      );

      if (!response.success || !response.paymentDetails) {
        throw new Error('Failed to fetch payment details');
      }

      const paymentDetails = response.paymentDetails;

      // Aggregate rules across all payments
      const ruleMap = new Map<string, { paymentCount: number; totalAmount: number; tierLevelUsed?: number | null }>();

      for (const payment of paymentDetails) {
        const ruleIds = (payment as any).ruleIds || [];
        const tierLevel = (payment as any).tierLevel ?? null;
        // For agencies, use commissionAmount if available, otherwise use overflowAmount
        const commissionAmount = payment.commissionAmount || (payment as any).overflowAmount || 0;

        // Each payment can have multiple rules, but we only have the total commission amount
        // So we'll divide the amount equally among the rules (or could be improved with actual per-rule amounts)
        const amountPerRule = ruleIds.length > 0 ? commissionAmount / ruleIds.length : commissionAmount;

        for (const ruleId of ruleIds) {
          if (!ruleMap.has(ruleId)) {
            ruleMap.set(ruleId, { paymentCount: 0, totalAmount: 0, tierLevelUsed: tierLevel });
          }
          const ruleData = ruleMap.get(ruleId)!;
          ruleData.paymentCount += 1;
          ruleData.totalAmount += amountPerRule;
          // Use the tier level from the first payment (or most common one)
          // For simplicity, we'll use the tier level from the first payment we see
          if (ruleData.tierLevelUsed === null || ruleData.tierLevelUsed === undefined) {
            ruleData.tierLevelUsed = tierLevel;
          }
        }
      }

      // Fetch rule details for each unique ruleId
      const ruleIds = Array.from(ruleMap.keys());
      const ruleAggregations: RuleAggregation[] = await Promise.all(
        ruleIds.map(async (ruleId): Promise<RuleAggregation> => {
          try {
            const ruleResponse = await apiService.get<{ success: boolean; rule: CommissionRule }>(
              `/api/commissions/rules/${ruleId}`
            );
            return {
              ruleId,
              rule: ruleResponse.success && ruleResponse.rule ? ruleResponse.rule : null,
              paymentCount: ruleMap.get(ruleId)!.paymentCount,
              totalAmount: ruleMap.get(ruleId)!.totalAmount,
              tierLevelUsed: ruleMap.get(ruleId)!.tierLevelUsed,
              loading: false
            };
          } catch (err) {
            console.error(`Error fetching rule ${ruleId}:`, err);
            return {
              ruleId,
              rule: null,
              paymentCount: ruleMap.get(ruleId)!.paymentCount,
              totalAmount: ruleMap.get(ruleId)!.totalAmount,
              tierLevelUsed: ruleMap.get(ruleId)!.tierLevelUsed,
              loading: false
            };
          }
        })
      );

      // Sort by Priority (lower number = higher priority), then by TierLevel
      ruleAggregations.sort((a, b) => {
        const priorityA = a.rule?.Priority ?? 999;
        const priorityB = b.rule?.Priority ?? 999;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }
        return (a.rule?.TierLevel ?? 0) - (b.rule?.TierLevel ?? 0);
      });

      setRules(ruleAggregations);
    } catch (err: any) {
      console.error('Error fetching rules from payments:', err);
      setError(err.message || 'Failed to load commission rules');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  const formatPercentage = (percentage: number) => {
    return `${(percentage * 100).toFixed(2)}%`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <FileText className="w-6 h-6 text-oe-primary" />
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Commission Rules</h2>
              <p className="text-sm text-gray-600 mt-1">
                Rules applied across all payments for {recipientName}
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
          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto"></div>
              <p className="text-gray-600 mt-4">Loading commission rules...</p>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <p className="text-red-600">{error}</p>
            </div>
          ) : rules.length === 0 ? (
            <div className="text-center py-8">
              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">No commission rules found</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Summary */}
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Total Payout Amount</label>
                    <p className="text-lg font-semibold text-gray-900 mt-1">{formatCurrency(totalAmount)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Total Payments</label>
                    <p className="text-lg font-semibold text-gray-900 mt-1">
                      {rules.reduce((sum, r) => sum + r.paymentCount, 0)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Rules List */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Rules Applied (in priority order)</h3>
                <div className="space-y-3">
                  {rules.map((ruleAgg, index) => (
                    <div
                      key={ruleAgg.ruleId}
                      className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                          <span className="text-sm font-semibold text-oe-primary">{index + 1}</span>
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <FileText className="w-4 h-4 text-gray-500" />
                            <h4 className="text-base font-semibold text-gray-900">
                              {ruleAgg.rule?.RuleName || 'Unknown Rule'}
                            </h4>
                          </div>
                          <div className="grid grid-cols-3 gap-4 mb-3">
                            <div>
                              <label className="text-xs text-gray-600">Commission Type</label>
                              <p className="text-sm font-semibold text-gray-900">
                                {ruleAgg.rule?.CommissionType || 'Unknown'}
                                {ruleAgg.rule?.CommissionType === 'Percentage' && ruleAgg.rule.CommissionRate !== null && ruleAgg.rule.CommissionRate !== undefined && (
                                  <span className="text-gray-600 ml-1">
                                    ({formatPercentage(ruleAgg.rule.CommissionRate)})
                                  </span>
                                )}
                                {ruleAgg.rule?.CommissionType === 'Flat' && ruleAgg.rule.FlatAmount !== null && ruleAgg.rule.FlatAmount !== undefined && (
                                  <span className="text-gray-600 ml-1">
                                    ({formatCurrency(ruleAgg.rule.FlatAmount)})
                                  </span>
                                )}
                                {ruleAgg.rule?.CommissionType === 'Tiered' && ruleAgg.rule.CommissionJson && (() => {
                                  try {
                                    const commissionConfig = typeof ruleAgg.rule.CommissionJson === 'string' 
                                      ? JSON.parse(ruleAgg.rule.CommissionJson) 
                                      : ruleAgg.rule.CommissionJson;
                                    if (commissionConfig.tiers && Array.isArray(commissionConfig.tiers) && commissionConfig.tiers.length > 0) {
                                      const tierLevelUsed = ruleAgg.tierLevelUsed;
                                      const tierData = commissionConfig.tiers
                                        .map((t: any) => {
                                          const level = t.level ?? t.tierLevel ?? 0;
                                          const name = t.name || `Level ${level}`;
                                          const rate = t.rate ?? t.percentage ?? 0;
                                          const ratePercent = rate > 1 ? rate : rate * 100;
                                          const isBold = tierLevelUsed !== null && tierLevelUsed !== undefined && level === tierLevelUsed;
                                          return { level, name, ratePercent, isBold };
                                        })
                                        .filter((t: any) => t.ratePercent > 0);
                                      
                                      if (tierData.length > 0) {
                                        return (
                                          <div className="text-gray-600 ml-1 text-xs mt-1">
                                            {tierData.map((t: any) => (
                                              <div key={t.level}>
                                                {t.isBold ? (
                                                  <strong>{t.name}: {t.ratePercent.toFixed(0)}%</strong>
                                                ) : (
                                                  <span>{t.name}: {t.ratePercent.toFixed(0)}%</span>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        );
                                      }
                                    }
                                  } catch (e) {
                                    // Ignore parse errors
                                  }
                                  return null;
                                })()}
                              </p>
                            </div>
                            {ruleAgg.rule?.ProductName && ruleAgg.rule?.ProductId !== '00000000-0000-0000-0000-000000000000' && (
                              <div>
                                <label className="text-xs text-gray-600">Product</label>
                                <p className="text-sm font-semibold text-gray-900">{ruleAgg.rule.ProductName}</p>
                              </div>
                            )}
                            {ruleAgg.rule?.Priority !== null && ruleAgg.rule?.Priority !== undefined && (
                              <div>
                                <label className="text-xs text-gray-600">Priority</label>
                                <p className="text-sm font-semibold text-gray-900">{ruleAgg.rule.Priority}</p>
                              </div>
                            )}
                          </div>
                          
                          {/* Payment statistics */}
                          <div className="border-t border-gray-200 pt-3 mt-3">
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <label className="text-xs text-gray-600">Payments Applied To</label>
                                <p className="text-sm font-semibold text-gray-900">{ruleAgg.paymentCount}</p>
                              </div>
                              <div>
                                <label className="text-xs text-gray-600">Total Amount</label>
                                <p className="text-sm font-semibold text-gray-900">{formatCurrency(ruleAgg.totalAmount)}</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
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

export default NACHAPayoutRulesModal;
