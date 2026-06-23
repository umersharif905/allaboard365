import { AlertCircle, CreditCard, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { getManualChargeToastMessage } from '../../../constants/paymentMessages';
import { invoicesService, type Invoice } from '../../../services/invoices.service';

function parseCalendarDate(dateStr: string): Date {
    const [y, m, d] = dateStr.split('T')[0].split('-');
    return new Date(Number(y), Number(m) - 1, Number(d));
}

function formatDate(dateString: string): string {
    const d = parseCalendarDate(dateString);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

interface Props {
    open: boolean;
    onClose: () => void;
    payableInvoices: Invoice[];
    hasActivePaymentMethod: boolean;
    onSuccess: () => void;
}

const MakePaymentNowModal: React.FC<Props> = ({
    open,
    onClose,
    payableInvoices,
    hasActivePaymentMethod,
    onSuccess,
}) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null);
        const firstId = payableInvoices[0]?.InvoiceId || '';
        setSelectedInvoiceId(firstId);
    }, [open, payableInvoices]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !submitting) onClose();
        };
        document.addEventListener('keydown', onKey);
        const t = window.setTimeout(() => {
            const el = panelRef.current?.querySelector<HTMLElement>(
                'select:not([disabled]), button:not([disabled])'
            );
            el?.focus();
        }, 0);
        return () => {
            document.removeEventListener('keydown', onKey);
            window.clearTimeout(t);
        };
    }, [open, submitting, onClose]);

    const selectedInvoice = useMemo(
        () => payableInvoices.find((i) => i.InvoiceId === selectedInvoiceId),
        [payableInvoices, selectedInvoiceId]
    );

    const scrollToPaymentMethods = () => {
        document.getElementById('payment-methods')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const handleSubmit = async () => {
        if (!selectedInvoiceId || !hasActivePaymentMethod) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await invoicesService.payMemberInvoiceBalance(selectedInvoiceId);
            if (res.success && res.data) {
                const amt = Number(res.data.amount);
                const st = res.data.paymentRecordStatus;
                const { message, severity } = getManualChargeToastMessage({
                    paymentRecordStatus: st,
                    settledMessage: `Payment of ${formatCurrency(amt)} was successful.`,
                });
                toast.success(message, { duration: severity === 'info' ? 10000 : 4000 });
                onSuccess();
                onClose();
            } else {
                const msg = res.message || 'Payment failed.';
                setError(msg);
                toast.error(msg);
            }
        } catch (e) {
            const err = e as {
                response?: { data?: { message?: string; error?: { code?: string } } };
                message?: string;
            };
            const data = err?.response?.data;
            const msg = data?.message || err?.message || 'Payment failed.';
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

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
            <div
                className="fixed inset-0 z-0 bg-gray-500 bg-opacity-75 transition-opacity"
                onClick={() => !submitting && onClose()}
                aria-hidden
            />
            <div className="relative z-10 flex min-h-full items-center justify-center p-4">
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="make-payment-now-title"
                    className="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center justify-between mb-4">
                        <h3 id="make-payment-now-title" className="text-lg font-semibold text-gray-900">
                            Make payment now
                        </h3>
                        <button
                            type="button"
                            onClick={onClose}
                            className="text-gray-400 hover:text-gray-600"
                            disabled={submitting}
                            aria-label="Close"
                        >
                            <X className="h-6 w-6" />
                        </button>
                    </div>
                    <p className="text-sm text-gray-600 mb-4">
                        Pay the balance due on a selected invoice using the{' '}
                        <span className="font-medium">default payment method on your primary household billing account</span>.
                        If you use a bank account (ACH), processing can take a few business days before your invoice updates.
                    </p>

                    {!hasActivePaymentMethod && (
                        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
                            Add an active payment method below, then return to complete payment.{' '}
                            <button
                                type="button"
                                className="underline font-medium text-oe-primary hover:text-oe-dark"
                                onClick={() => {
                                    scrollToPaymentMethods();
                                }}
                            >
                                Go to payment methods
                            </button>
                        </div>
                    )}

                    {error && (
                        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-4 flex items-start gap-3">
                            <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                            <p className="text-sm text-red-800">{error}</p>
                        </div>
                    )}

                    <div className="space-y-4">
                        <div>
                            <label htmlFor="pay-invoice-select" className="block text-sm font-medium text-gray-700 mb-1">
                                Invoice to pay
                            </label>
                            <select
                                id="pay-invoice-select"
                                value={selectedInvoiceId}
                                onChange={(e) => setSelectedInvoiceId(e.target.value)}
                                disabled={submitting}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                            >
                                {payableInvoices.map((inv) => (
                                    <option key={inv.InvoiceId} value={inv.InvoiceId}>
                                        {inv.InvoiceNumber} — {formatDate(inv.BillingPeriodStart)} –{' '}
                                        {formatDate(inv.BillingPeriodEnd)} — Balance{' '}
                                        {formatCurrency(Number(inv.BalanceDue) || 0)}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {selectedInvoice && (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                                <p className="font-medium text-gray-900">Amount to charge</p>
                                <p className="text-xl font-semibold text-gray-900 mt-1">
                                    {formatCurrency(Number(selectedInvoice.BalanceDue) || 0)}
                                </p>
                                <p className="text-xs text-gray-500 mt-2">
                                    This amount matches your invoice balance at the time you pay. Final charge is confirmed
                                    after processing.
                                </p>
                            </div>
                        )}
                        <p className="text-sm text-gray-600">
                            <button
                                type="button"
                                className="text-oe-primary hover:text-oe-dark font-medium underline"
                                onClick={() => scrollToPaymentMethods()}
                            >
                                Update payment method
                            </button>
                        </p>
                    </div>

                    <div className="mt-6 flex flex-wrap justify-end gap-3">
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
                            disabled={
                                submitting ||
                                !selectedInvoiceId ||
                                !hasActivePaymentMethod ||
                                payableInvoices.length === 0
                            }
                            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
                            aria-busy={submitting}
                        >
                            {submitting ? (
                                <>
                                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                    Processing…
                                </>
                            ) : (
                                <>
                                    <CreditCard className="h-4 w-4" />
                                    Pay now
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MakePaymentNowModal;
