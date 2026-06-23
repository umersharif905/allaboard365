// frontend/src/components/accounting/PaymentBreakdownModal.tsx
import { X, Loader2, DollarSign, Users, Building2, Store, Briefcase } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { nachaService } from '../../services/nachaService';
import { formatCurrency } from '../../utils/helpers';

interface PaymentBreakdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  paymentId: string;
}

interface Recipient {
  entityType: string;
  entityId: string;
  entityName: string;
  amount: number;
  tierLevel: number | null;
  ruleId: string | null;
  ruleName: string | null;
  commissionType: string | null;
  isRuleBased: boolean;
  isOverflow: boolean;
}

const PaymentBreakdownModal: React.FC<PaymentBreakdownModalProps> = ({
  isOpen,
  onClose,
  paymentId
}) => {
  const [payment, setPayment] = useState<any>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && paymentId) {
      fetchPaymentBreakdown();
    }
  }, [isOpen, paymentId]);

  const fetchPaymentBreakdown = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await nachaService.getPaymentBreakdown(paymentId);
      if (response.success) {
        setPayment(response.payment);
        setRecipients(response.recipients);
        setSummary(response.summary);
      } else {
        throw new Error('Failed to fetch payment breakdown');
      }
    } catch (err: any) {
      console.error('Error fetching payment breakdown:', err);
      setError(err.message || 'Failed to load payment breakdown');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const getEntityIcon = (entityType: string) => {
    switch (entityType) {
      case 'Agent':
        return <Users className="h-4 w-4" />;
      case 'Agency':
        return <Building2 className="h-4 w-4" />;
      case 'Vendor':
        return <Store className="h-4 w-4" />;
      case 'Tenant':
        return <Briefcase className="h-4 w-4" />;
      default:
        return <DollarSign className="h-4 w-4" />;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-semibold text-gray-900">
            Payment Breakdown
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              <span className="ml-3 text-gray-600">Loading payment breakdown...</span>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-md p-4">
              <p className="text-red-700">{error}</p>
            </div>
          ) : payment && recipients.length > 0 ? (
            <>
              {/* Payment Summary */}
              <div className="mb-6 grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600">Payment Amount</div>
                  <div className="text-xl font-bold text-gray-900">
                    {formatCurrency(payment.amount)}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600">Commission Pool</div>
                  <div className="text-xl font-bold text-gray-900">
                    {formatCurrency(payment.commissionPool)}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600">Net Rate</div>
                  <div className="text-xl font-bold text-gray-900">
                    {formatCurrency(payment.netRate)}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600">Override Rate</div>
                  <div className="text-xl font-bold text-gray-900">
                    {formatCurrency(payment.overrideRate)}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600">Payment Date</div>
                  <div className="text-sm font-medium text-gray-900">
                    {formatDate(payment.paymentDate)}
                  </div>
                </div>
              </div>

              {/* Summary Stats */}
              {summary && (
                <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                    <div className="text-sm text-oe-primary">Total Recipients</div>
                    <div className="text-2xl font-bold text-blue-900">
                      {summary.totalRecipients}
                    </div>
                  </div>
                  <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                    <div className="text-sm text-green-600">Rule-Based Amount</div>
                    <div className="text-2xl font-bold text-green-900">
                      {formatCurrency(summary.ruleBasedAmount)}
                    </div>
                  </div>
                  <div className="bg-yellow-50 p-4 rounded-lg border border-yellow-200">
                    <div className="text-sm text-yellow-600">Overflow Amount</div>
                    <div className="text-2xl font-bold text-yellow-900">
                      {formatCurrency(summary.overflowAmount)}
                    </div>
                  </div>
                  <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                    <div className="text-sm text-gray-600">Total Payout</div>
                    <div className="text-2xl font-bold text-gray-900">
                      {formatCurrency(summary.totalAmount)}
                    </div>
                  </div>
                </div>
              )}

              {/* Recipients Table */}
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Recipient</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tier</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rule</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {recipients.map((recipient, index) => (
                      <tr key={index} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          <div className="flex items-center gap-2">
                            {getEntityIcon(recipient.entityType)}
                            {recipient.entityName}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {recipient.entityType}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {recipient.tierLevel !== null ? `Tier ${recipient.tierLevel}` : '-'}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {recipient.isOverflow ? (
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                              Overflow
                            </span>
                          ) : recipient.isRuleBased ? (
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              Rule-Based
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              Commission
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {recipient.ruleName || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                          {formatCurrency(recipient.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50">
                    <tr>
                      <td colSpan={5} className="px-4 py-3 text-sm font-semibold text-gray-900 text-right">
                        Total:
                      </td>
                      <td className="px-4 py-3 text-sm font-bold text-gray-900 text-right">
                        {formatCurrency(recipients.reduce((sum, r) => sum + r.amount, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          ) : (
            <p className="text-gray-500">No breakdown data available</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default PaymentBreakdownModal;

