// CaseLedgerTab — editable ledger (transactions) for a Case. Copied from
// share-requests/tabs/LedgerTab and adapted: the Case ledger offers the SR
// transaction set MINUS the UA types, and drops the UA-reduction stat. See
// docs/billing-rework/case-finances-design.md.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, Pencil, Plus, Trash2, Wallet, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import {
  type CaseTransaction,
  type CaseTransactionType,
  type CaseBill,
  CASE_TRANSACTION_TYPES,
  caseTransactionTypeLabel,
} from '../../../../types/case.types';
import {
  type PaymentType,
  type TransactionStatus,
  PAYMENT_TYPES,
  TRANSACTION_STATUSES,
} from '../../../../types/shareRequest.types';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface CaseLedgerTabProps {
  caseId: string;
  /** Notify the parent Finances tab so the summary cards refresh. */
  onChanged?: () => void;
}

interface TransactionsResponse {
  success: boolean;
  data: CaseTransaction[];
}

interface BillsResponse {
  success: boolean;
  data: CaseBill[];
}

interface TxForm {
  billId: string;
  transactionType: CaseTransactionType;
  paymentType: PaymentType | '';
  transactionStatus: TransactionStatus;
  amount: string;
  transactionDate: string;
  referenceNumber: string;
  description: string;
}

const emptyForm: TxForm = {
  billId: '',
  transactionType: 'Payment to Provider',
  paymentType: '',
  transactionStatus: 'Pending',
  amount: '',
  transactionDate: new Date().toISOString().split('T')[0],
  referenceNumber: '',
  description: '',
};

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const fmtCurrency = (n?: number) =>
  typeof n === 'number'
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
    : '$0.00';

const CaseLedgerTab = ({ caseId, onChanged }: CaseLedgerTabProps) => {
  const [txs, setTxs] = useState<CaseTransaction[]>([]);
  const [bills, setBills] = useState<CaseBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<TxForm>(emptyForm);

  const toInputDate = (v?: string | null) => {
    if (!v) return new Date().toISOString().split('T')[0];
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date().toISOString().split('T')[0] : d.toISOString().split('T')[0];
  };

  const openAdd = () => {
    setEditingTxId(null);
    setForm(emptyForm);
    setShowAdd(true);
  };

  const openEdit = (t: CaseTransaction) => {
    setEditingTxId(t.TransactionId);
    setForm({
      billId: t.BillId ?? '',
      transactionType: t.TransactionType,
      paymentType: t.PaymentType ?? '',
      transactionStatus: t.TransactionStatus,
      amount: t.Amount != null ? String(t.Amount) : '',
      transactionDate: toInputDate(t.TransactionDate),
      referenceNumber: t.ReferenceNumber ?? '',
      description: t.Description ?? '',
    });
    setShowAdd(true);
  };

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [txRes, billsRes] = await Promise.all([
          apiService.get<TransactionsResponse>(
            `/api/me/vendor/cases/${caseId}/transactions`,
            signal ? { signal } : undefined
          ),
          apiService.get<BillsResponse>(
            `/api/me/vendor/cases/${caseId}/bills`,
            signal ? { signal } : undefined
          ),
        ]);
        if (signal?.aborted) return;
        if (txRes.success) setTxs(txRes.data);
        if (billsRes.success) setBills(billsRes.data);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load ledger');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [caseId]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const totalsByType = txs.reduce<Record<string, number>>((acc, t) => {
    acc[t.TransactionType] = (acc[t.TransactionType] ?? 0) + t.Amount;
    return acc;
  }, {});

  const handleSave = async () => {
    if (!form.amount) {
      window.alert('Amount is required');
      return;
    }
    const amountNum = parseFloat(form.amount);
    if (!Number.isFinite(amountNum)) {
      window.alert('Amount must be a number');
      return;
    }
    // Guard the discount-by-new-total path: a new total above the bill produces a
    // negative discount (and a total below 0 is nonsensical).
    if (form.transactionType === 'Discount' && amountNum < 0) {
      window.alert('The new bill total cannot be greater than the original billed amount.');
      return;
    }
    const payload = {
      billId: form.billId || (editingTxId ? null : undefined),
      transactionType: form.transactionType,
      paymentType: form.paymentType || (editingTxId ? null : undefined),
      transactionStatus: form.transactionStatus,
      amount: parseFloat(form.amount),
      transactionDate: form.transactionDate,
      referenceNumber: form.referenceNumber || (editingTxId ? null : undefined),
      description: form.description || (editingTxId ? null : undefined),
    };
    setSaving(true);
    try {
      if (editingTxId) {
        await apiService.put(`/api/me/vendor/cases/${caseId}/transactions/${editingTxId}`, payload);
      } else {
        await apiService.post(`/api/me/vendor/cases/${caseId}/transactions`, payload);
      }
      setForm(emptyForm);
      setShowAdd(false);
      setEditingTxId(null);
      await load();
      onChanged?.();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to save transaction');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (txId: string) => {
    if (!window.confirm('Delete this transaction?')) return;
    try {
      await apiService.delete(`/api/me/vendor/cases/${caseId}/transactions/${txId}`);
      await load();
      onChanged?.();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete transaction');
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Ledger</h2>
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add transaction
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-red-600 text-sm">
          <CircleAlert className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : (
        <>
          {txs.length === 0 ? (
            <EmptyState icon={Wallet} title="No transactions" description="Record the first transaction." tone="subtle" />
          ) : (
            <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <Th>Date</Th>
                    <Th>Type</Th>
                    <Th>Payment</Th>
                    <Th>Status</Th>
                    <Th>Bill #</Th>
                    <Th>Reference</Th>
                    <Th align="right">Amount</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {txs.map((t) => (
                    <tr key={t.TransactionId}>
                      <Td>{fmtDate(t.TransactionDate)}</Td>
                      <Td>
                        <span>{caseTransactionTypeLabel(t.TransactionType)}</span>
                        {t.Description && (
                          <span className="block text-[12px] text-gray-500 font-normal whitespace-pre-wrap">
                            {t.Description}
                          </span>
                        )}
                      </Td>
                      <Td>{t.PaymentType ?? '—'}</Td>
                      <Td>{t.TransactionStatus}</Td>
                      <Td className="font-mono text-[12px]">{t.BillNumber ?? '—'}</Td>
                      <Td className="font-mono text-[12px]">{t.ReferenceNumber ?? '—'}</Td>
                      <Td align="right" className="font-medium">{fmtCurrency(t.Amount)}</Td>
                      <Td>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(t)}
                            className="p-1 text-gray-400 hover:text-oe-primary rounded"
                            aria-label="Edit transaction"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(t.TransactionId)}
                            className="p-1 text-gray-400 hover:text-red-600 rounded"
                            aria-label="Delete transaction"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Ledger breakdown — decomposes the figures the top summary cards
              (Billed / Saved / Member paid / Reimbursed / Balance) don't show
              on their own: Member payments, Discounts, Financial aid, Provider
              payments. (No UA on cases.) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-50 border border-gray-200 rounded-lg p-4">
            <Stat label="Member paid" value={fmtCurrency(totalsByType['Member Payment'] ?? 0)} />
            <Stat label="Discounts" value={fmtCurrency(totalsByType['Discount'] ?? 0)} />
            <Stat label="Financial aid" value={fmtCurrency(totalsByType['Financial Aid'] ?? 0)} />
            <Stat label="Provider payments" value={fmtCurrency(totalsByType['Payment to Provider'] ?? 0)} />
          </div>
        </>
      )}

      {showAdd && (
        <TxModal
          form={form}
          editing={!!editingTxId}
          bills={bills}
          saving={saving}
          onChange={setForm}
          onSave={handleSave}
          onClose={() => { setShowAdd(false); setEditingTxId(null); }}
        />
      )}
    </div>
  );
};

interface TxModalProps {
  form: TxForm;
  editing: boolean;
  bills: CaseBill[];
  saving: boolean;
  onChange: (form: TxForm) => void;
  onSave: () => void;
  onClose: () => void;
}

const TxModal = ({ form, editing, bills, saving, onChange, onSave, onClose }: TxModalProps) => {
  const selectedBill = form.billId ? bills.find((b) => b.BillId === form.billId) ?? null : null;
  // "Enter new total" mode is only offered for a Discount tied to a specific bill
  // whose billed amount we know.
  const discountByTotal =
    form.transactionType === 'Discount' && !!selectedBill && Number.isFinite(selectedBill.BilledAmount);
  const newTotalInput =
    discountByTotal && form.amount !== '' && Number.isFinite(parseFloat(form.amount))
      ? (selectedBill!.BilledAmount - parseFloat(form.amount)).toFixed(2)
      : '';
  return (
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="add-case-tx-title"
    className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4"
    onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div className="w-full max-w-xl bg-white rounded-lg shadow-xl p-4 space-y-3 max-h-[90vh] overflow-y-auto">
      <div className="flex items-center justify-between">
        <h3 id="add-case-tx-title" className="text-base font-semibold text-gray-900">
          {editing ? 'Edit transaction' : 'Add transaction'}
        </h3>
        <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Bill (optional)" className="col-span-2">
          <select
            value={form.billId}
            onChange={(e) => {
              const next = { ...form, billId: e.target.value };
              if (form.transactionType === 'Discount') next.amount = '';
              onChange(next);
            }}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          >
            <option value="">No specific bill</option>
            {bills.map((b) => (
              <option key={b.BillId} value={b.BillId}>
                {b.BillNumber ?? `Bill ${b.BillId.slice(0, 8)}`} — {b.ProviderName ?? '—'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Type *">
          <select
            value={form.transactionType}
            onChange={(e) => {
              const nextType = e.target.value as CaseTransactionType;
              const next = { ...form, transactionType: nextType };
              if ((form.transactionType === 'Discount') !== (nextType === 'Discount')) {
                next.amount = '';
              }
              onChange(next);
            }}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          >
            {CASE_TRANSACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {caseTransactionTypeLabel(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Payment method">
          <select
            value={form.paymentType}
            onChange={(e) => onChange({ ...form, paymentType: e.target.value as PaymentType | '' })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          >
            <option value="">—</option>
            {PAYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            value={form.transactionStatus}
            onChange={(e) => onChange({ ...form, transactionStatus: e.target.value as TransactionStatus })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          >
            {TRANSACTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date *">
          <input
            type="date"
            value={form.transactionDate}
            onChange={(e) => onChange({ ...form, transactionDate: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        {discountByTotal ? (
          <Field label="New bill total *">
            <input
              type="number"
              step="0.01"
              value={newTotalInput}
              onChange={(e) => {
                const newTotal = e.target.value;
                const disc = newTotal === '' ? '' : (selectedBill!.BilledAmount - parseFloat(newTotal)).toFixed(2);
                onChange({ ...form, amount: disc });
              }}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
            />
            <p className="mt-1 text-xs text-gray-500">
              Was {fmtCurrency(selectedBill!.BilledAmount)}
              {form.amount !== '' && Number.isFinite(parseFloat(form.amount))
                ? ` → discount of ${fmtCurrency(parseFloat(form.amount))}`
                : ''}
            </p>
          </Field>
        ) : (
          <Field label="Amount *">
            <input
              type="number"
              step="0.01"
              value={form.amount}
              onChange={(e) => onChange({ ...form, amount: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
            />
          </Field>
        )}
        <Field label="Reference #">
          <input
            type="text"
            value={form.referenceNumber}
            onChange={(e) => onChange({ ...form, referenceNumber: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded font-mono"
          />
        </Field>
        <Field label="Description" className="col-span-2">
          <textarea
            value={form.description}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
            rows={2}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg">
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  </div>
  );
};

const Stat = ({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
    <div className={`text-base font-semibold ${accent ? 'text-oe-primary' : 'text-gray-900'}`}>{value}</div>
  </div>
);

const Th = ({ children, align = 'left' }: { children?: ReactNode; align?: 'left' | 'right' }) => (
  <th className={`px-4 py-2 text-${align} text-[11px] font-medium text-gray-500 uppercase tracking-wider`}>
    {children}
  </th>
);

const Td = ({
  children,
  className = '',
  align = 'left',
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) => (
  <td className={`px-4 py-2 text-gray-700 text-${align} ${className}`}>{children}</td>
);

const Field = ({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) => (
  <div className={className}>
    <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
    {children}
  </div>
);

export default CaseLedgerTab;
