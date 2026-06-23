import { Loader2, Receipt } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import {
  downloadVendorInvoicesZip,
  fetchVendorInvoicePreview,
  VendorInvoiceTenantPreview,
} from '../../services/vendor/vendorInvoices.service';

function firstOfMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function formatMonthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
}

const VendorInvoicesPage: React.FC = () => {
  const now = useMemo(() => new Date(), []);
  const defaultEnd = firstOfMonth(now);
  const defaultStart = firstOfMonth(addMonths(now, -1));

  const monthOptions = useMemo(() => {
    const opts: { value: string; label: string; periodStart: string; periodEnd: string }[] = [];
    for (let i = 0; i < 13; i += 1) {
      const start = addMonths(now, -i);
      const end = addMonths(start, 1);
      const periodStart = firstOfMonth(start);
      const periodEnd = firstOfMonth(end);
      opts.push({
        value: periodStart,
        label: `${formatMonthLabel(periodStart)} (thru ${periodEnd})`,
        periodStart,
        periodEnd,
      });
    }
    return opts;
  }, [now]);

  const [useAdvanced, setUseAdvanced] = useState(false);
  const [periodStart, setPeriodStart] = useState(defaultStart);
  const [periodEnd, setPeriodEnd] = useState(defaultEnd);
  const [monthKey, setMonthKey] = useState(defaultStart);

  const [tenants, setTenants] = useState<VendorInvoiceTenantPreview[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [grandTotal, setGrandTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onMonthChange = (value: string) => {
    setMonthKey(value);
    const opt = monthOptions.find((o) => o.value === value);
    if (opt) {
      setPeriodStart(opt.periodStart);
      setPeriodEnd(opt.periodEnd);
    }
  };

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchVendorInvoicePreview({ periodStart, periodEnd });
      setTenants(data.tenants);
      setGrandTotal(data.summary.grandTotal);
      const sel: Record<string, boolean> = {};
      for (const t of data.tenants) {
        sel[t.tenantId] = t.lineCount > 0;
      }
      setSelected(sel);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
      setTenants([]);
    } finally {
      setLoading(false);
    }
  }, [periodStart, periodEnd]);

  const selectedIds = tenants.filter((t) => selected[t.tenantId]).map((t) => t.tenantId);
  const allSelected = tenants.length > 0 && selectedIds.length === tenants.length;

  const toggleAll = (checked: boolean) => {
    const next: Record<string, boolean> = {};
    for (const t of tenants) {
      next[t.tenantId] = checked;
    }
    setSelected(next);
  };

  const onGenerate = async () => {
    if (selectedIds.length === 0) return;
    setGenerating(true);
    setError(null);
    try {
      const { blob } = await downloadVendorInvoicesZip({
        periodStart,
        periodEnd,
        tenantIds: selectedIds,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vendor_invoices_${periodStart}_thru_${periodEnd}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generate failed');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <Receipt className="h-8 w-8 text-oe-primary" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Invoices</h1>
          <p className="text-sm text-gray-600">
            Bill external tenants for active enrollments (NetRate) in the selected period.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6 space-y-4">
        {!useAdvanced ? (
          <div>
            <label htmlFor="vendor-invoice-period" className="block text-sm font-medium text-gray-700 mb-1">
              Billing period
            </label>
            <select
              id="vendor-invoice-period"
              className="w-full max-w-md border border-gray-300 rounded-md px-3 py-2 text-sm"
              value={monthKey}
              onChange={(e) => onMonthChange(e.target.value)}
            >
              {monthOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              {periodStart} → {periodEnd} (effective thru end; not terminated before start)
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period start</label>
              <input
                type="date"
                className="border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period end (thru)</label>
              <input
                type="date"
                className="border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>
        )}
        <button
          type="button"
          className="text-sm text-oe-primary hover:underline"
          onClick={() => setUseAdvanced((v) => !v)}
        >
          {useAdvanced ? 'Use month dropdown' : 'Advanced dates…'}
        </button>
        <button
          type="button"
          onClick={() => void loadPreview()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 bg-oe-primary text-white rounded-md text-sm font-medium hover:bg-oe-dark disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Load preview
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-sm">
          {error}
        </div>
      )}

      {tenants.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-700">
              <span className="font-semibold">{tenants.length}</span> external tenant(s) ·{' '}
              <span className="font-semibold">{formatMoney(grandTotal)}</span> expected
            </p>
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
                Select all
              </label>
              <button
                type="button"
                className="text-sm text-gray-600 hover:underline"
                onClick={() => toggleAll(false)}
              >
                Deselect all
              </button>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left w-10" />
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Tenant</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Billable</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Active roster</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Expected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {tenants.map((t) => (
                  <tr key={t.tenantId} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={!!selected[t.tenantId]}
                        onChange={(e) =>
                          setSelected((s) => ({ ...s, [t.tenantId]: e.target.checked }))
                        }
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-900">{t.tenantName}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{t.lineCount}</td>
                    <td className="px-4 py-3 text-right text-gray-500 text-xs">
                      {(t.activeLineCount ?? 0) > 0 ? (
                        <>
                          {t.activeLineCount} · {formatMoney(t.activeRosterAmount ?? 0)}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {formatMoney(t.expectedAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={generating || selectedIds.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 bg-oe-primary text-white rounded-md text-sm font-medium hover:bg-oe-dark disabled:opacity-50"
          >
            {generating && <Loader2 className="h-4 w-4 animate-spin" />}
            Generate invoice(s)
          </button>
        </>
      )}

      {!loading && tenants.length === 0 && !error && (
        <p className="text-sm text-gray-500">Load preview to see external tenants and amounts.</p>
      )}
    </div>
  );
};

export default VendorInvoicesPage;
