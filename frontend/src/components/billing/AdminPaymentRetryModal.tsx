/**
 * Retry a failed payment (group or household context) — shared by Tenant Billing and member admin payment sheets.
 */

import { Calendar, FileText, Info } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
  accountingService,
  type ChargeNowRetrySelectablePeriod,
  type PaymentRetryRequestBody,
  type PaymentRetryOptionsResponse
} from '../../services/AccountingService';
import type { BillingPaymentRow } from '../../services/billing.service';

function formatUsd(n: number): string {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

function fmtPeriod(start: string | null | undefined, end: string | null | undefined): string {
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

function fmtMonthLabel(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function computeRemaining(inv: {
  totalAmount: number;
  paidAmount: number;
  creditAmount?: number;
  balanceDue?: number;
}): number {
  if (Number.isFinite(inv.balanceDue)) return Math.max(Number(inv.balanceDue) || 0, 0);
  const total = Number(inv.totalAmount) || 0;
  const paid = Number(inv.paidAmount) || 0;
  const credit = Number(inv.creditAmount) || 0;
  return Math.max(total - paid - credit, 0);
}

function isoBoundary(d: string | Date): string {
  if (typeof d === 'string') return d.includes('T') ? d : `${d}T12:00:00.000Z`;
  return d.toISOString();
}

export interface AdminPaymentRetryModalProps {
  payment: BillingPaymentRow | null;
  open: boolean;
  onClose: () => void;
  /** After a successful retry (Close on success pane). */
  onRetrySuccess: () => void;
}

export const AdminPaymentRetryModal: React.FC<AdminPaymentRetryModalProps> = ({
  payment,
  open,
  onClose,
  onRetrySuccess
}) => {
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<'success' | 'error' | null>(null);
  const [retryResultMessage, setRetryResultMessage] = useState('');
  const [retryOptions, setRetryOptions] = useState<PaymentRetryOptionsResponse | null>(null);
  const [retryOptionsLoading, setRetryOptionsLoading] = useState(false);
  const [retrySelectedPaymentMethodId, setRetrySelectedPaymentMethodId] = useState<string | null>(null);
  const [selectedPeriodIdx, setSelectedPeriodIdx] = useState(0);

  useEffect(() => {
    if (!open || !payment) {
      setRetryResult(null);
      setRetryResultMessage('');
      setRetryOptions(null);
      setRetrySelectedPaymentMethodId(null);
      setRetrying(false);
      setSelectedPeriodIdx(0);
      return;
    }
    setRetryResult(null);
    setRetryResultMessage('');
    setRetryOptionsLoading(true);
    setRetrySelectedPaymentMethodId(null);
    accountingService
      .getRetryOptions(payment.paymentId)
      .then((opts) => {
        setRetryOptions(opts);
        const defaultPm =
          opts.paymentMethods?.find((pm) => pm.isDefault) ?? opts.paymentMethods?.[0] ?? null;
        setRetrySelectedPaymentMethodId(defaultPm?.paymentMethodId ?? null);

        const preview = opts.chargeNowPreview;
        const periods = preview?.selectablePeriods || [];
        if (periods.length === 0) {
          setSelectedPeriodIdx(0);
          return;
        }
        let defaultIdx = periods.length > 1 ? 1 : 0;
        if (preview?.nextInvoice) {
          const matchIdx = periods.findIndex(
            (p: ChargeNowRetrySelectablePeriod) =>
              p.existingInvoice?.invoiceId === preview!.nextInvoice!.invoiceId
          );
          if (matchIdx >= 0) defaultIdx = matchIdx;
        }
        setSelectedPeriodIdx(defaultIdx);
      })
      .catch(() =>
        setRetryOptions({
          success: true,
          context: 'group',
          paymentMethods: []
        })
      )
      .finally(() => setRetryOptionsLoading(false));
  }, [open, payment?.paymentId]);

  const preview = retryOptions?.chargeNowPreview ?? null;

  const selectedPeriod = useMemo(() => {
    if (!preview?.selectablePeriods?.length) return null;
    return preview.selectablePeriods[selectedPeriodIdx] ?? preview.selectablePeriods[0];
  }, [preview, selectedPeriodIdx]);

  const handleBackdropClose = () => {
    if (!retrying && retryResult === null) onClose();
  };

  if (!open || !payment) return null;

  const showPeriodPicker =
    retryOptions?.context === 'household' &&
    !!(preview?.selectablePeriods && preview.selectablePeriods.length > 0);

  const linked = retryOptions?.linkedInvoice;
  const rowLinkedSummary =
    payment.linkedInvoiceNumber || payment.linkedInvoiceBillingPeriodStart
      ? `${payment.linkedInvoiceNumber ? `#${payment.linkedInvoiceNumber}` : 'Invoice'}${payment.linkedInvoiceBillingPeriodStart ? ` (${fmtPeriod(payment.linkedInvoiceBillingPeriodStart, payment.linkedInvoiceBillingPeriodEnd)})` : ''}${payment.linkedInvoiceStatus ? ` · ${payment.linkedInvoiceStatus}` : ''}`
      : payment.invoiceId
        ? `(ID ${String(payment.invoiceId).slice(0, 8)}…) — open billing for number`
        : null;

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={handleBackdropClose} />
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h3 className="text-lg font-semibold text-gray-900">
            {retryResult === null
              ? 'Retry failed payment'
              : retryResult === 'success'
                ? 'Retry successful'
                : 'Retry failed'}
          </h3>
          {retryResult === null ? (
            <>
              <p className="mt-2 text-sm text-gray-600">
                Retry this failed payment of {formatUsd(payment.amount)}
                {(payment.memberName || payment.groupName) && (
                  <> for {payment.groupName || payment.memberName}</>
                )}
                ?
              </p>
              {rowLinkedSummary ? (
                <p className="mt-2 text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
                  <span className="font-medium text-gray-700">Current link: </span>
                  {rowLinkedSummary}
                </p>
              ) : linked ? (
                <p className="mt-2 text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
                  <span className="font-medium text-gray-700">Current link: </span>
                  {linked.invoiceNumber
                    ? `#${linked.invoiceNumber}${linked.billingPeriodStart ? ` (${fmtPeriod(linked.billingPeriodStart, linked.billingPeriodEnd)})` : ''}`
                    : linked.invoiceId}
                  {linked.status ? ` · ${linked.status}` : ''}
                </p>
              ) : retryOptions?.context === 'household' ? (
                <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
                  Not linked to an invoice yet. Pick the billing period below so the retry attaches to the right invoice when
                  the charge completes.
                </p>
              ) : null}

              {showPeriodPicker ? (
                <div className="mt-4 space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                      <Calendar className="h-4 w-4 text-gray-400" />
                      Billing period (invoice target)
                    </label>
                    <select
                      value={selectedPeriodIdx}
                      onChange={(e) => setSelectedPeriodIdx(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm text-gray-900 bg-white"
                    >
                      {preview!.selectablePeriods!.map((p, i) => (
                        <option key={i} value={i}>
                          {fmtMonthLabel(p.billingPeriodStart)} ({fmtPeriod(p.billingPeriodStart, p.billingPeriodEnd)})
                          {p.existingInvoice ? ` — ${p.existingInvoice.status}` : ' — New invoice'}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedPeriod ? (
                    <div
                      className={`rounded-lg border p-3 text-sm ${
                        selectedPeriod.existingInvoice
                          ? 'bg-blue-50 border-blue-200'
                          : 'bg-gray-50 border-gray-200'
                      }`}
                    >
                      {selectedPeriod.existingInvoice ? (
                        <div className="flex items-start gap-2">
                          <FileText className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
                          <div>
                            <p className="font-medium text-blue-900">
                              Invoice #{selectedPeriod.existingInvoice.invoiceNumber}
                            </p>
                            <p className="text-blue-700 mt-0.5">
                              Total: {formatUsd(selectedPeriod.existingInvoice.totalAmount)}
                              {' · Paid: '}
                              {formatUsd(selectedPeriod.existingInvoice.paidAmount)}
                              {(selectedPeriod.existingInvoice.creditAmount || 0) >= 0.005 && (
                                <>
                                  {' · Credit: '}
                                  {formatUsd(selectedPeriod.existingInvoice.creditAmount || 0)}
                                </>
                              )}
                              {' · Remaining: '}
                              {formatUsd(computeRemaining(selectedPeriod.existingInvoice))}
                            </p>
                            <p className="text-blue-600 text-xs mt-1">
                              Status: {selectedPeriod.existingInvoice.status}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2">
                          <Info className="h-4 w-4 text-gray-500 mt-0.5 flex-shrink-0" />
                          <div>
                            <p className="font-medium text-gray-800">Invoice may be created for this period</p>
                            <p className="text-gray-600 mt-0.5">
                              Period: {fmtPeriod(selectedPeriod.billingPeriodStart, selectedPeriod.billingPeriodEnd)}
                              {' · Estimated: '}
                              {formatUsd(selectedPeriod.estimatedAmount)}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {retryOptionsLoading ? (
                <p className="mt-2 text-sm text-gray-500">Loading payment methods…</p>
              ) : retryOptions?.paymentMethods?.length ? (
                <div className="mt-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Charge with</label>
                  <select
                    value={retrySelectedPaymentMethodId ?? ''}
                    onChange={(e) => setRetrySelectedPaymentMethodId(e.target.value || null)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm text-gray-900 bg-white"
                  >
                    {retryOptions.paymentMethods.map((pm) => (
                      <option key={pm.paymentMethodId} value={pm.paymentMethodId}>
                        {pm.label}
                        {pm.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : retryOptions && !retryOptionsLoading ? (
                <p className="mt-2 text-sm text-amber-600">No payment methods on file.</p>
              ) : null}
            </>
          ) : (
            <div
              className={`mt-3 p-3 rounded-lg text-sm ${
                retryResult === 'success'
                  ? 'bg-green-50 border border-green-200 text-green-800'
                  : 'bg-red-50 border border-red-200 text-red-800'
              }`}
            >
              {retryResultMessage}
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            {retryResult === null ? (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                  disabled={retrying}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setRetrying(true);
                    setRetryResult(null);
                    try {
                      const periodBody: Partial<{
                        billingPeriodStart: string;
                        billingPeriodEnd: string;
                      }> = {};
                      if (
                        retryOptions?.context === 'household' &&
                        showPeriodPicker &&
                        selectedPeriod?.billingPeriodStart &&
                        selectedPeriod?.billingPeriodEnd
                      ) {
                        periodBody.billingPeriodStart = isoBoundary(selectedPeriod.billingPeriodStart);
                        periodBody.billingPeriodEnd = isoBoundary(selectedPeriod.billingPeriodEnd);
                      }

                      const body: PaymentRetryRequestBody =
                        retryOptions?.context === 'group' && retrySelectedPaymentMethodId
                          ? { groupPaymentMethodId: retrySelectedPaymentMethodId, ...periodBody }
                          : retryOptions?.context === 'household' && retrySelectedPaymentMethodId
                            ? { memberPaymentMethodId: retrySelectedPaymentMethodId, ...periodBody }
                            : Object.keys(periodBody).length
                              ? periodBody
                              : undefined;
                      const result = await accountingService.retryPayment(payment.paymentId, body);
                      if (result.success) {
                        setRetryResult('success');
                        setRetryResultMessage(
                          result.message || 'Payment retry successful. The payment has been charged.'
                        );
                      } else {
                        setRetryResult('error');
                        setRetryResultMessage(result.message || 'Retry failed.');
                      }
                    } catch (e) {
                      setRetryResult('error');
                      const msg: string =
                        (e &&
                        typeof e === 'object' &&
                        'message' in e &&
                        typeof (e as { message?: string }).message === 'string'
                          ? (e as { message: string }).message
                          : null) ||
                        (e instanceof Error ? e.message : 'Failed to retry payment.');
                      setRetryResultMessage(msg || 'Failed to retry payment.');
                    } finally {
                      setRetrying(false);
                    }
                  }}
                  className="px-4 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                  disabled={
                    retrying ||
                    !retrySelectedPaymentMethodId ||
                    (retryOptions?.context === 'household' && showPeriodPicker && !selectedPeriod)
                  }
                >
                  {retrying ? 'Retrying…' : 'Retry payment'}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setRetryResult(null);
                  setRetryResultMessage('');
                  if (retryResult === 'success') onRetrySuccess();
                }}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
              >
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
