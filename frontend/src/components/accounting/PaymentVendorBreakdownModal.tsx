// frontend/src/components/accounting/PaymentVendorBreakdownModal.tsx
import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import {
  getVendorPaymentBreakdown,
  VendorPaymentBreakdownData
} from '../../services/accounting/vendorBreakdown.service';

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);

const formatDate = (d: string | null | undefined) => {
  if (!d) return '—';
  try {
    const [datePart] = String(d).split('T');
    const [y, m, day] = datePart.split('-').map(Number);
    const dt = new Date(y, m - 1, day);
    return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
};

interface PaymentVendorBreakdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  paymentId: string;
  vendorId?: string;
  /** Pre-known header values shown while loading. */
  paymentDate?: string;
  paymentAmount?: number;
  sourceName?: string;
  vendorName?: string;
}

const PaymentVendorBreakdownModal: React.FC<PaymentVendorBreakdownModalProps> = ({
  isOpen,
  onClose,
  paymentId,
  vendorId,
  paymentDate: initialPaymentDate,
  paymentAmount: initialPaymentAmount,
  sourceName: initialSourceName,
  vendorName: initialVendorName
}) => {
  const [data, setData] = useState<VendorPaymentBreakdownData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !paymentId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    getVendorPaymentBreakdown(paymentId, vendorId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) setData(res.data);
        else setError('Failed to load vendor breakdown');
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load vendor breakdown');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, paymentId, vendorId]);

  if (!isOpen) return null;

  const displayPaymentDate = data?.paymentDate ?? initialPaymentDate;
  const displayPaymentAmount = data?.paymentAmount ?? initialPaymentAmount;
  const displaySourceName = data?.sourceName ?? initialSourceName;
  const displayVendorName = data?.vendorName ?? initialVendorName;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative bg-white rounded-lg shadow-xl border border-gray-200 max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900">
              Vendor payout breakdown
            </h2>
            <div className="mt-1 text-sm text-gray-600 space-y-0.5">
              <p>
                Payment {formatDate(displayPaymentDate)}
                {displayPaymentAmount != null && ` · ${formatCurrency(displayPaymentAmount)}`}
                {displaySourceName && ` · ${displaySourceName}`}
              </p>
              {displayVendorName && (
                <p>Vendor: {displayVendorName}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 min-h-0">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-oe-primary" />
              <span className="ml-2 text-gray-600">Loading breakdown...</span>
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <p className="text-xs text-gray-500 uppercase tracking-wider">Vendor Total</p>
                  <p className="text-lg font-semibold text-gray-900 mt-1">
                    {formatCurrency(data.vendorTotal)}
                  </p>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <p className="text-xs text-gray-500 uppercase tracking-wider">Already Paid</p>
                  <p className="text-lg font-semibold text-green-700 mt-1">
                    {formatCurrency(data.alreadyPaid)}
                  </p>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <p className="text-xs text-gray-500 uppercase tracking-wider">Remaining</p>
                  <p className={`text-lg font-semibold mt-1 ${data.remaining > 0 ? 'text-yellow-700' : 'text-gray-900'}`}>
                    {formatCurrency(data.remaining)}
                  </p>
                </div>
              </div>

              {data.products.length === 0 ? (
                <p className="text-gray-600 text-sm">No vendor payouts for this payment.</p>
              ) : (
                <div className="space-y-6">
                  {data.products.map((product) => (
                    <div key={product.productId} className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="font-medium text-gray-900">{product.productName}</h3>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {product.vendorName || 'No vendor on file'}
                            {product.enrolledCount > 0 && ` · ${product.enrolledCount} enrollment${product.enrolledCount === 1 ? '' : 's'}`}
                          </p>
                        </div>
                        <span className="text-sm text-green-700 font-medium whitespace-nowrap">
                          Vendor: {formatCurrency(product.vendorAmount)}
                        </span>
                      </div>

                      {product.enrollments.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Member
                                </th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Tier
                                </th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Net Rate
                                </th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {product.enrollments.map((row) => (
                                <tr key={row.enrollmentId}>
                                  <td className="px-4 py-2 text-sm text-gray-900">{row.memberName}</td>
                                  <td className="px-4 py-2 text-sm text-gray-600">{row.pricingTier || '—'}</td>
                                  <td className="px-4 py-2 text-sm text-right font-medium text-green-700">
                                    {formatCurrency(row.netRate)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default PaymentVendorBreakdownModal;
