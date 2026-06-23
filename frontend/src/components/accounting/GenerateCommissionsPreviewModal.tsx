// frontend/src/components/accounting/GenerateCommissionsPreviewModal.tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, Loader2, X, AlertTriangle, DollarSign, ChevronDown, ChevronRight, User, Eye, Info } from 'lucide-react';
import { getTierLevelLabel } from '../../constants/form-options';
import { apiService } from '../../services/apiServices';
import { apiService as apiServiceAuth } from '../../services/api.service';
import { useCommissionLevels } from '../../hooks/useCommissionLevels';
import { Member } from '../../types/member.types';
import MemberManagementModal from '../../pages/members/MemberManagementModal';
import AgentManagementModal from '../../pages/tenant-admin/AgentManagementModal';
import PaymentCommissionBreakdownModal from './PaymentCommissionBreakdownModal';

export interface MissingCommissionPreviewItem {
  paymentId: string;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  invoiceStatus?: string | null;
  invoicePaymentReceivedDate?: string | null;
  agentId?: string | null;
  paymentDate: string;
  amount: number;
  commission: number;
  paymentStatus: string;
  agentName: string;
  agentCommissionTierLevel?: number | null;
  clientName: string;
  clientType: 'group' | 'individual';
  groupId: string | null;
  memberId: string | null;
  productCount: number;
  productNames: string[];
  sellingAgentExpectedAmount?: number | null;
  uplineExpectedTotal?: number | null;
  uplineExpectedAmounts?: Array<{
    agentId: string;
    agentName: string;
    tierLevel: number | null;
    amount: number;
  }>;
  agencyExpectedTotal?: number | null;
  sellingAgentZeroPayout?: boolean;
  zeroPayoutReason?: string | null;
}

/** Paid invoice in range with no commissions AND will not be picked up by generate-missing. */
export interface SkippedInvoicePreviewItem {
  invoiceId: string;
  invoiceNumber: string | null;
  anchorDate: string;
  dueDate?: string | null;
  paymentReceivedDate?: string | null;
  totalAmount: number;
  commission: number | null;
  invoiceStatus: string;
  agentId: string | null;
  agentName: string | null;
  agentStatus: string | null;
  agentTenantId: string | null;
  invoiceTenantId: string | null;
  clientName: string;
  clientType: 'group' | 'individual';
  groupId: string | null;
  memberId: string | null;
  skipReason:
    | 'NO_AGENT_ON_ENROLLMENT'
    | 'AGENT_NOT_FOUND'
    | 'AGENT_DIFFERENT_TENANT'
    | 'AGENT_NOT_ACTIVE'
    | 'NO_COMMISSION_ON_INVOICE'
    | 'ZERO_COMMISSION'
    | 'UNKNOWN';
  skipReasonLabel: string;
}

interface TopupInvoicePreviewItem {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceStatus: string;
  anchorDate: string;
  paymentReceivedDate: string | null;
  totalAmount: number;
  commission: number | null;
  agentId: string | null;
  agentName: string | null;
  clientName: string;
  clientType: 'group' | 'individual';
  groupId: string | null;
  memberId: string | null;
  settlementPaymentId: string | null;
  settlementPaymentDate: string | null;
  existingCommissionTotal: number;
}

interface GenerateCommissionsPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerated?: () => void;
  /** Keep parent badge in sync with missing-preview row count */
  onMissingCountLoaded?: (count: number) => void;
  mode?: 'missing' | 'topup';
  /** Date range filter (settlement PaymentDate) - when provided, only rows in this range are included */
  startDate?: string;
  endDate?: string;
}

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const parseCalendarDate = (dateString?: string): Date | null => {
  if (!dateString) return null;
  const datePart = dateString.split('T')[0];
  const [y, m, d] = datePart.split('-').map(Number);
  if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
    // Calendar dates should not shift by local timezone.
    return new Date(y, m - 1, d);
  }
  const fallback = new Date(dateString);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};
const formatDate = (d: string) => {
  const parsed = parseCalendarDate(d);
  return parsed
    ? parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'Active': return 'bg-green-100 text-green-800';
    case 'Inactive': return 'bg-gray-100 text-gray-800';
    case 'Pending': return 'bg-yellow-100 text-yellow-800';
    case 'Terminated': return 'bg-red-100 text-red-800';
    case 'Suspended': return 'bg-orange-100 text-orange-800';
    default: return 'bg-gray-100 text-gray-800';
  }
};

const getInvoiceStatusColor = (status: string) => {
  switch (status) {
    case 'Paid': return 'bg-green-100 text-green-800';
    case 'Partial': return 'bg-yellow-100 text-yellow-800';
    case 'Unpaid': return 'bg-gray-100 text-gray-800';
    case 'Overdue': return 'bg-red-100 text-red-800';
    case 'Voided': return 'bg-gray-100 text-gray-600';
    default: return 'bg-gray-100 text-gray-800';
  }
};
const getRelationshipIcon = (relationshipType?: string) => {
  const color = relationshipType === 'P' ? 'text-blue-600' : relationshipType === 'S' ? 'text-pink-500' : relationshipType === 'C' ? 'text-green-600' : 'text-gray-500';
  return <User className={`h-4 w-4 ${color}`} />;
};
const getRelationshipColor = (relationshipType?: string) => {
  switch (relationshipType) {
    case 'P': return 'bg-blue-100 text-blue-800';
    case 'S': return 'bg-pink-100 text-pink-800';
    case 'C': return 'bg-green-100 text-green-800';
    default: return 'bg-gray-100 text-gray-800';
  }
};
const formatCurrencyForModal = (amount: number | null | undefined | string): string => {
  if (amount === null || amount === undefined) return '$0.00';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return isNaN(n) ? '$0.00' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
};

interface EnrollmentRow {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

type PreviewRow = {
  commissionId?: string;
  paymentId?: string;
  invoiceId?: string;
  invoiceNumber?: string | null;
  amount?: number;
  agentId?: string;
  agencyId?: string;
  transactionType: string;
  status?: string;
  recipientName?: string;
  entityType?: string;
  entityId?: string;
  expectedAmount?: number;
  existingAmount?: number;
  deltaAmount?: number;
  _previewError?: boolean;
};

const GenerateCommissionsPreviewModal: React.FC<GenerateCommissionsPreviewModalProps> = ({
  isOpen,
  onClose,
  onGenerated,
  onMissingCountLoaded,
  mode = 'missing',
  startDate,
  endDate,
}) => {
  const isTopupMode = mode === 'topup';
  const navigate = useNavigate();
  const [items, setItems] = useState<MissingCommissionPreviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaymentId, setExpandedPaymentId] = useState<string | null>(null);
  const [memberModalMember, setMemberModalMember] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<EnrollmentRow[]>([]);
  const [memberModalLoading, setMemberModalLoading] = useState(false);
  const [dryRunRows, setDryRunRows] = useState<PreviewRow[]>([]);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<{ createdCommissions: Array<{ paymentId: string; commissionIds?: string[]; commissionId?: string }>; createdCommissionIds: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const [breakdownPayment, setBreakdownPayment] = useState<MissingCommissionPreviewItem | null>(null);
  const [agentDetailModalAgentId, setAgentDetailModalAgentId] = useState<string | null>(null);
  /** Toggle next to Generate — fires one email per distinct agent receiving a row in this run. */
  const [notifyAgents, setNotifyAgents] = useState(false);
  const [notificationsQueued, setNotificationsQueued] = useState<number>(0);
  /** Tenant-configured commission level names — shared via useCommissionLevels(). */
  const { displayNameByLevel: tierLevelDisplayNames } = useCommissionLevels();

  const dynamicTierLabel = (level: number | null | undefined): string => {
    if (level == null) return '';
    const dyn = tierLevelDisplayNames.get(Number(level));
    return dyn ? `Level ${level}: ${dyn}` : getTierLevelLabel(level);
  };
  const [activeTab, setActiveTab] = useState<'primary' | 'skipped'>('primary');
  /** Settlement paymentIds selected for dry-run / generate (subset of items). */
  const [selectedPaymentIds, setSelectedPaymentIds] = useState<string[]>([]);
  const [skippedItems, setSkippedItems] = useState<SkippedInvoicePreviewItem[]>([]);
  const [skippedLoading, setSkippedLoading] = useState(false);
  const [skippedError, setSkippedError] = useState<string | null>(null);
  /** Top-up wizard: 1 = pick date range, 2 = select invoices + preview/generate */
  const [topupStep, setTopupStep] = useState<1 | 2>(1);
  const [topupStartDate, setTopupStartDate] = useState(startDate || '');
  const [topupEndDate, setTopupEndDate] = useState(endDate || '');
  const [topupItems, setTopupItems] = useState<TopupInvoicePreviewItem[]>([]);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([]);
  const [topupListLoading, setTopupListLoading] = useState(false);
  const [topupPreviewChecked, setTopupPreviewChecked] = useState(false);

  // (CommissionLevels are loaded via useCommissionLevels() above.)

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setItems([]);
    setDryRunRows([]);
    setGeneratedReport(null);
    setActiveTab('primary');
    setSelectedPaymentIds([]);
    setSkippedItems([]);
    setSkippedError(null);
    setTopupStep(1);
    setTopupStartDate(startDate || '');
    setTopupEndDate(endDate || '');
    setTopupItems([]);
    setSelectedInvoiceIds([]);
    setTopupPreviewChecked(false);

    // Load skipped invoices in parallel; doesn't block or interfere with primary logic.
    setSkippedLoading(true);
    const skippedParams = new URLSearchParams();
    const skippedStart = isTopupMode ? (startDate || topupStartDate) : startDate;
    const skippedEnd = isTopupMode ? (endDate || topupEndDate) : endDate;
    if (skippedStart) skippedParams.set('startDate', skippedStart);
    if (skippedEnd) skippedParams.set('endDate', skippedEnd);
    const skippedQuery = skippedParams.toString() ? `?${skippedParams.toString()}` : '';
    apiService
      .get<{ success: boolean; items: SkippedInvoicePreviewItem[]; count: number; message?: string }>(
        `/api/commissions/skipped-invoices${skippedQuery}`,
        { timeout: 120000 }
      )
      .then((res) => {
        if (res.success && Array.isArray(res.items)) setSkippedItems(res.items);
        else setSkippedError(res.message || 'Failed to load skipped invoices');
      })
      .catch((err: any) => setSkippedError(err.message || 'Failed to load skipped invoices'))
      .finally(() => setSkippedLoading(false));

    if (isTopupMode) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    const query = params.toString() ? `?${params.toString()}` : '';
    apiService
      .get<{ success: boolean; items: MissingCommissionPreviewItem[]; count: number; message?: string }>(
        `/api/commissions/missing-preview${query}`,
        { timeout: 120000 }
      ) // 2 min - can be slow with many payments
      .then((res) => {
        if (res.success && res.items) {
          setItems(res.items);
          setSelectedPaymentIds(res.items.map((i) => i.paymentId));
          setDryRunRows([]);
          onMissingCountLoaded?.(res.items.length);
        } else setError(res.message || 'Failed to load preview');
      })
      .catch((err: any) => setError(err.message || 'Failed to load preview'))
      .finally(() => setLoading(false));
  }, [isOpen, startDate, endDate, isTopupMode]);

  const openMemberModal = async (memberId: string) => {
    setMemberModalLoading(true);
    setMemberModalMember(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
    try {
      const [householdRes, enrollmentsRes] = await Promise.all([
        apiServiceAuth.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(`/api/members/${memberId}/with-household`),
        apiServiceAuth.get<{ success: boolean; data: any[] }>(`/api/enrollments?memberId=${memberId}`)
      ]);
      if (householdRes.success && householdRes.data) {
        setMemberModalMember(householdRes.data.member);
        setMemberModalHousehold(householdRes.data.householdMembers || []);
      }
      if (enrollmentsRes.success && enrollmentsRes.data) {
        setMemberModalEnrollments((enrollmentsRes.data as any[]).map((e: any) => ({
          EnrollmentId: e.EnrollmentId,
          ProductName: e.ProductName ?? '',
          ProductType: e.ProductType ?? '',
          Status: e.Status ?? '',
          EffectiveDate: e.EffectiveDate ?? '',
          TerminationDate: e.TerminationDate,
          Premium: e.Premium ?? e.PremiumAmount ?? 0,
          PaymentFrequency: e.PaymentFrequency ?? 'Monthly'
        })));
      }
    } catch (err) {
      console.error('Failed to load member for modal', err);
      setError('Failed to load member details');
    } finally {
      setMemberModalLoading(false);
    }
  };

  const selectedItems = useMemo(
    () => items.filter((i) => selectedPaymentIds.includes(i.paymentId)),
    [items, selectedPaymentIds]
  );

  const selectedTopupItems = useMemo(
    () => topupItems.filter((i) => selectedInvoiceIds.includes(i.invoiceId)),
    [topupItems, selectedInvoiceIds]
  );

  const allTopupItemsSelected = topupItems.length > 0 && selectedInvoiceIds.length === topupItems.length;
  const someTopupItemsSelected = selectedInvoiceIds.length > 0;

  const allItemsSelected = items.length > 0 && selectedPaymentIds.length === items.length;
  const someItemsSelected = selectedPaymentIds.length > 0;

  const toggleSelectInvoice = useCallback((invoiceId: string) => {
    setSelectedInvoiceIds((prev) =>
      prev.includes(invoiceId) ? prev.filter((id) => id !== invoiceId) : [...prev, invoiceId]
    );
    setDryRunRows([]);
    setTopupPreviewChecked(false);
  }, []);

  const toggleSelectAllTopup = useCallback(() => {
    setSelectedInvoiceIds(allTopupItemsSelected ? [] : topupItems.map((i) => i.invoiceId));
    setDryRunRows([]);
    setTopupPreviewChecked(false);
  }, [allTopupItemsSelected, topupItems]);

  const loadTopupInvoices = async () => {
    if (!topupStartDate || !topupEndDate) {
      setError('Select a start and end date.');
      return;
    }
    setTopupListLoading(true);
    setError(null);
    setTopupItems([]);
    setSelectedInvoiceIds([]);
    setDryRunRows([]);
    setTopupPreviewChecked(false);
    try {
      const params = new URLSearchParams({ startDate: topupStartDate, endDate: topupEndDate });
      const res = await apiService.get<{
        success: boolean;
        items: TopupInvoicePreviewItem[];
        message?: string;
      }>(`/api/commissions/topup-preview?${params.toString()}`, { timeout: 120000 });
      if (res.success && Array.isArray(res.items)) {
        setTopupItems(res.items);
        setSelectedInvoiceIds(res.items.map((i) => i.invoiceId));
        setTopupStep(2);
      } else {
        setError(res.message || 'Failed to load invoices for top-up');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load invoices for top-up');
    } finally {
      setTopupListLoading(false);
    }
  };

  const toggleSelectPayment = useCallback((paymentId: string) => {
    setSelectedPaymentIds((prev) =>
      prev.includes(paymentId) ? prev.filter((id) => id !== paymentId) : [...prev, paymentId]
    );
    setDryRunRows([]);
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedPaymentIds(allItemsSelected ? [] : items.map((i) => i.paymentId));
    setDryRunRows([]);
  }, [allItemsSelected, items]);

  const handleDryRun = async () => {
    if (isTopupMode) {
      if (selectedTopupItems.length === 0) return;
    } else if (selectedItems.length === 0) {
      return;
    }
    setDryRunLoading(true);
    setError(null);
    setDryRunRows([]);
    setTopupPreviewChecked(false);
    try {
      if (isTopupMode) {
        const response = await apiService.post<{
          success: boolean;
          topupPreview?: PreviewRow[];
          message?: string;
        }>(
          '/api/commissions/generate-topup',
          { dryRun: true, invoiceIds: selectedInvoiceIds },
          { timeout: 300000 }
        );
        if (response.success) {
          const rows = (response.topupPreview || []).filter((r: any) => !r._previewError);
          setDryRunRows(rows);
          setTopupPreviewChecked(true);
        } else {
          setError(response.message || 'Top-up dry run failed');
        }
      } else {
        const body: { dryRun: boolean; startDate?: string; endDate?: string; paymentIds?: string[] } = {
          dryRun: true,
          paymentIds: selectedPaymentIds
        };
        if (startDate) body.startDate = startDate;
        if (endDate) body.endDate = endDate;
        const response = await apiService.post<{
          success: boolean;
          dryRunPreview?: PreviewRow[];
          message?: string;
        }>('/api/commissions/generate-missing', body, { timeout: 300000 });
        if (response.success && response.dryRunPreview) {
          const rows = response.dryRunPreview.filter((r: any) => !r._previewError);
          setDryRunRows(rows);
        } else {
          setError(response.message || 'Dry run failed');
        }
      }
    } catch (err: any) {
      setError(err.message || (isTopupMode ? 'Top-up dry run failed' : 'Dry run failed'));
    } finally {
      setDryRunLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (isTopupMode) {
      if (selectedTopupItems.length === 0) return;
    } else if (selectedItems.length === 0) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      if (isTopupMode) {
        const response = await apiService.post<{
          success: boolean;
          createdCommissions?: Array<{ invoiceId: string; paymentId: string | null; commissionId: string }>;
          message?: string;
        }>(
          '/api/commissions/generate-topup',
          { dryRun: false, invoiceIds: selectedInvoiceIds },
          { timeout: 900000 }
        );
        if (response.success) {
          const createdIds = (response.createdCommissions || [])
            .map((r) => r.commissionId)
            .filter(Boolean);
          setGeneratedReport({
            createdCommissions: (response.createdCommissions || []).map((r) => ({
              paymentId: r.paymentId || r.invoiceId,
              commissionId: r.commissionId
            })),
            createdCommissionIds: createdIds
          });
          onGenerated?.();
        } else {
          setError(response.message || 'Top-up generation failed');
        }
      } else {
        const body: { startDate?: string; endDate?: string; notifyAgents?: boolean; paymentIds?: string[] } = {};
        if (startDate) body.startDate = startDate;
        if (endDate) body.endDate = endDate;
        if (notifyAgents) body.notifyAgents = true;
        body.paymentIds = selectedPaymentIds;
        const response = await apiService.post<{
          success: boolean;
          processed: number;
          created: number;
          failed: number;
          createdCommissions?: Array<{ paymentId: string; commissionIds: string[] }>;
          createdCommissionIds?: string[];
          message?: string;
          errors?: Array<{ paymentId: string; error: string }>;
          notificationsQueued?: number;
        }>('/api/commissions/generate-missing', body, { timeout: 900000 });

        if (response.success) {
          setGeneratedReport({
            createdCommissions: response.createdCommissions || [],
            createdCommissionIds: response.createdCommissionIds || []
          });
          if ((response.notificationsQueued ?? 0) > 0) {
            setNotificationsQueued(response.notificationsQueued ?? 0);
          }
          onGenerated?.();
        } else {
          setError(response.message || 'Generate failed');
        }
      }
    } catch (err: any) {
      setError(err.message || (isTopupMode ? 'Failed to generate top-up commissions' : 'Failed to generate commissions'));
    } finally {
      setGenerating(false);
    }
  };

  const copyAllCommissionIds = () => {
    if (!generatedReport?.createdCommissionIds?.length) return;
    const text = generatedReport.createdCommissionIds.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  /** Sum of commission row amounts from dry run (matches what would be inserted). */
  const totalFromDryRun = useMemo(() => {
    if (dryRunRows.length === 0) return null;
    if (isTopupMode) {
      return dryRunRows.reduce((s, r) => s + Number(r.deltaAmount ?? 0), 0);
    }
    return dryRunRows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  }, [dryRunRows, isTopupMode]);

  /** Seller + upline + agency payout total for selected rows (matches what generation inserts). */
  const payoutTotalFromItems = useMemo(() => {
    if (selectedItems.length === 0) return null;
    return selectedItems.reduce((sum, row) => {
      const seller = Number(row.sellingAgentExpectedAmount ?? 0);
      const upline =
        row.uplineExpectedTotal != null
          ? Number(row.uplineExpectedTotal)
          : (row.uplineExpectedAmounts ?? []).reduce((acc, u) => acc + Number(u.amount ?? 0), 0);
      const agency = Number(row.agencyExpectedTotal ?? 0);
      return sum + seller + upline + agency;
    }, 0);
  }, [selectedItems]);

  const headerTotalDollars =
    totalFromDryRun !== null ? totalFromDryRun : !isTopupMode ? payoutTotalFromItems : null;
  const headerTotalLabel = isTopupMode
    ? 'Total top-up that would be generated'
    : 'Total that would be generated';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative bg-white rounded-lg shadow-xl border border-gray-200 w-[92vw] max-w-[1600px] mx-4 max-h-[94vh] flex flex-col">
        <div className="flex items-start justify-between gap-4 p-6 border-b border-gray-200">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-6 w-6 text-yellow-600 shrink-0" />
              <h2 className="text-xl font-semibold text-gray-900">
                {isTopupMode ? 'Check for commission top-ups' : 'Generate commissions - preview'}
              </h2>
            </div>
            {isTopupMode ? (
              topupStep === 2 && topupStartDate && topupEndDate ? (
                <p className="text-sm text-gray-500">
                  Step 2 — Select invoices ({formatDate(topupStartDate)} – {formatDate(topupEndDate)})
                </p>
              ) : (
                <p className="text-sm text-gray-500">Step 1 — Choose date range for paid invoices</p>
              )
            ) : startDate && endDate ? (
              <p className="text-sm text-gray-500">
                Date range: {formatDate(startDate)} – {formatDate(endDate)} (settlement date; invoice Paid may be later)
              </p>
            ) : null}
          </div>
          {headerTotalDollars !== null && (
            <div className="shrink-0 text-right pr-2 border-r border-gray-200 mr-2">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{headerTotalLabel}</p>
              <p className="text-2xl font-semibold text-oe-primary tabular-nums">{formatCurrency(headerTotalDollars)}</p>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 shrink-0"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 pt-4 border-b border-gray-200">
          <nav className="-mb-px flex space-x-6" aria-label="Preview tabs">
            <button
              type="button"
              onClick={() => setActiveTab('primary')}
              className={`py-2 px-1 border-b-2 text-sm font-medium ${
                activeTab === 'primary'
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {isTopupMode ? 'Top-ups' : 'Missing commissions'}
              {isTopupMode && topupStep === 2 && topupItems.length > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 text-blue-800 px-2 py-0.5 text-[11px] font-semibold">
                  {someTopupItemsSelected ? `${selectedInvoiceIds.length}/${topupItems.length}` : topupItems.length}
                </span>
              )}
              {!isTopupMode && items.length > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 text-blue-800 px-2 py-0.5 text-[11px] font-semibold">
                  {someItemsSelected ? `${selectedPaymentIds.length}/${items.length}` : items.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('skipped')}
              className={`py-2 px-1 border-b-2 text-sm font-medium inline-flex items-center gap-1.5 ${
                activeTab === 'skipped'
                  ? 'border-yellow-600 text-yellow-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
              title="Paid invoices in range that won't generate commissions automatically"
            >
              {skippedItems.length > 0 && <AlertTriangle className="h-4 w-4 text-yellow-600" />}
              Skipped invoices
              {skippedLoading ? (
                <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin text-gray-400" />
              ) : skippedItems.length > 0 ? (
                <span className="ml-1 inline-flex items-center rounded-full bg-yellow-100 text-yellow-800 px-2 py-0.5 text-[11px] font-semibold">
                  {skippedItems.length}
                </span>
              ) : null}
            </button>
          </nav>
        </div>

        <div className="p-6 overflow-y-auto flex-1 min-h-0">
          {activeTab === 'skipped' && (
            <div>
              <p className="text-sm text-gray-600 mb-4">
                These Paid invoices are in the selected date range (by payment received or due date),
                have no commission rows, and will not be picked up by &quot;Generate missing commissions&quot;.
                Usually because there is no agent on the primary enrollment, the agent isn&apos;t active or is in another
                tenant, or commission on the invoice is missing or $0. Fix the underlying cause, then re-run generate-missing.
                Refund ledger rows are not listed here.
              </p>
              {skippedError && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-red-600 shrink-0" />
                  <p className="text-sm text-red-800">{skippedError}</p>
                </div>
              )}
              {skippedLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                  <span className="ml-2 text-gray-600">Loading skipped invoices...</span>
                </div>
              ) : skippedItems.length === 0 ? (
                <div className="text-center py-8 text-gray-600">
                  <p className="font-medium">No skipped invoices in this range.</p>
                  <p className="text-sm mt-1">All paid invoices either have commissions or will be handled by generate-missing.</p>
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto max-h-[60vh]">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Commission pool</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Client</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Agent</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reason</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {skippedItems.map((row) => (
                          <tr key={row.invoiceId} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap font-mono text-xs">
                              {row.invoiceNumber || row.invoiceId.slice(0, 8)}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{formatDate(row.anchorDate)}</td>
                            <td className="px-4 py-3 text-sm whitespace-nowrap">
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${getInvoiceStatusColor(row.invoiceStatus)}`}>
                                {row.invoiceStatus}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">{formatCurrency(Number(row.totalAmount))}</td>
                            <td className="px-4 py-3 text-sm text-right text-gray-700">
                              {row.commission != null ? formatCurrency(Number(row.commission)) : '—'}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-900 max-w-[200px]">
                              {row.clientType === 'group' && row.groupId ? (
                                <button
                                  type="button"
                                  onClick={() => navigate(`/admin/groups/${row.groupId}`)}
                                  className="text-blue-600 hover:text-blue-800 hover:underline truncate block text-left w-full"
                                  title={row.clientName}
                                >
                                  {row.clientName}
                                </button>
                              ) : row.clientType === 'individual' && row.memberId ? (
                                <button
                                  type="button"
                                  onClick={() => openMemberModal(row.memberId!)}
                                  disabled={memberModalLoading}
                                  className="text-blue-600 hover:text-blue-800 hover:underline truncate block text-left w-full disabled:opacity-50"
                                  title={row.clientName}
                                >
                                  {row.clientName}
                                </button>
                              ) : (
                                <span className="truncate block" title={row.clientName}>{row.clientName}</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-900">
                              {row.agentName || <span className="text-gray-400">—</span>}
                            </td>
                            <td className="px-4 py-3 text-sm">
                              <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 text-yellow-800 px-2 py-0.5 text-xs font-semibold">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {row.skipReasonLabel}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'primary' && loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
              <span className="ml-2 text-gray-600">
                {isTopupMode ? 'Loading top-up preview data...' : 'Loading payments that need commissions...'}
              </span>
            </div>
          )}

          {activeTab === 'primary' && error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600 shrink-0" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {activeTab === 'primary' && isTopupMode && topupStep === 2 && dryRunLoading && (
            <div className="flex items-center justify-center py-8 text-gray-600">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600 mr-2" />
              Calculating top-up deltas for {selectedInvoiceIds.length} invoice(s)...
            </div>
          )}

          {activeTab === 'primary' && isTopupMode && topupStep === 1 && !topupListLoading && (
            <div className="max-w-xl space-y-4">
              <p className="text-sm text-gray-600">
                Top-up compares current commission rules against existing rows on each paid invoice.
                Pick a date range first — invoices are filtered by payment received / due date.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <label className="block text-sm">
                  <span className="text-gray-700 font-medium">Start date</span>
                  <input
                    type="date"
                    value={topupStartDate}
                    onChange={(e) => setTopupStartDate(e.target.value)}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-700 font-medium">End date</span>
                  <input
                    type="date"
                    value={topupEndDate}
                    onChange={(e) => setTopupEndDate(e.target.value)}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={loadTopupInvoices}
                disabled={topupListLoading || !topupStartDate || !topupEndDate}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {topupListLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Check for top ups
              </button>
            </div>
          )}

          {activeTab === 'primary' && isTopupMode && topupListLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
              <span className="ml-2 text-gray-600">Loading invoices for top-up...</span>
            </div>
          )}

          {activeTab === 'primary' && isTopupMode && topupStep === 2 && !topupListLoading && topupItems.length === 0 && !error && (
            <div className="text-center py-8 text-gray-600">
              <p className="font-medium">No paid invoices with existing commissions in this range.</p>
              <button type="button" onClick={() => setTopupStep(1)} className="mt-3 text-sm text-blue-600 hover:underline">
                Change date range
              </button>
            </div>
          )}

          {activeTab === 'primary' && isTopupMode && topupStep === 2 && topupItems.length > 0 && (
            <>
              <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm text-gray-600">
                  Paid invoices with commission rows in {formatDate(topupStartDate)} – {formatDate(topupEndDate)}.
                </p>
                <button type="button" onClick={() => { setTopupStep(1); setDryRunRows([]); setTopupPreviewChecked(false); }} className="text-sm text-blue-600 hover:underline">
                  Change date range
                </button>
              </div>
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-[50vh]">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-3 text-left w-10">
                          <input
                            type="checkbox"
                            checked={allTopupItemsSelected}
                            onChange={toggleSelectAllTopup}
                            aria-label="Select all invoices"
                            className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                          />
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Invoice</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Paid</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Pool</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Existing comm.</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Client</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Agent</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {topupItems.map((row) => (
                        <tr key={row.invoiceId} className="hover:bg-gray-50">
                          <td className="px-3 py-3">
                            <input
                              type="checkbox"
                              checked={selectedInvoiceIds.includes(row.invoiceId)}
                              onChange={() => toggleSelectInvoice(row.invoiceId)}
                              className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                            />
                          </td>
                          <td className="px-4 py-3 text-sm font-mono text-xs">{row.invoiceNumber || row.invoiceId.slice(0, 8)}</td>
                          <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{formatDate(row.anchorDate)}</td>
                          <td className="px-4 py-3 text-sm text-right">{formatCurrency(row.totalAmount)}</td>
                          <td className="px-4 py-3 text-sm text-right">{row.commission != null ? formatCurrency(row.commission) : '—'}</td>
                          <td className="px-4 py-3 text-sm text-right">{formatCurrency(row.existingCommissionTotal)}</td>
                          <td className="px-4 py-3 text-sm text-gray-900 truncate max-w-[180px]" title={row.clientName}>{row.clientName}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">{row.agentName || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activeTab === 'primary' && isTopupMode && topupStep === 2 && !dryRunLoading && dryRunRows.length === 0 && someTopupItemsSelected && !error && !topupPreviewChecked && (
            <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">
              Preview selected invoices to see if any top ups are needed.
            </div>
          )}

          {activeTab === 'primary' && isTopupMode && topupStep === 2 && !dryRunLoading && dryRunRows.length === 0 && someTopupItemsSelected && !error && topupPreviewChecked && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
              No top ups needed for the selected invoices.
            </div>
          )}

          {activeTab === 'primary' && isTopupMode && topupStep === 2 && dryRunRows.length > 0 && (
            <div className="mt-6 border border-blue-200 rounded-lg overflow-hidden bg-blue-50/50">
              <h3 className="px-4 py-2 text-sm font-semibold text-blue-900 border-b border-blue-200">
                Top ups needed
              </h3>
              <div className="overflow-x-auto max-h-[40vh]">
                <table className="min-w-full divide-y divide-blue-200">
                  <thead className="bg-blue-100/80">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Invoice</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Recipient</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-blue-800 uppercase">Expected</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-blue-800 uppercase">Existing</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-blue-800 uppercase">Top-Up Delta</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Type</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-blue-100">
                    {dryRunRows.map((r) => (
                      <tr key={`${r.invoiceId || r.paymentId}_${r.entityType || ''}_${r.entityId || ''}`} className="text-sm">
                        <td className="px-4 py-2 font-mono text-xs text-gray-600">
                          {r.invoiceNumber || r.invoiceId?.slice(0, 8) || r.paymentId?.slice(0, 8) || '—'}
                        </td>
                        <td className="px-4 py-2 text-gray-900" title={`${r.entityType ?? 'Recipient'} ID: ${r.entityId ?? '—'}`}>
                          {r.recipientName || `${r.entityType ?? 'Recipient'} (${r.entityId ?? '—'})`}
                        </td>
                        <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(Number(r.expectedAmount || 0))}</td>
                        <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(Number(r.existingAmount || 0))}</td>
                        <td className="px-4 py-2 text-right text-green-700">{formatCurrency(Number(r.deltaAmount || 0))}</td>
                        <td className="px-4 py-2 text-gray-600">{r.transactionType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'primary' && isTopupMode && generatedReport && generatedReport.createdCommissionIds.length > 0 && (
            <div className="mt-6 border border-green-200 rounded-lg overflow-hidden bg-green-50/50">
              <h3 className="px-4 py-2 text-sm font-semibold text-green-900 border-b border-green-200">
                Generated top-up rows
              </h3>
              <div className="p-4">
                <p className="text-sm text-green-800 mb-2">
                  {generatedReport.createdCommissionIds.length} commission row(s) created. Copy all GUIDs:
                </p>
                <button
                  type="button"
                  onClick={copyAllCommissionIds}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-green-300 bg-white text-green-800 text-sm font-medium hover:bg-green-50"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy all commission GUIDs'}
                </button>
                <div className="mt-3 max-h-32 overflow-y-auto font-mono text-xs text-gray-600 bg-white border border-gray-200 rounded p-2">
                  {generatedReport.createdCommissionIds.map((id) => (
                    <div key={id}>{id}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'primary' && !loading && !isTopupMode && items.length > 0 && (
            <>
              {items.length > 0 && (
                <>
                  <p className="text-sm text-gray-600 mb-4">
                    {selectedPaymentIds.length} of {items.length} invoice(s) selected for generation.
                    Uncheck any row you want to skip. Preview includes expected seller and upline payouts.
                    Settlement may predate the invoice Paid date when funding was late.
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="overflow-x-auto max-h-[50vh]">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="px-3 py-3 text-left w-10">
                              <input
                                type="checkbox"
                                checked={allItemsSelected}
                                onChange={toggleSelectAll}
                                disabled={items.length === 0}
                                aria-label="Select all invoices"
                                className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                              />
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Invoice
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Settled
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Invoice paid
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Amount
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Available Commission
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Client
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Agent
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Seller Payout
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Products
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">
                              Details
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {items.map((row) => {
                            const isSelected = selectedPaymentIds.includes(row.paymentId);
                            return (
                            <React.Fragment key={row.paymentId}>
                              <tr className={`hover:bg-gray-50 ${!isSelected ? 'opacity-50' : ''}`}>
                                <td className="px-3 py-3">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelectPayment(row.paymentId)}
                                    aria-label={`Include ${row.invoiceNumber || row.clientName}`}
                                    className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                                  />
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap font-mono text-xs">
                                  {row.invoiceNumber || (row.invoiceId ? row.invoiceId.slice(0, 8) : '—')}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                                  {formatDate(row.paymentDate)}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                                  {row.invoicePaymentReceivedDate
                                    ? formatDate(row.invoicePaymentReceivedDate)
                                    : '—'}
                                  {row.invoiceStatus ? (
                                    <span className={`ml-1 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${getInvoiceStatusColor(row.invoiceStatus)}`}>
                                      {row.invoiceStatus}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">
                                  {formatCurrency(Number(row.amount))}
                                </td>
                                <td className="px-4 py-3 text-sm text-right text-green-700">
                                  {formatCurrency(Number(row.commission))}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 max-w-[160px]">
                                  {row.clientType === 'group' && row.groupId ? (
                                    <button
                                      type="button"
                                      onClick={() => navigate(`/admin/groups/${row.groupId}`)}
                                      className="text-blue-600 hover:text-blue-800 hover:underline truncate block text-left w-full"
                                      title={row.clientName}
                                    >
                                      {row.clientName}
                                    </button>
                                  ) : row.clientType === 'individual' && row.memberId ? (
                                    <button
                                      type="button"
                                      onClick={() => openMemberModal(row.memberId!)}
                                      disabled={memberModalLoading}
                                      className="text-blue-600 hover:text-blue-800 hover:underline truncate block text-left w-full disabled:opacity-50"
                                      title={row.clientName}
                                    >
                                      {row.clientName}
                                    </button>
                                  ) : (
                                    <span className="truncate block" title={row.clientName}>{row.clientName}</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900">
                                  <div>
                                    {row.agentId ? (
                                      <button
                                        type="button"
                                        onClick={() => setAgentDetailModalAgentId(row.agentId!)}
                                        className="font-medium text-blue-600 hover:text-blue-800 hover:underline text-left"
                                        title="View agent details"
                                      >
                                        {row.agentName}
                                      </button>
                                    ) : (
                                      <div className="font-medium">{row.agentName}</div>
                                    )}
                                    {row.agentCommissionTierLevel != null && (
                                      <div className="text-xs text-gray-500 mt-0.5">
                                        {dynamicTierLabel(row.agentCommissionTierLevel)}
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-sm text-right">
                                  <div className="flex flex-col items-end">
                                    <span className={`${(row.sellingAgentExpectedAmount || 0) > 0 ? 'text-green-700' : 'text-red-700'} font-medium`}>
                                      {formatCurrency(Number(row.sellingAgentExpectedAmount || 0))}
                                    </span>
                                    {row.sellingAgentZeroPayout && (
                                      <span
                                        className="mt-1 inline-flex items-center rounded-full bg-red-100 text-red-800 px-2 py-0.5 text-[10px] font-semibold"
                                        title={row.zeroPayoutReason || 'Selling agent expected payout is $0'}
                                      >
                                        Agent gets $0
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600">
                                  {row.productCount === 0 ? (
                                    '—'
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setExpandedPaymentId((id) => (id === row.paymentId ? null : row.paymentId))}
                                      className="flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline"
                                    >
                                      {expandedPaymentId === row.paymentId ? (
                                        <ChevronDown className="h-4 w-4 shrink-0" />
                                      ) : (
                                        <ChevronRight className="h-4 w-4 shrink-0" />
                                      )}
                                      {row.productCount} product{row.productCount !== 1 ? 's' : ''}
                                    </button>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-sm">
                                  <button
                                    type="button"
                                    onClick={() => setBreakdownPayment(row)}
                                    className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-xs font-medium"
                                    title="View who gets paid what for each product"
                                  >
                                    <Info className="h-4 w-4" />
                                    Details
                                  </button>
                                </td>
                              </tr>
                              {(row.uplineExpectedAmounts || []).length > 0 && (
                                <tr className="bg-blue-50/40">
                                  <td colSpan={8} className="px-4 py-2 text-sm">
                                    <div className="pl-8 text-gray-700">
                                      <span className="font-medium text-gray-500">Upline payouts: </span>
                                      {(row.uplineExpectedAmounts || []).map((u, idx) => (
                                        <span key={`${row.paymentId}_${u.agentId}_${idx}`}>
                                          {idx > 0 ? ' · ' : ''}
                                          {u.agentId ? (
                                            <button
                                              type="button"
                                              onClick={() => setAgentDetailModalAgentId(u.agentId)}
                                              className="text-blue-600 hover:text-blue-800 hover:underline"
                                              title="View agent details"
                                            >
                                              {u.agentName}
                                            </button>
                                          ) : (
                                            u.agentName
                                          )}
                                          {u.tierLevel != null ? ` (${dynamicTierLabel(u.tierLevel)})` : ''}
                                          {`: ${formatCurrency(Number(u.amount || 0))}`}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                              {expandedPaymentId === row.paymentId && row.productNames.length > 0 && (
                                <tr className="bg-gray-50">
                                  <td colSpan={8} className="px-4 py-2 text-sm">
                                    <div className="pl-8 text-gray-700">
                                      <span className="font-medium text-gray-500">Products: </span>
                                      {row.productNames.join(', ')}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {dryRunRows.length > 0 && (
                <div className="mt-6 border border-blue-200 rounded-lg overflow-hidden bg-blue-50/50">
                  <h3 className="px-4 py-2 text-sm font-semibold text-blue-900 border-b border-blue-200">
                    Dry run - commission rows that would be created
                  </h3>
                  <div className="overflow-x-auto max-h-[40vh]">
                    <table className="min-w-full divide-y divide-blue-200">
                      <thead className="bg-blue-100/80">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Payment ID</th>
                          {isTopupMode ? (
                            <>
                              <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Recipient</th>
                              <th className="px-4 py-2 text-right text-xs font-medium text-blue-800 uppercase">Expected</th>
                              <th className="px-4 py-2 text-right text-xs font-medium text-blue-800 uppercase">Existing</th>
                              <th className="px-4 py-2 text-right text-xs font-medium text-blue-800 uppercase">Top-Up Delta</th>
                            </>
                          ) : (
                            <>
                              <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Commission ID</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Recipient</th>
                              <th className="px-4 py-2 text-right text-xs font-medium text-blue-800 uppercase">Amount</th>
                            </>
                          )}
                          <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Type</th>
                          {!isTopupMode && (
                            <th className="px-4 py-2 text-left text-xs font-medium text-blue-800 uppercase">Status</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-blue-100">
                        {dryRunRows.map((r) => (
                          <tr key={`${r.paymentId}_${r.commissionId || r.entityType || ''}_${r.entityId || ''}`} className="text-sm">
                            <td className="px-4 py-2 font-mono text-xs text-gray-600">{r.paymentId}</td>
                            {isTopupMode ? (
                              <>
                                <td className="px-4 py-2 text-gray-900" title={`${r.entityType ?? 'Recipient'} ID: ${r.entityId ?? '—'}`}>
                                  {r.recipientName || `${r.entityType ?? 'Recipient'} (${r.entityId ?? '—'})`}
                                </td>
                                <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(Number(r.expectedAmount || 0))}</td>
                                <td className="px-4 py-2 text-right text-gray-700">{formatCurrency(Number(r.existingAmount || 0))}</td>
                                <td className="px-4 py-2 text-right text-green-700">{formatCurrency(Number(r.deltaAmount || 0))}</td>
                              </>
                            ) : (
                              <>
                                <td className="px-4 py-2 font-mono text-xs text-gray-700">{r.commissionId}</td>
                                <td className="px-4 py-2 text-gray-900 font-medium">{r.recipientName ?? '—'}</td>
                                <td className="px-4 py-2 text-right text-green-700">{formatCurrency(Number(r.amount))}</td>
                              </>
                            )}
                            <td className="px-4 py-2 text-gray-600">{r.transactionType}</td>
                            {!isTopupMode && <td className="px-4 py-2 text-gray-600">{r.status}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {generatedReport && generatedReport.createdCommissionIds.length > 0 && (
                <div className="mt-6 border border-green-200 rounded-lg overflow-hidden bg-green-50/50">
                  <h3 className="px-4 py-2 text-sm font-semibold text-green-900 border-b border-green-200">
                    {isTopupMode ? 'Generated top-up rows' : 'Generated commission rows'}
                  </h3>
                  <div className="p-4">
                    <p className="text-sm text-green-800 mb-2">
                      {generatedReport.createdCommissionIds.length} commission row(s) created.
                      {notificationsQueued > 0 && (
                        <span className="ml-1 text-green-700">
                          {notificationsQueued} agent notification email{notificationsQueued === 1 ? '' : 's'} queued.
                        </span>
                      )}{' '}
                      Copy all GUIDs:
                    </p>
                    <button
                      type="button"
                      onClick={copyAllCommissionIds}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-green-300 bg-white text-green-800 text-sm font-medium hover:bg-green-50"
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copied ? 'Copied' : 'Copy all commission GUIDs'}
                    </button>
                    <div className="mt-3 max-h-32 overflow-y-auto font-mono text-xs text-gray-600 bg-white border border-gray-200 rounded p-2">
                      {generatedReport.createdCommissionIds.map((id) => (
                        <div key={id}>{id}</div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {activeTab === 'primary' && !loading && (
          (isTopupMode && topupStep === 2 && topupItems.length > 0) ||
          (!isTopupMode && items.length > 0)
        ) && (
          <div className="flex items-center justify-between gap-3 p-6 border-t border-gray-200 bg-gray-50 rounded-b-lg flex-wrap">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDryRun}
                disabled={
                  dryRunLoading ||
                  generating ||
                  (isTopupMode ? !someTopupItemsSelected : !someItemsSelected)
                }
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                {dryRunLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                {isTopupMode ? 'Preview top ups' : 'Preview (dry run)'}
              </button>
            </div>
            <div className="flex items-center gap-3">
              {generatedReport ? (
                <button
                  type="button"
                  onClick={() => { setGeneratedReport(null); onClose(); }}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100"
                  >
                    Cancel
                  </button>
                  {!isTopupMode && (
                    <div className="inline-flex items-center gap-3">
                      <label className="inline-flex items-center gap-2 text-sm text-gray-700 select-none">
                        <input
                          type="checkbox"
                          checked={notifyAgents}
                          onChange={(e) => setNotifyAgents(e.target.checked)}
                          disabled={generating}
                          className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                        />
                        Notify agents (one email per agent with portal link)
                      </label>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const html = await apiServiceAuth.get<string>(
                              '/api/commissions/notify-agents-preview',
                              { responseType: 'text', headers: { Accept: 'text/html' } } as any
                            );
                            const win = window.open('', '_blank');
                            if (win) {
                              win.document.open();
                              win.document.write(html as unknown as string);
                              win.document.close();
                            }
                          } catch {
                            /* ignore */
                          }
                        }}
                        className="text-xs font-medium text-oe-primary hover:text-oe-dark underline-offset-2 hover:underline"
                        title="Open the email template in a new tab"
                      >
                        Preview email
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={
                      generating
                      || dryRunLoading
                      || (isTopupMode && (!someTopupItemsSelected || dryRunRows.length === 0))
                      || (!isTopupMode && !someItemsSelected)
                    }
                    className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50 flex items-center"
                  >
                    {generating ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        {isTopupMode ? 'Generating top ups...' : 'Generating...'}
                      </>
                    ) : (
                      <>
                        <DollarSign className="h-4 w-4 mr-2" />
                        {isTopupMode ? 'Confirm & generate' : 'Generate commissions'}
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {breakdownPayment && (
          <PaymentCommissionBreakdownModal
            isOpen={!!breakdownPayment}
            onClose={() => setBreakdownPayment(null)}
            paymentId={breakdownPayment.paymentId}
            paymentDate={breakdownPayment.paymentDate}
            amount={breakdownPayment.amount}
            agentName={breakdownPayment.agentName}
            agentCommissionTierLevel={breakdownPayment.agentCommissionTierLevel ?? null}
            clientName={breakdownPayment.clientName}
          />
        )}

        {memberModalMember && (
          <MemberManagementModal
            member={memberModalMember}
            householdMembers={memberModalHousehold}
            memberEnrollments={memberModalEnrollments}
            enrollmentsLoading={memberModalLoading}
            onClose={() => {
              setMemberModalMember(null);
              setMemberModalHousehold([]);
              setMemberModalEnrollments([]);
            }}
            onEdit={() => {}}
            formatCurrency={formatCurrencyForModal}
            getStatusColor={getStatusColor}
            getRelationshipIcon={getRelationshipIcon}
            getRelationshipColor={getRelationshipColor}
            canEdit={false}
            canDelete={false}
          />
        )}

        {agentDetailModalAgentId && (
          <AgentManagementModal
            agentId={agentDetailModalAgentId}
            isOpen={!!agentDetailModalAgentId}
            onClose={() => setAgentDetailModalAgentId(null)}
            initialTab="commission"
          />
        )}
      </div>
    </div>
  );
};

export default GenerateCommissionsPreviewModal;
