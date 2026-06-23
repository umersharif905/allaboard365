import { AlertCircle, CreditCard, X } from 'lucide-react';
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { getManualChargeToastMessage } from '../../constants/paymentMessages';
import type { OutstandingInvoicePrompt } from '../../services/member-payment-methods.service';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatPeriod(start?: string | null, end?: string | null): string {
  const fmt = (iso?: string | null) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('T')[0].split('-');
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

interface Props {
  open: boolean;
  invoice: OutstandingInvoicePrompt;
  onClose: () => void;
  onPayNow: (invoiceId: string) => Promise<{ success: boolean; message?: string; data?: { amount?: number; paymentRecordStatus?: string } }>;
  onSuccess?: () => void;
}

const OutstandingInvoicePayPromptModal: React.FC<Props> = ({
  open,
  invoice,
  onClose,
  onPayNow,
  onSuccess,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handlePayNow = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await onPayNow(invoice.invoiceId);
      if (res.success && res.data) {
        const amt = Number(res.data.amount) || invoice.balanceDue;
        const { message } = getManualChargeToastMessage({
          paymentRecordStatus: res.data.paymentRecordStatus,
          settledMessage: `Payment of ${formatCurrency(amt)} was successful.`,
        });
        toast.success(message);
        onSuccess?.();
        onClose();
      } else {
        const msg = res.message || 'Payment failed.';
        setError(msg);
        toast.error(msg);
      }
    } catch (e) {
      const err = e as { response?: { data?: { message?: string } }; message?: string };
      const msg = err?.response?.data?.message || err?.message || 'Payment failed.';
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 relative">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex items-start gap-3 mb-4">
          <CreditCard className="h-6 w-6 text-oe-primary shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Pay outstanding invoice now?</h3>
            <p className="text-sm text-gray-600 mt-1">
              Your payment method was saved and future recurring charges will use it starting on your next billing date.
              Would you like to pay your current outstanding invoice with this payment method now?
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 mb-4 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-gray-600">Invoice</span>
            <span className="font-medium text-gray-900">{invoice.invoiceNumber || invoice.invoiceId.slice(0, 8)}</span>
          </div>
          <div className="flex justify-between gap-2 mt-2">
            <span className="text-gray-600">Billing period</span>
            <span className="font-medium text-gray-900">
              {formatPeriod(invoice.billingPeriodStart, invoice.billingPeriodEnd)}
            </span>
          </div>
          <div className="flex justify-between gap-2 mt-2">
            <span className="text-gray-600">Amount due</span>
            <span className="font-semibold text-gray-900">{formatCurrency(invoice.balanceDue)}</span>
          </div>
        </div>
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={handlePayNow}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-oe-primary hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Processing…' : 'Pay now'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OutstandingInvoicePayPromptModal;
