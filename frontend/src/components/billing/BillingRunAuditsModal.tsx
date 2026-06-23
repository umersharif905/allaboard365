import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import type { BillingAuditRunId, BillingAuditRunResponse } from '../../services/billing.service';
import {
  compareAuditRows,
  MISSING_RECURRING_AUDIT_COLUMN_ORDER
} from '../../utils/auditRowsSort';

const AUDIT_LABELS: Record<BillingAuditRunId, string> = {
  missing_recurring: 'Missing DIME recurring',
  failed_payments: 'Failed payments',
  dime_status: 'Payment status vs DIME',
  webhook_errors: 'Webhook errors',
  payment_json_fees: 'Payment JSON / fees',
  enrollment_month_gaps: 'Enrollment / payment gaps',
  payment_hold_enrollments: 'Payment hold enrollments',
  mrr_compare: 'MRR (Expected vs DIME API)',
  invoice_payout_integrity: 'Invoice payout signals (Paid/fulfillment)',
  orphan_payments: 'Orphan payments (no linked invoice)',
};

const AUDIT_ORDER: BillingAuditRunId[] = [
  'missing_recurring',
  'failed_payments',
  'dime_status',
  'webhook_errors',
  'payment_json_fees',
  'enrollment_month_gaps',
  'payment_hold_enrollments',
  'mrr_compare',
  'invoice_payout_integrity',
  'orphan_payments'
];

/** Labels in Run audits dialog (kept user-friendly; must cover every BillingAuditRunId). */
const AUDIT_MODAL_CHECKBOX_LABELS: Record<BillingAuditRunId, string> = {
  missing_recurring: 'Missing DIME recurring (members)',
  failed_payments: 'Failed payments (list)',
  dime_status: 'Payment status vs DIME',
  webhook_errors: 'Webhook integration errors (sample)',
  payment_json_fees: 'Payment JSON / recurring SystemFees issues',
  enrollment_month_gaps: 'Enrollment / payment gaps (heuristic)',
  payment_hold_enrollments: 'Payment hold enrollments',
  mrr_compare: 'MRR (Expected vs DIME API)',
  invoice_payout_integrity: 'Invoice payout signals (Paid / fulfillment)',
  orphan_payments: 'Orphan payments (no linked invoice)'
};

function formatCurrency(n: number) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCell(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const MISSING_RECURRING_SAMPLE_LABELS: Record<string, string> = {
  memberName: 'Member',
  memberEmail: 'Email',
  memberPhone: 'Phone',
  groupName: 'Group',
  totalPremium: 'Total premium',
  lastChargeAmount: 'Last charge',
  lastPaymentDate: 'Last payment',
  lastProcessorTransactionId: 'Last processor txn',
  lastRecurringScheduleId: 'Last schedule ref'
};

function formatMissingRecurringSampleCell(key: string, value: unknown, formatCurrency: (n: number) => string): React.ReactNode {
  if (value == null || value === '') return '—';
  const keyLower = key.toLowerCase();
  if (
    keyLower === 'totalpremium' ||
    keyLower === 'lastchargeamount' ||
    keyLower.includes('amount')
  ) {
    const n = Number(value);
    return Number.isFinite(n) ? formatCurrency(n) : String(value);
  }
  if (keyLower.includes('date') || keyLower === 'lastpaymentdate') {
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  return String(value);
}

function MissingRecurringSampleTable({ rows }: { rows: Record<string, unknown>[] }) {
  const [sortKey, setSortKey] = useState<string>('lastPaymentDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const orderedCols = MISSING_RECURRING_AUDIT_COLUMN_ORDER as readonly string[];

  const displayRows = useMemo(() => {
    if (!rows.length) return rows;
    return [...rows].sort((a, b) => compareAuditRows(a, b, sortKey, sortDir));
  }, [rows, sortKey, sortDir]);

  if (!rows.length) {
    return <p className="text-sm text-gray-500">No rows in this sample.</p>;
  }

  const sample = rows[0];
  const visible = Object.keys(sample);
  const keys = [
    ...orderedCols.filter((k) => k in sample),
    ...visible.filter((k) => !orderedCols.includes(k))
  ];
  const sortable = new Set<string>(orderedCols);

  return (
    <div className="overflow-x-auto border border-gray-200 rounded-lg max-h-[min(60vh,480px)] overflow-y-auto">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            {keys.map((k) => {
              const isSortable = sortable.has(k);
              const label = MISSING_RECURRING_SAMPLE_LABELS[k] ?? k;
              return (
                <th
                  key={k}
                  className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap"
                >
                  {isSortable ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                        else {
                          setSortKey(k);
                          setSortDir('asc');
                        }
                      }}
                      className="inline-flex items-center gap-1 font-medium uppercase tracking-wider text-gray-500 hover:text-gray-800"
                    >
                      {label}
                      {sortKey === k ? (
                        sortDir === 'asc' ? (
                          <ChevronUp className="h-4 w-4 shrink-0" aria-hidden />
                        ) : (
                          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="h-4 w-4 shrink-0 opacity-40" aria-hidden />
                      )}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {displayRows.map((row, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k} className="px-3 py-2 text-gray-800 text-sm break-words max-w-[min(28rem,40vw)]">
                  {formatMissingRecurringSampleCell(k, row[k], formatCurrency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GenericRowsTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) {
    return <p className="text-sm text-gray-500">No rows in this sample.</p>;
  }
  const keys = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-lg">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            {keys.map((k) => (
              <th key={k} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {rows.map((row, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k} className="px-3 py-2 text-gray-800 font-mono text-xs break-all max-w-xs">
                  {formatCell(row[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatPaymentAuditDate(v: unknown): string {
  if (v == null) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function DimeStatusAuditPanel({ data }: { data: Record<string, unknown> }) {
  const [showAll, setShowAll] = useState(false);
  const allRows = (data.rows as Record<string, unknown>[] | undefined) ?? [];
  const actionable = useMemo(
    () =>
      allRows.filter((r) => {
        const ns = r.newStatus != null && String(r.newStatus).trim() !== '';
        const err = r.error != null && String(r.error).trim() !== '';
        return ns || err;
      }),
    [allRows]
  );
  const tableRows = showAll ? allRows : actionable;
  const hasMore = allRows.length > actionable.length;

  return (
    <div className="space-y-3 text-sm text-gray-800">
      <p>
        Examined: <strong>{String(data.examined ?? '—')}</strong> · In sync: <strong>{String(data.inSync ?? '—')}</strong> · Errors:{' '}
        <strong>{String(data.errors ?? '—')}</strong> · Would update: <strong>{String(data.wouldUpdate ?? '—')}</strong>
        {data.invoicesSynced != null && (
          <>
            {' '}
            · Group invoices synced: <strong>{String(data.invoicesSynced)}</strong>
          </>
        )}
      </p>
      <p>
        Dry run: <strong>{data.dryRun === true ? 'yes' : data.dryRun === false ? 'no' : '—'}</strong>
      </p>
      {(data.passAPrimaryCount != null || data.passBCount != null) && (
        <p className="text-gray-700">
          Candidate rows — Pass A (primary window): <strong>{String(data.passAPrimaryCount ?? '—')}</strong>
          {data.passBCount != null && Number(data.passBCount) > 0 && (
            <>
              {' '}
              · Pass B (older succeeded): <strong>{String(data.passBCount)}</strong>
            </>
          )}
        </p>
      )}
      <p className="text-gray-600">
        When a payment is corrected to a successful status and has an{' '}
        <code className="text-xs bg-gray-100 px-1 rounded">InvoiceId</code>, the linked group invoice is updated (paid amount /
        status). When DIME shows a non-success status but the database still shows success, the invoice may be un-fulfilled
        (paid amounts reversed) where allowed — dry run shows <strong>Invoice action</strong> and warnings (for example
        commissions).
      </p>

      {allRows.length === 0 ? (
        <p className="text-sm text-gray-500">No per-payment rows returned. Run the audit again after deploying the latest API.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-gray-600">
              {showAll
                ? `Showing all ${allRows.length} payment(s).`
                : actionable.length > 0
                  ? `Showing ${actionable.length} payment(s) that would change status or had a DIME lookup error.`
                  : 'No changes or lookup errors in this run — all examined rows match DIME (or were skipped).'}
            </p>
            {hasMore && (
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                {showAll ? 'Show changes & errors only' : `Show all ${allRows.length} rows`}
              </button>
            )}
          </div>

          {(showAll || actionable.length > 0) && (
            <div className="overflow-x-auto border border-gray-200 rounded-lg max-h-[min(60vh,480px)] overflow-y-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payer</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Current (DB)</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">DIME</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Would become</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment date</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice action</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Note</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {tableRows.map((r, i) => {
                    const payer = String(r.payerLabel ?? r.groupName ?? r.primaryMemberName ?? '—').trim() || '—';
                    const db = String(r.dbCanonical ?? r.currentStatus ?? '—');
                    const dime = r.dimeCanonical != null ? String(r.dimeCanonical) : '—';
                    const newSt = r.newStatus != null && String(r.newStatus).trim() !== '' ? String(r.newStatus) : '—';
                    const amt = Number(r.amount);
                    const kind = r.invoiceAdjustmentKind != null && String(r.invoiceAdjustmentKind).trim() !== ''
                      ? String(r.invoiceAdjustmentKind)
                      : '';
                    const ws = r.wouldSyncInvoice === true ? 'sync' : r.wouldUnfulfillInvoice === true ? 'unfulfill' : '';
                    const invoiceAction =
                      kind === 'sync'
                        ? 'Sync invoice'
                        : kind === 'unfulfill'
                          ? 'Unfulfill invoice'
                          : ws
                            ? ws
                            : '—';
                    let note = '';
                    if (r.error != null && String(r.error).trim() !== '') note = String(r.error);
                    else if (r.skipped === true && r.skipReason != null) note = String(r.skipReason);
                    return (
                      <tr key={`${String(r.paymentId ?? i)}-${i}`}>
                        <td className="px-3 py-2 text-gray-900 max-w-[14rem] break-words">{payer}</td>
                        <td className="px-3 py-2 text-gray-800 whitespace-nowrap">{db}</td>
                        <td className="px-3 py-2 text-gray-800 whitespace-nowrap">{dime}</td>
                        <td className="px-3 py-2 text-gray-900 font-medium whitespace-nowrap">{newSt}</td>
                        <td className="px-3 py-2 text-gray-800 text-right tabular-nums whitespace-nowrap">
                          {Number.isFinite(amt) ? formatCurrency(amt) : '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-700 whitespace-nowrap text-xs">{formatPaymentAuditDate(r.paymentDate)}</td>
                        <td className="px-3 py-2 text-gray-800 whitespace-nowrap text-xs">{invoiceAction}</td>
                        <td className="px-3 py-2 text-gray-600 text-xs max-w-xs break-words">{note || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!showAll && actionable.length === 0 && allRows.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-sm px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Show all {allRows.length} examined rows
            </button>
          )}
        </>
      )}
    </div>
  );
}

function AuditResultPanel({ auditId, data }: { auditId: BillingAuditRunId; data: Record<string, unknown> }) {
  if (data.ok === false) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">
        {String(data.error ?? 'Audit failed')}
      </div>
    );
  }

  switch (auditId) {
    case 'missing_recurring': {
      const sample = (data.sample as Record<string, unknown>[] | undefined) || [];
      return (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Count: <strong>{Number(data.count ?? 0)}</strong> · Showing up to 50 sample rows.
          </p>
          <MissingRecurringSampleTable rows={sample} />
        </div>
      );
    }
    case 'failed_payments': {
      const rows = (data.rows as Record<string, unknown>[] | undefined) || [];
      return (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Count (up to limit): <strong>{Number(data.count ?? rows.length)}</strong>
          </p>
          <GenericRowsTable rows={rows} />
        </div>
      );
    }
    case 'dime_status':
      return <DimeStatusAuditPanel data={data} />;
    case 'webhook_errors': {
      const rows = (data.rows as Record<string, unknown>[] | undefined) || [];
      return (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Rows (sample): <strong>{Number(data.count ?? rows.length)}</strong>
          </p>
          <GenericRowsTable rows={rows} />
        </div>
      );
    }
    case 'payment_json_fees': {
      const rows = (data.rows as Record<string, unknown>[] | undefined) || [];
      return (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Count: <strong>{Number(data.count ?? rows.length)}</strong>
          </p>
          <GenericRowsTable rows={rows} />
        </div>
      );
    }
    case 'enrollment_month_gaps': {
      const rows = (data.rows as Record<string, unknown>[] | undefined) || [];
      return (
        <div className="space-y-3">
          {data.note != null && String(data.note) !== '' ? (
            <p className="text-sm text-gray-600">{String(data.note)}</p>
          ) : null}
          <p className="text-sm text-gray-600">
            Count: <strong>{Number(data.count ?? rows.length)}</strong>
          </p>
          <GenericRowsTable rows={rows} />
        </div>
      );
    }
    case 'payment_hold_enrollments': {
      const rows = (data.rows as Record<string, unknown>[] | undefined) || [];
      return (
        <div className="space-y-3">
          {data.note != null && String(data.note) !== '' ? (
            <p className="text-sm text-gray-600">{String(data.note)}</p>
          ) : null}
          <p className="text-sm text-gray-600">
            Count: <strong>{Number(data.count ?? rows.length)}</strong>
          </p>
          <GenericRowsTable rows={rows} />
        </div>
      );
    }
    case 'mrr_compare': {
      const meta = data.dimeApiMrrMeta as
        | {
            unavailable?: boolean;
            skipped?: boolean;
            reason?: string;
            error?: string;
            timedOut?: boolean;
            capped?: boolean;
            customersChecked?: number;
            customersSkipped?: number;
            scheduleRowsCounted?: number;
            apiCallFailures?: number;
          }
        | undefined;
      const dime = data.dimeApiActiveMrr;
      const expected = data.expectedEnrollmentMrr ?? data.dbMrrTotal;
      const deferred = data.futureGroupDeferredMrr;
      const deferredCount = data.futureGroupDeferredEnrollmentCount;
      const diff = data.mrrExpectedMinusDimeApi ?? data.mrrDbMinusDimeApi;
      return (
        <div className="space-y-2 text-sm text-gray-800">
          {data.note != null && String(data.note) !== '' ? (
            <p className="text-gray-600">{String(data.note)}</p>
          ) : null}
          <p>
            Expected enrollment MRR: <strong>{formatCurrency(Number(expected ?? 0))}</strong>
          </p>
          <p>
            Group: <strong>{formatCurrency(Number(data.groupMrr ?? 0))}</strong> · Individual:{' '}
            <strong>{formatCurrency(Number(data.individualMrr ?? 0))}</strong>
          </p>
          <p className="text-xs text-gray-600">
            DB schedule total (reference): <strong>{formatCurrency(Number(data.dbMrrTotal ?? 0))}</strong>
          </p>
          {deferred != null && Number(deferred) > 0.005 && (
            <p className="text-xs text-yellow-800">
              Excluded for now (future-month group effective enrollments):{' '}
              <strong>{formatCurrency(Number(deferred))}</strong>
              {deferredCount != null ? ` (${Number(deferredCount)} enrollment rows)` : ''}
            </p>
          )}
          <p>
            DIME API (Active recurring):{' '}
            <strong>{dime != null ? formatCurrency(Number(dime)) : '—'}</strong>
          </p>
          <p>
            Difference (Expected − DIME):{' '}
            <strong>{diff != null ? formatCurrency(Number(diff)) : '—'}</strong>
          </p>
          {meta?.skipped && (
            <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
              DIME HTTP skipped ({String(meta.reason ?? 'scheduled batch')}). DB totals only.
            </p>
          )}
          {meta?.unavailable && (
            <p className="text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">
              DIME API total could not be loaded{meta.error ? `: ${String(meta.error)}` : '.'}
            </p>
          )}
          {!meta?.skipped && !meta?.unavailable && meta && (
            <p className="text-xs text-gray-600">
              Processor customers checked: {meta.customersChecked ?? '—'} · Active schedule rows summed:{' '}
              {meta.scheduleRowsCounted ?? '—'}
              {typeof meta.apiCallFailures === 'number' && meta.apiCallFailures > 0
                ? ` · API call failures: ${meta.apiCallFailures}`
                : ''}
              {meta.timedOut ? ' · Stopped early (time limit)' : ''}
              {meta.capped && (meta.customersSkipped ?? 0) > 0
                ? ` · Cap: skipped ${meta.customersSkipped} customers`
                : ''}
            </p>
          )}
        </div>
      );
    }
    case 'invoice_payout_integrity': {
      const sample = (data.sample as Record<string, unknown>[] | undefined) || [];
      return (
        <div className="space-y-3 text-sm text-gray-800">
          <p>
            Paid invoices missing <code className="text-xs bg-gray-100 px-1 rounded">PaymentReceivedDate</code>:{' '}
            <strong>{Number(data.paidMissingPaymentReceivedDate ?? 0)}</strong>
          </p>
          <p>
            Unpaid/partial/overdue with <code className="text-xs bg-gray-100 px-1 rounded">PaymentReceivedDate</code> set:{' '}
            <strong>{Number(data.unpaidWithPaymentReceivedDateSet ?? 0)}</strong>
          </p>
          <p>
            Paid invoices with a linked <strong>Failed</strong> payment (review sample):{' '}
            <strong>{Number(data.paidInvoiceLinkedFailedPaymentCount ?? sample.length)}</strong>
          </p>
          {sample.length > 0 && <GenericRowsTable rows={sample} />}
        </div>
      );
    }
    case 'orphan_payments': {
      const rows = (data.rows as Record<string, unknown>[] | undefined) || [];
      const completed = Number(data.completedNoInvoiceCount ?? data.count ?? 0);
      return (
        <div className="space-y-3 text-sm text-gray-800">
          {data.note != null && String(data.note) !== '' ? (
            <p className="text-gray-600">{String(data.note)}</p>
          ) : null}
          <p>
            Successful charges, no <code className="text-xs bg-gray-100 px-1 rounded">InvoiceId</code> (noise excluded):{' '}
            <strong>{completed}</strong>
          </p>
          {rows.length > 0 ? (
            <>
              <p className="text-gray-600">Sample (most recent first):</p>
              <GenericRowsTable rows={rows} />
            </>
          ) : (
            <p className="text-gray-500">No sample rows.</p>
          )}
        </div>
      );
    }
    default:
      return <pre className="text-xs bg-gray-50 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(data, null, 2)}</pre>;
  }
}

type TabId = 'overview' | BillingAuditRunId;

export interface BillingRunAuditsModalProps {
  isOpen: boolean;
  onClose: () => void;
  runAuditsSelections: Record<BillingAuditRunId, boolean>;
  setRunAuditsSelections: React.Dispatch<React.SetStateAction<Record<BillingAuditRunId, boolean>>>;
  runAuditsStart: string;
  setRunAuditsStart: (v: string) => void;
  runAuditsEnd: string;
  setRunAuditsEnd: (v: string) => void;
  runAuditsDimeScope: 'calendar' | 'hours';
  setRunAuditsDimeScope: (v: 'calendar' | 'hours') => void;
  runAuditsHoursBack: number;
  setRunAuditsHoursBack: (v: number) => void;
  runAuditsSuccessRecheckDays: number;
  setRunAuditsSuccessRecheckDays: (v: number) => void;
  runAuditsSecondaryLimit: number;
  setRunAuditsSecondaryLimit: (v: number) => void;
  runAuditsLimit: number;
  setRunAuditsLimit: (v: number) => void;
  runAuditsDryRun: boolean;
  setRunAuditsDryRun: (v: boolean) => void;
  runAuditsPersist: boolean;
  setRunAuditsPersist: (v: boolean) => void;
  runAuditsLoading: boolean;
  runAuditsResult: BillingAuditRunResponse | null;
  onRun: () => void;
}

export const BillingRunAuditsModal: React.FC<BillingRunAuditsModalProps> = ({
  isOpen,
  onClose,
  runAuditsSelections,
  setRunAuditsSelections,
  runAuditsStart,
  setRunAuditsStart,
  runAuditsEnd,
  setRunAuditsEnd,
  runAuditsDimeScope,
  setRunAuditsDimeScope,
  runAuditsHoursBack,
  setRunAuditsHoursBack,
  runAuditsSuccessRecheckDays,
  setRunAuditsSuccessRecheckDays,
  runAuditsSecondaryLimit,
  setRunAuditsSecondaryLimit,
  runAuditsLimit,
  setRunAuditsLimit,
  runAuditsDryRun,
  setRunAuditsDryRun,
  runAuditsPersist,
  setRunAuditsPersist,
  runAuditsLoading,
  runAuditsResult,
  onRun
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  const resultKeys = useMemo(() => {
    const r = runAuditsResult?.results;
    if (!r) return [] as BillingAuditRunId[];
    return AUDIT_ORDER.filter((id) => Object.prototype.hasOwnProperty.call(r, id));
  }, [runAuditsResult]);

  useEffect(() => {
    if (runAuditsResult) setActiveTab('overview');
  }, [runAuditsResult]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-start justify-center px-4 py-8 pb-24">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !runAuditsLoading && onClose()} />
        <div className="relative bg-white rounded-lg shadow-xl max-w-6xl w-full p-6 my-2">
          <h3 className="text-lg font-semibold text-gray-900">Run billing audits</h3>
          <p className="mt-1 text-sm text-gray-600">
            Select checks to run. Payment status vs DIME can use a calendar range or payments from the last N hours. Other
            audits that use dates (for example webhook errors) still use the start/end dates below. Default range is the last 30
            days when you open this dialog.
          </p>

          <div className="mt-4 space-y-2">
            {AUDIT_ORDER.map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  checked={!!runAuditsSelections[id]}
                  onChange={(e) => setRunAuditsSelections((prev) => ({ ...prev, [id]: e.target.checked }))}
                />
                {AUDIT_MODAL_CHECKBOX_LABELS[id]}
              </label>
            ))}
          </div>

          {runAuditsSelections.dime_status && (
            <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50/60 p-4 space-y-3">
              <p className="text-sm font-medium text-gray-900">Payment status vs DIME — time window</p>
              <div className="flex flex-wrap gap-4 text-sm text-gray-800">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="dime-scope"
                    className="text-blue-600 focus:ring-blue-500"
                    checked={runAuditsDimeScope === 'calendar'}
                    onChange={() => setRunAuditsDimeScope('calendar')}
                  />
                  Calendar range (start/end dates below)
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="dime-scope"
                    className="text-blue-600 focus:ring-blue-500"
                    checked={runAuditsDimeScope === 'hours'}
                    onChange={() => setRunAuditsDimeScope('hours')}
                  />
                  Last N hours (1–168)
                </label>
              </div>
              {runAuditsDimeScope === 'hours' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Hours back</label>
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={runAuditsHoursBack}
                      onChange={(e) => setRunAuditsHoursBack(Number(e.target.value) || 168)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Pass B: older “succeeded” lookback (days, 0 = off)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={366}
                      value={runAuditsSuccessRecheckDays}
                      onChange={(e) => setRunAuditsSuccessRecheckDays(Number(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Pass B row cap (0 = off)</label>
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={runAuditsSecondaryLimit}
                      onChange={(e) => setRunAuditsSecondaryLimit(Number(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-600">
                Pass B adds an extra sweep for payments that still look successful in the database but fall outside the last-N-hours
                window, within the day lookback you set. Both limits must be &gt; 0 for Pass B to run.
              </p>
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start date</label>
              <input
                type="date"
                value={runAuditsStart}
                onChange={(e) => setRunAuditsStart(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End date</label>
              <input
                type="date"
                value={runAuditsEnd}
                onChange={(e) => setRunAuditsEnd(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Row limit</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={runAuditsLimit}
                onChange={(e) => setRunAuditsLimit(Number(e.target.value) || 500)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                checked={runAuditsDryRun}
                onChange={(e) => setRunAuditsDryRun(e.target.checked)}
              />
              Dry run for Payment status vs DIME only (recommended; uncheck to apply payment and linked invoice updates from
              DIME). Does not hide MRR totals in results or saved report.
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                checked={runAuditsPersist}
                onChange={(e) => setRunAuditsPersist(e.target.checked)}
              />
              Save summary + compact results to database after run
            </label>
          </div>

          {runAuditsResult && (
            <div className="mt-6 border-t border-gray-200 pt-4">
              <p className="text-xs font-medium text-gray-500 mb-2">
                Finished in {runAuditsResult.totalDurationMs} ms
              </p>
              <div className="flex flex-wrap gap-2 border-b border-gray-200 pb-3 mb-3">
                <button
                  type="button"
                  onClick={() => setActiveTab('overview')}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium text-left ${
                    activeTab === 'overview'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Overview
                </button>
                {resultKeys.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveTab(id)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium text-left max-w-full sm:max-w-[min(100%,16rem)] ${
                      activeTab === id
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                    title={AUDIT_LABELS[id]}
                  >
                    {AUDIT_LABELS[id]}
                  </button>
                ))}
              </div>
              <div className="pr-1">
                {activeTab === 'overview' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {resultKeys.map((id) => {
                      const raw = runAuditsResult.results[id] as Record<string, unknown>;
                      const ok = raw?.ok === true;
                      return (
                        <div
                          key={id}
                          className={`rounded-lg border p-4 ${ok ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}
                        >
                          <p className="text-sm font-medium text-gray-900">{AUDIT_LABELS[id]}</p>
                          <p className="text-xs text-gray-600 mt-1">
                            {ok ? 'Completed' : 'Failed'} · {String(raw?.durationMs ?? '—')} ms
                          </p>
                          {!ok && raw?.error != null && String(raw.error) !== '' ? (
                            <p className="text-xs text-red-800 mt-2">{String(raw.error)}</p>
                          ) : null}
                          {ok && (
                            <button
                              type="button"
                              onClick={() => setActiveTab(id)}
                              className="mt-2 text-xs text-blue-600 hover:text-blue-800 font-medium"
                            >
                              View details →
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {activeTab !== 'overview' &&
                  runAuditsResult &&
                  resultKeys.includes(activeTab as BillingAuditRunId) && (
                    <AuditResultPanel
                      auditId={activeTab as BillingAuditRunId}
                      data={runAuditsResult.results[activeTab as BillingAuditRunId] as Record<string, unknown>}
                    />
                  )}
              </div>
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3 border-t border-gray-200 pt-4">
            <button
              type="button"
              onClick={() => !runAuditsLoading && onClose()}
              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void onRun()}
              disabled={runAuditsLoading}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {runAuditsLoading ? 'Running…' : 'Run selected'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
