import React, { useCallback, useEffect, useState } from 'react';
import { Banknote, CalendarDays, ChevronLeft, ChevronRight, FileText, Info, Loader2, TrendingUp } from 'lucide-react';
import {
  getAgentCommissionPayouts,
  getAgentPayoutPayments,
  type AgentPayoutPaymentRow,
  type AgentPayoutRow,
} from '../../services/tenant-admin/agentCommissionPayouts.service';
import PaymentCommissionBreakdownModal from '../accounting/PaymentCommissionBreakdownModal';
import { formatPayoutCommissionTierDisplay } from '../../constants/form-options';

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const formatDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

interface AgentCommissionPayoutsViewProps {
  agentId: string;
  agentName?: string;
}

const AgentCommissionPayoutsView: React.FC<AgentCommissionPayoutsViewProps> = ({ agentId, agentName }) => {
  // Payout list state
  const [payouts, setPayouts] = useState<AgentPayoutRow[]>([]);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [payoutsError, setPayoutsError] = useState<string | null>(null);
  const [payoutsPage, setPayoutsPage] = useState(1);
  const [payoutsPagination, setPayoutsPagination] = useState<{ total: number; page: number; limit: number; totalPages: number } | null>(null);

  // Selected payout drill-down state
  const [selectedPayout, setSelectedPayout] = useState<AgentPayoutRow | null>(null);
  const [payoutPayments, setPayoutPayments] = useState<AgentPayoutPaymentRow[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);

  // Commission breakdown modal state
  const [breakdownPaymentId, setBreakdownPaymentId] = useState<string | null>(null);
  const [breakdownRow, setBreakdownRow] = useState<AgentPayoutPaymentRow | null>(null);

  const loadPayouts = useCallback(async () => {
    setPayoutsLoading(true);
    setPayoutsError(null);
    try {
      const result = await getAgentCommissionPayouts(agentId, { page: payoutsPage });
      setPayouts(result.data);
      setPayoutsPagination(result.pagination);
    } catch {
      setPayoutsError('Failed to load payouts');
    } finally {
      setPayoutsLoading(false);
    }
  }, [agentId, payoutsPage]);

  useEffect(() => {
    void loadPayouts();
  }, [loadPayouts]);

  const openPayoutDetail = async (payout: AgentPayoutRow) => {
    setSelectedPayout(payout);
    setPayoutPayments([]);
    setPaymentsLoading(true);
    setPaymentsError(null);
    try {
      const rows = await getAgentPayoutPayments(agentId, payout.nachaId);
      setPayoutPayments(rows);
    } catch {
      setPaymentsError('Failed to load payout payments');
    } finally {
      setPaymentsLoading(false);
    }
  };

  const openBreakdown = (row: AgentPayoutPaymentRow) => {
    setBreakdownRow(row);
    setBreakdownPaymentId(row.paymentId);
  };

  const displayClient = (row: AgentPayoutPaymentRow) =>
    row.memberName || row.groupName || '—';

  // ── Payment list view (drill-down) ──────────────────────────────────────
  if (selectedPayout) {
    return (
      <div>
        <button
          type="button"
          onClick={() => { setSelectedPayout(null); setPayoutPayments([]); }}
          className="inline-flex items-center gap-1.5 mb-4 text-sm text-gray-600 hover:text-gray-900"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to payouts
        </button>

        <div className="mb-4 rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-white p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700">
            <span className="inline-flex items-center gap-1.5 font-semibold text-gray-900 text-base">
              <Banknote className="h-4 w-4 text-gray-400" />
              {formatCurrency(selectedPayout.totalPaidToAgent)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4 text-gray-400" />
              {formatDate(selectedPayout.generatedDate)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-gray-400" />
              {selectedPayout.paymentCount} payment{selectedPayout.paymentCount !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {paymentsLoading ? (
          <div className="flex justify-center py-12 text-gray-400">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : paymentsError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-red-700">{paymentsError}</div>
        ) : payoutPayments.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-10 text-center text-gray-500">
            No payments found for this payout.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Client</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Payment</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Commission</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Agent level at time</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Selling agent</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {payoutPayments.map((row, idx) => (
                  <tr key={`${selectedPayout.nachaId}-${row.paymentId}-${idx}`} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(row.paymentDate)}</td>
                    <td className="px-3 py-2 font-medium text-gray-900">{displayClient(row)}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(row.amount)}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(row.commissionAmount)}</td>
                    <td className="px-3 py-2">
                      {(() => {
                        const tierText = formatPayoutCommissionTierDisplay(
                          row.commissionTierLevelSnapshot,
                          row.commissionTierLevelSnapshotLabel
                        );
                        return tierText ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                            {tierText}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{row.sellingAgentName || '—'}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => openBreakdown(row)}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-xs font-medium"
                        title="View commission breakdown"
                      >
                        <Info className="h-3.5 w-3.5" />
                        Breakdown
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {breakdownPaymentId && breakdownRow && (
          <PaymentCommissionBreakdownModal
            isOpen={true}
            onClose={() => { setBreakdownPaymentId(null); setBreakdownRow(null); }}
            paymentId={breakdownPaymentId}
            paymentDate={breakdownRow.paymentDate ? String(breakdownRow.paymentDate) : undefined}
            amount={breakdownRow.amount}
            agentName={agentName}
            agentCommissionTierLevel={breakdownRow.commissionTierLevelSnapshot}
            agentCommissionTierLevelLabel={breakdownRow.commissionTierLevelSnapshotLabel}
            clientName={displayClient(breakdownRow)}
            breakdownSource="accounting"
          />
        )}
      </div>
    );
  }

  // ── Payout list view ─────────────────────────────────────────────────────
  return (
    <div>
      {payoutsError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-red-700">
          {payoutsError}
        </div>
      ) : payoutsLoading && payouts.length === 0 ? (
        <div className="flex justify-center py-16 text-gray-400">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      ) : payouts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
          <Banknote className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700 font-medium">No payouts yet</p>
          <p className="text-sm text-gray-500 mt-1">No commission runs have been sent for this agent.</p>
        </div>
      ) : (
        <>
          {payoutsPage === 1 && payouts[0] && (
            <div className="mb-6 rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-white p-6">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="hidden sm:flex h-12 w-12 rounded-full bg-blue-600/10 items-center justify-center shrink-0">
                    <TrendingUp className="h-6 w-6 text-blue-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold tracking-wide text-blue-700 uppercase">Latest payout</p>
                    <p className="text-3xl font-bold text-gray-900 mt-1 tabular-nums">
                      {formatCurrency(payouts[0].totalPaidToAgent)}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays className="h-4 w-4 text-gray-400" />
                        {formatDate(payouts[0].generatedDate)}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <FileText className="h-4 w-4 text-gray-400" />
                        {payouts[0].paymentCount} payment{payouts[0].paymentCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void openPayoutDetail(payouts[0])}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-oe-primary text-white text-sm font-medium hover:bg-oe-dark transition-colors"
                >
                  <Info className="h-4 w-4" />
                  View breakdown
                </button>
              </div>
            </div>
          )}

          {(() => {
            const heroShown = payoutsPage === 1 && !!payouts[0];
            const listItems = payouts.slice(heroShown ? 1 : 0);
            if (listItems.length === 0) return null;
            return (
              <>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">
                  {heroShown ? 'Past payouts' : 'Payouts'}
                </h3>
                <ul className="space-y-2">
                  {listItems.map((p) => (
                    <li
                      key={p.nachaId}
                      className="group rounded-lg border border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm transition-all"
                    >
                      <button
                        type="button"
                        onClick={() => void openPayoutDetail(p)}
                        className="w-full flex items-center justify-between gap-4 px-4 py-3 text-left"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="hidden sm:flex h-9 w-9 rounded-full bg-gray-100 items-center justify-center shrink-0">
                            <Banknote className="h-4 w-4 text-gray-500" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-base font-semibold text-gray-900 truncate">{formatDate(p.generatedDate)}</p>
                            <p className="text-xs text-gray-500">{p.paymentCount} payment{p.paymentCount !== 1 ? 's' : ''}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          <span className="text-base font-semibold text-gray-900 tabular-nums">
                            {formatCurrency(p.totalPaidToAgent)}
                          </span>
                          <span className="inline-flex items-center text-xs font-medium text-gray-600 group-hover:text-oe-primary">
                            Details
                            <ChevronRight className="h-4 w-4 ml-0.5" />
                          </span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            );
          })()}
        </>
      )}

      {payoutsPagination && payoutsPagination.total > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-4 border-t border-gray-200">
          <p className="text-sm text-gray-600">
            Showing {(payoutsPagination.page - 1) * payoutsPagination.limit + 1}–
            {Math.min(payoutsPagination.page * payoutsPagination.limit, payoutsPagination.total)} of{' '}
            {payoutsPagination.total}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={payoutsPage <= 1 || payoutsLoading}
              onClick={() => setPayoutsPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </button>
            <span className="text-sm text-gray-600">
              Page {payoutsPage}{payoutsPagination.totalPages > 0 ? ` of ${payoutsPagination.totalPages}` : ''}
            </span>
            <button
              type="button"
              disabled={payoutsLoading || payoutsPage >= payoutsPagination.totalPages}
              onClick={() => setPayoutsPage((p) => p + 1)}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentCommissionPayoutsView;
