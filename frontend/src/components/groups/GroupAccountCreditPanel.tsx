// File: frontend/src/components/groups/GroupAccountCreditPanel.tsx
//
// Group-scoped twin of AccountCreditPanel from MemberPaymentsTab. Renders the
// group's available credit balance and ledger history (one row per source
// entry with applied/voided rolled up). TenantAdmin / SysAdmin can issue new
// goodwill credits and void unspent ones.

import { DollarSign } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useGroupCredits } from '../../hooks/useHouseholdCredits';
import {
    groupCreditsService,
    type CreditEntry
} from '../../services/householdCredits.service';
import AddManualCreditModal from '../../pages/members/modals/AddManualCreditModal';

interface GroupInvoiceRef {
    InvoiceId: string;
    InvoiceNumber?: string | null;
    BillingPeriodStart?: string | null;
    Status?: string | null;
    TotalAmount?: number | string | null;
    PaidAmount?: number | string | null;
    CreditAmount?: number | string | null;
    BalanceDue?: number | string | null;
}

interface Props {
    groupId: string;
    groupName?: string;
    tenantId?: string;
    canManageCredits?: boolean;
    /** Used both for invoice-number lookups and the apply-now preview. */
    invoices?: GroupInvoiceRef[];
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

const GroupAccountCreditPanel: React.FC<Props> = ({ groupId, groupName, tenantId, canManageCredits, invoices }) => {
    const credits = useGroupCredits(groupId);
    const [showHistory, setShowHistory] = useState(false);
    const [showAddCreditModal, setShowAddCreditModal] = useState(false);
    const [confirmingVoidId, setConfirmingVoidId] = useState<string | null>(null);
    const [voidReason, setVoidReason] = useState<string>('');
    const [voidingId, setVoidingId] = useState<string | null>(null);

    const sourceRows = useMemo(() => {
        const entries: CreditEntry[] = credits.data?.byEntry || [];
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
                    .map(c => ({ invoiceId: c.TargetInvoiceId || '', amount: Math.abs(Number(c.Amount) || 0) }));
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
    }, [credits.data?.byEntry]);

    const invoiceLookup = useMemo(() => {
        const map: Record<string, { number?: string | null }> = {};
        for (const inv of invoices || []) {
            map[inv.InvoiceId] = { number: inv.InvoiceNumber || null };
        }
        return map;
    }, [invoices]);

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
        const meta = invoiceLookup[invoiceId];
        return meta?.number ? `#${meta.number}` : 'invoice';
    };

    const handleConfirmVoid = async (entryId: string) => {
        setVoidingId(entryId);
        try {
            await groupCreditsService.voidEntry(entryId, voidReason.trim() || undefined);
            toast.success('Credit voided');
            setConfirmingVoidId(null);
            setVoidReason('');
            credits.refetch();
        } catch (e) {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            toast.error(err?.response?.data?.message || err?.message || 'Failed to void credit');
        } finally {
            setVoidingId(null);
        }
    };

    if (credits.isLoading) return null;

    const available = Number(credits.data?.availableCredit || 0);
    const hasAvailable = Math.abs(available) >= 0.005;
    const hasHistory = sourceRows.length > 0;

    // Visibility:
    //  - TenantAdmin / SysAdmin (canManageCredits): always visible so they
    //    can issue / void credits whenever, even at $0.
    //  - Agent / GroupAdmin: only when there's a non-zero available balance.
    //    History alone is not enough — they don't need to see prior activity
    //    if nothing's currently sitting on the account.
    if (!canManageCredits && !hasAvailable) return null;

    const invoiceOptionsForModal = (invoices || []).map(inv => ({
        InvoiceId: inv.InvoiceId,
        InvoiceNumber: inv.InvoiceNumber,
        BillingPeriodStart: inv.BillingPeriodStart,
        TotalAmount: typeof inv.TotalAmount === 'number' ? inv.TotalAmount : Number(inv.TotalAmount) || 0,
        PaidAmount: typeof inv.PaidAmount === 'number' ? inv.PaidAmount : Number(inv.PaidAmount) || 0,
        CreditAmount: typeof inv.CreditAmount === 'number' ? inv.CreditAmount : Number(inv.CreditAmount) || 0,
        BalanceDue: typeof inv.BalanceDue === 'number' ? inv.BalanceDue : Number(inv.BalanceDue) || 0,
        Status: inv.Status
    }));

    return (
        <>
            <div className="bg-white rounded-lg border border-gray-200">
                <div className="p-4 flex items-start justify-between">
                    <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-oe-light flex items-center justify-center">
                            <DollarSign className="h-5 w-5 text-oe-primary" />
                        </div>
                        <div>
                            <div className="text-sm text-gray-500">Group account credit</div>
                            <div className="text-2xl font-semibold text-gray-900">${available.toFixed(2)}</div>
                            <div className="text-xs text-gray-500">
                                {hasAvailable
                                    ? "Auto-applied to this group's next unpaid invoice on the next nightly run."
                                    : (hasHistory
                                        ? 'No active group balance — view history for past credit activity.'
                                        : 'No group credit on file.')}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {canManageCredits && tenantId && (
                            <button
                                type="button"
                                onClick={() => setShowAddCreditModal(true)}
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

                {showHistory && hasHistory && (
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
                                                            Voiding will remove the remaining <strong>${remaining.toFixed(2)}</strong> from this group's credit balance. Already-applied portions are preserved.
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

            {showAddCreditModal && tenantId && (
                <AddManualCreditModal
                    groupId={groupId}
                    tenantId={tenantId}
                    memberName={groupName}
                    invoices={invoiceOptionsForModal}
                    onClose={() => setShowAddCreditModal(false)}
                    onSuccess={() => { credits.refetch(); }}
                />
            )}
        </>
    );
};

export default GroupAccountCreditPanel;
