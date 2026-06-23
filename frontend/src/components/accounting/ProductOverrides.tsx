import { AlertTriangle, Calendar, Info, Loader, RefreshCcw, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { getProductOverrides, getTenantOverrideAchDetails, getOverrideBreakdown, getOverrideBreakdownFilterOptions, ProductOverrideRow, ProductOverridesReconciliation } from '../../services/accounting/productOverrides.service';
import { CommissionHoldSettings } from '../../services/accounting/commissionBreakdown.service';
import { useNavigate } from 'react-router-dom';
import SearchableDropdown from '../common/SearchableDropdown';
import ClawbackDetailsModal from './ClawbackDetailsModal';
import { useMemberModalLauncher } from '../../hooks/useMemberModalLauncher';
import { useAuth } from '../../contexts/AuthContext';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
}

function toYmd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function startOfLastMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

interface ProductOverridesProps {
  holdSettings?: CommissionHoldSettings | null;
}

const ProductOverrides: React.FC<ProductOverridesProps> = ({ holdSettings = null }) => {
  const today = useMemo(() => new Date(), []);
  const [startDate, setStartDate] = useState(toYmd(startOfLastMonth(today)));
  const [endDate, setEndDate] = useState(holdSettings?.safeEndDate || toYmd(today));
  const [rows, setRows] = useState<ProductOverrideRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [achLoading, setAchLoading] = useState(false);
  const [achError, setAchError] = useState<string | null>(null);
  const [showAchModal, setShowAchModal] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<ProductOverrideRow | null>(null);
  const [clawbackTenant, setClawbackTenant] = useState<{ tenantId: string; tenantName: string } | null>(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { openMember, MemberModalElement } = useMemberModalLauncher();
  const navigateToGroup = (groupId: string) => {
    const role = user?.currentRole || 'TenantAdmin';
    setClawbackTenant(null);
    if (role === 'Agent') navigate(`/agent/groups/${groupId}`);
    else if (role === 'TenantAdmin') navigate(`/tenant-admin/groups/${groupId}`);
    else navigate(`/admin/groups/${groupId}`);
  };
  const [achDetails, setAchDetails] = useState<any | null>(null);
  const [showBreakdownModal, setShowBreakdownModal] = useState(false);
  const [breakdownData, setBreakdownData] = useState<any | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<any[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [reconciliation, setReconciliation] = useState<ProductOverridesReconciliation | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getProductOverrides({ startDate, endDate });
      if (res?.success) {
        setRows(res.data || []);
        setReconciliation(res.reconciliation ?? null);
      } else {
        setRows([]);
        setReconciliation(null);
        setError('Failed to load product overrides');
      }
    } catch (e: any) {
      setRows([]);
      setReconciliation(null);
      setError(e?.message || 'Failed to load product overrides');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  useEffect(() => {
    if (holdSettings?.safeEndDate) {
      setEndDate(holdSettings.safeEndDate);
    }
  }, [holdSettings?.safeEndDate]);

  const totalPaidAmount = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.paidAmount || 0), 0),
    [rows]
  );
  const totalUnpaidAmount = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.unpaidAmount || 0), 0),
    [rows]
  );
  // Tenant-level clawback is attached to every ACH row for that tenant; sum once per tenant.
  const totalPendingClawbackAmount = useMemo(() => {
    const byTenant = new Map<string, number>();
    for (const r of rows) {
      if (!r.tenantId || byTenant.has(r.tenantId)) continue;
      byTenant.set(r.tenantId, Number(r.pendingClawbackAmount || 0));
    }
    return [...byTenant.values()].reduce((a, b) => a + b, 0);
  }, [rows]);
  /** Unpaid amounts with no active Product Override ACH (pricing-only gaps, missing ACH id, or stale ACH ref). */
  const totalUncategorizedUnpaidAmount = useMemo(
    () =>
      rows.reduce(
        (sum, r) =>
          sum + (!r.hasActiveAch ? Number(r.unpaidAmount || 0) : 0),
        0
      ),
    [rows]
  );

  const openAchModal = async (account: ProductOverrideRow) => {
    setSelectedAccount(account);
    setShowAchModal(true);
    setAchLoading(true);
    setAchError(null);
    setAchDetails(null);
    try {
      const res = await getTenantOverrideAchDetails(account.tenantId);
      if (res?.success) {
        setAchDetails(res.data);
      } else {
        setAchError('Failed to load override ACH details');
      }
    } catch (e: any) {
      setAchError(e?.message || 'Failed to load override ACH details');
    } finally {
      setAchLoading(false);
    }
  };

  const openBreakdownModal = async (account: ProductOverrideRow) => {
    setSelectedAccount(account);
    setShowBreakdownModal(true);
    setSelectedFilter('all');
    setBreakdownLoading(true);
    setBreakdownError(null);
    setBreakdownData(null);
    setFilterOptionsLoading(true);
    
    try {
      // Load filter options
      const filterRes = await getOverrideBreakdownFilterOptions({
        overrideACHId: account.overrideACHId,
        tenantId: account.tenantId,
        startDate,
        endDate
      });
      if (filterRes?.success) {
        setFilterOptions(filterRes.data || []);
      }

      // Load breakdown data
      const res = await getOverrideBreakdown({
        overrideACHId: account.overrideACHId,
        tenantId: account.tenantId,
        startDate,
        endDate
      });
      if (res?.success) {
        setBreakdownData(res.data);
      } else {
        setBreakdownError('Failed to load breakdown');
      }
    } catch (e: any) {
      setBreakdownError(e?.message || 'Failed to load breakdown');
    } finally {
      setBreakdownLoading(false);
      setFilterOptionsLoading(false);
    }
  };

  const handleFilterChange = async (value: string, _label: string) => {
    setSelectedFilter(value);
    if (!selectedAccount) return;

    setBreakdownLoading(true);
    setBreakdownError(null);
    
    try {
      const [filterType, filterId] = value === 'all' ? ['all', null] : value.split('_');
      const params: any = {
        overrideACHId: selectedAccount.overrideACHId,
        tenantId: selectedAccount.tenantId,
        startDate,
        endDate
      };
      
      if (filterType === 'group') {
        params.groupId = filterId;
      } else if (filterType === 'member') {
        params.householdId = filterId;
      }

      const res = await getOverrideBreakdown(params);
      if (res?.success) {
        setBreakdownData(res.data);
      } else {
        setBreakdownError('Failed to load breakdown');
      }
    } catch (e: any) {
      setBreakdownError(e?.message || 'Failed to load breakdown');
    } finally {
      setBreakdownLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium text-gray-900">Product Overrides</h2>
            <p className="text-gray-600 mt-1">Override distributions based on configured product overrides</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="flex items-center gap-2">
              <div className="relative">
                <Calendar className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="date"
                  className="pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <span className="text-sm text-gray-500">to</span>
              <div className="relative">
                <Calendar className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="date"
                  className="pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            <button
              onClick={fetchData}
              disabled={loading}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 flex items-center justify-center"
            >
              {loading ? <Loader className="h-4 w-4 animate-spin mr-2" /> : <RefreshCcw className="h-4 w-4 mr-2" />}
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="p-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg mb-4">
            {error}
          </div>
        )}

        {reconciliation && !loading && (
          <div className="mb-4 flex gap-2 rounded-lg border border-slate-200 bg-slate-50/80 p-3 text-xs text-slate-700 leading-relaxed">
            <Info className="h-4 w-4 text-slate-500 flex-shrink-0 mt-0.5" />
            <div className="space-y-2 min-w-0">
              <p className="font-medium text-slate-900">
                Totals vs invoice “override” column
              </p>
              <p>
                This table matches{' '}
                <span className="font-medium">NACHA payout scope</span>:{' '}
                {reconciliation.fundedPaymentsInWindow} funded payment
                {reconciliation.fundedPaymentsInWindow === 1 ? '' : 's'} in this date range, using tenant setting{' '}
                <span className="font-medium">
                  {reconciliation.payoutBasis === 'paymentReceived'
                    ? 'pay when payment is received (invoice fulfillment / paid dates)'
                    : 'pay when coverage is effective (billing period overlap on linked invoices)'}
                </span>
                . It is{' '}
                <span className="font-medium">not</span> the sum of every invoice line for the same calendar months.
              </p>
              <ul className="list-disc pl-4 space-y-1 tabular-nums">
                <li>
                  Expected on this screen (sum of Total):{' '}
                  <span className="font-semibold">{formatCurrency(reconciliation.reportExpectedTotal)}</span>
                </li>
                <li>
                  Paid invoices — sum of stored <code className="text-[11px] bg-white px-1 rounded border">OverrideRate</code>{' '}
                  when billing period overlaps dates:{' '}
                  <span className="font-semibold">
                    {formatCurrency(reconciliation.invoicePaidOverrideBillingPeriodOverlap)}
                  </span>
                  {reconciliation.creditFundedPaidInvoiceOverrideBillingOverlap > 0.005 && (
                    <span className="text-slate-600">
                      {' '}
                      (credit-settled only, no payment row:{' '}
                      {formatCurrency(reconciliation.creditFundedPaidInvoiceOverrideBillingOverlap)} — excluded here until tied to a payment anchor)
                    </span>
                  )}
                </li>
                {reconciliation.payoutBasis === 'paymentReceived' && (
                  <li>
                    Same paid invoices, but only when <span className="font-medium">fulfillment</span> falls in this range:{' '}
                    <span className="font-semibold">
                      {formatCurrency(reconciliation.invoicePaidOverrideFulfillmentInWindow)}
                    </span>{' '}
                    (closer to this report when April coverage is often paid in June, etc.)
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Override Account</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Paid</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Unpaid</th>
                <th
                  className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                  title="Unpaid override amounts with no active Override ACH — includes pricing tiers that have OverrideRate but no ProductOverrides distribution rules (flows to product owner until rules exist)."
                >
                  Uncategorized
                </th>
                <th
                  className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                  title="Pending refund clawbacks at the tenant level. Will be deducted from this tenant's next NACHA override payout."
                >
                  Pending Clawback
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-10 text-center text-gray-500">
                    <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
                    Loading...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-10 text-center text-gray-500">
                    No override distributions found for this date range.
                  </td>
                </tr>
              ) : (
                rows.map(r => (
                  <tr
                    key={
                      r.uncategorizedPricingGap
                        ? `uncat_${r.tenantId}`
                        : r.overrideACHId || `tenant_${r.tenantId}`
                    }
                    className="hover:bg-gray-50"
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      {r.uncategorizedPricingGap ? (
                        <div className="text-left">
                          <div className="inline-flex items-center">
                            <div>
                              <div className="text-sm font-medium text-gray-900">{r.accountName}</div>
                              <div className="text-xs text-gray-500">{r.tenantName}</div>
                              <div className="text-xs text-gray-500 mt-0.5">Product owner · pricing tiers lack distribution rules</div>
                            </div>
                            <span className="ml-2" title="OverrideRate on pricing with no matching ProductOverrides">
                              <AlertTriangle className="h-4 w-4 text-amber-600" />
                            </span>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="text-left text-blue-600 hover:underline"
                          onClick={() => openAchModal(r)}
                        >
                          <div className="inline-flex items-center">
                            <div>
                              <div className="text-sm font-medium text-gray-900">{r.accountName}</div>
                              <div className="text-xs text-gray-500">{r.tenantName}</div>
                              {r.accountNumberLast4 && (
                                <div className="text-xs text-gray-400">•••• {r.accountNumberLast4}</div>
                              )}
                            </div>
                            {!r.hasActiveAch && (
                              <span
                                className="ml-2"
                                title="No active Product Override ACH for this distribution rule"
                              >
                                <AlertTriangle className="h-4 w-4 text-yellow-600" />
                              </span>
                            )}
                          </div>
                        </button>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <span 
                        className={r.paidAmount > 0 ? 'font-medium' : 'text-gray-500'}
                        style={r.paidAmount > 0 ? { color: 'var(--oe-success, #4caf50)' } : undefined}
                      >
                        {formatCurrency(r.paidAmount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <span 
                        className={r.unpaidAmount > 0 ? 'font-medium' : 'text-gray-500'}
                        style={r.unpaidAmount > 0 ? { color: 'var(--oe-error, #e53935)' } : undefined}
                      >
                        {formatCurrency(r.unpaidAmount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      {!r.hasActiveAch ? (
                        <span
                          className={
                            Number(r.unpaidAmount || 0) > 0 ? 'font-medium' : 'text-gray-500'
                          }
                          style={
                            Number(r.unpaidAmount || 0) > 0
                              ? { color: 'var(--oe-warning, #ed6c02)' }
                              : undefined
                          }
                          title={
                            r.uncategorizedPricingGap
                              ? 'Pricing OverrideRate with no ProductOverrides — add distribution rules and ACH on the product.'
                              : 'No active Product Override ACH on file for this bucket.'
                          }
                        >
                          {formatCurrency(r.unpaidAmount)}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-right"
                      title={
                        Number(r.pendingClawbackAmount || 0) > 0
                          ? `${r.pendingClawbackCount || 1} pending refund clawback${
                              (r.pendingClawbackCount || 1) === 1 ? '' : 's'
                            } at the tenant level — will reduce this tenant's next NACHA override payout`
                          : 'No pending clawbacks'
                      }
                    >
                      {Number(r.pendingClawbackAmount || 0) > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setClawbackTenant({
                              tenantId: r.tenantId,
                              tenantName: r.accountName || r.tenantName,
                            })
                          }
                          className="font-medium hover:underline focus:outline-none focus:underline"
                          style={{ color: 'var(--oe-warning, #ed6c02)' }}
                          title="View refunds behind this clawback"
                        >
                          −{formatCurrency(r.pendingClawbackAmount || 0)}
                        </button>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      {r.uncategorizedPricingGap ? (
                        <span className="font-medium text-gray-800">{formatCurrency(r.expectedAmount)}</span>
                      ) : (
                        <button
                          onClick={() => openBreakdownModal(r)}
                          className="text-blue-600 hover:underline font-medium"
                          title="View breakdown by product and tier"
                        >
                          {formatCurrency(r.expectedAmount)}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && rows.length > 0 && (
          <div className="mt-3">
            <p className="text-sm font-semibold text-gray-900 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span>
                Total paid (in range):{' '}
                <span
                  className={totalPaidAmount > 0 ? 'font-semibold' : 'text-gray-500 font-normal'}
                  style={totalPaidAmount > 0 ? { color: 'var(--oe-success, #4caf50)' } : undefined}
                >
                  {formatCurrency(totalPaidAmount)}
                </span>
              </span>
              <span className="text-gray-300 hidden sm:inline">|</span>
              <span>
                Total unpaid:{' '}
                <span className="text-red-700">{formatCurrency(totalUnpaidAmount)}</span>
              </span>
              <span className="text-gray-300 hidden sm:inline">|</span>
              <span title="Unpaid override with no active Override ACH (includes pricing-only tiers without ProductOverrides).">
                Uncategorized unpaid:{' '}
                <span
                  className={
                    totalUncategorizedUnpaidAmount > 0
                      ? 'font-medium text-amber-700'
                      : 'text-gray-500 font-normal'
                  }
                >
                  {formatCurrency(totalUncategorizedUnpaidAmount)}
                </span>
              </span>
              {totalPendingClawbackAmount > 0 && (
                <span className="text-sm font-medium text-orange-700">
                  Pending clawback: −{formatCurrency(totalPendingClawbackAmount)}
                </span>
              )}
            </p>
          </div>
        )}
      </div>

      {showAchModal && selectedAccount && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-lg border border-gray-200 w-full max-w-2xl">
            <div className="p-6 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium text-gray-900">Override ACH Details</h3>
                <p className="text-gray-600 mt-1">{selectedAccount.accountName}</p>
                <p className="text-gray-500 text-sm mt-1">{selectedAccount.tenantName}</p>
              </div>
              <button
                onClick={() => {
                  setShowAchModal(false);
                  setSelectedAccount(null);
                  setAchDetails(null);
                  setAchError(null);
                }}
                className="p-2 rounded-lg hover:bg-gray-50"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>

            <div className="p-6">
              {achError && (
                <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg mb-4">
                  {achError}
                </div>
              )}

              {achLoading ? (
                <div className="text-center text-gray-500 py-10">
                  <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
                  Loading ACH account...
                </div>
              ) : !achDetails ? (
                <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 rounded-lg">
                  No active override ACH account is configured.
                </div>
              ) : (
                <div>
                  <div className="mb-2 text-sm text-gray-600">
                    {achDetails.isSplit ? (
                      <span>Split payout across {achDetails.accounts?.length || 0} accounts</span>
                    ) : (
                      <span>All override ACH accounts for {selectedAccount.tenantName}</span>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Bank</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Used</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {(achDetails.accounts || []).map((a: any) => {
                          const isThisAccount = selectedAccount.overrideACHId && a.overrideACHId === selectedAccount.overrideACHId;
                          return (
                            <tr key={a.overrideACHId || a.achAccountId} className={isThisAccount ? 'bg-blue-50' : ''}>
                              <td className="px-4 py-3 text-sm text-gray-900">
                                <div className="font-medium">{a.accountHolderName}</div>
                                <div className="text-gray-500">{a.accountType || a.bankAccountType}{a.accountNumberLast4 ? ` • •••• ${a.accountNumberLast4}` : ''}</div>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600">{a.bankName}</td>
                              <td className="px-4 py-3 text-sm text-gray-600">
                                <span
                                  className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                    isThisAccount ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                                  }`}
                                >
                                  {isThisAccount ? 'Default' : 'Not used'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600">{a.status || (a.isActive ? 'Active' : 'Inactive')}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Breakdown Modal */}
      {showBreakdownModal && selectedAccount && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-lg border border-gray-200 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-lg font-medium text-gray-900">Override Breakdown</h3>
                <p className="text-gray-600 mt-1">{selectedAccount.accountName}</p>
                <p className="text-gray-500 text-sm mt-1">{selectedAccount.tenantName}</p>
                <p className="text-sm text-gray-500 mt-1">
                  Date Range: {(() => {
                    // Parse date parts separately to avoid timezone conversion issues (per backend-system.md)
                    const [y1, m1, d1] = startDate.split('-').map(Number);
                    const [y2, m2, d2] = endDate.split('-').map(Number);
                    const start = new Date(y1, m1 - 1, d1);
                    const end = new Date(y2, m2 - 1, d2);
                    return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
                  })()}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowBreakdownModal(false);
                  setSelectedAccount(null);
                  setBreakdownData(null);
                  setBreakdownError(null);
                  setSelectedFilter('all');
                  setFilterOptions([]);
                }}
                className="p-2 rounded-lg hover:bg-gray-50"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>

            <div className="p-6 border-b border-gray-200 flex-shrink-0">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Filter by Group or Member
              </label>
              <SearchableDropdown
                options={filterOptions}
                value={selectedFilter}
                onChange={handleFilterChange}
                placeholder="Select a filter..."
                loading={filterOptionsLoading}
                className="w-full"
              />
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {breakdownLoading ? (
                <div className="text-center text-gray-500 py-10">
                  <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
                  Loading breakdown...
                </div>
              ) : breakdownError ? (
                <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg">
                  {breakdownError}
                </div>
              ) : !breakdownData || breakdownData.length === 0 ? (
                <div className="text-center text-gray-500 py-10">
                  No breakdown data available for this account.
                </div>
              ) : (
                <div className="space-y-6">
                  {breakdownData.map((product: any, idx: number) => (
                    <div key={idx} className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
                        <h4 className="font-medium text-gray-900">{product.productName}</h4>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pricing Tier</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Enrollments</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Override Amount</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total Override</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {product.tiers.map((tier: any, tierIdx: number) => (
                              <tr key={tierIdx}>
                                <td className="px-4 py-3 text-sm text-gray-900">{tier.pricingTier}</td>
                                <td className="px-4 py-3 text-sm text-gray-900 text-right">{tier.enrollmentCount}</td>
                                <td className="px-4 py-3 text-sm text-gray-900 text-right">{formatCurrency(tier.overrideAmount)}</td>
                                <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">{formatCurrency(tier.totalOverride)}</td>
                              </tr>
                            ))}
                            <tr className="bg-gray-50 font-medium">
                              <td colSpan={3} className="px-4 py-3 text-sm text-gray-900 text-right">Product Total:</td>
                              <td className="px-4 py-3 text-sm text-gray-900 text-right">{formatCurrency(product.totalOverride)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <div className="flex justify-end">
                      <div className="text-right">
                        <div className="text-sm text-gray-500">Grand Total</div>
                        <div className="text-lg font-semibold text-gray-900">
                          {formatCurrency(
                            breakdownData.reduce((sum: number, p: any) => sum + (p.totalOverride || 0), 0)
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <ClawbackDetailsModal
        isOpen={!!clawbackTenant}
        onClose={() => setClawbackTenant(null)}
        recipientLabel={clawbackTenant?.tenantName || ''}
        source={
          clawbackTenant
            ? {
                kind: 'payout',
                payoutType: 'TenantOverride',
                recipientEntityId: clawbackTenant.tenantId,
              }
            : null
        }
        onOpenMember={(memberId) => {
          setClawbackTenant(null);
          openMember(memberId);
        }}
        onOpenGroup={(groupId) => navigateToGroup(groupId)}
      />
      {MemberModalElement}
    </div>
  );
};

export default ProductOverrides;


