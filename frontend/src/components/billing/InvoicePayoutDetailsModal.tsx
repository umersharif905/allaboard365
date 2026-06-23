import React, { useEffect, useRef, useState } from 'react';
import { Building, Coins, Loader2, Percent, X } from 'lucide-react';
import {
  invoicesService,
  type InvoicePayoutDetails,
  type InvoicePayoutLineItem
} from '../../services/invoices.service';

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);

const formatDate = (d: string | null | undefined) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return '—';
  }
};

export type InvoicePayoutSection = 'commissions' | 'vendors' | 'overrides';

interface InvoicePayoutDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  invoiceId: string;
  invoiceNumber?: string;
  /** Scroll to this section on open. */
  initialSection?: InvoicePayoutSection;
}

const SECTION_META: Record<
  InvoicePayoutSection,
  { title: string; empty: string; Icon: typeof Coins }
> = {
  commissions: {
    title: 'Commissions',
    empty: 'No commission payouts recorded for this invoice.',
    Icon: Coins
  },
  vendors: {
    title: 'Vendor payouts',
    empty: 'No vendor NACHA payouts sent for this invoice.',
    Icon: Building
  },
  overrides: {
    title: 'Override payouts',
    empty: 'No product override NACHA payouts sent for this invoice.',
    Icon: Percent
  }
};

function PayoutSectionTable({
  section,
  items,
  sectionRef
}: {
  section: InvoicePayoutSection;
  items: InvoicePayoutLineItem[];
  sectionRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const { title, empty, Icon } = SECTION_META[section];
  const total = items.reduce((sum, row) => sum + (row.amount || 0), 0);

  return (
    <div ref={sectionRef} className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 text-oe-primary flex-shrink-0" aria-hidden />
          <h3 className="font-medium text-gray-900">{title}</h3>
          <span className="text-xs text-gray-500">({items.length})</span>
        </div>
        {items.length > 0 && (
          <span className="text-sm font-semibold text-gray-900 whitespace-nowrap">
            {formatCurrency(total)}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-4 text-sm text-gray-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Recipient
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Paid on
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {items.map((row, idx) => (
                <tr key={`${section}-${idx}-${row.recipientName}-${row.amount}`}>
                  <td className="px-4 py-2 text-sm text-gray-900">
                    {row.recipientName}
                    {section === 'commissions' && row.transactionType && (
                      <span className="ml-1.5 text-xs text-gray-500">({row.transactionType})</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-sm text-right font-medium text-gray-900">
                    {formatCurrency(row.amount)}
                  </td>
                  <td className="px-4 py-2 text-sm text-right text-gray-600 whitespace-nowrap">
                    {formatDate(row.payoutDate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const InvoicePayoutDetailsModal: React.FC<InvoicePayoutDetailsModalProps> = ({
  isOpen,
  onClose,
  invoiceId,
  invoiceNumber,
  initialSection
}) => {
  const [data, setData] = useState<InvoicePayoutDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commissionsRef = useRef<HTMLDivElement>(null);
  const vendorsRef = useRef<HTMLDivElement>(null);
  const overridesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !invoiceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    invoicesService
      .getInvoicePayoutDetails(invoiceId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) setData(res.data);
        else setError(res.message || 'Failed to load payout details');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load payout details');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, invoiceId]);

  useEffect(() => {
    if (!isOpen || loading || !data || !initialSection) return;
    const refMap = {
      commissions: commissionsRef,
      vendors: vendorsRef,
      overrides: overridesRef
    };
    const target = refMap[initialSection]?.current;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isOpen, loading, data, initialSection]);

  if (!isOpen) return null;

  const displayNumber = data?.invoiceNumber || invoiceNumber;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative bg-white rounded-lg shadow-xl border border-gray-200 max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900">Invoice payout breakdown</h2>
            {displayNumber && (
              <p className="mt-1 text-sm text-gray-600">{displayNumber}</p>
            )}
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
              <span className="ml-2 text-gray-600">Loading payout details...</span>
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <div className="space-y-4">
              <PayoutSectionTable
                section="commissions"
                items={data.commissions}
                sectionRef={commissionsRef}
              />
              <PayoutSectionTable
                section="vendors"
                items={data.vendors}
                sectionRef={vendorsRef}
              />
              <PayoutSectionTable
                section="overrides"
                items={data.overrides}
                sectionRef={overridesRef}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default InvoicePayoutDetailsModal;
