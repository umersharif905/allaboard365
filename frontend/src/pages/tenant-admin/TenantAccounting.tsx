import {
  AlertCircle,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Filter,
  HelpCircle,
  Settings,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import UnifiedTenantSettingsModal from '../../components/UnifiedTenantSettingsModal';
import CommissionBreakdown from '../../components/accounting/CommissionBreakdown';
import GenerateCommissionsPreviewModal from '../../components/accounting/GenerateCommissionsPreviewModal';
import NACHAList from '../../components/accounting/NACHAList';
import NACHAWizard from '../../components/accounting/NACHAWizard';
import ProductOverrides from '../../components/accounting/ProductOverrides';
import VendorBreakdown from '../../components/accounting/VendorBreakdown';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import {
  CommissionHoldSettings,
  getCommissionBreakdownHoldSettings
} from '../../services/accounting/commissionBreakdown.service';
import {
  billingService,
  type BillingFeeRow,
  type BillingFilterOptions,
  type BillingFeesTotals
} from '../../services/billing.service';
import { apiService } from '../../services/apiServices';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import { useAuth } from '../../contexts/AuthContext';

function toYmd(d: Date) {
  return d.toISOString().slice(0, 10);
}
function startOfLastMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

const PAYMENT_STATUSES = [
  { value: '', label: 'All statuses' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Failed', label: 'Failed' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Returned', label: 'Returned' },
  { value: 'Voided', label: 'Voided' }
];

const TenantAccounting: React.FC = () => {
  const { user } = useAuth();
  const currentRole = user?.currentRole || 'TenantAdmin';

  const [activeTab, setActiveTab] = useState<'nacha' | 'vendors' | 'overrides' | 'commissions' | 'fees'>('nacha');
  const [showNACHAWizard, setShowNACHAWizard] = useState<boolean>(false);
  const [refreshNACHA, setRefreshNACHA] = useState<number>(0);
  const [autoOpenNachaId, setAutoOpenNachaId] = useState<string | undefined>();

  const [fees, setFees] = useState<BillingFeeRow[]>([]);
  const [feesTotals, setFeesTotals] = useState<BillingFeesTotals | null>(null);
  const [feesTotal, setFeesTotal] = useState(0);
  const [feesPage, setFeesPage] = useState(1);
  const [feesLimit] = useState(25);
  const [feesLoading, setFeesLoading] = useState(false);
  const [feesError, setFeesError] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<BillingFilterOptions | null>(null);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [groupIdFilter, setGroupIdFilter] = useState('');
  const [memberIdFilter, setMemberIdFilter] = useState('');
  const [agentIdFilter, setAgentIdFilter] = useState('');
  const [agencyIdFilter, setAgencyIdFilter] = useState('');
  const [feeDetailRow, setFeeDetailRow] = useState<BillingFeeRow | null>(null);
  const [feesStartDate, setFeesStartDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [feesEndDate, setFeesEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [holdSettings, setHoldSettings] = useState<CommissionHoldSettings | null>(null);
  const [holdSettingsLoading, setHoldSettingsLoading] = useState(true);
  const [commissionsStartDate, setCommissionsStartDate] = useState(() => toYmd(startOfLastMonth(new Date())));
  const [commissionsEndDate, setCommissionsEndDate] = useState(() => toYmd(new Date()));
  const [missingCommissionsCount, setMissingCommissionsCount] = useState<number | null>(null);
  const [loadingMissingCount, setLoadingMissingCount] = useState(false);
  const [showGenerateCommissionsModal, setShowGenerateCommissionsModal] = useState(false);
  const [generateCommissionsMode, setGenerateCommissionsMode] = useState<'missing' | 'topup'>('missing');
  const [showAdvancedCommissionActions, setShowAdvancedCommissionActions] = useState(false);
  const [showUnderpaidHint, setShowUnderpaidHint] = useState(false);
  const [showPayoutSettings, setShowPayoutSettings] = useState(false);
  const [settingsTenant, setSettingsTenant] = useState<any>(null);

  const openPayoutSettings = useCallback(async () => {
    try {
      const res = await TenantAdminService.getTenantSettings();
      if (res.success && res.data) {
        const s = res.data as any;
        setSettingsTenant({
          TenantId: s.tenantId,
          Name: s.name || 'Organization',
          LogoUrl: s.branding?.logoUrl,
          PrimaryColorHex: s.branding?.primaryColorHex,
          SecondaryColorHex: s.branding?.secondaryColorHex,
          CustomDomain: s.domainSettings?.customUrl,
          DefaultUrlPath: s.domainSettings?.defaultUrlPath || '',
          MemberIDPrefix: s.branding?.memberIDPrefix || 'OED',
          AdvancedSettings: JSON.stringify({
            branding: s.branding,
            domain: s.domainSettings,
            email: s.emailSettings,
            notifications: s.notificationSettings,
            features: s.features
          }),
          SystemFees: '{}'
        });
        setShowPayoutSettings(true);
      }
    } catch (err) {
      console.error('Failed to load tenant settings:', err);
    }
  }, []);

  const loadFilterOptions = useCallback(() => {
    if (!currentRole) return;
    setFilterOptionsLoading(true);
    billingService
      .getFilterOptions(currentRole)
      .then((res) => {
        if (res.success && res.data) setFilterOptions(res.data);
        else setFilterOptions(null);
      })
      .finally(() => setFilterOptionsLoading(false));
  }, [currentRole]);

  const loadFees = useCallback(() => {
    if (!currentRole) return;
    setFeesLoading(true);
    setFeesError(null);
    billingService
      .getFees(currentRole, {
        status: statusFilter || undefined,
        groupId: groupIdFilter || undefined,
        memberId: memberIdFilter || undefined,
        agentId: agentIdFilter || undefined,
        agencyId: agencyIdFilter || undefined,
        startDate: feesStartDate || undefined,
        endDate: feesEndDate || undefined,
        page: feesPage,
        limit: feesLimit
      })
      .then((res) => {
        if (res.success && Array.isArray(res.data)) {
          setFees(res.data);
          setFeesTotal(typeof res.total === 'number' ? res.total : res.data.length);
          setFeesTotals(res.totals ?? null);
        } else {
          setFees([]);
          setFeesTotal(0);
          setFeesTotals(null);
          setFeesError(res.message || 'Failed to load fees');
        }
      })
      .catch((err) => {
        setFees([]);
        setFeesTotal(0);
        setFeesTotals(null);
        setFeesError(err?.message || 'Failed to load fees');
      })
      .finally(() => setFeesLoading(false));
  }, [
    currentRole,
    statusFilter,
    groupIdFilter,
    memberIdFilter,
    agentIdFilter,
    agencyIdFilter,
    feesStartDate,
    feesEndDate,
    feesPage,
    feesLimit
  ]);

  useEffect(() => {
    if (activeTab === 'fees') loadFilterOptions();
  }, [activeTab, loadFilterOptions]);

  useEffect(() => {
    if (activeTab !== 'fees') return;
    loadFees();
  }, [activeTab, loadFees]);

  const fetchMissingCommissionsCount = useCallback(async () => {
    setLoadingMissingCount(true);
    try {
      const params = new URLSearchParams();
      if (commissionsStartDate) params.set('startDate', commissionsStartDate);
      if (commissionsEndDate) params.set('endDate', commissionsEndDate);
      const query = params.toString() ? `?${params.toString()}` : '';
      const response = await apiService.get<{ success: boolean; missingCount: number; message?: string }>(`/api/commissions/missing${query}`);
      if (response.success) {
        setMissingCommissionsCount(response.missingCount);
      }
    } catch (error: any) {
      console.error('Failed to fetch missing commissions count:', error);
      setMissingCommissionsCount(null);
    } finally {
      setLoadingMissingCount(false);
    }
  }, [commissionsStartDate, commissionsEndDate]);

  const handleGenerateMissingClick = () => {
    setGenerateCommissionsMode('missing');
    setShowGenerateCommissionsModal(true);
    // Refresh count when opening so the button matches missing-preview (same API filters).
    fetchMissingCommissionsCount();
  };

  const handleGenerateTopupsClick = () => {
    setGenerateCommissionsMode('topup');
    setShowGenerateCommissionsModal(true);
  };

  useEffect(() => {
    if (activeTab === 'commissions') {
      fetchMissingCommissionsCount();
    }
  }, [activeTab, fetchMissingCommissionsCount, commissionsStartDate, commissionsEndDate]);

  useEffect(() => {
    const fetchHoldSettings = async () => {
      setHoldSettingsLoading(true);
      try {
        const res = await getCommissionBreakdownHoldSettings();
        if (res?.success && res.data) {
          setHoldSettings(res.data);
          if (res.data.safeEndDate) {
            setCommissionsEndDate(res.data.safeEndDate);
          }
        } else {
          setHoldSettings(null);
        }
      } catch (e) {
        setHoldSettings(null);
      } finally {
        setHoldSettingsLoading(false);
      }
    };

    fetchHoldSettings();
  }, []);

  const formatDate = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const formatCurrency = (n: number) =>
    `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const feesTotalPages = Math.ceil(feesTotal / feesLimit) || 1;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow-sm">
        <div className="px-6 pt-4">
          <div className="border-b border-gray-200">
            <nav className="flex space-x-0">
              <button
                className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                  activeTab === 'nacha'
                    ? 'border-oe-primary text-gray-900 font-semibold'
                    : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                }`}
                style={activeTab === 'nacha' ? { 
                  backgroundColor: 'rgba(37, 99, 235, 0.08)',
                  borderBottomColor: 'var(--oe-primary, #2563EB)',
                  borderBottomWidth: '3px'
                } : {}}
                onClick={() => setActiveTab('nacha')}
              >
                <span className="font-semibold text-gray-900">NACHA Payouts</span>
              </button>
              <button
                className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                  activeTab === 'vendors'
                    ? 'border-oe-primary text-gray-900 font-semibold'
                    : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                }`}
                style={activeTab === 'vendors' ? { 
                  backgroundColor: 'rgba(37, 99, 235, 0.08)',
                  borderBottomColor: 'var(--oe-primary, #2563EB)',
                  borderBottomWidth: '3px'
                } : {}}
                onClick={() => setActiveTab('vendors')}
              >
                <span className="font-semibold text-gray-900">Vendor Breakdown</span>
                <span className="relative group/tip inline-flex items-center ml-1 align-middle">
                  <HelpCircle className="h-3.5 w-3.5 text-gray-400 cursor-help" />
                  <span className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-50 w-64 text-left leading-relaxed">
                    Vendors are paid based on when enrolled members' coverage is effective, not when payment is collected.
                  </span>
                </span>
              </button>
              <button
                className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                  activeTab === 'overrides'
                    ? 'border-oe-primary text-gray-900 font-semibold'
                    : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                }`}
                style={activeTab === 'overrides' ? { 
                  backgroundColor: 'rgba(37, 99, 235, 0.08)',
                  borderBottomColor: 'var(--oe-primary, #2563EB)',
                  borderBottomWidth: '3px'
                } : {}}
                onClick={() => setActiveTab('overrides')}
              >
                <span className="font-semibold text-gray-900">Product Overrides</span>
                <span className="relative group/tip inline-flex items-center ml-1 align-middle">
                  <HelpCircle className="h-3.5 w-3.5 text-gray-400 cursor-help" />
                  <span className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-50 w-56 text-left leading-relaxed">
                    Override distributions are paid based on when member payments are received.
                  </span>
                </span>
              </button>
              <button
                className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                  activeTab === 'commissions'
                    ? 'border-oe-primary text-gray-900 font-semibold'
                    : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                }`}
                style={activeTab === 'commissions' ? { 
                  backgroundColor: 'rgba(37, 99, 235, 0.08)',
                  borderBottomColor: 'var(--oe-primary, #2563EB)',
                  borderBottomWidth: '3px'
                } : {}}
                onClick={() => setActiveTab('commissions')}
              >
                <span className="font-semibold text-gray-900">Commissions</span>
                <span className="relative group/tip inline-flex items-center ml-1 align-middle">
                  <HelpCircle className="h-3.5 w-3.5 text-gray-400 cursor-help" />
                  <span className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-50 w-56 text-left leading-relaxed">
                    Agent commissions are paid based on when payments are received, subject to the configured hold period.
                  </span>
                </span>
              </button>
              <button
                className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                  activeTab === 'fees'
                    ? 'border-oe-primary text-gray-900 font-semibold'
                    : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                }`}
                style={activeTab === 'fees' ? { 
                  backgroundColor: 'rgba(37, 99, 235, 0.08)',
                  borderBottomColor: 'var(--oe-primary, #2563EB)',
                  borderBottomWidth: '3px'
                } : {}}
                onClick={() => setActiveTab('fees')}
              >
                <span className="font-semibold text-gray-900">Fees</span>
              </button>
              <button
                className="flex items-center justify-center px-3 py-4 text-gray-400 hover:text-gray-600 transition-colors"
                onClick={openPayoutSettings}
                title="Payout Settings"
              >
                <Settings className="h-4 w-4" />
              </button>
            </nav>
          </div>
        </div>

        <div className="p-6">
          {activeTab === 'nacha' ? (
            <>
              {/* NACHA Toolbar */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowNACHAWizard(true)}
                    className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark transition-colors flex items-center"
                  >
                    <CreditCard size={16} className="mr-2" />
                    New NACHA Payout
                  </button>
                </div>
              </div>

              {/* NACHA Files List */}
              <NACHAList refreshTrigger={refreshNACHA} autoOpenNachaId={autoOpenNachaId} />
            </>
          ) : activeTab === 'vendors' ? (
            holdSettingsLoading ? (
              <div className="text-center py-10 text-gray-500">Loading date defaults...</div>
            ) : (
              <VendorBreakdown holdSettings={holdSettings} />
            )
          ) : activeTab === 'overrides' ? (
            holdSettingsLoading ? (
              <div className="text-center py-10 text-gray-500">Loading date defaults...</div>
            ) : (
              <>
                <div className="mb-4 flex items-center gap-1.5 text-xs text-gray-500">
                  <HelpCircle className="h-3.5 w-3.5" />
                  <span>Amounts reflect when member payments are received. Configure in Payout Settings.</span>
                </div>
                <ProductOverrides holdSettings={holdSettings} />
              </>
            )
          ) : activeTab === 'fees' ? (
            <>
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <Filter className="h-5 w-5 text-gray-500" />
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <span>From</span>
                  <input
                    type="date"
                    value={feesStartDate}
                    onChange={(e) => setFeesStartDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <span>To</span>
                  <input
                    type="date"
                    value={feesEndDate}
                    onChange={(e) => setFeesEndDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                </label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  {PAYMENT_STATUSES.map((s) => (
                    <option key={s.value || 'all'} value={s.value}>{s.label}</option>
                  ))}
                </select>
                {filterOptions && (
                  <>
                    <SearchableDropdown
                      options={filterOptions.groups}
                      value={groupIdFilter}
                      onChange={(v) => setGroupIdFilter(v || '')}
                      placeholder="Group"
                      className="min-w-[160px]"
                    />
                    <SearchableDropdown
                      options={filterOptions.members}
                      value={memberIdFilter}
                      onChange={(v) => setMemberIdFilter(v || '')}
                      placeholder="Member"
                      className="min-w-[160px]"
                      showEmail
                    />
                    <SearchableDropdown
                      options={filterOptions.agents}
                      value={agentIdFilter}
                      onChange={(v) => setAgentIdFilter(v || '')}
                      placeholder="Agent"
                      className="min-w-[160px]"
                      showEmail
                    />
                    <SearchableDropdown
                      options={filterOptions.agencies}
                      value={agencyIdFilter}
                      onChange={(v) => setAgencyIdFilter(v || '')}
                      placeholder="Agency"
                      className="min-w-[160px]"
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setFeesPage(1);
                    loadFees();
                  }}
                  disabled={feesLoading || filterOptionsLoading}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
                >
                  {feesLoading ? 'Loading...' : 'Apply'}
                </button>
              </div>
              {feesError && (
                <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 flex items-center gap-2 mb-4">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <span>{feesError}</span>
                </div>
              )}
              {feesTotals && (
                <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                  <p className="text-sm font-medium text-gray-700 mb-2">Total fees (filtered)</p>
                  <div className="flex flex-wrap gap-6">
                    <span className="text-sm text-gray-600">
                      Payment amount: <span className="font-semibold text-gray-900">{formatCurrency(feesTotals.totalAmount)}</span>
                    </span>
                    <span className="text-sm text-gray-600">
                      Processing fee: <span className="font-semibold text-gray-900">{formatCurrency(feesTotals.totalProcessingFee)}</span>
                    </span>
                    <span className="text-sm text-gray-600">
                      System fee: <span className="font-semibold text-gray-900">{formatCurrency(feesTotals.totalSystemFee)}</span>
                    </span>
                    <span className="text-sm text-gray-600">
                      Total fees: <span className="font-semibold text-gray-900">{formatCurrency(feesTotals.totalFees)}</span>
                    </span>
                  </div>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Date</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Group / Member</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Payment amount</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Processing fee</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">System fee</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Total fee</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {feesLoading ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                          Loading...
                        </td>
                      </tr>
                    ) : fees.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                          No payments with fees found.
                        </td>
                      </tr>
                    ) : (
                      fees.map((row) => {
                        const dime = row.dimeProcessorFee ?? null;
                        const ours = row.processingFee ?? 0;
                        const feeColorClass =
                          dime != null && dime > 0
                            ? ours < dime
                              ? 'text-yellow-600 bg-yellow-50'
                              : Math.abs(ours - dime) < 0.005
                                ? 'text-blue-600 bg-blue-50'
                                : 'text-green-600 bg-green-50'
                            : 'text-gray-600';
                        const displayFee = row.dimeProcessorFee ?? row.processingFee;
                        return (
                          <tr key={row.paymentId} className="hover:bg-gray-50">
                            <td className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">
                              {formatDate(row.paymentDate)}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-900">
                              {row.groupName ?? row.memberName ?? '—'}
                            </td>
                            <td className="px-4 py-2 text-sm text-right text-gray-900">
                              {formatCurrency(row.amount)}
                            </td>
                            <td className="px-4 py-2 text-sm text-right">
                              <button
                                type="button"
                                onClick={() => setFeeDetailRow(row)}
                                className={`inline-flex items-center justify-end w-full text-right font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-1 py-0.5 ${feeColorClass}`}
                              >
                                {(row.processingFee ?? 0) > 0 ? formatCurrency(row.processingFee) : '—'}
                              </button>
                            </td>
                            <td className="px-4 py-2 text-sm text-right text-gray-900">
                              {formatCurrency(row.systemFee)}
                            </td>
                            <td className="px-4 py-2 text-sm text-right font-medium text-gray-900">
                              {formatCurrency(row.totalFee)}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              {feeDetailRow && (
                <div className="fixed inset-0 z-50 overflow-y-auto">
                  <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
                    <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setFeeDetailRow(null)} />
                    <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                      <h3 className="text-lg font-semibold text-gray-900">Processing fee</h3>
                      <p className="mt-1 text-sm text-gray-500">
                        {formatDate(feeDetailRow.paymentDate)} · {formatCurrency(feeDetailRow.amount)}
                        {(feeDetailRow.groupName || feeDetailRow.memberName) && (
                          <> · {feeDetailRow.groupName ?? feeDetailRow.memberName}</>
                        )}
                      </p>
                      <div className="mt-4 space-y-3">
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">From processor (DIME):</span>
                          <span className="font-medium text-gray-900">
                            {feeDetailRow.dimeProcessorFeeComingSoon
                              ? 'Coming soon'
                              : (feeDetailRow.dimeProcessorFee ?? 0) > 0
                                ? formatCurrency(feeDetailRow.dimeProcessorFee!)
                                : '—'}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">From our system (oe.Enrollments):</span>
                          <span className="font-medium text-gray-900">{formatCurrency(feeDetailRow.processingFee)}</span>
                        </div>
                      </div>
                      <div className="mt-6 flex justify-end">
                        <button
                          type="button"
                          onClick={() => setFeeDetailRow(null)}
                          className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {feesTotal > 0 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-gray-600">
                    Showing {(feesPage - 1) * feesLimit + 1}–{Math.min(feesPage * feesLimit, feesTotal)} of {feesTotal}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setFeesPage((p) => Math.max(1, p - 1))}
                      disabled={feesPage <= 1 || feesLoading}
                      className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <span className="text-sm text-gray-700">
                      Page {feesPage} of {feesTotalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setFeesPage((p) => Math.min(feesTotalPages, p + 1))}
                      disabled={feesPage >= feesTotalPages || feesLoading}
                      className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            holdSettingsLoading ? (
              <div className="text-center py-10 text-gray-500">Loading date defaults...</div>
            ) : (
              <>
                {/* Missing Commissions Warning */}
                {missingCommissionsCount !== null && missingCommissionsCount > 0 && (
                  <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5 text-yellow-600" />
                      <div className="flex-1">
                        <h3 className="text-sm font-semibold text-yellow-800">
                          Missing Commissions Detected
                        </h3>
                        <p className="text-sm text-yellow-700 mt-1">
                          {missingCommissionsCount} invoice(s) found without commission rows. These commissions can be generated retroactively using the same logic as the commission trigger.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mb-4 flex items-center gap-1.5 text-xs text-gray-500">
                  <HelpCircle className="h-3.5 w-3.5" />
                  <span>Amounts reflect when payments are received, subject to the configured hold period. Configure in Payout Settings.</span>
                </div>
                <CommissionBreakdown
                  holdSettings={holdSettings}
                  startDate={commissionsStartDate}
                  endDate={commissionsEndDate}
                  onStartDateChange={setCommissionsStartDate}
                  onEndDateChange={setCommissionsEndDate}
                  onRefresh={fetchMissingCommissionsCount}
                  showMainTableFilter={showAdvancedCommissionActions}
                  advancedPanelOpen={showAdvancedCommissionActions}
                  headerActions={
                    <div className="flex flex-wrap items-center gap-3">
                      {missingCommissionsCount !== null && missingCommissionsCount > 0 && (
                        <button
                          onClick={handleGenerateMissingClick}
                          disabled={loadingMissingCount}
                          className="bg-yellow-600 text-white px-4 py-2 rounded-md hover:bg-yellow-700 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <AlertTriangle size={16} className="mr-2" />
                          {loadingMissingCount ? 'Loading...' : `Generate missing commissions (${missingCommissionsCount})`}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowAdvancedCommissionActions((v) => !v)}
                        className="px-3 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
                      >
                        {showAdvancedCommissionActions ? 'Hide advanced options' : 'Advanced options'}
                      </button>
                      {showAdvancedCommissionActions && (
                        <div className="relative inline-flex flex-col items-start">
                          <button
                            onClick={handleGenerateTopupsClick}
                            onMouseEnter={() => setShowUnderpaidHint(true)}
                            onMouseLeave={() => setShowUnderpaidHint(false)}
                            onFocus={() => setShowUnderpaidHint(true)}
                            onBlur={() => setShowUnderpaidHint(false)}
                            disabled={loadingMissingCount}
                            className="bg-white text-gray-700 border border-gray-300 px-4 py-2 rounded-md hover:bg-gray-50 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                            aria-describedby="underpaid-commissions-help"
                          >
                            <AlertTriangle size={16} className="mr-2" />
                            Check for top ups
                          </button>
                          {showUnderpaidHint && (
                            <div
                              id="underpaid-commissions-help"
                              role="tooltip"
                              className="absolute top-full left-0 mt-2 w-[420px] max-w-[90vw] p-3 rounded-md border border-blue-200 bg-white shadow-md text-sm text-gray-700 z-20"
                            >
                              Compare current commission rules against past payouts. Check for top ups when rule
                              changes may have underpaid agents on already-paid invoices.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  }
                />
              </>
            )
          )}
        </div>
      </div>

      {/* NACHA Wizard Modal */}
      <NACHAWizard
        isOpen={showNACHAWizard}
        onClose={() => setShowNACHAWizard(false)}
        onSuccess={(generatedNACHA) => {
          setRefreshNACHA(prev => prev + 1);
          setShowNACHAWizard(false);
          if (generatedNACHA?.nachaId) {
            setAutoOpenNachaId(generatedNACHA.nachaId);
          }
        }}
      />

      {/* Generate commissions preview modal */}
      <GenerateCommissionsPreviewModal
        isOpen={showGenerateCommissionsModal}
        onClose={() => setShowGenerateCommissionsModal(false)}
        onGenerated={() => fetchMissingCommissionsCount()}
        onMissingCountLoaded={(count) => setMissingCommissionsCount(count)}
        mode={generateCommissionsMode}
        startDate={commissionsStartDate}
        endDate={commissionsEndDate}
      />

      {showPayoutSettings && settingsTenant && (
        <UnifiedTenantSettingsModal
          tenant={settingsTenant}
          onClose={() => setShowPayoutSettings(false)}
          onSave={() => {
            // Keep the modal open so the user sees the save confirmation.
            // The parent can refetch any cached tenant data here if needed.
          }}
          initialTab="payouts"
        />
      )}
    </div>
  );
};

export default TenantAccounting;