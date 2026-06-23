import React, { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { apiService } from '../../services/api.service';

const REFUND_REASONS = [
  'Customer Request',
  'Duplicate Payment',
  'Service Not Provided',
  'Cancelled Enrollment',
  'Billing Error',
  'Fraudulent Transaction',
  'Other'
];

interface ClawbackPreview {
  commission: boolean;
  vendors: string[];
  tenantOverrides: string[];
}

interface RefundInfo {
  hasCommissionPayout: boolean;
  hasVendorPayout: boolean;
  needsTransactionInfoId: boolean;
  clawbackPreview: ClawbackPreview | null;
}

interface RefundPaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  paymentId: string;
  amount: number;
  onSuccess: () => void;
}

const RefundPaymentModal: React.FC<RefundPaymentModalProps> = ({
  isOpen,
  onClose,
  paymentId,
  amount,
  onSuccess
}) => {
  const [refundReason, setRefundReason] = useState('');
  const [refundOtherReason, setRefundOtherReason] = useState('');
  const [transactionInfoId, setTransactionInfoId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refundInfo, setRefundInfo] = useState<RefundInfo | null>(null);
  const [refundInfoLoading, setRefundInfoLoading] = useState(false);
  const [generateClawbacks, setGenerateClawbacks] = useState(true);
  const [processOnPaymentProcessor, setProcessOnPaymentProcessor] = useState(true);

  useEffect(() => {
    if (isOpen && paymentId) {
      setGenerateClawbacks(true);
      setProcessOnPaymentProcessor(true);
    }
    if (!isOpen || !paymentId) {
      setRefundInfo(null);
      return;
    }
    setRefundInfoLoading(true);
    setRefundInfo(null);
    apiService
      .get<{
        success?: boolean;
        hasCommissionPayout?: boolean;
        hasVendorPayout?: boolean;
        needsTransactionInfoId?: boolean;
        clawbackPreview?: ClawbackPreview;
      }>(`/api/accounting/payments/${paymentId}/refund-info`)
      .then((res) => {
        if (res?.success) {
          const cp = res.clawbackPreview;
          setRefundInfo({
            hasCommissionPayout: !!res.hasCommissionPayout,
            hasVendorPayout: !!res.hasVendorPayout,
            needsTransactionInfoId: !!res.needsTransactionInfoId,
            clawbackPreview:
              cp && typeof cp === 'object'
                ? {
                    commission: !!cp.commission,
                    vendors: Array.isArray(cp.vendors) ? cp.vendors : [],
                    tenantOverrides: Array.isArray(cp.tenantOverrides) ? cp.tenantOverrides : []
                  }
                : null
          });
        }
      })
      .catch(() => setRefundInfo(null))
      .finally(() => setRefundInfoLoading(false));
  }, [isOpen, paymentId]);

  const handleClose = () => {
    if (!submitting) {
      setRefundReason('');
      setRefundOtherReason('');
      setTransactionInfoId('');
      setGenerateClawbacks(true);
      setProcessOnPaymentProcessor(true);
      onClose();
    }
  };

  const handleSubmit = async () => {
    if (!refundReason) {
      toast.error('Please select a refund reason');
      return;
    }
    if (refundReason === 'Other' && !refundOtherReason.trim()) {
      toast.error('Please provide a reason for "Other"');
      return;
    }
    if (processOnPaymentProcessor && refundInfo?.needsTransactionInfoId && !transactionInfoId.trim()) {
      toast.error('Enter the DIME Transaction Info ID from the DIME dashboard to continue.');
      return;
    }
    const reason = refundReason === 'Other' ? refundOtherReason.trim() : refundReason;
    setSubmitting(true);
    try {
      const body: {
        amount: number;
        reason: string;
        transactionInfoId?: string;
        skipClawbacks?: boolean;
        skipProcessorRefund?: boolean;
      } = {
        amount,
        reason
      };
      if (processOnPaymentProcessor && refundInfo?.needsTransactionInfoId && transactionInfoId.trim()) {
        body.transactionInfoId = transactionInfoId.trim();
      }
      if (!generateClawbacks) {
        body.skipClawbacks = true;
      }
      if (!processOnPaymentProcessor) {
        body.skipProcessorRefund = true;
      }
      const res = await apiService.post<{ success?: boolean; message?: string }>(
        `/api/accounting/payments/${paymentId}/refund`,
        body
      );
      if (res?.success) {
        toast.success(res.message || 'Refund processed successfully');
        handleClose();
        onSuccess();
      } else {
        toast.error((res as { message?: string })?.message || 'Refund failed');
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'Refund failed';
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const cp = refundInfo?.clawbackPreview;
  const clawbackBulletItems: string[] = [];
  if (generateClawbacks) {
    if (cp?.commission) clawbackBulletItems.push('Commission clawback will be generated.');
    if (cp && cp.vendors.length > 0) {
      clawbackBulletItems.push(`Vendor clawback will be generated for: ${cp.vendors.join(', ')}.`);
    }
    if (cp && cp.tenantOverrides.length > 0) {
      clawbackBulletItems.push(`Tenant override clawback will be generated for: ${cp.tenantOverrides.join(', ')}.`);
    }
  } else {
    clawbackBulletItems.push('Clawbacks will not be generated for this refund.');
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-md w-full">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Process Refund</h3>
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>
        <div className="p-6">
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Refund amount: <span className="font-semibold text-gray-900">${Number(amount).toFixed(2)}</span>
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Refund Reason <span className="text-red-500">*</span>
              </label>
              <select
                value={refundReason}
                onChange={(e) => {
                  setRefundReason(e.target.value);
                  if (e.target.value !== 'Other') setRefundOtherReason('');
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="">Select a reason...</option>
                {REFUND_REASONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            {refundReason === 'Other' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Please specify reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={refundOtherReason}
                  onChange={(e) => setRefundOtherReason(e.target.value)}
                  placeholder="Enter refund reason..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>
            )}

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 rounded border-gray-300"
                  checked={processOnPaymentProcessor}
                  onChange={(e) => setProcessOnPaymentProcessor(e.target.checked)}
                  disabled={submitting}
                />
                <span>
                  <span className="text-sm font-medium text-gray-900">Process refund on payment processor</span>
                  <span className="block text-xs text-gray-600 mt-0.5">
                    When checked, we refund through DIME before updating our records. Uncheck to record the refund in
                    OpenEnroll only (e.g. you already refunded in the processor dashboard or via another channel).
                  </span>
                </span>
              </label>
            </div>

            {!processOnPaymentProcessor ? (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 flex gap-3">
                <AlertTriangle className="h-5 w-5 text-orange-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-orange-900">
                  <span className="font-medium">Database only.</span> The customer will not receive money back through
                  this action. Use this when the processor was already refunded or no processor refund is needed.
                </p>
              </div>
            ) : null}

            {processOnPaymentProcessor && !refundInfoLoading && refundInfo?.needsTransactionInfoId ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  DIME Transaction Info ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={transactionInfoId}
                  onChange={(e) => setTransactionInfoId(e.target.value)}
                  placeholder="From DIME dashboard → transaction details"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <p className="mt-1 text-xs text-gray-500">
                  We couldn’t look it up automatically. In DIME, open this transaction and copy <strong>transaction_info_id</strong> here, then submit.
                </p>
              </div>
            ) : null}

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-medium mb-1">Before you continue</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Canceling coverage or recurring billing is a separate step if you need it.</li>
                </ul>
                {!refundInfoLoading ? (
                  <div className="mt-3 pt-3 border-t border-amber-200">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-1 rounded border-gray-300"
                        checked={generateClawbacks}
                        onChange={(e) => setGenerateClawbacks(e.target.checked)}
                        disabled={submitting}
                      />
                      <span>
                        <span className="font-medium">Generate commission and payout clawbacks</span>
                        <span className="block text-xs font-normal text-amber-900/80 mt-0.5">
                          Uncheck only with finance approval. Already-sent payouts are not reversed automatically.
                        </span>
                      </span>
                    </label>
                  </div>
                ) : null}
                {!refundInfoLoading && clawbackBulletItems.length > 0 ? (
                  <ul className="list-disc list-inside space-y-1 mt-3">
                    {clawbackBulletItems.map((line, idx) => (
                      <li key={idx}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>

            {refundInfoLoading ? (
              <p className="text-sm text-gray-500">Checking payout status…</p>
            ) : refundInfo && (refundInfo.hasCommissionPayout || refundInfo.hasVendorPayout) ? (
              <div className="bg-red-50 border-2 border-red-300 rounded-lg p-4 flex gap-3">
                <AlertTriangle className="h-6 w-6 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-red-900">
                  <p className="font-semibold mb-1">Money may have already gone out</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {refundInfo.hasCommissionPayout && <li>Commission was already paid.</li>}
                    {refundInfo.hasVendorPayout && <li>A vendor payout was already sent.</li>}
                  </ul>
                  <p className="mt-2">
                    {generateClawbacks
                      ? 'A refund can still create clawback rows. That does not pull cash back from the bank by itself — check with finance.'
                      : 'Clawback generation is off for this refund — finance should reconcile payout and commission ledgers manually.'}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800">
                {processOnPaymentProcessor
                  ? 'Payment and invoice balances update when the refund completes.'
                  : 'Payment and invoice balances will update in OpenEnroll only; no processor refund is sent.'}
              </p>
            </div>
          </div>
        </div>
        <div className="p-6 border-t border-gray-200 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {submitting
              ? 'Processing...'
              : processOnPaymentProcessor
                ? 'Process Refund'
                : 'Record Refund in Database'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RefundPaymentModal;
