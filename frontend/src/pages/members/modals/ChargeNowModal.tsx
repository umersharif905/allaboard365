// File: frontend/src/pages/members/modals/ChargeNowModal.tsx
import { AlertCircle, Calendar, CreditCard, DollarSign, FileText, Info, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { getManualChargeToastMessage } from '../../../constants/paymentMessages';
import { apiService } from '../../../services/api.service';

interface ExistingInvoice {
    invoiceId: string;
    invoiceNumber: string;
    totalAmount: number;
    paidAmount: number;
    creditAmount?: number;
    balanceDue?: number;
    status: string;
}

interface SelectablePeriod {
    billingPeriodStart: string;
    billingPeriodEnd: string;
    estimatedAmount: number;
    existingInvoice: ExistingInvoice | null;
}

interface NextInvoice extends ExistingInvoice {
    billingPeriodStart: string;
    billingPeriodEnd: string;
}

interface NextPeriod {
    billingPeriodStart: string;
    billingPeriodEnd: string;
    estimatedAmount: number;
}

interface PreviewData {
    defaultAmount: number;
    nextInvoice: NextInvoice | null;
    nextPeriod: NextPeriod | null;
    selectablePeriods: SelectablePeriod[];
}

interface ChargeResult {
    paymentId: string;
    amount: number;
    transactionId: string;
    paymentRecordStatus?: string;
    invoice?: {
        invoiceId: string;
        invoiceNumber: string | null;
        billingPeriodStart: string | null;
        billingPeriodEnd: string | null;
        created: boolean;
    } | null;
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

// Remaining balance after Paid + Credit. Prefer the persisted BalanceDue from
// the API; fall back to recomputing from parts when older payloads omit it.
function computeRemaining(inv: ExistingInvoice): number {
    if (Number.isFinite(inv.balanceDue)) return Math.max(Number(inv.balanceDue) || 0, 0);
    const total = Number(inv.totalAmount) || 0;
    const paid = Number(inv.paidAmount) || 0;
    const credit = Number(inv.creditAmount) || 0;
    return Math.max(total - paid - credit, 0);
}

interface Props {
    memberId: string;
    /** When set, auto-select the billing period for this invoice after preview loads. */
    preselectedInvoiceId?: string | null;
    onSuccess?: () => void;
    onClose: () => void;
}

const ChargeNowModal: React.FC<Props> = ({ memberId, preselectedInvoiceId, onSuccess, onClose }) => {
    const [amount, setAmount] = useState<string>('');
    const [loadingPreview, setLoadingPreview] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<PreviewData | null>(null);
    const [selectedPeriodIdx, setSelectedPeriodIdx] = useState<number>(0);

    useEffect(() => {
        let cancelled = false;
        setLoadingPreview(true);
        setError(null);
        apiService
            .get<{ success: boolean; data?: PreviewData }>(`/api/members/${memberId}/charge-now-preview`)
            .then((res) => {
                if (cancelled) return;
                if (res.success && res.data) {
                    setPreview(res.data);
                    const periods = res.data.selectablePeriods || [];

                    // Auto-select the period matching the unpaid invoice, or the middle (current) period
                    let defaultIdx = periods.length > 1 ? 1 : 0;
                    const targetInvoiceId = preselectedInvoiceId || res.data.nextInvoice?.invoiceId;
                    if (targetInvoiceId) {
                        const matchIdx = periods.findIndex(
                            (p) => p.existingInvoice?.invoiceId === targetInvoiceId
                        );
                        if (matchIdx >= 0) defaultIdx = matchIdx;
                    }
                    setSelectedPeriodIdx(defaultIdx);

                    const selectedPeriod = periods[defaultIdx];
                    if (selectedPeriod?.existingInvoice) {
                        setAmount(String(computeRemaining(selectedPeriod.existingInvoice).toFixed(2)));
                    } else if (selectedPeriod?.estimatedAmount) {
                        setAmount(String(selectedPeriod.estimatedAmount.toFixed(2)));
                    } else if (res.data.defaultAmount) {
                        setAmount(String(res.data.defaultAmount.toFixed(2)));
                    }
                } else {
                    setPreview(null);
                    setAmount('');
                }
            })
            .catch((e) => {
                if (cancelled) return;
                const msg = (e as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message || (e as Error).message;
                setError(msg || 'Failed to load preview');
                setPreview(null);
            })
            .finally(() => {
                if (!cancelled) setLoadingPreview(false);
            });
        return () => { cancelled = true; };
    }, [memberId, preselectedInvoiceId]);

    const selectedPeriod = useMemo(() => {
        if (!preview?.selectablePeriods?.length) return null;
        return preview.selectablePeriods[selectedPeriodIdx] || null;
    }, [preview, selectedPeriodIdx]);

    const amountNum = useMemo(() => {
        const n = parseFloat(amount);
        return Number.isFinite(n) ? n : NaN;
    }, [amount]);

    /** How much of this charge would apply to the selected invoice vs already covered (paid + credit). */
    const overInvoiceRemaining = useMemo(() => {
        const inv = selectedPeriod?.existingInvoice;
        if (!inv) return null;
        const remaining = computeRemaining(inv);
        if (!Number.isFinite(amountNum) || amountNum <= 0) return null;
        const over = amountNum - remaining;
        if (over <= 0.005) return null;
        return { remaining, over };
    }, [selectedPeriod, amountNum]);

    const handlePeriodChange = (idx: number) => {
        setSelectedPeriodIdx(idx);
        const period = preview?.selectablePeriods?.[idx];
        if (!period) return;
        if (period.existingInvoice) {
            setAmount(String(computeRemaining(period.existingInvoice).toFixed(2)));
        } else {
            setAmount(String(period.estimatedAmount.toFixed(2)));
        }
    };

    const handleSubmit = async () => {
        const parsed = parseFloat(amount);
        if (isNaN(parsed) || parsed <= 0) {
            toast.error('Enter a valid amount greater than 0.');
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const body: Record<string, unknown> = { amount: parsed };
            if (selectedPeriod) {
                body.billingPeriodStart = selectedPeriod.billingPeriodStart;
                body.billingPeriodEnd = selectedPeriod.billingPeriodEnd;
            }

            const res = await apiService.post<{ success: boolean; message?: string; data?: ChargeResult }>(
                `/api/members/${memberId}/charge-now`,
                body
            );
            if (res.success) {
                const inv = res.data?.invoice;
                const invLabel = inv?.invoiceNumber
                    ? ` — Invoice #${inv.invoiceNumber} (${fmtPeriod(inv.billingPeriodStart, inv.billingPeriodEnd)}) ${inv.created ? 'created' : 'updated'}`
                    : '';
                const { message, severity } = getManualChargeToastMessage({
                    paymentRecordStatus: res.data?.paymentRecordStatus,
                    settledMessage: `Charged $${parsed.toFixed(2)} successfully${invLabel}`,
                });
                toast.success(message, { duration: severity === 'info' ? 10000 : 4000 });
                onSuccess?.();
                onClose();
            } else {
                const msg = (res as { message?: string })?.message || 'Charge failed.';
                setError(msg);
                toast.error(msg);
            }
        } catch (e) {
            const err = e as {
                response?: { data?: { message?: string; error?: { code?: string } } };
                message?: string;
            };
            const data = err?.response?.data;
            const msg =
                data?.message ||
                err?.message ||
                'Charge failed.';
            setError(msg);
            if (data?.error?.code === 'DIME_TOKEN_NO_LOCAL_PAN') {
                toast.error(msg, { duration: 8000 });
            } else {
                toast.error(msg);
            }
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="fixed inset-0 z-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !submitting && onClose()} />
            <div className="relative z-10 flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                            <DollarSign className="h-5 w-5 text-oe-primary" />
                            Charge Now
                        </h3>
                        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" disabled={submitting}>
                            <X className="h-6 w-6" />
                        </button>
                    </div>
                    <p className="text-sm text-gray-600 mb-4">
                        Charge this member&apos;s default payment method. Select the billing period this charge covers.
                    </p>

                    {error && (
                        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-4 flex items-start gap-3">
                            <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm font-medium text-red-800">Error</p>
                                <p className="text-sm text-red-700 mt-1">{error}</p>
                            </div>
                            <button type="button" onClick={() => setError(null)} className="ml-auto text-red-500 hover:text-red-700">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    )}

                    {loadingPreview ? (
                        <div className="space-y-3">
                            <div className="h-10 bg-gray-100 rounded-lg animate-pulse" />
                            <div className="h-10 bg-gray-100 rounded-lg animate-pulse" />
                            <div className="h-16 bg-gray-100 rounded-lg animate-pulse" />
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* Billing Period Selector */}
                            {preview?.selectablePeriods && preview.selectablePeriods.length > 0 && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                                        <Calendar className="h-4 w-4 text-gray-400" />
                                        Billing Period
                                    </label>
                                    <select
                                        value={selectedPeriodIdx}
                                        onChange={(e) => handlePeriodChange(Number(e.target.value))}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                                        disabled={submitting}
                                    >
                                        {preview.selectablePeriods.map((p, i) => (
                                            <option key={i} value={i}>
                                                {fmtMonthLabel(p.billingPeriodStart)} ({fmtPeriod(p.billingPeriodStart, p.billingPeriodEnd)})
                                                {p.existingInvoice ? ` — ${p.existingInvoice.status}` : ' — New invoice'}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* Invoice Context Card */}
                            {selectedPeriod && (
                                <div className={`rounded-lg border p-3 text-sm ${
                                    selectedPeriod.existingInvoice
                                        ? 'bg-blue-50 border-blue-200'
                                        : 'bg-gray-50 border-gray-200'
                                }`}>
                                    {selectedPeriod.existingInvoice ? (
                                        <div className="flex items-start gap-2">
                                            <FileText className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
                                            <div>
                                                <p className="font-medium text-blue-900">
                                                    Invoice #{selectedPeriod.existingInvoice.invoiceNumber}
                                                </p>
                                                <p className="text-blue-700 mt-0.5">
                                                    Total: ${selectedPeriod.existingInvoice.totalAmount.toFixed(2)}
                                                    {' · '}Paid: ${selectedPeriod.existingInvoice.paidAmount.toFixed(2)}
                                                    {(selectedPeriod.existingInvoice.creditAmount || 0) >= 0.005 && (
                                                        <>{' · '}Credit: ${(selectedPeriod.existingInvoice.creditAmount || 0).toFixed(2)}</>
                                                    )}
                                                    {' · '}Remaining: ${computeRemaining(selectedPeriod.existingInvoice).toFixed(2)}
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
                                                <p className="font-medium text-gray-800">
                                                    New invoice will be created
                                                </p>
                                                <p className="text-gray-600 mt-0.5">
                                                    Period: {fmtPeriod(selectedPeriod.billingPeriodStart, selectedPeriod.billingPeriodEnd)}
                                                    {' · '}Estimated: ${selectedPeriod.estimatedAmount.toFixed(2)}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Amount */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Amount ($)</label>
                                <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    placeholder="0.00"
                                    disabled={submitting}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                />
                                {preview?.defaultAmount != null && preview.defaultAmount > 0 && (
                                    <p className="text-xs text-gray-500 mt-1">
                                        Total premium: ${preview.defaultAmount.toFixed(2)}
                                    </p>
                                )}
                                {overInvoiceRemaining && (
                                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                                        <p className="font-medium">Amount is above what this invoice still owes</p>
                                        <p className="mt-1 text-amber-800">
                                            Remaining on invoice: ${overInvoiceRemaining.remaining.toFixed(2)}. You are
                                            charging ${amountNum.toFixed(2)} — about $
                                            {overInvoiceRemaining.over.toFixed(2)} above that.
                                        </p>
                                        <p className="mt-1 text-amber-800">
                                            The processor will charge the full amount you enter; invoice PaidAmount caps
                                            at what is still owed today.
                                        </p>
                                        <p className="mt-1 text-amber-800">
                                            Nightly billing can turn a true overpayment into household credit only when
                                            this charge is <span className="font-medium">larger than the invoice total</span>
                                            {' '}(not just larger than what is left to pay). Credits are then applied to
                                            older open invoices in order. If you are only a little above the remaining
                                            balance but still under the full invoice amount, that path may not run.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="mt-6 flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={submitting}
                            className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={submitting || loadingPreview || !amount || parseFloat(amount) <= 0}
                            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
                        >
                            {submitting ? (
                                <>
                                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                    Charging…
                                </>
                            ) : (
                                <>
                                    <CreditCard className="h-4 w-4" />
                                    Charge ${amount ? parseFloat(amount).toFixed(2) : '0.00'}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ChargeNowModal;
