/**
 * Shared payment detail sheet (tenant billing ↔ member admin payment history): details, commissions, retry / refund / audit.
 */

import { Loader2, Receipt, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
  billingService,
  formatBillingPaymentStatusLabel,
  formatChargeSourceAttribution,
  getPaymentMethodType,
  isAchSettlementPendingFailureReason,
  type BillingPaymentCommissionRow,
  type BillingPaymentRow
} from '../../services/billing.service';
import type { PaymentBreakdownData } from '../../types/paymentCommissionBreakdown.types';
import { getStoredDimePaymentFailureUiHint } from '../../constants/dimePaymentFailureHints';
import { PaymentCommissionBreakdownView } from './PaymentCommissionBreakdownView';
import { AdminPaymentRetryModal } from './AdminPaymentRetryModal';

function formatCalendarDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    const datePart = String(dateStr).split('T')[0];
    const [yStr, mStr, dStr] = datePart.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    if (!y || !m || !d) return new Date(dateStr).toLocaleDateString();
    return new Date(y, m - 1, d).toLocaleDateString();
  } catch (_e) {
    return String(dateStr);
  }
}

function formatCurrency(n: number): string {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDetailDate(d: string | null | undefined): string {
  return d ? formatCalendarDate(d) : '—';
}

function formatBillingRowLinkedInvoice(row: BillingPaymentRow): string {
  if (row.linkedInvoiceNumber) {
    const period =
      row.linkedInvoiceBillingPeriodStart && row.linkedInvoiceBillingPeriodEnd
        ? ` · ${formatDetailDate(row.linkedInvoiceBillingPeriodStart)} – ${formatDetailDate(row.linkedInvoiceBillingPeriodEnd)}`
        : '';
    const st = row.linkedInvoiceStatus ? ` · ${row.linkedInvoiceStatus}` : '';
    return `#${row.linkedInvoiceNumber}${period}${st}`;
  }
  if (row.invoiceId) {
    const short = String(row.invoiceId).replace(/-/g, '').slice(0, 8);
    return `Linked (invoice ID …${short}) — refresh list if number is missing`;
  }
  return 'None';
}

function isRefundEligible(row: BillingPaymentRow): boolean {
  const tt = (row.transactionType || '').toLowerCase();
  if (tt === 'refund') return false;
  const status = (row.status || '').toLowerCase();
  if (status === 'refunded') return false;
  return ['completed', 'paid', 'approval', 'success', 'succeeded'].includes(status);
}

function sumBreakdownAllocated(data: PaymentBreakdownData): number {
  return data.products.reduce(
    (sum, p) => sum + p.breakdown.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    0
  );
}

export interface AdminPaymentDetailsModalProps {
  billingRow: BillingPaymentRow | null;
  open: boolean;
  onClose: () => void;
  currentRole: string;
  effectiveTenantId?: string | null;
  /** After retry succeeds or list should refresh */
  onRetrySuccess: () => void;
  onRequestRefund: (row: BillingPaymentRow) => void;
  /** Tenant billing audit entry point; omit to hide Audit action */
  onOpenAudit?: (row: BillingPaymentRow) => void;
  /** TenantAdmin/SysAdmin tools (retry, refund, commissions, audit optional) */
  showAdminBillingActions?: boolean;
  /** Member-specific rows under the standard detail fields */
  detailsExtras?: React.ReactNode;
  /** e.g. payment status editor (delete lives under Actions when this is set) */
  footerExtras?: React.ReactNode;
  /** Optional destructive remove (member admin); confirm copy stresses this is not recommended */
  deletePayment?: {
    showConfirm: boolean;
    deleting: boolean;
    disabled?: boolean;
    onRequestDelete: () => void;
    onCancelConfirm: () => void;
    onConfirmDelete: () => void | Promise<void>;
  };
}

export const AdminPaymentDetailsModal: React.FC<AdminPaymentDetailsModalProps> = ({
  billingRow,
  open,
  onClose,
  currentRole,
  effectiveTenantId,
  onRetrySuccess,
  onRequestRefund,
  onOpenAudit,
  showAdminBillingActions = true,
  detailsExtras,
  footerExtras,
  deletePayment
}) => {
  const [detailTab, setDetailTab] = useState<'details' | 'commissions'>('details');
  const [commissionBreakdown, setCommissionBreakdown] = useState<PaymentBreakdownData | null>(null);
  const [commissionBreakdownLoading, setCommissionBreakdownLoading] = useState(false);
  const [commissionBreakdownError, setCommissionBreakdownError] = useState<string | null>(null);
  const [commissionLedgerFallback, setCommissionLedgerFallback] = useState<BillingPaymentCommissionRow[]>([]);
  const [commissionLedgerTotal, setCommissionLedgerTotal] = useState(0);
  const [commissionUsedLedgerFallback, setCommissionUsedLedgerFallback] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);

  useEffect(() => {
    if (!open || !billingRow) {
      setDetailTab('details');
      setCommissionBreakdown(null);
      setCommissionBreakdownError(null);
      setCommissionBreakdownLoading(false);
      setCommissionLedgerFallback([]);
      setCommissionLedgerTotal(0);
      setCommissionUsedLedgerFallback(false);
      return;
    }
    setDetailTab('details');
    setCommissionBreakdown(null);
    setCommissionBreakdownError(null);
    setCommissionLedgerFallback([]);
    setCommissionLedgerTotal(0);
    setCommissionUsedLedgerFallback(false);
  }, [open, billingRow?.paymentId]);

  useEffect(() => {
    if (!open || !billingRow?.paymentId || !currentRole) return;
    if (!showAdminBillingActions) return;
    if (detailTab !== 'commissions') return;

    let cancelled = false;
    const tenantOpt = currentRole === 'SysAdmin' ? effectiveTenantId ?? undefined : undefined;

    (async () => {
      setCommissionBreakdownLoading(true);
      setCommissionBreakdownError(null);
      setCommissionBreakdown(null);
      setCommissionLedgerFallback([]);
      setCommissionLedgerTotal(0);
      setCommissionUsedLedgerFallback(false);

      try {
        const br = await billingService.getAccountingPaymentCommissionBreakdown(
          billingRow.paymentId,
          tenantOpt ?? null
        );
        if (cancelled) return;
        if (br.success && br.data) {
          setCommissionBreakdown(br.data);
          return;
        }
        setCommissionBreakdownError(br.message || 'Could not load payout-style commission breakdown.');
        const leg = await billingService.getPaymentCommissions(currentRole, billingRow.paymentId, tenantOpt);
        if (cancelled) return;
        if (leg.success && leg.data) {
          setCommissionLedgerFallback(leg.data.commissions || []);
          setCommissionLedgerTotal(leg.data.totalAmount || 0);
          setCommissionUsedLedgerFallback(true);
        }
      } catch (err: any) {
        if (cancelled) return;
        setCommissionBreakdownError(err?.message || 'Failed to load commission breakdown.');
        try {
          const leg = await billingService.getPaymentCommissions(currentRole, billingRow.paymentId, tenantOpt);
          if (!cancelled && leg.success && leg.data) {
            setCommissionLedgerFallback(leg.data.commissions || []);
            setCommissionLedgerTotal(leg.data.totalAmount || 0);
            setCommissionUsedLedgerFallback(true);
          }
        } catch (_e2) {
          /* keep first error */
        }
      } finally {
        if (!cancelled) setCommissionBreakdownLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, billingRow?.paymentId, detailTab, currentRole, effectiveTenantId, showAdminBillingActions]);

  const commissionTabBadgeCount = useMemo(() => {
    if (commissionBreakdown?.products?.length) {
      return commissionBreakdown.products.reduce((n, p) => n + (p.breakdown?.length ?? 0), 0);
    }
    return commissionLedgerFallback.length;
  }, [commissionBreakdown, commissionLedgerFallback]);

  if (!open || !billingRow) return null;

  const showCommissionsTab = showAdminBillingActions;
  const canRetry = showAdminBillingActions && billingRow.status === 'Failed';
  const canRefund = showAdminBillingActions && isRefundEligible(billingRow);
  const showAuditAction = !!(showAdminBillingActions && onOpenAudit);
  const hasActionsSection =
    showAdminBillingActions &&
    (canRetry || canRefund || showAuditAction || !!deletePayment);

  const trimmedProcessorFailureReason = (billingRow.failureReason ?? '').trim();
  const achSettlementPending = isAchSettlementPendingFailureReason(
    trimmedProcessorFailureReason,
    billingRow.status
  );
  const showProcessorFailureReason =
    trimmedProcessorFailureReason.length > 0 &&
    trimmedProcessorFailureReason.toLowerCase() !== 'success' &&
    !achSettlementPending;
  const processorFailureUiHint =
    achSettlementPending || showProcessorFailureReason
      ? getStoredDimePaymentFailureUiHint(trimmedProcessorFailureReason, billingRow.status)
      : null;
  const chargeSourceLabel =
    billingRow.chargeSourceLabel ??
    formatChargeSourceAttribution({
      paymentMethod: billingRow.paymentMethod,
      enrollmentId: billingRow.enrollmentId,
      recurringScheduleId: billingRow.recurringScheduleId,
      createdBy: billingRow.createdBy,
      initiatedByName: billingRow.initiatedByName,
      isManualCharge: billingRow.isManualCharge,
      memberUserId: billingRow.memberUserId
    });

  return (
    <>
      <div className="fixed inset-0 z-50 overflow-y-auto">
        <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={onClose} />
          <div className="relative bg-white rounded-lg shadow-xl max-w-3xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Payment details</h3>
                <p className="mt-1 text-sm text-gray-500">
                  {formatDetailDate(billingRow.paymentDate)} · {formatCurrency(billingRow.amount)}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>

            {showCommissionsTab ? (
              <div className="mt-4 border-b border-gray-200">
                <nav className="-mb-px flex space-x-6">
                  <button
                    type="button"
                    onClick={() => setDetailTab('details')}
                    className={`py-2 px-1 border-b-2 text-sm font-medium ${
                      detailTab === 'details'
                        ? 'border-oe-primary text-oe-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    Details
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetailTab('commissions')}
                    className={`py-2 px-1 border-b-2 text-sm font-medium ${
                      detailTab === 'commissions'
                        ? 'border-oe-primary text-oe-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    Commissions
                    {!commissionBreakdownLoading && commissionTabBadgeCount > 0 && (
                      <span className="ml-2 inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700">
                        {commissionTabBadgeCount}
                      </span>
                    )}
                  </button>
                </nav>
              </div>
            ) : null}

            {detailTab === 'details' || !showCommissionsTab ? (
              <>
                <div className="mt-4 space-y-0 divide-y divide-gray-100">
                  <div className="flex flex-col gap-1 py-2">
                    <span className="text-xs font-medium text-gray-500 uppercase">Processor</span>
                    <span className="text-sm text-gray-900">{billingRow.processor ?? '—'}</span>
                  </div>
                  {(billingRow.processorTransactionId ?? '').trim() !== '' ? (
                      <div className="flex flex-col gap-1 py-2">
                          <span className="text-xs font-medium text-gray-500 uppercase">
                              Processor transaction #
                          </span>
                          <span className="text-sm text-gray-900 font-mono break-all">
                              {(billingRow.processorTransactionId ?? '').trim()}
                          </span>
                      </div>
                  ) : null}
                  <div className="flex flex-col gap-1 py-2">
                    <span className="text-xs font-medium text-gray-500 uppercase">Status</span>
                    <span className="text-sm text-gray-900">{formatBillingPaymentStatusLabel(billingRow)}</span>
                  </div>
                  <div className="flex flex-col gap-1 py-2">
                    <span className="text-xs font-medium text-gray-500 uppercase">Method</span>
                    <span className="text-sm text-gray-900">{getPaymentMethodType(billingRow.paymentMethod).label}</span>
                  </div>
                  {chargeSourceLabel ? (
                    <div className="flex flex-col gap-1 py-2">
                      <span className="text-xs font-medium text-gray-500 uppercase">Charged by</span>
                      <span className="text-sm text-gray-900">{chargeSourceLabel}</span>
                    </div>
                  ) : null}
                  {achSettlementPending ? (
                    <div className="flex flex-col gap-1 py-2">
                      <span className="text-xs font-medium text-gray-500 uppercase">Settlement</span>
                      <span className="text-sm text-amber-900">{trimmedProcessorFailureReason}</span>
                      {processorFailureUiHint ? (
                        <p className="text-xs text-amber-900 leading-snug whitespace-pre-wrap break-words border-l-2 border-amber-300 pl-2 pt-0.5">
                          {processorFailureUiHint}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-1 py-2">
                    <span className="text-xs font-medium text-gray-500 uppercase">Linked invoice</span>
                    <span className="text-sm text-gray-900">{formatBillingRowLinkedInvoice(billingRow)}</span>
                  </div>
                  {showProcessorFailureReason ? (
                    <div className="flex flex-col gap-1 py-2">
                      <span className="text-xs font-medium text-gray-500 uppercase">Failure reason</span>
                      <span className="text-sm text-red-800 whitespace-pre-wrap break-words leading-relaxed">
                        {trimmedProcessorFailureReason}
                      </span>
                      {processorFailureUiHint ? (
                        <p className="text-xs text-amber-900 mt-2 leading-snug whitespace-pre-wrap break-words border-l-2 border-amber-300 pl-2 pt-0.5">
                          {processorFailureUiHint}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {detailsExtras ? (
                  <div className="mt-4 pt-4 border-t border-gray-100 space-y-4">{detailsExtras}</div>
                ) : null}
              </>
            ) : (
              <div className="mt-4">
                {!commissionUsedLedgerFallback && (
                  <>
                    <p className="text-xs text-gray-600 mb-3 leading-relaxed">
                      Per-product allocation is the same engine as Accounting → Commission breakdown and agent commission
                      generation (posted payment rows plus rules), not raw <code className="text-[11px]">oe.Commissions</code>{' '}
                      ledger lines.
                    </p>
                    {commissionBreakdown && commissionBreakdown.products.length > 0 ? (
                      <div className="flex items-center justify-between mb-2 text-sm">
                        <span className="text-gray-600">Recipient lines (all products)</span>
                        <span className="font-medium text-gray-900">
                          Total allocated: {formatCurrency(sumBreakdownAllocated(commissionBreakdown))}
                        </span>
                      </div>
                    ) : null}
                  </>
                )}
                {commissionUsedLedgerFallback && commissionBreakdownError ? (
                  <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
                    {commissionBreakdownError} Showing posted commission ledger as fallback.
                  </div>
                ) : null}

                <PaymentCommissionBreakdownView
                  data={commissionBreakdown}
                  loading={commissionBreakdownLoading}
                  error={commissionUsedLedgerFallback ? null : commissionBreakdownError}
                  breakdownSource="accounting"
                  compact
                />

                {!commissionBreakdownLoading && commissionUsedLedgerFallback && commissionLedgerFallback.length > 0 ? (
                  <>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-6 mb-2">
                      Posted ledger (oe.Commissions)
                    </h4>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm text-gray-600">
                        {commissionLedgerFallback.length} row{commissionLedgerFallback.length === 1 ? '' : 's'}
                      </p>
                      <p className="text-sm font-medium text-gray-900">
                        Total: {formatCurrency(commissionLedgerTotal)}
                      </p>
                    </div>
                    <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                      {commissionLedgerFallback.map((c) => {
                        const recipientName = c.agentName || c.agencyName || '(Unassigned)';
                        const recipientSub = c.agentName
                          ? c.agencyName
                            ? `Agent · ${c.agencyName}`
                            : 'Agent'
                          : c.agencyName
                            ? 'Agency'
                            : null;
                        const badgeClass =
                          c.status === 'Paid'
                            ? 'bg-green-100 text-green-800'
                            : c.status === 'Pending'
                              ? 'bg-yellow-100 text-yellow-800'
                              : c.status === 'Hold' || c.status === 'OnHold'
                                ? 'bg-amber-100 text-amber-800'
                                : c.status === 'Reversed' || c.status === 'Clawback'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-gray-100 text-gray-800';
                        return (
                          <div key={c.commissionId} className="p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">{recipientName}</p>
                                {recipientSub && <p className="text-xs text-gray-500 truncate">{recipientSub}</p>}
                                {c.agentEmail && <p className="text-xs text-gray-500 truncate">{c.agentEmail}</p>}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm font-semibold text-gray-900">{formatCurrency(c.amount)}</p>
                                <span
                                  className={`inline-flex px-2 py-0.5 mt-1 text-xs font-semibold rounded-full ${badgeClass}`}
                                >
                                  {c.status}
                                </span>
                              </div>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
                              {c.transactionType && (
                                <div>
                                  <span className="text-gray-500">Type: </span>
                                  <span className="text-gray-900">{c.transactionType}</span>
                                </div>
                              )}
                              {(c.periodStartDate || c.periodEndDate) && (
                                <div>
                                  <span className="text-gray-500">Period: </span>
                                  <span className="text-gray-900">
                                    {c.periodStartDate ? formatDetailDate(c.periodStartDate) : '—'}
                                    {' – '}
                                    {c.periodEndDate ? formatDetailDate(c.periodEndDate) : '—'}
                                  </span>
                                </div>
                              )}
                              {c.splitPartnerName && c.splitPercentage != null && (
                                <div className="col-span-2">
                                  <span className="text-gray-500">Split: </span>
                                  <span className="text-gray-900">
                                    {c.isPrimaryInSplit ? 'Primary' : 'Partner'} ·{' '}
                                    {Math.round(c.splitPercentage * 100) / 100}% with {c.splitPartnerName}
                                  </span>
                                </div>
                              )}
                              {c.appliedToBalance != null && c.appliedToBalance > 0 && (
                                <div className="col-span-2">
                                  <span className="text-gray-500">Applied to advance balance: </span>
                                  <span className="text-gray-900">{formatCurrency(c.appliedToBalance)}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : null}
              </div>
            )}

            {hasActionsSection ? (
              <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="mb-3">
                  <h4 className="text-sm font-semibold tracking-wide text-gray-900 uppercase">Actions</h4>
                  {showAuditAction ? (
                    <p className="mt-1 text-xs text-gray-600 leading-relaxed">
                      NetRate, vendor JSON, commissions math, and full reconciliation → <strong>Audit</strong>.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {canRetry ? (
                    <button
                      type="button"
                      onClick={() => setRetryOpen(true)}
                      className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-amber-300 text-sm font-medium text-amber-800 bg-white shadow-sm hover:bg-amber-50"
                    >
                      <RefreshCw className="h-4 w-4 mr-2 shrink-0" />
                      Retry payment
                    </button>
                  ) : null}
                  {canRefund ? (
                    <button
                      type="button"
                      onClick={() => {
                        onRequestRefund(billingRow);
                        onClose();
                      }}
                      className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-red-300 text-sm font-medium text-red-800 bg-white shadow-sm hover:bg-red-50"
                    >
                      <RotateCcw className="h-4 w-4 mr-2 shrink-0" />
                      Issue refund
                    </button>
                  ) : null}
                  {showAuditAction && onOpenAudit ? (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenAudit(billingRow);
                        onClose();
                      }}
                      className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-blue-300 text-sm font-medium text-blue-800 bg-white shadow-sm hover:bg-blue-50"
                    >
                      <Receipt className="h-4 w-4 mr-2 shrink-0" />
                      Open audit
                    </button>
                  ) : null}
                </div>
                {deletePayment ? (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    {deletePayment.showConfirm ? (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                        <p className="text-sm font-semibold text-red-900">Delete this payment permanently?</p>
                        <p className="text-sm text-red-800 mt-2 leading-relaxed">
                          <strong>Not recommended.</strong> Deleting a payment row is almost never the right fix—prefer
                          updating status after reconciliation, issuing a refund, or using{' '}
                          {showAuditAction ? (
                            <>
                              <strong>Audit</strong>
                            </>
                          ) : (
                            'audit/support tools'
                          )}{' '}
                          unless you fully understand ledger and commission impact.
                        </p>
                        <p className="text-sm text-red-800 mt-2 leading-relaxed">
                          This removes the payment record from our database only. It does not refund the payer or change
                          anything at the payment processor.
                        </p>
                        <p className="text-sm text-red-800 mt-2 leading-relaxed">
                          This cannot be undone. Deletion may fail if commissions or other records reference this payment.
                        </p>
                        <div className="flex flex-wrap gap-2 mt-3">
                          <button
                            type="button"
                            onClick={() => deletePayment.onCancelConfirm()}
                            disabled={deletePayment.deleting}
                            className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void deletePayment.onConfirmDelete()}
                            disabled={deletePayment.deleting}
                            className="inline-flex items-center px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
                          >
                            {deletePayment.deleting ? (
                              <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Deleting…
                              </>
                            ) : (
                              <>
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete permanently
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => deletePayment.onRequestDelete()}
                        disabled={!!deletePayment.disabled || deletePayment.deleting}
                        className="inline-flex items-center justify-center w-full sm:w-auto px-4 py-2.5 rounded-lg border border-red-300 text-sm font-medium text-red-800 bg-white shadow-sm hover:bg-red-50 disabled:opacity-50 disabled:pointer-events-none"
                      >
                        <Trash2 className="h-4 w-4 mr-2 shrink-0" />
                        Delete payment…
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}

            {footerExtras ? <div className="mt-6 pt-4 border-t border-gray-100">{footerExtras}</div> : null}

            <div className="mt-6 flex justify-end border-t border-gray-200 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>

      <AdminPaymentRetryModal
        payment={billingRow}
        open={retryOpen}
        onClose={() => setRetryOpen(false)}
        onRetrySuccess={() => {
          setRetryOpen(false);
          onRetrySuccess();
          onClose();
        }}
      />
    </>
  );
};
