// File: frontend/src/pages/members/modals/AddManualCreditModal.tsx
import { AlertCircle, DollarSign, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { groupCreditsService, householdCreditsService } from '../../../services/householdCredits.service';

export interface InvoiceOption {
    InvoiceId: string;
    InvoiceNumber?: string | null;
    BillingPeriodStart?: string | null;
    TotalAmount?: number | null;
    PaidAmount?: number | null;
    CreditAmount?: number | null;
    BalanceDue?: number | null;
    Status?: string | null;
}

interface Props {
    /**
     * Pass exactly one of householdId / groupId — the modal stays generic and
     * can issue goodwill against either scope.
     */
    householdId?: string;
    groupId?: string;
    tenantId: string;
    /** Display label, e.g. member's name or group name. */
    memberName?: string;
    /**
     * Optional list of invoices used to render the live preview of which
     * invoices the credit will apply to (oldest-first). Only invoices with a
     * positive open balance are considered.
     */
    invoices?: InvoiceOption[];
    onClose: () => void;
    onSuccess?: () => void;
}

const fmtMoney = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;

const fmtDate = (s?: string | null) => {
    if (!s) return '';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const computeOpenBalance = (inv: InvoiceOption): number => {
    if (typeof inv.BalanceDue === 'number') return Math.max(0, inv.BalanceDue);
    const total = Number(inv.TotalAmount) || 0;
    const paid = Number(inv.PaidAmount) || 0;
    const credit = Number(inv.CreditAmount) || 0;
    return Math.max(0, total - paid - credit);
};

const AddManualCreditModal: React.FC<Props> = ({ householdId, groupId, tenantId, memberName, invoices, onClose, onSuccess }) => {
    const isGroup = !!groupId && !householdId;
    const [amount, setAmount] = useState<string>('');
    const [notes, setNotes] = useState<string>('');
    const [applyNow, setApplyNow] = useState<boolean>(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const queryClient = useQueryClient();

    const openInvoices = useMemo(() => {
        return (invoices || [])
            .filter(inv => !['Cancelled', 'Voided'].includes(String(inv.Status || '')))
            .map(inv => ({ ...inv, openBalance: computeOpenBalance(inv) }))
            .filter(inv => inv.openBalance > 0.005)
            .sort((a, b) => String(a.BillingPeriodStart || '').localeCompare(String(b.BillingPeriodStart || '')));
    }, [invoices]);

    const parsedAmount = parseFloat(amount);

    /**
     * Live preview of FIFO oldest-first allocation across open invoices.
     * Mirrors backend `applyForHousehold` so what you see is what you get.
     */
    const allocationPreview = useMemo(() => {
        if (!applyNow || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return [];
        let leftover = parsedAmount;
        const results: Array<{ inv: (typeof openInvoices)[number]; willApply: number }> = [];
        for (const inv of openInvoices) {
            if (leftover < 0.005) break;
            const willApply = Math.min(leftover, inv.openBalance);
            if (willApply < 0.005) continue;
            results.push({ inv, willApply: Math.round(willApply * 100) / 100 });
            leftover -= willApply;
        }
        return results;
    }, [openInvoices, applyNow, parsedAmount]);

    const remainderToAccount = useMemo(() => {
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return 0;
        if (!applyNow) return parsedAmount;
        const used = allocationPreview.reduce((s, r) => s + r.willApply, 0);
        return Math.max(0, Math.round((parsedAmount - used) * 100) / 100);
    }, [parsedAmount, applyNow, allocationPreview]);

    const handleSubmit = async () => {
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            toast.error('Enter an amount greater than 0.');
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = isGroup
                ? await groupCreditsService.createGoodwill({
                      tenantId,
                      groupId: groupId as string,
                      amount: parsedAmount,
                      notes: notes.trim() || undefined,
                      applyNow
                  })
                : await householdCreditsService.createGoodwill({
                      tenantId,
                      householdId: householdId as string,
                      amount: parsedAmount,
                      notes: notes.trim() || undefined,
                      applyNow
                  });
            const apps = (res as { data?: { applications?: Array<{ appliedAmount: number; invoiceId: string }> } })?.data?.applications || [];
            const total = apps.reduce((s, a) => s + (Number(a.appliedAmount) || 0), 0);
            if (apps.length > 0) {
                toast.success(
                    `Added $${parsedAmount.toFixed(2)} credit; applied $${total.toFixed(2)} across ${apps.length} invoice${apps.length === 1 ? '' : 's'}`
                );
            } else {
                toast.success(`Added $${parsedAmount.toFixed(2)} credit${memberName ? ` to ${memberName}` : ''}`);
            }
            if (isGroup) {
                await queryClient.invalidateQueries({ queryKey: ['group-credits', groupId] });
                await queryClient.invalidateQueries({ queryKey: ['group-credit-balances', groupId] });
            } else {
                await queryClient.invalidateQueries({ queryKey: ['household-credits', householdId] });
                await queryClient.invalidateQueries({ queryKey: ['household-credits-balances'] });
            }
            await queryClient.invalidateQueries({ queryKey: ['invoices'] });
            onSuccess?.();
            onClose();
        } catch (e) {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            const msg = err?.response?.data?.message || err?.message || 'Failed to add credit.';
            setError(msg);
            toast.error(msg);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto">
            <div
                className="fixed inset-0 z-0 bg-gray-500 bg-opacity-75 transition-opacity"
                onClick={() => !submitting && onClose()}
            />
            <div className="relative z-10 flex min-h-full items-center justify-center p-4">
                <div
                    className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                            <DollarSign className="h-5 w-5 text-oe-success" />
                            {isGroup ? 'Add Group Credit' : 'Add Account Credit'}
                        </h3>
                        <button
                            type="button"
                            onClick={onClose}
                            className="text-gray-400 hover:text-gray-600"
                            disabled={submitting}
                        >
                            <X className="h-6 w-6" />
                        </button>
                    </div>

                    <p className="text-sm text-gray-600 mb-4">
                        Issue a goodwill credit to {memberName || (isGroup ? 'this group' : 'this household')}.
                    </p>

                    {error && (
                        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-4 flex items-start gap-3">
                            <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                            <div className="text-sm text-red-700">{error}</div>
                        </div>
                    )}

                    <div className="space-y-4">
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
                                autoFocus
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            />
                        </div>

                        <div>
                            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={applyNow}
                                    onChange={(e) => setApplyNow(e.target.checked)}
                                    disabled={submitting}
                                    className="mt-0.5 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                                />
                                <span>
                                    <span className="font-medium">Apply to unpaid invoices now</span>
                                    <span className="block text-xs text-gray-500 mt-0.5">
                                        Cascades oldest-first. Uncheck to leave on the account for the next nightly run.
                                    </span>
                                </span>
                            </label>

                            {Number.isFinite(parsedAmount) && parsedAmount > 0 && (
                                <div className="mt-2 text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded-lg p-2 space-y-1">
                                    {applyNow && allocationPreview.length === 0 && (
                                        <div>No open invoices — full {fmtMoney(parsedAmount)} will sit on the account.</div>
                                    )}
                                    {applyNow && allocationPreview.map(r => (
                                        <div key={r.inv.InvoiceId}>
                                            Apply <strong>{fmtMoney(r.willApply)}</strong> to{' '}
                                            {r.inv.InvoiceNumber ? `#${r.inv.InvoiceNumber}` : 'invoice'}
                                            {r.inv.BillingPeriodStart ? ` (${fmtDate(r.inv.BillingPeriodStart)})` : ''}
                                            {r.willApply >= r.inv.openBalance - 0.005 ? <> — Paid.</> : (
                                                <> — leaves {fmtMoney(r.inv.openBalance - r.willApply)} due.</>
                                            )}
                                        </div>
                                    ))}
                                    {remainderToAccount > 0.005 && (
                                        <div>
                                            {applyNow ? 'Remaining ' : 'Full '}
                                            <strong>{fmtMoney(remainderToAccount)}</strong>
                                            {applyNow ? ' stays as account credit.' : ' will sit on the account until the next nightly run.'}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Reason / Notes (optional)</label>
                            <textarea
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                placeholder="e.g. Service credit for outage on 4/15"
                                rows={3}
                                disabled={submitting}
                                maxLength={500}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                            />
                            <p className="text-xs text-gray-500 mt-1">{notes.length}/500</p>
                        </div>
                    </div>

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
                            disabled={submitting || !amount || parseFloat(amount) <= 0}
                            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
                        >
                            {submitting ? (
                                <>
                                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                    Adding…
                                </>
                            ) : (
                                <>
                                    <DollarSign className="h-4 w-4" />
                                    {applyNow && allocationPreview.length > 0
                                        ? `Add & apply ${amount ? fmtMoney(parseFloat(amount)) : '$0.00'}`
                                        : `Add ${amount ? fmtMoney(parseFloat(amount)) : '$0.00'} credit`}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AddManualCreditModal;
