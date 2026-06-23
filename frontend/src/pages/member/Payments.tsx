import {
    AlertCircle,
    Calendar,
    CheckCircle,
    ChevronDown,
    ChevronUp,
    Clock,
    CreditCard,
    DollarSign,
    ExternalLink,
    FileText,
    History,
    Loader2,
    Receipt,
    RefreshCw,
    X
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { useMemberContributions } from '../../hooks/member/useMemberContributions';
import { useMemberPaymentMethods } from '../../hooks/member/useMemberPaymentMethods';
import { useMemberPayments } from '../../hooks/useMemberPayments';
import { useMemberInvoices } from '../../hooks/useInvoices';
import { invoicesService, type Invoice } from '../../services/invoices.service';
import { openPaymentReceiptPdfInNewTab } from '../../services/paymentReceipt.service';
import MakePaymentNowModal from './components/MakePaymentNowModal';
import MemberPaymentMethodsSection from './components/MemberPaymentMethodsSection';
import { isSuccessfulPaymentRecordStatus } from '../../constants/paymentStatus';

function parseCalendarDate(dateStr: string): Date {
    const [y, m, d] = dateStr.split('T')[0].split('-');
    return new Date(Number(y), Number(m) - 1, Number(d));
}

interface Payment {
    PaymentId: string;
    InvoiceId?: string;
    Amount: number;
    PaymentDate: string;
    Status: string;
    PaymentMethod: string;
    TransactionType?: string;
    EnrollmentId: string;
    NextBillingDate?: string;
    ProcessorTransactionId?: string;
    FailureReason?: string;
    ACHReturnCode?: string;
    ACHReturnReason?: string;
    ChargebackReason?: string;
    OriginalPaymentId?: string;
    PaymentMethodType?: string;
    CardLast4?: string;
    CardBrand?: string;
    AccountNumberLast4?: string;
    AccountType?: string;
    ProductName?: string;
}

interface InvoiceRow {
    id: string;
    date: string;
    sortDate: number;
    description: string;
    amount: number;
    displayStatus: string;
    invoice: Invoice;
    linkedPayments: Payment[];
}

const isFailedStatus = (status?: string) => {
    const s = status?.toLowerCase();
    return s === 'failed' || s === 'declined' || s === 'returned' || s === 'chargeback';
};

/** Matches admin underpaid invoicing — use canonical Status, not derived displayStatus. */
const isPayableMemberInvoice = (inv: Invoice): boolean => {
    const status = String(inv?.Status || '').toLowerCase();
    const balance = Number(inv?.BalanceDue) || 0;
    return balance > 0.005 && (status === 'partial' || status === 'overdue' || status === 'unpaid');
};

const Payments: React.FC = () => {
    const queryClient = useQueryClient();
    const { data: payments, isLoading: paymentsLoading, error: paymentsError, refetch: refetchPayments } = useMemberPayments();
    const contributions = useMemberContributions();
    const {
        data: invoices = [],
        isLoading: invoicesLoading,
        isError: invoicesIsError,
        error: invoicesFetchError,
        refetch: refetchInvoices,
    } = useMemberInvoices();
    const { data: paymentMethods = [], isLoading: paymentMethodsLoading } = useMemberPaymentMethods();
    const [expandedRow, setExpandedRow] = useState<string | null>(null);
    const [detailPayment, setDetailPayment] = useState<Payment | null>(null);
    const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
    const [receiptPdfLoadingId, setReceiptPdfLoadingId] = useState<string | null>(null);
    const [showMakePaymentModal, setShowMakePaymentModal] = useState(false);

    const handleViewInvoicePdf = async (invoiceId: string) => {
        setPdfLoadingId(invoiceId);
        try {
            await invoicesService.openIndividualInvoicePdfInNewTab(invoiceId);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not open invoice PDF');
        } finally {
            setPdfLoadingId(null);
        }
    };

    const handleOpenPaymentReceiptPdf = async (paymentId: string) => {
        setReceiptPdfLoadingId(paymentId);
        try {
            await openPaymentReceiptPdfInNewTab(paymentId);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not open payment receipt');
        } finally {
            setReceiptPdfLoadingId(null);
        }
    };

    const invoiceRows = useMemo<InvoiceRow[]>(() => {
        const paymentsByInvoice = new Map<string, Payment[]>();
        (payments || []).forEach((p: Payment) => {
            if (!p.InvoiceId) return;
            const list = paymentsByInvoice.get(p.InvoiceId) || [];
            list.push(p);
            paymentsByInvoice.set(p.InvoiceId, list);
        });

        const rows = (invoices as Invoice[]).map<InvoiceRow>((inv) => {
            const linked = (paymentsByInvoice.get(inv.InvoiceId) || [])
                .slice()
                .sort((a, b) => new Date(b.PaymentDate).getTime() - new Date(a.PaymentDate).getTime());

            // Derive display status: if the invoice is not fully paid and the most
            // recent linked payment attempt failed, surface "Failed" to the member.
            const invoiceStatusLower = inv.Status?.toLowerCase();
            const isPaid = invoiceStatusLower === 'paid';
            const latestAttempt = linked[0];
            let displayStatus: string = inv.Status;
            if (!isPaid && latestAttempt && isFailedStatus(latestAttempt.Status)) {
                displayStatus = 'Failed';
            }

            return {
                id: `inv-${inv.InvoiceId}`,
                date: inv.BillingPeriodStart,
                sortDate: parseCalendarDate(inv.BillingPeriodStart).getTime(),
                description: inv.InvoiceNumber,
                amount: inv.TotalAmount,
                displayStatus,
                invoice: inv,
                linkedPayments: linked,
            };
        });

        rows.sort((a, b) => b.sortDate - a.sortDate);
        return rows;
    }, [payments, invoices]);

    const getStatusBadge = (status: string) => {
        const lower = status?.toLowerCase();
        let color = 'bg-gray-100 text-gray-800';
        let icon = <Clock className="h-3.5 w-3.5" />;

        if (['paid', 'completed', 'approval', 'success', 'succeeded'].includes(lower)) {
            color = 'bg-green-100 text-green-800';
            icon = <CheckCircle className="h-3.5 w-3.5" />;
        } else if (['pending', 'processing', 'unpaid'].includes(lower)) {
            color = 'bg-yellow-100 text-yellow-800';
            icon = <Clock className="h-3.5 w-3.5" />;
        } else if (['failed', 'declined', 'overdue'].includes(lower)) {
            color = 'bg-red-100 text-red-800';
            icon = <AlertCircle className="h-3.5 w-3.5" />;
        } else if (lower === 'partial') {
            color = 'bg-orange-100 text-orange-800';
            icon = <Clock className="h-3.5 w-3.5" />;
        } else if (lower === 'cancelled') {
            color = 'bg-gray-100 text-gray-500';
            icon = <X className="h-3.5 w-3.5" />;
        }

        const displayStatus = ['approval', 'success', 'succeeded'].includes(lower) ? 'Completed' : status;

        return (
            <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full ${color}`}>
                {icon}
                {displayStatus}
            </span>
        );
    };

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
    };

    const formatDate = (dateString: string) => {
        const d = parseCalendarDate(dateString);
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    };

    const formatPaymentMethod = (payment: Payment) => {
        if (payment.PaymentMethodType === 'Card' && payment.CardLast4) {
            return `${payment.CardBrand || 'Card'} ****${payment.CardLast4}`;
        }
        if (payment.PaymentMethodType === 'ACH' && payment.AccountNumberLast4) {
            return `${payment.AccountType || 'Bank'} ****${payment.AccountNumberLast4}`;
        }
        if (payment.PaymentMethod) {
            return payment.PaymentMethod.replace('dime', 'Card').replace('_', ' ');
        }
        return 'N/A';
    };

    const getNextBillingDate = () => {
        // Use actual NextBillingDate from payment records or enrollments
        if (payments?.length) {
            const latestWithDate = [...payments]
                .sort((a: Payment, b: Payment) => new Date(b.PaymentDate).getTime() - new Date(a.PaymentDate).getTime())
                .find((p: Payment) => p.NextBillingDate);
            if (latestWithDate?.NextBillingDate) {
                return parseCalendarDate(latestWithDate.NextBillingDate);
            }
        }
        if (contributions.enrollments?.length) {
            const enrollmentWithDate = contributions.enrollments.find((e) => e.NextBillingDate);
            if (enrollmentWithDate?.NextBillingDate) {
                return parseCalendarDate(enrollmentWithDate.NextBillingDate);
            }
        }
        return null;
    };

    const failedPayments = useMemo(() => {
        if (!payments?.length) return [];
        return payments.filter((p: Payment) =>
            p.Status?.toLowerCase() === 'failed' ||
            p.Status?.toLowerCase() === 'declined'
        );
    }, [payments]);

    const payableInvoices = useMemo(() => {
        return (invoices as Invoice[]).filter(isPayableMemberInvoice);
    }, [invoices]);

    const hasPayableInvoices = payableInvoices.length > 0;

    const hasActivePaymentMethod = useMemo(() => {
        return paymentMethods.some((pm) => pm.status?.toLowerCase() === 'active');
    }, [paymentMethods]);

    const nextBillingDate = getNextBillingDate();
    const totalMonthlyPremium = contributions.yourContribution;
    const isLoading =
        paymentsLoading || contributions.isLoading || invoicesLoading || paymentMethodsLoading;

    useEffect(() => {
        if (showMakePaymentModal) {
            void refetchInvoices();
        }
    }, [showMakePaymentModal, refetchInvoices]);

    if (isLoading) {
        return (
            <div className="p-4 md:p-6">
                <div className="animate-pulse">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 mb-6 md:mb-8">
                        <div className="h-32 bg-gray-200 rounded-lg"></div>
                        <div className="h-32 bg-gray-200 rounded-lg"></div>
                        <div className="h-32 bg-gray-200 rounded-lg"></div>
                    </div>
                    <div className="h-64 bg-gray-200 rounded-lg"></div>
                </div>
            </div>
        );
    }

    if (paymentsError) {
        return (
            <div className="p-4 md:p-6">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 md:p-6 text-center">
                    <AlertCircle className="h-12 w-12 text-red-600 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-red-900 mb-2">Error Loading Payments</h3>
                    <p className="text-red-700 mb-4">{paymentsError.message}</p>
                    <button
                        onClick={() => refetchPayments()}
                        className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors"
                    >
                        <RefreshCw className="h-4 w-4 inline mr-2" />
                        Try Again
                    </button>
                </div>
            </div>
        );
    }

    if (invoicesIsError) {
        const msg =
            invoicesFetchError instanceof Error
                ? invoicesFetchError.message
                : 'Could not load invoices.';
        return (
            <div className="p-4 md:p-6">
                <MemberPaymentMethodsSection />
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 md:p-6 text-center max-w-2xl mx-auto">
                    <AlertCircle className="h-12 w-12 text-amber-600 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-amber-900 mb-2">Billing information unavailable</h3>
                    <p className="text-amber-800 mb-4">
                        {msg} If your household uses individual billing, invoices appear here once your account is active.
                        Contact support if this continues.
                    </p>
                    <button
                        type="button"
                        onClick={() => refetchInvoices()}
                        className="bg-amber-700 text-white px-4 py-2 rounded-lg hover:bg-amber-800 transition-colors"
                    >
                        <RefreshCw className="h-4 w-4 inline mr-2" />
                        Try again
                    </button>
                </div>
            </div>
        );
    }

    const toggleRow = (id: string) => {
        setExpandedRow(expandedRow === id ? null : id);
    };

    return (
        <div className="p-4 md:p-6">
            {/* Payment Methods */}
            <MemberPaymentMethodsSection />

            {/* Failed Payment Alerts */}
            {failedPayments.length > 0 && (
                <div className="mb-4 md:mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-center">
                        <AlertCircle className="h-5 w-5 text-red-600 mr-3" />
                        <div>
                            <h3 className="text-sm font-medium text-red-900">
                                {failedPayments.length} Failed Payment{failedPayments.length > 1 ? 's' : ''}
                            </h3>
                            <p className="text-sm text-red-700">
                                Please update your payment method to avoid service interruption.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-6 mb-6 md:mb-8">
                <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-6">
                    <div className="flex items-center">
                        <DollarSign className="h-8 w-8 text-oe-primary mr-3 flex-shrink-0" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-600">Monthly Premium</p>
                            <p className="text-xl md:text-2xl font-semibold text-gray-900 truncate">{formatCurrency(totalMonthlyPremium)}</p>
                        </div>
                    </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-6">
                    <div className="flex items-center">
                        <Calendar className="h-8 w-8 text-green-600 mr-3 flex-shrink-0" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-600">Next Billing Date</p>
                            <p className="text-xl md:text-2xl font-semibold text-gray-900 truncate">
                                {nextBillingDate ? nextBillingDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A'}
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Unified billing table */}
            <div className="bg-white rounded-lg border border-gray-200">
                <div className="p-4 md:p-6 border-b border-gray-200">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                        <h2 className="text-lg font-medium text-gray-900">Invoices</h2>
                        <div className="flex flex-wrap items-center gap-2 justify-end w-full sm:w-auto">
                            {hasPayableInvoices && (
                                <button
                                    type="button"
                                    onClick={() => setShowMakePaymentModal(true)}
                                    className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors text-sm font-medium min-h-11 order-first sm:order-none"
                                >
                                    Make payment now
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    void refetchPayments();
                                    void refetchInvoices();
                                }}
                                className="text-oe-primary hover:text-oe-dark text-sm font-medium min-h-11 flex items-center"
                            >
                            <RefreshCw className="h-4 w-4 inline mr-1" />
                            Refresh
                        </button>
                        </div>
                    </div>
                    {hasPayableInvoices && !hasActivePaymentMethod && (
                        <p className="text-sm text-amber-800 mt-3">
                            Add an active payment method in the section above to pay your balance.
                        </p>
                    )}
                </div>

                {/* Mobile card list */}
                <div className="md:hidden divide-y divide-gray-200">
                    {invoiceRows.length > 0 ? (
                        invoiceRows.map((row) => (
                            <div key={row.id} className="p-4">
                                <button
                                    type="button"
                                    className="w-full flex items-start justify-between gap-3 text-left"
                                    onClick={() => toggleRow(row.id)}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                                            <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
                                            <span>{formatDate(row.date)}</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-sm font-medium text-gray-900">
                                            <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                                            <span className="break-all">{row.description}</span>
                                        </div>
                                        {row.linkedPayments.length > 0 && (
                                            <p className="text-xs text-gray-500 mt-1">
                                                {row.linkedPayments.length} payment{row.linkedPayments.length !== 1 ? 's' : ''}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                className="text-gray-600 hover:text-oe-primary p-1 rounded disabled:opacity-50"
                                                title="View / print invoice"
                                                disabled={pdfLoadingId === row.invoice.InvoiceId}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleViewInvoicePdf(row.invoice.InvoiceId);
                                                }}
                                            >
                                                {pdfLoadingId === row.invoice.InvoiceId ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <ExternalLink className="h-4 w-4" />
                                                )}
                                            </button>
                                            <span className="text-sm font-semibold text-gray-900">{formatCurrency(row.amount)}</span>
                                        </div>
                                        {getStatusBadge(row.displayStatus)}
                                        {expandedRow === row.id
                                            ? <ChevronUp className="h-4 w-4 text-gray-400" />
                                            : <ChevronDown className="h-4 w-4 text-gray-400" />}
                                    </div>
                                </button>

                                {expandedRow === row.id && (
                                    <div className="mt-3 pt-3 border-t border-gray-100 space-y-4">
                                        <div>
                                            <h4 className="text-xs font-semibold text-gray-700 uppercase mb-2">Invoice Details</h4>
                                            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                                                <div>
                                                    <dt className="text-gray-500 text-xs">Invoice #</dt>
                                                    <dd className="font-medium text-gray-900 break-all">{row.invoice.InvoiceNumber}</dd>
                                                </div>
                                                <div>
                                                    <dt className="text-gray-500 text-xs">Due Date</dt>
                                                    <dd className="font-medium text-gray-900">{formatDate(row.invoice.DueDate)}</dd>
                                                </div>
                                                <div className="col-span-2">
                                                    <dt className="text-gray-500 text-xs">Billing Period</dt>
                                                    <dd className="font-medium text-gray-900">
                                                        {formatDate(row.invoice.BillingPeriodStart)} – {formatDate(row.invoice.BillingPeriodEnd)}
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt className="text-gray-500 text-xs">Balance Due</dt>
                                                    <dd className="font-medium text-gray-900">{formatCurrency(row.invoice.BalanceDue)}</dd>
                                                </div>
                                            </dl>
                                        </div>

                                        {row.linkedPayments.length > 0 ? (
                                            <div>
                                                <h4 className="text-xs font-semibold text-gray-700 uppercase mb-2">Payments</h4>
                                                <div className="space-y-2">
                                                    {row.linkedPayments.map((pmt) => {
                                                        const failureMessage =
                                                            pmt.FailureReason ||
                                                            (pmt.ACHReturnCode ? `${pmt.ACHReturnCode} — ${pmt.ACHReturnReason || 'ACH return'}` : null) ||
                                                            pmt.ChargebackReason ||
                                                            null;
                                                        return (
                                                            <div
                                                                key={pmt.PaymentId}
                                                                className="w-full text-left bg-gray-50 rounded-lg border border-gray-200 p-3 cursor-pointer hover:border-gray-300"
                                                                onClick={() => setDetailPayment(pmt)}
                                                            >
                                                                <div className="flex items-center justify-between gap-2">
                                                                    <div className="flex items-center gap-2 min-w-0">
                                                                        <CreditCard className="h-4 w-4 text-gray-400 flex-shrink-0" />
                                                                        <div className="min-w-0">
                                                                            <p className="text-sm font-medium text-gray-900">{formatDate(pmt.PaymentDate)}</p>
                                                                            <p className="text-xs text-gray-500 truncate">{formatPaymentMethod(pmt)}</p>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex flex-row items-center gap-2 flex-shrink-0">
                                                                        <div className="flex flex-col items-end gap-1">
                                                                            <span className="text-sm font-medium text-gray-900">{formatCurrency(pmt.Amount)}</span>
                                                                            {getStatusBadge(pmt.Status)}
                                                                        </div>
                                                                        {isSuccessfulPaymentRecordStatus(pmt.Status) && (
                                                                            <button
                                                                                type="button"
                                                                                title="View payment receipt"
                                                                                className="text-gray-600 hover:text-gray-900 p-1 rounded-md hover:bg-gray-200 disabled:opacity-50"
                                                                                disabled={receiptPdfLoadingId === pmt.PaymentId}
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    void handleOpenPaymentReceiptPdf(pmt.PaymentId);
                                                                                }}
                                                                            >
                                                                                {receiptPdfLoadingId === pmt.PaymentId ? (
                                                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                                                ) : (
                                                                                    <Receipt className="h-4 w-4" />
                                                                                )}
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                {isFailedStatus(pmt.Status) && failureMessage && (
                                                                    <div className="mt-2 bg-red-50 border border-red-200 rounded p-2">
                                                                        <p className="text-xs text-red-700 break-words">{failureMessage}</p>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        ) : (
                                            <p className="text-sm text-gray-500 italic">No payments recorded.</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))
                    ) : (
                        <div className="px-4 py-12 text-center text-gray-500">
                            <History className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                            <p className="text-base font-medium">No invoices found</p>
                            <p className="text-sm">Your invoices will appear here once billing begins.</p>
                        </div>
                    )}
                </div>

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-8"></th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Billing Period</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-24">Invoice PDF</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {invoiceRows.length > 0 ? (
                                invoiceRows.map((row) => (
                                    <React.Fragment key={row.id}>
                                        <tr
                                            className="hover:bg-gray-50 cursor-pointer"
                                            onClick={() => toggleRow(row.id)}
                                        >
                                            <td className="px-6 py-4 text-gray-400">
                                                {expandedRow === row.id
                                                    ? <ChevronUp className="h-4 w-4" />
                                                    : <ChevronDown className="h-4 w-4" />}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                                {formatDate(row.date)}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 max-w-xs">
                                                <div className="flex items-center gap-2">
                                                    <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                                                    <span className="break-words">{row.description}</span>
                                                    {row.linkedPayments.length > 0 && (
                                                        <span className="text-xs text-gray-500">
                                                            ({row.linkedPayments.length} payment{row.linkedPayments.length !== 1 ? 's' : ''})
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                                {formatCurrency(row.amount)}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                {getStatusBadge(row.displayStatus)}
                                            </td>
                                            <td
                                                className="px-6 py-4 whitespace-nowrap text-center"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <button
                                                    type="button"
                                                    className="text-gray-600 hover:text-oe-primary inline-flex items-center justify-center disabled:opacity-50"
                                                    title="View / print invoice"
                                                    disabled={pdfLoadingId === row.invoice.InvoiceId}
                                                    onClick={() => handleViewInvoicePdf(row.invoice.InvoiceId)}
                                                >
                                                    {pdfLoadingId === row.invoice.InvoiceId ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <ExternalLink className="h-4 w-4" />
                                                    )}
                                                </button>
                                            </td>
                                        </tr>

                                        {/* Expanded Detail */}
                                        {expandedRow === row.id && (
                                            <tr>
                                                <td colSpan={6} className="px-6 py-0">
                                                    <div className="py-4 bg-gray-50 -mx-6 px-6 border-t border-gray-100">
                                                        <div className="space-y-4">
                                                            {/* Invoice Details */}
                                                            <div>
                                                                <h4 className="text-sm font-medium text-gray-700 mb-2">Invoice Details</h4>
                                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                                                    <div>
                                                                        <span className="text-gray-500">Invoice #</span>
                                                                        <p className="font-medium text-gray-900">{row.invoice.InvoiceNumber}</p>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500">Billing Period</span>
                                                                        <p className="font-medium text-gray-900">
                                                                            {formatDate(row.invoice.BillingPeriodStart)} – {formatDate(row.invoice.BillingPeriodEnd)}
                                                                        </p>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500">Due Date</span>
                                                                        <p className="font-medium text-gray-900">{formatDate(row.invoice.DueDate)}</p>
                                                                    </div>
                                                                    <div>
                                                                        <span className="text-gray-500">Balance Due</span>
                                                                        <p className="font-medium text-gray-900">{formatCurrency(row.invoice.BalanceDue)}</p>
                                                                    </div>
                                                                </div>
                                                            </div>

                                                            {/* Linked Payments */}
                                                            {row.linkedPayments.length > 0 ? (
                                                                <div>
                                                                    <h4 className="text-sm font-medium text-gray-700 mb-2">Payments</h4>
                                                                    <div className="space-y-2">
                                                                        {row.linkedPayments.map((pmt) => {
                                                                            const failureMessage =
                                                                                pmt.FailureReason ||
                                                                                (pmt.ACHReturnCode ? `${pmt.ACHReturnCode} — ${pmt.ACHReturnReason || 'ACH return'}` : null) ||
                                                                                pmt.ChargebackReason ||
                                                                                null;
                                                                            return (
                                                                                <div
                                                                                    key={pmt.PaymentId}
                                                                                    className="bg-white rounded-lg border border-gray-200 p-3 cursor-pointer hover:border-gray-300"
                                                                                    onClick={(e) => { e.stopPropagation(); setDetailPayment(pmt); }}
                                                                                >
                                                                                    <div className="flex items-center justify-between">
                                                                                        <div className="flex items-center gap-3">
                                                                                            <CreditCard className="h-4 w-4 text-gray-400" />
                                                                                            <div>
                                                                                                <p className="text-sm font-medium text-gray-900">{formatDate(pmt.PaymentDate)}</p>
                                                                                                <p className="text-xs text-gray-500">{formatPaymentMethod(pmt)}</p>
                                                                                            </div>
                                                                                        </div>
                                                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                                                        <span className="text-sm font-medium text-gray-900">{formatCurrency(pmt.Amount)}</span>
                                                                                        {getStatusBadge(pmt.Status)}
                                                                                        {isSuccessfulPaymentRecordStatus(pmt.Status) && (
                                                                                            <button
                                                                                                type="button"
                                                                                                title="View payment receipt"
                                                                                                className="text-gray-600 hover:text-gray-900 p-1 rounded-md hover:bg-gray-100 disabled:opacity-50"
                                                                                                disabled={receiptPdfLoadingId === pmt.PaymentId}
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    void handleOpenPaymentReceiptPdf(pmt.PaymentId);
                                                                                                }}
                                                                                            >
                                                                                                {receiptPdfLoadingId === pmt.PaymentId ? (
                                                                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                                                                ) : (
                                                                                                    <Receipt className="h-4 w-4" />
                                                                                                )}
                                                                                            </button>
                                                                                        )}
                                                                                    </div>
                                                                                    </div>
                                                                                    {isFailedStatus(pmt.Status) && failureMessage && (
                                                                                        <div className="mt-2 bg-red-50 border border-red-200 rounded p-2">
                                                                                            <p className="text-xs text-red-700">{failureMessage}</p>
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <p className="text-sm text-gray-500 italic">No payments recorded for this invoice.</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                                        <History className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                                        <p className="text-lg font-medium">No invoices found</p>
                                        <p className="text-sm">Your invoices will appear here once billing begins.</p>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <MakePaymentNowModal
                open={showMakePaymentModal}
                onClose={() => setShowMakePaymentModal(false)}
                payableInvoices={payableInvoices}
                hasActivePaymentMethod={hasActivePaymentMethod}
                onSuccess={() => {
                    setExpandedRow(null);
                    void refetchPayments();
                    void queryClient.invalidateQueries({ queryKey: ['member-invoices'] });
                    void queryClient.invalidateQueries({ queryKey: ['memberPayments'] });
                }}
            />

            {/* Payment Detail Modal */}
            {detailPayment && (
                <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50 p-4" onClick={() => setDetailPayment(null)}>
                    <div className="relative mt-8 md:mt-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white" onClick={(e) => e.stopPropagation()}>
                        <div className="mt-3">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-medium text-gray-900">Payment Details</h3>
                                <button
                                    onClick={() => setDetailPayment(null)}
                                    className="text-gray-400 hover:text-gray-600"
                                >
                                    <X className="h-6 w-6" />
                                </button>
                            </div>

                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700">Payment Date</label>
                                    <p className="text-sm text-gray-900">{formatDate(detailPayment.PaymentDate)}</p>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700">Amount</label>
                                    <p className="text-sm text-gray-900">{formatCurrency(detailPayment.Amount)}</p>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700">Status</label>
                                    {getStatusBadge(detailPayment.Status)}
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700">Payment Method</label>
                                    <p className="text-sm text-gray-900">{formatPaymentMethod(detailPayment)}</p>
                                </div>
                                {detailPayment.ProductName && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700">Product</label>
                                        <p className="text-sm text-gray-900">{detailPayment.ProductName}</p>
                                    </div>
                                )}
                                {detailPayment.ProcessorTransactionId && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700">Transaction ID</label>
                                        <p className="text-sm text-gray-900 font-mono">{detailPayment.ProcessorTransactionId}</p>
                                    </div>
                                )}
                                {detailPayment.FailureReason && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700">Failure Reason</label>
                                        <p className="text-sm text-red-600">{detailPayment.FailureReason}</p>
                                    </div>
                                )}
                                {detailPayment.ACHReturnCode && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700">ACH Return</label>
                                        <p className="text-sm text-red-600">{detailPayment.ACHReturnCode} — {detailPayment.ACHReturnReason}</p>
                                    </div>
                                )}
                                {detailPayment.ChargebackReason && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700">Chargeback Reason</label>
                                        <p className="text-sm text-red-600">{detailPayment.ChargebackReason}</p>
                                    </div>
                                )}
                            </div>

                            <div className="mt-6 flex justify-end">
                                <button
                                    onClick={() => setDetailPayment(null)}
                                    className="bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700 transition-colors"
                                >
                                    Close
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Payments;
