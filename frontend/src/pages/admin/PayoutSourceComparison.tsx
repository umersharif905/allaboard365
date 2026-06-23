import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronLeft,
  RefreshCw,
  Database,
  FileText,
  Clock
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../../services/api.service';

// Invoice-Sourced Payouts validation harness.
//
// Compares per-payment breakdown columns between oe.Payments (legacy) and
// oe.Invoices (canonical) for the last N days. Non-zero deltas indicate the
// dual-write fell out of sync and must be resolved before removing the
// COALESCE(inv.X, p.X) fallback in readers.

interface CoverageSummary {
  totalPayments: number;
  unlinkedPayments: number;
  linkedPayments: number;
  linkedPaidInvoices: number;
  linkedUnpaidInvoices: number;
}

interface DeltaRow {
  paymentId: string;
  invoiceId: string | null;
  tenantId: string | null;
  paymentDate: string;
  amount: number | null;
  column: string;
  paymentsValue: number | string | null;
  invoicesValue: number | string | null;
  delta: number | null;
}

interface ComparisonResponse {
  success: boolean;
  windowDays: number;
  tolerance: number;
  coverage: CoverageSummary;
  deltaCount: number;
  deltas: DeltaRow[];
  message?: string;
}

const DAYS_OPTIONS = [7, 14, 30, 60, 90];

const fmtCurrency = (val: number | null | undefined): string => {
  if (val == null || Number.isNaN(Number(val))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(val));
};

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch (_e) {
    return String(iso);
  }
};

const shortId = (id: string | null | undefined): string => {
  if (!id) return '—';
  const s = String(id);
  return s.length > 10 ? `${s.slice(0, 8)}…` : s;
};

const PayoutSourceComparison: React.FC = () => {
  const navigate = useNavigate();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ComparisonResponse | null>(null);

  const load = useCallback(async (windowDays: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.get<ComparisonResponse>(
        `/api/admin/payout-source-comparison?days=${windowDays}`
      );
      if (!res.success) {
        throw new Error(res.message || 'Failed to load comparison');
      }
      setData(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unexpected error';
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const grouped = useMemo(() => {
    if (!data?.deltas) return new Map<string, DeltaRow[]>();
    const map = new Map<string, DeltaRow[]>();
    for (const d of data.deltas) {
      const list = map.get(d.paymentId) || [];
      list.push(d);
      map.set(d.paymentId, list);
    }
    return map;
  }, [data]);

  const hasDeltas = (data?.deltaCount || 0) > 0;

  return (
    <div className="p-6">
      <div className="flex items-center mb-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex items-center text-gray-600 hover:text-gray-900 mr-4"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </button>
        <h1 className="text-2xl font-semibold text-gray-900">Payout Source Comparison</h1>
      </div>

      <p className="text-gray-600 mb-6 max-w-4xl">
        Compares per-payment breakdown columns between <code className="font-mono">oe.Payments</code> (legacy source)
        and <code className="font-mono">oe.Invoices</code> (canonical source) for the selected window.
        Any rows below indicate the dual-write fell out of sync; resolve these before dropping the
        <code className="font-mono"> COALESCE(inv.X, p.X)</code> fallback.
      </p>

      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 flex flex-wrap items-center gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Window</label>
          <select
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={loading}
          >
            {DAYS_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => load(days)}
            disabled={loading}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 mb-6 flex items-start">
          <AlertTriangle className="h-5 w-5 mr-2 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Failed to load comparison</p>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <Database className="h-4 w-4 mr-2" />
                <span className="text-sm">Total payments</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.coverage.totalPayments}</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <FileText className="h-4 w-4 mr-2" />
                <span className="text-sm">Linked to invoice</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.coverage.linkedPayments}</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <Clock className="h-4 w-4 mr-2" />
                <span className="text-sm">Unlinked (grandfathered)</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.coverage.unlinkedPayments}</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <CheckCircle className="h-4 w-4 mr-2 text-oe-success" />
                <span className="text-sm">Linked · invoice Paid</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.coverage.linkedPaidInvoices}</div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <AlertTriangle className="h-4 w-4 mr-2 text-yellow-600" />
                <span className="text-sm">Linked · invoice Unpaid</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.coverage.linkedUnpaidInvoices}</div>
            </div>
          </div>

          {!hasDeltas ? (
            <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-6 flex items-start">
              <CheckCircle className="h-6 w-6 mr-3 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">No deltas detected</p>
                <p className="text-sm">
                  All linked payments in the last {data.windowDays} days have matching breakdown
                  columns between <code className="font-mono">oe.Payments</code> and{' '}
                  <code className="font-mono">oe.Invoices</code>. Safe to consider dropping the
                  Payments-side fallback.
                </p>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-lg font-medium text-gray-900">
                  {data.deltaCount} delta{data.deltaCount === 1 ? '' : 's'} across{' '}
                  {grouped.size} payment{grouped.size === 1 ? '' : 's'}
                </h2>
                <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
                  Tolerance: ±{data.tolerance}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment date</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Column</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Payments</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Invoices</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Δ</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {data.deltas.map((row, idx) => {
                      const isJson = row.delta == null;
                      return (
                        <tr key={`${row.paymentId}-${row.column}-${idx}`} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm font-mono text-gray-900" title={row.paymentId}>
                            {shortId(row.paymentId)}
                          </td>
                          <td className="px-4 py-3 text-sm font-mono text-gray-600" title={row.invoiceId || ''}>
                            {shortId(row.invoiceId)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">{fmtDate(row.paymentDate)}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">{fmtCurrency(row.amount)}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                              {row.column}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-right font-mono text-gray-900">
                            {isJson
                              ? (row.paymentsValue ? <span className="text-xs text-gray-500">[json]</span> : '∅')
                              : fmtCurrency(row.paymentsValue as number | null)}
                          </td>
                          <td className="px-4 py-3 text-sm text-right font-mono text-gray-900">
                            {isJson
                              ? (row.invoicesValue ? <span className="text-xs text-gray-500">[json]</span> : '∅')
                              : fmtCurrency(row.invoicesValue as number | null)}
                          </td>
                          <td className={`px-4 py-3 text-sm text-right font-mono ${isJson ? 'text-gray-500' : (row.delta && row.delta !== 0 ? 'text-red-600' : 'text-gray-900')}`}>
                            {isJson ? 'json-diff' : fmtCurrency(row.delta)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PayoutSourceComparison;
