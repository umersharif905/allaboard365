// File: frontend/src/components/billing/BillingDriftModal.tsx
//
// Self-contained drilldown for the "Billing drift / Over-billed invoices"
// auditor. Lists candidate invoices and lets an admin issue a credit per row
// using the existing household credit ledger. The original invoice is never
// mutated — credits flow through oe.HouseholdCreditEntries and reduce
// BalanceDue via the computed column.

import { AlertTriangle, Loader2, X } from 'lucide-react';
import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { useBillingDrift } from '../../hooks/useBillingDrift';
import { billingDriftService, type BillingDriftCandidate } from '../../services/billingDrift.service';

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatMoney(n: number) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function formatPeriod(c: BillingDriftCandidate) {
  if (!c.billingPeriodStart) return '—';
  const d = new Date(c.billingPeriodStart);
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Matches server cap: min(requested, suggestedCredit) or full suggested. */
function creditAmountForFix(c: BillingDriftCandidate, overrideAmountStr: string): number {
  const requested = Number(overrideAmountStr);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(requested, c.suggestedCredit);
  }
  return c.suggestedCredit;
}

function balanceDueOnInvoice(c: BillingDriftCandidate): number {
  const raw =
    (Number(c.totalAmount) || 0) -
    (Number(c.paidAmount) || 0) -
    (Number(c.creditAlreadyApplied) || 0);
  return Math.max(0, Math.round(raw * 100) / 100);
}

export default function BillingDriftModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useBillingDrift({ enabled: open, limit: 500 });
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [overrideAmount, setOverrideAmount] = useState<string>('');
  const [overrideNotes, setOverrideNotes] = useState<string>('');

  if (!open) return null;

  const beginConfirm = (c: BillingDriftCandidate) => {
    setConfirmId(c.invoiceId);
    setOverrideAmount(c.suggestedCredit.toFixed(2));
    setOverrideNotes('');
  };

  const cancelConfirm = () => {
    setConfirmId(null);
    setOverrideAmount('');
    setOverrideNotes('');
  };

  const handleIssue = async (c: BillingDriftCandidate) => {
    setIssuingId(c.invoiceId);
    try {
      const requested = Number(overrideAmount);
      const amount = Number.isFinite(requested) && requested > 0 ? requested : undefined;
      await billingDriftService.issueCredit({
        invoiceId: c.invoiceId,
        amount,
        notes: overrideNotes.trim() || undefined
      });
      toast.success(`Fixed overcharge (${formatMoney(amount ?? c.suggestedCredit)}) for ${c.memberName || 'household'}`);
      cancelConfirm();
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['household-credits'] });
      await queryClient.invalidateQueries({ queryKey: ['household-credits-balances'] });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
    } catch (e) {
      const err = e as { response?: { data?: { message?: string } }; message?: string };
      toast.error(err?.response?.data?.message || err?.message || 'Could not apply fix');
    } finally {
      setIssuingId(null);
    }
  };

  const candidates = data?.candidates || [];
  const summary = data?.summary || { count: 0, totalSuggestedCredit: 0 };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 z-50 overflow-y-auto" onClick={onClose}>
      <div
        className="relative top-12 mx-auto p-0 border w-[1100px] max-w-[97vw] shadow-lg rounded-lg bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-yellow-100 flex items-center justify-center">
              <AlertTriangle className="h-5 w-5 text-yellow-700" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Over-billed invoices</h3>
              <p className="text-xs text-gray-500">
                Billed amount is higher than what active enrollments imply for that period. <strong>Fix</strong> applies credit so
                balances match what they should be—the original billed line on the invoice is not rewritten.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="text-sm text-gray-700">
            {isLoading ? (
              <span>Scanning…</span>
            ) : (
              <>
                <span className="font-semibold">{summary.count}</span> invoice{summary.count === 1 ? '' : 's'} flagged ·{' '}
                <span className="font-semibold">{formatMoney(summary.totalSuggestedCredit)}</span> total over-billed
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-sm text-oe-primary hover:text-oe-dark disabled:opacity-50 inline-flex items-center gap-1"
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Refresh
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : candidates.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-gray-300" />
              <p>No over-billed invoices detected.</p>
            </div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Member</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Invoice</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Billed</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Should be</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Already credited</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Overcharge</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Likely cause</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {candidates.map((c) => {
                  const isConfirming = confirmId === c.invoiceId;
                  const dropped = (c.droppedItems || []).filter(d => d.productName);
                  const previewCredit = isConfirming ? creditAmountForFix(c, overrideAmount) : 0;
                  const dueNow = balanceDueOnInvoice(c);
                  const toThisInvoice = isConfirming ? Math.min(previewCredit, dueNow) : 0;
                  const dueAfter = isConfirming ? Math.max(0, Math.round((dueNow - toThisInvoice) * 100) / 100) : 0;
                  return (
                    <React.Fragment key={c.invoiceId}>
                      <tr className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-sm text-gray-900">
                          <div className="font-medium">{c.memberName || '—'}</div>
                          {c.memberEmail && <div className="text-xs text-gray-500">{c.memberEmail}</div>}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-700 whitespace-nowrap">{c.invoiceNumber || c.invoiceId.slice(0, 8)}</td>
                        <td className="px-3 py-2 text-sm text-gray-700 whitespace-nowrap">{formatPeriod(c)}</td>
                        <td className="px-3 py-2 text-sm text-right text-gray-700 whitespace-nowrap">{formatMoney(c.totalAmount)}</td>
                        <td className="px-3 py-2 text-sm text-right text-gray-700 whitespace-nowrap">{formatMoney(c.recomputedTotal)}</td>
                        <td className="px-3 py-2 text-sm text-right text-gray-500 whitespace-nowrap">{formatMoney(c.creditAlreadyApplied)}</td>
                        <td className="px-3 py-2 text-sm text-right font-semibold text-yellow-800 whitespace-nowrap">{formatMoney(c.suggestedCredit)}</td>
                        <td className="px-3 py-2 text-xs text-gray-600 max-w-[260px]">
                          {dropped.length > 0 ? (
                            <ul className="space-y-0.5">
                              {dropped.slice(0, 3).map((d) => (
                                <li key={d.enrollmentId} className="truncate">
                                  {d.productName} · {formatMoney(d.premiumAmount)}
                                </li>
                              ))}
                              {dropped.length > 3 && <li className="text-gray-400">+ {dropped.length - 3} more</li>}
                            </ul>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {!isConfirming && (
                            <button
                              type="button"
                              onClick={() => beginConfirm(c)}
                              className="text-xs font-medium text-oe-primary hover:text-oe-dark"
                            >
                              Fix
                            </button>
                          )}
                        </td>
                      </tr>
                      {isConfirming && (
                        <tr className="bg-yellow-50">
                          <td colSpan={9} className="px-3 py-3">
                            <div className="rounded-md border border-yellow-200 bg-white px-3 py-2 mb-3 text-sm text-gray-800 space-y-2">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span className="text-gray-500 text-xs font-medium uppercase tracking-wide">
                                  Align to enrollments
                                </span>
                                <span className="font-semibold tabular-nums">
                                  {formatMoney(c.totalAmount)} → {formatMoney(c.recomputedTotal)}
                                </span>
                                <span className="text-xs text-gray-500">(billed line stays; credit closes the gap)</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-gray-500 text-xs font-medium uppercase tracking-wide">
                                  Credit for overcharge
                                </span>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0.01"
                                  max={c.suggestedCredit}
                                  value={overrideAmount}
                                  onChange={(ev) => setOverrideAmount(ev.target.value)}
                                  className="w-28 px-2 py-1 border border-gray-300 rounded text-xs tabular-nums"
                                />
                                <span className="text-gray-600 text-xs">
                                  max {formatMoney(c.suggestedCredit)} · applies as{' '}
                                  <span className="font-medium text-gray-900">{formatMoney(previewCredit)}</span>
                                </span>
                              </div>
                              {dueNow >= 0.01 ? (
                                <div className="text-xs text-gray-700">
                                  <span className="font-medium text-gray-600">Balance due on this invoice: </span>
                                  <span className="tabular-nums">
                                    {formatMoney(dueNow)} → {formatMoney(dueAfter)}
                                  </span>
                                  {previewCredit > toThisInvoice + 0.005 && (
                                    <span className="text-gray-500">
                                      {' '}
                                      · {formatMoney(previewCredit - toThisInvoice)} can apply to other unpaid invoices
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <div className="text-xs text-gray-700">
                                  This invoice is already paid.{' '}
                                  <span className="font-medium">{formatMoney(previewCredit)}</span> goes to the household as
                                  credit for future bills.
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={overrideNotes}
                                onChange={(ev) => setOverrideNotes(ev.target.value)}
                                placeholder="Notes (optional — auto-filled if blank)"
                                maxLength={500}
                                className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => handleIssue(c)}
                                disabled={issuingId === c.invoiceId}
                                className="px-3 py-1.5 bg-oe-primary text-white rounded-lg text-xs font-medium hover:bg-oe-dark disabled:opacity-50 inline-flex items-center gap-1"
                              >
                                {issuingId === c.invoiceId ? (
                                  <>
                                    <Loader2 className="h-3 w-3 animate-spin" /> Applying…
                                  </>
                                ) : (
                                  'Apply fix'
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={cancelConfirm}
                                disabled={issuingId === c.invoiceId}
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
          )}
        </div>
      </div>
    </div>
  );
}
