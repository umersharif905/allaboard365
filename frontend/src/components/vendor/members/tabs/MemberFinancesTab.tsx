import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, DollarSign, Receipt, Wallet } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import type {
  MemberFinanceSummary,
  MemberFinanceSummaryResponse,
} from '../../../../types/shareRequest.types';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';
import UaCoverageBanner from '../../shared/UaCoverageBanner';

interface MemberFinancesTabProps {
  memberId: string;
}

const fmtCurrency = (n?: number) =>
  typeof n === 'number'
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
    : '$0.00';

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const MemberFinancesTab = ({ memberId }: MemberFinancesTabProps) => {
  const [summary, setSummary] = useState<MemberFinanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const response = await apiService.get<MemberFinanceSummaryResponse>(
          `/api/me/vendor/members/${memberId}/finance-summary`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (response.success) setSummary(response.data);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load finances');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [memberId]);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6">
        <div className="flex items-center gap-2 text-red-600 text-sm">
          <CircleAlert className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!summary || summary.shareRequestCount === 0) {
    return (
      <div className="p-4 sm:p-6">
        <EmptyState
          icon={DollarSign}
          title="No finances yet"
          description="This member has no share requests with bills or ledger activity."
          tone="subtle"
        />
      </div>
    );
  }

  const t = summary.totals;
  const ua = summary.uaAnalysis;

  const cards = [
    { label: 'Billed', value: t.billed, accent: false },
    { label: 'Saved', value: t.saved, accent: false },
    { label: 'Member paid', value: t.memberPaid, accent: false },
    { label: 'Reimbursed', value: t.reimbursed, accent: false },
    { label: 'Balance', value: t.balance, accent: true },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="bg-white border border-gray-200 rounded-lg px-3 py-2">
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-sm font-semibold ${c.accent ? 'text-oe-primary' : 'text-gray-900'}`}>
              {fmtCurrency(c.value)}
            </p>
          </div>
        ))}
      </div>

      {/* Unshared-amount coverage signal (trailing 12 months) */}
      <UaCoverageBanner ua={ua} />

      {/* Two short columns: Bills + Ledger summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 mb-3">
            <Receipt className="h-4 w-4 text-gray-400" /> Bills
          </h3>
          <dl className="space-y-2 text-sm">
            <Row label="Total billed" value={fmtCurrency(t.billed)} />
            <Row label="Estimates" value={fmtCurrency(t.estimates)} />
            <Row label="Paid to provider" value={fmtCurrency(t.paidToProvider)} />
            <Row label="Bill balance" value={fmtCurrency(t.billBalance)} strong />
          </dl>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 mb-3">
            <Wallet className="h-4 w-4 text-gray-400" /> Ledger
          </h3>
          <dl className="space-y-2 text-sm">
            <Row label="Discounts" value={fmtCurrency(t.discount)} />
            <Row label="Financial aid" value={fmtCurrency(t.financialAid)} />
            <Row label="Member paid (out-of-pocket)" value={fmtCurrency(t.memberPaid)} />
            <Row label="Reimbursed" value={fmtCurrency(t.reimbursed)} strong />
          </dl>
        </div>
      </div>

      {/* Per-share-request breakdown */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <h3 className="text-sm font-semibold text-gray-900 px-4 py-3 border-b border-gray-200">
          Share requests ({summary.shareRequestCount})
        </h3>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <Th>Request #</Th>
                <Th>Status</Th>
                <Th>Service date</Th>
                <Th align="right">Billed</Th>
                <Th align="right">Member paid</Th>
                <Th align="right">UA target</Th>
                <Th align="right">Balance</Th>
                <Th>UA met</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {summary.shareRequests.map((sr) => (
                <tr key={sr.shareRequestId}>
                  <Td className="font-mono text-[12px]">{sr.requestNumber}</Td>
                  <Td>{sr.status}</Td>
                  <Td>{fmtDate(sr.serviceDate || sr.submittedDate)}</Td>
                  <Td align="right">{fmtCurrency(sr.billed)}</Td>
                  <Td align="right">{fmtCurrency(sr.memberPaid)}</Td>
                  <Td align="right">{fmtCurrency(sr.incidentUA)}</Td>
                  <Td align="right" className="font-medium">{fmtCurrency(sr.balance)}</Td>
                  <Td>
                    {sr.uaPaidInFull ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-100 text-green-800">
                        Paid in full
                      </span>
                    ) : (
                      <span className="text-gray-400 text-[12px]">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const Row = ({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) => (
  <div className="flex items-center justify-between">
    <dt className="text-gray-500">{label}</dt>
    <dd className={strong ? 'font-semibold text-gray-900' : 'text-gray-900'}>{value}</dd>
  </div>
);

const Th = ({ children, align = 'left' }: { children?: ReactNode; align?: 'left' | 'right' }) => (
  <th className={`px-4 py-2 text-${align} text-[11px] font-medium text-gray-500 uppercase tracking-wider`}>
    {children}
  </th>
);

const Td = ({
  children,
  className = '',
  align = 'left',
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) => (
  <td className={`px-4 py-2 text-gray-700 text-${align} ${className}`}>{children}</td>
);

export default MemberFinancesTab;
