import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, Pencil, Plus, Receipt, Trash2, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import {
  type ShareRequestBill,
  type ShareRequestProvider,
  type BillType,
  BILL_TYPES,
} from '../../../../types/shareRequest.types';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';
import ProviderPicker from '../ProviderPicker';

interface BillsTabProps {
  shareRequestId: string;
  /** Notify the parent Finances tab so the summary cards refresh. */
  onChanged?: () => void;
}

interface BillsResponse {
  success: boolean;
  data: ShareRequestBill[];
}

interface ProvidersResponse {
  success: boolean;
  data: ShareRequestProvider[];
}

interface BillForm {
  providerId: string;
  billNumber: string;
  billType: BillType;
  billDate: string;
  dateOfService: string;
  description: string;
  billedAmount: string;
  allowedAmount: string;
  notes: string;
}

const emptyForm: BillForm = {
  providerId: '',
  billNumber: '',
  billType: 'Bill',
  billDate: '',
  dateOfService: '',
  description: '',
  billedAmount: '',
  allowedAmount: '',
  notes: '',
};

const fmtDate = (v?: string) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const fmtCurrency = (n?: number) =>
  typeof n === 'number'
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
    : '$0.00';

const BillsTab = ({ shareRequestId, onChanged }: BillsTabProps) => {
  const [bills, setBills] = useState<ShareRequestBill[]>([]);
  const [providers, setProviders] = useState<ShareRequestProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  // null = creating a new bill; a BillId = editing that bill.
  const [editingBillId, setEditingBillId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<BillForm>(emptyForm);

  const toInputDate = (v?: string) => {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
  };

  const openAdd = () => {
    setEditingBillId(null);
    setForm(emptyForm);
    setShowAdd(true);
  };

  const openEdit = (b: ShareRequestBill) => {
    setEditingBillId(b.BillId);
    setForm({
      providerId: b.ProviderId ?? '',
      billNumber: b.BillNumber ?? '',
      billType: b.BillType,
      billDate: toInputDate(b.BillDate),
      dateOfService: toInputDate(b.DateOfService),
      description: b.Description ?? '',
      billedAmount: b.BilledAmount != null ? String(b.BilledAmount) : '',
      allowedAmount: b.AllowedAmount != null ? String(b.AllowedAmount) : '',
      notes: b.Notes ?? '',
    });
    setShowAdd(true);
  };

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [billsRes, providersRes] = await Promise.all([
          apiService.get<BillsResponse>(
            `/api/me/vendor/share-requests/${shareRequestId}/bills`,
            signal ? { signal } : undefined
          ),
          apiService.get<ProvidersResponse>(
            `/api/me/vendor/share-requests/${shareRequestId}/providers`,
            signal ? { signal } : undefined
          ),
        ]);
        if (signal?.aborted) return;
        if (billsRes.success) setBills(billsRes.data);
        if (providersRes.success) setProviders(providersRes.data);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load bills');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [shareRequestId]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const visibleBills = selectedProviderId
    ? bills.filter((b) => b.ProviderId === selectedProviderId)
    : bills;

  const totals = visibleBills.reduce(
    (acc, b) => ({
      billed: acc.billed + (b.BilledAmount || 0),
      paid: acc.paid + (b.PaidAmount || 0),
      balance: acc.balance + (b.Balance || 0),
    }),
    { billed: 0, paid: 0, balance: 0 }
  );

  const handleSave = async () => {
    if (!form.providerId) {
      window.alert('Provider is required');
      return;
    }
    if (!form.billedAmount) {
      window.alert('Billed amount is required');
      return;
    }
    const srId = shareRequestId;
    // On edit, send null (not undefined) for cleared optional fields so they
    // actually clear; on create, omit them.
    const payload = {
      providerId: form.providerId,
      billNumber: form.billNumber || (editingBillId ? null : undefined),
      billType: form.billType,
      billDate: form.billDate || (editingBillId ? null : undefined),
      dateOfService: form.dateOfService || (editingBillId ? null : undefined),
      description: form.description || (editingBillId ? null : undefined),
      billedAmount: parseFloat(form.billedAmount),
      allowedAmount: form.allowedAmount ? parseFloat(form.allowedAmount) : (editingBillId ? null : undefined),
      notes: form.notes || (editingBillId ? null : undefined),
    };
    setSaving(true);
    try {
      if (editingBillId) {
        await apiService.put(`/api/me/vendor/share-requests/${srId}/bills/${editingBillId}`, payload);
      } else {
        await apiService.post(`/api/me/vendor/share-requests/${srId}/bills`, payload);
      }
      setForm(emptyForm);
      setShowAdd(false);
      setEditingBillId(null);
      await load();
      onChanged?.();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to save bill');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (billId: string) => {
    if (!window.confirm('Delete this bill?')) return;
    const srId = shareRequestId;
    try {
      await apiService.delete(`/api/me/vendor/share-requests/${srId}/bills/${billId}`);
      await load();
      onChanged?.();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete bill');
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Bills</h2>
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add bill
        </button>
      </div>

      {/* Provider selector strip */}
      {providers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSelectedProviderId(null)}
            className={`px-3 py-1 text-xs rounded-full border ${
              selectedProviderId === null
                ? 'bg-oe-primary text-white border-oe-primary'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            All providers
          </button>
          {providers.map((p) => (
            <button
              key={p.ShareRequestProviderId}
              type="button"
              onClick={() => setSelectedProviderId(p.ProviderId)}
              className={`px-3 py-1 text-xs rounded-full border ${
                selectedProviderId === p.ProviderId
                  ? 'bg-oe-primary text-white border-oe-primary'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {p.ProviderName}
            </button>
          ))}
        </div>
      )}

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
      ) : visibleBills.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No bills"
          description={selectedProviderId ? 'No bills for this provider.' : 'Add the first bill.'}
          tone="subtle"
        />
      ) : (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <Th>Bill #</Th>
                <Th>Type</Th>
                <Th>Provider</Th>
                <Th>Service date</Th>
                <Th align="right">Billed</Th>
                <Th align="right">Paid</Th>
                <Th align="right">Balance</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {visibleBills.map((b) => (
                <tr key={b.BillId}>
                  <Td className="font-mono text-[12px]">{b.BillNumber ?? '—'}</Td>
                  <Td>{b.BillType}</Td>
                  <Td className="font-medium text-gray-900">
                    <span>{b.ProviderName ?? '—'}</span>
                    {b.Description && (
                      <span className="block text-[12px] text-gray-500 font-normal whitespace-pre-wrap">
                        {b.Description}
                      </span>
                    )}
                  </Td>
                  <Td>{fmtDate(b.DateOfService)}</Td>
                  <Td align="right">{fmtCurrency(b.BilledAmount)}</Td>
                  <Td align="right">{fmtCurrency(b.PaidAmount)}</Td>
                  <Td align="right" className="font-medium">{fmtCurrency(b.Balance)}</Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(b)}
                        className="p-1 text-gray-400 hover:text-oe-primary rounded"
                        aria-label="Edit bill"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(b.BillId)}
                        className="p-1 text-gray-400 hover:text-red-600 rounded"
                        aria-label="Delete bill"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50">
              <tr>
                <Td colSpan={4} className="text-right font-semibold text-gray-700">
                  {selectedProviderId ? 'Provider total' : 'Total'}
                </Td>
                <Td align="right" className="font-semibold">{fmtCurrency(totals.billed)}</Td>
                <Td align="right" className="font-semibold">{fmtCurrency(totals.paid)}</Td>
                <Td align="right" className="font-semibold">{fmtCurrency(totals.balance)}</Td>
                <Td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {showAdd && (
        <BillModal
          form={form}
          editing={!!editingBillId}
          shareRequestId={shareRequestId}
          providers={providers}
          saving={saving}
          onProviderPicked={(providerId) => setForm((f) => ({ ...f, providerId }))}
          onLinkedChanged={load}
          onChange={setForm}
          onSave={handleSave}
          onClose={() => { setShowAdd(false); setEditingBillId(null); }}
        />
      )}
    </div>
  );
};

interface BillModalProps {
  form: BillForm;
  editing: boolean;
  shareRequestId: string;
  providers: ShareRequestProvider[];
  saving: boolean;
  onProviderPicked: (providerId: string) => void;
  onLinkedChanged: () => Promise<void> | void;
  onChange: (form: BillForm) => void;
  onSave: () => void;
  onClose: () => void;
}

const BillModal = ({
  form,
  editing,
  shareRequestId,
  providers,
  saving,
  onProviderPicked,
  onLinkedChanged,
  onChange,
  onSave,
  onClose,
}: BillModalProps) => {
  const selectedProvider = providers.find((p) => p.ProviderId === form.providerId) ?? null;
  return (
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="add-bill-title"
    className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4"
    onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div className="w-full max-w-xl bg-white rounded-lg shadow-xl p-4 space-y-3 max-h-[90vh] overflow-y-auto">
      <div className="flex items-center justify-between">
        <h3 id="add-bill-title" className="text-base font-semibold text-gray-900">
          {editing ? 'Edit bill' : 'Add bill'}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 rounded"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Provider *" className="col-span-2">
          {selectedProvider ? (
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm border border-oe-primary bg-oe-light rounded">
              <span className="font-medium text-gray-900 truncate">{selectedProvider.ProviderName}</span>
              <button
                type="button"
                onClick={() => onChange({ ...form, providerId: '' })}
                className="text-gray-500 hover:text-gray-800 shrink-0"
                aria-label="Change provider"
              >
                Change
              </button>
            </div>
          ) : (
            <ProviderPicker
              shareRequestId={shareRequestId}
              linkedProviders={providers}
              onPicked={onProviderPicked}
              onLinkedChanged={onLinkedChanged}
            />
          )}
        </Field>
        <Field label="Bill #">
          <input
            type="text"
            value={form.billNumber}
            onChange={(e) => onChange({ ...form, billNumber: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        <Field label="Type">
          <select
            value={form.billType}
            onChange={(e) => onChange({ ...form, billType: e.target.value as BillType })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          >
            {BILL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bill date">
          <input
            type="date"
            value={form.billDate}
            onChange={(e) => onChange({ ...form, billDate: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        <Field label="Date of service">
          <input
            type="date"
            value={form.dateOfService}
            onChange={(e) => onChange({ ...form, dateOfService: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        <Field label="Billed amount *">
          <input
            type="number"
            step="0.01"
            value={form.billedAmount}
            onChange={(e) => onChange({ ...form, billedAmount: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        <Field label="Allowed amount">
          <input
            type="number"
            step="0.01"
            value={form.allowedAmount}
            onChange={(e) => onChange({ ...form, allowedAmount: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        <Field label="Description" className="col-span-2">
          <input
            type="text"
            value={form.description}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        <Field label="Notes" className="col-span-2">
          <textarea
            value={form.notes}
            onChange={(e) => onChange({ ...form, notes: e.target.value })}
            rows={2}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-lg"
        >
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

const Th = ({ children, align = 'left' }: { children?: ReactNode; align?: 'left' | 'right' }) => (
  <th className={`px-4 py-2 text-${align} text-[11px] font-medium text-gray-500 uppercase tracking-wider`}>
    {children}
  </th>
);

const Td = ({
  children,
  className = '',
  align = 'left',
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right';
  colSpan?: number;
}) => (
  <td colSpan={colSpan} className={`px-4 py-2 text-gray-700 text-${align} ${className}`}>
    {children}
  </td>
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

export default BillsTab;
