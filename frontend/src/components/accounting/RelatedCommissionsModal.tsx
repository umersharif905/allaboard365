/**
 * Related Commissions Modal
 * Shows all commissions related to an advance (starting from the advance payment)
 */

import { X, TrendingUp, Calendar } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';

import CommissionStatusBadge from './CommissionStatusBadge';

interface RelatedCommissionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  commissionId: string;
  agentId: string;
  householdId?: string;
  groupId?: string;
  originalCommissionId?: string;
  transactionType?: string;
}

interface Commission {
  CommissionId: string;
  PaymentId: string;
  PaymentDate: string;
  Amount: number;
  AdvanceBalance: number | null;
  AppliedToBalance: number | null;
  RemainingAdvanceBalance: number | null; // Balance at the time of this transaction
  TransactionType: string;
  Status: string;
  MemberName: string;
  ProductName: string;
  PaymentAmount: number;
  CreatedDate: string;
  HouseholdId?: string;
  GroupId?: string;
  OriginalCommissionId?: string;
  // Phase 7c — populated for Refund/Chargeback rows linking back to the original positive row
  RelatedCommissionId?: string;
}

const RelatedCommissionsModal: React.FC<RelatedCommissionsModalProps> = ({
  isOpen,
  onClose,
  commissionId,
  agentId,
  householdId,
  groupId,
  originalCommissionId,
  transactionType
}) => {
  const [loading, setLoading] = useState(true);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadRelatedCommissions();
    }
  }, [isOpen, commissionId, agentId, householdId, groupId, originalCommissionId]);

  const loadRelatedCommissions = async () => {
    try {
      setLoading(true);
      setError(null);

      // Determine the root advance commission ID
      let rootCommissionId = commissionId;
      
      // If this is a commission row, find the original advance
      if (transactionType === 'Commission' && originalCommissionId) {
        rootCommissionId = originalCommissionId;
      }

      // Fetch all related commissions for this agent/household/group
      // We'll fetch all commissions and filter client-side
      const response = await apiService.get<{
        success: boolean;
        commissions: Commission[];
      }>(`/api/accounting/commissions?agentId=${agentId}`);

      if (response.success) {
        const allCommissions = response.commissions || [];
        
        // Filter to find related commissions:
        // 1. The advance commission (TransactionType = 'Advance')
        // 2. All commissions that reference this advance (OriginalCommissionId = advance.CommissionId)
        // Filter by HouseholdId or GroupId to ensure they're related
        const advanceCommission = allCommissions.find(
          c => c.CommissionId === rootCommissionId && c.TransactionType === 'Advance'
        ) || allCommissions.find(
          c => c.TransactionType === 'Advance' && 
          ((householdId && c.HouseholdId === householdId) || (groupId && c.GroupId === groupId))
        );

        if (advanceCommission) {
          const relatedCommissions = allCommissions.filter((c: Commission) => {
            // Include the advance commission
            if (c.CommissionId === advanceCommission.CommissionId) return true;

            // Include commissions that reference this advance
            if (c.OriginalCommissionId === advanceCommission.CommissionId) return true;

            // Phase 7c — include refund/chargeback clawbacks linked to either
            // the advance itself or to any of the related downstream rows.
            if (c.RelatedCommissionId === advanceCommission.CommissionId) return true;

            // Also include by household/group match (same agent, same household/group)
            if (householdId && c.HouseholdId === householdId) return true;
            if (groupId && c.GroupId === groupId) return true;

            return false;
          });

          // Sort by CreatedDate (newest first - advance at bottom, most recent at top)
          relatedCommissions.sort((a, b) => 
            new Date(b.CreatedDate).getTime() - new Date(a.CreatedDate).getTime()
          );

          setCommissions(relatedCommissions);
        } else {
          // If no advance found, just show this commission
          const currentCommission = allCommissions.find(c => c.CommissionId === commissionId);
          setCommissions(currentCommission ? [currentCommission] : []);
        }
      } else {
        throw new Error('Failed to load related commissions');
      }
    } catch (err: any) {
      console.error('Error loading related commissions:', err);
      setError(err.message || 'Failed to load related commissions');
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

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75" onClick={onClose}></div>

        <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-4xl sm:w-full">
          <div className="bg-white px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Advance Commission History</h3>
                <p className="text-sm text-gray-600 mt-1">All related commissions showing balance progression</p>
              </div>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-500 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
          </div>

          <div className="bg-white px-6 py-4 max-h-[70vh] overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
                <span className="ml-3 text-gray-600">Loading related commissions...</span>
              </div>
            )}

            {error && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-red-700">{error}</p>
              </div>
            )}

            {!loading && !error && (
              <div className="space-y-4">
                {commissions.length === 0 ? (
                  <div className="text-center py-8">
                    <TrendingUp className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <p className="text-gray-600">No related commissions found</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {commissions.map((commission, index) => {
                      const isAdvance = commission.TransactionType === 'Advance';
                      // Phase 7c — Refund/Chargeback rows are clawbacks created by RefundService
                      // (negative Amount, Status starts as Pending, flips to Paid when settled
                      // through NACHA). Surface them distinctly so finance can audit chargebacks.
                      const isClawback = commission.TransactionType === 'Refund' || commission.TransactionType === 'Chargeback';
                      const hasBalance = commission.RemainingAdvanceBalance !== null && commission.RemainingAdvanceBalance !== undefined;
                      const hasApplied = commission.AppliedToBalance !== null && commission.AppliedToBalance !== undefined;
                      const isSelected = commission.CommissionId === commissionId;
                      // Calculate advance number (1 = oldest/advance, higher = more recent)
                      const advanceNumber = commissions.length - index;

                      return (
                        <div
                          key={commission.CommissionId}
                          className={`border rounded-lg p-4 ${
                            isSelected
                              ? 'bg-purple-50 border-purple-300 ring-2 ring-purple-400'
                              : isClawback
                                ? 'bg-red-50 border-red-200'
                                : isAdvance
                                  ? 'bg-blue-50 border-blue-200'
                                  : 'bg-gray-50 border-gray-200'
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                {isAdvance && (
                                  <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                                    Advance Payment
                                  </span>
                                )}
                                {isClawback && (
                                  <span
                                    className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800"
                                    title="Negative-amount clawback row generated by a refund or chargeback. Nets against future payouts in the next NACHA cycle."
                                  >
                                    {commission.TransactionType === 'Chargeback' ? 'Chargeback' : 'Refund clawback'}
                                  </span>
                                )}
                                {!isAdvance && !isClawback && hasApplied && (
                                  <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
                                    Applied to Balance
                                  </span>
                                )}
                                <CommissionStatusBadge status={commission.Status} />
                              </div>

                              <div className="grid grid-cols-3 gap-4 mt-2">
                                <div>
                                  <p className="text-xs text-gray-500">Advance #</p>
                                  <p className="text-sm font-medium text-gray-900">{advanceNumber}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-gray-500">Member</p>
                                  <p className="text-sm font-medium text-gray-900">{commission.MemberName}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-gray-500">Payment Date</p>
                                  <p className="text-sm font-medium text-gray-900 flex items-center gap-1">
                                    <Calendar className="h-3 w-3" />
                                    {formatDate(commission.PaymentDate || commission.CreatedDate)}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-gray-500">Payment Amount</p>
                                  <p className="text-sm font-medium text-gray-900">{formatCurrency(commission.PaymentAmount)}</p>
                                </div>
                              </div>

                              <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-200">
                                <div>
                                  <p className="text-xs text-gray-500">Commission Amount</p>
                                  <p className="text-sm font-semibold text-gray-900">{formatCurrency(commission.Amount)}</p>
                                </div>
                                {hasApplied && (
                                  <div>
                                    <p className="text-xs text-gray-500">Applied to Balance</p>
                                    <p className="text-sm font-semibold text-yellow-700">
                                      {formatCurrency(commission.AppliedToBalance || 0)}
                                    </p>
                                  </div>
                                )}
                                {hasBalance && (
                                  <div>
                                    <p className="text-xs text-gray-500">Remaining Balance</p>
                                    <p className={`text-sm font-semibold ${commission.RemainingAdvanceBalance === 0 ? 'text-green-700' : 'text-red-700'}`}>
                                      {formatCurrency(commission.RemainingAdvanceBalance || 0)}
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-gray-50 px-6 py-4 border-t border-gray-200">
            <button
              onClick={onClose}
              className="w-full sm:w-auto px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RelatedCommissionsModal;

