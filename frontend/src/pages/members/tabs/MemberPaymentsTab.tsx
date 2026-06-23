// File: frontend/src/pages/members/tabs/MemberPaymentsTab.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Coins,
    Percent,
    AlertCircle,
    Building,
    CheckCircle,
    Clock,
    CreditCard,
    DollarSign,
    ExternalLink,
    Eye,
    FileText,
    Link2,
    Loader2,
    Pencil,
    Plus,
    Receipt,
    RefreshCw,
    Repeat,
    RotateCcw,
    Search,
    Star,
    Trash2,
    X
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import RefundPaymentModal from '../../../components/shared/RefundPaymentModal';
import { AdminPaymentDetailsModal } from '../../../components/billing/AdminPaymentDetailsModal';
import OutstandingInvoicePayPromptModal from '../../../components/billing/OutstandingInvoicePayPromptModal';
import InvoicePayoutDetailsModal, {
    type InvoicePayoutSection
} from '../../../components/billing/InvoicePayoutDetailsModal';
import { isSuccessfulPaymentRecordStatus } from '../../../constants/paymentStatus';
import { getStoredDimePaymentFailureUiHint } from '../../../constants/dimePaymentFailureHints';
import { apiService } from '../../../services/api.service';
import { formatChargeSourceAttribution, getPaymentMethodType, paymentMethodBadgeClasses } from '../../../services/billing.service';
import {
    MemberPaymentMethodsService,
    type OutstandingInvoicePrompt,
    type PaymentMethodRecurringSyncPayload,
} from '../../../services/member-payment-methods.service';
import { Member } from '../../../types/member.types';
import { useInvoices, useInvoicePayoutFlags } from '../../../hooks/useInvoices';
import { invoicesService, type Invoice, type InvoicePayoutFlags } from '../../../services/invoices.service';
import { useHouseholdCredits } from '../../../hooks/useHouseholdCredits';
import { householdCreditsService, type CreditEntry } from '../../../services/householdCredits.service';
import { openPaymentReceiptPdfInNewTab } from '../../../services/paymentReceipt.service';
import AddPaymentMethodModal from '../modals/AddPaymentMethodModal';
import AddManualCreditModal from '../modals/AddManualCreditModal';
import ChargeNowModal from '../modals/ChargeNowModal';
import MemberRecurringPaymentsTab from './MemberRecurringPaymentsTab';
import { useAuth } from '../../../contexts/AuthContext';
import { memberPaymentToBillingRow } from '../../../utils/memberPaymentBillingRow';
import { invoiceShowsPastDueCollectionBanner } from '../../../utils/helpers';

interface Payment {
    PaymentId: string;
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
    ProductName?: string;
    EnrollmentStatus?: string;
    AttemptNumber?: number;
    ConsecutiveFailureCount?: number;
    LastFailureDate?: string;
    PaymentMethodType?: string;
    CardLast4?: string;
    CardBrand?: string;
    AccountNumberLast4?: string;
    AccountType?: string;
    InvoiceId?: string;
    LocationId?: string;
    Processor?: string;
    RefundReason?: string;
    IsRefunded?: boolean;
    GroupId?: string;
    CreatedBy?: string | null;
    CreatedByName?: string | null;
    RecurringScheduleId?: string | null;
}

interface MemberPaymentMethodRow {
  paymentMethodId: string;
  paymentMethodType: 'ACH' | 'CreditCard' | 'DebitCard' | 'Card';
  isDefault: boolean;
  status: string;
  bankName?: string;
  accountType?: string;
  routingNumber?: string | null;
  accountNumberLast4?: string | null;
  accountHolderName?: string | null;
  cardBrand?: string;
  cardLast4?: string;
  cardholderName?: string | null;
  billingAddress?: string | null;
  billingAddress2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
  billingCountry?: string | null;
  expiryMonth?: number;
  expiryYear?: number;
  createdDate?: string;
  processorCustomerId?: string | null;
  processorPaymentMethodId?: string | null;
  modifiedDate?: string | null;
  modifiedByUserId?: string | null;
  modifiedByName?: string | null;
  modifiedByEmail?: string | null;
  lastUpdatedByActor?: 'member' | 'staff' | 'unknown';
}

interface Props {
  member: Member;
  showRecurringSection?: boolean;
  /** Add payment method for individual members (Agent, AgencyOwner, GroupAdmin, TenantAdmin, SysAdmin). Recurring charges/link are still showRecurringSection only. */
  canManagePaymentMethods?: boolean;
  /** Allow issuing manual goodwill credits (TenantAdmin / SysAdmin). */
  canManageCredits?: boolean;
  onRefresh?: () => void;
}

type PaymentsSubTab = 'history' | 'recurring' | 'invoices';

// Calendar-only dates (BillingPeriodStart/End, DueDate, InvoiceDate) come
// from the API as UTC midnight (e.g. "2026-04-01T00:00:00Z"). new Date(...)
// shifts these back a day in any TZ west of UTC, so the UI shows "3/31"
// instead of "4/1". Parse the YYYY-MM-DD parts directly so the stored
// calendar date renders the same in every timezone.
function formatCalendarDate(dateString: string | null | undefined): string {
    if (!dateString) return '—';
    try {
        const datePart = String(dateString).split('T')[0];
        const [yStr, mStr, dStr] = datePart.split('-');
        const y = Number(yStr);
        const m = Number(mStr);
        const d = Number(dStr);
        if (!y || !m || !d) return new Date(dateString).toLocaleDateString();
        return new Date(y, m - 1, d).toLocaleDateString();
    } catch (_e) {
        return String(dateString);
    }
}

/** Must match SETTABLE_PAYMENT_STATUSES in backend/routes/payments.js */
const EDITABLE_PAYMENT_STATUSES: { value: string; label: string }[] = [
    { value: 'Completed', label: 'Completed' },
    { value: 'Failed', label: 'Failed' },
    { value: 'Pending', label: 'Pending' },
    { value: 'Refunded', label: 'Refunded' },
    { value: 'Voided', label: 'Voided' },
    { value: 'Canceled', label: 'Canceled' },
    { value: 'Processing', label: 'Processing' },
    { value: 'Unknown', label: 'Unknown' },
    { value: 'APPROVAL', label: 'APPROVAL (legacy)' },
    { value: 'SUCCESS', label: 'SUCCESS (legacy)' },
    { value: 'COMPLETED', label: 'COMPLETED (legacy)' },
    { value: 'succeeded', label: 'succeeded (legacy)' },
    { value: 'Approved', label: 'Approved (legacy)' },
    { value: 'PAID', label: 'PAID (legacy)' },
    { value: 'Declined', label: 'Declined' }
];

function statusSelectOptions(currentStatus: string | undefined) {
    const cur = (currentStatus || '').trim();
    const values = new Set(EDITABLE_PAYMENT_STATUSES.map((o) => o.value));
    if (cur && !values.has(cur)) {
        return [{ value: cur, label: `${cur} (current)` }, ...EDITABLE_PAYMENT_STATUSES];
    }
    return EDITABLE_PAYMENT_STATUSES;
}

function entryTypeLabel(t: string) {
    switch (t) {
        case 'OverpaymentRecognized': return 'Overpayment recognized';
        case 'AppliedToInvoice': return 'Applied to invoice';
        case 'ReversedApplication': return 'Reversed (refund)';
        case 'ManualGoodwill': return 'Manual credit';
        case 'Voided': return 'Voided';
        default: return t;
    }
}

interface CreditPanelData {
    availableCredit: number;
    entryCount: number;
    byEntry: CreditEntry[];
}

function AccountCreditPanel({
    credit,
    loading,
    canManageCredits,
    onAddCredit,
    onAfterVoid,
    invoiceLookup
}: {
    credit?: CreditPanelData;
    loading?: boolean;
    canManageCredits?: boolean;
    onAddCredit?: () => void;
    onAfterVoid?: () => void;
    /** Map of InvoiceId -> { number, period } for resolving Applied To labels. */
    invoiceLookup?: Record<string, { number?: string | null; period?: string | null }>;
}) {
    const [showHistory, setShowHistory] = useState(false);
    const [confirmingVoidId, setConfirmingVoidId] = useState<string | null>(null);
    const [voidReason, setVoidReason] = useState<string>('');
    const [voidingId, setVoidingId] = useState<string | null>(null);

    /**
     * Roll the flat ledger up into one row per positive source entry.
     * Each source aggregates its AppliedToInvoice / Voided children:
     *   - applied: list of { invoiceId, amount } (positive magnitudes)
     *   - voidedAmount: sum of |Voided child Amount|
     *   - remaining = Amount + sum(child Amount) (children are negative)
     */
    const sourceRows = useMemo(() => {
        const entries = credit?.byEntry || [];
        const childrenBySource: Record<string, CreditEntry[]> = {};
        for (const e of entries) {
            if (e.RelatedEntryId && (e.EntryType === 'AppliedToInvoice' || e.EntryType === 'Voided')) {
                (childrenBySource[e.RelatedEntryId] ||= []).push(e);
            }
        }
        return entries
            .filter(e => Number(e.Amount) > 0)
            .map(src => {
                const children = childrenBySource[src.EntryId] || [];
                const applied = children
                    .filter(c => c.EntryType === 'AppliedToInvoice')
                    .map(c => ({ invoiceId: c.TargetInvoiceId || '', amount: Math.abs(Number(c.Amount) || 0), date: c.CreatedDate }));
                const voidedAmount = children
                    .filter(c => c.EntryType === 'Voided')
                    .reduce((s, c) => s + Math.abs(Number(c.Amount) || 0), 0);
                const remaining = Math.max(
                    0,
                    Math.round(((Number(src.Amount) || 0) + children.reduce((s, c) => s + Number(c.Amount), 0)) * 100) / 100
                );
                let status: 'available' | 'partial' | 'used' | 'voided' = 'available';
                if (voidedAmount > 0.005 && remaining < 0.005) status = 'voided';
                else if (remaining < 0.005) status = 'used';
                else if (applied.length > 0 || voidedAmount > 0.005) status = 'partial';
                return { src, applied, voidedAmount, remaining, status };
            });
    }, [credit?.byEntry]);

    const isVoidableType = (t: string) =>
        t === 'ManualGoodwill' || t === 'OverpaymentRecognized' || t === 'ReversedApplication';

    const statusBadge = (status: 'available' | 'partial' | 'used' | 'voided') => {
        const map: Record<string, string> = {
            available: 'bg-green-100 text-green-800',
            partial: 'bg-yellow-100 text-yellow-800',
            used: 'bg-gray-100 text-gray-700',
            voided: 'bg-red-100 text-red-800'
        };
        const label: Record<string, string> = {
            available: 'Available',
            partial: 'Partial',
            used: 'Fully applied',
            voided: 'Voided'
        };
        return (
            <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${map[status]}`}>
                {label[status]}
            </span>
        );
    };

    const invoiceLabel = (invoiceId: string) => {
        const meta = invoiceLookup?.[invoiceId];
        if (meta?.number) return `#${meta.number}`;
        return 'invoice';
    };

    const handleConfirmVoid = async (entryId: string) => {
        setVoidingId(entryId);
        try {
            await householdCreditsService.voidEntry(entryId, voidReason.trim() || undefined);
            toast.success('Credit voided');
            setConfirmingVoidId(null);
            setVoidReason('');
            onAfterVoid?.();
        } catch (e) {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            toast.error(err?.response?.data?.message || err?.message || 'Failed to void credit');
        } finally {
            setVoidingId(null);
        }
    };
    if (loading) return null;

    const available = Number(credit?.availableCredit || 0);
    const hasAvailable = Math.abs(available) >= 0.005;
    const hasHistory = sourceRows.length > 0;

    // Render the panel when there's an available balance OR history OR the
    // admin can issue a goodwill credit (so the button is reachable).
    if (!hasAvailable && !hasHistory && !canManageCredits) return null;

    return (
        <div className="bg-white rounded-lg border border-gray-200 mb-4">
            <div className="p-4 flex items-start justify-between">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-oe-light flex items-center justify-center">
                        <DollarSign className="h-5 w-5 text-oe-primary" />
                    </div>
                    <div>
                        <div className="text-sm text-gray-500">Account credit</div>
                        <div className="text-2xl font-semibold text-gray-900">
                            ${available.toFixed(2)}
                        </div>
                        <div className="text-xs text-gray-500">
                            {hasAvailable
                                ? 'Auto-applied to next unpaid invoice on the next nightly run.'
                                : (hasHistory
                                    ? 'No active balance — view history for past credit activity.'
                                    : 'No credit on file.')}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {canManageCredits && onAddCredit && (
                        <button
                            type="button"
                            onClick={onAddCredit}
                            className="text-sm font-medium text-oe-primary hover:text-oe-dark border border-oe-primary px-3 py-1.5 rounded-lg"
                        >
                            + Add credit
                        </button>
                    )}
                    {hasHistory && (
                        <button
                            type="button"
                            onClick={() => setShowHistory(s => !s)}
                            className="text-sm text-oe-primary hover:text-oe-dark"
                        >
                            {showHistory ? 'Hide history' : `Show history (${sourceRows.length})`}
                        </button>
                    )}
                </div>
            </div>
            {showHistory && sourceRows.length > 0 && (
                <div className="border-t border-gray-200 overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Remaining</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Applied to</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Notes</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                                {canManageCredits && (
                                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                                )}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {sourceRows.map(({ src, applied, voidedAmount, remaining, status }) => {
                                const canVoid = canManageCredits && isVoidableType(src.EntryType) && remaining > 0.005;
                                const isConfirming = confirmingVoidId === src.EntryId;
                                const colSpan = canManageCredits ? 8 : 7;
                                return (
                                    <React.Fragment key={src.EntryId}>
                                        <tr>
                                            <td className="px-4 py-2 text-sm text-gray-900">{entryTypeLabel(src.EntryType)}</td>
                                            <td className="px-4 py-2 text-sm text-right font-medium text-oe-success whitespace-nowrap">
                                                +${Number(src.Amount).toFixed(2)}
                                            </td>
                                            <td className="px-4 py-2 text-sm text-right text-gray-600 whitespace-nowrap">
                                                ${remaining.toFixed(2)}
                                            </td>
                                            <td className="px-4 py-2 text-sm">{statusBadge(status)}</td>
                                            <td className="px-4 py-2 text-sm text-gray-600">
                                                {applied.length === 0 && voidedAmount < 0.005 && (
                                                    <span className="text-gray-400">—</span>
                                                )}
                                                {applied.length > 0 && (
                                                    <ul className="space-y-0.5">
                                                        {applied.map((a, i) => (
                                                            <li key={i} className="whitespace-nowrap">
                                                                {invoiceLabel(a.invoiceId)}: <span className="font-medium">${a.amount.toFixed(2)}</span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                                {voidedAmount > 0.005 && (
                                                    <div className="text-xs text-red-700 mt-0.5 whitespace-nowrap">
                                                        Voided ${voidedAmount.toFixed(2)}
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-4 py-2 text-sm text-gray-600">{src.Notes || '—'}</td>
                                            <td className="px-4 py-2 text-sm text-gray-600 whitespace-nowrap">
                                                {src.CreatedDate ? new Date(src.CreatedDate).toLocaleDateString() : '—'}
                                            </td>
                                            {canManageCredits && (
                                                <td className="px-4 py-2 text-right text-sm">
                                                    {canVoid && !isConfirming && (
                                                        <button
                                                            type="button"
                                                            onClick={() => { setConfirmingVoidId(src.EntryId); setVoidReason(''); }}
                                                            className="text-red-600 hover:text-red-800 text-xs font-medium"
                                                        >
                                                            Void
                                                        </button>
                                                    )}
                                                </td>
                                            )}
                                        </tr>
                                        {isConfirming && canManageCredits && (
                                            <tr className="bg-red-50">
                                                <td colSpan={colSpan} className="px-4 py-3">
                                                    <div className="text-xs text-red-800 mb-2">
                                                        Voiding will remove the remaining <strong>${remaining.toFixed(2)}</strong> from this household's credit balance. Already-applied portions are preserved.
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="text"
                                                            value={voidReason}
                                                            onChange={(ev) => setVoidReason(ev.target.value)}
                                                            placeholder="Reason (optional)"
                                                            maxLength={500}
                                                            className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => handleConfirmVoid(src.EntryId)}
                                                            disabled={voidingId === src.EntryId}
                                                            className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 disabled:opacity-50"
                                                        >
                                                            {voidingId === src.EntryId ? 'Voiding…' : 'Confirm void'}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => { setConfirmingVoidId(null); setVoidReason(''); }}
                                                            disabled={voidingId === src.EntryId}
                                                            className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function UnderpaidInvoicesBanner({ invoices }: { invoices: Invoice[] }) {
    const underpaid = invoices.filter(inv => {
        const status = String(inv.Status || '').toLowerCase();
        const balance = Number(inv.BalanceDue) || 0;
        return balance > 0.005 && (status === 'partial' || status === 'overdue' || status === 'unpaid');
    });
    if (underpaid.length === 0) return null;

    // Past-due = Status Overdue OR due calendar date strictly before today (not UTC midnight vs wall clock).
    const pastDue = underpaid.filter(inv => invoiceShowsPastDueCollectionBanner(inv));
    const upcoming = underpaid.filter(inv => !pastDue.includes(inv));
    const pastDueTotal = pastDue.reduce((acc, inv) => acc + (Number(inv.BalanceDue) || 0), 0);
    const upcomingTotal = upcoming.reduce((acc, inv) => acc + (Number(inv.BalanceDue) || 0), 0);

    if (pastDue.length === 0) {
        return null;
    }

    return (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg p-3 mb-4 flex items-start gap-2">
            <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
            <div className="text-sm">
                <span className="font-semibold">${pastDueTotal.toFixed(2)} past-due</span> across {pastDue.length} invoice{pastDue.length === 1 ? '' : 's'} — not auto-charged, admin must collect manually.
                {upcoming.length > 0 && (
                    <span className="block text-xs mt-1 text-yellow-700">
                        Plus ${upcomingTotal.toFixed(2)} upcoming on {upcoming.length} invoice{upcoming.length === 1 ? '' : 's'} (will run on next recurring cycle).
                    </span>
                )}
            </div>
        </div>
    );
}

function InvoiceStatusBadge({ status }: { status: string }) {
    const styles: Record<string, string> = {
        Paid: 'bg-green-100 text-green-800',
        Overdue: 'bg-red-100 text-red-800',
        Partial: 'bg-orange-100 text-orange-800',
        Unpaid: 'bg-yellow-100 text-yellow-800',
        Cancelled: 'bg-gray-100 text-gray-600',
    };
    return (
        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
            {status}
        </span>
    );
}

function InvoicePayoutIndicators({
    flags,
    onSectionClick
}: {
    flags?: InvoicePayoutFlags;
    onSectionClick?: (section: InvoicePayoutSection) => void;
}) {
    if (!flags) return null;
    const { commissions, vendors, overrides } = flags;
    if (!commissions && !vendors && !overrides) {
        return (
            <span className="text-xs text-gray-400" title="No commission, vendor, or override payouts sent on NACHA for this invoice">
                —
            </span>
        );
    }
    const items: {
        key: InvoicePayoutSection;
        label: string;
        active: boolean;
        Icon: typeof Coins;
    }[] = [
        { key: 'commissions', label: 'Agent commissions paid on NACHA', active: commissions, Icon: Coins },
        { key: 'vendors', label: 'Vendor payouts sent on NACHA', active: vendors, Icon: Building },
        { key: 'overrides', label: 'Product override payouts sent on NACHA', active: overrides, Icon: Percent },
    ];
    return (
        <div className="flex items-center gap-1.5">
            {items.map(({ key, label, active, Icon }) => (
                active && onSectionClick ? (
                    <button
                        key={key}
                        type="button"
                        onClick={() => onSectionClick(key)}
                        title={`${label} — click for breakdown`}
                        className="inline-flex items-center justify-center rounded p-0.5 text-oe-success bg-green-50 hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-oe-primary/40"
                    >
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                        <span className="sr-only">{label}</span>
                    </button>
                ) : (
                    <span
                        key={key}
                        title={active ? label : `${label.replace(' paid', '').replace(' sent', '')} — not paid out`}
                        className={`inline-flex items-center justify-center rounded p-0.5 ${
                            active ? 'text-oe-success bg-green-50' : 'text-gray-300'
                        }`}
                    >
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                        <span className="sr-only">{label}</span>
                    </span>
                )
            ))}
        </div>
    );
}

function MemberInvoicesSubTab({
    householdId,
    canEdit = false,
    allowInvoiceDeletion = false,
    member,
    canManageCredits = false,
    showPayoutFlags = false
}: {
    householdId?: string;
    canEdit?: boolean;
    /** TenantAdmin / SysAdmin: allow deleting individual invoices with no linked payments. */
    allowInvoiceDeletion?: boolean;
    member?: Member;
    canManageCredits?: boolean;
    /** TenantAdmin / SysAdmin: show NACHA payout indicators per invoice. */
    showPayoutFlags?: boolean;
}) {
    const [showAddCreditModal, setShowAddCreditModal] = useState(false);
    const [statusFilter, setStatusFilter] = useState('');
    const { data, isLoading, refetch } = useInvoices(
        { householdId: householdId || undefined, type: 'Individual', status: statusFilter || undefined },
        !!householdId
    );
    const { data: payoutFlags = {} } = useInvoicePayoutFlags(
        householdId,
        showPayoutFlags && !!householdId
    );
    const credits = useHouseholdCredits(householdId || null);
    // Phase 1f: latest billing periods first; surface surplus paid amounts as +$X.
    const invoices: Invoice[] = (data?.invoices || []).slice().sort((a, b) => {
        const dateA = a.BillingPeriodStart || '';
        const dateB = b.BillingPeriodStart || '';
        return String(dateB).localeCompare(String(dateA));
    });

    const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
    const [editPaidAmount, setEditPaidAmount] = useState('');
    const [editStatus, setEditStatus] = useState('');
    const [editSaving, setEditSaving] = useState(false);
    const [invoiceResyncing, setInvoiceResyncing] = useState(false);
    const [invoiceDeleting, setInvoiceDeleting] = useState(false);
    const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
    const [payoutDetailsInvoice, setPayoutDetailsInvoice] = useState<Invoice | null>(null);
    const [payoutDetailsSection, setPayoutDetailsSection] = useState<InvoicePayoutSection | undefined>();

    const openPayoutDetails = (inv: Invoice, section: InvoicePayoutSection) => {
        setPayoutDetailsSection(section);
        setPayoutDetailsInvoice(inv);
    };

    const closePayoutDetails = () => {
        setPayoutDetailsInvoice(null);
        setPayoutDetailsSection(undefined);
    };

    const openEditModal = (inv: Invoice) => {
        setEditingInvoice(inv);
        setEditPaidAmount(String(Number(inv.PaidAmount).toFixed(2)));
        setEditStatus(inv.Status);
    };

    const handleEditSave = async () => {
        if (!editingInvoice) return;
        setEditSaving(true);
        try {
            const paidAmount = parseFloat(editPaidAmount);
            if (isNaN(paidAmount) || paidAmount < 0) {
                toast.error('Paid amount must be a valid non-negative number');
                setEditSaving(false);
                return;
            }
            await invoicesService.updateInvoice(editingInvoice.InvoiceId, { paidAmount, status: editStatus });
            toast.success('Invoice updated successfully');
            setEditingInvoice(null);
            refetch();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update invoice');
        } finally {
            setEditSaving(false);
        }
    };

    const markAsFulfilled = () => {
        if (!editingInvoice) return;
        setEditPaidAmount(String(Number(editingInvoice.TotalAmount).toFixed(2)));
        setEditStatus('Paid');
    };

    const handleInvoiceResyncOpenMaintenance = async () => {
        if (!editingInvoice || editingInvoice.InvoiceType !== 'Individual') return;
        setInvoiceResyncing(true);
        try {
            const res = await invoicesService.resyncInvoiceOpenMaintenance(editingInvoice.InvoiceId);
            if (!res.success) {
                toast.error(res.message || 'Invoice audit failed');
                return;
            }
            if (res.skipped) {
                toast(res.message || 'No changes applied for this invoice.', { icon: 'ℹ️' });
            } else {
                const d = res.data;
                const parts: string[] = [];
                if (d?.selfHeal?.linkedPayments) parts.push(`${d.selfHeal.linkedPayments} payment(s) linked`);
                if (d?.reconcile?.updated) parts.push('total recomputed');
                if (d?.enrollmentTotalsSync?.updated && d.enrollmentTotalsSync.newTotalAmount != null) {
                    const prev = d.enrollmentTotalsSync.previousTotalAmount;
                    parts.push(
                        typeof prev === 'number'
                            ? `totals aligned $${Number(prev).toFixed(2)} → $${Number(d.enrollmentTotalsSync.newTotalAmount).toFixed(2)}`
                            : `totals aligned to $${Number(d.enrollmentTotalsSync.newTotalAmount).toFixed(2)}`
                    );
                }
                if (d?.ledgerSync?.updated) parts.push('paid amount synced from payment ledger');
                if (d?.dimeRecurringSynced) parts.push('DIME recurring synced');
                if (d?.dimeSyncError) parts.push(`DIME sync note: ${d.dimeSyncError}`);
                toast.success(parts.length ? `Invoice audit: ${parts.join(' · ')}` : 'Invoice audit complete.');
            }
            const refreshed = await refetch();
            const invs = refreshed.data?.invoices;
            const next = invs?.find((i) => i.InvoiceId === editingInvoice.InvoiceId);
            if (next) {
                setEditingInvoice(next);
                setEditPaidAmount(String(Number(next.PaidAmount).toFixed(2)));
                setEditStatus(next.Status);
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Invoice audit failed');
        } finally {
            setInvoiceResyncing(false);
        }
    };

    const handleViewInvoicePdf = async (inv: Invoice) => {
        setPdfLoadingId(inv.InvoiceId);
        try {
            await invoicesService.openIndividualInvoicePdfInNewTab(inv.InvoiceId, {
                memberId: member?.MemberId,
            });
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not open invoice PDF');
        } finally {
            setPdfLoadingId(null);
        }
    };

    const handleDeleteInvoice = async () => {
        if (!editingInvoice || editingInvoice.InvoiceType !== 'Individual') return;
        const payCount = Number(editingInvoice.PaymentCount ?? 0);
        const paid = Number(editingInvoice.PaidAmount) || 0;
        if (payCount > 0 || paid > 0.005) return;
        if (
            !window.confirm(
                `Delete invoice ${editingInvoice.InvoiceNumber}? This cannot be undone.`
            )
        ) {
            return;
        }
        setInvoiceDeleting(true);
        try {
            await invoicesService.deleteInvoice(editingInvoice.InvoiceId);
            toast.success('Invoice deleted');
            setEditingInvoice(null);
            refetch();
            void credits.refetch();
        } catch (err: unknown) {
            const msg =
                err &&
                typeof err === 'object' &&
                'message' in err &&
                typeof (err as { message: unknown }).message === 'string'
                    ? (err as { message: string }).message
                    : 'Failed to delete invoice';
            toast.error(msg);
        } finally {
            setInvoiceDeleting(false);
        }
    };

    return (
        <div>
            <AccountCreditPanel
                credit={credits.data}
                loading={credits.isLoading}
                canManageCredits={canManageCredits && !!member?.HouseholdId && !!member?.TenantId}
                onAddCredit={() => setShowAddCreditModal(true)}
                onAfterVoid={() => credits.refetch()}
                invoiceLookup={Object.fromEntries(
                    invoices.map(inv => [
                        inv.InvoiceId,
                        { number: inv.InvoiceNumber || null, period: inv.BillingPeriodStart || null }
                    ])
                )}
            />

            <UnderpaidInvoicesBanner invoices={invoices} />

            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Invoices</h3>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:outline-none"
                >
                    <option value="">All Statuses</option>
                    <option value="NotPaid">Not Paid</option>
                    <option value="Unpaid">Unpaid</option>
                    <option value="Partial">Partial</option>
                    <option value="Paid">Paid</option>
                    <option value="Overdue">Overdue</option>
                    <option value="Cancelled">Cancelled</option>
                </select>
            </div>
            {isLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
            ) : invoices.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                    <FileText className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                    <p>No invoices found</p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Invoice #</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Paid</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Balance</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                                {showPayoutFlags && (
                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase" title="Commission, vendor, and override NACHA payouts">
                                        Payouts
                                    </th>
                                )}
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Due Date</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Invoice PDF</th>
                                {canEdit && <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Edit</th>}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {invoices.map((inv) => (
                                <tr key={inv.InvoiceId} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{inv.InvoiceNumber}</td>
                                    <td className="px-4 py-3 text-sm text-gray-600">
                                        {formatCalendarDate(inv.BillingPeriodStart)} – {formatCalendarDate(inv.BillingPeriodEnd)}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-900 text-right">${Number(inv.TotalAmount).toFixed(2)}</td>
                                    <td className="px-4 py-3 text-sm text-gray-900 text-right">
                                        ${Number(inv.PaidAmount).toFixed(2)}
                                        {Number((inv as Invoice & { CreditAmount?: number }).CreditAmount || 0) > 0 && (
                                            <span className="ml-1 text-xs text-oe-success" title="Covered by account credit">
                                                +${Number((inv as Invoice & { CreditAmount?: number }).CreditAmount || 0).toFixed(2)} credit
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-900 text-right">${Number(inv.BalanceDue).toFixed(2)}</td>
                                    <td className="px-4 py-3"><InvoiceStatusBadge status={inv.Status} /></td>
                                    {showPayoutFlags && (
                                        <td className="px-4 py-3">
                                            <InvoicePayoutIndicators
                                                flags={payoutFlags[inv.InvoiceId]}
                                                onSectionClick={(section) => openPayoutDetails(inv, section)}
                                            />
                                        </td>
                                    )}
                                    <td className="px-4 py-3 text-sm text-gray-600">{formatCalendarDate(inv.DueDate)}</td>
                                    <td className="px-4 py-3 text-right">
                                        <button
                                            type="button"
                                            onClick={() => handleViewInvoicePdf(inv)}
                                            disabled={pdfLoadingId === inv.InvoiceId}
                                            className="inline-flex items-center justify-center text-gray-600 hover:text-oe-primary disabled:opacity-50"
                                            title="View / print invoice"
                                        >
                                            {pdfLoadingId === inv.InvoiceId ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <ExternalLink className="h-4 w-4" />
                                            )}
                                        </button>
                                    </td>
                                    {canEdit && (
                                        <td className="px-4 py-3 text-right">
                                            <button
                                                type="button"
                                                onClick={() => openEditModal(inv)}
                                                className="text-gray-400 hover:text-gray-600"
                                                title="Invoice details / audit"
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </button>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Invoice details / edit (TenantAdmin & SysAdmin open via pencil) */}
            {editingInvoice && (
                <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[70]" onClick={() => setEditingInvoice(null)}>
                    <div className="relative top-20 mx-auto p-0 border w-[420px] shadow-lg rounded-lg bg-white" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between p-5 border-b border-gray-200">
                            <h3 className="text-lg font-medium text-gray-900">Invoice details</h3>
                            <button onClick={() => setEditingInvoice(null)} className="text-gray-400 hover:text-gray-600">
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Invoice</span>
                                    <span className="font-medium text-gray-900">{editingInvoice.InvoiceNumber}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Total Amount</span>
                                    <span className="font-medium text-gray-900">${Number(editingInvoice.TotalAmount).toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Current Paid</span>
                                    <span className="font-medium text-gray-900">${Number(editingInvoice.PaidAmount).toFixed(2)}</span>
                                </div>
                                {Number(editingInvoice.BalanceDue) > 0 && Number(editingInvoice.BalanceDue) < 1 && (
                                    <div className="flex justify-between text-yellow-700">
                                        <span>Remaining</span>
                                        <span className="font-medium">${Number(editingInvoice.BalanceDue).toFixed(2)} (likely rounding)</span>
                                    </div>
                                )}
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Paid Amount</label>
                                <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={editPaidAmount}
                                    onChange={(e) => setEditPaidAmount(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                                <select
                                    value={editStatus}
                                    onChange={(e) => setEditStatus(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:outline-none"
                                >
                                    <option value="Unpaid">Unpaid</option>
                                    <option value="Partial">Partial</option>
                                    <option value="Paid">Paid</option>
                                    <option value="Overdue">Overdue</option>
                                    <option value="Cancelled">Cancelled</option>
                                </select>
                            </div>

                            {editingInvoice.InvoiceType === 'Individual' && (
                                <>
                                    <button
                                        type="button"
                                        onClick={handleInvoiceResyncOpenMaintenance}
                                        disabled={invoiceResyncing || editSaving || invoiceDeleting}
                                        className="w-full text-sm font-medium py-2 px-3 border border-oe-primary rounded-lg text-oe-primary bg-white hover:bg-blue-50 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                                    >
                                        {invoiceResyncing ? (
                                            <RefreshCw className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Search className="h-4 w-4" />
                                        )}
                                        Audit invoice (sync from enrollments)
                                    </button>
                                    <p className="text-xs text-gray-500 -mt-2">
                                        <span className="font-medium text-gray-700">TenantAdmin / SysAdmin.</span> Open invoices:
                                        link orphan payments, recompute total + breakdown from enrollments, sync DIME when the total
                                        changes. Paid invoices: when paid amount already matches enrollments, align invoice total and
                                        JSON breakdown only (does not remove existing household credits).
                                    </p>
                                </>
                            )}

                            <button
                                type="button"
                                onClick={markAsFulfilled}
                                className="w-full text-sm text-oe-primary hover:text-oe-dark font-medium py-1.5 border border-dashed border-oe-primary rounded-lg hover:bg-blue-50 transition-colors"
                            >
                                <CheckCircle className="h-4 w-4 inline mr-1.5" />
                                Mark as Fully Paid
                            </button>

                            {allowInvoiceDeletion && editingInvoice.InvoiceType === 'Individual' && (
                                <>
                                    {(Number(editingInvoice.PaymentCount ?? 0) > 0 ||
                                        (Number(editingInvoice.PaidAmount) || 0) > 0.005) && (
                                        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5">
                                            {Number(editingInvoice.PaymentCount ?? 0) > 0
                                                ? 'This invoice has linked payments. Link them to a different invoice before it can be deleted.'
                                                : 'This invoice shows a paid balance; clear or move allocations before it can be deleted.'}
                                        </p>
                                    )}
                                </>
                            )}
                        </div>
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 p-5 border-t border-gray-200">
                            <div className="order-2 sm:order-1">
                                {allowInvoiceDeletion &&
                                    editingInvoice.InvoiceType === 'Individual' &&
                                    Number(editingInvoice.PaymentCount ?? 0) === 0 &&
                                    (Number(editingInvoice.PaidAmount) || 0) <= 0.005 && (
                                        <button
                                            type="button"
                                            onClick={handleDeleteInvoice}
                                            disabled={editSaving || invoiceResyncing || invoiceDeleting}
                                            className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-red-600 disabled:opacity-40 disabled:pointer-events-none"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            {invoiceDeleting ? 'Deleting…' : 'Delete invoice'}
                                        </button>
                                    )}
                            </div>
                            <div className="flex justify-end gap-3 order-1 sm:order-2">
                                <button
                                    onClick={() => setEditingInvoice(null)}
                                    disabled={invoiceDeleting}
                                    className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleEditSave}
                                    disabled={editSaving || invoiceResyncing || invoiceDeleting}
                                    className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50"
                                >
                                    {editSaving ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {showAddCreditModal && member?.HouseholdId && member?.TenantId && (
                <AddManualCreditModal
                    householdId={member.HouseholdId}
                    tenantId={member.TenantId}
                    memberName={[member.FirstName, member.LastName].filter(Boolean).join(' ') || undefined}
                    invoices={invoices}
                    onClose={() => setShowAddCreditModal(false)}
                    onSuccess={() => {
                        credits.refetch();
                        refetch();
                    }}
                />
            )}
            {payoutDetailsInvoice && (
                <InvoicePayoutDetailsModal
                    isOpen
                    onClose={closePayoutDetails}
                    invoiceId={payoutDetailsInvoice.InvoiceId}
                    invoiceNumber={payoutDetailsInvoice.InvoiceNumber}
                    initialSection={payoutDetailsSection}
                />
            )}
        </div>
    );
}

/** Native `title` tooltip for Replace vault (full guidance; no inline paragraph). */
const REPLACE_VAULT_AT_PROCESSOR_TITLE =
    'Use when DIME rejects the saved token (often code 23 — see payment failure hint below). Runs a fresh DIME vault from encrypted details on file. Afterwards confirm recurring billing still references this same payment method at DIME before retrying. Members may also edit payment methods in Account Settings.';

const MemberPaymentsTab: React.FC<Props> = ({ member, showRecurringSection, canManagePaymentMethods = false, canManageCredits = false, onRefresh }) => {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const isTenantBillingAdmin =
        user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';
    const [paymentDetailMode, setPaymentDetailMode] = useState<'legacy' | 'admin'>('legacy');
    const isIndividualMember = !member.GroupId;
    const [paymentsSubTab, setPaymentsSubTab] = useState<PaymentsSubTab>('history');
    const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
    const [receiptPdfLoadingId, setReceiptPdfLoadingId] = useState<string | null>(null);
    const [refundPayment, setRefundPayment] = useState<Payment | null>(null);
    const [showLinkDimeModal, setShowLinkDimeModal] = useState(false);
    const [dimeCustomerId, setDimeCustomerId] = useState('');
    const [dimePaymentMethodId, setDimePaymentMethodId] = useState('');
    const [linkingDime, setLinkingDime] = useState(false);
    const [showAddPaymentMethodModal, setShowAddPaymentMethodModal] = useState(false);
    const [showChargeNowModal, setShowChargeNowModal] = useState(false);
    const [chargeNowPreselectedInvoiceId, setChargeNowPreselectedInvoiceId] = useState<string | null>(null);
    const [outstandingInvoicePrompt, setOutstandingInvoicePrompt] = useState<OutstandingInvoicePrompt | null>(null);
    const [statusDraft, setStatusDraft] = useState('');
    const [savingStatus, setSavingStatus] = useState(false);
    const [updateInvoiceWhenChangingStatus, setUpdateInvoiceWhenChangingStatus] = useState(true);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deletingPayment, setDeletingPayment] = useState(false);
    const [invoiceLinkDraft, setInvoiceLinkDraft] = useState('');
    const [linkInvoiceSaving, setLinkInvoiceSaving] = useState(false);
    const [syncingPaymentMethodId, setSyncingPaymentMethodId] = useState<string | null>(null);
    // CVV prompt modal state — only kept in memory for the lifetime of the modal,
    // cleared on close / submit / unmount. PCI DSS 3.2.2: never persist CVV.
    const [cvvPromptPm, setCvvPromptPm] = useState<MemberPaymentMethodRow | null>(null);
    const [cvvPromptValue, setCvvPromptValue] = useState('');
    const [cvvPromptError, setCvvPromptError] = useState<string | null>(null);
    const [cvvPromptSubmitting, setCvvPromptSubmitting] = useState(false);
    /** Preserve replace-vault intent when POST returns CVV_REQUIRED (Payment methods). */
    const [cvvPromptForceReplace, setCvvPromptForceReplace] = useState(false);
    const [paymentMethodManagePm, setPaymentMethodManagePm] = useState<MemberPaymentMethodRow | null>(null);
    const [paymentMethodToEdit, setPaymentMethodToEdit] = useState<MemberPaymentMethodRow | null>(null);
    const [removingPaymentMethodId, setRemovingPaymentMethodId] = useState<string | null>(null);
    const [restoringPaymentMethodId, setRestoringPaymentMethodId] = useState<string | null>(null);
    const [showRemovedPaymentMethods, setShowRemovedPaymentMethods] = useState(true);

    // Fetch member payments - use admin endpoint when viewing another member
    const { data: payments, isLoading: paymentsLoading, error: paymentsError, refetch: refetchPayments } = useQuery({
        queryKey: ['memberPayments', member.MemberId],
        queryFn: async (): Promise<Payment[]> => {
            // Use the admin endpoint with memberId parameter
            const response = await apiService.get<{ success: boolean; data: Payment[]; message?: string }>(`/api/payments?memberId=${member.MemberId}`);
            
            if (!response.success) {
                throw new Error(response.message || 'Failed to fetch payments');
            }
            
            return response.data;
        },
        enabled: !!member.MemberId,
        staleTime: 5 * 60 * 1000,
    });

    const { data: linkInvoicesData, refetch: refetchLinkInvoices } = useInvoices(
        { householdId: member.HouseholdId || undefined, type: 'Individual' },
        !!member.HouseholdId && isTenantBillingAdmin && isIndividualMember
    );
    const linkInvoiceOptions: Invoice[] = useMemo(() => {
        const list = [...(linkInvoicesData?.invoices || [])];
        list.sort((a, b) => String(b.BillingPeriodStart || '').localeCompare(String(a.BillingPeriodStart || '')));
        return list;
    }, [linkInvoicesData?.invoices]);

    // Payment methods for individual (non-group) members only; also returns hasExistingDimeCustomerId for Link DIME modal warning
    const { data: paymentMethodsData, isLoading: paymentMethodsLoading, refetch: refetchPaymentMethods } = useQuery({
        queryKey: ['memberPaymentMethods', member.MemberId, 'includeRemoved'],
        queryFn: async (): Promise<{
            list: MemberPaymentMethodRow[];
            removed: MemberPaymentMethodRow[];
            hasExistingDimeCustomerId: boolean;
        }> => {
            const response = await MemberPaymentMethodsService.getPaymentMethodsForMember(member.MemberId, {
                includeRemoved: true
            });
            if (!response.success) {
                return { list: [], removed: [], hasExistingDimeCustomerId: false };
            }
            return {
                list: response.data || [],
                removed: response.removed || [],
                hasExistingDimeCustomerId: !!response.hasExistingDimeCustomerId
            };
        },
        enabled: !!member.MemberId && isIndividualMember,
        staleTime: 2 * 60 * 1000,
        refetchOnMount: 'always',
    });
    const paymentMethods = paymentMethodsData?.list ?? [];
    const removedPaymentMethods = paymentMethodsData?.removed ?? [];
    const hasExistingDimeCustomerId = paymentMethodsData?.hasExistingDimeCustomerId ?? false;
    const allPaymentMethodsForManage = useMemo(
        () => [...paymentMethods, ...removedPaymentMethods],
        [paymentMethods, removedPaymentMethods]
    );
    const resolvedPaymentMethodManage = useMemo(() => {
        if (!paymentMethodManagePm) return null;
        return (
            allPaymentMethodsForManage.find((p) => p.paymentMethodId === paymentMethodManagePm.paymentMethodId) ??
            paymentMethodManagePm
        );
    }, [paymentMethodManagePm, allPaymentMethodsForManage]);
    const isRemovedPaymentMethod = (pm: MemberPaymentMethodRow) =>
        String(pm.status || '').toLowerCase() === 'inactive';

    useEffect(() => {
        if (!selectedPayment) {
            setStatusDraft('');
            setShowDeleteConfirm(false);
            setPaymentDetailMode('legacy');
            setInvoiceLinkDraft('');
        } else {
            setStatusDraft(selectedPayment.Status || '');
            setUpdateInvoiceWhenChangingStatus(true);
            setInvoiceLinkDraft(selectedPayment.InvoiceId ? String(selectedPayment.InvoiceId) : '');
        }
    }, [selectedPayment]);

    const isPaymentGroupBilled = (payment: Payment | null) => {
        if (!payment?.GroupId) return false;
        return (
            String(payment.GroupId).replace(/-/g, '').toLowerCase() !== '00000000000000000000000000000000'
        );
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

    const normInvoiceId = (id: string | null | undefined) => {
        if (id == null || String(id).trim() === '') return null;
        return String(id).replace(/-/g, '').toLowerCase();
    };

    const linkInvoiceOptionsForSelect: Invoice[] = useMemo(() => {
        const base = linkInvoiceOptions;
        const cur = selectedPayment?.InvoiceId;
        if (!cur || String(cur).trim() === '') return base;
        if (base.some((inv) => normInvoiceId(inv.InvoiceId) === normInvoiceId(cur))) return base;
        return [
            {
                InvoiceId: String(cur),
                InvoiceNumber: '(current)',
                BillingPeriodStart: '',
                BillingPeriodEnd: '',
                Status: 'Unpaid',
                TotalAmount: 0,
                PaidAmount: 0,
                BalanceDue: 0,
                DueDate: '',
                CreatedDate: '',
                InvoiceType: 'Individual'
            } as Invoice,
            ...base
        ];
    }, [linkInvoiceOptions, selectedPayment?.InvoiceId]);

    const handleSaveInvoiceLink = async () => {
        if (!selectedPayment || !isTenantBillingAdmin || !isIndividualMember || !member.HouseholdId) return;
        if (isPaymentGroupBilled(selectedPayment)) {
            toast.error('Group-billed payments cannot be relinked here.');
            return;
        }
        const prevId = selectedPayment.InvoiceId ? String(selectedPayment.InvoiceId) : null;
        const targetRaw = invoiceLinkDraft.trim();
        const targetId = targetRaw === '' ? null : targetRaw;
        if (normInvoiceId(targetId) === normInvoiceId(prevId)) {
            toast('No change to invoice link.', { icon: 'ℹ️' });
            return;
        }
        if (
            targetId &&
            normInvoiceId(targetId) !== normInvoiceId(prevId) &&
            !linkInvoiceOptionsForSelect.some(
                (inv) => normInvoiceId(inv.InvoiceId) === normInvoiceId(targetId)
            )
        ) {
            toast.error('Choose an invoice from this household’s list.');
            return;
        }
        setLinkInvoiceSaving(true);
        try {
            const res = await invoicesService.linkPaymentToInvoice(selectedPayment.PaymentId, targetId);
            if (res.success && res.data) {
                if (res.data.warnings?.includes('commissions_exist_review_after_relink')) {
                    toast.success('Invoice link updated. Review commissions for this payment.');
                } else {
                    toast.success(
                        res.data.noOp ? 'Invoice link unchanged.' : 'Invoice link and balances updated.'
                    );
                }
                setSelectedPayment({
                    ...selectedPayment,
                    InvoiceId: targetId || undefined
                });
                await refetchPayments();
                await refetchLinkInvoices();
                void queryClient.invalidateQueries({ queryKey: ['invoices'] });
                onRefresh?.();
            } else {
                toast.error((res as { message?: string }).message || 'Failed to update invoice link');
            }
        } catch (e: unknown) {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            toast.error(err?.response?.data?.message || err?.message || 'Failed to update invoice link');
        } finally {
            setLinkInvoiceSaving(false);
        }
    };

    const handleSavePaymentStatus = async () => {
        if (!selectedPayment) return;
        const next = statusDraft.trim();
        if (!next || next === selectedPayment.Status) return;
        setSavingStatus(true);
        try {
            const res = await apiService.patch<{
                success: boolean;
                message?: string;
                invoiceSync?: {
                    applied?: boolean;
                    reason?: string;
                    warnings?: string[];
                    invoiceStatus?: string;
                    newPaidAmount?: number;
                };
            }>(`/api/payments/${encodeURIComponent(selectedPayment.PaymentId)}`, {
                status: next,
                updateInvoice: updateInvoiceWhenChangingStatus
            });
            if (res.success) {
                const inv = res.invoiceSync;
                if (inv?.warnings?.includes('commission_may_remain')) {
                    toast.success(
                        'Payment status updated — invoice adjusted. Commissions on this payment may still need manual review.'
                    );
                } else if (inv?.applied) {
                    toast.success(res.message || 'Payment status updated');
                } else if (inv?.reason === 'no_invoice' && updateInvoiceWhenChangingStatus) {
                    toast.success(
                        'Payment status updated. No linked invoice — only the payment row was updated.'
                    );
                } else {
                    toast.success(res.message || 'Payment status updated');
                }
                await refetchPayments();
                setSelectedPayment(null);
                onRefresh?.();
            } else {
                toast.error(res.message || 'Failed to update status');
            }
        } catch (e: unknown) {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            const msg = err?.response?.data?.message || err?.message || 'Failed to update status';
            toast.error(msg);
        } finally {
            setSavingStatus(false);
        }
    };

    const handleDeletePayment = async () => {
        if (!selectedPayment) return;
        setDeletingPayment(true);
        try {
            const res = await apiService.delete<{ success: boolean; message?: string }>(
                `/api/payments/${encodeURIComponent(selectedPayment.PaymentId)}`
            );
            if (res.success) {
                toast.success('Payment deleted');
                setSelectedPayment(null);
                setShowDeleteConfirm(false);
                await refetchPayments();
                onRefresh?.();
            } else {
                toast.error(res.message || 'Failed to delete payment');
            }
        } catch (e: unknown) {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            const msg = err?.response?.data?.message || err?.message || 'Failed to delete payment';
            toast.error(msg);
        } finally {
            setDeletingPayment(false);
        }
    };

    const handleLinkDimeCustomer = async () => {
        const customerIdTrimmed = dimeCustomerId.trim();
        if (!customerIdTrimmed) {
            toast.error('Enter DIME customer ID (UUID from DIME dashboard customer link).');
            return;
        }
        setLinkingDime(true);
        toast.loading('Linking DIME customer…', { id: 'link-dime' });
        try {
            const res = await apiService.post<{ success?: boolean; message?: string }>('/api/payments/link-dime-customer', {
                memberId: member.MemberId,
                dimeCustomerId: customerIdTrimmed,
                dimePaymentMethodId: dimePaymentMethodId.trim() || undefined,
                paymentMethodType: 'Card',
            });
            const success = (res as any)?.success === true;
            const msg = (res as any)?.message;
            toast.dismiss('link-dime');
            if (success) {
                toast.success(msg || 'DIME customer linked.');
                setDimeCustomerId('');
                setDimePaymentMethodId('');
                setShowLinkDimeModal(false);
                await refetchPaymentMethods();
                queryClient.invalidateQueries({ queryKey: ['canSetupRecurring', member.MemberId] });
                onRefresh?.();
            } else {
                toast.error(msg || 'Failed to link DIME customer.');
            }
        } catch (e) {
            toast.dismiss('link-dime');
            const err = e as { message?: string; response?: { data?: { message?: string } } };
            const message = err?.response?.data?.message || (err?.message ?? 'Failed to link DIME customer.');
            toast.error(message);
        } finally {
            setLinkingDime(false);
        }
    };

    const getPaymentMethodDisplay = (pm: MemberPaymentMethodRow) => {
        if (String(pm.paymentMethodType).toUpperCase() === 'ACH') {
            return `Bank •••• ${pm.accountNumberLast4 || '****'}`;
        }
        const last4 = pm.cardLast4;
        const brand = pm.cardBrand || 'Card';
        if (!last4) {
            return 'DIME customer linked (no payment method on file)';
        }
        return `${brand} •••• ${last4}`;
    };

    const maybePromptOutstandingInvoiceAfterPmSave = (data?: PaymentMethodRecurringSyncPayload) => {
        if (!showRecurringSection || !isIndividualMember) return;
        if (data?.outstandingInvoice) {
            setOutstandingInvoicePrompt(data.outstandingInvoice);
        }
    };

    const runAddToPaymentProcessor = async (
        pm: MemberPaymentMethodRow,
        opts?: { cvv?: string; forceReplaceProcessorPaymentMethod?: boolean }
    ): Promise<'ok' | 'cvv-required' | 'error'> => {
        try {
            const callOpts =
                opts?.cvv || opts?.forceReplaceProcessorPaymentMethod
                    ? {
                          ...(opts.cvv ? { cvv: opts.cvv } : {}),
                          ...(opts.forceReplaceProcessorPaymentMethod
                              ? { forceReplaceProcessorPaymentMethod: true as const }
                              : {})
                      }
                    : undefined;
            const res = await MemberPaymentMethodsService.addToPaymentProcessorForMember(
                member.MemberId,
                pm.paymentMethodId,
                callOpts
            );
            if (res.success) {
                toast.success(res.message || 'Payment method saved to payment processor.');
                await refetchPaymentMethods();
                queryClient.invalidateQueries({ queryKey: ['canSetupRecurring', member.MemberId] });
                onRefresh?.();
                if (opts?.forceReplaceProcessorPaymentMethod) {
                    maybePromptOutstandingInvoiceAfterPmSave(res.data);
                }
                return 'ok';
            }
            if (res.code === 'CVV_REQUIRED') {
                return 'cvv-required';
            }
            toast.error(res.message || 'Failed to save payment method to payment processor.');
            return 'error';
        } catch (e: unknown) {
            // apiService normalizes axios errors into { message, status, code, responseData }
            // with `code` at the top level — not nested under response.data.
            const err = e as {
                code?: string;
                message?: string;
                responseData?: { code?: string; message?: string };
                response?: { status?: number; data?: { message?: string; code?: string } };
            };
            const code = err?.code || err?.responseData?.code || err?.response?.data?.code;
            if (code === 'CVV_REQUIRED') {
                return 'cvv-required';
            }
            const msg =
                err?.responseData?.message ||
                err?.response?.data?.message ||
                err?.message ||
                'Failed to save payment method to payment processor.';
            toast.error(msg);
            return 'error';
        }
    };

    const handleAddToPaymentProcessor = async (
        pm: MemberPaymentMethodRow
    ): Promise<'ok' | 'cvv-required' | 'error'> => {
        setSyncingPaymentMethodId(pm.paymentMethodId);
        let outcome: 'ok' | 'cvv-required' | 'error' = 'error';
        try {
            setCvvPromptForceReplace(false);
            outcome = await runAddToPaymentProcessor(pm);
            if (outcome === 'cvv-required') {
                setCvvPromptPm(pm);
                setCvvPromptValue('');
                setCvvPromptError(null);
            }
        } finally {
            setSyncingPaymentMethodId(null);
        }
        return outcome;
    };

    const handleReplaceProcessorVault = async (
        pm: MemberPaymentMethodRow
    ): Promise<'ok' | 'cvv-required' | 'error' | 'cancelled'> => {
        if (
            !window.confirm(
                'Replace the vaulted token at DIME using payment details encrypted on file. After success, confirm the active recurring schedule still references this payment method, then retry the charge. Proceed?'
            )
        ) {
            return 'cancelled';
        }
        setSyncingPaymentMethodId(pm.paymentMethodId);
        let outcome: 'ok' | 'cvv-required' | 'error' = 'error';
        try {
            setCvvPromptForceReplace(true);
            outcome = await runAddToPaymentProcessor(pm, { forceReplaceProcessorPaymentMethod: true });
            if (outcome === 'cvv-required') {
                setCvvPromptPm(pm);
                setCvvPromptValue('');
                setCvvPromptError(null);
            } else {
                setCvvPromptForceReplace(false);
            }
        } finally {
            setSyncingPaymentMethodId(null);
        }
        return outcome;
    };

    const handleRemovePaymentMethod = async (pm: MemberPaymentMethodRow) => {
        const label = getPaymentMethodDisplay(pm);
        if (
            !window.confirm(
                `Remove ${label} from this member's account? It will be hidden on the member portal and cannot be used for future charges. Historical payments are unchanged.`
            )
        ) {
            return;
        }
        setRemovingPaymentMethodId(pm.paymentMethodId);
        try {
            const res = await MemberPaymentMethodsService.deletePaymentMethodForMember(
                member.MemberId,
                pm.paymentMethodId
            );
            if (res.success) {
                toast.success(res.message || 'Payment method removed');
                setPaymentMethodManagePm(null);
                await refetchPaymentMethods();
                onRefresh?.();
            } else {
                toast.error(res.message || 'Failed to remove payment method');
            }
        } catch (err: any) {
            const msg =
                err?.response?.data?.message || err?.message || 'Failed to remove payment method';
            toast.error(msg);
        } finally {
            setRemovingPaymentMethodId(null);
        }
    };

    const handleRestorePaymentMethod = async (pm: MemberPaymentMethodRow) => {
        const label = getPaymentMethodDisplay(pm);
        if (
            !window.confirm(
                `Restore ${label} for this member? It will appear on the member portal again. You may need to re-save it to the payment processor.`
            )
        ) {
            return;
        }
        setRestoringPaymentMethodId(pm.paymentMethodId);
        try {
            const res = await MemberPaymentMethodsService.restorePaymentMethodForMember(
                member.MemberId,
                pm.paymentMethodId
            );
            if (res.success) {
                toast.success(res.message || 'Payment method restored');
                setPaymentMethodManagePm(null);
                await refetchPaymentMethods();
                onRefresh?.();
            } else {
                toast.error(res.message || 'Failed to restore payment method');
            }
        } catch (err: any) {
            const msg =
                err?.response?.data?.message || err?.message || 'Failed to restore payment method';
            toast.error(msg);
        } finally {
            setRestoringPaymentMethodId(null);
        }
    };

    const closeCvvPrompt = () => {
        setCvvPromptPm(null);
        setCvvPromptValue('');
        setCvvPromptError(null);
        setCvvPromptSubmitting(false);
        setCvvPromptForceReplace(false);
    };

    const submitCvvPrompt = async () => {
        if (!cvvPromptPm) return;
        const cvv = cvvPromptValue.trim();
        if (!/^\d{3,4}$/.test(cvv)) {
            setCvvPromptError('Enter a 3 or 4 digit CVV.');
            return;
        }
        setCvvPromptError(null);
        setCvvPromptSubmitting(true);
        setSyncingPaymentMethodId(cvvPromptPm.paymentMethodId);
        try {
            const outcome = await runAddToPaymentProcessor(cvvPromptPm, {
                cvv,
                forceReplaceProcessorPaymentMethod: cvvPromptForceReplace
            });
            if (outcome === 'ok') {
                closeCvvPrompt();
            } else if (outcome === 'cvv-required') {
                setCvvPromptError('That CVV was not accepted. Please verify it with the member and try again.');
                setCvvPromptSubmitting(false);
            } else {
                closeCvvPrompt();
            }
        } finally {
            setSyncingPaymentMethodId(null);
            setCvvPromptSubmitting(false);
        }
    };

    const formatPaymentMethodAddedAt = (iso: string | undefined): string | null => {
        if (!iso || typeof iso !== 'string') return null;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    };

    const formatPaymentMethodLastUpdatedSubtitle = (pm: MemberPaymentMethodRow): string | null => {
        const whenLabel = formatPaymentMethodAddedAt(pm.modifiedDate ?? undefined);
        if (!whenLabel) return null;
        const actor = pm.lastUpdatedByActor;
        if (actor === 'member') return `Last updated ${whenLabel} · Member`;
        if (actor === 'staff') {
            const n = pm.modifiedByName?.trim();
            const e = pm.modifiedByEmail?.trim();
            if (n && e) return `Last updated ${whenLabel} · Staff: ${n} (${e})`;
            if (n) return `Last updated ${whenLabel} · Staff: ${n}`;
            if (e) return `Last updated ${whenLabel} · Staff: ${e}`;
            return `Last updated ${whenLabel} · Staff`;
        }
        return `Last updated ${whenLabel} · Unknown user / legacy`;
    };

    const getPaymentStatusIcon = (status: string) => {
        switch (status?.toLowerCase()) {
            case 'paid':
            case 'completed':
            case 'approval':
            case 'success':
                return <CheckCircle className="h-5 w-5 text-green-600" />;
            case 'recurringscheduled':
                return (
                    <span title="Recurring schedule record (not a settled charge)">
                        <Clock className="h-5 w-5 text-gray-500" />
                    </span>
                );
            case 'pending':
            case 'processing':
                return <Clock className="h-5 w-5 text-yellow-600" />;
            case 'failed':
            case 'declined':
                return <AlertCircle className="h-5 w-5 text-red-600" />;
            default:
                return <Clock className="h-5 w-5 text-gray-400" />;
        }
    };

    const getPaymentStatusColor = (status: string, isRefunded?: boolean) => {
        if (isRefunded) {
            return 'bg-gray-100 text-gray-800';
        }
        switch (status?.toLowerCase()) {
            case 'paid':
            case 'completed':
            case 'approval':
            case 'success':
                return 'bg-green-100 text-green-800';
            case 'recurringscheduled':
                return 'bg-gray-100 text-gray-700';
            case 'pending':
            case 'processing':
                return 'bg-yellow-100 text-yellow-800';
            case 'failed':
            case 'declined':
                return 'bg-red-100 text-red-800';
            default:
                return 'bg-gray-100 text-gray-800';
        }
    };

    const handleRefundClick = (payment: Payment) => {
        setRefundPayment(payment);
    };

    const isPaymentRefunded = (payment: Payment) => {
        return payment.Status?.toLowerCase() === 'refunded';
    };

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(amount);
    };

    const formatDate = (dateString: string) => {
        return new Date(dateString).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    };

    const paymentMethodEnrichedDetail = (payment: Payment): string | null => {
        if (payment.PaymentMethodType === 'Card' && payment.CardLast4) {
            return `${payment.CardBrand || 'Card'} ****${payment.CardLast4}`;
        }
        if (payment.PaymentMethodType === 'ACH' && payment.AccountNumberLast4) {
            return `${payment.AccountType || 'Bank'} ****${payment.AccountNumberLast4}`;
        }
        return null;
    };

    const renderPaymentMethodRails = (payment: Payment | null | undefined, opts?: { className?: string }) => {
        if (!payment) return null;
        const rail = getPaymentMethodType(payment.PaymentMethod);
        const extra = paymentMethodEnrichedDetail(payment);
        return (
            <div className={`flex flex-wrap items-center gap-2 ${opts?.className ?? ''}`}>
                <span
                    className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${paymentMethodBadgeClasses(rail.type)}`}
                >
                    {rail.label}
                </span>
                {extra ? <span className="text-gray-600 text-sm break-words">{extra}</span> : null}
            </div>
        );
    };

    const formatTransactionType = (type: string | null | undefined) => {
        if (!type) return 'Payment';
        
        switch (type.toLowerCase()) {
            case 'payment':
                return 'Payment';
            case 'refund':
                return 'Refund';
            case 'chargeback':
                return 'Chargeback';
            case 'ach_return':
                return 'ACH Return';
            case 'deposit':
                return 'Deposit';
            case 'void':
                return 'Void';
            default:
                return type.charAt(0).toUpperCase() + type.slice(1);
        }
    };

    const getTransactionTypeColor = (type: string | null | undefined) => {
        if (!type) return 'bg-blue-100 text-blue-800';
        
        switch (type.toLowerCase()) {
            case 'payment':
                return 'bg-green-100 text-green-800';
            case 'refund':
                return 'bg-yellow-100 text-yellow-800';
            case 'chargeback':
                return 'bg-red-100 text-red-800';
            case 'ach_return':
                return 'bg-red-100 text-red-800';
            case 'deposit':
                return 'bg-blue-100 text-blue-800';
            case 'void':
                return 'bg-gray-100 text-gray-800';
            default:
                return 'bg-gray-100 text-gray-800';
        }
    };

    if (paymentsLoading) {
        return (
            <div className="p-6">
                <div className="flex items-center justify-center h-64">
                    <div className="text-center">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto mb-4"></div>
                        <div className="text-lg text-gray-600">Loading payments...</div>
                    </div>
                </div>
            </div>
        );
    }

    if (paymentsError) {
        return (
            <div className="p-6">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-center">
                        <AlertCircle className="h-5 w-5 text-red-600 mr-2" />
                        <div>
                            <h4 className="font-medium text-red-800">Error Loading Payments</h4>
                            <p className="text-sm text-red-700">{paymentsError.message}</p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-6">
            {/* Payment methods section - individual (non-group) members only */}
            {isIndividualMember && (
                <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">
                        Payment Methods
                        {(paymentMethods.length > 0 || removedPaymentMethods.length > 0) && (
                            <span className="ml-2 text-sm font-normal text-gray-500">
                                ({paymentMethods.length} active
                                {removedPaymentMethods.length > 0
                                    ? `, ${removedPaymentMethods.length} removed`
                                    : ''}
                                )
                            </span>
                        )}
                    </h3>
                    {paymentMethodsLoading ? (
                        <div className="flex items-center gap-2 text-gray-500 text-sm">
                            <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-oe-primary" />
                            Loading payment methods...
                        </div>
                    ) : paymentMethods.length === 0 && removedPaymentMethods.length === 0 ? (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
                            <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm font-medium text-amber-800">No payment methods on file</p>
                                <p className="text-sm text-amber-700 mt-1">This member has not added any payment methods yet.</p>
                            </div>
                        </div>
                    ) : (
                        <>
                        {paymentMethods.length === 0 ? (
                            <p className="text-sm text-gray-500 mb-3">No active payment methods.</p>
                        ) : (
                        <div className="space-y-3">
                            {paymentMethods.map((pm) => {
                                const addedAtLabel = formatPaymentMethodAddedAt(pm.createdDate);
                                const updatedLabel = formatPaymentMethodLastUpdatedSubtitle(pm);
                                return (
                                <div
                                    key={pm.paymentMethodId}
                                    className="flex items-center justify-between p-4 border border-gray-200 rounded-lg bg-gray-50/50"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-white border border-gray-200">
                                            {pm.paymentMethodType === 'ACH' ? (
                                                <Building className="h-5 w-5 text-oe-primary" />
                                            ) : (
                                                <CreditCard className="h-5 w-5 text-oe-primary" />
                                            )}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="font-medium text-gray-900">{getPaymentMethodDisplay(pm)}</span>
                                                {pm.isDefault && (
                                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                                        <Star className="h-3 w-3" />
                                                        Primary
                                                    </span>
                                                )}
                                                {!pm.processorPaymentMethodId && (
                                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                                                        Not saved to Payment Processor
                                                    </span>
                                                )}
                                            </div>
                                            {pm.bankName && (
                                                <p className="text-sm text-gray-500 mt-0.5">{pm.bankName}</p>
                                            )}
                                            {addedAtLabel && (
                                                <p className="text-xs text-gray-400 mt-0.5">Added {addedAtLabel}</p>
                                            )}
                                            {updatedLabel && (
                                                <p className="text-xs text-gray-400 mt-0.5">{updatedLabel}</p>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {canManagePaymentMethods && (
                                            <>
                                                <button
                                                    type="button"
                                                    title="View details, edit billing, or replace vault at processor"
                                                    onClick={() => setPaymentMethodManagePm(pm)}
                                                    disabled={
                                                        syncingPaymentMethodId === pm.paymentMethodId ||
                                                        removingPaymentMethodId === pm.paymentMethodId ||
                                                        restoringPaymentMethodId === pm.paymentMethodId
                                                    }
                                                    className="p-2 rounded-lg border border-gray-200 text-gray-500 bg-white hover:bg-gray-50 hover:text-gray-800 disabled:opacity-50 disabled:pointer-events-none"
                                                    aria-label="View or manage payment method"
                                                >
                                                    <Pencil className="h-4 w-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    title="Remove from member portal (soft delete)"
                                                    onClick={() => handleRemovePaymentMethod(pm)}
                                                    disabled={
                                                        syncingPaymentMethodId === pm.paymentMethodId ||
                                                        removingPaymentMethodId === pm.paymentMethodId ||
                                                        restoringPaymentMethodId === pm.paymentMethodId
                                                    }
                                                    className="p-2 rounded-lg border border-red-200 text-red-600 bg-white hover:bg-red-50 disabled:opacity-50 disabled:pointer-events-none"
                                                    aria-label="Remove payment method"
                                                >
                                                    {removingPaymentMethodId === pm.paymentMethodId ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Trash2 className="h-4 w-4" />
                                                    )}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                                );
                            })}
                        </div>
                        )}
                        {removedPaymentMethods.length > 0 && canManagePaymentMethods && (
                            <div className="mt-6 border-t border-gray-200 pt-4">
                                <button
                                    type="button"
                                    onClick={() => setShowRemovedPaymentMethods((v) => !v)}
                                    className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
                                >
                                    <span className="text-gray-400">{showRemovedPaymentMethods ? '▾' : '▸'}</span>
                                    Removed payment methods ({removedPaymentMethods.length})
                                </button>
                                <p className="text-xs text-gray-500 mt-1 ml-5">
                                    Hidden from the member portal. Restore or edit billing details here.
                                </p>
                                {showRemovedPaymentMethods && (
                                    <div className="space-y-3 mt-3">
                                        {removedPaymentMethods.map((pm) => {
                                            const addedAtLabel = formatPaymentMethodAddedAt(pm.createdDate);
                                            const updatedLabel = formatPaymentMethodLastUpdatedSubtitle(pm);
                                            return (
                                                <div
                                                    key={pm.paymentMethodId}
                                                    className="flex items-center justify-between p-4 border border-dashed border-gray-300 rounded-lg bg-gray-50/80 opacity-90"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <div className="p-2 rounded-lg bg-white border border-gray-200">
                                                            {pm.paymentMethodType === 'ACH' ? (
                                                                <Building className="h-5 w-5 text-gray-400" />
                                                            ) : (
                                                                <CreditCard className="h-5 w-5 text-gray-400" />
                                                            )}
                                                        </div>
                                                        <div>
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <span className="font-medium text-gray-700">
                                                                    {getPaymentMethodDisplay(pm)}
                                                                </span>
                                                                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">
                                                                    Removed
                                                                </span>
                                                            </div>
                                                            {pm.bankName && (
                                                                <p className="text-sm text-gray-500 mt-0.5">{pm.bankName}</p>
                                                            )}
                                                            {addedAtLabel && (
                                                                <p className="text-xs text-gray-400 mt-0.5">Added {addedAtLabel}</p>
                                                            )}
                                                            {updatedLabel && (
                                                                <p className="text-xs text-gray-400 mt-0.5">{updatedLabel}</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2 shrink-0">
                                                        <button
                                                            type="button"
                                                            title="Edit billing details"
                                                            onClick={() => setPaymentMethodManagePm(pm)}
                                                            disabled={
                                                                syncingPaymentMethodId === pm.paymentMethodId ||
                                                                removingPaymentMethodId === pm.paymentMethodId ||
                                                                restoringPaymentMethodId === pm.paymentMethodId
                                                            }
                                                            className="p-2 rounded-lg border border-gray-200 text-gray-500 bg-white hover:bg-gray-50 hover:text-gray-800 disabled:opacity-50"
                                                            aria-label="Edit removed payment method"
                                                        >
                                                            <Pencil className="h-4 w-4" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            title="Restore for member portal"
                                                            onClick={() => handleRestorePaymentMethod(pm)}
                                                            disabled={
                                                                syncingPaymentMethodId === pm.paymentMethodId ||
                                                                removingPaymentMethodId === pm.paymentMethodId ||
                                                                restoringPaymentMethodId === pm.paymentMethodId
                                                            }
                                                            className="p-2 rounded-lg border border-green-200 text-green-700 bg-white hover:bg-green-50 disabled:opacity-50"
                                                            aria-label="Restore payment method"
                                                        >
                                                            {restoringPaymentMethodId === pm.paymentMethodId ? (
                                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                            ) : (
                                                                <RotateCcw className="h-4 w-4" />
                                                            )}
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}
                        </>
                    )}
                    {isIndividualMember && (canManagePaymentMethods || showRecurringSection) && (
                        <div className="mt-4 flex flex-wrap gap-2">
                            {canManagePaymentMethods && (
                                <button
                                    type="button"
                                    onClick={() => setShowAddPaymentMethodModal(true)}
                                    className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                                >
                                    <Plus className="h-4 w-4 text-oe-primary" />
                                    Add Payment Method
                                </button>
                            )}
                            {showRecurringSection && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => setShowChargeNowModal(true)}
                                        className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                                    >
                                        <DollarSign className="h-4 w-4 text-oe-primary" />
                                        Charge Now
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShowLinkDimeModal(true)}
                                        className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                                    >
                                        <Link2 className="h-4 w-4 text-oe-primary" />
                                        Link DIME customer
                                    </button>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Sub-tabs: Payment history | Recurring payments | Invoices */}
            <div className="border-b border-gray-200 mb-6">
                <nav className="-mb-px flex space-x-8">
                    <button
                        type="button"
                        onClick={() => setPaymentsSubTab('history')}
                        className={`py-3 px-1 border-b-2 font-medium text-sm flex items-center gap-2 ${paymentsSubTab === 'history' ? 'border-oe-primary text-oe-primary' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                    >
                        <CreditCard className="h-4 w-4" />
                        Payment history
                    </button>
                    {showRecurringSection && (
                        <button
                            type="button"
                            onClick={() => setPaymentsSubTab('recurring')}
                            className={`py-3 px-1 border-b-2 font-medium text-sm flex items-center gap-2 ${paymentsSubTab === 'recurring' ? 'border-oe-primary text-oe-primary' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                        >
                            <Repeat className="h-4 w-4" />
                            Recurring payments
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => setPaymentsSubTab('invoices')}
                        className={`py-3 px-1 border-b-2 font-medium text-sm flex items-center gap-2 ${paymentsSubTab === 'invoices' ? 'border-oe-primary text-oe-primary' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                    >
                        <FileText className="h-4 w-4" />
                        Invoices
                    </button>
                </nav>
            </div>

            {paymentsSubTab === 'invoices' ? (
                <MemberInvoicesSubTab
                    householdId={member.HouseholdId}
                    canEdit={showRecurringSection}
                    allowInvoiceDeletion={isTenantBillingAdmin}
                    member={member}
                    canManageCredits={canManageCredits}
                    showPayoutFlags={isTenantBillingAdmin}
                />
            ) : paymentsSubTab === 'recurring' && showRecurringSection ? (
                <MemberRecurringPaymentsTab member={member} onRefresh={onRefresh} />
            ) : (
        <>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-lg font-semibold text-gray-900">Payment History</h3>
                    <p className="text-sm text-gray-600">
                      Settled and in-process charges for this member. DIME recurring schedule placeholders are listed under{' '}
                      <span className="font-medium text-gray-700">Recurring payments</span>, not here.
                    </p>
                </div>
                <button
                    onClick={() => refetchPayments()}
                    className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex items-center"
                >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Refresh
                </button>
            </div>

            {/* Summary Cards */}
            {payments && payments.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm text-gray-600">Total Payments</p>
                                <p className="text-2xl font-bold text-gray-900">{payments.length}</p>
                            </div>
                            <div className="bg-blue-100 p-3 rounded-full">
                                <CreditCard className="h-6 w-6 text-oe-primary" />
                            </div>
                        </div>
                    </div>

                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm text-gray-600">Total Amount Paid</p>
                                <p className="text-2xl font-bold text-gray-900">
                                    {formatCurrency(
                                        payments
                                            .filter((p) => {
                                                // Net-money rule:
                                                //   • Original payment rows that landed (Completed) OR were later refunded
                                                //     still represent money that hit our account.
                                                //   • Refund rows (negative amount) net out the original; include when
                                                //     successfully completed.
                                                const status = String(p.Status || '').toLowerCase();
                                                if (status === 'refunded') return true;
                                                return isSuccessfulPaymentRecordStatus(p.Status);
                                            })
                                            .reduce((sum, p) => sum + (Number(p.Amount) || 0), 0)
                                    )}
                                </p>
                            </div>
                            <div className="bg-green-100 p-3 rounded-full">
                                <DollarSign className="h-6 w-6 text-green-600" />
                            </div>
                        </div>
                    </div>

                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm text-gray-600">Last Payment</p>
                                <p className="text-lg font-semibold text-gray-900">
                                    {(() => {
                                        // Pick the most recent actual payment (skip refund rows, since the
                                        // refund date != when the customer last paid us).
                                        const actual = payments
                                            .filter(
                                                (p) =>
                                                    String(p.TransactionType || 'Payment').toLowerCase() !==
                                                    'refund'
                                            )
                                            .sort(
                                                (a, b) =>
                                                    new Date(b.PaymentDate).getTime() -
                                                    new Date(a.PaymentDate).getTime()
                                            );
                                        return actual[0] ? formatDate(actual[0].PaymentDate) : 'N/A';
                                    })()}
                                </p>
                            </div>
                            <div className="bg-purple-100 p-3 rounded-full">
                                <Clock className="h-6 w-6 text-purple-600" />
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Payments Table */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full table-fixed divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[11%]">
                                    Date
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[9%]">
                                    Type
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[9%]">
                                    Amount
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[11%]">
                                    Status
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[12%]">
                                    Method
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[14%]">
                                    Charged by
                                </th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider min-w-0 w-[22%]">
                                    Failure Reason
                                </th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider w-[13%] whitespace-nowrap">
                                    Actions
                                </th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {payments && payments.length > 0 ? (
                                payments.map((payment) => {
                                    const failureHint =
                                        payment.FailureReason && payment.Status === 'Failed'
                                            ? getStoredDimePaymentFailureUiHint(payment.FailureReason)
                                            : null;
                                    const chargeSourceLabel = formatChargeSourceAttribution({
                                        paymentMethod: payment.PaymentMethod,
                                        enrollmentId: payment.EnrollmentId,
                                        recurringScheduleId: payment.RecurringScheduleId,
                                        createdBy: payment.CreatedBy,
                                        createdByName: payment.CreatedByName,
                                        memberUserId: member.UserId,
                                        isManualCharge:
                                            !payment.EnrollmentId &&
                                            !payment.RecurringScheduleId &&
                                            (!!payment.CreatedBy ||
                                                ['dime', 'ach', 'card'].includes(
                                                    String(payment.PaymentMethod || '').trim().toLowerCase()
                                                ))
                                    });
                                    return (
                                    <tr key={payment.PaymentId} className="hover:bg-gray-50">
                                        <td className="px-4 py-4 align-top text-sm text-gray-900 whitespace-nowrap">
                                            <div>
                                                <div>{formatDate(payment.PaymentDate)}</div>
                                                {payment.AttemptNumber && payment.Status === 'Failed' && (
                                                    <div className="text-xs text-red-600 mt-1">
                                                        Attempt {payment.AttemptNumber}{payment.ConsecutiveFailureCount ? ` (${payment.ConsecutiveFailureCount} consecutive)` : ''}
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-4 align-top whitespace-nowrap">
                                            <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getTransactionTypeColor(payment.TransactionType)}`}>
                                                {formatTransactionType(payment.TransactionType)}
                                            </span>
                                        </td>
                                        <td className="px-4 py-4 align-top whitespace-nowrap text-sm font-medium text-gray-900">
                                            {formatCurrency(payment.Amount)}
                                        </td>
                                        <td className="px-4 py-4 align-top whitespace-nowrap">
                                            <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getPaymentStatusColor(payment.Status, isPaymentRefunded(payment))}`}>
                                                <span className="flex items-center">
                                                    {getPaymentStatusIcon(payment.Status)}
                                                    <span className="ml-1">
                                                        {isPaymentRefunded(payment)
                                                            ? 'Refunded' 
                                                            : payment.Status?.toLowerCase() === 'approval' || payment.Status?.toLowerCase() === 'success' 
                                                                ? 'Completed' 
                                                                : payment.Status}
                                                    </span>
                                                </span>
                                            </span>
                                        </td>
                                        <td className="px-4 py-4 align-top text-sm text-gray-900">
                                            {renderPaymentMethodRails(payment)}
                                        </td>
                                        <td className="px-4 py-4 align-top text-sm text-gray-700">
                                            {chargeSourceLabel}
                                        </td>
                                        <td className="px-4 py-4 align-top text-sm text-gray-900 min-w-0">
                                            {payment.FailureReason ? (
                                                <div
                                                    className="min-w-0"
                                                    title={[payment.FailureReason, failureHint || ''].filter(Boolean).join('\n\n')}
                                                >
                                                    <p className="text-red-600 text-sm leading-snug line-clamp-2 break-words">
                                                        {payment.FailureReason}
                                                    </p>
                                                    {failureHint && (
                                                            <p className="text-xs text-amber-900 mt-1 line-clamp-2 leading-snug break-words border-l-2 border-amber-300 pl-2">
                                                                {failureHint}
                                                            </p>
                                                        )}
                                                </div>
                                            ) : payment.Status === 'Failed' && payment.ACHReturnReason ? (
                                                <p className="text-red-600 line-clamp-2 break-words" title={payment.ACHReturnReason}>
                                                    {payment.ACHReturnReason}
                                                </p>
                                            ) : payment.Status === 'Failed' && payment.ChargebackReason ? (
                                                <p className="text-red-600 line-clamp-2 break-words" title={payment.ChargebackReason}>
                                                    {payment.ChargebackReason}
                                                </p>
                                            ) : (
                                                <p className="text-gray-400">—</p>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 align-top text-sm text-right whitespace-nowrap">
                                            <div className="flex flex-col items-end gap-2 sm:flex-row sm:justify-end sm:items-start sm:flex-wrap sm:gap-x-3 sm:gap-y-1">
                                                {isSuccessfulPaymentRecordStatus(payment.Status) && (
                                                    <button
                                                        type="button"
                                                        title="View payment receipt"
                                                        disabled={receiptPdfLoadingId === payment.PaymentId}
                                                        onClick={() => handleOpenPaymentReceiptPdf(payment.PaymentId)}
                                                        className="text-gray-600 hover:text-oe-primary inline-flex items-center disabled:opacity-50"
                                                    >
                                                        {receiptPdfLoadingId === payment.PaymentId ? (
                                                            <Loader2 className="h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <Receipt className="h-4 w-4" />
                                                        )}
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setPaymentDetailMode(isTenantBillingAdmin ? 'admin' : 'legacy');
                                                        setSelectedPayment(payment);
                                                    }}
                                                    className="text-oe-primary hover:text-blue-800 font-medium inline-flex items-center"
                                                >
                                                    <Eye className="h-4 w-4 mr-1" />
                                                    {isTenantBillingAdmin ? 'Details' : 'View / Edit'}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                    );
                                })
                            ) : (
                                <tr>
                                    <td colSpan={8} className="px-6 py-12 text-center">
                                        <div className="flex flex-col items-center">
                                            <CreditCard className="h-12 w-12 text-gray-400 mb-4" />
                                            <h3 className="text-lg font-medium text-gray-900 mb-2">No Payments Found</h3>
                                            <p className="text-gray-600">
                                                This member has no payment history yet.
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Shared billing-admin payment sheet (retry, refund, commissions) */}
            <AdminPaymentDetailsModal
                billingRow={
                    isTenantBillingAdmin && selectedPayment && paymentDetailMode === 'admin'
                        ? memberPaymentToBillingRow(member, selectedPayment)
                        : null
                }
                open={isTenantBillingAdmin && !!selectedPayment && paymentDetailMode === 'admin'}
                onClose={() => {
                    setShowDeleteConfirm(false);
                    setSelectedPayment(null);
                    setPaymentDetailMode('legacy');
                }}
                currentRole={user?.currentRole ?? ''}
                effectiveTenantId={
                    user?.currentRole === 'SysAdmin' ? member.TenantId ?? null : undefined
                }
                onRetrySuccess={() => {
                    refetchPayments();
                    onRefresh?.();
                }}
                onRequestRefund={(row) => {
                    if (selectedPayment?.PaymentId === row.paymentId) handleRefundClick(selectedPayment);
                }}
                showAdminBillingActions
                deletePayment={{
                    showConfirm: showDeleteConfirm,
                    deleting: deletingPayment,
                    disabled: savingStatus,
                    onRequestDelete: () => setShowDeleteConfirm(true),
                    onCancelConfirm: () => setShowDeleteConfirm(false),
                    onConfirmDelete: handleDeletePayment
                }}
                detailsExtras={
                    selectedPayment ? (
                        <>
                            <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-sm font-medium text-gray-700">Transaction type</label>
                                <div className="mt-1">
                                    <span
                                        className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getTransactionTypeColor(selectedPayment.TransactionType)}`}
                                    >
                                        {formatTransactionType(selectedPayment.TransactionType)}
                                    </span>
                                </div>
                            </div>
                            <div className="col-span-2">
                                <label className="text-sm font-medium text-gray-700 mb-1 block">Method details</label>
                                {renderPaymentMethodRails(selectedPayment, { className: 'items-start' })}
                            </div>
                            {selectedPayment.ACHReturnCode ? (
                                <div>
                                    <label className="text-sm font-medium text-gray-700">ACH Return Code</label>
                                    <p className="text-red-600 text-sm">{selectedPayment.ACHReturnCode}</p>
                                </div>
                            ) : null}
                            {selectedPayment.ACHReturnReason ? (
                                <div>
                                    <label className="text-sm font-medium text-gray-700">ACH Return Reason</label>
                                    <p className="text-red-600 text-sm whitespace-pre-wrap break-words leading-relaxed">
                                        {selectedPayment.ACHReturnReason}
                                    </p>
                                </div>
                            ) : null}
                            {selectedPayment.ChargebackReason ? (
                                <div className="col-span-2">
                                    <label className="text-sm font-medium text-gray-700">Chargeback Reason</label>
                                    <p className="text-red-600 text-sm whitespace-pre-wrap break-words leading-relaxed">
                                        {selectedPayment.ChargebackReason}
                                    </p>
                                </div>
                            ) : null}
                            {selectedPayment.NextBillingDate ? (
                                <div>
                                    <label className="text-sm font-medium text-gray-700">Next Billing Date</label>
                                    <p className="text-gray-900">{formatDate(selectedPayment.NextBillingDate)}</p>
                                </div>
                            ) : null}
                            </div>
                            {isTenantBillingAdmin && isIndividualMember && member.HouseholdId ? (
                                <div className="mt-4 border-t border-gray-200 pt-4 space-y-2 col-span-2">
                                    <div>
                                        <label
                                            className="block text-sm font-medium text-gray-700 mb-1"
                                            htmlFor="payment-invoice-link-select"
                                        >
                                            Linked invoice (household)
                                        </label>
                                        {isPaymentGroupBilled(selectedPayment) ? (
                                            <p className="text-sm text-gray-500">
                                                This payment is group-billed — use group billing to change invoice linkage.
                                            </p>
                                        ) : (
                                            <>
                                                <select
                                                    id="payment-invoice-link-select"
                                                    value={invoiceLinkDraft}
                                                    onChange={(e) => setInvoiceLinkDraft(e.target.value)}
                                                    disabled={linkInvoiceSaving || deletingPayment}
                                                    className="w-full max-w-lg px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white text-gray-900 text-sm disabled:opacity-60"
                                                >
                                                    <option value="">No invoice (unlink)</option>
                                                    {linkInvoiceOptionsForSelect.map((inv) => (
                                                        <option key={inv.InvoiceId} value={inv.InvoiceId}>
                                                            #{inv.InvoiceNumber} ·{' '}
                                                            {formatCalendarDate(inv.BillingPeriodStart)} –{' '}
                                                            {formatCalendarDate(inv.BillingPeriodEnd)} · {inv.Status} ·{' '}
                                                            {formatCurrency(Number(inv.TotalAmount || 0))}
                                                        </option>
                                                    ))}
                                                </select>
                                                <p className="text-xs text-gray-500 mt-1">
                                                    For successful charges, the previous invoice is unfulfilled and the new one is
                                                    fulfilled by this payment amount (credit-aware status). Commissions may need a
                                                    manual review if they were already generated.
                                                </p>
                                                <button
                                                    type="button"
                                                    onClick={() => void handleSaveInvoiceLink()}
                                                    disabled={
                                                        linkInvoiceSaving ||
                                                        deletingPayment ||
                                                        savingStatus
                                                    }
                                                    className="mt-2 inline-flex items-center justify-center px-3 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 text-sm font-medium disabled:opacity-50 disabled:pointer-events-none"
                                                >
                                                    {linkInvoiceSaving ? (
                                                        <>
                                                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                            Saving…
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Link2 className="h-4 w-4 mr-2" />
                                                            Save invoice link
                                                        </>
                                                    )}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            ) : null}
                        </>
                    ) : null
                }
                footerExtras={
                    selectedPayment ? (
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="payment-status-edit-shared">
                                    Payment status
                                </label>
                                <select
                                    id="payment-status-edit-shared"
                                    value={statusDraft}
                                    onChange={(e) => setStatusDraft(e.target.value)}
                                    className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white text-gray-900"
                                >
                                    {statusSelectOptions(selectedPayment.Status).map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                                <p className="text-xs text-gray-500 mt-1">
                                    Correct the recorded status when needed (e.g. after manual reconciliation).
                                </p>
                                <label className="mt-3 flex items-start gap-2 text-sm text-gray-800 cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                        checked={updateInvoiceWhenChangingStatus}
                                        onChange={(e) => setUpdateInvoiceWhenChangingStatus(e.target.checked)}
                                    />
                                    <span>
                                        Update corresponding invoice
                                        <span className="block text-xs font-normal text-gray-500 mt-0.5">
                                            When switching between paid and unpaid outcomes, adjusts invoice Paid Amount and status
                                            (credit-aware).
                                        </span>
                                    </span>
                                </label>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2 sm:justify-end w-full">
                                <button
                                    type="button"
                                    onClick={handleSavePaymentStatus}
                                    disabled={
                                        savingStatus ||
                                        deletingPayment ||
                                        statusDraft.trim() === (selectedPayment.Status || '')
                                    }
                                    className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 disabled:pointer-events-none"
                                >
                                    {savingStatus ? (
                                        <>
                                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                            Saving…
                                        </>
                                    ) : (
                                        'Save status'
                                    )}
                                </button>
                            </div>
                        </div>
                    ) : null
                }
            />

            {/* Payment Details Modal (agents / non–tenant billing admin) */}
            {selectedPayment && paymentDetailMode === 'legacy' && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-lg max-w-2xl w-full">
                        <div className="p-6 border-b border-gray-200">
                            <div className="flex items-center justify-between">
                                <h3 className="text-lg font-semibold text-gray-900">Payment details</h3>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowDeleteConfirm(false);
                                        setSelectedPayment(null);
                                    }}
                                    className="text-gray-400 hover:text-gray-600"
                                >
                                    <span className="sr-only">Close</span>
                                    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        </div>

                        <div className="p-6">
                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="text-sm font-medium text-gray-700">Payment ID</label>
                                        <p className="text-gray-900 text-sm font-mono">{selectedPayment.PaymentId}</p>
                                    </div>
                                    <div>
                                        <label className="text-sm font-medium text-gray-700">Transaction Type</label>
                                        <div className="mt-1">
                                            <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getTransactionTypeColor(selectedPayment.TransactionType)}`}>
                                                {formatTransactionType(selectedPayment.TransactionType)}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="col-span-2">
                                        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="payment-status-edit">
                                            Payment status
                                        </label>
                                        <select
                                            id="payment-status-edit"
                                            value={statusDraft}
                                            onChange={(e) => setStatusDraft(e.target.value)}
                                            className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white text-gray-900"
                                        >
                                            {statusSelectOptions(selectedPayment.Status).map((opt) => (
                                                <option key={opt.value} value={opt.value}>
                                                    {opt.label}
                                                </option>
                                            ))}
                                        </select>
                                        <p className="text-xs text-gray-500 mt-1">
                                            Correct the recorded status when needed (e.g. after manual reconciliation).
                                        </p>
                                        <label className="mt-3 flex items-start gap-2 text-sm text-gray-800 cursor-pointer select-none">
                                            <input
                                                type="checkbox"
                                                className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                checked={updateInvoiceWhenChangingStatus}
                                                onChange={(e) => setUpdateInvoiceWhenChangingStatus(e.target.checked)}
                                            />
                                            <span>
                                                Update corresponding invoice
                                                <span className="block text-xs font-normal text-gray-500 mt-0.5">
                                                    When switching between paid and unpaid outcomes, adjusts invoice Paid Amount and status
                                                    (credit-aware).
                                                </span>
                                            </span>
                                        </label>
                                    </div>
                                    <div>
                                        <label className="text-sm font-medium text-gray-700">Amount</label>
                                        <p className="text-gray-900 font-semibold">{formatCurrency(selectedPayment.Amount)}</p>
                                    </div>
                                    <div>
                                        <label className="text-sm font-medium text-gray-700">Payment Date</label>
                                        <p className="text-gray-900">{formatDate(selectedPayment.PaymentDate)}</p>
                                    </div>
                                    <div className="col-span-2">
                                        <label className="text-sm font-medium text-gray-700 mb-1 block">
                                            Payment Method
                                        </label>
                                        {renderPaymentMethodRails(selectedPayment, { className: 'items-start' })}
                                    </div>
                                    {selectedPayment.ProcessorTransactionId && (
                                        <div className="col-span-2">
                                            <label className="text-sm font-medium text-gray-700">Transaction ID</label>
                                            <p className="text-gray-900 font-mono text-sm">{selectedPayment.ProcessorTransactionId}</p>
                                        </div>
                                    )}
                                    {selectedPayment.OriginalPaymentId && (
                                        <div className="col-span-2">
                                            <label className="text-sm font-medium text-gray-700">Original Payment ID</label>
                                            <p className="text-gray-900 font-mono text-sm">{selectedPayment.OriginalPaymentId}</p>
                                        </div>
                                    )}
                                    {selectedPayment.FailureReason && (
                                        <div className="col-span-2">
                                            <label className="text-sm font-medium text-gray-700">
                                                Failure Reason
                                            </label>
                                            <p className="text-red-600 text-sm whitespace-pre-wrap break-words leading-relaxed">
                                                {selectedPayment.FailureReason}
                                            </p>
                                            {getStoredDimePaymentFailureUiHint(selectedPayment.FailureReason) && (
                                                <p className="text-xs text-amber-900 mt-2 border-l-2 border-amber-300 pl-2">
                                                    {getStoredDimePaymentFailureUiHint(selectedPayment.FailureReason)}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                    {selectedPayment.ACHReturnCode && (
                                        <div>
                                            <label className="text-sm font-medium text-gray-700">ACH Return Code</label>
                                            <p className="text-red-600 text-sm">{selectedPayment.ACHReturnCode}</p>
                                        </div>
                                    )}
                                    {selectedPayment.ACHReturnReason && (
                                        <div>
                                            <label className="text-sm font-medium text-gray-700">ACH Return Reason</label>
                                            <p className="text-red-600 text-sm">{selectedPayment.ACHReturnReason}</p>
                                        </div>
                                    )}
                                    {selectedPayment.ChargebackReason && (
                                        <div className="col-span-2">
                                            <label className="text-sm font-medium text-gray-700">Chargeback Reason</label>
                                            <p className="text-red-600 text-sm">{selectedPayment.ChargebackReason}</p>
                                        </div>
                                    )}
                                    {selectedPayment.NextBillingDate && (
                                        <div>
                                            <label className="text-sm font-medium text-gray-700">Next Billing Date</label>
                                            <p className="text-gray-900">{formatDate(selectedPayment.NextBillingDate)}</p>
                                        </div>
                                    )}
                                    {selectedPayment.AttemptNumber && selectedPayment.Status === 'Failed' && (
                                        <div>
                                            <label className="text-sm font-medium text-gray-700">Attempt Number</label>
                                            <p className="text-gray-900">Attempt {selectedPayment.AttemptNumber}</p>
                                            {selectedPayment.ConsecutiveFailureCount && (
                                                <p className="text-xs text-red-600">({selectedPayment.ConsecutiveFailureCount} consecutive failures)</p>
                                            )}
                                        </div>
                                    )}
                                    {selectedPayment.LastFailureDate && (
                                        <div>
                                            <label className="text-sm font-medium text-gray-700">Last Failure Date</label>
                                            <p className="text-red-600">{formatDate(selectedPayment.LastFailureDate)}</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border-t border-gray-200 space-y-4">
                            {showDeleteConfirm && (
                                <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                                    <p className="text-sm font-medium text-red-900">Delete this payment?</p>
                                    <p className="text-sm text-red-800 mt-1">
                                        This removes the payment record from our database only. It does not refund the
                                        payer or change anything at the payment processor.
                                    </p>
                                    <p className="text-sm text-red-800 mt-1">
                                        This cannot be undone. Deletion may fail if commissions or other records reference this payment.
                                    </p>
                                    <div className="flex flex-wrap gap-2 mt-3">
                                        <button
                                            type="button"
                                            onClick={() => setShowDeleteConfirm(false)}
                                            disabled={deletingPayment}
                                            className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleDeletePayment}
                                            disabled={deletingPayment}
                                            className="inline-flex items-center px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
                                        >
                                            {deletingPayment ? (
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
                            )}
                            <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
                                <button
                                    type="button"
                                    onClick={() => setShowDeleteConfirm(true)}
                                    disabled={savingStatus || deletingPayment || showDeleteConfirm}
                                    className="inline-flex items-center justify-center px-4 py-2 border border-red-300 text-red-700 rounded-lg hover:bg-red-50 text-sm font-medium disabled:opacity-50 disabled:pointer-events-none"
                                >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete payment…
                                </button>
                                <div className="flex flex-col sm:flex-row gap-2 sm:ml-auto w-full sm:w-auto">
                                    <button
                                        type="button"
                                        onClick={handleSavePaymentStatus}
                                        disabled={
                                            savingStatus ||
                                            deletingPayment ||
                                            !selectedPayment ||
                                            statusDraft.trim() === (selectedPayment.Status || '')
                                        }
                                        className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 disabled:pointer-events-none"
                                    >
                                        {savingStatus ? (
                                            <>
                                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                Saving…
                                            </>
                                        ) : (
                                            'Save status'
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowDeleteConfirm(false);
                                            setSelectedPayment(null);
                                        }}
                                        className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
                                    >
                                        Close
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <RefundPaymentModal
                isOpen={!!refundPayment}
                onClose={() => setRefundPayment(null)}
                paymentId={refundPayment?.PaymentId ?? ''}
                amount={refundPayment?.Amount ?? 0}
                onSuccess={() => {
                    // Refund flips invoice PaidAmount/Status (via unfulfillInvoiceInTxn) and
                    // may have voided/cascaded credit applications. Invalidate the
                    // invoice + credit query caches so the Invoices subtab and Credits
                    // panel rerender immediately, alongside the payment list refresh.
                    refetchPayments();
                    queryClient.invalidateQueries({ queryKey: ['invoices'] });
                    queryClient.invalidateQueries({ queryKey: ['member-invoices'] });
                    queryClient.invalidateQueries({ queryKey: ['householdCredits'] });
                    queryClient.invalidateQueries({ queryKey: ['household-credits'] });
                    setRefundPayment(null);
                }}
            />

            {/* Link DIME customer modal */}
            {showLinkDimeModal && (
                <div className="fixed inset-0 z-50 overflow-y-auto">
                    <div className="fixed inset-0 z-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !linkingDime && setShowLinkDimeModal(false)} />
                    <div className="relative z-10 flex min-h-full items-center justify-center p-4">
                        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
                            <h3 className="text-lg font-semibold text-gray-900 mb-2">Link DIME customer</h3>
                            <p className="text-sm text-gray-600 mb-4">
                                Paste the DIME customer UUID from the customer link (e.g. app.dimepayments.com/.../customer/<strong>uuid</strong>). Optionally add the payment method ID to enable setting up recurring later.
                            </p>
                            {hasExistingDimeCustomerId && (
                                <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                                    A DIME customer ID is already on file. Linking will overwrite it.
                                </div>
                            )}
                            <div className="space-y-3 mb-6">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">DIME customer ID (UUID)</label>
                                    <input
                                        type="text"
                                        value={dimeCustomerId}
                                        onChange={(e) => setDimeCustomerId(e.target.value)}
                                        placeholder="e.g. a73e6acc-b5ed-4f9a-a636-15e441c1c683"
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">DIME payment method ID (optional)</label>
                                    <input
                                        type="text"
                                        value={dimePaymentMethodId}
                                        onChange={(e) => setDimePaymentMethodId(e.target.value)}
                                        placeholder="From DIME dashboard if available"
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                                    />
                                </div>
                            </div>
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => !linkingDime && setShowLinkDimeModal(false)}
                                    disabled={linkingDime}
                                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleLinkDimeCustomer}
                                    disabled={linkingDime || !dimeCustomerId.trim()}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:pointer-events-none text-sm font-medium"
                                >
                                    {linkingDime ? 'Linking…' : 'Link DIME customer'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
            )}
            {/* Charge Now modal */}
            {showChargeNowModal && (
                <ChargeNowModal
                    memberId={member.MemberId}
                    preselectedInvoiceId={chargeNowPreselectedInvoiceId}
                    onSuccess={() => {
                        refetchPayments();
                        refetchPaymentMethods();
                        queryClient.invalidateQueries({ queryKey: ['canSetupRecurring', member.MemberId] });
                        queryClient.invalidateQueries({ queryKey: ['invoices'] });
                        queryClient.invalidateQueries({ queryKey: ['member-invoices'] });
                        onRefresh?.();
                    }}
                    onClose={() => {
                        setShowChargeNowModal(false);
                        setChargeNowPreselectedInvoiceId(null);
                    }}
                />
            )}
            {/* Add Payment Method modal - rendered at top level so it works from any sub-tab */}
            {(showAddPaymentMethodModal || paymentMethodToEdit) && (
                <AddPaymentMethodModal
                    memberId={member.MemberId}
                    memberPrefill={{
                        firstName: member.FirstName,
                        lastName: member.LastName,
                        address: member.Address,
                        city: member.City,
                        state: member.State,
                        zip: member.Zip,
                        phoneNumber: member.PhoneNumber,
                    }}
                    editSource={paymentMethodToEdit ?? undefined}
                    onSuccess={(data) => {
                        refetchPaymentMethods();
                        queryClient.invalidateQueries({ queryKey: ['canSetupRecurring', member.MemberId] });
                        onRefresh?.();
                        maybePromptOutstandingInvoiceAfterPmSave(data);
                    }}
                    onClose={() => {
                        setShowAddPaymentMethodModal(false);
                        setPaymentMethodToEdit(null);
                    }}
                />
            )}
            {outstandingInvoicePrompt && showRecurringSection && isIndividualMember && (
                <OutstandingInvoicePayPromptModal
                    open={!!outstandingInvoicePrompt}
                    invoice={outstandingInvoicePrompt}
                    onClose={() => setOutstandingInvoicePrompt(null)}
                    onPayNow={async (invoiceId) => {
                        setChargeNowPreselectedInvoiceId(invoiceId);
                        setOutstandingInvoicePrompt(null);
                        setShowChargeNowModal(true);
                        return { success: true };
                    }}
                />
            )}
            {/* Admin actions for one payment method — replace vault tooltip on button only */}
            {resolvedPaymentMethodManage && canManagePaymentMethods && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4"
                    onMouseDown={(e) => {
                        if (
                            e.target === e.currentTarget &&
                            syncingPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId &&
                            removingPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId &&
                            restoringPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId
                        ) {
                            setPaymentMethodManagePm(null);
                        }
                    }}
                >
                    <div
                        className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
                        role="dialog"
                        aria-labelledby="payment-method-actions-title"
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-4 mb-4">
                            <div>
                                <h3 id="payment-method-actions-title" className="text-lg font-semibold text-gray-900">
                                    {isRemovedPaymentMethod(resolvedPaymentMethodManage)
                                        ? 'Removed payment method'
                                        : 'Payment method'}
                                </h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    if (
                                        syncingPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId &&
                                        removingPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId &&
                                        restoringPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId
                                    ) {
                                        setPaymentMethodManagePm(null);
                                    }
                                }}
                                disabled={
                                    syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                    removingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                    restoringPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId
                                }
                                className="text-gray-400 hover:text-gray-600 disabled:opacity-50 shrink-0"
                                aria-label="Close"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 mb-4">
                            <div className="flex items-start gap-3">
                                <div className="p-2 rounded-lg bg-white border border-gray-200">
                                    {resolvedPaymentMethodManage.paymentMethodType === 'ACH' ? (
                                        <Building className="h-5 w-5 text-oe-primary" />
                                    ) : (
                                        <CreditCard className="h-5 w-5 text-oe-primary" />
                                    )}
                                </div>
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-medium text-gray-900">
                                            {getPaymentMethodDisplay(resolvedPaymentMethodManage)}
                                        </span>
                                        {isRemovedPaymentMethod(resolvedPaymentMethodManage) && (
                                            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">
                                                Removed
                                            </span>
                                        )}
                                        {resolvedPaymentMethodManage.isDefault && (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                                <Star className="h-3 w-3" />
                                                Primary
                                            </span>
                                        )}
                                        {!resolvedPaymentMethodManage.processorPaymentMethodId && (
                                            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                                                Not saved to payment processor
                                            </span>
                                        )}
                                    </div>
                                    {resolvedPaymentMethodManage.bankName && (
                                        <p className="text-sm text-gray-500 mt-1">{resolvedPaymentMethodManage.bankName}</p>
                                    )}
                                    {resolvedPaymentMethodManage.cardholderName && (
                                        <p className="text-sm text-gray-700 mt-1">
                                            <span className="text-gray-500">Cardholder:</span> {resolvedPaymentMethodManage.cardholderName}
                                        </p>
                                    )}
                                    {resolvedPaymentMethodManage.accountHolderName && (
                                        <p className="text-sm text-gray-700 mt-1">
                                            <span className="text-gray-500">Account holder:</span>{' '}
                                            {resolvedPaymentMethodManage.accountHolderName}
                                        </p>
                                    )}
                                    {String(resolvedPaymentMethodManage.paymentMethodType).toUpperCase() !== 'ACH' &&
                                        (resolvedPaymentMethodManage.expiryMonth != null ||
                                            resolvedPaymentMethodManage.expiryYear != null) && (
                                            <p className="text-sm text-gray-700 mt-1">
                                                <span className="text-gray-500">Expires:</span>{' '}
                                                {String(resolvedPaymentMethodManage.expiryMonth ?? '—').padStart(2, '0')}/
                                                {resolvedPaymentMethodManage.expiryYear ?? '—'}
                                            </p>
                                        )}
                                    {String(resolvedPaymentMethodManage.paymentMethodType).toUpperCase() === 'ACH' &&
                                        resolvedPaymentMethodManage.routingNumber && (
                                            <p className="text-sm text-gray-700 mt-1 font-mono">
                                                <span className="text-gray-500 font-sans">Routing:</span>{' '}
                                                {resolvedPaymentMethodManage.routingNumber}
                                            </p>
                                        )}
                                    {(resolvedPaymentMethodManage.billingAddress ||
                                        resolvedPaymentMethodManage.billingCity) && (
                                        <div className="text-sm text-gray-700 mt-2 border-t border-gray-200 pt-2">
                                            <span className="text-gray-500 block text-xs uppercase tracking-wide mb-0.5">
                                                Billing address
                                            </span>
                                            {[resolvedPaymentMethodManage.billingAddress, resolvedPaymentMethodManage.billingAddress2]
                                                .filter(Boolean)
                                                .join(', ')}
                                            <br />
                                            {[
                                                resolvedPaymentMethodManage.billingCity,
                                                resolvedPaymentMethodManage.billingState,
                                                resolvedPaymentMethodManage.billingZip,
                                            ]
                                                .filter(Boolean)
                                                .join(', ')}
                                        </div>
                                    )}
                                    {(resolvedPaymentMethodManage.processorCustomerId ||
                                        resolvedPaymentMethodManage.processorPaymentMethodId) && (
                                        <div className="text-xs text-gray-600 mt-2 space-y-1 font-mono break-all">
                                            {resolvedPaymentMethodManage.processorCustomerId && (
                                                <div>
                                                    <span className="text-gray-500 font-sans">DIME customer: </span>
                                                    {resolvedPaymentMethodManage.processorCustomerId}
                                                </div>
                                            )}
                                            {resolvedPaymentMethodManage.processorPaymentMethodId && (
                                                <div>
                                                    <span className="text-gray-500 font-sans">DIME payment method: </span>
                                                    {resolvedPaymentMethodManage.processorPaymentMethodId}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {(() => {
                            const auditAdded = formatPaymentMethodAddedAt(resolvedPaymentMethodManage.createdDate);
                            const auditUpdated =
                                formatPaymentMethodLastUpdatedSubtitle(resolvedPaymentMethodManage);
                            if (!auditAdded && !auditUpdated) return null;
                            return (
                                <div className="text-xs text-gray-500 mb-4 space-y-0.5 border border-gray-200 rounded-lg bg-white px-4 py-3">
                                    {auditAdded && <p>Added {auditAdded}</p>}
                                    {auditUpdated && <p>{auditUpdated}</p>}
                                </div>
                            );
                        })()}

                        <div className="flex flex-col gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    const row = resolvedPaymentMethodManage;
                                    setPaymentMethodManagePm(null);
                                    setPaymentMethodToEdit(row);
                                }}
                                disabled={
                                    syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                    restoringPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId
                                }
                                className="inline-flex justify-center items-center gap-2 px-4 py-2.5 border border-oe-primary rounded-lg text-sm font-medium text-oe-primary bg-white hover:bg-blue-50 disabled:opacity-50 disabled:pointer-events-none"
                            >
                                <Pencil className="h-4 w-4" />
                                Edit billing &amp; details
                            </button>
                            {!resolvedPaymentMethodManage.processorPaymentMethodId ? (
                                <button
                                    type="button"
                                    onClick={async () => {
                                        const o = await handleAddToPaymentProcessor(resolvedPaymentMethodManage);
                                        if (o === 'ok') setPaymentMethodManagePm(null);
                                    }}
                                    disabled={
                                        syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                        restoringPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId
                                    }
                                    className="inline-flex justify-center items-center gap-2 px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-800 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:pointer-events-none"
                                >
                                    {syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ? (
                                        <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Saving to processor…
                                        </>
                                    ) : (
                                        'Add to payment processor'
                                    )}
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    title={REPLACE_VAULT_AT_PROCESSOR_TITLE}
                                    onClick={async () => {
                                        const o = await handleReplaceProcessorVault(resolvedPaymentMethodManage);
                                        if (o === 'ok') setPaymentMethodManagePm(null);
                                    }}
                                    disabled={
                                        syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                        restoringPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId
                                    }
                                    className="inline-flex justify-center items-center gap-2 px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-800 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:pointer-events-none"
                                >
                                    {syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ? (
                                        <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Replacing vault…
                                        </>
                                    ) : (
                                        <>
                                            <RefreshCw className="h-4 w-4" />
                                            Replace vault at processor
                                        </>
                                    )}
                                </button>
                            )}
                            {isRemovedPaymentMethod(resolvedPaymentMethodManage) ? (
                                <button
                                    type="button"
                                    onClick={() => handleRestorePaymentMethod(resolvedPaymentMethodManage)}
                                    disabled={
                                        syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                        restoringPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId
                                    }
                                    className="inline-flex justify-center items-center gap-2 px-4 py-2.5 border border-green-200 rounded-lg text-sm font-medium text-green-700 bg-white hover:bg-green-50 disabled:opacity-50 disabled:pointer-events-none"
                                >
                                    {restoringPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ? (
                                        <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Restoring…
                                        </>
                                    ) : (
                                        <>
                                            <RotateCcw className="h-4 w-4" />
                                            Restore for member portal
                                        </>
                                    )}
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => handleRemovePaymentMethod(resolvedPaymentMethodManage)}
                                    disabled={
                                        syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                        removingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                        restoringPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId
                                    }
                                    className="inline-flex justify-center items-center gap-2 px-4 py-2.5 border border-red-200 rounded-lg text-sm font-medium text-red-700 bg-white hover:bg-red-50 disabled:opacity-50 disabled:pointer-events-none"
                                >
                                    {removingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ? (
                                        <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Removing…
                                        </>
                                    ) : (
                                        <>
                                            <Trash2 className="h-4 w-4" />
                                            Remove from member portal
                                        </>
                                    )}
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    if (
                                        syncingPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId &&
                                        removingPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId &&
                                        restoringPaymentMethodId !== resolvedPaymentMethodManage.paymentMethodId
                                    ) {
                                        setPaymentMethodManagePm(null);
                                    }
                                }}
                                disabled={
                                    syncingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                    removingPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId ||
                                    restoringPaymentMethodId === resolvedPaymentMethodManage.paymentMethodId
                                }
                                className="text-sm font-medium text-gray-600 hover:text-gray-900 py-2 disabled:opacity-50"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* CVV prompt modal — DIME rejected the card-on-file re-vault because it needs the */}
            {/* card's CVV. PCI DSS 3.2.2: the value stays in React state only for this modal's */}
            {/* lifetime and is discarded as soon as it's sent to the server. */}
            {cvvPromptPm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
                    <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <h3 className="text-lg font-semibold text-gray-900">Confirm CVV</h3>
                                <p className="text-sm text-gray-600 mt-1">
                                    The payment processor needs the CVV to re-save{' '}
                                    <span className="font-medium">
                                        {cvvPromptPm.cardBrand || 'card'} •••• {cvvPromptPm.cardLast4 || '****'}
                                    </span>
                                    . Ask the member for the 3-4 digit security code on the back of the card.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={closeCvvPrompt}
                                disabled={cvvPromptSubmitting}
                                className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                                aria-label="Close"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 mb-4">
                            <p className="text-xs text-blue-900">
                                The CVV is sent straight to the payment processor and never stored.
                            </p>
                        </div>
                        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="cvv-prompt-input">
                            CVV
                        </label>
                        <input
                            id="cvv-prompt-input"
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            maxLength={4}
                            placeholder="123"
                            value={cvvPromptValue}
                            onChange={(e) => {
                                const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 4);
                                setCvvPromptValue(digitsOnly);
                                if (cvvPromptError) setCvvPromptError(null);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !cvvPromptSubmitting) {
                                    e.preventDefault();
                                    submitCvvPrompt();
                                }
                            }}
                            disabled={cvvPromptSubmitting}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50 disabled:opacity-50 tracking-widest"
                            autoFocus
                        />
                        {cvvPromptError && (
                            <p className="text-sm text-red-600 mt-2">{cvvPromptError}</p>
                        )}
                        <div className="flex justify-end gap-2 mt-5">
                            <button
                                type="button"
                                onClick={closeCvvPrompt}
                                disabled={cvvPromptSubmitting}
                                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={submitCvvPrompt}
                                disabled={cvvPromptSubmitting || !cvvPromptValue}
                                className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 disabled:pointer-events-none"
                            >
                                {cvvPromptSubmitting ? (
                                    <>
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                        Retrying…
                                    </>
                                ) : (
                                    'Retry with CVV'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MemberPaymentsTab;


