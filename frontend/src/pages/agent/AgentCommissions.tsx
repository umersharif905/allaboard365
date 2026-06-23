// frontend/src/pages/agent/AgentCommissions.tsx
import { Banknote, Calculator, CalendarDays, ChevronLeft, ChevronRight, Clock, FileText, Info, Loader2, TrendingUp, Users, User, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import PaymentCommissionBreakdownModal from '../../components/accounting/PaymentCommissionBreakdownModal';
import CommissionSimulator from '../../components/commissions/CommissionSimulator';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import {
  AGENT_FILTER_SCOPE_AGENCY,
  AGENT_FILTER_SCOPE_DIRECT_DOWNLINE,
  AGENT_FILTER_SHOW_ALL,
  getInitialAgentFilterIdFromStorage,
  isAgentFilterScopeSentinel
} from '../../constants/agentFilterScope';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import { useAuth } from '../../hooks';
import { AgentService } from '../../services/agent/agent.service';
import { apiService } from '../../services/api.service';
import { Member } from '../../types/member.types';
import MemberManagementModal from '../members/MemberManagementModal';

type Perspective = 'self' | 'downline';

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

interface CommissionPaymentRow {
  paymentId: string;
  paymentDate: string;
  amount: number;
  status: string;
  paymentMethod?: string | null;
  sellingAgentId?: string | null;
  sellingAgentName?: string | null;
  isUplinePayment?: boolean;
  groupId?: string | null;
  groupName?: string | null;
  memberId?: string | null;
  memberName?: string | null;
  commissionOwnerAgentId?: string | null;
  commissionOwnerName?: string | null;
  commissionAmount: number;
  debitAmount?: number;
  payoutLineAmount?: number;
  payoutDate?: string | null;
}

interface AwaitingCommissionRow {
  paymentId: string;
  paymentDate: string;
  amount: number;
  status: string;
  sellingAgentId?: string | null;
  sellingAgentName?: string | null;
  commissionOwnerAgentId?: string | null;
  commissionOwnerName?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  memberId?: string | null;
  memberName?: string | null;
}

interface PayoutRow {
  nachaId: string;
  generatedDate: string;
  totalPaidToAgent: number;
  paymentCount: number;
  commissionOwnerAgentId?: string | null;
  commissionOwnerName?: string | null;
}

const PAGE_SIZE = 25;

type ListPagination = { total: number; page: number; limit: number; totalPages: number };

function unwrapAgentMembersList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object' && 'members' in data && Array.isArray((data as { members: unknown }).members)) {
    return (data as { members: Array<Record<string, unknown>> }).members;
  }
  return [];
}

function memberRowLabel(m: { MemberName?: string; FirstName?: string; LastName?: string; MemberId?: string }): string {
  if (m.MemberName) return String(m.MemberName);
  const n = `${m.FirstName || ''} ${m.LastName || ''}`.trim();
  return n || String(m.MemberId || '');
}

const AgentCommissions: React.FC = () => {
  const { user } = useAuth();
  // Tab order is deliberate — payouts land first because that's the "money already
  // hit my bank" answer an agent usually wants; payments and awaiting are the drill-ins.
  const tabs = ['Payouts', 'Payments', 'Awaiting'] as const;
  const [activeTab, setActiveTab] = useState(0);
  const navigate = useNavigate();

  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summary, setSummary] = useState<{ totalPaid?: number; totalPending?: number; totalEarned?: number } | null>(null);

  const [payments, setPayments] = useState<CommissionPaymentRow[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);

  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [payoutsError, setPayoutsError] = useState<string | null>(null);

  const [awaitingRows, setAwaitingRows] = useState<AwaitingCommissionRow[]>([]);
  const [awaitingLoading, setAwaitingLoading] = useState(false);
  const [awaitingError, setAwaitingError] = useState<string | null>(null);
  const [awaitingPage, setAwaitingPage] = useState(1);
  const [awaitingPagination, setAwaitingPagination] = useState<ListPagination | null>(null);

  const [dateRangeStart, setDateRangeStart] = useState('');
  const [dateRangeEnd, setDateRangeEnd] = useState('');
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [payoutsPage, setPayoutsPage] = useState(1);
  const [paymentsPagination, setPaymentsPagination] = useState<ListPagination | null>(null);
  const [payoutsPagination, setPayoutsPagination] = useState<ListPagination | null>(null);

  // Same default + AgencyOwner / oe.AgencyAdmins migration as MembersPage / GroupsPage
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

  // "Viewing perspective" — self (default) shows viewer's own commissions; downline
  // re-reads oe.Commissions for the selected downline/direct/agency scope. Independent
  // from salesAgentFilter so switching modes doesn't clobber the other view's choice.
  const [perspective, setPerspective] = useState<Perspective>('self');
  const [commissionOwnerFilter, setCommissionOwnerFilter] = useState(
    () => getInitialAgentFilterIdFromStorage() || AGENT_FILTER_SHOW_ALL
  );

  useEffect(() => {
    if (user?.currentRole !== 'Agent') return;
    if (!agencyWideFilterAvailable) return;
    setCommissionOwnerFilter((prev) => (prev === AGENT_FILTER_SHOW_ALL ? AGENT_FILTER_SCOPE_AGENCY : prev));
  }, [user?.currentRole, agencyWideFilterAvailable]);

  // Perspective toggle is only meaningful for uplines/agency admins — hide it for
  // plain agents with no downline so the page stays unchanged for them.
  const hasAnyDownline = useMemo(() => {
    return (
      agencyWideFilterAvailable ||
      downlineAgentOptions.some(
        (opt) =>
          !isAgentFilterScopeSentinel(opt.value) &&
          !!opt.value
      )
    );
  }, [agencyWideFilterAvailable, downlineAgentOptions]);

  // Are we aggregating multiple owners? (Determines whether the "Commission owner"
  // column adds signal or just repeats the same name.)
  const isAggregateOwnerScope = useMemo(() => {
    return (
      perspective === 'downline' &&
      (commissionOwnerFilter === AGENT_FILTER_SHOW_ALL ||
        commissionOwnerFilter === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE ||
        commissionOwnerFilter === AGENT_FILTER_SCOPE_AGENCY)
    );
  }, [perspective, commissionOwnerFilter]);

  // Only pass perspective/commissionOwnerFilter downstream when actually viewing
  // downline — 'self' is the original, untouched code path.
  const perspectiveParam = perspective === 'downline' ? 'downline' : undefined;
  const commissionOwnerFilterParam =
    perspective === 'downline' ? commissionOwnerFilter || undefined : undefined;

  const agentFilterPlaceholderLabels = useMemo(() => {
    const agency = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SCOPE_AGENCY)?.label ?? 'All Agency Agents';
    const direct = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE)?.label ?? 'Direct downlines';
    const downline = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SHOW_ALL)?.label ?? 'Show all';
    return { agency, direct, downline };
  }, [downlineAgentOptions]);

  const [paymentsFilters, setPaymentsFilters] = useState({
    groupId: '',
    memberId: ''
  });

  const [groupOptions, setGroupOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [memberOptions, setMemberOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [groupSearchLoading, setGroupSearchLoading] = useState(false);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);

  const groupDropdownAgentId = useMemo(() => {
    return salesAgentFilter &&
      salesAgentFilter !== AGENT_FILTER_SHOW_ALL &&
      salesAgentFilter !== AGENT_FILTER_SCOPE_AGENCY &&
      salesAgentFilter !== AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
      ? salesAgentFilter
      : undefined;
  }, [salesAgentFilter]);

  const groupDropdownScope = useMemo((): 'downline' | 'agency' | 'direct' | undefined => {
    if (groupDropdownAgentId) return undefined;
    if (salesAgentFilter === AGENT_FILTER_SCOPE_AGENCY) return 'agency';
    if (salesAgentFilter === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE) return 'direct';
    return 'downline';
  }, [salesAgentFilter, groupDropdownAgentId]);

  const searchGroups = useCallback(
    async (query: string) => {
      const q = (query || '').trim();
      if (q.length === 1) return;

      try {
        setGroupSearchLoading(true);
        const res = await AgentService.getMyAgentGroups(
          false,
          groupDropdownAgentId,
          undefined,
          undefined,
          groupDropdownScope,
          q.length >= 2 ? q : undefined,
          50
        );
        if (res?.success && Array.isArray(res.data)) {
          setGroupOptions(
            (res.data as Array<{ GroupId: string; Name: string }>).map((g) => ({
              id: g.GroupId,
              label: g.Name || 'Unnamed group',
              value: g.GroupId
            }))
          );
        } else {
          setGroupOptions([]);
        }
      } catch {
        setGroupOptions([]);
      } finally {
        setGroupSearchLoading(false);
      }
    },
    [groupDropdownAgentId, groupDropdownScope]
  );

  const searchMembers = useCallback(
    async (query: string) => {
      const q = (query || '').trim();
      if (q.length === 1) return;

      try {
        setMemberSearchLoading(true);
        const res = await AgentService.getMyMembers({
          groupId: paymentsFilters.groupId || undefined,
          search: q.length >= 2 ? q : undefined,
          limit: '50'
        });
        const list = unwrapAgentMembersList(res?.data);
        if (res?.success) {
          setMemberOptions(
            list.map((m) => ({
              id: String(m.MemberId),
              label: memberRowLabel(m as { MemberName?: string; FirstName?: string; LastName?: string; MemberId?: string }),
              value: String(m.MemberId)
            }))
          );
        } else {
          setMemberOptions([]);
        }
      } catch {
        setMemberOptions([]);
      } finally {
        setMemberSearchLoading(false);
      }
    },
    [paymentsFilters.groupId]
  );

  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownPaymentId, setBreakdownPaymentId] = useState<string | null>(null);
  const [breakdownRow, setBreakdownRow] = useState<CommissionPaymentRow | null>(null);

  const [payoutDetailNachaId, setPayoutDetailNachaId] = useState<string | null>(null);
  const [payoutDetailPayout, setPayoutDetailPayout] = useState<PayoutRow | null>(null);
  const [payoutDetailRows, setPayoutDetailRows] = useState<CommissionPaymentRow[]>([]);
  const [payoutDetailLoading, setPayoutDetailLoading] = useState(false);

  const [showCalculator, setShowCalculator] = useState(false);

  const [memberModalMember, setMemberModalMember] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<Enrollment[]>([]);
  const [memberModalLoading, setMemberModalLoading] = useState(false);

  useEffect(() => {
    const loadSummary = async () => {
      setSummaryLoading(true);
      try {
        const res = await AgentService.getCommissionSummary({
          perspective: perspectiveParam,
          commissionOwnerFilter: commissionOwnerFilterParam
        });
        if (res?.success && res.data) {
          setSummary(res.data as { totalPaid?: number; totalPending?: number; totalEarned?: number });
        } else {
          setSummary(null);
        }
      } catch {
        setSummary(null);
      } finally {
        setSummaryLoading(false);
      }
    };
    loadSummary();
  }, [perspectiveParam, commissionOwnerFilterParam]);

  useEffect(() => {
    const gid = paymentsFilters.groupId;
    if (!gid) return;
    void (async () => {
      try {
        const res = await AgentService.getMyAgentGroups(
          false,
          groupDropdownAgentId,
          undefined,
          undefined,
          groupDropdownScope,
          undefined,
          500
        );
        const list = (res?.success && Array.isArray(res.data) ? res.data : []) as Array<{ GroupId: string; Name: string }>;
        const found = list.find((g) => g.GroupId === gid);
        if (found) {
          setGroupOptions((prev) => (prev.some((o) => o.value === gid) ? prev : [...prev, { id: gid, label: found.Name || 'Group', value: gid }]));
        }
      } catch {
        /* ignore */
      }
    })();
  }, [paymentsFilters.groupId, groupDropdownAgentId, groupDropdownScope]);

  useEffect(() => {
    const mid = paymentsFilters.memberId;
    if (!mid) return;
    void (async () => {
      try {
        const res = await apiService.get<{ success: boolean; data?: { FirstName?: string; LastName?: string } }>(
          `/api/members/${mid}/profile`
        );
        if (res.success && res.data) {
          const d = res.data;
          const label = `${d.FirstName || ''} ${d.LastName || ''}`.trim() || mid;
          setMemberOptions((prev) => (prev.some((o) => o.value === mid) ? prev : [...prev, { id: mid, label, value: mid }]));
        }
      } catch {
        /* ignore */
      }
    })();
  }, [paymentsFilters.memberId]);

  const fetchPayments = useCallback(async () => {
    setPaymentsLoading(true);
    setPaymentsError(null);
    try {
      const res = await AgentService.getMyPayments({
        groupId: paymentsFilters.groupId || undefined,
        memberId: paymentsFilters.memberId || undefined,
        salesAgentFilter: salesAgentFilter || undefined,
        perspective: perspectiveParam,
        commissionOwnerFilter: commissionOwnerFilterParam,
        startDate: dateRangeStart || undefined,
        endDate: dateRangeEnd || undefined,
        page: paymentsPage,
        limit: PAGE_SIZE
      });
      if (res?.success) {
        setPayments(Array.isArray(res.data) ? (res.data as CommissionPaymentRow[]) : []);
        setPaymentsPagination(res.pagination ?? null);
      } else {
        setPayments([]);
        setPaymentsPagination(null);
      }
    } catch (e: unknown) {
      setPaymentsError(e instanceof Error ? e.message : 'Failed to load payments');
      setPayments([]);
      setPaymentsPagination(null);
    } finally {
      setPaymentsLoading(false);
    }
  }, [
    paymentsFilters.groupId,
    paymentsFilters.memberId,
    salesAgentFilter,
    perspectiveParam,
    commissionOwnerFilterParam,
    dateRangeStart,
    dateRangeEnd,
    paymentsPage
  ]);

  const fetchPayouts = useCallback(async () => {
    setPayoutsLoading(true);
    setPayoutsError(null);
    try {
      const res = await AgentService.getMyPayouts({
        salesAgentFilter: salesAgentFilter || undefined,
        perspective: perspectiveParam,
        commissionOwnerFilter: commissionOwnerFilterParam,
        startDate: dateRangeStart || undefined,
        endDate: dateRangeEnd || undefined,
        page: payoutsPage,
        limit: PAGE_SIZE
      });
      if (res?.success) {
        setPayouts(Array.isArray(res.data) ? (res.data as PayoutRow[]) : []);
        setPayoutsPagination(res.pagination ?? null);
      } else {
        setPayouts([]);
        setPayoutsPagination(null);
      }
    } catch (e: unknown) {
      setPayoutsError(e instanceof Error ? e.message : 'Failed to load payouts');
      setPayouts([]);
      setPayoutsPagination(null);
    } finally {
      setPayoutsLoading(false);
    }
  }, [salesAgentFilter, perspectiveParam, commissionOwnerFilterParam, dateRangeStart, dateRangeEnd, payoutsPage]);

  const fetchAwaiting = useCallback(async () => {
    setAwaitingLoading(true);
    setAwaitingError(null);
    try {
      const res = await AgentService.getMyPaymentsAwaitingCommissions({
        perspective: perspectiveParam,
        commissionOwnerFilter: commissionOwnerFilterParam,
        page: awaitingPage,
        limit: PAGE_SIZE
      });
      if (res?.success) {
        setAwaitingRows(Array.isArray(res.data) ? (res.data as AwaitingCommissionRow[]) : []);
        setAwaitingPagination(res.pagination ?? null);
      } else {
        setAwaitingRows([]);
        setAwaitingPagination(null);
      }
    } catch (e: unknown) {
      setAwaitingError(e instanceof Error ? e.message : 'Failed to load');
      setAwaitingRows([]);
      setAwaitingPagination(null);
    } finally {
      setAwaitingLoading(false);
    }
  }, [perspectiveParam, commissionOwnerFilterParam, awaitingPage]);

  useEffect(() => {
    if (activeTab === 0) {
      void fetchPayouts();
    } else if (activeTab === 1) {
      void fetchPayments();
    } else if (activeTab === 2) {
      void fetchAwaiting();
    }
  }, [activeTab, fetchPayments, fetchPayouts, fetchAwaiting]);

  const openPayoutDetail = async (nachaId: string, ownerAgentId?: string | null) => {
    setPayoutDetailNachaId(nachaId);
    setPayoutDetailPayout(
      payouts.find(
        (p) =>
          p.nachaId === nachaId &&
          (!ownerAgentId || p.commissionOwnerAgentId === ownerAgentId)
      ) || null
    );
    setPayoutDetailLoading(true);
    setPayoutDetailRows([]);
    try {
      const res = await AgentService.getMyPayoutIncludedPayments(nachaId, {
        groupId: paymentsFilters.groupId || undefined,
        memberId: paymentsFilters.memberId || undefined,
        salesAgentFilter: salesAgentFilter || undefined,
        perspective: perspectiveParam,
        commissionOwnerFilter: commissionOwnerFilterParam,
        commissionOwnerAgentId: ownerAgentId || undefined,
        startDate: dateRangeStart || undefined,
        endDate: dateRangeEnd || undefined
      });
      if (res?.success && Array.isArray(res.data)) {
        setPayoutDetailRows(res.data as CommissionPaymentRow[]);
      }
    } catch {
      toast.error('Failed to load payout payments');
    } finally {
      setPayoutDetailLoading(false);
    }
  };

  const openBreakdown = (row: CommissionPaymentRow) => {
    setBreakdownRow(row);
    setBreakdownPaymentId(row.paymentId);
    setBreakdownOpen(true);
  };

  const openMemberManagementModal = useCallback(async (memberId: string) => {
    if (!memberId) return;
    setMemberModalLoading(true);
    setMemberModalMember(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
    try {
      const householdRes = await apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(
        `/api/members/${memberId}/with-household`
      );
      if (householdRes.success && householdRes.data) {
        setMemberModalMember(householdRes.data.member);
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
      setMemberModalLoading(false);
    }
  }, []);

  const handleClientClick = (row: CommissionPaymentRow) => {
    if (row.groupId) {
      navigate(`/agent/groups/${row.groupId}`);
    } else if (row.memberId) {
      void openMemberManagementModal(row.memberId);
    }
  };

  const displayClientName = (row: CommissionPaymentRow) => {
    if (row.groupName) return row.groupName;
    if (row.memberName) return row.memberName;
    return '—';
  };

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const formatPaymentStatusLabel = (status: string) => {
    const s = String(status).toLowerCase();
    if (s === 'completed') return 'Paid Out';
    return status;
  };

  const getStatusColor = (status: string) => {
    switch (String(status).toLowerCase()) {
      case 'paid':
      case 'completed':
      case 'succeeded':
        return 'text-green-600 bg-green-100';
      case 'pending':
      case 'processing':
        return 'text-yellow-600 bg-yellow-100';
      case 'hold':
        return 'text-yellow-800 bg-yellow-100';
      case 'reversed':
      case 'failed':
        return 'text-red-600 bg-red-100';
      default:
        return 'text-gray-600 bg-gray-100';
    }
  };

  const filterToolbar = (
    <div className="flex flex-col md:flex-row gap-2 md:items-end flex-wrap mb-6">
      <div className="min-w-[160px]">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {activeTab === 1 ? 'Payment date from' : 'Payout date from'}
        </label>
        <input
          type="date"
          value={dateRangeStart}
          onChange={(e) => {
            setDateRangeStart(e.target.value);
            setPaymentsPage(1);
            setPayoutsPage(1);
          }}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
        />
      </div>
      <div className="min-w-[160px]">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {activeTab === 1 ? 'Payment date to' : 'Payout date to'}
        </label>
        <input
          type="date"
          value={dateRangeEnd}
          onChange={(e) => {
            setDateRangeEnd(e.target.value);
            setPaymentsPage(1);
            setPayoutsPage(1);
          }}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
        />
      </div>
      {perspective === 'downline' && (
        <div className="min-w-[200px] md:min-w-[220px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Commission for</label>
          <SearchableDropdown
            options={downlineAgentOptions.map((opt) => ({
              id: opt.id,
              label: opt.label,
              value: opt.value,
              email: opt.email
            }))}
            value={commissionOwnerFilter}
            onChange={(value) => {
              setCommissionOwnerFilter(value);
              setPaymentsPage(1);
              setPayoutsPage(1);
              setAwaitingPage(1);
            }}
            placeholder={
              commissionOwnerFilter === AGENT_FILTER_SCOPE_AGENCY
                ? agentFilterPlaceholderLabels.agency
                : commissionOwnerFilter === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
                  ? agentFilterPlaceholderLabels.direct
                  : commissionOwnerFilter === AGENT_FILTER_SHOW_ALL
                    ? agentFilterPlaceholderLabels.downline
                    : 'Specific downline agent'
            }
            searchPlaceholder="Search agents..."
            loading={isLoadingDownlineAgents}
            showEmail={true}
            useBackendSearch={false}
            className="w-full"
          />
        </div>
      )}
      <div className="min-w-[200px] md:min-w-[220px]">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {perspective === 'downline' ? 'Sold by' : 'Filter by Agent'}
        </label>
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
            setPayoutsPage(1);
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
      <div className="min-w-[200px]">
        <label className="block text-sm font-medium text-gray-700 mb-1">Group</label>
        <SearchableDropdown
          options={groupOptions}
          value={paymentsFilters.groupId || ''}
          onChange={(value) => {
            setPaymentsFilters((prev) => ({ ...prev, groupId: value, memberId: '' }));
            setPaymentsPage(1);
          }}
          placeholder="All groups"
          searchPlaceholder="Type to search groups..."
          loading={groupSearchLoading}
          onSearch={searchGroups}
          useBackendSearch={true}
          className="w-full"
        />
      </div>
      <div className="min-w-[200px]">
        <label className="block text-sm font-medium text-gray-700 mb-1">Member</label>
        <SearchableDropdown
          options={memberOptions}
          value={paymentsFilters.memberId || ''}
          onChange={(value) => {
            setPaymentsFilters((prev) => ({ ...prev, memberId: value }));
            setPaymentsPage(1);
          }}
          placeholder="All members"
          searchPlaceholder="Type to search members..."
          loading={memberSearchLoading}
          onSearch={searchMembers}
          useBackendSearch={true}
          className="w-full"
        />
      </div>
    </div>
  );

  const summaryLabelSuffix = perspective === 'downline' ? ' (downline)' : '';

  return (
    <div className="p-6 max-w-full">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        {hasAnyDownline ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700 mr-1">Viewing:</span>
            <div
              role="tablist"
              aria-label="Commission viewing perspective"
              className="inline-flex rounded-lg border border-gray-200 bg-white p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={perspective === 'self'}
                onClick={() => {
                  setPerspective('self');
                  setPaymentsPage(1);
                  setPayoutsPage(1);
                  setAwaitingPage(1);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  perspective === 'self'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <User className="h-4 w-4" />
                My commissions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={perspective === 'downline'}
                onClick={() => {
                  setPerspective('downline');
                  setPaymentsPage(1);
                  setPayoutsPage(1);
                  setAwaitingPage(1);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  perspective === 'downline'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <Users className="h-4 w-4" />
                Downline commissions
              </button>
            </div>
          </div>
        ) : (
          <div />
        )}
        <button
          type="button"
          onClick={() => setShowCalculator(true)}
          className="inline-flex items-center gap-1.5 bg-oe-primary hover:bg-oe-dark text-white px-4 py-2 rounded-lg text-sm font-medium"
        >
          <Calculator className="h-4 w-4" />
          Commission Calculator
        </button>
      </div>

      {!summaryLoading && summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-sm text-gray-600">Total earned{summaryLabelSuffix}</p>
            <p className="text-lg font-semibold text-gray-900">{formatCurrency(Number(summary.totalEarned ?? 0))}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-sm text-gray-600">Paid{summaryLabelSuffix}</p>
            <p className="text-lg font-semibold text-gray-900">{formatCurrency(Number(summary.totalPaid ?? 0))}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-sm text-gray-600">Pending{summaryLabelSuffix}</p>
            <p className="text-lg font-semibold text-gray-900">{formatCurrency(Number(summary.totalPending ?? 0))}</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 mb-6">
        <div className="border-b border-gray-200">
          <nav className="flex">
            {tabs.map((tab, index) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(index)}
                className={`flex-1 px-6 py-4 text-center text-sm font-medium border-b-2 transition-colors ${
                  activeTab === index
                    ? 'border-blue-600 text-gray-900 bg-blue-50/50'
                    : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                }`}
              >
                {tab}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 1 && (
            <div>
              {filterToolbar}
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment date</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Group / member</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Payment</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {perspective === 'downline' ? 'Commission' : 'Your commission'}
                      </th>
                      <th
                        className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                        title="Refund / chargeback debits offsetting this payment's commission"
                      >
                        Debits
                      </th>
                      {isAggregateOwnerScope && (
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Commission owner</th>
                      )}
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Selling agent</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payout date</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Details</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {paymentsError ? (
                      <tr>
                        <td colSpan={isAggregateOwnerScope ? 10 : 9} className="px-4 py-8 text-center text-red-600">
                          {paymentsError}
                        </td>
                      </tr>
                    ) : paymentsLoading ? (
                      <tr>
                        <td colSpan={isAggregateOwnerScope ? 10 : 9} className="px-4 py-8 text-center text-gray-500">
                          <Loader2 className="h-6 w-6 animate-spin inline text-gray-400" />
                        </td>
                      </tr>
                    ) : payments.length === 0 ? (
                      <tr>
                        <td colSpan={isAggregateOwnerScope ? 10 : 9} className="px-4 py-8 text-center text-gray-500">
                          No payments found
                        </td>
                      </tr>
                    ) : (
                      payments.map((row) => (
                        <tr key={`${row.paymentId}:${row.commissionOwnerAgentId || 'self'}`} className="hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{formatDate(row.paymentDate)}</td>
                          <td className="px-4 py-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleClientClick(row)}
                                className="font-medium text-blue-600 hover:text-blue-800 hover:underline text-left"
                              >
                                {displayClientName(row)}
                              </button>
                              {row.isUplinePayment && perspective === 'self' && (
                                <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                                  Upline payment
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">{formatCurrency(row.amount)}</td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-medium text-gray-900">
                            {formatCurrency(row.commissionAmount)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right">
                            {row.debitAmount && Math.abs(row.debitAmount) > 0.005 ? (
                              <span className="text-red-700 font-medium" title="Refund / chargeback offset">
                                {formatCurrency(row.debitAmount)}
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          {isAggregateOwnerScope && (
                            <td className="px-4 py-3 text-sm text-gray-700">{row.commissionOwnerName || '—'}</td>
                          )}
                          <td className="px-4 py-3 text-sm text-gray-700">{row.sellingAgentName || '—'}</td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm">
                            {row.payoutDate ? (
                              <span className="text-green-700">{formatDate(row.payoutDate)}</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-yellow-600">
                                <Clock className="h-3.5 w-3.5" />
                                Pending
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(row.status)}`}>
                              {formatPaymentStatusLabel(row.status)}
                            </span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right">
                            <button
                              type="button"
                              onClick={() => openBreakdown(row)}
                              className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-xs font-medium"
                              title="View who gets paid what for each product"
                            >
                              <Info className="h-4 w-4 shrink-0" />
                              Details
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {paymentsPagination && paymentsPagination.total > 0 && (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-4 border-t border-gray-200">
                  <p className="text-sm text-gray-600">
                    Showing {(paymentsPagination.page - 1) * paymentsPagination.limit + 1}–
                    {Math.min(paymentsPagination.page * paymentsPagination.limit, paymentsPagination.total)} of{' '}
                    {paymentsPagination.total}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      disabled={paymentsPage <= 1 || paymentsLoading}
                      onClick={() => setPaymentsPage((p) => Math.max(1, p - 1))}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </button>
                    <span className="text-sm text-gray-600">
                      Page {paymentsPage}
                      {paymentsPagination.totalPages > 0 ? ` of ${paymentsPagination.totalPages}` : ''}
                    </span>
                    <button
                      type="button"
                      disabled={
                        paymentsLoading ||
                        paymentsPagination.totalPages <= 0 ||
                        paymentsPage >= paymentsPagination.totalPages
                      }
                      onClick={() => setPaymentsPage((p) => p + 1)}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 0 && (
            <div>
              {filterToolbar}

              {payoutsError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-red-700">
                  {payoutsError}
                </div>
              ) : payoutsLoading && payouts.length === 0 ? (
                <div className="flex justify-center py-16 text-gray-400">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : payouts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
                  <Banknote className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-700 font-medium">No payouts yet</p>
                  <p className="text-sm text-gray-500 mt-1">
                    {perspective === 'downline'
                      ? 'The selected downline has not been paid out in this date range.'
                      : 'Once a commission run is sent, your payout will show up here.'}
                  </p>
                </div>
              ) : (
                <>
                  {payoutsPage === 1 && payouts[0] && !isAggregateOwnerScope && (
                    <div className="mb-6 rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-white p-6">
                      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                        <div className="flex items-start gap-4">
                          <div className="hidden sm:flex h-12 w-12 rounded-full bg-blue-600/10 items-center justify-center shrink-0">
                            <TrendingUp className="h-6 w-6 text-blue-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold tracking-wide text-blue-700 uppercase">
                              Latest payout
                            </p>
                            <p className="text-3xl font-bold text-gray-900 mt-1 tabular-nums">
                              {formatCurrency(payouts[0].totalPaidToAgent || 0)}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
                              <span className="inline-flex items-center gap-1.5">
                                <CalendarDays className="h-4 w-4 text-gray-400" />
                                {formatDate(payouts[0].generatedDate)}
                              </span>
                              <span className="inline-flex items-center gap-1.5">
                                <FileText className="h-4 w-4 text-gray-400" />
                                {payouts[0].paymentCount || 0} payment{(payouts[0].paymentCount || 0) !== 1 ? 's' : ''}
                              </span>
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void openPayoutDetail(payouts[0].nachaId, payouts[0].commissionOwnerAgentId)}
                          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
                        >
                          <Info className="h-4 w-4" />
                          View breakdown
                        </button>
                      </div>
                    </div>
                  )}

                  {(() => {
                    const heroShown = payoutsPage === 1 && !isAggregateOwnerScope && !!payouts[0];
                    const listItems = payouts.slice(heroShown ? 1 : 0);
                    if (listItems.length === 0) return null;
                    return (
                      <>
                        <h3 className="text-sm font-semibold text-gray-700 mb-3">
                          {heroShown ? 'Past payouts' : 'Payouts'}
                        </h3>
                        <ul className="space-y-2">
                          {listItems.map((p) => (
                          <li
                            key={`${p.nachaId}:${p.commissionOwnerAgentId || 'self'}`}
                            className="group rounded-lg border border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm transition-all"
                          >
                            <button
                              type="button"
                              onClick={() => void openPayoutDetail(p.nachaId, p.commissionOwnerAgentId)}
                              className="w-full flex items-center justify-between gap-4 px-4 py-3 text-left"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="hidden sm:flex h-9 w-9 rounded-full bg-gray-100 items-center justify-center shrink-0">
                                  {isAggregateOwnerScope ? (
                                    <User className="h-4 w-4 text-gray-500" />
                                  ) : (
                                    <Banknote className="h-4 w-4 text-gray-500" />
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-base font-semibold text-gray-900 truncate">
                                    {isAggregateOwnerScope
                                      ? (p.commissionOwnerName || 'Unknown agent')
                                      : formatDate(p.generatedDate)}
                                  </p>
                                  <p className="text-xs text-gray-500 truncate">
                                    {isAggregateOwnerScope ? `${formatDate(p.generatedDate)} · ` : ''}
                                    {p.paymentCount || 0} payment{(p.paymentCount || 0) !== 1 ? 's' : ''}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-4 shrink-0">
                                <span className="text-base font-semibold text-gray-900 tabular-nums">
                                  {formatCurrency(p.totalPaidToAgent || 0)}
                                </span>
                                <span className="inline-flex items-center text-xs font-medium text-gray-600 group-hover:text-blue-700">
                                  Details
                                  <ChevronRight className="h-4 w-4 ml-0.5" />
                                </span>
                              </div>
                            </button>
                          </li>
                          ))}
                        </ul>
                      </>
                    );
                  })()}
                </>
              )}
              {payoutsPagination && payoutsPagination.total > 0 && (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-4 border-t border-gray-200">
                  <p className="text-sm text-gray-600">
                    Showing {(payoutsPagination.page - 1) * payoutsPagination.limit + 1}–
                    {Math.min(payoutsPagination.page * payoutsPagination.limit, payoutsPagination.total)} of{' '}
                    {payoutsPagination.total}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      disabled={payoutsPage <= 1 || payoutsLoading}
                      onClick={() => setPayoutsPage((p) => Math.max(1, p - 1))}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </button>
                    <span className="text-sm text-gray-600">
                      Page {payoutsPage}
                      {payoutsPagination.totalPages > 0 ? ` of ${payoutsPagination.totalPages}` : ''}
                    </span>
                    <button
                      type="button"
                      disabled={
                        payoutsLoading ||
                        payoutsPagination.totalPages <= 0 ||
                        payoutsPage >= payoutsPagination.totalPages
                      }
                      onClick={() => setPayoutsPage((p) => p + 1)}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 2 && (
            <div>
              <p className="text-sm text-gray-500 mb-4">
                {perspective === 'downline'
                  ? 'Payments sold by the selected downline that have not had commission rows generated yet.'
                  : 'Payments you sold that have not had commission rows generated yet.'}
              </p>
              {perspective === 'downline' && filterToolbar}
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment date</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Group / member</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Payment amount</th>
                      {isAggregateOwnerScope && (
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Commission owner</th>
                      )}
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Selling agent</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment status</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {awaitingError ? (
                      <tr>
                        <td colSpan={isAggregateOwnerScope ? 6 : 5} className="px-4 py-8 text-center text-red-600">
                          {awaitingError}
                        </td>
                      </tr>
                    ) : awaitingLoading ? (
                      <tr>
                        <td colSpan={isAggregateOwnerScope ? 6 : 5} className="px-4 py-8 text-center text-gray-500">
                          <Loader2 className="h-6 w-6 animate-spin inline text-gray-400" />
                        </td>
                      </tr>
                    ) : awaitingRows.length === 0 ? (
                      <tr>
                        <td colSpan={isAggregateOwnerScope ? 6 : 5} className="px-4 py-8 text-center text-gray-500">
                          All payments have commissions generated — nothing outstanding.
                        </td>
                      </tr>
                    ) : (
                      awaitingRows.map((row) => (
                        <tr key={row.paymentId} className="hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{formatDate(row.paymentDate)}</td>
                          <td className="px-4 py-3 text-sm">
                            <button
                              type="button"
                              onClick={() => handleClientClick(row as CommissionPaymentRow)}
                              className="font-medium text-blue-600 hover:text-blue-800 hover:underline text-left"
                            >
                              {row.groupName || row.memberName || '—'}
                            </button>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">{formatCurrency(row.amount)}</td>
                          {isAggregateOwnerScope && (
                            <td className="px-4 py-3 text-sm text-gray-700">{row.commissionOwnerName || row.sellingAgentName || '—'}</td>
                          )}
                          <td className="px-4 py-3 text-sm text-gray-700">{row.sellingAgentName || '—'}</td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(row.status)}`}>
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {awaitingPagination && awaitingPagination.total > 0 && (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-4 border-t border-gray-200">
                  <p className="text-sm text-gray-600">
                    Showing {(awaitingPagination.page - 1) * awaitingPagination.limit + 1}–
                    {Math.min(awaitingPagination.page * awaitingPagination.limit, awaitingPagination.total)} of{' '}
                    {awaitingPagination.total}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      disabled={awaitingPage <= 1 || awaitingLoading}
                      onClick={() => setAwaitingPage((p) => Math.max(1, p - 1))}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </button>
                    <span className="text-sm text-gray-600">
                      Page {awaitingPage}
                      {awaitingPagination.totalPages > 0 ? ` of ${awaitingPagination.totalPages}` : ''}
                    </span>
                    <button
                      type="button"
                      disabled={
                        awaitingLoading ||
                        awaitingPagination.totalPages <= 0 ||
                        awaitingPage >= awaitingPagination.totalPages
                      }
                      onClick={() => setAwaitingPage((p) => p + 1)}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {breakdownPaymentId && (
        <PaymentCommissionBreakdownModal
          isOpen={breakdownOpen}
          onClose={() => {
            setBreakdownOpen(false);
            setBreakdownPaymentId(null);
            setBreakdownRow(null);
          }}
          paymentId={breakdownPaymentId}
          paymentDate={breakdownRow?.paymentDate}
          amount={breakdownRow?.amount}
          agentName={breakdownRow?.sellingAgentName || undefined}
          clientName={
            breakdownRow
              ? breakdownRow.groupName || breakdownRow.memberName || undefined
              : undefined
          }
          breakdownSource={perspective === 'downline' ? 'me-agent-downline' : 'me-agent'}
        />
      )}

      {payoutDetailNachaId && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-screen items-center justify-center px-4 py-8">
            <button
              type="button"
              className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
              aria-label="Close"
              onClick={() => {
                setPayoutDetailNachaId(null);
                setPayoutDetailPayout(null);
              }}
            />
            <div className="relative bg-white rounded-lg shadow-xl max-w-5xl w-full max-h-[90vh] flex flex-col border border-gray-200">
              <div className="flex items-start justify-between p-6 border-b border-gray-200">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-gray-900">Payout breakdown</h3>
                  {payoutDetailPayout && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays className="h-4 w-4 text-gray-400" />
                        {formatDate(payoutDetailPayout.generatedDate)}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <FileText className="h-4 w-4 text-gray-400" />
                        {payoutDetailPayout.paymentCount || 0} payment
                        {(payoutDetailPayout.paymentCount || 0) !== 1 ? 's' : ''}
                      </span>
                      <span className="inline-flex items-center gap-1.5 font-semibold text-gray-900">
                        <Banknote className="h-4 w-4 text-gray-400" />
                        {formatCurrency(payoutDetailPayout.totalPaidToAgent || 0)}
                      </span>
                      {isAggregateOwnerScope && payoutDetailPayout.commissionOwnerName && (
                        <span className="inline-flex items-center gap-1.5">
                          <User className="h-4 w-4 text-gray-400" />
                          {payoutDetailPayout.commissionOwnerName}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPayoutDetailNachaId(null);
                    setPayoutDetailPayout(null);
                  }}
                  className="text-gray-400 hover:text-gray-600 shrink-0 ml-4"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="p-6 overflow-y-auto flex-1">
                {payoutDetailLoading ? (
                  <div className="flex justify-center py-12 text-gray-500">
                    <Loader2 className="h-8 w-8 animate-spin" />
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Client</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Payment</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                            {perspective === 'downline' ? 'Commission' : 'Your commission'}
                          </th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Selling Agent</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Payout line</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {payoutDetailRows.map((row) => (
                          <tr key={`${row.paymentId}:${row.commissionOwnerAgentId || 'self'}`} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-sm whitespace-nowrap">{formatDate(row.paymentDate)}</td>
                            <td className="px-3 py-2 text-sm">
                              <button
                                type="button"
                                onClick={() => handleClientClick(row)}
                                className="text-blue-600 hover:underline font-medium"
                              >
                                {displayClientName(row)}
                              </button>
                            </td>
                            <td className="px-3 py-2 text-sm text-right">{formatCurrency(row.amount)}</td>
                            <td className="px-3 py-2 text-sm text-right font-medium">{formatCurrency(row.commissionAmount)}</td>
                            <td className="px-3 py-2 text-sm text-gray-700">
                              {row.commissionOwnerName || row.sellingAgentName || '—'}
                            </td>
                            <td className="px-3 py-2 text-sm text-right text-gray-700">
                              {formatCurrency(row.payoutLineAmount ?? 0)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => openBreakdown(row)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-xs font-medium"
                                title="View commission breakdown"
                              >
                                <Info className="h-3.5 w-3.5" />
                                Details
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showCalculator && (
        <CommissionSimulator
          onClose={() => setShowCalculator(false)}
          initialTenantId={user?.currentTenantId || user?.tenantId || undefined}
        />
      )}

      {memberModalMember && (
        <MemberManagementModal
          member={memberModalMember}
          householdMembers={memberModalHousehold}
          memberEnrollments={memberModalEnrollments}
          enrollmentsLoading={memberModalLoading}
          onClose={() => setMemberModalMember(null)}
          onEdit={() => {}}
          formatCurrency={formatCurrency}
          getStatusColor={getStatusColor}
          getRelationshipIcon={() => null}
          getRelationshipColor={() => 'bg-gray-100 text-gray-800'}
          canEdit={false}
          canDelete={false}
        />
      )}
    </div>
  );
};

export default AgentCommissions;
