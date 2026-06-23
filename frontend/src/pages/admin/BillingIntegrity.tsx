import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronLeft,
  RefreshCw,
  Receipt,
  FileText,
  AlertCircle,
  DollarSign,
  Wrench,
  Building2,
  Users
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import { apiService } from '../../services/api.service';
import { useHouseholdCreditBalances } from '../../hooks/useHouseholdCredits';
import { useMemberModalLauncher } from '../../hooks/useMemberModalLauncher';

// Billing Integrity dashboard. SysAdmin tool that surfaces three categories
// of data drift between oe.Enrollments, oe.Invoices, and oe.Payments and
// exposes idempotent fixers for each:
//   1. Invoices below the $3.50/month SystemFee floor (recompute via the
//      shared invoice audit logic and align linked payment snapshots).
//   2. Individually-billed households missing one or more monthly invoices
//      between FirstActive and current month.
//   3. Orphan payments (InvoiceId IS NULL) — completed payments are linked
//      to existing or newly-created invoices via the standard tryLink path.

interface LowFeeInvoiceRow {
  InvoiceId: string;
  TenantId: string;
  TenantName?: string | null;
  TenantFeeFloor: number;
  InvoiceNumber: string | null;
  InvoiceType: string;
  HouseholdId: string | null;
  GroupId: string | null;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  Status: string;
  TotalAmount: number;
  PaidAmount: number;
  NetRate: number;
  OverrideRate: number;
  Commission: number;
  SystemFees: number;
  ProcessingFeeAmount: number;
  SetupFee: number;
  BreakdownSum: number;
  MathDiff: number;
  Bucket: 'safe_to_split' | 'undercharged' | 'other_mismatch';
  LinkedSuccessPayments: number;
  GroupName: string | null;
  PrimaryMemberId: string | null;
  PrimaryUserId: string | null;
  PrimaryFirstName: string | null;
  PrimaryLastName: string | null;
  PrimaryEmail: string | null;
}

interface MissingInvoiceRow {
  HouseholdId: string;
  TenantId: string;
  TenantName?: string | null;
  PrimaryMemberName?: string | null;
  PrimaryMemberId?: string | null;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  MonthKey: string;
}

interface OrphanPaymentRow {
  PaymentId: string;
  TenantId: string;
  HouseholdId: string | null;
  GroupId: string | null;
  PrimaryMemberId?: string | null;
  Amount: number;
  Status: string;
  PaymentDate: string;
  Processor: string | null;
  PaymentMethod: string | null;
  Category: string;
}

interface PhantomZeroRow {
  PhantomInvoiceId: string;
  PhantomInvoiceNumber: string | null;
  HouseholdId: string;
  TenantId: string;
  PhantomPeriodStart: string;
  PhantomPeriodEnd: string;
  PaymentId: string;
  PaymentDate: string;
  PaymentAmount: number;
  PaymentStatus: string;
  TwinInvoiceId: string | null;
  TwinInvoiceNumber: string | null;
  TwinPeriodStart: string | null;
  TwinPeriodEnd: string | null;
  TwinTotalAmount: number | null;
  TwinPaidAmount: number | null;
  TwinStatus: string | null;
  PrimaryMemberId: string | null;
  PrimaryFirstName: string | null;
  PrimaryLastName: string | null;
  PrimaryEmail: string | null;
}

interface SystemFeeMonth {
  month: string;
  invoiceCount: number;
  systemFees: number;
}

interface AnchorDriftRow {
  HouseholdId: string;
  PrimaryMemberId?: string | null;
  PrimaryMemberName?: string | null;
  AnchorEffectiveDate: string | null | undefined;
  AnchorDay?: number | null;
  WrongOpenInvoiceCount: number;
  NextBillingDate?: string | null;
  /** 1 when active DIME schedule NextBillingDate day-of-month differs from anchor */
  DimeScheduleDayMismatch: number;
}

interface IssuesSummary {
  tenantFeeFloors: Record<string, { tenantName: string | null; tenantFeeFloor: number }>;
  phantomZeroInvoices: { count: number; eligible: number; rows: PhantomZeroRow[] };
  lowSystemFeeInvoices: { count: number; rows: LowFeeInvoiceRow[] };
  missingMonthlyInvoices: { count: number; householdCount: number; rows: MissingInvoiceRow[] };
  orphanPayments: { count: number; byCategory: Record<string, number>; rows: OrphanPaymentRow[] };
  systemFeeCollections: { totalCollected: number; byMonth: SystemFeeMonth[] };
  /** Unified enrollment billing-day vs invoices / DIME (read-only worklist). */
  anchorBillingDrift: { count: number; rows: AnchorDriftRow[] };
}

interface IssuesResponse {
  success: boolean;
  data: IssuesSummary;
  message?: string;
}

const fmtCurrency = (val: number | null | undefined): string => {
  if (val == null || Number.isNaN(Number(val))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(val));
};

// Calendar dates from the API are stored as UTC midnight (e.g. "2026-04-01T00:00:00Z"),
// representing a billing period day. Parse the date parts directly so the displayed
// day always matches the stored period regardless of the user's timezone.
const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    const datePart = String(iso).split('T')[0];
    const [yStr, mStr, dStr] = datePart.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    if (!y || !m || !d) return new Date(iso).toLocaleDateString();
    return new Date(y, m - 1, d).toLocaleDateString();
  } catch (_e) {
    return String(iso);
  }
};

const fmtMonth = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    const datePart = String(iso).split('T')[0];
    const [yStr, mStr] = datePart.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    if (!y || !m) return iso;
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  } catch (_e) {
    return String(iso);
  }
};

const shortId = (id: string | null | undefined, len = 8): string => {
  if (!id) return '—';
  const s = String(id);
  return s.length > len + 1 ? `${s.slice(0, len)}…` : s;
};

const BillingIntegrity: React.FC = () => {
  const navigate = useNavigate();
  const { openMember, MemberModalElement } = useMemberModalLauncher();
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<IssuesSummary | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.get<IssuesResponse>('/api/admin/billing-integrity/issues');
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Failed to load billing integrity issues');
      }
      setData({
        ...(res.data as IssuesSummary),
        anchorBillingDrift: res.data.anchorBillingDrift ?? { count: 0, rows: [] }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unexpected error';
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runFix = useCallback(
    async (key: string, path: string, label: string, query?: string) => {
      const confirmed = window.confirm(
        `Run "${label}"? This will modify production data. (Idempotent and re-runnable.)`
      );
      if (!confirmed) return;
      setRunning(key);
      try {
        const res = await apiService.post<{ success: boolean; data: Record<string, unknown>; message?: string }>(
          `${path}${query ? `?${query}` : ''}`
        );
        if (!res.success) {
          throw new Error(res.message || 'Fix failed');
        }
        // Surface the per-row outcome so silent failures (per-household errors,
        // skipped rows) don't get hidden behind a generic "complete" toast.
        const data = (res.data || {}) as Record<string, unknown>;
        const created = Number(data.created ?? 0);
        const fixed = Number(data.fixed ?? 0);
        const linked = Number(data.linked ?? 0);
        const updated = Number(data.updated ?? 0);
        const skipped = Number(data.skipped ?? 0);
        const scanned = Number(data.scanned ?? 0);
        const errorsArr = Array.isArray(data.errors) ? (data.errors as Array<Record<string, unknown>>) : [];
        const verb =
          created > 0 ? `created ${created}` :
          fixed   > 0 ? `fixed ${fixed}`     :
          linked  > 0 ? `linked ${linked}`   :
          updated > 0 ? `updated ${updated}` :
          'no changes';
        const summary = `${label}: ${verb}${scanned ? ` (scanned ${scanned})` : ''}${skipped ? `, skipped ${skipped}` : ''}${errorsArr.length ? `, ${errorsArr.length} errors` : ''}`;
        if (errorsArr.length > 0) {
          console.warn(`[BillingIntegrity] ${label} per-row errors:`, errorsArr);
          toast.error(summary, { duration: 8000 });
          const first = errorsArr[0];
          const firstMsg = typeof first?.error === 'string' ? first.error : JSON.stringify(first);
          toast.error(`First error: ${firstMsg}`, { duration: 12000 });
        } else if (created === 0 && fixed === 0 && linked === 0 && updated === 0 && scanned > 0) {
          toast(summary, { duration: 6000, icon: 'ℹ️' });
        } else {
          toast.success(summary);
        }
        await load();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unexpected error';
        toast.error(msg);
      } finally {
        setRunning(null);
      }
    },
    [load]
  );

  const orphanCategories = useMemo(() => {
    if (!data) return [] as { category: string; count: number }[];
    return Object.entries(data.orphanPayments.byCategory)
      .map(([category, count]) => ({ category, count: Number(count || 0) }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const completedOrphans = useMemo(() => {
    if (!data) return 0;
    return data.orphanPayments.byCategory.completed || 0;
  }, [data]);

  const refundedOrphans = useMemo(() => {
    if (!data) return 0;
    return data.orphanPayments.byCategory.refunded || 0;
  }, [data]);

  // Phase 1g.3: surface count + total of households with available credit so
  // SysAdmin can drill into the TenantBilling Credits tab to see the ledger.
  const { data: creditBalances = [] } = useHouseholdCreditBalances();
  const creditPanelTotal = useMemo(() => {
    return creditBalances.reduce((sum, row) => sum + Number(row.Balance || 0), 0);
  }, [creditBalances]);
  const creditPanelCount = creditBalances.length;

  return (
    <>
      <div className="p-6">
      <div className="flex items-center mb-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex items-center text-gray-600 hover:text-gray-900 mr-4"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </button>
        <h1 className="text-2xl font-semibold text-gray-900">Billing Integrity</h1>
      </div>

      <p className="text-gray-600 mb-6 max-w-4xl">
        Detects and fixes drift between <code className="font-mono">oe.Enrollments</code>,{' '}
        <code className="font-mono">oe.Invoices</code>, and <code className="font-mono">oe.Payments</code>:
        household invoices below their tenant&apos;s configured system-fee floor (sum of enabled{' '}
        <code className="font-mono">MemberPaid</code> fees from{' '}
        <code className="font-mono">oe.Tenants.SystemFees</code>), individually-billed households
        missing one or more monthly invoices, and orphan payments (no linked invoice). All fixes
        are idempotent and safe to re-run.
      </p>

      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 flex items-center justify-between">
        <div className="flex items-center text-gray-600">
          <Receipt className="h-5 w-5 mr-2" />
          <span className="text-sm">
            Snapshot of current billing state. Click any &ldquo;Fix&rdquo; button to repair that category.
          </span>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 mb-6 flex items-start">
          <AlertTriangle className="h-5 w-5 mr-2 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Failed to load</p>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Top stat cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <DollarSign className="h-4 w-4 mr-2 text-oe-success" />
                <span className="text-sm">SystemFees collected (Paid)</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">
                {fmtCurrency(data.systemFeeCollections.totalCollected)}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Across {data.systemFeeCollections.byMonth.length} month
                {data.systemFeeCollections.byMonth.length === 1 ? '' : 's'}
              </div>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <AlertCircle className="h-4 w-4 mr-2 text-amber-600" />
                <span className="text-sm">Below tenant fee floor</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.lowSystemFeeInvoices.count}</div>
              <div className="text-xs text-gray-500 mt-1">
                {Object.values(data.tenantFeeFloors || {}).length > 0 ? (
                  <>
                    Tenants:{' '}
                    {Object.values(data.tenantFeeFloors)
                      .map((t) => `${t.tenantName || '—'} ($${t.tenantFeeFloor})`)
                      .join(', ')}
                  </>
                ) : (
                  'No tenants with fee floors triggered'
                )}
              </div>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <FileText className="h-4 w-4 mr-2 text-amber-600" />
                <span className="text-sm">Missing monthly invoices</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.missingMonthlyInvoices.count}</div>
              <div className="text-xs text-gray-500 mt-1">
                Across {data.missingMonthlyInvoices.householdCount} household
                {data.missingMonthlyInvoices.householdCount === 1 ? '' : 's'}
              </div>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <Receipt className="h-4 w-4 mr-2 text-purple-700" />
                <span className="text-sm">Billing day drift</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.anchorBillingDrift.count}</div>
              <div className="text-xs text-gray-500 mt-1">
                Open invoices or DIME next charge day ≠ unified effective day (manual cleanup)
              </div>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <AlertCircle className="h-4 w-4 mr-2 text-red-600" />
                <span className="text-sm">Orphan payments</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.orphanPayments.count}</div>
              <div className="text-xs text-gray-500 mt-1">
                {completedOrphans} completed · {refundedOrphans} refunded
              </div>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center text-gray-600 mb-1">
                <AlertCircle className="h-4 w-4 mr-2 text-red-600" />
                <span className="text-sm">Phantom $0 invoices</span>
              </div>
              <div className="text-2xl font-semibold text-gray-900">{data.phantomZeroInvoices?.count ?? 0}</div>
              <div className="text-xs text-gray-500 mt-1">
                {data.phantomZeroInvoices?.eligible ?? 0} auto-fixable · {(data.phantomZeroInvoices?.count ?? 0) - (data.phantomZeroInvoices?.eligible ?? 0)} need review
              </div>
            </div>
          </div>

          {/* Phase 1g.3: Households with available credit - drill into TenantBilling Credits tab */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 flex items-center justify-between">
            <div className="flex items-center">
              <DollarSign className="h-5 w-5 mr-3 text-oe-success" />
              <div>
                <div className="text-sm text-gray-600">Households with available credit</div>
                <div className="text-xl font-semibold text-gray-900">
                  {creditPanelCount} household{creditPanelCount === 1 ? '' : 's'} · {fmtCurrency(creditPanelTotal)} total
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Auto-applies to next unpaid invoice during nightly run.
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate('/tenant-admin/billing?tab=credits')}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-sm"
            >
              View credits ledger
            </button>
          </div>

          {/* Section: Phantom $0 invoices linked to a real payment */}
          {data.phantomZeroInvoices && (
            <Section
              title="Phantom $0 invoices with linked payment"
              count={data.phantomZeroInvoices.count}
              description="Detects $0 invoices that have a payment linked to them but ALSO have a real twin invoice (matching the payment amount within $0.50, billing period within 45 days after the payment date). The auto-fix re-points the payment to the real twin invoice and deletes the $0 row inside a transaction. No money moves; this is purely a linkage repair."
              actions={
                <button
                  type="button"
                  disabled={running !== null || data.phantomZeroInvoices.eligible === 0}
                  onClick={() =>
                    runFix(
                      'fix-phantom',
                      '/api/admin/billing-integrity/fix-phantom-zero-invoices',
                      `Re-point ${data.phantomZeroInvoices.eligible} phantom invoice${data.phantomZeroInvoices.eligible === 1 ? '' : 's'} to the real twin`
                    )
                  }
                  className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
                >
                  <Wrench className={`h-4 w-4 mr-2 ${running === 'fix-phantom' ? 'animate-spin' : ''}`} />
                  {running === 'fix-phantom'
                    ? 'Running…'
                    : `Repair ${data.phantomZeroInvoices.eligible} phantom${data.phantomZeroInvoices.eligible === 1 ? '' : 's'}`}
                </button>
              }
            >
              {data.phantomZeroInvoices.rows.length === 0 ? (
                <EmptyState ok message="No phantom $0 invoices detected." />
              ) : (
                <Table
                  headers={['Member', 'Phantom Inv', 'Phantom Period', 'Payment $', 'Twin Inv', 'Twin Period', 'Twin Status', 'Action']}
                  rows={data.phantomZeroInvoices.rows.slice(0, 100).map((r) => [
                    r.PrimaryMemberId ? (
                      <button
                        key="m"
                        type="button"
                        onClick={() => void openMember(r.PrimaryMemberId!, 'payments')}
                        className="text-oe-primary hover:text-oe-dark hover:underline text-sm"
                      >
                        {[r.PrimaryFirstName, r.PrimaryLastName].filter(Boolean).join(' ') || r.PrimaryEmail || shortId(r.HouseholdId)}
                      </button>
                    ) : (
                      <span key="m" className="font-mono text-xs">{shortId(r.HouseholdId)}</span>
                    ),
                    <span key="pi" className="font-mono text-xs">{r.PhantomInvoiceNumber || shortId(r.PhantomInvoiceId)}</span>,
                    <span key="pp" className="text-xs text-gray-700">{fmtMonth(r.PhantomPeriodStart)}</span>,
                    fmtCurrency(r.PaymentAmount),
                    r.TwinInvoiceId ? (
                      <span key="ti" className="font-mono text-xs">{r.TwinInvoiceNumber || shortId(r.TwinInvoiceId)}</span>
                    ) : (
                      <span key="ti" className="text-xs text-red-600">no match</span>
                    ),
                    r.TwinPeriodStart ? (
                      <span key="tp" className="text-xs text-gray-700">{fmtMonth(r.TwinPeriodStart)}</span>
                    ) : <span key="tp">—</span>,
                    r.TwinStatus ? <StatusBadge key="ts" status={r.TwinStatus} /> : <span key="ts">—</span>,
                    <span key="a" className={`text-xs ${r.TwinInvoiceId ? 'text-green-700' : 'text-amber-700'}`}>
                      {r.TwinInvoiceId ? 'auto-fix' : 'manual review'}
                    </span>
                  ])}
                />
              )}
            </Section>
          )}

          {/* Section: Low system fee invoices */}
          {(() => {
            const safeRows = data.lowSystemFeeInvoices.rows.filter((r) => r.Bucket === 'safe_to_split');
            const underRows = data.lowSystemFeeInvoices.rows.filter((r) => r.Bucket === 'undercharged');
            const otherRows = data.lowSystemFeeInvoices.rows.filter((r) => r.Bucket === 'other_mismatch');
            return (
              <Section
                title="Household invoices below tenant fee floor"
                count={data.lowSystemFeeInvoices.count}
                description="Scope: individually-billed household invoices whose SystemFees fall below their tenant's configured floor (sum of enabled MemberPaid fees from oe.Tenants.SystemFees). Group invoices use a per-member fee model and are audited separately via the TenantBilling 'Run audits → payment_json_fees' job. The auto-fix recomputes ALL breakdown columns from oe.Enrollments and applies the correction only when the recomputed breakdowns still sum to the existing TotalAmount, so the customer's charge never changes."
                actions={
                  <button
                    type="button"
                    disabled={running !== null || safeRows.length === 0}
                    onClick={() =>
                      runFix(
                        'recompute',
                        '/api/admin/billing-integrity/recompute-fees',
                        `Recompute breakdowns on ${safeRows.length} balanced invoice${safeRows.length === 1 ? '' : 's'}`
                      )
                    }
                    className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
                  >
                    <Wrench className={`h-4 w-4 mr-2 ${running === 'recompute' ? 'animate-spin' : ''}`} />
                    {running === 'recompute' ? 'Running…' : `Auto-fix balanced (${safeRows.length})`}
                  </button>
                }
              >
                {/* Bucket summary */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <div className="text-xs font-semibold text-green-800 uppercase">Balanced (auto-fix)</div>
                    <div className="text-2xl font-semibold text-green-900 mt-1">{safeRows.length}</div>
                    <div className="text-xs text-green-700 mt-1">
                      Recomputing breakdowns from oe.Enrollments produces a sum that equals TotalAmount. Auto-fix
                      re-categorizes ALL breakdown columns (incl. JSON) without changing the customer&apos;s
                      charge.
                    </div>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <div className="text-xs font-semibold text-amber-800 uppercase">Undercharged</div>
                    <div className="text-2xl font-semibold text-amber-900 mt-1">{underRows.length}</div>
                    <div className="text-xs text-amber-700 mt-1">
                      Stored breakdown already equals TotalAmount and SystemFees = $0. Either the household is
                      missing a SystemFee enrollment for this period or the customer was undercharged. Needs
                      human review — fix the enrollment on the platform first.
                    </div>
                  </div>
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="text-xs font-semibold text-red-800 uppercase">Other mismatch</div>
                    <div className="text-2xl font-semibold text-red-900 mt-1">{otherRows.length}</div>
                    <div className="text-xs text-red-700 mt-1">
                      Math doesn&apos;t add up cleanly — typically older invoices with zeroed-out breakdowns or
                      unusual amounts. Investigate per-invoice in TenantBilling Audit.
                    </div>
                  </div>
                </div>

                {safeRows.length > 0 && (
                  <BucketTable
                    title="Balanced — safe to auto-fix"
                    rows={safeRows}
                    tone="safe"
                    onOpenMember={(mid) => void openMember(mid, 'payments')}
                    onNavigateToGroup={(gid) => navigate(`/admin/groups/${gid}`)}
                  />
                )}
                {underRows.length > 0 && (
                  <BucketTable
                    title="Undercharged (needs review)"
                    rows={underRows}
                    tone="warn"
                    onOpenMember={(mid) => void openMember(mid, 'payments')}
                    onNavigateToGroup={(gid) => navigate(`/admin/groups/${gid}`)}
                  />
                )}
                {otherRows.length > 0 && (
                  <BucketTable
                    title="Other mismatch (needs review)"
                    rows={otherRows}
                    tone="error"
                    onOpenMember={(mid) => void openMember(mid, 'payments')}
                    onNavigateToGroup={(gid) => navigate(`/admin/groups/${gid}`)}
                  />
                )}
                {data.lowSystemFeeInvoices.rows.length === 0 && (
                  <EmptyState
                    ok
                    message="All household invoices meet the system fee floor. (Group invoices are audited separately on TenantBilling.)"
                  />
                )}
              </Section>
            );
          })()}

          {/* Section: Missing monthly invoices */}
          <Section
            title="Missing monthly invoices"
            count={data.missingMonthlyInvoices.count}
            description="One row per household-month gap between the household&apos;s first active enrollment and today. Expected periods use the unified billing day (DOM of earliest active Product/Bundle enrollment, end of calendar month)—not always the 1st. Rows are created via getOrCreateInvoiceForPeriod and self-heal linkage with matching prepay payments."
            actions={
              <button
                type="button"
                disabled={running !== null || data.missingMonthlyInvoices.count === 0}
                onClick={() =>
                  runFix(
                    'create-missing',
                    '/api/admin/billing-integrity/create-missing-invoices',
                    'Create missing monthly invoices'
                  )
                }
                className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
              >
                <Wrench className={`h-4 w-4 mr-2 ${running === 'create-missing' ? 'animate-spin' : ''}`} />
                {running === 'create-missing' ? 'Running…' : 'Create missing invoices'}
              </button>
            }
          >
            {data.missingMonthlyInvoices.rows.length === 0 ? (
              <EmptyState ok message="Every individually-billed household has all expected monthly invoices." />
            ) : (
              <Table
                headers={['Primary member / household', 'Tenant', 'Missing month', 'Period']}
                rows={data.missingMonthlyInvoices.rows.slice(0, 100).map((r) => [
                  <button
                    key="hh"
                    type="button"
                    disabled={!r.PrimaryMemberId}
                    onClick={() => r.PrimaryMemberId && void openMember(r.PrimaryMemberId, 'payments')}
                    title={r.HouseholdId}
                    className="text-left max-w-xs disabled:opacity-50 disabled:cursor-not-allowed enabled:cursor-pointer"
                  >
                    <span className="block font-medium text-oe-primary hover:text-oe-dark hover:underline">
                      {(r.PrimaryMemberName && r.PrimaryMemberName.trim()) || '—'}
                    </span>
                    <span className="block text-xs text-gray-500 font-mono mt-0.5">{shortId(r.HouseholdId)}</span>
                  </button>,
                  <span key="tn" className="text-sm text-gray-900" title={r.TenantId}>
                    {(r.TenantName && r.TenantName.trim()) || '—'}
                  </span>,
                  <span key="mk" className="font-medium">{fmtMonth(r.BillingPeriodStart) || r.MonthKey}</span>,
                  `${fmtDate(r.BillingPeriodStart)} → ${fmtDate(r.BillingPeriodEnd)}`
                ])}
              />
            )}
          </Section>

          {/* Section: Anchor billing drift (read-only worklist) */}
          <Section
            title="Households with invoice / recurring day ≠ enrollment anchor"
            count={data.anchorBillingDrift.count}
            description="Read-only audit. Billing anchor = earliest EffectiveDate DOM among active Product/Bundle enrollments (no termination, individual billed). Rows list primary members needing manual fixes when open invoices begin on the wrong DOM or the active DIME NextBillingDate doesn&apos;t match that anchor."
          >
            {data.anchorBillingDrift.rows.length === 0 ? (
              <EmptyState ok message="No households with mismatched billing day vs enrollment anchor." />
            ) : (
              <Table
                headers={['Primary member', 'Anchor DOM', 'Open invoices wrong DOM', 'DIME mismatch', 'Next DIME billing']}
                rows={data.anchorBillingDrift.rows.slice(0, 200).map((r) => [
                  <button
                    key="pm"
                    type="button"
                    disabled={!r.PrimaryMemberId}
                    onClick={() => r.PrimaryMemberId && void openMember(r.PrimaryMemberId, 'payments')}
                    title={r.HouseholdId}
                    className="text-left max-w-xs disabled:opacity-50 disabled:cursor-not-allowed enabled:cursor-pointer"
                  >
                    <span className="block font-medium text-oe-primary hover:text-oe-dark hover:underline">
                      {(r.PrimaryMemberName && r.PrimaryMemberName.trim()) || '—'}
                    </span>
                    <span className="block text-xs text-gray-500 font-mono mt-0.5">{shortId(r.HouseholdId)}</span>
                  </button>,
                  <span key="ad" className="text-sm">
                    {fmtDate(typeof r.AnchorEffectiveDate === 'string' ? r.AnchorEffectiveDate : null)} (DOM{' '}
                    {r.AnchorDay ?? '—'})
                  </span>,
                  <span key="wo">{r.WrongOpenInvoiceCount ?? 0}</span>,
                  <span key="dm">{r.DimeScheduleDayMismatch ? 'Yes' : 'No'}</span>,
                  fmtDate(typeof r.NextBillingDate === 'string' ? r.NextBillingDate : null)
                ])}
              />
            )}
          </Section>

          {/* Section: Orphan payments */}
          <Section
            title="Orphan payments"
            count={data.orphanPayments.count}
            description="Payments with InvoiceId IS NULL, grouped by Status. Completed payments are linked via the same flow used at charge time (prepay match → period match → create-and-link). Refunded payments are skipped by default but can be linked too."
            actions={
              <div className="flex space-x-2">
                <button
                  type="button"
                  disabled={running !== null || completedOrphans === 0}
                  onClick={() =>
                    runFix(
                      'link-completed',
                      '/api/admin/billing-integrity/link-orphan-payments',
                      'Link completed orphans'
                    )
                  }
                  className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
                >
                  <Wrench className={`h-4 w-4 mr-2 ${running === 'link-completed' ? 'animate-spin' : ''}`} />
                  {running === 'link-completed' ? 'Running…' : 'Link completed'}
                </button>
                <button
                  type="button"
                  disabled={running !== null || refundedOrphans === 0}
                  onClick={() =>
                    runFix(
                      'link-refunded',
                      '/api/admin/billing-integrity/link-orphan-payments',
                      'Link completed + refunded orphans',
                      'includeRefunded=true'
                    )
                  }
                  className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                >
                  <Wrench className={`h-4 w-4 mr-2 ${running === 'link-refunded' ? 'animate-spin' : ''}`} />
                  {running === 'link-refunded' ? 'Running…' : 'Include refunded'}
                </button>
              </div>
            }
          >
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
              {orphanCategories.map((c) => (
                <div key={c.category} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <div className="text-xs text-gray-500 capitalize">{c.category}</div>
                  <div className="text-lg font-semibold text-gray-900">{c.count}</div>
                </div>
              ))}
            </div>
            {data.orphanPayments.rows.length === 0 ? (
              <EmptyState ok message="No orphan payments." />
            ) : (
              <Table
                headers={['Payment', 'Date', 'Amount', 'Status', 'Category', 'Household', 'Processor']}
                rows={data.orphanPayments.rows.slice(0, 100).map((r) => [
                  <span key="p" className="font-mono text-xs">{shortId(r.PaymentId)}</span>,
                  fmtDate(r.PaymentDate),
                  fmtCurrency(r.Amount),
                  <StatusBadge key="st" status={r.Status} />,
                  <span key="c" className="text-xs capitalize text-gray-700">{r.Category}</span>,
                  r.HouseholdId && r.PrimaryMemberId ? (
                    <button
                      key="h"
                      type="button"
                      onClick={() => void openMember(r.PrimaryMemberId!, 'payments')}
                      className="font-mono text-xs text-oe-primary hover:text-oe-dark hover:underline"
                      title={r.HouseholdId ?? undefined}
                    >
                      {shortId(r.HouseholdId)}
                    </button>
                  ) : r.HouseholdId ? (
                    <span key="h" className="font-mono text-xs text-gray-500" title={`${r.HouseholdId}${r.PrimaryMemberId ? '' : ' — no primary member'}`}>
                      {shortId(r.HouseholdId)}
                    </span>
                  ) : (
                    <span key="h" className="text-gray-400">—</span>
                  ),
                  r.Processor || '—'
                ])}
              />
            )}
          </Section>

          {/* SystemFee collections by month */}
          {data.systemFeeCollections.byMonth.length > 0 && (
            <Section
              title="SystemFees collected by month"
              description="Sum of SystemFees on Paid invoices, grouped by billing month."
            >
              <Table
                headers={['Month', 'Paid invoices', 'SystemFees']}
                rows={data.systemFeeCollections.byMonth.map((m) => [
                  m.month,
                  m.invoiceCount,
                  fmtCurrency(m.systemFees)
                ])}
              />
            </Section>
          )}
        </>
      )}
    </div>
    {MemberModalElement}
    </>
  );
};

// ----- helpers -----------------------------------------------------------

const Section: React.FC<{
  title: string;
  count?: number;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, count, description, actions, children }) => (
  <div className="bg-white rounded-lg border border-gray-200 mb-6">
    <div className="p-6 border-b border-gray-200 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-medium text-gray-900">
          {title}
          {typeof count === 'number' && (
            <span className="ml-2 inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-gray-100 text-gray-700">
              {count}
            </span>
          )}
        </h2>
        {description && <p className="text-sm text-gray-600 mt-1 max-w-3xl">{description}</p>}
      </div>
      {actions && <div className="flex-shrink-0">{actions}</div>}
    </div>
    <div className="p-6">{children}</div>
  </div>
);

const EmptyState: React.FC<{ ok?: boolean; message: string }> = ({ ok, message }) => (
  <div
    className={`flex items-center p-4 rounded-lg ${
      ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-gray-50 border border-gray-200 text-gray-700'
    }`}
  >
    {ok ? <CheckCircle className="h-5 w-5 mr-2" /> : <AlertCircle className="h-5 w-5 mr-2" />}
    <span className="text-sm">{message}</span>
  </div>
);

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const s = (status || '').toLowerCase();
  let cls = 'bg-gray-100 text-gray-700';
  if (s === 'paid' || s === 'success' || s === 'completed' || s === 'succeeded') {
    cls = 'bg-green-100 text-green-800';
  } else if (s === 'unpaid' || s === 'overdue') {
    cls = 'bg-red-100 text-red-800';
  } else if (s === 'partial' || s === 'partiallyrefunded') {
    cls = 'bg-amber-100 text-amber-800';
  } else if (s === 'refunded') {
    cls = 'bg-purple-100 text-purple-800';
  } else if (s === 'failed' || s === 'declined') {
    cls = 'bg-red-100 text-red-800';
  } else if (s === 'pending' || s === 'processing' || s === 'recurringscheduled' || s === 'scheduled') {
    cls = 'bg-blue-100 text-blue-800';
  }
  return <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${cls}`}>{status}</span>;
};

const BucketTable: React.FC<{
  title: string;
  rows: LowFeeInvoiceRow[];
  tone: 'safe' | 'warn' | 'error';
  onOpenMember?: (memberId: string) => void;
  onNavigateToGroup?: (groupId: string) => void;
}> = ({ title, rows, tone, onOpenMember, onNavigateToGroup }) => {
  const navigate = useNavigate();
  const headerCls =
    tone === 'safe'
      ? 'text-green-800'
      : tone === 'warn'
        ? 'text-amber-800'
        : 'text-red-800';

  const openSubject = (r: LowFeeInvoiceRow) => {
    if (r.GroupId) {
      if (onNavigateToGroup) {
        onNavigateToGroup(String(r.GroupId));
      } else {
        navigate(`/admin/groups/${r.GroupId}`);
      }
      return;
    }
    if (r.PrimaryMemberId && onOpenMember) {
      onOpenMember(String(r.PrimaryMemberId));
      return;
    }
    if (r.PrimaryMemberId) {
      navigate(`/admin/members?openMemberId=${r.PrimaryMemberId}`);
      return;
    }
    if (r.HouseholdId) {
      navigate(`/admin/members?householdId=${r.HouseholdId}`);
    }
  };

  const renderSubject = (r: LowFeeInvoiceRow) => {
    if (r.GroupName) {
      return (
        <button
          type="button"
          onClick={() => openSubject(r)}
          className="text-oe-primary hover:text-oe-dark hover:underline text-left"
        >
          <span className="inline-flex items-center">
            <Building2 className="h-3.5 w-3.5 mr-1" />
            {r.GroupName}
          </span>
        </button>
      );
    }
    const name = [r.PrimaryFirstName, r.PrimaryLastName].filter(Boolean).join(' ');
    if (name) {
      return (
        <button
          type="button"
          onClick={() => openSubject(r)}
          className="text-oe-primary hover:text-oe-dark hover:underline text-left"
        >
          <span className="inline-flex items-center">
            <Users className="h-3.5 w-3.5 mr-1" />
            {name}
          </span>
        </button>
      );
    }
    if (r.HouseholdId) {
      return (
        <span className="text-gray-500 text-xs font-mono">household {shortId(r.HouseholdId)}</span>
      );
    }
    return <span className="text-gray-400">—</span>;
  };

  return (
    <div className="mb-6">
      <h3 className={`text-sm font-semibold ${headerCls} mb-2`}>
        {title} ({rows.length})
      </h3>
      <Table
        headers={['Invoice', 'Subject', 'Period', 'Status', 'Total', 'BreakdownSum', 'Diff', 'SysFee', 'Floor']}
        rows={rows.slice(0, 100).map((r) => [
          <span key="num" className="font-mono text-xs">
            {r.InvoiceNumber || shortId(r.InvoiceId)}
          </span>,
          renderSubject(r),
          fmtDate(r.BillingPeriodStart),
          <StatusBadge key="st" status={r.Status} />,
          fmtCurrency(r.TotalAmount),
          fmtCurrency(r.BreakdownSum),
          <span
            key="d"
            className={
              Math.abs(r.MathDiff - r.TenantFeeFloor) < 0.01
                ? 'text-green-700 font-medium'
                : Math.abs(r.MathDiff) < 0.01
                  ? 'text-gray-600'
                  : 'text-red-700 font-medium'
            }
          >
            {fmtCurrency(r.MathDiff)}
          </span>,
          fmtCurrency(r.SystemFees),
          <span key="f" className="text-xs text-gray-700">
            {fmtCurrency(r.TenantFeeFloor)}
          </span>
        ])}
      />
    </div>
  );
};

const Table: React.FC<{ headers: string[]; rows: React.ReactNode[][] }> = ({ headers, rows }) => (
  <div className="overflow-x-auto">
    <table className="min-w-full divide-y divide-gray-200">
      <thead className="bg-gray-50">
        <tr>
          {headers.map((h) => (
            <th
              key={h}
              className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="bg-white divide-y divide-gray-200">
        {rows.map((row, i) => (
          <tr key={i} className="hover:bg-gray-50">
            {row.map((cell, j) => (
              <td key={j} className="px-4 py-2 text-sm text-gray-700 whitespace-nowrap">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    {rows.length === 100 && (
      <p className="text-xs text-gray-500 mt-2 italic">Showing first 100 rows.</p>
    )}
  </div>
);

export default BillingIntegrity;
