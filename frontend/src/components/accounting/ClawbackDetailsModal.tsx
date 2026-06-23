import { Loader, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
  CommissionClawbackDetailRow,
  PayoutClawbackDetailRow,
  getCommissionClawbackDetails,
  getPayoutClawbackDetails,
} from '../../services/accounting/clawbackDetails.service';

type Source =
  | { kind: 'commission'; entityType: 'Agent' | 'Agency'; entityId: string }
  | { kind: 'payout'; payoutType: 'Vendor' | 'TenantOverride'; recipientEntityId: string };

interface Props {
  isOpen: boolean;
  onClose: () => void;
  recipientLabel: string;
  source: Source | null;
  /** Open MemberManagementModal (or equivalent) for the household's primary member */
  onOpenMember?: (memberId: string) => void;
  /** Navigate to the group page (caller decides the role-aware route) */
  onOpenGroup?: (groupId: string, groupName?: string | null) => void;
}

function formatCurrency(amount: number | null | undefined) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    Number(amount || 0)
  );
}

function formatDate(d: string | null | undefined) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return '—';
  }
}

const ClawbackDetailsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  recipientLabel,
  source,
  onOpenMember,
  onOpenGroup,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commissionRows, setCommissionRows] = useState<CommissionClawbackDetailRow[]>([]);
  const [payoutRows, setPayoutRows] = useState<PayoutClawbackDetailRow[]>([]);
  const [totalPending, setTotalPending] = useState<number>(0);

  useEffect(() => {
    if (!isOpen || !source) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setCommissionRows([]);
      setPayoutRows([]);
      try {
        if (source.kind === 'commission') {
          const res = await getCommissionClawbackDetails({
            entityType: source.entityType,
            entityId: source.entityId,
          });
          if (cancelled) return;
          if (res.success) {
            setCommissionRows(res.data.items || []);
            setTotalPending(res.data.totalPending || 0);
          } else {
            setError('Failed to load commission clawback details');
          }
        } else {
          const res = await getPayoutClawbackDetails({
            payoutType: source.payoutType,
            recipientEntityId: source.recipientEntityId,
          });
          if (cancelled) return;
          if (res.success) {
            setPayoutRows(res.data.items || []);
            setTotalPending(res.data.totalPending || 0);
          } else {
            setError('Failed to load payout clawback details');
          }
        }
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || 'Failed to load clawback details');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, source]);

  const sourceLabel = useMemo(() => {
    if (!source) return '';
    if (source.kind === 'commission') {
      return source.entityType === 'Agent' ? 'Agent commission clawback' : 'Agency commission clawback';
    }
    return source.payoutType === 'Vendor' ? 'Vendor payout clawback' : 'Tenant override clawback';
  }, [source]);

  if (!isOpen) return null;

  const isCommission = source?.kind === 'commission';
  const rowCount = isCommission ? commissionRows.length : payoutRows.length;

  const renderCustomer = (
    groupId: string | null,
    groupName: string | null,
    primaryMemberId: string | null,
    householdName: string | null
  ) => {
    if (groupId && groupName) {
      if (onOpenGroup) {
        return (
          <button
            type="button"
            onClick={() => onOpenGroup(groupId, groupName)}
            className="text-blue-600 hover:underline font-medium text-left"
          >
            {groupName}
          </button>
        );
      }
      return <span>{groupName}</span>;
    }
    if (householdName) {
      if (primaryMemberId && onOpenMember) {
        return (
          <button
            type="button"
            onClick={() => onOpenMember(primaryMemberId)}
            className="text-blue-600 hover:underline font-medium text-left"
          >
            {householdName}
          </button>
        );
      }
      return <span>{householdName}</span>;
    }
    return <span className="text-gray-400">—</span>;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[80] p-4">
      <div className="bg-white rounded-lg border border-gray-200 w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-5 border-b border-gray-200 flex items-start justify-between flex-shrink-0">
          <div>
            <p className="text-xs uppercase tracking-wide text-orange-700 font-medium">
              {sourceLabel}
            </p>
            <h3 className="text-lg font-semibold text-gray-900 mt-0.5">{recipientLabel}</h3>
            <p className="text-sm text-gray-600 mt-1">
              {loading ? (
                'Loading…'
              ) : (
                <>
                  <span className="font-medium text-orange-700">
                    −{formatCurrency(totalPending)}
                  </span>{' '}
                  pending across {rowCount} refund{rowCount === 1 ? '' : 's'} — will reduce next NACHA payout.
                </>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-50"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-5 bg-red-50 border border-red-200 text-red-800 p-3 rounded-md text-sm">
              {error}
            </div>
          )}

          {loading ? (
            <div className="p-10 text-center text-gray-500">
              <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
              Loading refund history…
            </div>
          ) : rowCount === 0 ? (
            <div className="p-10 text-center text-gray-500 text-sm">
              No pending clawback refunds for this recipient.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Refund Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Customer
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Reason
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                      Refund Amt
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-orange-700 uppercase">
                      Clawback
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {isCommission
                    ? commissionRows.map((r, i) => (
                        <tr key={r.commissionId || `c-${i}`} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-700 align-top whitespace-nowrap">
                            {formatDate(r.refundDate || r.createdDate)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700 align-top">
                            {renderCustomer(
                              r.groupId,
                              r.groupName,
                              r.primaryMemberId,
                              r.householdName
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700 align-top max-w-xs">
                            <div className="truncate" title={r.refundReason || r.refundNotes || ''}>
                              {r.refundReason || r.refundNotes || (
                                <span className="text-gray-400">—</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700 text-right align-top whitespace-nowrap">
                            {r.refundAmount != null ? formatCurrency(r.refundAmount) : '—'}
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-orange-700 text-right align-top whitespace-nowrap">
                            −{formatCurrency(r.amount)}
                          </td>
                        </tr>
                      ))
                    : payoutRows.map((r, i) => (
                        <tr key={r.clawbackId || `p-${i}`} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-700 align-top whitespace-nowrap">
                            {formatDate(r.refundDate || r.createdDate)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700 align-top">
                            {renderCustomer(
                              r.groupId,
                              r.groupName,
                              r.primaryMemberId,
                              r.householdName
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700 align-top max-w-xs">
                            <div
                              className="truncate"
                              title={r.refundReason || r.refundNotes || r.clawbackNotes || ''}
                            >
                              {r.refundReason || r.refundNotes || r.clawbackNotes || (
                                <span className="text-gray-400">—</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700 text-right align-top whitespace-nowrap">
                            {r.refundAmount != null ? formatCurrency(r.refundAmount) : '—'}
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-orange-700 text-right align-top whitespace-nowrap">
                            −{formatCurrency(r.remainingAmount)}
                            {Math.abs(Number(r.amount) - Number(r.remainingAmount)) > 0.005 && (
                              <div className="text-[11px] text-gray-500 font-normal">
                                {formatCurrency(r.remainingAmount)} remaining of {formatCurrency(r.amount)}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-200 flex items-center justify-between text-xs text-gray-500 flex-shrink-0">
          <span>
            Pending clawbacks net automatically against the next NACHA payout. Anything that
            exceeds the gross carries forward.
          </span>
          <button
            onClick={onClose}
            className="ml-4 px-4 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ClawbackDetailsModal;
