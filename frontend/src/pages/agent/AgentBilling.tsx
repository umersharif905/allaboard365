import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  Filter,
  Heart,
  RefreshCw,
  User,
  UserCheck,
  Users,
  FileText,
  Loader2,
  XCircle
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import {
  AGENT_FILTER_SCOPE_AGENCY,
  AGENT_FILTER_SCOPE_DIRECT_DOWNLINE,
  AGENT_FILTER_SHOW_ALL,
  getInitialAgentFilterIdFromStorage
} from '../../constants/agentFilterScope';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import { useAgentInvoices } from '../../hooks/useInvoices';
import type { Invoice } from '../../services/invoices.service';
import { useAuth } from '../../contexts/AuthContext';
import { accountingService, type PaymentRetryOptionsResponse } from '../../services/AccountingService';
import { apiService } from '../../services/api.service';
import {
  billingService,
  formatBillingPaymentStatusLabel,
  getPaymentMethodType,
    paymentMethodBadgeClasses,
  type BillingFilterOptions,
  type BillingPaymentRow,
  type BillingPaymentsStatusSummary
} from '../../services/billing.service';
import { Member } from '../../types/member.types';
import MemberManagementModal from '../members/MemberManagementModal';
import { FailedPaymentReasonBadge } from '../../components/billing/FailedPaymentReasonBadge';
import { getStoredDimePaymentFailureUiHint } from '../../constants/dimePaymentFailureHints';
import { buildFailedPaymentStatusTitle } from '../../utils/billingPaymentFailureTooltip';

const PAYMENT_STATUS_UNRESOLVED_FAILED = '__unresolved_failed__';

const PAYMENT_STATUSES = [
  { value: '', label: 'All statuses' },
  { value: PAYMENT_STATUS_UNRESOLVED_FAILED, label: 'Unresolved failed payments' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Refunded', label: 'Refunded' },
  { value: 'Failed', label: 'Failed' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Returned', label: 'Returned' },
  { value: 'Voided', label: 'Voided' }
];

function getMonthRange(year: number, month: number): { startDate: string; endDate: string } {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

function getDefaultTransactionsDateRange(): { startDate: string; endDate: string } {
  const n = new Date();
  return getMonthRange(n.getFullYear(), n.getMonth() + 1);
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
}

function formatDate(d: string | Date | null | undefined): string {
  if (d == null) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

interface Enrollment {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

const AgentBilling: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const currentRole = user?.currentRole || 'Agent';

  const [payments, setPayments] = useState<BillingPaymentRow[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [paymentsSummary, setPaymentsSummary] = useState<BillingPaymentsStatusSummary | null>(null);
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [paymentsLimit] = useState(25);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<BillingFilterOptions | null>(null);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [groupIdFilter, setGroupIdFilter] = useState('');
  const [memberIdFilter, setMemberIdFilter] = useState('');
  const [paymentDetailModal, setPaymentDetailModal] = useState<BillingPaymentRow | null>(null);
  const [processorFeeModalPayment, setProcessorFeeModalPayment] = useState<BillingPaymentRow | null>(null);
  const [processorFeeDetail, setProcessorFeeDetail] = useState<{
    ourProcessingFee: number;
    processorName: string | null;
    processorFee: number | null;
    processorFeeComingSoon?: boolean;
  } | null>(null);
  const [processorFeeDetailLoading, setProcessorFeeDetailLoading] = useState(false);
  const [transactionsStartDate, setTransactionsStartDate] = useState(() => getDefaultTransactionsDateRange().startDate);
  const [transactionsEndDate, setTransactionsEndDate] = useState(() => getDefaultTransactionsDateRange().endDate);

  const [retryModalPayment, setRetryModalPayment] = useState<BillingPaymentRow | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<null | 'success' | 'error'>(null);
  const [retryResultMessage, setRetryResultMessage] = useState('');
  const [retryOptions, setRetryOptions] = useState<PaymentRetryOptionsResponse | null>(null);
  const [retryOptionsLoading, setRetryOptionsLoading] = useState(false);
  const [retrySelectedPaymentMethodId, setRetrySelectedPaymentMethodId] = useState<string | null>(null);

  const [selectedMemberForModal, setSelectedMemberForModal] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<Enrollment[]>([]);
  const [memberModalEnrollmentsLoading, setMemberModalEnrollmentsLoading] = useState(false);

  const [agentBillingTab, setAgentBillingTab] = useState<'payments' | 'invoices'>('payments');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState('');
  const { data: agentInvoicesData = [], isLoading: agentInvoicesLoading } = useAgentInvoices(
    { status: invoiceStatusFilter || undefined },
    agentBillingTab === 'invoices'
  );

  const [salesAgentFilter, setSalesAgentFilter] = useState(
    () => getInitialAgentFilterIdFromStorage() || AGENT_FILTER_SHOW_ALL
  );
  const { data: downlineAgentOptions, isLoading: isLoadingDownlineAgents, agencyWideFilterAvailable } =
    useDownlineAgentsForFilter({
      includeShowAllOption: true,
      agencyOwnerFilter: true
    });

  useEffect(() => {
    if (user?.currentRole !== 'Agent') return;
    if (!agencyWideFilterAvailable) return;
    setSalesAgentFilter((prev) => (prev === AGENT_FILTER_SHOW_ALL ? AGENT_FILTER_SCOPE_AGENCY : prev));
  }, [user?.currentRole, agencyWideFilterAvailable]);

  const agentFilterPlaceholderLabels = useMemo(() => {
    const agency = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SCOPE_AGENCY)?.label ?? 'All Agency Agents';
    const direct = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE)?.label ?? 'Direct downlines';
    const downline = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SHOW_ALL)?.label ?? 'Show all';
    return { agency, direct, downline };
  }, [downlineAgentOptions]);

  const getTransactionsDateRange = useCallback((): { startDate?: string; endDate?: string } => {
    if (transactionsStartDate && transactionsEndDate) {
      return { startDate: transactionsStartDate, endDate: transactionsEndDate };
    }
    return {};
  }, [transactionsStartDate, transactionsEndDate]);

  const loadFilterOptions = useCallback(() => {
    if (currentRole !== 'Agent') return;
    setFilterOptionsLoading(true);
    billingService
      .getFilterOptions(currentRole)
      .then((res) => {
        if (res.success && res.data) setFilterOptions(res.data);
        else setFilterOptions(null);
      })
      .finally(() => setFilterOptionsLoading(false));
  }, [currentRole]);

  const loadPayments = useCallback(
    (override?: {
      page?: number;
      startDate?: string;
      endDate?: string;
      status?: string;
      groupId?: string;
      memberId?: string;
    }) => {
      if (currentRole !== 'Agent') return;
      setPaymentsLoading(true);
      setPaymentsError(null);
      const range =
        override?.startDate != null && override?.endDate != null
          ? { startDate: override.startDate, endDate: override.endDate }
          : getTransactionsDateRange();
      const { startDate, endDate } = range;
      const page = override?.page ?? paymentsPage;
      const statusFilterEff = override?.status !== undefined ? override.status : statusFilter;
      const groupEff = override?.groupId !== undefined ? override.groupId : groupIdFilter;
      const memberEff = override?.memberId !== undefined ? override.memberId : memberIdFilter;
      const unresolvedFailedOnly = statusFilterEff === PAYMENT_STATUS_UNRESOLVED_FAILED;
      const status = unresolvedFailedOnly ? undefined : statusFilterEff || undefined;
      const salesParam =
        currentRole === 'Agent'
          ? !salesAgentFilter || salesAgentFilter === ''
            ? 'me'
            : salesAgentFilter
          : undefined;
      billingService
        .getPayments(currentRole, {
          status,
          unresolvedFailedOnly: unresolvedFailedOnly ? true : undefined,
          groupId: groupEff || undefined,
          memberId: memberEff || undefined,
          ...(currentRole === 'Agent' && salesParam != null ? { salesAgentFilter: salesParam } : {}),
          startDate,
          endDate,
          page,
          limit: paymentsLimit
        })
        .then((res) => {
          if (res.success && Array.isArray(res.data)) {
            setPayments(res.data);
            setPaymentsTotal(typeof res.total === 'number' ? res.total : res.data.length);
            setPaymentsSummary(res.summary ?? null);
          } else {
            setPayments([]);
            setPaymentsTotal(0);
            setPaymentsSummary(null);
            setPaymentsError(res.message || 'Failed to load payments');
          }
        })
        .catch((err) => {
          setPayments([]);
          setPaymentsTotal(0);
          setPaymentsSummary(null);
          setPaymentsError(err?.message || 'Failed to load payments');
        })
        .finally(() => setPaymentsLoading(false));
    },
    [
      currentRole,
      getTransactionsDateRange,
      paymentsPage,
      paymentsLimit,
      statusFilter,
      groupIdFilter,
      memberIdFilter
    ]
  );

  useEffect(() => {
    loadFilterOptions();
  }, [loadFilterOptions]);

  useEffect(() => {
    loadPayments();
  }, [loadPayments]);

  useEffect(() => {
    if (!processorFeeModalPayment?.paymentId || currentRole !== 'Agent') return;
    setProcessorFeeDetail(null);
    setProcessorFeeDetailLoading(true);
    billingService
      .getProcessorFeeDetail(currentRole, processorFeeModalPayment.paymentId)
      .then((res) => {
        if (res.success && res.data) setProcessorFeeDetail(res.data);
        else setProcessorFeeDetail(null);
      })
      .catch(() => setProcessorFeeDetail(null))
      .finally(() => setProcessorFeeDetailLoading(false));
  }, [processorFeeModalPayment?.paymentId, currentRole]);

  const resetTransactionsFilters = useCallback(() => {
    const r = getDefaultTransactionsDateRange();
    setTransactionsStartDate(r.startDate);
    setTransactionsEndDate(r.endDate);
    setStatusFilter('');
    setGroupIdFilter('');
    setMemberIdFilter('');
    setSalesAgentFilter(
      agencyWideFilterAvailable ? AGENT_FILTER_SCOPE_AGENCY : AGENT_FILTER_SHOW_ALL
    );
    setPaymentsPage(1);
  }, [user?.currentRole, agencyWideFilterAvailable]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(paymentsTotal / paymentsLimit)),
    [paymentsTotal, paymentsLimit]
  );

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'Terminated':
        return 'bg-red-100 text-red-800';
      case 'Inactive':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getRelationshipIcon = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P':
        return <UserCheck className="h-4 w-4 text-blue-600" />;
      case 'S':
        return <Heart className="h-4 w-4 text-pink-600" />;
      case 'C':
        return <User className="h-4 w-4 text-gray-600" />;
      default:
        return <UserCheck className="h-4 w-4 text-blue-600" />;
    }
  };

  const getRelationshipColor = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P':
        return 'bg-blue-100 text-blue-800';
      case 'S':
        return 'bg-pink-100 text-pink-800';
      case 'C':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-blue-100 text-blue-800';
    }
  };

  const openMemberManagementModal = useCallback(async (memberId: string) => {
    if (!memberId) return;
    setMemberModalEnrollmentsLoading(true);
    setSelectedMemberForModal(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
    try {
      const householdRes = await apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(
        `/api/members/${memberId}/with-household`
      );
      if (householdRes.success && householdRes.data) {
        setSelectedMemberForModal(householdRes.data.member);
        setMemberModalHousehold(householdRes.data.householdMembers || []);
      }
      const [activeRes, pendingRes] = await Promise.all([
        apiService.get<{ success: boolean; data: Enrollment[] }>(`/api/enrollments?memberId=${memberId}&status=Active`),
        apiService.get<{ success: boolean; data: Enrollment[] }>(`/api/enrollments?memberId=${memberId}&status=Pending`)
      ]);
      const active = activeRes.success ? activeRes.data || [] : [];
      const pending = pendingRes.success ? pendingRes.data || [] : [];
      const combined = [...active, ...pending];
      const unique = combined.filter(
        (e: Enrollment, i: number, self: Enrollment[]) =>
          self.findIndex((x) => (x.EnrollmentId || (x as { enrollmentId?: string }).enrollmentId) === (e.EnrollmentId || (e as { enrollmentId?: string }).enrollmentId)) === i
      );
      setMemberModalEnrollments(unique);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load member');
    } finally {
      setMemberModalEnrollmentsLoading(false);
    }
  }, []);

  const handleTransactionMemberOrGroupClick = useCallback(
    async (p: BillingPaymentRow) => {
      if (p.groupId) {
        navigate(`/agent/groups/${p.groupId}`);
      } else if (p.memberId) {
        await openMemberManagementModal(p.memberId);
      }
    },
    [navigate, openMemberManagementModal]
  );

  return (
    <div className="p-6 space-y-6">
      {/* Tab Bar */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex">
            <button
              type="button"
              onClick={() => setAgentBillingTab('payments')}
              className={`flex-1 px-6 py-3 text-center border-b-2 font-medium text-sm ${
                agentBillingTab === 'payments'
                  ? 'border-oe-primary text-gray-900 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Payments
            </button>
            <button
              type="button"
              onClick={() => setAgentBillingTab('invoices')}
              className={`flex-1 px-6 py-3 text-center border-b-2 font-medium text-sm ${
                agentBillingTab === 'invoices'
                  ? 'border-oe-primary text-gray-900 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Invoices
            </button>
          </nav>
        </div>
      </div>

      {agentBillingTab === 'invoices' && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-semibold text-gray-900">Invoices</h3>
            <select
              value={invoiceStatusFilter}
              onChange={(e) => setInvoiceStatusFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All Statuses</option>
              <option value="Unpaid">Unpaid</option>
              <option value="Partial">Partial</option>
              <option value="Paid">Paid</option>
              <option value="Overdue">Overdue</option>
            </select>
          </div>
          {agentInvoicesLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          ) : (agentInvoicesData as Invoice[]).length === 0 ? (
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
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Member / Group</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Balance</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Due Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {(agentInvoicesData as Invoice[]).map((inv) => (
                    <tr key={inv.InvoiceId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{inv.InvoiceNumber}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {inv.InvoiceType === 'Individual'
                          ? `${inv.MemberFirstName || ''} ${inv.MemberLastName || ''}`.trim() || '—'
                          : inv.GroupName || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {new Date(inv.BillingPeriodStart).toLocaleDateString()} – {new Date(inv.BillingPeriodEnd).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 text-right">${Number(inv.TotalAmount).toFixed(2)}</td>
                      <td className="px-4 py-3 text-sm text-gray-900 text-right">${Number(inv.BalanceDue).toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          inv.Status === 'Paid' ? 'bg-green-100 text-green-800' :
                          inv.Status === 'Overdue' ? 'bg-red-100 text-red-800' :
                          inv.Status === 'Partial' ? 'bg-orange-100 text-orange-800' :
                          'bg-yellow-100 text-yellow-800'
                        }`}>
                          {inv.Status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{new Date(inv.DueDate).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {agentBillingTab === 'payments' && (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        {paymentsSummary != null &&
          (paymentsSummary.unresolvedFailedDedupedAmount ?? 0) > 0 && (
            <div className="rounded-lg bg-blue-50 border border-blue-200 text-blue-900 p-4 flex flex-wrap items-start gap-3 mb-6">
              <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Unresolved failed payments</p>
                <p className="text-sm mt-1 text-blue-800">
                  Filter to open failed charges that still need attention (retries scheduled or no later successful payment in the same
                  household or group invoice).
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setStatusFilter(PAYMENT_STATUS_UNRESOLVED_FAILED);
                  setPaymentsPage(1);
                }}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm whitespace-nowrap"
              >
                Show unresolved failed
              </button>
            </div>
          )}

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Filter className="h-5 w-5 text-gray-500" />
          <div className="min-w-[200px] md:min-w-[220px]">
            <SearchableDropdown
              options={downlineAgentOptions.map((opt) => ({
                id: opt.id,
                label: opt.label,
                value: opt.value,
                email: opt.email
              }))}
              value={salesAgentFilter}
              onChange={(value) => {
                setSalesAgentFilter(value);
                setPaymentsPage(1);
              }}
              placeholder={
                salesAgentFilter === AGENT_FILTER_SCOPE_AGENCY
                  ? agentFilterPlaceholderLabels.agency
                  : salesAgentFilter === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
                    ? agentFilterPlaceholderLabels.direct
                    : salesAgentFilter === AGENT_FILTER_SHOW_ALL
                      ? agentFilterPlaceholderLabels.downline
                      : 'Me or specific agent'
              }
              searchPlaceholder="Search agents..."
              loading={isLoadingDownlineAgents}
              showEmail={true}
              useBackendSearch={false}
              className="w-full"
            />
          </div>
          <input
            type="date"
            value={transactionsStartDate}
            onChange={(e) => {
              setTransactionsStartDate(e.target.value);
              setPaymentsPage(1);
            }}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            aria-label="Start date"
          />
          <span className="text-gray-500">to</span>
          <input
            type="date"
            value={transactionsEndDate}
            onChange={(e) => {
              setTransactionsEndDate(e.target.value);
              setPaymentsPage(1);
            }}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            aria-label="End date"
          />
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPaymentsPage(1);
            }}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
          >
            {PAYMENT_STATUSES.map((s) => (
              <option key={s.value || 'all'} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {filterOptions && (
            <>
              <SearchableDropdown
                options={filterOptions.groups}
                value={groupIdFilter}
                onChange={(v) => {
                  setGroupIdFilter(v || '');
                  setPaymentsPage(1);
                }}
                placeholder="Group"
                className="min-w-[160px]"
              />
              <SearchableDropdown
                options={filterOptions.members}
                value={memberIdFilter}
                onChange={(v) => {
                  setMemberIdFilter(v || '');
                  setPaymentsPage(1);
                }}
                placeholder="Member"
                className="min-w-[160px]"
                showEmail
              />
            </>
          )}
          <button
            type="button"
            onClick={() => {
              resetTransactionsFilters();
            }}
            disabled={paymentsLoading || filterOptionsLoading}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm"
          >
            Reset
          </button>
        </div>

        <div className="mb-4">
          {paymentsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[0, 1, 2].map((k) => (
                <div key={k} className="bg-white rounded-lg border border-gray-200 p-4 animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-24 mb-2" />
                  <div className="h-8 bg-gray-200 rounded w-32" />
                </div>
              ))}
            </div>
          ) : paymentsSummary ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-600">Unresolved failed</p>
                      <p className="text-2xl font-bold text-red-700 mt-1">{formatCurrency(paymentsSummary.failedAmount)}</p>
                    </div>
                    <XCircle className="h-8 w-8 text-red-600" />
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-600">Pending</p>
                      <p className="text-2xl font-bold text-yellow-700 mt-1">{formatCurrency(paymentsSummary.pendingAmount)}</p>
                    </div>
                    <Clock className="h-8 w-8 text-yellow-600" />
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-600">Completed / other</p>
                      <p className="text-2xl font-bold text-green-700 mt-1">{formatCurrency(paymentsSummary.completedAmount)}</p>
                    </div>
                    <CheckCircle className="h-8 w-8 text-green-600" />
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {paymentsError && (
          <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 flex items-center gap-2 mb-4">
            <AlertCircle className="h-5 w-5 flex-shrink-0" />
            <span>{paymentsError}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Date</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Member / Group</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Selling agent</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Agency</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Processor fee</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Amount</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Status</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Method</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paymentsLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No payments found.
                  </td>
                </tr>
              ) : (
                payments.map((p) => {
                  const isGroup = !!p.groupId;
                  const isMember = !!p.memberId;
                  const displayName = isGroup ? (p.groupName ?? '—') : (p.memberName ?? '—');
                  const canClick = (isMember || isGroup) && (p.memberId || p.groupId);
                  return (
                    <tr key={p.paymentId} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">{formatDate(p.paymentDate)}</td>
                      <td className="px-4 py-2 text-sm text-gray-900">
                        {canClick ? (
                          <button
                            type="button"
                            onClick={() => void handleTransactionMemberOrGroupClick(p)}
                            className="inline-flex items-center gap-2 text-left text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                          >
                            {isMember ? (
                              <User className="h-4 w-4 flex-shrink-0 text-gray-500" />
                            ) : (
                              <Users className="h-4 w-4 flex-shrink-0 text-gray-500" />
                            )}
                            <span>{displayName}</span>
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            {isMember ? (
                              <User className="h-4 w-4 flex-shrink-0 text-gray-400" />
                            ) : isGroup ? (
                              <Users className="h-4 w-4 flex-shrink-0 text-gray-400" />
                            ) : null}
                            {displayName}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-900">{p.agentName ?? '—'}</td>
                      <td className="px-4 py-2 text-sm text-gray-900">{p.agencyName ?? '—'}</td>
                      <td className="px-4 py-2 text-sm text-right">
                        <button
                          type="button"
                          onClick={() => setProcessorFeeModalPayment(p)}
                          className={`inline-flex items-center justify-end w-full text-right font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded ${
                            (() => {
                              const dime = p.dimeProcessorFee ?? null;
                              const ours = p.processingFee ?? 0;
                              if (dime != null && dime > 0) {
                                if (ours < dime) return 'text-yellow-600 bg-yellow-50';
                                if (Math.abs(ours - dime) < 0.005) return 'text-blue-600 bg-blue-50';
                                return 'text-green-600 bg-green-50';
                              }
                              return 'text-gray-600';
                            })()
                          }`}
                        >
                          {(p.processingFee ?? 0) > 0 ? formatCurrency(p.processingFee ?? 0) : '—'}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-sm text-right font-medium text-gray-900">{formatCurrency(p.amount)}</td>
                      <td className="px-4 py-2">
                        {p.status === 'Failed' ? (
                          <FailedPaymentReasonBadge
                            reasonText={buildFailedPaymentStatusTitle(
                              p.failureReason,
                              p.consecutiveFailureCount,
                              p.attemptNumber
                            )}
                            className="inline-flex px-2 py-1 text-xs font-semibold rounded-full cursor-pointer bg-red-100 text-red-800 border-0"
                          >
                            {formatBillingPaymentStatusLabel(p)}
                          </FailedPaymentReasonBadge>
                        ) : (
                          <span
                            className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                              p.status === 'Completed'
                                ? 'bg-green-100 text-green-800'
                                : p.status === 'Refunded'
                                  ? 'bg-gray-100 text-gray-700'
                                  : p.status === 'Pending'
                                    ? 'bg-yellow-100 text-yellow-800'
                                    : 'bg-gray-100 text-gray-800'
                            }`}
                          >
                            {formatBillingPaymentStatusLabel(p)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-600">
                        <span
                          className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${paymentMethodBadgeClasses(
                            getPaymentMethodType(p.paymentMethod).type
                          )}`}
                        >
                          {getPaymentMethodType(p.paymentMethod).label}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex items-center gap-2 justify-end">
                          {p.status === 'Failed' && (
                            <button
                              type="button"
                              onClick={() => {
                                setRetryModalPayment(p);
                                setRetryResult(null);
                                setRetryResultMessage('');
                                setRetryOptions(null);
                                setRetrySelectedPaymentMethodId(null);
                                setRetryOptionsLoading(true);
                                accountingService
                                  .getRetryOptions(p.paymentId)
                                  .then((opts) => {
                                    setRetryOptions(opts);
                                    const defaultPm = opts.paymentMethods?.find((pm) => pm.isDefault) ?? opts.paymentMethods?.[0];
                                    setRetrySelectedPaymentMethodId(defaultPm?.paymentMethodId ?? null);
                                  })
                                  .catch(() => setRetryOptions({ success: true, context: 'group', paymentMethods: [] }))
                                  .finally(() => setRetryOptionsLoading(false));
                              }}
                              className="inline-flex items-center px-3 py-1.5 border border-amber-300 text-sm font-medium rounded-md text-amber-700 bg-white hover:bg-amber-50"
                            >
                              <RefreshCw className="h-4 w-4 mr-1.5" />
                              Retry
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setPaymentDetailModal(p)}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                          >
                            <Eye className="h-4 w-4 mr-1.5" />
                            Details
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {paymentsTotal > 0 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-gray-600">
              Showing {(paymentsPage - 1) * paymentsLimit + 1}–{Math.min(paymentsPage * paymentsLimit, paymentsTotal)} of{' '}
              {paymentsTotal}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPaymentsPage((pg) => Math.max(1, pg - 1))}
                disabled={paymentsPage <= 1 || paymentsLoading}
                className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <span className="text-sm text-gray-700">
                Page {paymentsPage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPaymentsPage((pg) => Math.min(totalPages, pg + 1))}
                disabled={paymentsPage >= totalPages || paymentsLoading}
                className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {paymentDetailModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setPaymentDetailModal(null)} />
            <div className="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Payment details</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {formatDate(paymentDetailModal.paymentDate)} · {formatCurrency(paymentDetailModal.amount)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPaymentDetailModal(null)}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
              <div className="mt-4 space-y-0 divide-y divide-gray-100">
                <div className="flex flex-col gap-1 py-2">
                  <span className="text-xs font-medium text-gray-500 uppercase">Payment ID</span>
                  <span className="text-sm font-mono text-gray-900 break-all">{paymentDetailModal.paymentId}</span>
                </div>
                <div className="flex flex-col gap-1 py-2">
                  <span className="text-xs font-medium text-gray-500 uppercase">Processor transaction ID</span>
                  <span className="text-sm font-mono text-gray-900 break-all">{paymentDetailModal.processorTransactionId ?? '—'}</span>
                </div>
                <div className="flex flex-col gap-1 py-2">
                  <span className="text-xs font-medium text-gray-500 uppercase">Failure reason</span>
                  {paymentDetailModal.failureReason ? (
                    <>
                      <span className="text-sm text-red-700 whitespace-pre-wrap break-words leading-relaxed">
                        {paymentDetailModal.failureReason}
                      </span>
                      {getStoredDimePaymentFailureUiHint(paymentDetailModal.failureReason) && (
                        <p className="text-xs text-amber-900 mt-2 border-l-2 border-amber-300 pl-2">
                          {getStoredDimePaymentFailureUiHint(paymentDetailModal.failureReason)}
                        </p>
                      )}
                    </>
                  ) : (
                    <span className="text-sm text-gray-500">—</span>
                  )}
                </div>
                {paymentDetailModal.status === 'Failed' &&
                  (paymentDetailModal.attemptNumber != null || paymentDetailModal.consecutiveFailureCount != null) && (
                    <div className="flex flex-col gap-1 py-2">
                      <span className="text-xs font-medium text-gray-500 uppercase">Retry / streak</span>
                      <span className="text-sm text-gray-900">
                        {paymentDetailModal.attemptNumber != null ? `Billing attempt ${paymentDetailModal.attemptNumber}` : '—'}
                        {paymentDetailModal.consecutiveFailureCount != null &&
                        paymentDetailModal.consecutiveFailureCount > 0
                          ? ` · ${paymentDetailModal.consecutiveFailureCount} consecutive failure(s)`
                          : ''}
                      </span>
                    </div>
                  )}
                {(paymentDetailModal.achReturnCode || paymentDetailModal.achReturnReason) && (
                  <>
                    <div className="flex flex-col gap-1 py-2">
                      <span className="text-xs font-medium text-gray-500 uppercase">ACH return code</span>
                      <span className="text-sm text-red-700">{paymentDetailModal.achReturnCode ?? '—'}</span>
                    </div>
                    <div className="flex flex-col gap-1 py-2">
                      <span className="text-xs font-medium text-gray-500 uppercase">ACH return reason</span>
                      <span className="text-sm text-red-700 whitespace-pre-wrap break-words">
                        {paymentDetailModal.achReturnReason ?? '—'}
                      </span>
                    </div>
                  </>
                )}
                {paymentDetailModal.chargebackReason && (
                  <div className="flex flex-col gap-1 py-2">
                    <span className="text-xs font-medium text-gray-500 uppercase">Chargeback reason</span>
                    <span className="text-sm text-red-700 whitespace-pre-wrap break-words">
                      {paymentDetailModal.chargebackReason}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {processorFeeModalPayment && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setProcessorFeeModalPayment(null)} />
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
              <h3 className="text-lg font-semibold text-gray-900">Processor fee</h3>
              <p className="mt-1 text-sm text-gray-500">
                {formatDate(processorFeeModalPayment.paymentDate)} · {formatCurrency(processorFeeModalPayment.amount)}
                {(processorFeeModalPayment.memberName || processorFeeModalPayment.groupName) && (
                  <> · {processorFeeModalPayment.groupName || processorFeeModalPayment.memberName}</>
                )}
              </p>
              <div className="mt-4 space-y-3">
                {processorFeeDetailLoading ? (
                  <p className="text-sm text-gray-500">Loading...</p>
                ) : processorFeeDetail ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">
                        From processor{processorFeeDetail.processorName ? ` (${processorFeeDetail.processorName})` : ''}:
                      </span>
                      <span className="font-medium text-gray-900">
                        {processorFeeDetail.processorFeeComingSoon
                          ? 'Coming soon'
                          : processorFeeDetail.processorFee != null
                            ? formatCurrency(processorFeeDetail.processorFee)
                            : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">From our system (oe.Enrollments):</span>
                      <span className="font-medium text-gray-900">{formatCurrency(processorFeeDetail.ourProcessingFee)}</span>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-gray-500">Could not load fee details.</p>
                )}
              </div>
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => setProcessorFeeModalPayment(null)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {retryModalPayment && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
            <div
              className="fixed inset-0 bg-gray-500 bg-opacity-75"
              onClick={() => !retrying && retryResult === null && setRetryModalPayment(null)}
            />
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
              <h3 className="text-lg font-semibold text-gray-900">
                {retryResult === null ? 'Retry failed payment' : retryResult === 'success' ? 'Retry successful' : 'Retry failed'}
              </h3>
              {retryResult === null ? (
                <>
                  <p className="mt-2 text-sm text-gray-600">
                    Retry this failed payment of {formatCurrency(retryModalPayment.amount)}
                    {(retryModalPayment.memberName || retryModalPayment.groupName) && (
                      <> for {retryModalPayment.groupName || retryModalPayment.memberName}</>
                    )}
                    ?
                  </p>
                  {retryOptionsLoading ? (
                    <p className="mt-2 text-sm text-gray-500">Loading payment methods…</p>
                  ) : retryOptions?.paymentMethods?.length ? (
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Charge with</label>
                      <select
                        value={retrySelectedPaymentMethodId ?? ''}
                        onChange={(e) => setRetrySelectedPaymentMethodId(e.target.value || null)}
                        className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                      >
                        {retryOptions.paymentMethods.map((pm) => (
                          <option key={pm.paymentMethodId} value={pm.paymentMethodId}>
                            {pm.label}
                            {pm.isDefault ? ' (default)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : retryOptions && !retryOptionsLoading ? (
                    <p className="mt-2 text-sm text-amber-600">No payment methods on file.</p>
                  ) : null}
                </>
              ) : (
                <div
                  className={`mt-3 p-3 rounded-lg text-sm ${
                    retryResult === 'success' ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'
                  }`}
                >
                  {retryResultMessage}
                </div>
              )}
              <div className="mt-6 flex justify-end gap-2">
                {retryResult === null ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setRetryModalPayment(null)}
                      className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                      disabled={retrying}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!retryModalPayment) return;
                        setRetrying(true);
                        setRetryResult(null);
                        try {
                          const body =
                            retryOptions?.context === 'group' && retrySelectedPaymentMethodId
                              ? { groupPaymentMethodId: retrySelectedPaymentMethodId }
                              : retryOptions?.context === 'household' && retrySelectedPaymentMethodId
                                ? { memberPaymentMethodId: retrySelectedPaymentMethodId }
                                : undefined;
                          const result = await accountingService.retryPayment(retryModalPayment.paymentId, body);
                          if (result.success) {
                            setRetryResult('success');
                            setRetryResultMessage(result.message || 'Payment retry successful. The payment has been charged.');
                          } else {
                            setRetryResult('error');
                            setRetryResultMessage(result.message || 'Retry failed.');
                          }
                        } catch (e) {
                          setRetryResult('error');
                          const msg: string =
                            (e && typeof e === 'object' && 'message' in e && typeof (e as { message?: string }).message === 'string'
                              ? (e as { message: string }).message
                              : null) || (e instanceof Error ? e.message : 'Failed to retry payment.');
                          setRetryResultMessage(msg || 'Failed to retry payment.');
                        } finally {
                          setRetrying(false);
                        }
                      }}
                      className="px-4 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                      disabled={retrying}
                    >
                      {retrying ? 'Retrying…' : 'Retry payment'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setRetryModalPayment(null);
                      setRetryResult(null);
                      setRetryResultMessage('');
                      if (retryResult === 'success') loadPayments();
                    }}
                    className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedMemberForModal && (
        <MemberManagementModal
          key={selectedMemberForModal.MemberId}
          member={selectedMemberForModal}
          householdMembers={memberModalHousehold}
          memberEnrollments={memberModalEnrollments}
          enrollmentsLoading={memberModalEnrollmentsLoading}
          onClose={() => {
            setSelectedMemberForModal(null);
            setMemberModalHousehold([]);
            setMemberModalEnrollments([]);
          }}
          onEdit={() => {}}
          formatCurrency={formatCurrency}
          getStatusColor={getStatusColor}
          getRelationshipIcon={getRelationshipIcon}
          getRelationshipColor={getRelationshipColor}
          canEdit={false}
          canDelete={false}
        />
      )}
    </div>
  );
};

export default AgentBilling;
