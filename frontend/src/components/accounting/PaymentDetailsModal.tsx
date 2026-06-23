// frontend/src/components/accounting/PaymentDetailsModal.tsx
import { FileText, Loader2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTierLevelLabel } from '../../constants/form-options';
import { useAuth } from '../../contexts/AuthContext';
import { PaymentDetail, nachaService } from '../../services/nachaService';
import PaymentCommissionBreakdownModal from './PaymentCommissionBreakdownModal';

interface PaymentDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  nachaId: string;
  recipientName: string;
  recipientType: string;
  entityId: string;
  entityType: string;
}

const PaymentDetailsModal: React.FC<PaymentDetailsModalProps> = ({
  isOpen,
  onClose,
  nachaId,
  recipientName,
  recipientType,
  entityId,
  entityType
}) => {
  const [paymentDetails, setPaymentDetails] = useState<PaymentDetail[]>([]);
  const [allPaymentDetails, setAllPaymentDetails] = useState<PaymentDetail[]>([]);
  const [groupedBy, setGroupedBy] = useState<'invoice' | 'payment'>('invoice');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEnrollmentsModal, setShowEnrollmentsModal] = useState(false);
  const [selectedPaymentEnrollments, setSelectedPaymentEnrollments] = useState<Array<{
    enrollmentId: string;
    productName: string;
    memberName: string;
    netRate: number;
    overrideRate: number;
    commission: number;
    systemFees: number;
    effectiveDate: string;
    terminationDate: string | null;
    status: string;
  }>>([]);
  const [loadingEnrollments, setLoadingEnrollments] = useState(false);
  const [groupNavigateConfirm, setGroupNavigateConfirm] = useState<{ groupId: string; groupName: string } | null>(null);
  const [selectedPaymentForBreakdown, setSelectedPaymentForBreakdown] = useState<{
    paymentId: string;
    paymentDate: string;
    paymentAmount: number;
    agentName?: string;
    clientName?: string;
  } | null>(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0
  });

  useEffect(() => {
    if (isOpen) {
      fetchPaymentDetails();
    }
  }, [isOpen, pagination.page, nachaId, entityId, entityType]);

  const fetchPaymentDetails = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await nachaService.getRecipientPaymentDetails(
        nachaId,
        entityType,
        entityId
      );
      
      // Store all details for totals calculation
      const allDetails = response.paymentDetails;
      setGroupedBy(response.groupedBy || 'invoice');
      setAllPaymentDetails(allDetails);
      
      // Calculate pagination from full results
      const total = allDetails.length;
      const offset = (pagination.page - 1) * pagination.limit;
      const paginatedDetails = allDetails.slice(offset, offset + pagination.limit);
      
      setPaymentDetails(paginatedDetails);
      setPagination(prev => ({
        ...prev,
        total,
        totalPages: Math.ceil(total / prev.limit)
      }));
    } catch (err: any) {
      console.error('Failed to load payment details:', err);
      setError(err.message || 'Failed to load payment details');
    } finally {
      setLoading(false);
    }
  };

  const handleMemberNameClick = async (paymentId: string) => {
    setLoadingEnrollments(true);
    setShowEnrollmentsModal(true);
    try {
      const response = await nachaService.getPaymentEnrollments(paymentId);
      setSelectedPaymentEnrollments(response.enrollments || []);
    } catch (err: any) {
      console.error('Failed to load enrollments:', err);
      setSelectedPaymentEnrollments([]);
    } finally {
      setLoadingEnrollments(false);
    }
  };

  const handleMemberOrGroupClick = (item: { groupId?: string | null; groupName?: string | null; memberName: string; paymentId: string }) => {
    if (item.groupId && item.groupName) {
      setGroupNavigateConfirm({ groupId: item.groupId, groupName: item.groupName });
      return;
    }
    handleMemberNameClick(item.paymentId);
  };

  const handleConfirmNavigateToGroup = () => {
    if (!groupNavigateConfirm) return;
    const { groupId } = groupNavigateConfirm;
    const role = user?.currentRole || 'TenantAdmin';
    onClose();
    setGroupNavigateConfirm(null);
    if (role === 'Agent') navigate(`/agent/groups/${groupId}`);
    else if (role === 'TenantAdmin') navigate(`/tenant-admin/groups/${groupId}`);
    else navigate(`/admin/groups/${groupId}`);
  };

  const openCommissionBreakdown = (payment: {
    paymentId: string;
    paymentDate: string;
    paymentAmount: number;
    agentName?: string;
    clientName?: string;
  }) => {
    setSelectedPaymentForBreakdown(payment);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  // Format dates - calendar dates parse date parts to avoid timezone conversion issues
  const formatDate = (dateString: string, isTimestamp: boolean = false) => {
    if (!dateString) return '';
    
    try {
      if (isTimestamp) {
        // Timestamps - use timezone conversion
        return new Date(dateString).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
      } else {
        // Calendar dates (paymentDate) - parse date parts separately to avoid timezone issues
        // Server returns UTC dates like "2025-11-05T00:00:00Z"
        const [datePart] = dateString.split('T');
        const [year, month, day] = datePart.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        return date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
      }
    } catch (error) {
      console.error('Error formatting date:', error);
      return dateString;
    }
  };

  const recipientTierLevel = allPaymentDetails.find((detail) => detail.tierLevel !== null && detail.tierLevel !== undefined)?.tierLevel;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-semibold text-gray-900">
                Invoices: {recipientName}
              </h2>
              {recipientType === 'Agent' && recipientTierLevel !== null && recipientTierLevel !== undefined && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
                  {getTierLevelLabel(recipientTierLevel)}
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500 mt-1">
              {recipientType} • {pagination.total} invoice{pagination.total !== 1 ? 's' : ''} total
            </p>
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
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-oe-primary" />
              <span className="ml-3 text-gray-600">
                Loading invoices…
              </span>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-red-600">{error}</p>
              <button
                onClick={fetchPaymentDetails}
                className="mt-4 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
              >
                Retry
              </button>
            </div>
          ) : paymentDetails.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">
                No invoices found for this recipient on this NACHA
              </p>
            </div>
          ) : (
            <>
              {/* Total Amount Summary */}
              <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Total Invoice Amount</p>
                    <p className="text-2xl font-bold text-gray-900">
                      {formatCurrency(
                        allPaymentDetails.reduce((sum, detail) => sum + (detail.paymentAmount || 0), 0)
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-gray-600">
                      {entityType === 'Vendor' ? 'Total Vendor Payout' : entityType === 'Tenant' ? 'Total Product Owner Override' : 'Total Commission'}
                    </p>
                    <p className="text-2xl font-bold text-oe-primary">
                      {formatCurrency(
                        allPaymentDetails.reduce((sum, detail) => sum + (detail.amount || 0), 0)
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Invoice
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Paid Date
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Member/Group
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        Invoice Total
                      </th>
                      {entityType === 'Vendor' ? (
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                          Allocated Vendor Rate
                        </th>
                      ) : entityType === 'Agent' || entityType === 'Agency' ? (
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                          Commission (invoice)
                        </th>
                      ) : null}
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        {entityType === 'Vendor' ? 'Vendor Payout' : entityType === 'Tenant' ? 'Product Owner Override' : 'Received Commission'}
                      </th>
                      {(entityType === 'Agent' || entityType === 'Agency') && (
                        <>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Paid As
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                            Selling Agent
                          </th>
                        </>
                      )}
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {paymentDetails.map((detail, idx) => {
                      const rowKey =
                        detail.invoiceId || detail.paymentId || detail.nachaPaymentDetailId || String(idx);
                      const paidDate = detail.invoicePaidDate || detail.paymentDate;
                      const paidAs =
                        detail.tierLevel === 0
                          ? 'Seller'
                          : detail.tierLevel != null
                            ? 'Upline'
                            : '—';
                      const commissionOnInvoice =
                        detail.commissionAmount != null ? detail.commissionAmount : detail.amount;

                      return (
                        <tr key={rowKey} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">
                            <div>{detail.invoiceNumber || '—'}</div>
                            {detail.invoiceStatus ? (
                              <div className="text-xs text-gray-500 mt-0.5">{detail.invoiceStatus}</div>
                            ) : null}
                            {(detail.lineCount ?? 0) > 1 ? (
                              <div className="text-xs text-gray-400 mt-0.5">
                                {detail.lineCount} commission lines
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {formatDate(paidDate, false)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {detail.groupId && detail.groupName ? (
                              <button
                                onClick={() => handleMemberOrGroupClick(detail)}
                                className="text-oe-primary hover:text-oe-primary-dark hover:underline cursor-pointer"
                              >
                                {detail.groupName}
                              </button>
                            ) : detail.paymentId ? (
                              <button
                                onClick={() => handleMemberOrGroupClick(detail)}
                                className="text-oe-primary hover:text-oe-primary-dark hover:underline cursor-pointer"
                              >
                                {detail.memberName}
                              </button>
                            ) : (
                              <span>{detail.groupName || detail.memberName}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900 text-right">
                            {formatCurrency(detail.paymentAmount)}
                          </td>
                          {entityType === 'Vendor' ? (
                            <td className="px-4 py-3 text-sm text-gray-400 text-right">—</td>
                          ) : entityType === 'Agent' || entityType === 'Agency' ? (
                            <td className="px-4 py-3 text-sm text-gray-600 text-right">
                              {formatCurrency(commissionOnInvoice)}
                            </td>
                          ) : null}
                          <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                            {formatCurrency(detail.amount)}
                          </td>
                          {entityType === 'Agent' || entityType === 'Agency' ? (
                            <>
                              <td className="px-4 py-3 text-sm text-gray-500">{paidAs}</td>
                              <td className="px-4 py-3 text-sm text-gray-500">
                                {detail.tierLevel === 0 ? (
                                  <span className="text-gray-400 italic">Self</span>
                                ) : detail.sellingAgentName ? (
                                  <span className="text-gray-700">{detail.sellingAgentName}</span>
                                ) : (
                                  '—'
                                )}
                              </td>
                            </>
                          ) : null}
                          <td className="px-4 py-3 text-right">
                            {detail.paymentId ? (
                              <button
                                type="button"
                                onClick={() =>
                                  openCommissionBreakdown({
                                    paymentId: detail.paymentId!,
                                    paymentDate: detail.paymentDate,
                                    paymentAmount: detail.paymentAmount,
                                    agentName: detail.sellingAgentName || recipientName,
                                    clientName: detail.groupName || detail.memberName
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                                title="View commission breakdown for this invoice"
                              >
                                <FileText className="h-3.5 w-3.5" />
                                Breakdown
                              </button>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {pagination.totalPages > 1 && (
                <div className="flex items-center justify-between mt-6">
                  <div className="text-sm text-gray-600">
                    Showing {((pagination.page - 1) * pagination.limit) + 1} to{' '}
                    {Math.min(pagination.page * pagination.limit, pagination.total)} of{' '}
                    {pagination.total} invoices
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        setPagination({ ...pagination, page: pagination.page - 1 })
                      }
                      disabled={pagination.page === 1}
                      className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <span className="px-4 py-2 text-sm text-gray-700">
                      Page {pagination.page} of {pagination.totalPages}
                    </span>
                    <button
                      onClick={() =>
                        setPagination({ ...pagination, page: pagination.page + 1 })
                      }
                      disabled={pagination.page >= pagination.totalPages}
                      className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Navigate to Group confirmation */}
      {groupNavigateConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Navigate to group</h3>
            <p className="text-gray-600 mb-6">
              Are you sure you want to navigate to this group? You will leave this screen.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setGroupNavigateConfirm(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmNavigateToGroup}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
              >
                Go to group
              </button>
            </div>
          </div>
        </div>
      )}
      
      {selectedPaymentForBreakdown && (
        <PaymentCommissionBreakdownModal
          isOpen={!!selectedPaymentForBreakdown}
          onClose={() => setSelectedPaymentForBreakdown(null)}
          paymentId={selectedPaymentForBreakdown.paymentId}
          paymentDate={selectedPaymentForBreakdown.paymentDate}
          amount={selectedPaymentForBreakdown.paymentAmount}
          agentName={selectedPaymentForBreakdown.agentName}
          clientName={selectedPaymentForBreakdown.clientName}
          breakdownSource="accounting"
        />
      )}
      
      {/* Enrollments Modal */}
      {showEnrollmentsModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-60">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Payment Enrollments
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  {selectedPaymentEnrollments.length} enrollment{selectedPaymentEnrollments.length !== 1 ? 's' : ''} for this payment
                </p>
              </div>
              <button
                onClick={() => {
                  setShowEnrollmentsModal(false);
                  setSelectedPaymentEnrollments([]);
                }}
                className="text-gray-400 hover:text-gray-500 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6">
              {loadingEnrollments ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-oe-primary" />
                  <span className="ml-3 text-gray-600">Loading enrollments...</span>
                </div>
              ) : selectedPaymentEnrollments.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-gray-500">No enrollments found for this payment</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Member</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Net Rate</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Override</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Commission</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">System Fees</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Effective Date</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {selectedPaymentEnrollments.map((enrollment, idx) => (
                        <tr key={idx} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {enrollment.productName}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {enrollment.memberName}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900 text-right">
                            {formatCurrency(enrollment.netRate)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900 text-right">
                            {formatCurrency(enrollment.overrideRate)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900 text-right">
                            {formatCurrency(enrollment.commission)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900 text-right">
                            {formatCurrency(enrollment.systemFees)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {formatDate(enrollment.effectiveDate, false)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PaymentDetailsModal;


