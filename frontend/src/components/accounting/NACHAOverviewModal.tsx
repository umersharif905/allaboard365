// frontend/src/components/accounting/NACHAOverviewModal.tsx
import { ArrowLeft, CheckCircle, FileText, Info, Loader2, User, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../../services/api.service';
import { useAuth } from '../../contexts/AuthContext';
import { commissionService } from '../../services/commissions.service';
import { NACHAValidationResponse, NACHAPreview, nachaService, StalePayablesSummaryData, StalePayablePaymentRow, StalePayableCommissionRow } from '../../services/nachaService';
import { getVendorNachaPreviewGap, VendorNachaPreviewGapRow } from '../../services/accounting/vendorBreakdown.service';
import { generateAgentStatement } from '../../utils/excelGenerator';
import { formatCurrency, formatDate } from '../../utils/helpers';
import MemberManagementModal from '../../pages/members/MemberManagementModal';
import { Member } from '../../types/member.types';
import AgencyDetailsModal from './AgencyDetailsModal';
import AgentDetailsModal from './AgentDetailsModal';
import NACHAPayoutRulesModal from './NACHAPayoutRulesModal';
import ClawbackDetailsModal from './ClawbackDetailsModal';
import PaymentCommissionBreakdownModal from './PaymentCommissionBreakdownModal';

/** Normalize payout entity ids so header/row checkboxes stay in sync (GUID casing). */
const normalizePayoutEntityId = (id: string) => String(id).trim().toUpperCase();

/** Estimated next commission/vendor payout window after the current NACHA period. */
const formatNextPayoutCycleRange = (startDate: string, endDate: string): string => {
  if (!endDate) return 'the next payout cycle';
  try {
    const end = new Date(endDate);
    const start = startDate ? new Date(startDate) : end;
    const durationMs = Math.max(0, end.getTime() - start.getTime());
    const nextStart = new Date(end);
    nextStart.setUTCDate(nextStart.getUTCDate() + 1);
    const nextEnd = new Date(nextStart.getTime() + durationMs);
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return `${fmt(nextStart)} – ${fmt(nextEnd)}`;
  } catch {
    return `after ${formatDate(endDate)}`;
  }
};

const carryForwardHoverTitle = (amount: number, startDate: string, endDate: string): string => {
  const range = formatNextPayoutCycleRange(startDate, endDate);
  return `Applies in future payout cycle (${range}). ${formatCurrency(amount)} of pending refund clawback will net against a future ACH payout.`;
};

const isValidVendorPayoutRow = (payout: NACHAPreview['payoutBreakdown'][0]) => {
  if ((payout as any).isSplit && (payout as any).distributionPercentage !== undefined) {
    return (payout as any).distributionPercentage > 0;
  }
  if (payout.amount === 0 || payout.amount === null || payout.amount === undefined) {
    return false;
  }
  return true;
};

interface NACHAOverviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  previews: Map<string, NACHAPreview>;
  startDate: string;
  endDate: string;
  tenantId?: string;
  onGenerate?: (
    payoutTypes: string[],
    startDate: string,
    endDate: string,
    tenantId?: string,
    filters?: {
      vendorIds?: string[];
      agentIds?: string[];
      agencyIds?: string[];
      fundingAchAccountIdByPayoutType?: Record<string, string>;
      companyIdentificationByPayoutType?: Record<string, string>;
      excludedPaymentIds?: string[];
      excludedInvoiceIds?: string[];
    }
  ) => Promise<void>;
  /** Optional fast summary from /stale-payables-summary (trailing window outside selected range). */
  stalePayablesSummary?: StalePayablesSummaryData | null;
}

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
const getRelationshipIcon = (relationshipType?: string) => {
  const color =
    relationshipType === 'P'
      ? 'text-blue-600'
      : relationshipType === 'S'
        ? 'text-pink-500'
        : relationshipType === 'C'
          ? 'text-green-600'
          : 'text-gray-500';
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
  return isNaN(n)
    ? '$0.00'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(n);
};

function ymdToLocalLabel(ymd: string) {
  const parts = ymd.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return ymd;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d).toLocaleDateString();
}

/** Invoice/payment anchors counted as included in this NACHA after per-row exclusions. */
function buildNachaPreviewIncludedAnchors(
  payout: any,
  excludedPaymentIds: Set<string>,
  excludedInvoiceIds: Set<string>
) {
  const invoiceIds: string[] = [];
  const paymentIds: string[] = [];
  const details: Array<{ paymentId?: string; invoiceId?: string }> = Array.isArray(payout?.payoutDetails)
    ? payout.payoutDetails
    : [];
  for (const d of details) {
    const pid = d?.paymentId ? String(d.paymentId) : '';
    const iid = d?.invoiceId ? String(d.invoiceId) : '';
    if ((pid && excludedPaymentIds.has(pid)) || (iid && excludedInvoiceIds.has(iid))) continue;
    if (iid) invoiceIds.push(iid);
    else if (pid) paymentIds.push(pid);
  }
  return {
    includedInvoiceIds: [...new Set(invoiceIds)],
    includedPaymentIds: [...new Set(paymentIds)],
  };
}

const NACHAOverviewModal: React.FC<NACHAOverviewModalProps> = ({
  isOpen,
  onClose,
  previews,
  startDate,
  endDate,
  tenantId: initialTenantId,
  onGenerate,
  stalePayablesSummary = null,
}) => {
  const [staleOutsideRangeOpen, setStaleOutsideRangeOpen] = useState(false);
  const [localTenantId, setLocalTenantId] = useState<string>(initialTenantId || '');
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [error, setError] = useState<string | null>(null);
  const previousPayoutCountRef = useRef<number>(0);
  const [showLedgerValidation, setShowLedgerValidation] = useState(false);
  const [ledgerValidationLoading, setLedgerValidationLoading] = useState(false);
  const [ledgerValidationError, setLedgerValidationError] = useState<string | null>(null);
  const [ledgerValidationResult, setLedgerValidationResult] = useState<NACHAValidationResponse | null>(null);

  // Sync local tenant ID with prop changes
  useEffect(() => {
    setLocalTenantId(initialTenantId || '');
  }, [initialTenantId]);

  // Fetch fees data when modal opens or dates/tenant change
  useEffect(() => {
    const fetchFees = async () => {
      if (!isOpen || !startDate || !endDate) return;
      
      setLoadingFees(true);
      try {
        const response = await nachaService.getFeesBreakdown(
          startDate,
          endDate,
          localTenantId || undefined
        );
        if (response.success) {
          setFeesData(response.fees || []);
          setFeesTotals(response.totals || { totalSystemFees: 0, totalProcessingFees: 0, totalFees: 0 });
        }
      } catch (error) {
        console.error('Failed to fetch fees:', error);
        setFeesData([]);
        setFeesTotals({ totalSystemFees: 0, totalProcessingFees: 0, totalFees: 0 });
      } finally {
        setLoadingFees(false);
      }
    };

    fetchFees();
  }, [isOpen, startDate, endDate, localTenantId]);

  // Auto-navigate to breakdown if only 1 payout type is selected
  useEffect(() => {
    if (!isOpen) {
      // Reset to overview when modal closes
      setActiveTab('overview');
      previousPayoutCountRef.current = 0;
      setVendorSelectionInitialized(false);
      setAgentAgencySelectionInitialized(false);
      return;
    }
    
    const payoutTypes = Array.from(previews.keys());
    const currentPayoutCount = payoutTypes.length;
    const previousCount = previousPayoutCountRef.current;
    
    // Auto-navigate only when:
    // 1. Modal just opened (previousCount === 0)
    // 2. Payout count changed from multiple to single
    const shouldAutoNavigate = previousCount === 0 || 
                               (previousCount > 1 && currentPayoutCount === 1);
    
    if (currentPayoutCount === 1 && shouldAutoNavigate) {
      // Only 1 payout type - go straight to its breakdown
      const singlePayoutType = payoutTypes[0];
      setActiveTab(singlePayoutType);
    } else if (currentPayoutCount === 0) {
      // No payout types, reset to overview
      setActiveTab('overview');
    } else if (currentPayoutCount > 1) {
      // Multiple payout types - only change if current tab is invalid (doesn't exist in previews)
      setActiveTab(prevTab => {
        if (prevTab !== 'overview' && !previews.has(prevTab)) {
          return 'overview';
        }
        return prevTab;
      });
    }
    
    // Update previous count for next comparison
    previousPayoutCountRef.current = currentPayoutCount;
  }, [isOpen, previews]);

  const [showRulesModal, setShowRulesModal] = useState(false);
  const [selectedRulesData, setSelectedRulesData] = useState<{
    entityType: string;
    entityId: string;
    recipientName: string;
    totalAmount: number;
    startDate: string;
    endDate: string;
  } | null>(null);
  const [showPaymentDetails, setShowPaymentDetails] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<{
    entityType: string;
    entityId: string;
    entityName: string;
  } | null>(null);
  const [clawbackTarget, setClawbackTarget] = useState<{
    entityType: 'Agent' | 'Agency' | 'Vendor' | 'Tenant';
    entityId: string;
    entityName: string;
  } | null>(null);
  const navigateClawback = useNavigate();
  const { user: clawbackUser } = useAuth();
  const navigateToGroupFromClawback = (groupId: string) => {
    const role = clawbackUser?.currentRole || 'TenantAdmin';
    setClawbackTarget(null);
    onClose();
    if (role === 'Agent') navigateClawback(`/agent/groups/${groupId}`);
    else if (role === 'TenantAdmin') navigateClawback(`/tenant-admin/groups/${groupId}`);
    else navigateClawback(`/admin/groups/${groupId}`);
  };
  /** Open group page without closing the payout overview. */
  const navigateToGroupPage = (groupId: string) => {
    if (!groupId) return;
    const role = clawbackUser?.currentRole || 'TenantAdmin';
    setStaleOutsideRangeOpen(false);
    if (role === 'Agent') navigateClawback(`/agent/groups/${groupId}`);
    else if (role === 'TenantAdmin') navigateClawback(`/tenant-admin/groups/${groupId}`);
    else navigateClawback(`/admin/groups/${groupId}`);
  };
  const [paymentDetails, setPaymentDetails] = useState<any[]>([]);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Per-row inclusion exclusions; user toggles in the details modal to skip specific payouts
  const [excludedPaymentIds, setExcludedPaymentIds] = useState<Set<string>>(new Set());
  const [excludedInvoiceIds, setExcludedInvoiceIds] = useState<Set<string>>(new Set());
  const nachaPreviewExclusionKey = useMemo(
    () =>
      `${[...excludedPaymentIds].sort().join(',')}|${[...excludedInvoiceIds].sort().join(',')}`,
    [excludedPaymentIds, excludedInvoiceIds]
  );
  const [vendorNachaOmittedByVendorId, setVendorNachaOmittedByVendorId] = useState<
    Record<
      string,
      { count: number; totalVendorShare: number; rows: VendorNachaPreviewGapRow[]; loading?: boolean }
    >
  >({});
  const [vendorNachaOmittedModalVendorId, setVendorNachaOmittedModalVendorId] = useState<string | null>(
    null
  );
  const [showAgentDetails, setShowAgentDetails] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [showAgencyDetails, setShowAgencyDetails] = useState(false);
  const [selectedAgencyId, setSelectedAgencyId] = useState<string | null>(null);
  const [selectedAgencyName, setSelectedAgencyName] = useState<string | null>(null);
  const [feesData, setFeesData] = useState<Array<{
    paymentId: string;
    paymentDate: string;
    groupId: string | null;
    groupName: string | null;
    memberName: string;
    systemFees: number;
    processingFee: number;
    totalFees: number;
  }>>([]);
  const [feesTotals, setFeesTotals] = useState<{
    totalSystemFees: number;
    totalProcessingFees: number;
    totalFees: number;
  }>({ totalSystemFees: 0, totalProcessingFees: 0, totalFees: 0 });
  const [loadingFees, setLoadingFees] = useState(false);

  // Live exclusion math. The per-recipient `payout.amount` (and `payout.netAmount`
  // when clawback is in play) is computed by the backend assuming every invoice
  // in the window flows into the NACHA. When the user excludes specific invoices
  // via the per-recipient picker, the row total here -- and the headline
  // totals on the cards / page -- need to drop accordingly so the user can
  // see exactly what the generated NACHA will disburse.
  //
  // We sum `amount` across `payout.payoutDetails` whose paymentId/invoiceId
  // is in the excluded sets. Each detail line carries the full per-line dollar
  // contribution to this recipient, so summing them reproduces what the backend
  // would skip if `excludedPaymentIds` / `excludedInvoiceIds` were applied.
  const computeExcludedPayoutAmount = (payout: any): number => {
    const details: any[] = Array.isArray(payout?.payoutDetails) ? payout.payoutDetails : [];
    if (!details.length) return 0;
    if (excludedPaymentIds.size === 0 && excludedInvoiceIds.size === 0) return 0;
    let excluded = 0;
    for (const d of details) {
      const pid = d?.paymentId ? String(d.paymentId) : null;
      const iid = d?.invoiceId ? String(d.invoiceId) : null;
      const isExcluded = (pid && excludedPaymentIds.has(pid))
        || (iid && excludedInvoiceIds.has(iid));
      if (isExcluded) excluded += Number(d?.amount) || 0;
    }
    // Split-payout adjustment.
    //
    // When a recipient has multiple ACH accounts (e.g. ShareWELL Holding 70% /
    // ShareWELL Partners LLC 30%), the backend creates one row per ACH account
    // with `amount = master * pct / 100` -- but the rest of the payout (and
    // critically `payoutDetails`) is spread from the master via `...payout`,
    // so `payoutDetails[i].amount` carries the FULL master amount on every
    // split row. If we subtracted that raw amount from the row's split total
    // we'd over-deduct (Brian's $378 master would drop the 70% Holding row by
    // $378 and the 30% Partners row by $378, for a combined $756 reduction
    // rather than the correct $378). Scaling by the distribution percentage
    // here keeps each split row in lockstep with its proportional share of
    // the excluded master amount.
    if (payout?.isSplit && payout?.distributionPercentage !== undefined && payout?.distributionPercentage !== null) {
      const pct = Number(payout.distributionPercentage);
      if (Number.isFinite(pct) && pct >= 0) {
        excluded = excluded * pct / 100;
      }
    }
    return Math.round(excluded * 100) / 100;
  };

  // Returns the dollar amount the user can expect this recipient to receive
  // on the generated NACHA after exclusions. Falls back to net (when clawback
  // is present) or gross. Floored at 0 so a single huge exclusion can't render
  // a negative amount.
  const getEffectivePayoutAmount = (payout: any, opts?: { useNet?: boolean }): number => {
    const base = (opts?.useNet && payout?.netAmount !== undefined && payout?.netAmount !== null)
      ? Number(payout.netAmount) || 0
      : Number(payout?.amount) || 0;
    const excluded = computeExcludedPayoutAmount(payout);
    if (excluded <= 0) return base;
    return Math.max(0, Math.round((base - excluded) * 100) / 100);
  };
  const [showProductBreakdown, setShowProductBreakdown] = useState(false);
  const [selectedPaymentForProducts, setSelectedPaymentForProducts] = useState<any>(null);
  // Per-payment "Details" breakdown — uses the same modal as Generate Commissions Preview
  // so accounting sees a single, consistent who-gets-what view across both flows.
  // Only used for Agent/Agency Commission Payouts (which is what the breakdown endpoint covers).
  const [breakdownPayment, setBreakdownPayment] = useState<{
    paymentId: string;
    paymentDate?: string;
    amount?: number;
    agentName?: string;
    agentCommissionTierLevel?: number | null;
    clientName?: string;
  } | null>(null);
  const [productBreakdown, setProductBreakdown] = useState<Array<{
    productId: string;
    productName: string;
    enrolledHouseholdsCount: number;
    totalCost: number;
    payoutAmount: number;
    isVendorProduct?: boolean;
  }>>([]);

  // Vendor breakdown (inline household breakdown inside the breakdown modal)
  const [vendorBreakdownSelectedProductId, setVendorBreakdownSelectedProductId] = useState<string>('');
  const [vendorBreakdownSelectedProductName, setVendorBreakdownSelectedProductName] = useState<string>('');
  const [vendorBreakdownHouseholds, setVendorBreakdownHouseholds] = useState<any[]>([]);
  const [vendorBreakdownHouseholdsLoading, setVendorBreakdownHouseholdsLoading] = useState(false);
  const [vendorBreakdownHouseholdsError, setVendorBreakdownHouseholdsError] = useState<string | null>(null);

  const [memberModalMember, setMemberModalMember] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<EnrollmentRow[]>([]);
  const [memberModalLoading, setMemberModalLoading] = useState(false);
  
  // Household details modal state
  const [showHouseholdDetails, setShowHouseholdDetails] = useState(false);
  const [selectedProductForHouseholds, setSelectedProductForHouseholds] = useState<{
    productId: string;
    productName: string;
    paymentId: string;
  } | null>(null);
  const [currentPaymentForHouseholds, setCurrentPaymentForHouseholds] = useState<any>(null);
  const [availableProductsForFilter, setAvailableProductsForFilter] = useState<Array<{
    productId: string;
    productName: string;
    vendorName: string;
  }>>([]);
  const [filteredProductId, setFilteredProductId] = useState<string>('ALL');
  const [selectedVendorIds, setSelectedVendorIds] = useState<Set<string>>(new Set()); // For vendor payout selection
  const [vendorSelectionInitialized, setVendorSelectionInitialized] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [selectedAgencyIds, setSelectedAgencyIds] = useState<Set<string>>(new Set());
  const [agentAgencySelectionInitialized, setAgentAgencySelectionInitialized] = useState(false);
  const [achOptions, setAchOptions] = useState<Array<{
    achAccountId: string;
    accountHolderName: string;
    bankName: string;
    accountNumberLast4?: string;
    accountType: string;
    label: string;
    isDefault: boolean;
    accountSource: string;
    companyIdentification?: string | null;
  }>>([]);
  const [achOptionsError, setAchOptionsError] = useState<string | null>(null);
  const [selectedFundingAchAccountIdByPayoutType, setSelectedFundingAchAccountIdByPayoutType] = useState<Record<string, string>>({});
  const [companyIdentificationByPayoutType, setCompanyIdentificationByPayoutType] = useState<Record<string, string>>({});
  const [companyIdLockedByPayoutType, setCompanyIdLockedByPayoutType] = useState<Record<string, boolean>>({});
  const [loadingAchOptions, setLoadingAchOptions] = useState(false);
  const [companyIdError, setCompanyIdError] = useState<string | null>(null);

  const handleExport = async (entityType: string, entityId: string, entityName: string) => {
    try {
      const response = await nachaService.getExportDetails(
        entityType,
        entityId,
        startDate,
        endDate
      );

      if (response.success) {
        // Generate Excel Statement
        generateAgentStatement({
          agentName: entityName,
          period: `${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`,
          entityType: entityType,
          summary: response.summary,
          payments: response.payments,
          groups: response.groups,
          individuals: response.individuals,
          products: response.products
        });
      }
    } catch (err: any) {
      console.error('Export failed:', err);
      alert('Failed to export statement: ' + (err.message || 'Unknown error'));
    }
  };

  const [householdDetails, setHouseholdDetails] = useState<Array<{
    householdId: string;
    householdName: string;
    householdTier: string | null;
    enrollmentCount: number;
    householdPayment: number;
    entityPayout: number;
    ageBand: string | null;
    systemFees?: number;
    processingFees?: number;
    totalFees?: number;
    configValue?: string | null;
  }>>([]);
  const [householdConfigFieldName, setHouseholdConfigFieldName] = useState<string | null>(null);
  const [householdDetailsLoading, setHouseholdDetailsLoading] = useState(false);
  const [householdDetailsPagination, setHouseholdDetailsPagination] = useState<{
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }>({ page: 1, limit: 50, total: 0, totalPages: 0 });

  const loadVendorBreakdownHouseholds = async (productId: string, productName: string) => {
    if (!selectedRecipient || selectedRecipient.entityType !== 'Vendor') return;
    if (!selectedPaymentForProducts?.paymentId) return;

    setVendorBreakdownSelectedProductId(productId);
    setVendorBreakdownSelectedProductName(productName);
    setVendorBreakdownHouseholdsLoading(true);
    setVendorBreakdownHouseholdsError(null);
    setVendorBreakdownHouseholds([]);

    try {
      const params = new URLSearchParams({
        entityType: 'Vendor',
        entityId: selectedRecipient.entityId,
        page: '1',
        limit: '1000'
      });
      const response = await apiService.get<{
        success: boolean;
        households?: any[];
        message?: string;
      }>(
        `/api/accounting/nacha/payment/${selectedPaymentForProducts.paymentId}/product/${productId}/households?${params.toString()}`
      );

      if (response.success) {
        setVendorBreakdownHouseholds(response.households || []);
      } else {
        setVendorBreakdownHouseholds([]);
        setVendorBreakdownHouseholdsError(response.message || 'Failed to load household breakdown');
      }
    } catch (error: any) {
      setVendorBreakdownHouseholds([]);
      setVendorBreakdownHouseholdsError(error?.message || 'Failed to load household breakdown');
    } finally {
      setVendorBreakdownHouseholdsLoading(false);
    }
  };

  const openMemberModal = async (memberId: string) => {
    if (!memberId) return;
    setMemberModalLoading(true);
    setMemberModalMember(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
    try {
      const [householdRes, enrollmentsRes] = await Promise.all([
        apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(
          `/api/members/${memberId}/with-household`
        ),
        apiService.get<{ success: boolean; data: any[] }>(`/api/enrollments?memberId=${memberId}`)
      ]);

      if (householdRes.success && householdRes.data) {
        setMemberModalMember(householdRes.data.member);
        setMemberModalHousehold(householdRes.data.householdMembers || []);
      }
      if (enrollmentsRes.success && enrollmentsRes.data) {
        setMemberModalEnrollments(
          (enrollmentsRes.data as any[]).map((e: any) => ({
            EnrollmentId: e.EnrollmentId,
            ProductName: e.ProductName ?? '',
            ProductType: e.ProductType ?? '',
            Status: e.Status ?? '',
            EffectiveDate: e.EffectiveDate ?? '',
            TerminationDate: e.TerminationDate,
            Premium: e.Premium ?? e.PremiumAmount ?? 0,
            PaymentFrequency: e.PaymentFrequency ?? 'Monthly'
          }))
        );
      }
    } catch (err) {
      console.error('Failed to load member for modal', err);
      setError('Failed to load member details');
    } finally {
      setMemberModalLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || activeTab !== 'Vendor Payouts') return;
    const preview = previews.get('Vendor Payouts');
    if (!preview?.payoutBreakdown?.length) return;
    const vendorRows = preview.payoutBreakdown.filter((p) => p.entityType === 'Vendor');
    const uniqueIds = [...new Set(vendorRows.map((p) => String(p.entityId)))];
    let cancelled = false;
    void (async () => {
      await Promise.all(
        uniqueIds.map(async (vid) => {
          const row = vendorRows.find((p) => String(p.entityId) === vid);
          if (!row) return;
          const { includedInvoiceIds, includedPaymentIds } = buildNachaPreviewIncludedAnchors(
            row,
            excludedPaymentIds,
            excludedInvoiceIds
          );
          const key = vid.toUpperCase();
          if (!cancelled) {
            setVendorNachaOmittedByVendorId((prev) => ({
              ...prev,
              [key]: { ...(prev[key] || { count: 0, totalVendorShare: 0, rows: [] }), loading: true },
            }));
          }
          try {
            const res = await getVendorNachaPreviewGap({
              vendorId: vid,
              startDate,
              endDate,
              includedInvoiceIds,
              includedPaymentIds,
            });
            if (cancelled) return;
            if (res.success && res.data) {
              const payload = res.data;
              setVendorNachaOmittedByVendorId((prev) => ({
                ...prev,
                [key]: {
                  count: payload.count,
                  totalVendorShare: payload.totalVendorShare,
                  rows: payload.rows || [],
                  loading: false,
                },
              }));
            } else {
              setVendorNachaOmittedByVendorId((prev) => ({
                ...prev,
                [key]: { count: 0, totalVendorShare: 0, rows: [], loading: false },
              }));
            }
          } catch {
            if (!cancelled) {
              setVendorNachaOmittedByVendorId((prev) => ({
                ...prev,
                [key]: { count: 0, totalVendorShare: 0, rows: [], loading: false },
              }));
            }
          }
        })
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeTab, startDate, endDate, nachaPreviewExclusionKey, previews]);

  // ACH details modal state
  const [showACHDetails, setShowACHDetails] = useState(false);
  const [achDetails, setAchDetails] = useState<{
    isSplit: boolean;
    totalDistribution: number;
    accounts: Array<{
      achAccountId: string;
      accountHolderName: string;
      bankName: string;
      accountType: string;
      routingNumber: string;
      accountNumber: string;
      accountNumberLast4?: string;
      distributionPercentage: number;
      isDefault: boolean;
      verificationStatus: string;
      status: string;
    }>;
    accountSource: 'ACHAccounts' | 'ProductOverrideACH';
  } | null>(null);
  const [achDetailsLoading, setAchDetailsLoading] = useState(false);
  const [achDetailsError, setAchDetailsError] = useState<string | null>(null);

  // Helper function to build product breakdown from payment JSON data
  // For Tenant entity type, filters products to only those owned by the viewing tenant
  const buildProductBreakdown = async (payment: any, entityType: string, viewingEntityId?: string): Promise<Array<{
    productId: string;
    productName: string;
    enrolledHouseholdsCount: number;
    totalCost: number;
    payoutAmount: number;
  }>> => {
    const breakdown: Array<{
      productId: string;
      productName: string;
      enrolledHouseholdsCount: number;
      totalCost: number;
      payoutAmount: number;
    }> = [];

    try {
      let productData: any = null;
      
      // Determine which JSON to use based on entity type
      if (entityType === 'Agent' || entityType === 'Agency') {
        // For agents/agencies, use ProductCommissions
        if (payment.productCommissions) {
          productData = typeof payment.productCommissions === 'string' 
            ? JSON.parse(payment.productCommissions) 
            : payment.productCommissions;
        }
      } else if (entityType === 'Vendor') {
        // For vendors, use ProductVendorAmounts
        if (payment.productVendorAmounts) {
          productData = typeof payment.productVendorAmounts === 'string' 
            ? JSON.parse(payment.productVendorAmounts) 
            : payment.productVendorAmounts;
        }
      } else if (entityType === 'Tenant') {
        // For product owners, use ProductOwnerAmounts
        if (payment.productOwnerAmounts) {
          productData = typeof payment.productOwnerAmounts === 'string' 
            ? JSON.parse(payment.productOwnerAmounts) 
            : payment.productOwnerAmounts;
          
          // Debug logging for Tenant entity type
          console.log('🔍 ProductOwnerAmounts for Tenant:', {
            isString: typeof payment.productOwnerAmounts === 'string',
            isArray: Array.isArray(productData),
            isObject: typeof productData === 'object' && !Array.isArray(productData),
            sampleEntry: Array.isArray(productData) ? productData[0] : (typeof productData === 'object' ? Object.values(productData)[0] : null),
            keys: Array.isArray(productData) ? Object.keys(productData[0] || {}) : (typeof productData === 'object' ? Object.keys(Object.values(productData)[0] || {}) : [])
          });
        }
      }

      if (!productData) {
        console.warn('No productData found for entity type:', entityType);
        return breakdown;
      }

      // Handle both object and array formats
      const products = Array.isArray(productData) 
        ? productData.reduce((acc: any, item: any) => {
            if (item && item.ProductId) {
              // Normalize field names - ensure enrolledHouseholdsCount is set correctly
              acc[item.ProductId.toString().toUpperCase()] = {
                ...item,
                enrolledHouseholdsCount: item.enrolledHouseholdsCount !== undefined 
                  ? item.enrolledHouseholdsCount 
                  : (item.EnrolledHouseholdsCount !== undefined ? item.EnrolledHouseholdsCount : 0)
              };
            }
            return acc;
          }, {})
        : productData;

      // Calculate total payment amount for cost calculation
      const totalPaymentAmount = payment.paymentAmount || 0;
      void totalPaymentAmount;
      
      // For cost calculation, we need to sum up all the product-specific amounts
      // (commission, vendor amount, override amount) to determine the cost per product
      // This is more accurate than proportionally distributing the total payment
      const productAmountsMap = new Map<string, number>(); // productId -> total amount
      
      // Collect all product-specific amounts from different JSON fields
      // This will give us a more accurate picture of each product's cost
      if (payment.productCommissions) {
        try {
          const commissions = typeof payment.productCommissions === 'string' 
            ? JSON.parse(payment.productCommissions) 
            : payment.productCommissions;
          const commissionsObj = Array.isArray(commissions) 
            ? commissions.reduce((acc: any, item: any) => {
                if (item && item.ProductId) {
                  acc[item.ProductId.toString().toUpperCase()] = item;
                }
                return acc;
              }, {})
            : commissions;
          
          for (const [productId, data] of Object.entries(commissionsObj)) {
            const productInfo = data as any;
            const current = productAmountsMap.get(productId.toUpperCase()) || 0;
            productAmountsMap.set(productId.toUpperCase(), current + (parseFloat(productInfo.commissionAmount) || 0));
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      
      if (payment.productVendorAmounts) {
        try {
          const vendorAmounts = typeof payment.productVendorAmounts === 'string' 
            ? JSON.parse(payment.productVendorAmounts) 
            : payment.productVendorAmounts;
          const vendorAmountsObj = Array.isArray(vendorAmounts) 
            ? vendorAmounts.reduce((acc: any, item: any) => {
                if (item && item.ProductId) {
                  acc[item.ProductId.toString().toUpperCase()] = item;
                }
                return acc;
              }, {})
            : vendorAmounts;
          
          for (const [productId, data] of Object.entries(vendorAmountsObj)) {
            const productInfo = data as any;
            const current = productAmountsMap.get(productId.toUpperCase()) || 0;
            productAmountsMap.set(productId.toUpperCase(), current + (parseFloat(productInfo.vendorAmount) || 0));
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      
      if (payment.productOwnerAmounts) {
        try {
          const ownerAmounts = typeof payment.productOwnerAmounts === 'string' 
            ? JSON.parse(payment.productOwnerAmounts) 
            : payment.productOwnerAmounts;
          const ownerAmountsObj = Array.isArray(ownerAmounts) 
            ? ownerAmounts.reduce((acc: any, item: any) => {
                if (item && item.ProductId) {
                  acc[item.ProductId.toString().toUpperCase()] = {
                    ...item,
                    enrolledHouseholdsCount: item.enrolledHouseholdsCount !== undefined 
                      ? item.enrolledHouseholdsCount 
                      : (item.EnrolledHouseholdsCount !== undefined ? item.EnrolledHouseholdsCount : 0)
                  };
                }
                return acc;
              }, {})
            : ownerAmounts;
          
          for (const [productId, data] of Object.entries(ownerAmountsObj)) {
            const productInfo = data as any;
            const current = productAmountsMap.get(productId.toUpperCase()) || 0;
            productAmountsMap.set(productId.toUpperCase(), current + (parseFloat(productInfo.overrideAmount) || 0));
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      
      // Calculate total of all product-specific amounts for proportion calculation
      const totalProductAmounts = Array.from(productAmountsMap.values()).reduce((sum, amount) => sum + amount, 0);
      void totalProductAmounts;
      
      // Get total enrolled households to calculate per-product cost proportionally
      let totalHouseholds = 0;
      Object.values(products).forEach((prod: any) => {
        if (prod.enrolledHouseholdsCount === undefined) {
          console.warn('Missing enrolledHouseholdsCount in product data', { product: prod });
        }
        const householdsCount = prod.enrolledHouseholdsCount !== undefined ? prod.enrolledHouseholdsCount : 0;
        totalHouseholds += householdsCount;
      });

      // For Tenant entity type, filter products to only those owned by the viewing tenant
      // For Vendor entity type, filter products to only those belonging to the viewing vendor
      // Also filter out bundles for all entity types (bundles shouldn't have enrollments)
      let productsToInclude = Object.entries(products);
      if ((entityType === 'Tenant' || entityType === 'Vendor') && viewingEntityId) {
        // Fetch product ownership/vendor info via batch API to filter
        const productIds = Object.keys(products);
        if (productIds.length > 0) {
          const matchingProductIds = new Set<string>(); // Products owned by tenant or belonging to vendor
          const bundleProductIds = new Set<string>();
          
          // Fetch product info in batch to check ownership/vendor and bundle status
          try {
            const response = await apiService.post<{ 
              success: boolean; 
              products?: Array<{ 
                ProductId: string; 
                ProductOwnerId?: string; 
                VendorId?: string;
                IsBundle?: boolean 
              }> 
            }>('/api/products/batch', {
              productIds
            });
            
            if (response.success && response.products && Array.isArray(response.products)) {
              for (const product of response.products) {
                if (product && product.ProductId) {
                  const productIdUpper = product.ProductId.toString().toUpperCase();
                  
                  // Check if matches viewing entity
                  if (entityType === 'Tenant') {
                    // Check if owned by viewing tenant
                    if (product.ProductOwnerId && product.ProductOwnerId.toUpperCase() === viewingEntityId.toUpperCase()) {
                      matchingProductIds.add(productIdUpper);
                    }
                  } else if (entityType === 'Vendor') {
                    // Check if belongs to viewing vendor
                    if (product.VendorId && product.VendorId.toUpperCase() === viewingEntityId.toUpperCase()) {
                      matchingProductIds.add(productIdUpper);
                    }
                  }
                  
                  // Track bundles to filter them out
                  const isBundle = product.IsBundle === true || (product.IsBundle as any) === 1 || !!product.IsBundle;
                  if (isBundle) {
                    bundleProductIds.add(productIdUpper);
                  }
                }
              }
            }
          } catch (error) {
            console.warn(`Failed to fetch product ownership/vendor batch:`, error);
          }
          
          // Filter to only products matching this entity AND not bundles
          productsToInclude = productsToInclude.filter(([productIdStr]) => {
            const productIdUpper = productIdStr.toUpperCase();
            const isMatching = matchingProductIds.has(productIdUpper);
            const isBundle = bundleProductIds.has(productIdUpper);
            if (isBundle) {
              console.warn(`⚠️ Filtering out bundle product from breakdown: ${productIdStr}`);
            }
            return isMatching && !isBundle;
          });
        }
      } else {
        // For non-tenant/vendor entity types, still filter out bundles
        const productIds = Object.keys(products);
        if (productIds.length > 0) {
          const bundleProductIds = new Set<string>();
          
          // Fetch product info in batch to check bundle status
          try {
            const response = await apiService.post<{ success: boolean; products?: Array<{ ProductId: string; IsBundle?: boolean }> }>('/api/products/batch', {
              productIds
            });
            
            if (response.success && response.products && Array.isArray(response.products)) {
              for (const product of response.products) {
                const isBundle = product && (product.IsBundle === true || (product.IsBundle as any) === 1 || !!product.IsBundle);
                if (product && product.ProductId && isBundle) {
                  bundleProductIds.add(product.ProductId.toString().toUpperCase());
                }
              }
            }
          } catch (error) {
            console.warn(`Failed to fetch product bundle status:`, error);
          }
          
          // Filter out bundles
          productsToInclude = productsToInclude.filter(([productIdStr]) => {
            const isBundle = bundleProductIds.has(productIdStr.toUpperCase());
            if (isBundle) {
              console.warn(`⚠️ Filtering out bundle product from breakdown: ${productIdStr}`);
            }
            return !isBundle;
          });
        }
      }
      
      // For Agent/Agency: Calculate the agent's/agency's total commission for this payment
      // IMPORTANT: Only include products that have commission rules applied to them
      // We need to get the ruleIds from the payment and check which products those rules apply to
      let agentTotalCommission = 0;
      let totalCommissionPool = 0;
      let ruleProductIds = new Set<string>(); // Products that have commission rules applied
      
      if (entityType === 'Agent' || entityType === 'Agency') {
        // For agents, use commissionAmount; for agencies, use overflowAmount (or commissionAmount as fallback)
        agentTotalCommission = entityType === 'Agency' 
          ? ((payment as any).overflowAmount || payment.commissionAmount || 0)
          : (payment.commissionAmount || 0);
        
        // Get ruleIds from payment to determine which products had rules applied
        const ruleIds: string[] = [];
        if (payment.ruleIds && Array.isArray(payment.ruleIds)) {
          ruleIds.push(...payment.ruleIds);
        }
        if (payment.ruleId && !ruleIds.includes(payment.ruleId)) {
          ruleIds.push(payment.ruleId);
        }
        
        // Fetch rules to get their ProductIds
        if (ruleIds.length > 0) {
          try {
            const rulesResponse = await commissionService.getCommissionRulesBatch(ruleIds);
            if (rulesResponse.success && rulesResponse.rules && Array.isArray(rulesResponse.rules)) {
              // Collect ProductIds from rules (excluding "All Products" placeholder)
              rulesResponse.rules.forEach((rule: any) => {
                if (rule.ProductId && rule.ProductId !== '00000000-0000-0000-0000-000000000000') {
                  ruleProductIds.add(rule.ProductId.toString().toUpperCase());
                }
              });
            }
          } catch (error) {
            console.warn('Error fetching rules to filter products:', error);
            // If we can't fetch rules, don't filter - show all products (fallback behavior)
          }
        }
        
        // Filter productsToInclude to only products that have commission rules applied
        // If no rules were found, don't filter (show all products as fallback)
        if (ruleProductIds.size > 0) {
          productsToInclude = productsToInclude.filter(([productIdStr]) => {
            return ruleProductIds.has(productIdStr.toUpperCase());
          });
        }
        
        // Calculate total commission pool from ProductCommissions (only for products with rules)
        for (const [, data] of productsToInclude) {
          const productInfo = data as any;
          totalCommissionPool += (parseFloat(productInfo.commissionAmount) || 0);
        }
      }
      
      // Build breakdown
      for (const [productId, data] of productsToInclude) {
        const productInfo = data as any;
        
        // Debug logging for Tenant entity type to diagnose household count issue
        if (entityType === 'Tenant') {
          console.log('🔍 Building breakdown for Tenant product:', {
            productId,
            productInfo,
            hasEnrolledHouseholdsCount: productInfo.enrolledHouseholdsCount !== undefined,
            enrolledHouseholdsCount: productInfo.enrolledHouseholdsCount,
            hasEnrollmentCount: productInfo.enrollmentCount !== undefined,
            enrollmentCount: productInfo.enrollmentCount,
            allKeys: Object.keys(productInfo)
          });
        }
        
        // Handle both enrolledHouseholdsCount (new) and enrollmentCount (old) field names
        // Also check for capitalized versions (EnrolledHouseholdsCount, EnrollmentCount)
        let enrolledHouseholdsCount = 0;
        if (productInfo.enrolledHouseholdsCount !== undefined) {
          enrolledHouseholdsCount = productInfo.enrolledHouseholdsCount;
        } else if (productInfo.EnrolledHouseholdsCount !== undefined) {
          enrolledHouseholdsCount = productInfo.EnrolledHouseholdsCount;
        } else if (productInfo.enrollmentCount !== undefined) {
          // Fallback to old field name (from backfill script)
          enrolledHouseholdsCount = productInfo.enrollmentCount;
        } else if (productInfo.EnrollmentCount !== undefined) {
          // Fallback to old capitalized field name
          enrolledHouseholdsCount = productInfo.EnrollmentCount;
        } else {
          console.warn('Missing enrolledHouseholdsCount/enrollmentCount in product breakdown data', { 
            productId, 
            productInfo,
            entityType,
            allKeys: Object.keys(productInfo || {})
          });
        }
        
        // Calculate payout amount based on entity type
        let payoutAmount = 0;
        if (entityType === 'Agent' || entityType === 'Agency') {
          // For agents/agencies, proportionally distribute their total commission across products
          // that have commission rules applied, based on each product's share of the total commission pool
          const productCommissionPool = parseFloat(productInfo.commissionAmount) || 0;
          if (totalCommissionPool > 0 && agentTotalCommission > 0) {
            // Calculate this product's share of the commission pool
            const productShare = productCommissionPool / totalCommissionPool;
            // Agent's commission from this product = agent's total commission * product's share
            payoutAmount = agentTotalCommission * productShare;
          } else {
            // Fallback: if no commission pool or agent commission, use 0
            payoutAmount = 0;
          }
        } else if (entityType === 'Vendor') {
          // For vendors, use vendorAmount from ProductVendorAmounts
          payoutAmount = productInfo.vendorAmount || 0;
        } else if (entityType === 'Tenant') {
          // For product owners, use overrideAmount from ProductOwnerAmounts
          payoutAmount = productInfo.overrideAmount || 0;
        }

        // Calculate total cost for this product
        // Total cost = sum of all amounts associated with this product:
        // - Commission (from ProductCommissions)
        // - Vendor amount (NetRate from ProductVendorAmounts)
        // - Override amount (OverrideRate from ProductOwnerAmounts)
        const productSpecificAmount = productAmountsMap.get(productId.toUpperCase()) || 0;
        
        // If we have product-specific amounts, use them directly
        // Otherwise, we can't accurately calculate the cost (would need more data)
        const totalCost = productSpecificAmount > 0 
          ? productSpecificAmount 
          : 0; // Don't guess - return 0 if we don't have the data

        breakdown.push({
          productId: productId.toUpperCase(),
          productName: `Product ${productId.substring(0, 8)}...`, // Placeholder - will fetch real name
          enrolledHouseholdsCount,
          totalCost,
          payoutAmount
        });
      }
    } catch (error) {
      console.error('Error building product breakdown:', error);
    }

    return breakdown;
  };

  // Helper function to calculate total households from payment
  // Uses uniqueHouseholdCount from backend if available, otherwise falls back to summing JSON counts
  const calculateTotalHouseholds = (payment: any, entityType: string): number => {
    // Use unique household count from backend if available (this is the correct count)
    if (payment.uniqueHouseholdCount !== undefined && payment.uniqueHouseholdCount !== null) {
      return payment.uniqueHouseholdCount;
    }
    
    // Fallback to old method (summing across products) for backwards compatibility
    // This is incorrect for payments with multiple products but kept for legacy data
    try {
      let productData: any = null;
      
      // Determine which JSON to use based on entity type
      if (entityType === 'Agent' || entityType === 'Agency') {
        if (payment.productCommissions) {
          productData = typeof payment.productCommissions === 'string' 
            ? JSON.parse(payment.productCommissions) 
            : payment.productCommissions;
        }
      } else if (entityType === 'Vendor') {
        if (payment.productVendorAmounts) {
          productData = typeof payment.productVendorAmounts === 'string' 
            ? JSON.parse(payment.productVendorAmounts) 
            : payment.productVendorAmounts;
        }
      } else if (entityType === 'Tenant') {
        if (payment.productOwnerAmounts) {
          productData = typeof payment.productOwnerAmounts === 'string' 
            ? JSON.parse(payment.productOwnerAmounts) 
            : payment.productOwnerAmounts;
        }
      }

      if (!productData) return 0;

      // Handle both object and array formats
      const products = Array.isArray(productData) 
        ? productData.reduce((acc: any, item: any) => {
            if (item && item.ProductId) {
              acc[item.ProductId.toString().toUpperCase()] = {
                ...item,
                enrolledHouseholdsCount: item.enrolledHouseholdsCount !== undefined 
                  ? item.enrolledHouseholdsCount 
                  : (item.EnrolledHouseholdsCount !== undefined ? item.EnrolledHouseholdsCount : (item.enrollmentCount !== undefined ? item.enrollmentCount : (item.EnrollmentCount !== undefined ? item.EnrollmentCount : 0)))
              };
            }
            return acc;
          }, {})
        : productData;

      // Sum up household counts across all products (legacy method - incorrect for multi-product payments)
      let totalHouseholds = 0;
      for (const [, data] of Object.entries(products)) {
        const productInfo = data as any;
        const households = productInfo.enrolledHouseholdsCount !== undefined 
          ? productInfo.enrolledHouseholdsCount 
          : (productInfo.EnrolledHouseholdsCount !== undefined ? productInfo.EnrolledHouseholdsCount : (productInfo.enrollmentCount !== undefined ? productInfo.enrollmentCount : (productInfo.EnrollmentCount !== undefined ? productInfo.EnrollmentCount : 0)));
        totalHouseholds += households || 0;
      }
      
      return totalHouseholds;
    } catch (error) {
      console.error('Error calculating total households:', error);
      return 0;
    }
  };

  // Handler for clicking household count from product breakdown to show household details for a specific product
  const handleHouseholdDetailsClick = async (productId: string, paymentId: string, page: number = 1) => {
    if (!selectedRecipient) return;
    
    setHouseholdDetailsLoading(true);
    setShowHouseholdDetails(true);
    
    try {
      const params = new URLSearchParams({
        entityType: selectedRecipient.entityType,
        entityId: selectedRecipient.entityId,
        page: page.toString(),
        limit: '50'
      });
      
      const response = await apiService.get<{
        success: boolean;
        households: Array<{
          householdId: string;
          householdName: string;
          householdTier: string | null;
          enrollmentCount: number;
          householdPayment: number;
          entityPayout: number;
          systemFees?: number;
          processingFees?: number;
          totalFees?: number;
          configValue?: string | null;
        }>;
        configFieldName?: string | null;
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      }>(`/api/accounting/nacha/payment/${paymentId}/product/${productId}/households?${params.toString()}`);
      
      if (response.success) {
        // Map households to include ageBand property (default to null if not provided)
        const householdsWithAgeBand = (response.households || []).map((household: any) => ({
          ...household,
          ageBand: household.ageBand ?? null,
          configValue: household.configValue ?? null
        }));
        setHouseholdDetails(householdsWithAgeBand);
        setHouseholdDetailsPagination(response.pagination || { page: 1, limit: 50, total: 0, totalPages: 0 });
        setHouseholdConfigFieldName(response.configFieldName || null);
        // Set filtered product ID
        setFilteredProductId(productId);
      } else {
        console.error('Failed to fetch household details:', response);
        setHouseholdDetails([]);
      }
    } catch (error) {
      console.error('Error fetching household details:', error);
      setHouseholdDetails([]);
    } finally {
      setHouseholdDetailsLoading(false);
    }
  };

  // Helper function to get ALL product IDs from a payment (not filtered by entity)
  const getAllProductIdsFromPayment = (payment: any): string[] => {
    const productIds = new Set<string>();
    
    // Check all product JSON fields to get all products
    const fieldsToCheck = [
      payment.productCommissions,
      payment.productVendorAmounts,
      payment.productOwnerAmounts
    ];
    
    fieldsToCheck.forEach(field => {
      if (!field) return;
      
      try {
        const data = typeof field === 'string' ? JSON.parse(field) : field;
        const products = Array.isArray(data) ? data : Object.values(data || {});
        
        products.forEach((item: any) => {
          if (item && item.ProductId) {
            productIds.add(item.ProductId.toString().toUpperCase());
          } else if (item && typeof item === 'object') {
            // Try to find ProductId in nested structure
            Object.values(item).forEach((val: any) => {
              if (val && val.ProductId) {
                productIds.add(val.ProductId.toString().toUpperCase());
              }
            });
          }
        });
      } catch (e) {
        // Ignore parse errors
      }
    });
    
    return Array.from(productIds);
  };

  // Handler for clicking household count from payment details to show all households for the payment
  const handlePaymentHouseholdsClick = async (payment: any, page: number = 1) => {
    if (!selectedRecipient) return;
    
    // Get ALL product IDs from payment (not filtered by vendor/entity)
    const allProductIds = getAllProductIdsFromPayment(payment);
    
    if (allProductIds.length === 0) {
      return; // No products, can't show households
    }

    // Get product breakdown for the entity (filtered) - needed for fallback and single product check
    const breakdown = await buildProductBreakdown(payment, selectedRecipient.entityType, selectedRecipient.entityId);

    // Fetch vendor information for ALL products to populate filter dropdown
    try {
      const productIds = allProductIds;
      const productsResponse = await apiService.post<{ 
        success: boolean; 
        products?: Array<{ 
          ProductId: string; 
          Name: string; 
          VendorId?: string;
          VendorName?: string;
        }> 
      }>('/api/products/batch', { productIds });
      
      if (productsResponse.success && productsResponse.products) {
        // Build products list with vendor names (VendorName should be included from batch endpoint)
        const productsWithVendors = productsResponse.products.map(p => ({
          productId: p.ProductId,
          productName: p.Name || p.ProductId, // Use Name, fallback to ProductId if Name is missing
          vendorName: p.VendorName || (p.VendorId ? 'Unknown Vendor' : 'No Vendor')
        }));
        
        setAvailableProductsForFilter(productsWithVendors);
      } else {
        // If products batch fails, try to fetch product names individually
        console.warn('Products batch response not successful, fetching individually');
        try {
          const individualProducts = await Promise.all(
            breakdown.map(async (p) => {
              try {
                const productResponse = await apiService.post<{ 
                  success: boolean; 
                  products?: Array<{ 
                    ProductId: string; 
                    Name: string; 
                    VendorId?: string;
                    VendorName?: string;
                  }> 
                }>('/api/products/batch', { productIds: [p.productId] });
                
                if (productResponse.success && productResponse.products && productResponse.products.length > 0) {
                  const prod = productResponse.products[0];
                  return {
                    productId: prod.ProductId,
                    productName: prod.Name || prod.ProductId,
                    vendorName: prod.VendorName || (prod.VendorId ? 'Unknown Vendor' : 'No Vendor')
                  };
                }
              } catch (err) {
                console.error(`Error fetching product ${p.productId}:`, err);
              }
              // Fallback if individual fetch fails
              return {
                productId: p.productId,
                productName: p.productName || p.productId,
                vendorName: 'Unknown Vendor'
              };
            })
          );
          setAvailableProductsForFilter(individualProducts);
        } catch (error) {
          console.error('Error fetching product/vendor info individually:', error);
          // Final fallback - use breakdown data
          setAvailableProductsForFilter(breakdown.map(p => ({
            productId: p.productId,
            productName: p.productName || p.productId,
            vendorName: 'Unknown Vendor'
          })));
        }
      }
    } catch (error) {
      console.error('Error fetching product/vendor info for filter:', error);
      // Final fallback - use breakdown data
      setAvailableProductsForFilter(breakdown.map(p => ({
        productId: p.productId,
        productName: p.productName || p.productId,
        vendorName: 'Unknown Vendor'
      })));
    }
    
    // Store payment object for pagination and filter
    setCurrentPaymentForHouseholds(payment);
    
    // If breakdown is empty, we still want to show households for all products
    // This can happen for Agent/Agency views where productCommissions might be empty
    // but households still exist in the payment
    if (breakdown.length === 0) {
      // No products in breakdown, but we have product IDs from payment
      // Show all products and set filter to 'ALL'
      setFilteredProductId('ALL');
      setSelectedProductForHouseholds({
        productId: 'ALL',
        productName: `All Products (${allProductIds.length} products)`,
        paymentId: payment.paymentId || ''
      });
    } else if (breakdown.length === 1) {
      // If only one product in breakdown, open household details directly for that product
      // But still show filter dropdown with all products
      setSelectedProductForHouseholds({
        productId: breakdown[0].productId,
        productName: breakdown[0].productName,
        paymentId: payment.paymentId || ''
      });
      setFilteredProductId(breakdown[0].productId);
      await handleHouseholdDetailsClick(breakdown[0].productId, payment.paymentId || '', page);
      return;
    } else {
      // Multiple products in breakdown
      setFilteredProductId('ALL');
      setSelectedProductForHouseholds({
        productId: 'ALL',
        productName: `All Products (${breakdown.length} products)`,
        paymentId: payment.paymentId || ''
      });
    }

    // Fetch households for ALL products (not just breakdown) when "ALL" is selected
    // But if a specific product is selected, only fetch for that product
    setHouseholdDetailsLoading(true);
    setShowHouseholdDetails(true);
    
    try {
      // When "ALL" is selected, use ALL product IDs, not just the filtered breakdown
      // This ensures we show households from all products in the payment, not just the entity's products
      // When a specific product is selected, use that product ID
      // Ensure filteredProductId is set - default to 'ALL' if not set
      const currentFilteredProductId = filteredProductId || 'ALL';
      const productsToFetch = currentFilteredProductId === 'ALL' ? allProductIds : [currentFilteredProductId];
      
      // Fetch households for all products in parallel
      const householdPromises = productsToFetch.map(productId => {
        const params = new URLSearchParams({
          entityType: selectedRecipient.entityType,
          entityId: selectedRecipient.entityId,
          page: '1',
          limit: '1000' // Get all households for each product
        });
        
        return apiService.get<{
          success: boolean;
          households: Array<{
            householdId: string;
            householdName: string;
            householdTier: string | null;
            enrollmentCount: number;
            householdPayment: number;
            entityPayout: number;
          }>;
          pagination: {
            page: number;
            limit: number;
            total: number;
            totalPages: number;
          };
        }>(`/api/accounting/nacha/payment/${payment.paymentId}/product/${productId}/households?${params.toString()}`);
      });
      
      const responses = await Promise.all(householdPromises);
      
      // Aggregate all households from all products
      const allHouseholds: Map<string, {
        householdId: string;
        householdName: string;
        householdTier: string | null;
        enrollmentCount: number;
        householdPayment: number;
        entityPayout: number;
      }> = new Map();
      
      responses.forEach((response, index) => {
        if (response.success && response.households) {
          response.households.forEach(household => {
            const existing = allHouseholds.get(household.householdId);
            if (existing) {
              // Aggregate amounts if household appears in multiple products
              existing.householdPayment += household.householdPayment;
              existing.entityPayout += household.entityPayout;
              existing.enrollmentCount += household.enrollmentCount;
            } else {
              allHouseholds.set(household.householdId, { ...household });
            }
          });
        } else {
          console.error(`Failed to fetch households for product ${productsToFetch[index]}:`, response);
        }
      });
      
      // Convert map to array and sort by household name
      const aggregatedHouseholds = Array.from(allHouseholds.values()).sort((a, b) => 
        a.householdName.localeCompare(b.householdName)
      );
      
      // Paginate the aggregated results
      const limit = 50;
      const offset = (page - 1) * limit;
      const paginatedHouseholds = aggregatedHouseholds.slice(offset, offset + limit).map((household: any) => ({
        ...household,
        ageBand: household.ageBand ?? null
      }));
      
      setHouseholdDetails(paginatedHouseholds);
      setHouseholdDetailsPagination({
        page,
        limit,
        total: aggregatedHouseholds.length,
        totalPages: Math.ceil(aggregatedHouseholds.length / limit)
      });
      
      // Selected product info should already be set above, but ensure it's correct as fallback
      if (!selectedProductForHouseholds || !selectedProductForHouseholds.productId) {
        setSelectedProductForHouseholds({
          productId: breakdown.length === 1 ? breakdown[0].productId : 'ALL',
          productName: breakdown.length === 1 ? breakdown[0].productName : `All Products (${breakdown.length || allProductIds.length} products)`,
          paymentId: payment.paymentId || ''
        });
        setFilteredProductId(breakdown.length === 1 ? breakdown[0].productId : 'ALL');
      }
      
      // Fetch vendor information for ALL products (not just breakdown) to populate filter dropdown
      try {
        const productIds = allProductIds; // Use all products, not just filtered breakdown
        const productsResponse = await apiService.post<{ 
          success: boolean; 
          products?: Array<{ 
            ProductId: string; 
            Name: string; 
            VendorId?: string;
            VendorName?: string;
          }> 
        }>('/api/products/batch', { productIds });
        
        if (productsResponse.success && productsResponse.products) {
          // Fetch vendor names for products that have VendorId
          const vendorIds = new Set<string>();
          productsResponse.products.forEach(p => {
            if (p.VendorId) vendorIds.add(p.VendorId);
          });
          
          const vendorsMap = new Map<string, string>();
          if (vendorIds.size > 0) {
            const vendorIdsArray = Array.from(vendorIds);
            const vendorsResponse = await apiService.post<{
              success: boolean;
              vendors?: Array<{ VendorId: string; Name: string }>;
            }>('/api/vendors/batch', { vendorIds: vendorIdsArray });
            
            if (vendorsResponse.success && vendorsResponse.vendors) {
              vendorsResponse.vendors.forEach(v => {
                vendorsMap.set(v.VendorId, v.Name);
              });
            }
          }
          
          // Build products list with vendor names
          const productsWithVendors = productsResponse.products.map(p => ({
            productId: p.ProductId,
            productName: p.Name || p.ProductId, // Use Name, fallback to ProductId if Name is missing
            vendorName: p.VendorName || (p.VendorId ? vendorsMap.get(p.VendorId) || 'Unknown Vendor' : 'No Vendor')
          }));
          
          setAvailableProductsForFilter(productsWithVendors);
          setFilteredProductId('ALL'); // Reset filter to "All Products"
        } else {
          // If products batch fails, try to fetch product names individually
          console.warn('Products batch response not successful, fetching individually');
          try {
            const individualProducts = await Promise.all(
              breakdown.map(async (p) => {
                try {
                  const productResponse = await apiService.post<{ 
                    success: boolean; 
                    products?: Array<{ 
                      ProductId: string; 
                      Name: string; 
                      VendorId?: string;
                      VendorName?: string;
                    }> 
                  }>('/api/products/batch', { productIds: [p.productId] });
                  
                  if (productResponse.success && productResponse.products && productResponse.products.length > 0) {
                    const prod = productResponse.products[0];
                    return {
                      productId: prod.ProductId,
                      productName: prod.Name || prod.ProductId,
                      vendorName: prod.VendorName || (prod.VendorId ? 'Unknown Vendor' : 'No Vendor')
                    };
                  }
                } catch (err) {
                  console.error(`Error fetching product ${p.productId}:`, err);
                }
                // Fallback if individual fetch fails
                return {
                  productId: p.productId,
                  productName: p.productName || p.productId,
                  vendorName: 'Unknown Vendor'
                };
              })
            );
            setAvailableProductsForFilter(individualProducts);
            setFilteredProductId('ALL');
          } catch (error) {
            console.error('Error fetching product/vendor info individually:', error);
            // Final fallback - use breakdown data
            setAvailableProductsForFilter(breakdown.map(p => ({
              productId: p.productId,
              productName: p.productName || p.productId,
              vendorName: 'Unknown Vendor'
            })));
            setFilteredProductId('ALL');
          }
        }
      } catch (error) {
        console.error('Error fetching product/vendor info for filter:', error);
        // Final fallback - use breakdown data
        setAvailableProductsForFilter(breakdown.map(p => ({
          productId: p.productId,
          productName: p.productName || p.productId,
          vendorName: 'Unknown Vendor'
        })));
        setFilteredProductId('ALL');
      }
    } catch (error) {
      console.error('Error fetching household details for payment:', error);
      setHouseholdDetails([]);
    } finally {
      setHouseholdDetailsLoading(false);
    }
  };

  // Helper function to fetch product names for breakdown (batch request)
  // Returns both product names and bundle flags
  const fetchProductNames = async (productIds: string[]): Promise<{ names: Map<string, string>; bundleFlags: Map<string, boolean> }> => {
    const productNamesMap = new Map<string, string>();
    const bundleFlagsMap = new Map<string, boolean>();
    
    if (productIds.length === 0) {
      return { names: productNamesMap, bundleFlags: bundleFlagsMap };
    }
    
    // Fetch product names in batch using /api/products/batch endpoint
    try {
      const response = await apiService.post<{ success: boolean; products?: Array<{ ProductId: string; Name: string; IsBundle?: boolean }> }>('/api/products/batch', {
        productIds
      });
      
      if (response.success && response.products && Array.isArray(response.products)) {
        for (const product of response.products) {
          if (product && product.ProductId) {
            const productIdUpper = product.ProductId.toString().toUpperCase();
            if (product.Name) {
              productNamesMap.set(productIdUpper, product.Name);
            }
            // Store bundle flag (default to false if not provided)
            const isBundle = product.IsBundle === true || (product.IsBundle as any) === 1 || !!product.IsBundle;
            bundleFlagsMap.set(productIdUpper, isBundle);
          }
        }
        console.log(`✅ Fetched ${response.products.length} product names in batch`);
      } else {
        console.warn(`Unexpected batch response structure:`, response);
      }
    } catch (error) {
      console.error(`❌ Failed to fetch products batch:`, error);
    }
    
    // Fill in any missing product names with placeholders
    for (const productId of productIds) {
      const productIdUpper = productId.toUpperCase();
      if (!productNamesMap.has(productIdUpper)) {
        productNamesMap.set(productIdUpper, `Product ${productId.substring(0, 8)}...`);
      }
      // Default to false for bundle flag if not found
      if (!bundleFlagsMap.has(productIdUpper)) {
        bundleFlagsMap.set(productIdUpper, false);
      }
    }
    
    return { names: productNamesMap, bundleFlags: bundleFlagsMap };
  };

  // Helper function to handle product breakdown click
  const handleProductBreakdownClick = async (payment: any) => {
    // Vendor: use backend per-payment per-vendor breakdown (source of truth for reconciliation)
    if (selectedRecipient?.entityType === 'Vendor' && selectedRecipient?.entityId) {
      try {
        const response = await apiService.get<{
          success: boolean;
          products?: Array<{
            productId: string;
            productName: string;
            householdsCount: number;
            vendorPayoutAmount: number;
          }>;
        }>(`/api/accounting/nacha/payment/${payment.paymentId}/vendor/${selectedRecipient.entityId}/product-breakdown`);

        const products = response.success && Array.isArray(response.products) ? response.products : [];
        if (products.length === 0) return;

        setProductBreakdown(
          products.map((p) => ({
            productId: (p.productId || '').toUpperCase(),
            productName: p.productName,
            enrolledHouseholdsCount: Number(p.householdsCount || 0),
            totalCost: 0,
            payoutAmount: Number(p.vendorPayoutAmount || 0),
            isVendorProduct: true
          }))
        );
        setSelectedPaymentForProducts(payment);
        setShowProductBreakdown(true);
        return;
      } catch (error) {
        console.error('Error fetching vendor product breakdown:', error);
        return;
      }
    }

    const breakdown = await buildProductBreakdown(payment, selectedRecipient?.entityType || '', selectedRecipient?.entityId);
    if (breakdown.length === 0) return;

    // Fetch product names and bundle flags
    const productIds = breakdown.map(p => p.productId);
    const { names: productNames, bundleFlags } = await fetchProductNames(productIds);
    
    // If viewing for a vendor, fetch vendor info for products to highlight vendor's products
    let vendorProductsMap = new Map<string, boolean>();
    if (selectedRecipient?.entityType === 'Vendor' && selectedRecipient?.entityId) {
      try {
        const productsResponse = await apiService.post<{ 
          success: boolean; 
          products?: Array<{ 
            ProductId: string; 
            VendorId?: string;
          }> 
        }>('/api/products/batch', { productIds });
        
        if (productsResponse.success && productsResponse.products) {
          productsResponse.products.forEach(p => {
            if (p.VendorId && p.VendorId.toUpperCase() === selectedRecipient.entityId.toUpperCase()) {
              vendorProductsMap.set(p.ProductId.toUpperCase(), true);
            }
          });
        }
      } catch (error) {
        console.error('Error fetching vendor info for products:', error);
      }
    }
    
    // Update breakdown with product names and filter out bundles
    const breakdownWithNames = breakdown
      .map(item => ({
        ...item,
        productName: productNames.get(item.productId) || item.productName,
        isVendorProduct: vendorProductsMap.get(item.productId.toUpperCase()) || false
      }))
      .filter(item => {
        // Filter out bundles - they shouldn't appear in enrollments
        const isBundle = bundleFlags.get(item.productId) || false;
        if (isBundle) {
          console.warn(`⚠️ Filtering out bundle product from breakdown: ${item.productName} (${item.productId})`);
        }
        return !isBundle;
      });

    setProductBreakdown(breakdownWithNames);
    setSelectedPaymentForProducts(payment);
    setShowProductBreakdown(true);
  };

  // Function to fetch payment details for a recipient
  const fetchPaymentDetails = async (entityType: string, entityId: string) => {
    setLoadingPayments(true);
    try {
      const response = await nachaService.getPreviewRecipientPayments(
        entityType,
        entityId,
        startDate,
        endDate
      );
      if (response && response.success && response.paymentDetails) {
        setPaymentDetails(response.paymentDetails);
      } else {
        console.error('Invalid response structure or empty results:', response);
        setPaymentDetails([]);
      }
    } catch (err: any) {
      console.error('Failed to load payment details:', err);
      setPaymentDetails([]);
    } finally {
      setLoadingPayments(false);
    }
  };

  if (!isOpen) return null;

  const payoutTypes = Array.from(previews.keys());
  const payoutTypeLabels: Record<string, string> = {
    'Agent Commission Payouts': 'Agent Commission Payouts',
    'Vendor Payouts': 'Vendor Payouts',
    'Product Owner Payouts': 'Product Override Distributions',
    'Product Override Distributions': 'Product Override Distributions'
  };

  const activePreview = activeTab !== 'overview' ? previews.get(activeTab) : null;

  const handleViewDetails = (payoutType: string) => {
    setActiveTab(payoutType);
    // Initialize vendor selection - select all vendors by default when viewing vendor payouts (excluding 0% splits)
    if (payoutType === 'Vendor Payouts') {
      const preview = previews.get(payoutType);
      if (preview && preview.payoutBreakdown) {
        // Filter out vendors with 0% split or 0 amount
        const validVendors = preview.payoutBreakdown.filter(payout => {
          if ((payout as any).isSplit && (payout as any).distributionPercentage !== undefined) {
            return (payout as any).distributionPercentage > 0;
          }
          if (payout.amount === 0 || payout.amount === null || payout.amount === undefined) {
            return false;
          }
          return true;
        });
        setSelectedVendorIds(new Set(validVendors.map((p) => normalizePayoutEntityId(p.entityId))));
        setVendorSelectionInitialized(true);
      }
      // Don't reset agent/agency selection when switching to vendor payouts
    } else {
      // Clear vendor selection for non-vendor payout types
      setSelectedVendorIds(new Set());
      setVendorSelectionInitialized(false);
    }

    // Initialize agent/agency selection - select all recipients by default when viewing agent commission payouts
    if (payoutType === 'Agent Commission Payouts') {
      const preview = previews.get(payoutType);
      if (preview && preview.payoutBreakdown) {
        const validRecipients = preview.payoutBreakdown.filter(payout => {
          if (payout.amount === 0 || payout.amount === null || payout.amount === undefined) return false;
          return payout.entityType === 'Agent' || payout.entityType === 'Agency';
        });
        setSelectedAgentIds(
          new Set(
            validRecipients
              .filter((p) => p.entityType === 'Agent')
              .map((p) => normalizePayoutEntityId(p.entityId))
          )
        );
        setSelectedAgencyIds(
          new Set(
            validRecipients
              .filter((p) => p.entityType === 'Agency')
              .map((p) => normalizePayoutEntityId(p.entityId))
          )
        );
        setAgentAgencySelectionInitialized(true);
      }
    }
  };
  
  // Initialize vendor selection once when opening Vendor Payouts (preserve explicit uncheck-all)
  useEffect(() => {
    if (activeTab === 'Vendor Payouts') {
      const preview = previews.get('Vendor Payouts');
      if (preview && preview.payoutBreakdown && !vendorSelectionInitialized) {
        const validVendors = preview.payoutBreakdown.filter(payout => {
          if ((payout as any).isSplit && (payout as any).distributionPercentage !== undefined) {
            return (payout as any).distributionPercentage > 0;
          }
          if (payout.amount === 0 || payout.amount === null || payout.amount === undefined) {
            return false;
          }
          return true;
        });
        setSelectedVendorIds(new Set(validVendors.map((p) => normalizePayoutEntityId(p.entityId))));
        setVendorSelectionInitialized(true);
      }
    }
  }, [activeTab, previews, vendorSelectionInitialized]);

  // Re-default vendor selection when preview date range / tenant changes
  useEffect(() => {
    setVendorSelectionInitialized(false);
  }, [startDate, endDate, localTenantId]);

  // Initialize agent/agency selection when activeTab changes to Agent Commission Payouts
  useEffect(() => {
    if (activeTab === 'Agent Commission Payouts') {
      const preview = previews.get('Agent Commission Payouts');
      if (preview && preview.payoutBreakdown && !agentAgencySelectionInitialized) {
        const validRecipients = preview.payoutBreakdown.filter(payout => {
          if (payout.amount === 0 || payout.amount === null || payout.amount === undefined) return false;
          return payout.entityType === 'Agent' || payout.entityType === 'Agency';
        });
        setSelectedAgentIds(
          new Set(
            validRecipients
              .filter((p) => p.entityType === 'Agent')
              .map((p) => normalizePayoutEntityId(p.entityId))
          )
        );
        setSelectedAgencyIds(
          new Set(
            validRecipients
              .filter((p) => p.entityType === 'Agency')
              .map((p) => normalizePayoutEntityId(p.entityId))
          )
        );
        setAgentAgencySelectionInitialized(true);
      }
    }
  }, [activeTab, previews, agentAgencySelectionInitialized]);

  // Fetch ACH options when viewing payout breakdown
  useEffect(() => {
    const fetchACHOptions = async () => {
      if (activeTab === 'overview' || activeTab === 'fees') {
        setAchOptions([]);
        setLoadingAchOptions(false);
        return;
      }

      const preview = previews.get(activeTab);
      if (!preview) {
        setAchOptions([]);
        setLoadingAchOptions(false);
        return;
      }
      
      // Determine payout type for ACH account lookup
      let payoutType = '';
      if (activeTab === 'Agent Commission Payouts') payoutType = 'Agent Commission Payouts';
      else if (activeTab === 'Vendor Payouts') payoutType = 'Vendor Payouts';
      else if (activeTab === 'Product Owner Payouts' || activeTab === 'Product Override Distributions') payoutType = activeTab;
      else {
        setAchOptions([]);
        setLoadingAchOptions(false);
        return;
      }
      
      // Use localTenantId if available, otherwise we can't fetch options
      const tenantIdToUse = localTenantId;
      if (!tenantIdToUse) {
        console.warn('No tenantId available for fetching ACH options');
        setAchOptions([]);
        setAchOptionsError(null);
        setLoadingAchOptions(false);
        return;
      }
      
      setLoadingAchOptions(true);
      setAchOptionsError(null);
      
      try {
        console.log('Fetching ACH options:', { tenantId: tenantIdToUse, payoutType });
        // Fetch all available ACH options
        const response = await nachaService.getACHOptions(tenantIdToUse, payoutType);
        console.log('ACH options response:', response);
        
        if (response.success && response.options && response.options.length > 0) {
          setAchOptions(response.options);
          
          // Set default selected account for this payout type (preserve existing selection if still valid)
          const existingSelection = selectedFundingAchAccountIdByPayoutType[activeTab];
          const existingIsValid = existingSelection
            ? response.options.some(opt => opt.achAccountId === existingSelection)
            : false;
          const defaultOption = response.options.find(opt => opt.isDefault) || response.options[0];
          const nextSelectedId = existingIsValid ? existingSelection : defaultOption.achAccountId;
          setSelectedFundingAchAccountIdByPayoutType(prev => ({
            ...prev,
            [activeTab]: nextSelectedId
          }));
          
          console.log('ACH options loaded:', response.options.length, 'options, default:', defaultOption.label);
        } else {
          console.warn('No ACH options returned from API', response);
          setAchOptions([]);
        }
      } catch (error) {
        console.error('Error fetching ACH options:', error);
        setAchOptions([]);
        const errAny = error as any;
        const msg =
          errAny?.response?.data?.message ||
          errAny?.message ||
          'Failed to load ACH account options.';
        setAchOptionsError(String(msg));
      } finally {
        setLoadingAchOptions(false);
      }
    };
    
    fetchACHOptions();
    // IMPORTANT: Do NOT depend on selectedFundingAchAccountIdByPayoutType here.
    // This effect sets selection defaults; including selection state in deps causes an infinite refetch loop.
  }, [activeTab, localTenantId, previews]);

  // Auto-fill and lock Company Identification when the selected funding ACH has one
  useEffect(() => {
    if (activeTab === 'overview' || activeTab === 'fees') return;
    if (!achOptions || achOptions.length === 0) return;

    const payoutType = activeTab;
    const selectedId = selectedFundingAchAccountIdByPayoutType[payoutType];
    if (!selectedId) return;

    const selectedOption = achOptions.find((opt) => opt.achAccountId === selectedId);
    const selectedCompanyId = (selectedOption?.companyIdentification || '').replace(/\D/g, '').slice(0, 10);
    const isValid = /^\d{9}$|^\d{10}$/.test(selectedCompanyId);

    setCompanyIdLockedByPayoutType((prev) => {
      if (prev[payoutType] === isValid) return prev;
      return { ...prev, [payoutType]: isValid };
    });

    if (isValid) {
      setCompanyIdentificationByPayoutType((prev) => {
        if ((prev[payoutType] || '').trim() === selectedCompanyId) return prev;
        return { ...prev, [payoutType]: selectedCompanyId };
      });
      setCompanyIdError(null);
    }
  }, [activeTab, achOptions, selectedFundingAchAccountIdByPayoutType]);

  const renderFees = () => {
    return (
      <div className="space-y-6">
        {/* Fees Section */}
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-oe-dark mb-4">Fees Breakdown</h3>
          {loadingFees ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-oe-primary" />
              <span className="ml-2 text-gray-600">Loading fees...</span>
            </div>
          ) : feesData.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No fees found for the selected date range</div>
          ) : (
            <>
              {/* Fees Summary */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div className="bg-oe-neutral-light rounded-lg p-4">
                  <label className="text-xs text-gray-600 font-medium uppercase">Total System Fees</label>
                  <p className="text-xl font-bold text-oe-dark mt-1">{formatCurrency(feesTotals.totalSystemFees)}</p>
                </div>
                <div className="bg-oe-neutral-light rounded-lg p-4">
                  <label className="text-xs text-gray-600 font-medium uppercase">Total Processing Fees</label>
                  <p className="text-xl font-bold text-oe-dark mt-1">{formatCurrency(feesTotals.totalProcessingFees)}</p>
                </div>
                <div className="bg-oe-neutral-light rounded-lg p-4">
                  <label className="text-xs text-gray-600 font-medium uppercase">Total Fees</label>
                  <p className="text-xl font-bold text-oe-dark mt-1">{formatCurrency(feesTotals.totalFees)}</p>
                </div>
              </div>

              {/* Fees Table */}
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Payment Date</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Group</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Member</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">System Fees</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Processing Fees</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Fees</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {feesData.map((fee, idx) => (
                      <tr key={fee.paymentId || idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {formatDate(fee.paymentDate, false)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {fee.groupName || <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {fee.groupId ? <span className="text-gray-400">—</span> : fee.memberName}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 text-right">
                          {formatCurrency(fee.systemFees)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 text-right">
                          {formatCurrency(fee.processingFee)}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-oe-dark text-right">
                          {formatCurrency(fee.totalFees)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderOverview = () => {
    // Calculate overall stats
    // Use a Set to track unique revenue values to avoid double-counting the same payment
    // Since each payout type may reference the same underlying payment, we need to deduplicate
    const uniqueRevenues = new Set<number>();
    let totalPayouts = 0;
    let totalAmount = 0;
    let totalMissingACH = 0;
    
    const hasExclusions = excludedPaymentIds.size > 0 || excludedInvoiceIds.size > 0;
    previews.forEach((preview) => {
      totalPayouts += preview.totalPayouts;
      if (hasExclusions) {
        // Match the per-row + per-card "after exclusions" math so the headline
        // amount lines up with what the generated NACHA will actually disburse.
        const previewHasClawback = (preview.payoutBreakdown || []).some(
          (p: any) => p?.netAmount !== undefined && p?.netAmount !== null
        );
        const previewEffective = (preview.payoutBreakdown || []).reduce(
          (sum, p: any) => sum + getEffectivePayoutAmount(p, {
            useNet: previewHasClawback && p?.netAmount !== undefined
          }),
          0
        );
        totalAmount += previewEffective;
      } else {
        totalAmount += preview.totalAmount;
      }
      const missingACH = preview.payoutBreakdown.filter(p => !p.hasACH).length;
      totalMissingACH += missingACH;
    });
    
    // Calculate total revenue
    // If backend provides totalRevenue (calculated from unique payment IDs), use it
    // Otherwise, fall back to summing revenue from one payout type only
    let totalRevenue = 0;
    const previewsWithRevenue = Array.from(previews.values()).filter(p => p.totalRevenue !== undefined);
    if (previewsWithRevenue.length > 0) {
      previewsWithRevenue.forEach(p => uniqueRevenues.add(p.totalRevenue || 0));
      // Use totalRevenue from backend (most accurate - calculated from unique payment IDs)
      // All payout types should have the same totalRevenue since they reference the same payments
      totalRevenue = previewsWithRevenue[0].totalRevenue || 0;
    } else {
      // Fallback: use revenue from one payout type only (Agent Commission Payouts preferred)
      const agentPayoutsPreview = previews.get('Agent Commission Payouts');
      if (agentPayoutsPreview) {
        agentPayoutsPreview.payoutBreakdown.forEach(payout => {
          if (payout.revenue !== undefined && payout.revenue > 0) {
            totalRevenue += payout.revenue;
          }
        });
      } else {
        // Fallback: use first available payout type
        const firstPreview = Array.from(previews.values())[0];
        if (firstPreview) {
          firstPreview.payoutBreakdown.forEach(payout => {
            if (payout.revenue !== undefined && payout.revenue > 0) {
              totalRevenue += payout.revenue;
            }
          });
        }
      }
    }

    return (
      <div className="space-y-6">
        {/* Overall Stats */}
        <div className="bg-oe-neutral-light rounded-lg p-6 border border-gray-200">
          <h3 className="text-lg font-semibold text-oe-dark mb-4">Overall Summary</h3>
          {(() => {
            // Collect all excluded payments from all previews
            const allExcluded: Array<{ tenantId: string; tenantName: string; holdDays: number; holdDaysCountFrom: string; excludedPaymentCount: number; excludedAmount: number; earliestPaymentDate: string; latestEligibilityDate: string }> = [];
            previews.forEach((preview) => {
              if (preview.excludedPaymentsDueToHoldPeriods) {
                allExcluded.push(...preview.excludedPaymentsDueToHoldPeriods);
              }
            });
            // Deduplicate by tenantId
            const uniqueExcluded = Array.from(
              new Map(allExcluded.map(item => [item.tenantId, item])).values()
            );
            
            if (uniqueExcluded.length > 0) {
              return (
                <div className="mb-4">
                  {uniqueExcluded.map((excluded, idx) => {
                    const eligibilityDate = new Date(excluded.latestEligibilityDate);
                    const formattedEligibilityDate = eligibilityDate.toLocaleDateString();
                    const formattedDateRange = `${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`;
                    return (
                      <div key={idx} className="text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-md p-3 mb-2">
                        <p>
                          <strong>{excluded.tenantName}</strong> has a commission hold period ({excluded.holdDays} day{excluded.holdDays !== 1 ? 's' : ''}) not allowing selected dates of {formattedDateRange} to apply. 
                          You will need to payout these payments after {formattedEligibilityDate} (when the hold period expires).
                        </p>
                      </div>
                    );
                  })}
                </div>
              );
            }
            return null;
          })()}
          {(() => {
            // Detail listing of agency / agent recipients with no active ACH account.
            // Counterpart to the totalMissingACH summary chip below — when generation
            // would silently skip these payouts, surface who and how much.
            const missing: Array<{ entityType: string; entityName: string; entityId: string; amount: number }> = [];
            previews.forEach((preview) => {
              (preview.payoutBreakdown || []).forEach((p: any) => {
                if (p?.hasACH === false) {
                  missing.push({
                    entityType: String(p.entityType || ''),
                    entityName: String(p.entityName || p.entityId || 'Unknown'),
                    entityId: String(p.entityId || ''),
                    amount: Number(p.amount || 0)
                  });
                }
              });
            });
            if (missing.length === 0) return null;
            // Dedupe by (entityType, entityId) — same recipient can appear across previews.
            const dedup = Array.from(
              new Map(missing.map((m) => [`${m.entityType}:${m.entityId}`, m])).values()
            );
            const total = dedup.reduce((s, m) => s + m.amount, 0);
            return (
              <div className="mb-4 text-sm text-red-800 bg-red-50 border border-red-200 rounded-md p-3">
                <p className="font-medium">
                  Excluded payments due to missing ACH ({dedup.length} recipient{dedup.length !== 1 ? 's' : ''} · {formatCurrency(total)})
                </p>
                <ul className="mt-2 space-y-0.5 text-xs text-red-900">
                  {dedup.slice(0, 12).map((m, i) => (
                    <li key={`${m.entityType}:${m.entityId}:${i}`}>
                      <span className="font-medium">{m.entityType}</span> — {m.entityName} · {formatCurrency(m.amount)}
                    </li>
                  ))}
                  {dedup.length > 12 && (
                    <li className="italic">…and {dedup.length - 12} more.</li>
                  )}
                </ul>
              </div>
            );
          })()}
          {(() => {
            const missingIds = new Set<string>();
            let sumCount = 0;
            previews.forEach((preview) => {
              const m = preview.paymentsMissingProductSnapshot;
              if (m?.count) {
                sumCount += m.count;
                (m.paymentIds || []).forEach((id) => missingIds.add(id));
              }
            });
            if (sumCount === 0) return null;
            const displayCount = missingIds.size > 0 ? missingIds.size : sumCount;
            return (
              <div className="mb-4 text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-md p-3">
                <p>
                  <strong>{displayCount}</strong> payment{displayCount !== 1 ? 's' : ''} in the selected date range
                  {' '}have no ProductCommissions snapshot on file. Vendor or product-owner payouts that rely on per-product
                  breakdown may not fully include those payments.
                </p>
                {missingIds.size > 0 && (
                  <p className="mt-1 text-xs text-yellow-900 break-all">
                    Sample payment IDs: {Array.from(missingIds).slice(0, 12).join(', ')}
                    {missingIds.size > 12 ? '…' : ''}
                  </p>
                )}
              </div>
            );
          })()}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-gray-600 font-medium uppercase">Total Revenue</label>
              <p className="text-2xl font-bold text-oe-dark mt-1">{formatCurrency(totalRevenue)}</p>
            </div>
            <div>
              <label className="text-xs text-gray-600 font-medium uppercase">Total Recipients</label>
              <p className="text-2xl font-bold text-oe-dark mt-1">{totalPayouts}</p>
            </div>
            <div>
              <label className="text-xs text-gray-600 font-medium uppercase">Total Payout Amount</label>
              <p className="text-2xl font-bold text-oe-dark mt-1">{formatCurrency(totalAmount)}</p>
            </div>
          </div>
          {totalMissingACH > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                  ⚠️ {totalMissingACH} recipient{totalMissingACH > 1 ? 's' : ''} missing ACH information
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Payout Type Cards */}
        <div className="space-y-4">
          {payoutTypes.map((payoutType) => {
            const preview = previews.get(payoutType);
            if (!preview) return null;

            const missingACH = preview.payoutBreakdown.filter(p => !p.hasACH).length;

            return (
              <div
                key={payoutType}
                className="bg-white border border-gray-200 rounded-lg p-6 hover:border-oe-primary hover:shadow-md transition-all cursor-pointer"
                onClick={() => handleViewDetails(payoutType)}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <FileText className="w-5 h-5 text-oe-primary" />
                    <h3 className="text-lg font-semibold text-oe-dark">
                      {payoutTypeLabels[payoutType] || payoutType}
                    </h3>
                    {missingACH > 0 && (
                      <span className="ml-auto inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        {missingACH} missing ACH
                      </span>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-oe-neutral-light rounded-lg p-4">
                      <label className="text-xs text-oe-dark font-medium uppercase">Total Amount</label>
                      <p className="text-xl font-bold text-oe-dark mt-1">{formatCurrency(preview.totalAmount)}</p>
                    </div>
                    <div className="bg-oe-neutral-light rounded-lg p-4">
                      <label className="text-xs text-oe-dark font-medium uppercase">Recipients</label>
                      <p className="text-xl font-bold text-oe-dark mt-1">{preview.payoutBreakdown.length}</p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderPayoutBreakdown = (preview: NACHAPreview, payoutType: string) => {
    const clawbackApplied = Number(preview.totalClawbackApplied || 0);
    const clawbackCarryForward = Number(preview.totalClawbackCarryForward || 0);
    const anyClawbackInPreview = (preview.payoutBreakdown || []).some(
      (p) => Number(p.pendingClawbackAmount || 0) > 0
    );
    return (
      <div className="space-y-6">
        {/* Phase 7b — Carry-forward indicator. Any recipient whose net amount
            for this cycle is <= 0 (clawback >= positive payout) is excluded by
            the non-negative ACH guard and stays Pending in oe.Commissions /
            oe.PayoutClawbacks for the next cycle. */}
        {(clawbackApplied > 0 || clawbackCarryForward > 0) ? (
          <div className="bg-orange-50 border border-orange-200 text-orange-900 rounded-lg p-3 text-sm flex items-start gap-2">
            <FileText className="w-4 h-4 mt-0.5 flex-shrink-0 text-orange-700" />
            <div className="flex-1">
              <div className="font-semibold mb-1">Refund clawbacks will net into this NACHA cycle.</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
                <div>
                  <span className="text-orange-800/80">Applied this cycle: </span>
                  <span className="font-semibold">−{formatCurrency(clawbackApplied)}</span>
                </div>
                {clawbackCarryForward > 0 && (
                  <div>
                    <span className="text-orange-800/80">Carry forward to next cycle: </span>
                    <span className="font-semibold">{formatCurrency(clawbackCarryForward)}</span>
                  </div>
                )}
              </div>
              <div className="mt-2 text-xs text-orange-800/80">
                Recipients whose net amount this cycle is zero or negative are excluded from the ACH file
                and their remaining clawback balance stays pending for the next cycle.
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded-lg p-3 text-sm flex items-start gap-2">
            <FileText className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-700" />
            <div>
              <span className="font-semibold">Carry-forward enabled.</span>{' '}
              Recipients whose net amount this cycle is zero or negative (clawback offsetting payout)
              are not in this NACHA file. Their balances stay Pending and will be netted in the next
              cycle.
            </div>
          </div>
        )}
        {/* Summary */}
        <div className="bg-oe-neutral-light rounded-lg p-4">
          <h3 className="text-lg font-semibold text-oe-dark mb-4">Payout Summary</h3>
          
          {/* Funding ACH Account Selection */}
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
            <label className="block text-sm font-medium text-blue-900 mb-2">
              Paying From:
            </label>
            {loadingAchOptions ? (
              <div className="p-2 bg-white border border-blue-300 rounded-lg">
                <p className="text-sm text-gray-600">Loading ACH account options...</p>
              </div>
            ) : achOptions.length > 0 ? (
              <>
                <select
                  value={selectedFundingAchAccountIdByPayoutType[payoutType] || ''}
                  onChange={(e) => {
                    const selectedId = e.target.value;
                    setSelectedFundingAchAccountIdByPayoutType(prev => ({
                      ...prev,
                      [payoutType]: selectedId
                    }));
                  }}
                  className="w-full px-3 py-2 text-sm border border-blue-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {achOptions.map((option) => (
                    <option key={option.achAccountId} value={option.achAccountId}>
                      {option.label} - {option.accountHolderName}
                      {option.bankName && ` • ${option.bankName}`}
                      {option.accountNumberLast4 && ` • ****${option.accountNumberLast4}`}
                    </option>
                  ))}
                </select>
                {selectedFundingAchAccountIdByPayoutType[payoutType] && (
                  <p className="text-xs text-blue-700 mt-2">
                    {achOptions.find(opt => opt.achAccountId === selectedFundingAchAccountIdByPayoutType[payoutType])?.accountSource === 'TenantPayoutACH' && 'Tenant Payout ACH Account'}
                    {achOptions.find(opt => opt.achAccountId === selectedFundingAchAccountIdByPayoutType[payoutType])?.accountSource === 'AgencyPrimaryACH' && 'Primary Agency ACH Account'}
                    {achOptions.find(opt => opt.achAccountId === selectedFundingAchAccountIdByPayoutType[payoutType])?.accountSource === 'VendorTenantTpaServices' && 'TPA (Commissions Processing) ACH Account'}
                    {achOptions.find(opt => opt.achAccountId === selectedFundingAchAccountIdByPayoutType[payoutType])?.accountSource === 'ACHAccounts' && 'Tenant ACH Account'}
                  </p>
                )}

                {/* Required NACHA header settings */}
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-blue-900 mb-1">
                      Company Identification (EIN 9 digits or 10)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="\\d*"
                      value={companyIdentificationByPayoutType[payoutType] || ''}
                      disabled={Boolean(companyIdLockedByPayoutType[payoutType])}
                      onChange={(e) => {
                        const next = e.target.value.replace(/\D/g, '').slice(0, 10);
                        setCompanyIdentificationByPayoutType(prev => ({
                          ...prev,
                          [payoutType]: next
                        }));
                        if (next.length === 9 || next.length === 10) setCompanyIdError(null);
                      }}
                      placeholder="e.g. 12-3456789 (EIN) or 1123456789"
                      className="w-full px-3 py-2 text-sm border border-blue-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50 disabled:cursor-not-allowed"
                    />
                    <p className="text-xs text-blue-700 mt-1">
                      {companyIdLockedByPayoutType[payoutType]
                        ? 'Auto-filled from the selected funding ACH account.'
                        : 'Required. Use your 9-digit EIN or 10-digit Company ID used for ACH origination.'}
                    </p>
                  </div>
                  <div className="flex items-end">
                    {companyIdError && (
                      <div className="w-full bg-red-50 border border-red-200 rounded-md p-3">
                        <p className="text-sm text-red-700">{companyIdError}</p>
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="p-2 bg-yellow-50 border border-yellow-300 rounded-lg">
                <p className="text-sm text-yellow-800">
                  {achOptionsError ? (
                    <span className="text-red-700">
                      Failed to load ACH account options: {achOptionsError}
                    </span>
                  ) : (
                    <>
                  {!localTenantId 
                    ? 'Please select a tenant to view ACH account options.'
                    : 'No ACH account options available. Please configure ACH accounts for this tenant.'}
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
          
          {preview.excludedPaymentsDueToHoldPeriods && preview.excludedPaymentsDueToHoldPeriods.length > 0 && (
            <div className="mb-4">
              {preview.excludedPaymentsDueToHoldPeriods.map((excluded, idx) => {
                const eligibilityDate = new Date(excluded.latestEligibilityDate);
                const formattedEligibilityDate = eligibilityDate.toLocaleDateString();
                const formattedDateRange = `${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`;
                return (
                  <div key={idx} className="text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-md p-3 mb-2">
                    <p>
                      <strong>{excluded.tenantName}</strong> has a commission hold period ({excluded.holdDays} day{excluded.holdDays !== 1 ? 's' : ''}) not allowing selected dates of {formattedDateRange} to apply. 
                      You will need to payout these payments after {formattedEligibilityDate} (when the hold period expires).
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {preview.paymentsMissingProductSnapshot &&
            preview.paymentsMissingProductSnapshot.count > 0 &&
            (payoutType === 'Vendor Payouts' || payoutType === 'Product Owner Payouts') && (
              <div className="mb-4 text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-md p-3">
                <p>
                  <strong>{preview.paymentsMissingProductSnapshot.count}</strong> payment
                  {preview.paymentsMissingProductSnapshot.count !== 1 ? 's' : ''} in this range have no ProductCommissions
                  snapshot on file. Payout lines that rely on per-product data may not fully include those payments.
                </p>
                {(preview.paymentsMissingProductSnapshot.paymentIds || []).length > 0 && (
                  <p className="mt-1 text-xs text-yellow-900 break-all">
                    Sample payment IDs: {(preview.paymentsMissingProductSnapshot.paymentIds || []).slice(0, 12).join(', ')}
                    {(preview.paymentsMissingProductSnapshot.paymentIds || []).length > 12 ? '…' : ''}
                  </p>
                )}
              </div>
            )}
          
          {(() => {
            // Filter payouts by selection (Vendor or Agent/Agency)
            const filteredBreakdown = (() => {
              if (payoutType === 'Vendor Payouts' && vendorSelectionInitialized) {
                return preview.payoutBreakdown.filter((p) =>
                  selectedVendorIds.has(normalizePayoutEntityId(p.entityId))
                );
              }
              if (payoutType === 'Agent Commission Payouts' && agentAgencySelectionInitialized) {
                return preview.payoutBreakdown.filter(p => {
                  if (p.entityType === 'Agent') return selectedAgentIds.has(normalizePayoutEntityId(p.entityId));
                  if (p.entityType === 'Agency') return selectedAgencyIds.has(normalizePayoutEntityId(p.entityId));
                  return true;
                });
              }
              return preview.payoutBreakdown;
            })();
            
            const totalPayouts = filteredBreakdown.length;
            // Use the same per-recipient effective amount the row displays so
            // the card and headline totals stay in lockstep with what the user
            // sees on each row after exclusions.
            const effectiveAmountFor = (p: any) => getEffectivePayoutAmount(
              p,
              { useNet: anyClawbackInPreview && p?.netAmount !== undefined }
            );
            const totalAmount = filteredBreakdown.reduce((sum, p) => sum + effectiveAmountFor(p), 0);
            const withACH = filteredBreakdown.filter(p => p.hasACH).length;
            const withoutACH = filteredBreakdown.filter(p => !p.hasACH).length;
            const totalWithACH = filteredBreakdown.filter(p => p.hasACH).reduce((sum, p) => sum + effectiveAmountFor(p), 0);
            const totalWithoutACH = filteredBreakdown.filter(p => !p.hasACH).reduce((sum, p) => sum + effectiveAmountFor(p), 0);
            
            return (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-oe-dark">Total Payouts</p>
                    <p className="text-2xl font-bold text-oe-dark">{totalPayouts}</p>
                  </div>
                  <div>
                    <p className="text-sm text-oe-dark">Total Amount</p>
                    <p className="text-2xl font-bold text-oe-dark">{formatCurrency(totalAmount)}</p>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-oe-dark font-medium">With ACH: {withACH} payouts</p>
                      <p className="text-oe-dark text-lg font-semibold">{formatCurrency(totalWithACH)}</p>
                    </div>
                    {withoutACH > 0 && (
                      <div>
                        <p className="text-yellow-800 font-medium">Missing ACH: {withoutACH} payouts</p>
                        <p className="text-yellow-800 text-lg font-semibold">{formatCurrency(totalWithoutACH)}</p>
                      </div>
                    )}
                  </div>
                  {payoutType === 'Vendor Payouts' && vendorSelectionInitialized && (
                    <div className="mt-2 text-xs text-gray-600">
                      Showing {selectedVendorIds.size} of {preview.payoutBreakdown.length} selected vendors
                    </div>
                  )}
                  {payoutType === 'Agent Commission Payouts' && agentAgencySelectionInitialized && (
                    <div className="mt-2 text-xs text-gray-600">
                      Selected: {selectedAgentIds.size} agent(s), {selectedAgencyIds.size} agenc{selectedAgencyIds.size === 1 ? 'y' : 'ies'}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
          {(() => {
            // Filter payouts by selected vendors if viewing Vendor Payouts
            const filteredBreakdown = payoutType === 'Vendor Payouts' && vendorSelectionInitialized
              ? preview.payoutBreakdown.filter((p) =>
                  selectedVendorIds.has(normalizePayoutEntityId(p.entityId))
                )
              : preview.payoutBreakdown;
            
            const withoutACH = filteredBreakdown.filter(p => !p.hasACH).length;
            const totalWithoutACH = filteredBreakdown.filter(p => !p.hasACH).reduce((sum, p) => sum + p.amount, 0);
            
            return withoutACH > 0 ? (
              <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-md p-3">
                <div className="flex">
                  <div className="ml-3">
                    <p className="text-sm font-medium text-yellow-800">
                      {withoutACH} recipient{withoutACH > 1 ? 's' : ''} {withoutACH > 1 ? 'are' : 'is'} missing ACH account information
                    </p>
                    <p className="text-sm text-yellow-700 mt-1">
                      They will not be included in the NACHA file, but their payout amounts ({formatCurrency(totalWithoutACH)}) are shown below.
                    </p>
                  </div>
                </div>
              </div>
            ) : null;
          })()}
        </div>

        {/* Payout Breakdown Table */}
        {(() => {
          // Filter out vendors with 0% split (distributionPercentage === 0) or 0 amount
          const vendorTableRows = preview.payoutBreakdown.filter(
            (payout) => payoutType !== 'Vendor Payouts' || isValidVendorPayoutRow(payout)
          );
          let filteredBreakdown =
            payoutType === 'Vendor Payouts' ? vendorTableRows : preview.payoutBreakdown.filter(isValidVendorPayoutRow);

          const vendorAllSelected =
            payoutType === 'Vendor Payouts' &&
            vendorTableRows.length > 0 &&
            vendorTableRows.every((p) => selectedVendorIds.has(normalizePayoutEntityId(p.entityId)));
          const vendorSomeSelected =
            payoutType === 'Vendor Payouts' &&
            vendorTableRows.some((p) => selectedVendorIds.has(normalizePayoutEntityId(p.entityId)));

          const agentAgencyTableRows =
            payoutType === 'Agent Commission Payouts'
              ? filteredBreakdown.filter((p) => p.entityType === 'Agent' || p.entityType === 'Agency')
              : [];
          const agentAgencyAllSelected =
            agentAgencyTableRows.length > 0 &&
            agentAgencyTableRows.every((p) =>
              p.entityType === 'Agent'
                ? selectedAgentIds.has(normalizePayoutEntityId(p.entityId))
                : selectedAgencyIds.has(normalizePayoutEntityId(p.entityId))
            );

          return filteredBreakdown.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Payout Breakdown</h3>
              <div className="overflow-x-auto max-h-96 border border-gray-200 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      {(payoutType === 'Vendor Payouts' || payoutType === 'Agent Commission Payouts') && (
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase w-12">
                          {payoutType === 'Vendor Payouts' ? (
                            <input
                              type="checkbox"
                              checked={vendorAllSelected}
                              ref={(el) => {
                                if (el) el.indeterminate = vendorSomeSelected && !vendorAllSelected;
                              }}
                              onChange={() => {
                                if (vendorAllSelected) {
                                  setSelectedVendorIds(new Set());
                                } else {
                                  setSelectedVendorIds(
                                    new Set(vendorTableRows.map((p) => normalizePayoutEntityId(p.entityId)))
                                  );
                                }
                                setVendorSelectionInitialized(true);
                              }}
                              title="Select or deselect all vendors in this table"
                              className="h-4 w-4 text-oe-primary rounded focus:ring-oe-primary"
                            />
                          ) : (
                            <div className="flex flex-col gap-2 items-start">
                              <label className="flex items-center gap-2 text-[11px] text-gray-600 normal-case">
                                <input
                                  type="checkbox"
                                  checked={agentAgencyAllSelected}
                                  onChange={() => {
                                    if (agentAgencyAllSelected) {
                                      setSelectedAgentIds(new Set());
                                      setSelectedAgencyIds(new Set());
                                    } else {
                                      setSelectedAgentIds(
                                        new Set(
                                          agentAgencyTableRows
                                            .filter((p) => p.entityType === 'Agent')
                                            .map((p) => normalizePayoutEntityId(p.entityId))
                                        )
                                      );
                                      setSelectedAgencyIds(
                                        new Set(
                                          agentAgencyTableRows
                                            .filter((p) => p.entityType === 'Agency')
                                            .map((p) => normalizePayoutEntityId(p.entityId))
                                        )
                                      );
                                    }
                                    setAgentAgencySelectionInitialized(true);
                                  }}
                                  className="h-4 w-4 text-oe-primary rounded focus:ring-oe-primary"
                                />
                                All
                              </label>
                              <label className="flex items-center gap-2 text-[11px] text-gray-600 normal-case">
                                <input
                                  type="checkbox"
                                  checked={
                                    agentAgencyTableRows.filter((p) => p.entityType === 'Agent').length > 0 &&
                                    agentAgencyTableRows
                                      .filter((p) => p.entityType === 'Agent')
                                      .every((p) => selectedAgentIds.has(normalizePayoutEntityId(p.entityId)))
                                  }
                                  onChange={() => {
                                    const agentRows = agentAgencyTableRows.filter((p) => p.entityType === 'Agent');
                                    const allAgents = agentRows.every((p) =>
                                      selectedAgentIds.has(normalizePayoutEntityId(p.entityId))
                                    );
                                    const next = new Set(selectedAgentIds);
                                    if (allAgents) {
                                      agentRows.forEach((p) => next.delete(normalizePayoutEntityId(p.entityId)));
                                    } else {
                                      agentRows.forEach((p) => next.add(normalizePayoutEntityId(p.entityId)));
                                    }
                                    setSelectedAgentIds(next);
                                    setAgentAgencySelectionInitialized(true);
                                  }}
                                  className="h-4 w-4 text-oe-primary rounded focus:ring-oe-primary"
                                />
                                Agents
                              </label>
                              <label className="flex items-center gap-2 text-[11px] text-gray-600 normal-case">
                                <input
                                  type="checkbox"
                                  checked={
                                    agentAgencyTableRows.filter((p) => p.entityType === 'Agency').length > 0 &&
                                    agentAgencyTableRows
                                      .filter((p) => p.entityType === 'Agency')
                                      .every((p) => selectedAgencyIds.has(normalizePayoutEntityId(p.entityId)))
                                  }
                                  onChange={() => {
                                    const agencyRows = agentAgencyTableRows.filter((p) => p.entityType === 'Agency');
                                    const allAgencies = agencyRows.every((p) =>
                                      selectedAgencyIds.has(normalizePayoutEntityId(p.entityId))
                                    );
                                    const next = new Set(selectedAgencyIds);
                                    if (allAgencies) {
                                      agencyRows.forEach((p) => next.delete(normalizePayoutEntityId(p.entityId)));
                                    } else {
                                      agencyRows.forEach((p) => next.add(normalizePayoutEntityId(p.entityId)));
                                    }
                                    setSelectedAgencyIds(next);
                                    setAgentAgencySelectionInitialized(true);
                                  }}
                                  className="h-4 w-4 text-oe-primary rounded focus:ring-oe-primary"
                                />
                                Agencies
                              </label>
                            </div>
                          )}
                        </th>
                      )}
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Recipient</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                      {payoutType === 'Agent Commission Payouts' && (
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Revenue</th>
                      )}
                      {(payoutType === 'Vendor Payouts' || payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions') && (
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Revenue</th>
                      )}
                      {anyClawbackInPreview && (
                        <th
                          className="px-4 py-3 text-right text-xs font-medium text-orange-700 uppercase"
                          title="Pending refund clawback that will net against this recipient on this NACHA cycle. Anything beyond their gross carries forward."
                        >
                          Clawback
                        </th>
                      )}
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        {anyClawbackInPreview ? 'Net Payout' : 'Payout Amount'}
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">ACH Status</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredBreakdown.map((payout, index) => {
                    const isUnknownDestination = (payout as any).isUnknownDestination || (payout as any).missingOverrideDestination || payout.entityId === 'UNKNOWN' || payout.entityId === 'unknown';
                    const isUnknownEntity = !isUnknownDestination && (payout.entityName === 'Unknown' || !payout.entityName || payout.entityName === payout.entityId);
                    const entityKey = normalizePayoutEntityId(payout.entityId);
                    const isAgentSelected = payout.entityType === 'Agent' ? selectedAgentIds.has(entityKey) : true;
                    const isAgencySelected = payout.entityType === 'Agency' ? selectedAgencyIds.has(entityKey) : true;
                    const isSelectedForAgentTab = payoutType === 'Agent Commission Payouts'
                      ? (payout.entityType === 'Agent' ? isAgentSelected : payout.entityType === 'Agency' ? isAgencySelected : true)
                      : true;
                    return (
                      <tr key={index} className={`hover:bg-gray-50 ${!payout.hasACH && !isUnknownDestination ? 'bg-yellow-50' : ''} ${isUnknownDestination ? 'bg-red-50 border-l-4 border-red-500' : ''} ${isUnknownEntity ? 'bg-orange-50 border-l-4 border-orange-400' : ''} ${payoutType === 'Vendor Payouts' && vendorSelectionInitialized && !selectedVendorIds.has(entityKey) ? 'opacity-50' : ''} ${payoutType === 'Agent Commission Payouts' && agentAgencySelectionInitialized && !isSelectedForAgentTab ? 'opacity-50' : ''}`}>
                        {payoutType === 'Vendor Payouts' && (
                          <td className="px-4 py-3 text-center">
                            <input
                              type="checkbox"
                              checked={selectedVendorIds.has(entityKey)}
                              onChange={(e) => {
                                const newSelected = new Set(selectedVendorIds);
                                if (e.target.checked) {
                                  newSelected.add(entityKey);
                                } else {
                                  newSelected.delete(entityKey);
                                }
                                setSelectedVendorIds(newSelected);
                                setVendorSelectionInitialized(true);
                              }}
                              className="h-4 w-4 text-oe-primary rounded focus:ring-oe-primary"
                            />
                          </td>
                        )}
                        {payoutType === 'Agent Commission Payouts' && (
                          <td className="px-4 py-3 text-center">
                            {(payout.entityType === 'Agent' || payout.entityType === 'Agency') ? (
                              <input
                                type="checkbox"
                                checked={
                                  payout.entityType === 'Agent'
                                    ? selectedAgentIds.has(entityKey)
                                    : selectedAgencyIds.has(entityKey)
                                }
                                onChange={(e) => {
                                  if (payout.entityType === 'Agent') {
                                    const next = new Set(selectedAgentIds);
                                    if (e.target.checked) next.add(entityKey);
                                    else next.delete(entityKey);
                                    setSelectedAgentIds(next);
                                  } else {
                                    const next = new Set(selectedAgencyIds);
                                    if (e.target.checked) next.add(entityKey);
                                    else next.delete(entityKey);
                                    setSelectedAgencyIds(next);
                                  }
                                  setAgentAgencySelectionInitialized(true);
                                }}
                                className="h-4 w-4 text-oe-primary rounded focus:ring-oe-primary"
                              />
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-4 py-3 text-sm text-oe-dark">
                          {isUnknownDestination ? (
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className="text-red-600 font-semibold">⚠️ Unknown Override Destination</span>
                              </div>
                              {(payout as any).productName && (
                                <div className="text-xs text-gray-700">
                                  <span className="font-medium">Product:</span> {(payout as any).productName}
                                  {(payout as any).productId && (
                                    <span className="ml-2 text-gray-500 font-mono">({(payout as any).productId.substring(0, 8)}...)</span>
                                  )}
                                </div>
                              )}
                              <div className="text-xs text-red-600 mt-1">
                                No override destinations configured. Please configure overrides in the product's pricing settings.
                              </div>
                            </div>
                          ) : isUnknownEntity ? (
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className="text-orange-600 font-medium">⚠️ Unknown Entity</span>
                              </div>
                              <div className="text-xs text-gray-500 font-mono">
                                Type: {payout.entityType} | ID: {payout.entityId}
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span>{payout.entityName}</span>
                                {(payout as any).isSplit && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                                    Split {(payout as any).splitIndex !== undefined ? `${(payout as any).splitIndex + 1}/${(payout as any).totalSplits}` : ''}
                                  </span>
                                )}
                              </div>
                              {(payout as any).isSplit && (payout as any).distributionPercentage !== undefined && (
                                <div className="text-xs text-gray-500">
                                  {((payout as any).distributionPercentage || 0).toFixed(2)}% distribution
                                  {(payout as any).originalAmount && (
                                    <span className="ml-2 text-gray-400">
                                      (of {formatCurrency((payout as any).originalAmount)})
                                    </span>
                                  )}
                                </div>
                              )}
                              {(() => {
                                // Per-recipient invoice picker affordance. Counts unique
                                // payment/invoice anchors contributing to this row, then
                                // subtracts any that are currently in the per-row
                                // excludedPaymentIds / excludedInvoiceIds sets so the user
                                // can see at a glance how many sources are still selected.
                                const details: any[] = Array.isArray((payout as any).payoutDetails)
                                  ? (payout as any).payoutDetails
                                  : [];
                                const anchorSet = new Set<string>();
                                let excludedHits = 0;
                                for (const d of details) {
                                  const pid = d?.paymentId ? String(d.paymentId) : null;
                                  const iid = d?.invoiceId ? String(d.invoiceId) : null;
                                  const key = pid || iid;
                                  if (!key) continue;
                                  if (anchorSet.has(key)) continue;
                                  anchorSet.add(key);
                                  if ((pid && excludedPaymentIds.has(pid))
                                    || (iid && excludedInvoiceIds.has(iid))) {
                                    excludedHits += 1;
                                  }
                                }
                                const totalSources = anchorSet.size;
                                const includedSources = Math.max(0, totalSources - excludedHits);
                                const noPicker = totalSources === 0;
                                const label = noPicker
                                  ? 'View invoices'
                                  : excludedHits > 0
                                    ? `${includedSources} of ${totalSources} invoices selected`
                                    : `${totalSources} invoice${totalSources === 1 ? '' : 's'} included`;
                                const vidKey = String(payout.entityId).toUpperCase();
                                const omittedSnap = vendorNachaOmittedByVendorId[vidKey];
                                const omittedLoading = omittedSnap?.loading;
                                const omittedCount = omittedSnap?.count ?? 0;
                                const canOpenOmitted =
                                  payout.entityType === 'Vendor' &&
                                  payoutType === 'Vendor Payouts' &&
                                  !omittedLoading &&
                                  omittedCount > 0;
                                return (
                                  <div className="mt-1 flex flex-wrap items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        setSelectedRecipient({
                                          entityType: payout.entityType,
                                          entityId: payout.entityId,
                                          entityName: payout.entityName || payout.entityId
                                        });
                                        setShowPaymentDetails(true);
                                        await fetchPaymentDetails(payout.entityType, payout.entityId);
                                      }}
                                      className={`inline-flex w-fit items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                                        excludedHits > 0
                                          ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                                          : 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                                      }`}
                                      title="Open the per-invoice picker to include or exclude individual invoices from this NACHA"
                                    >
                                      <Info className="h-3 w-3" />
                                      {label}
                                    </button>
                                    {payout.entityType === 'Vendor' && payoutType === 'Vendor Payouts' && (
                                      <button
                                        type="button"
                                        disabled={!canOpenOmitted}
                                        onClick={() => {
                                          if (canOpenOmitted) setVendorNachaOmittedModalVendorId(vidKey);
                                        }}
                                        className={`inline-flex w-fit items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                                          canOpenOmitted
                                            ? 'bg-orange-50 text-orange-900 border-orange-300 hover:bg-orange-100'
                                            : 'bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed'
                                        }`}
                                        title={
                                          canOpenOmitted
                                            ? 'Completed payments or invoices in this window with vendor share that are not part of this NACHA preview (e.g. payment not linked to an invoice, or invoice omitted from the selection)'
                                            : omittedLoading
                                              ? 'Loading omitted sources…'
                                              : 'No extra sources in this window beyond the preview selection'
                                        }
                                      >
                                        <Info className="h-3 w-3" />
                                        {omittedLoading ? 'Not in NACHA…' : `${omittedCount} not in this NACHA`}
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {payout.entityType === 'Agency' ? (
                            <span className="inline-flex items-center gap-1">
                              <span>Agency</span>
                              {(payout as any).isPrimaryAgency && (
                                <span className="text-xs text-oe-primary font-medium">(Primary)</span>
                              )}
                            </span>
                          ) : (
                            payout.entityType
                          )}
                        </td>
                        {payoutType === 'Agent Commission Payouts' && (
                          <td className="px-4 py-3 text-sm text-gray-600 text-right">
                            {payout.revenue !== undefined ? formatCurrency(payout.revenue) : '-'}
                          </td>
                        )}
                        {(payoutType === 'Vendor Payouts' || payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions') && (
                          <td className="px-4 py-3 text-sm text-gray-600 text-right">
                            {payout.revenue !== undefined ? formatCurrency(payout.revenue) : '-'}
                          </td>
                        )}
                        {anyClawbackInPreview && (
                          <td className="px-4 py-3 text-sm text-right">
                            {Number(payout.pendingClawbackAmount || 0) > 0 ? (
                              <button
                                type="button"
                                onClick={() => {
                                  const t = (payout.entityType || '') as
                                    | 'Agent'
                                    | 'Agency'
                                    | 'Vendor'
                                    | 'Tenant';
                                  if (
                                    t !== 'Agent' &&
                                    t !== 'Agency' &&
                                    t !== 'Vendor' &&
                                    t !== 'Tenant'
                                  )
                                    return;
                                  setClawbackTarget({
                                    entityType: t,
                                    entityId: payout.entityId,
                                    entityName: payout.entityName || payout.entityId,
                                  });
                                }}
                                className="flex flex-col items-end ml-auto hover:underline focus:outline-none focus:underline"
                                title={
                                  Number(payout.clawbackCarryForwardAmount || 0) > 0
                                    ? `Pending clawback ${formatCurrency(payout.pendingClawbackAmount || 0)} — applying ${formatCurrency(payout.clawbackAppliedThisCycle || 0)} this cycle. Click to view refunds.`
                                    : `${payout.pendingClawbackCount || 1} pending refund clawback${(payout.pendingClawbackCount || 1) === 1 ? '' : 's'} netting against this recipient. Click to view refunds.`
                                }
                              >
                                <span className="font-medium text-orange-700">
                                  −{formatCurrency(payout.clawbackAppliedThisCycle || 0)}
                                </span>
                                {Number(payout.clawbackCarryForwardAmount || 0) > 0 && (
                                  <span
                                    className="text-[11px] text-orange-600/80 underline decoration-dotted decoration-orange-400/70 cursor-help"
                                    title={carryForwardHoverTitle(
                                      Number(payout.clawbackCarryForwardAmount || 0),
                                      startDate,
                                      endDate
                                    )}
                                  >
                                    +{formatCurrency(payout.clawbackCarryForwardAmount || 0)} carry-fwd
                                  </span>
                                )}
                              </button>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-4 py-3 text-sm font-medium text-oe-dark text-right">
                          {isUnknownDestination ? (
                            <span className="text-red-600 font-medium">
                              {formatCurrency(payout.amount)}
                            </span>
                          ) : (() => {
                            // Live recompute: subtract excluded invoice/payment
                            // contributions so the user sees exactly what the
                            // generated NACHA will disburse to this recipient.
                            const useNet = anyClawbackInPreview && payout.netAmount !== undefined;
                            const baseAmount = useNet ? Number(payout.netAmount) : Number(payout.amount);
                            const effective = getEffectivePayoutAmount(payout, { useNet });
                            const wasReduced = Math.abs(baseAmount - effective) > 0.005;
                            return (
                              <div className="flex flex-col items-end">
                                <button
                                  onClick={async () => {
                                    setSelectedRecipient({
                                      entityType: payout.entityType,
                                      entityId: payout.entityId,
                                      entityName: payout.entityName || payout.entityId
                                    });
                                    setShowPaymentDetails(true);
                                    await fetchPaymentDetails(payout.entityType, payout.entityId);
                                  }}
                                  className="text-oe-primary hover:text-oe-dark hover:underline cursor-pointer font-medium"
                                >
                                  {formatCurrency(effective)}
                                </button>
                                {wasReduced && (
                                  <span
                                    className="text-[11px] text-amber-700"
                                    title="Original amount before excluding invoices"
                                  >
                                    <span className="line-through text-gray-400 mr-1">
                                      {formatCurrency(baseAmount)}
                                    </span>
                                    after exclusions
                                  </span>
                                )}
                                {anyClawbackInPreview &&
                                  Number(payout.pendingClawbackAmount || 0) > 0 &&
                                  payout.grossAmount !== undefined && (
                                    <span
                                      className="text-[11px] text-gray-500"
                                      title="Gross before clawback"
                                    >
                                      gross {formatCurrency(payout.grossAmount)}
                                    </span>
                                  )}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3 text-sm text-center">
                          {isUnknownDestination ? (
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                              N/A
                            </span>
                          ) : payout.hasACH ? (
                            <button
                              onClick={async () => {
                                setAchDetailsLoading(true);
                                setAchDetailsError(null);
                                try {
                                  const preview = previews.get(activeTab);
                                  // Always use entityId (vendor/entity ID) - the endpoint handles returning all accounts for vendors
                                  const response = await nachaService.getACHDetails(
                                    payout.entityType,
                                    payout.entityId,
                                    preview?.payoutType
                                  );
                                  if (response.success && response.data) {
                                    setAchDetails(response.data);
                                    setShowACHDetails(true);
                                  } else {
                                    setAchDetailsError('Failed to load ACH details');
                                  }
                                } catch (err: any) {
                                  console.error('Failed to load ACH details:', err);
                                  setAchDetailsError(err.message || 'Failed to load ACH details');
                                } finally {
                                  setAchDetailsLoading(false);
                                }
                              }}
                              className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 hover:bg-green-200 cursor-pointer transition-colors"
                              disabled={achDetailsLoading}
                            >
                              {achDetailsLoading ? (
                                <>
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                  Loading...
                                </>
                              ) : (
                                '✓ ACH Set'
                              )}
                            </button>
                          ) : (
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                              Missing
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </div>
    );
  };

  return (
    <>
      {/* Error Modal - Render first with highest z-index to appear on top */}
      {error && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]" style={{ position: 'fixed' }}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <h3 className="ml-3 text-lg font-semibold text-gray-900">NACHA Generation Error</h3>
              </div>
              <button
                onClick={() => setError(null)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6">
              <div className="bg-red-50 border border-red-200 rounded-md p-4">
                <p className="text-sm text-red-700 whitespace-pre-wrap">{error}</p>
              </div>
              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setError(null)}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div className="flex items-center gap-4">
              {activeTab !== 'overview' && (
                <button
                  onClick={() => setActiveTab('overview')}
                  className="text-gray-600 hover:text-oe-dark transition-colors"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
              )}
              <div>
                <h2 className="text-2xl font-semibold text-oe-dark">
                  {activeTab === 'overview' ? 'Payout Overview' : payoutTypeLabels[activeTab] || activeTab}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  {activeTab === 'overview' 
                    ? `${payoutTypes.length} payout type(s) selected. Click on any to view full breakdown.`
                    : `Viewing detailed breakdown for ${payoutTypeLabels[activeTab] || activeTab}`
                  }
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-500 transition-colors"
            >
              <X className="h-6 w-6" />
            </button>
          </div>

          {stalePayablesSummary &&
            (stalePayablesSummary.vendorStaleCount > 0 ||
              stalePayablesSummary.overrideStaleCount > 0 ||
              stalePayablesSummary.commissionStaleCount > 0) && (
              <div className="px-6 py-3 bg-amber-50 border-b border-amber-200 text-amber-950 text-sm flex flex-wrap items-center justify-between gap-3">
                <p>
                  <span className="font-semibold">Not in this date range:</span>{' '}
                  {stalePayablesSummary.vendorStaleCount + stalePayablesSummary.overrideStaleCount + stalePayablesSummary.commissionStaleCount}{' '}
                  recent paid item(s) (last {stalePayablesSummary.trailingDays} days through {ymdToLocalLabel(endDate)}) have a payout date outside{' '}
                  <span className="whitespace-nowrap">{ymdToLocalLabel(startDate)} – {ymdToLocalLabel(endDate)}</span>. Widen the range or run another NACHA to include them.
                </p>
                <button
                  type="button"
                  onClick={() => setStaleOutsideRangeOpen(true)}
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-amber-900 text-xs font-medium hover:bg-amber-100/80"
                >
                  View list
                </button>
              </div>
            )}

          {/* Tabs */}
          <div className="border-b border-gray-200">
            <div className="flex space-x-1 px-6">
              <button
                onClick={() => setActiveTab('overview')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'overview'
                    ? 'border-oe-primary text-oe-primary'
                    : 'border-transparent text-gray-500 hover:text-oe-dark hover:border-gray-300'
                }`}
              >
                Overview
              </button>
              {payoutTypes.map((payoutType) => (
                <button
                  key={payoutType}
                  onClick={() => setActiveTab(payoutType)}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === payoutType
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-oe-dark hover:border-gray-300'
                  }`}
                >
                  {payoutTypeLabels[payoutType] || payoutType}
                </button>
              ))}
              <button
                onClick={() => setActiveTab('fees')}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'fees'
                    ? 'border-oe-primary text-oe-primary'
                    : 'border-transparent text-gray-500 hover:text-oe-dark hover:border-gray-300'
                }`}
              >
                Fees
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === 'overview' 
              ? renderOverview()
              : activeTab === 'fees'
              ? renderFees()
              : activePreview 
                ? renderPayoutBreakdown(activePreview, activeTab)
                : <div className="text-center py-8 text-gray-500">Preview not found</div>
            }
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 p-4 bg-gray-50">
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                Close
              </button>
              <button
                onClick={async () => {
                  setLedgerValidationLoading(true);
                  setLedgerValidationError(null);
                  setLedgerValidationResult(null);
                  setShowLedgerValidation(true);
                  try {
                    const result = await nachaService.validateLedger({
                      tenantId: localTenantId || undefined,
                      status: 'Sent',
                      limit: 200
                    });
                    setLedgerValidationResult(result);
                  } catch (e: any) {
                    setLedgerValidationError(e?.message || 'Failed to validate NACHA ledger');
                  } finally {
                    setLedgerValidationLoading(false);
                  }
                }}
                disabled={ledgerValidationLoading}
                className="px-4 py-2 border border-gray-300 bg-white text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {ledgerValidationLoading ? (
                  <>
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    Checking...
                  </>
                ) : (
                  <>
                    <Info size={16} className="mr-2" />
                    Check for issues
                  </>
                )}
              </button>
              {onGenerate && (
                <button
                  onClick={async () => {
                    setGenerating(true);
                    setError(null);
                    try {
                      const payoutTypesToGenerate = Array.from(previews.keys());

                      // Validate required NACHA header fields (per payout type). Accept 9-digit EIN or 10 digits.
                      for (const pt of payoutTypesToGenerate) {
                        const companyId = (companyIdentificationByPayoutType[pt] || '').replace(/\D/g, '').trim();
                        if (!/^\d{9}$|^\d{10}$/.test(companyId)) {
                          setCompanyIdError(`Missing Company Identification for "${pt}". Enter 9-digit EIN or 10-digit Company ID.`);
                          setActiveTab(pt);
                          setGenerating(false);
                          return;
                        }
                      }

                      const filters: {
                        vendorIds?: string[];
                        agentIds?: string[];
                        agencyIds?: string[];
                        fundingAchAccountIdByPayoutType?: Record<string, string>;
                        companyIdentificationByPayoutType?: Record<string, string>;
                        excludedPaymentIds?: string[];
                        excludedInvoiceIds?: string[];
                      } = {};

                      // For vendor payouts, pass selected vendor IDs (empty = none selected)
                      if (vendorSelectionInitialized) {
                        filters.vendorIds = Array.from(selectedVendorIds);
                      }
                      // For agent commission payouts, pass selected agent/agencies
                      if (agentAgencySelectionInitialized) {
                        filters.agentIds = Array.from(selectedAgentIds);
                        filters.agencyIds = Array.from(selectedAgencyIds);
                      }
                      filters.fundingAchAccountIdByPayoutType = selectedFundingAchAccountIdByPayoutType;
                      filters.companyIdentificationByPayoutType = companyIdentificationByPayoutType;
                      // Per-row exclusions from preview details modal
                      if (excludedPaymentIds.size > 0) {
                        filters.excludedPaymentIds = Array.from(excludedPaymentIds);
                      }
                      if (excludedInvoiceIds.size > 0) {
                        filters.excludedInvoiceIds = Array.from(excludedInvoiceIds);
                      }

                      await onGenerate(payoutTypesToGenerate, startDate, endDate, localTenantId || undefined, filters);
                    } catch (error: any) {
                      console.error('Failed to generate NACHA files:', error);
                      setError(error?.message || 'Failed to generate NACHA files');
                    } finally {
                      setGenerating(false);
                    }
                  }}
                  disabled={
                    generating ||
                    Array.from(previews.keys()).some(pt => !/^\d{9}$|^\d{10}$/.test((companyIdentificationByPayoutType[pt] || '').replace(/\D/g, '').trim())) ||
                    (activeTab === 'Agent Commission Payouts' && agentAgencySelectionInitialized && selectedAgentIds.size === 0 && selectedAgencyIds.size === 0) ||
                    (activeTab === 'Vendor Payouts' && vendorSelectionInitialized && selectedVendorIds.size === 0)
                  }
                  className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                >
                  {generating ? (
                    <>
                      <Loader2 size={16} className="mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <CheckCircle size={16} className="mr-2" />
                      Generate NACHA Files
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {staleOutsideRangeOpen && stalePayablesSummary && (() => {
        const vendorRows = stalePayablesSummary.vendorStaleRows ?? [];
        const ovRows = stalePayablesSummary.overrideStaleRows ?? [];
        const commRows = stalePayablesSummary.commissionStaleRows ?? [];
        const anchorDates = [
          ...vendorRows.map((r) => r.anchorDate),
          ...ovRows.map((r) => r.anchorDate),
          ...commRows.map((r) => r.anchorDate),
        ]
          .filter((x): x is string => !!x)
          .sort();
        const earliest = anchorDates[0];
        const total =
          stalePayablesSummary.vendorStaleCount +
          stalePayablesSummary.overrideStaleCount +
          stalePayablesSummary.commissionStaleCount;

        const onPayRow = (r: StalePayablePaymentRow) => {
          if (r.sourceType === 'group' && r.groupId) navigateToGroupPage(r.groupId);
          else if (r.primaryMemberId) {
            setStaleOutsideRangeOpen(false);
            void openMemberModal(r.primaryMemberId);
          }
        };
        const onCommRow = (r: StalePayableCommissionRow) => {
          if (r.sourceType === 'group' && r.groupId) navigateToGroupPage(r.groupId);
          else if (r.primaryMemberId) {
            setStaleOutsideRangeOpen(false);
            void openMemberModal(r.primaryMemberId);
          }
        };

        const rowBtn =
          'text-left w-full rounded-md px-2 py-1.5 hover:bg-gray-100 text-sm border border-transparent hover:border-gray-200';

        return (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-[95] p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] flex flex-col">
            <div className="p-6 border-b border-gray-200 flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900">Paid items not in this run</h3>
              <p className="text-sm text-gray-600 mt-2 leading-relaxed">
                <span className="font-medium text-gray-800">{total}</span> payouts in the last{' '}
                {stalePayablesSummary.trailingDays} days (through {ymdToLocalLabel(endDate)}) are not included because the payout date is not
                between {ymdToLocalLabel(startDate)} and {ymdToLocalLabel(endDate)}.
                {earliest ? (
                  <>
                    {' '}
                    To include them, set the NACHA start date on or before{' '}
                    <span className="font-medium text-gray-800">{ymdToLocalLabel(earliest)}</span>, or run another NACHA for the earlier dates.
                  </>
                ) : (
                  <> Widen the start date or run another file for the earlier activity.</>
                )}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                Timing rules: vendor ={' '}
                {stalePayablesSummary.vendorBasis === 'paymentReceived'
                  ? 'invoice paid (fulfillment)'
                  : 'coverage / invoice billing period'}
                ; overrides ={' '}
                {stalePayablesSummary.overrideBasis === 'paymentReceived'
                  ? 'invoice paid (fulfillment)'
                  : 'coverage / invoice billing period'}
                ; commissions = due date / clawback date.
              </p>
              <p className="text-xs text-gray-600 mt-2 font-medium">Click a row to open the group or primary member.</p>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1 text-sm">
              {vendorRows.length > 0 && (
                <div className="mb-4">
                  <div className="font-semibold text-gray-900">Vendor ({stalePayablesSummary.vendorStaleCount})</div>
                  <ul className="mt-1 space-y-0.5">
                    {vendorRows.map((r) => (
                      <li key={r.paymentId}>
                        <button type="button" className={rowBtn} onClick={() => onPayRow(r)}>
                          <span className="text-oe-primary font-medium">{r.displayName}</span>
                          {r.invoiceNumber ? <span className="text-gray-500"> · Inv {r.invoiceNumber}</span> : null}
                          {r.anchorDate ? <span className="text-gray-500"> · {ymdToLocalLabel(r.anchorDate)}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {stalePayablesSummary.vendorStaleRowsTruncated && (
                    <p className="text-xs text-gray-500 mt-1 italic">Showing a sample; more rows exist.</p>
                  )}
                </div>
              )}
              {ovRows.length > 0 && (
                <div className="mb-4">
                  <div className="font-semibold text-gray-900">Overrides ({stalePayablesSummary.overrideStaleCount})</div>
                  <ul className="mt-1 space-y-0.5">
                    {ovRows.map((r) => (
                      <li key={`ov-${r.paymentId}`}>
                        <button type="button" className={rowBtn} onClick={() => onPayRow(r)}>
                          <span className="text-oe-primary font-medium">{r.displayName}</span>
                          {r.invoiceNumber ? <span className="text-gray-500"> · Inv {r.invoiceNumber}</span> : null}
                          {r.anchorDate ? <span className="text-gray-500"> · {ymdToLocalLabel(r.anchorDate)}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {stalePayablesSummary.overrideStaleRowsTruncated && (
                    <p className="text-xs text-gray-500 mt-1 italic">Showing a sample; more rows exist.</p>
                  )}
                </div>
              )}
              {commRows.length > 0 && (
                <div>
                  <div className="font-semibold text-gray-900">Commissions ({stalePayablesSummary.commissionStaleCount})</div>
                  <ul className="mt-1 space-y-0.5">
                    {commRows.map((r) => (
                      <li key={r.commissionId}>
                        <button type="button" className={rowBtn} onClick={() => onCommRow(r)}>
                          <span className="text-oe-primary font-medium">{r.displayName}</span>
                          {r.invoiceNumber ? <span className="text-gray-500"> · Inv {r.invoiceNumber}</span> : null}
                          {r.anchorDate ? <span className="text-gray-500"> · {ymdToLocalLabel(r.anchorDate)}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {stalePayablesSummary.commissionStaleRowsTruncated && (
                    <p className="text-xs text-gray-500 mt-1 italic">Showing a sample; more rows exist.</p>
                  )}
                </div>
              )}
              {vendorRows.length === 0 && ovRows.length === 0 && commRows.length === 0 && (
                <p className="text-gray-500 text-sm">No row samples returned. Counts: vendor {stalePayablesSummary.vendorStaleCount}, overrides {stalePayablesSummary.overrideStaleCount}, commissions {stalePayablesSummary.commissionStaleCount}.</p>
              )}
            </div>
            <div className="p-4 border-t border-gray-200 flex justify-end flex-shrink-0 bg-gray-50">
              <button
                type="button"
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300"
                onClick={() => setStaleOutsideRangeOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Error Modal - High z-index to appear on top of all modals */}
      {error && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <h3 className="ml-3 text-lg font-semibold text-gray-900">NACHA Generation Error</h3>
              </div>
              <button
                onClick={() => setError(null)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6">
              <div className="bg-red-50 border border-red-200 rounded-md p-4">
                <p className="text-sm text-red-700 whitespace-pre-wrap">{error}</p>
              </div>
              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setError(null)}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Ledger Validation Modal */}
      {showLedgerValidation && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[90]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">NACHA Ledger Check</h3>
                <p className="text-sm text-gray-600 mt-1">
                  Audits recent Sent NACHA files against `oe.NACHAPaymentDetails` and `oe.Payments` snapshots.
                </p>
              </div>
              <button
                onClick={() => {
                  setShowLedgerValidation(false);
                  setLedgerValidationError(null);
                  setLedgerValidationResult(null);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              {ledgerValidationError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
                  <p className="text-sm text-red-700 whitespace-pre-wrap">{ledgerValidationError}</p>
                </div>
              )}

              {ledgerValidationLoading && (
                <div className="bg-blue-50 border border-blue-200 rounded-md p-4 mb-4 flex items-center">
                  <Loader2 size={16} className="mr-2 animate-spin text-blue-600" />
                  <p className="text-sm text-blue-800">Running validation…</p>
                </div>
              )}

              {ledgerValidationResult && ledgerValidationResult.success && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                      <div className="text-sm text-gray-600">Files checked</div>
                      <div className="text-2xl font-bold text-gray-900">
                        {ledgerValidationResult.summary.checkedGenerations}
                      </div>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                      <div className="text-sm text-red-700">Errors</div>
                      <div className="text-2xl font-bold text-red-800">
                        {ledgerValidationResult.summary.errorCount}
                      </div>
                    </div>
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <div className="text-sm text-yellow-700">Warnings</div>
                      <div className="text-2xl font-bold text-yellow-800">
                        {ledgerValidationResult.summary.warningCount}
                      </div>
                    </div>
                  </div>

                  <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                    <div className="p-4 border-b border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-900">Issues</h4>
                      <p className="text-xs text-gray-600 mt-1">
                        Errors indicate potential overpay/mismatch conditions. Warnings are informational and may require review.
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Severity</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Message</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Context</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {ledgerValidationResult.issues.length === 0 ? (
                            <tr>
                              <td className="px-4 py-4 text-sm text-gray-600" colSpan={4}>
                                No issues found.
                              </td>
                            </tr>
                          ) : (
                            ledgerValidationResult.issues.map((issue, idx) => (
                              <tr key={idx} className="hover:bg-gray-50">
                                <td className="px-4 py-3 text-sm">
                                  <span
                                    className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                      issue.severity === 'error'
                                        ? 'bg-red-100 text-red-800'
                                        : 'bg-yellow-100 text-yellow-800'
                                    }`}
                                  >
                                    {issue.severity}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-900 font-mono">{issue.code}</td>
                                <td className="px-4 py-3 text-sm text-gray-900 whitespace-pre-wrap">{issue.message}</td>
                                <td className="px-4 py-3 text-xs text-gray-600 font-mono whitespace-pre-wrap">
                                  {[
                                    issue.nachaId ? `nachaId=${issue.nachaId}` : null,
                                    issue.payoutType ? `payoutType=${issue.payoutType}` : null,
                                    issue.paymentId ? `paymentId=${issue.paymentId}` : null,
                                    issue.recipientEntityType ? `type=${issue.recipientEntityType}` : null,
                                    issue.recipientEntityId ? `id=${issue.recipientEntityId}` : null
                                  ].filter(Boolean).join('\n')}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="border-t border-gray-200 p-4 bg-gray-50 flex justify-end">
              <button
                onClick={() => {
                  setShowLedgerValidation(false);
                  setLedgerValidationError(null);
                  setLedgerValidationResult(null);
                }}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Commission Rules Modal */}
      {selectedRulesData && (
        <NACHAPayoutRulesModal
          isOpen={showRulesModal}
          onClose={() => {
            setShowRulesModal(false);
            setSelectedRulesData(null);
          }}
          entityType={selectedRulesData.entityType}
          entityId={selectedRulesData.entityId}
          recipientName={selectedRulesData.recipientName}
          totalAmount={selectedRulesData.totalAmount}
          startDate={selectedRulesData.startDate}
          endDate={selectedRulesData.endDate}
        />
      )}

      {/* Agent Details Modal */}
      <AgentDetailsModal
        agentId={selectedAgentId || ''}
        agentName={selectedAgentName || undefined}
        isOpen={showAgentDetails}
        onClose={() => {
          setShowAgentDetails(false);
          setSelectedAgentId(null);
          setSelectedAgentName(null);
        }}
      />
      
      {/* Agency Details Modal */}
      <AgencyDetailsModal
        agencyId={selectedAgencyId || ''}
        agencyName={selectedAgencyName || undefined}
        isOpen={showAgencyDetails}
        onClose={() => {
          setShowAgencyDetails(false);
          setSelectedAgencyId(null);
          setSelectedAgencyName(null);
        }}
      />

      <ClawbackDetailsModal
        isOpen={!!clawbackTarget}
        onClose={() => setClawbackTarget(null)}
        recipientLabel={clawbackTarget?.entityName || ''}
        source={
          clawbackTarget
            ? clawbackTarget.entityType === 'Agent' || clawbackTarget.entityType === 'Agency'
              ? {
                  kind: 'commission',
                  entityType: clawbackTarget.entityType,
                  entityId: clawbackTarget.entityId,
                }
              : {
                  kind: 'payout',
                  payoutType: clawbackTarget.entityType === 'Vendor' ? 'Vendor' : 'TenantOverride',
                  recipientEntityId: clawbackTarget.entityId,
                }
            : null
        }
        onOpenMember={(memberId) => {
          setClawbackTarget(null);
          openMemberModal(memberId);
        }}
        onOpenGroup={(groupId) => navigateToGroupFromClawback(groupId)}
      />

      {/* Per-payment commission breakdown — same modal Generate Commissions Preview uses for "Details". */}
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
          breakdownSource="accounting"
        />
      )}

      {/* Payment Details Modal (Recipient's Payments) */}
      {showPaymentDetails && selectedRecipient && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h2 className="text-2xl font-semibold text-gray-900">
                  Invoices for {selectedRecipient.entityName}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  {(() => {
                    const total = paymentDetails.length;
                    const excluded = paymentDetails.reduce((n, p: any) => {
                      const pid = p.paymentId ? String(p.paymentId) : null;
                      const iid = p.invoiceId ? String(p.invoiceId) : null;
                      const isOut = (pid && excludedPaymentIds.has(pid))
                        || (iid && excludedInvoiceIds.has(iid));
                      return n + (isOut ? 1 : 0);
                    }, 0);
                    const included = Math.max(0, total - excluded);
                    return (
                      <>
                        {selectedRecipient.entityType} • {included} of {total} invoice{total === 1 ? '' : 's'} included
                        {excluded > 0 ? ` (${excluded} excluded)` : ''}
                      </>
                    );
                  })()}
                </p>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => handleExport(selectedRecipient.entityType, selectedRecipient.entityId, selectedRecipient.entityName)}
                  className="flex items-center px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                  <FileText size={16} className="mr-2" />
                  Export Statement
                </button>
                <button
                  onClick={() => {
                    setShowPaymentDetails(false);
                    setSelectedRecipient(null);
                    setPaymentDetails([]);
                  }}
                  className="text-gray-400 hover:text-gray-500 transition-colors p-2"
                >
                  <X className="h-6 w-6" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {loadingPayments ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-gray-500">Loading payment details...</div>
                </div>
              ) : paymentDetails.length === 0 ? (
                <div className="text-center py-12 text-gray-500">No payment details found</div>
              ) : (
                <>
                  {/* Summary Stats */}
                  <div className={`mb-4 grid gap-4 ${selectedRecipient.entityType === 'Agent' ? 'grid-cols-3' : selectedRecipient.entityType === 'Agency' ? 'grid-cols-2' : selectedRecipient.entityType === 'Vendor' ? 'grid-cols-2' : 'grid-cols-4'}`}>
                    <div className="bg-oe-neutral-light p-4 rounded-lg">
                      <div className="text-sm text-gray-600">Total Revenue</div>
                      <div className="text-2xl font-bold text-oe-dark">
                        {formatCurrency(paymentDetails.reduce((sum, p) => sum + (p.paymentAmount || 0), 0))}
                      </div>
                    </div>
                    {selectedRecipient.entityType === 'Agent' && (
                      <>
                        <div className="bg-oe-neutral-light p-4 rounded-lg">
                          <div className="text-sm text-gray-600">Total Commission</div>
                          <div className="text-2xl font-bold text-oe-dark">
                            {formatCurrency(paymentDetails.reduce((sum, p) => sum + (p.commissionPool || 0), 0))}
                          </div>
                        </div>
                        <div className="bg-oe-neutral-light p-4 rounded-lg">
                          <div className="text-sm text-gray-600">Total Payout</div>
                          <div className="text-2xl font-bold text-oe-dark">
                            {formatCurrency(paymentDetails.reduce((sum, p) => sum + (p.commissionAmount || 0), 0))}
                          </div>
                        </div>
                      </>
                    )}
                    {selectedRecipient.entityType === 'Agency' && (
                      <div className="bg-oe-neutral-light p-4 rounded-lg">
                        <div className="text-sm text-gray-600">Total Payout</div>
                        <div className="text-2xl font-bold text-oe-dark">
                          {formatCurrency(paymentDetails.reduce((sum, p) => sum + ((p as any).overflowAmount || 0), 0))}
                        </div>
                      </div>
                    )}
                    {selectedRecipient.entityType === 'Vendor' && (
                      <div className="bg-oe-neutral-light p-4 rounded-lg">
                        <div className="text-sm text-gray-600">Total Vendor Payout (NetRate)</div>
                        <div className="text-2xl font-bold text-oe-dark">
                          {formatCurrency(paymentDetails.reduce((sum, p) => sum + ((p as any).vendorPayout || 0), 0))}
                        </div>
                      </div>
                    )}
                    {selectedRecipient.entityType === 'Tenant' && (
                      <>
                        <div className="bg-oe-neutral-light p-4 rounded-lg">
                          <div className="text-sm text-gray-600">Total Override Rate</div>
                          <div className="text-2xl font-bold text-oe-dark">
                            {formatCurrency(paymentDetails.reduce((sum, p) => sum + ((p as any).overridePayout || 0), 0))}
                          </div>
                        </div>
                        <div className="bg-oe-neutral-light p-4 rounded-lg">
                          <div className="text-sm text-gray-600">Entity Override Payout</div>
                          <div className="text-2xl font-bold text-oe-dark">
                            {formatCurrency(paymentDetails.reduce((sum, p) => sum + (((p as any).entityOverridePayout ?? (p as any).overridePayout) || 0), 0))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Payment Details Table */}
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Member</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Payment Amount</th>
                          {selectedRecipient.entityType === 'Agent' && (
                            <>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Commission</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Commission Payout</th>
                              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Commission Group</th>
                            </>
                          )}
                          {selectedRecipient.entityType === 'Agency' && (
                            <>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Commission</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Payout</th>
                              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Commission Group</th>
                            </>
                          )}
                          {selectedRecipient.entityType === 'Vendor' && (
                            <>
                              <th className="px-4 py-3 text-right text-xs font-bold text-gray-900 uppercase">
                                NetRate (Vendor Payout)
                              </th>
                              {/* Commented out Commission and OverrideRate columns for vendors */}
                              {/* <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Commission</th> */}
                              {/* <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">OverrideRate</th> */}
                            </>
                          )}
                          {selectedRecipient.entityType === 'Tenant' && (
                            <>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Override Rate</th>
                              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Entity Override Payout</th>
                            </>
                          )}
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Households</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Products</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase" title="Uncheck to exclude this row from generated NACHA">Include</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {paymentDetails.map((payment, idx) => {
                          const totalHouseholds = calculateTotalHouseholds(payment, selectedRecipient?.entityType || '');
                          const isCreditFunded = (payment as any).fundingSource === 'Credit';
                          const rowPaymentId = payment.paymentId || null;
                          const rowInvoiceId = (payment as any).invoiceId || null;
                          const isExcluded = (rowPaymentId && excludedPaymentIds.has(rowPaymentId))
                            || (rowInvoiceId && excludedInvoiceIds.has(rowInvoiceId));
                          return (
                            <tr key={payment.paymentId || (payment as any).invoiceId || idx} className={`hover:bg-gray-50 ${isExcluded ? 'opacity-50 line-through' : ''}`}>
                              <td className="px-4 py-3 text-sm text-oe-dark">
                                <div className="flex items-center gap-2">
                                  <span>{payment.memberName}</span>
                                  {isCreditFunded && (
                                    <span
                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-800 border border-purple-200"
                                      title="Invoice was paid via household credit (no oe.Payments row). Uncheck to exclude from this NACHA."
                                    >
                                      Credit-funded
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-500">
                                {formatDate(payment.paymentDate, false)}
                              </td>
                              <td className="px-4 py-3 text-sm text-oe-dark text-right">
                                {formatCurrency(payment.paymentAmount)}
                              </td>
                            {selectedRecipient.entityType === 'Agent' && (
                              <>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency(payment.commissionPool || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm font-medium text-oe-dark text-right">
                                  {formatCurrency(payment.commissionAmount || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm text-oe-dark">
                                  {(payment as any).commissionGroupName || (
                                    <span className="text-gray-400 italic">—</span>
                                  )}
                                </td>
                              </>
                            )}
                            {selectedRecipient.entityType === 'Agency' && (
                              <>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency(payment.commissionPool || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm font-medium text-oe-dark text-right">
                                  {formatCurrency((payment as any).overflowAmount || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm text-oe-dark">
                                  {(payment as any).commissionGroupName || (
                                    <span className="text-gray-400 italic">—</span>
                                  )}
                                </td>
                              </>
                            )}
                            {selectedRecipient.entityType === 'Vendor' && (
                              <>
                                <td className="px-4 py-3 text-sm font-bold text-oe-dark text-right">
                                  {formatCurrency((payment as any).vendorPayout || 0)}
                                </td>
                                {/* Commented out Commission and OverrideRate columns for vendors */}
                                {/* <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency((payment as any).commissionPool || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency((payment as any).overrideRate || 0)}
                                </td> */}
                              </>
                            )}
                            {selectedRecipient.entityType === 'Tenant' && (
                              <>
                                <td className="px-4 py-3 text-sm text-gray-600 text-right">
                                  {formatCurrency((payment as any).overridePayout || 0)}
                                </td>
                                <td className="px-4 py-3 text-sm font-medium text-oe-dark text-right">
                                    {formatCurrency(((payment as any).entityOverridePayout ?? (payment as any).overridePayout) || 0)}
                                </td>
                              </>
                            )}
                            <td className="px-4 py-3 text-sm text-gray-600 text-right">
                              <button
                                onClick={async () => {
                                  // Open household details modal with all households from this payment
                                  await handlePaymentHouseholdsClick(payment, 1);
                                }}
                                className="text-oe-primary hover:text-blue-800 hover:underline font-medium"
                                disabled={totalHouseholds === 0}
                              >
                                {totalHouseholds || 0}
                              </button>
                            </td>
                            <td className="px-4 py-3 text-sm text-oe-dark">
                              {(() => {
                                // For Agent/Agency rows, prefer the same per-payment breakdown modal
                                // used by the Generate Commissions Preview "Details" button so the two
                                // flows show identical "who gets paid what" output. The endpoint behind
                                // that modal is paymentId-keyed, so credit-funded rows (paymentId IS NULL)
                                // fall back to the legacy product breakdown popup.
                                const supportsCommissionBreakdown =
                                  (selectedRecipient.entityType === 'Agent' || selectedRecipient.entityType === 'Agency')
                                  && !!payment.paymentId;
                                if (supportsCommissionBreakdown) {
                                  return (
                                    <button
                                      onClick={() => {
                                        setBreakdownPayment({
                                          paymentId: payment.paymentId,
                                          paymentDate: payment.paymentDate,
                                          amount: payment.paymentAmount,
                                          agentName: selectedRecipient.entityName,
                                          agentCommissionTierLevel: (payment as any).agentCommissionTierLevel ?? payment.tierLevel ?? null,
                                          clientName: payment.memberName || (payment as any).groupName || undefined
                                        });
                                      }}
                                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-xs font-medium"
                                      title="View who gets paid what for each product"
                                    >
                                      <Info className="h-4 w-4" />
                                      Details
                                    </button>
                                  );
                                }
                                return (
                                  <button
                                    onClick={async () => {
                                      const breakdown = await buildProductBreakdown(payment, selectedRecipient.entityType, selectedRecipient.entityId);
                                      if (breakdown.length === 0) {
                                        return;
                                      }
                                      await handleProductBreakdownClick(payment);
                                    }}
                                    className="text-oe-primary hover:text-oe-dark hover:underline cursor-pointer font-medium"
                                  >
                                    View breakdown
                                  </button>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <input
                                type="checkbox"
                                checked={!isExcluded}
                                disabled={!rowPaymentId && !rowInvoiceId}
                                onChange={(e) => {
                                  const include = e.target.checked;
                                  if (rowPaymentId) {
                                    setExcludedPaymentIds(prev => {
                                      const next = new Set(prev);
                                      if (include) next.delete(rowPaymentId); else next.add(rowPaymentId);
                                      return next;
                                    });
                                  }
                                  if (rowInvoiceId) {
                                    setExcludedInvoiceIds(prev => {
                                      const next = new Set(prev);
                                      if (include) next.delete(rowInvoiceId); else next.add(rowInvoiceId);
                                      return next;
                                    });
                                  }
                                }}
                                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded cursor-pointer"
                              />
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-200 p-4 bg-gray-50">
              <div className="flex items-center justify-end">
                <button
                  onClick={() => {
                    setShowPaymentDetails(false);
                    setSelectedRecipient(null);
                    setPaymentDetails([]);
                  }}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Product Breakdown Modal */}
      {showProductBreakdown && selectedPaymentForProducts && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[75]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h2 className="text-2xl font-semibold text-gray-900">
                  {selectedRecipient?.entityType === 'Vendor' ? 'Vendor Breakdown' : 'Product Breakdown'}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  {selectedPaymentForProducts.memberName} • {formatDate(selectedPaymentForProducts.paymentDate, false)}
                  {selectedRecipient && (
                    <> • Payout to: <span className="font-medium text-gray-900">{selectedRecipient.entityName}</span> ({selectedRecipient.entityType})</>
                  )}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowProductBreakdown(false);
                  setSelectedPaymentForProducts(null);
                  setProductBreakdown([]);
                  setVendorBreakdownSelectedProductId('');
                  setVendorBreakdownSelectedProductName('');
                  setVendorBreakdownHouseholds([]);
                  setVendorBreakdownHouseholdsError(null);
                }}
                className="text-gray-400 hover:text-gray-500 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {productBreakdown.length === 0 ? (
                <div className="text-center py-12 text-gray-500">No products found</div>
              ) : (
                <>
                  {/* Summary Stats */}
                  {selectedRecipient && (
                    <div className="mb-4 bg-gray-50 p-4 rounded-lg border border-gray-200">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="text-sm text-gray-600">Recipient</div>
                          <div className="text-lg font-semibold text-gray-900">{selectedRecipient.entityName}</div>
                          <div className="text-xs text-gray-500 mt-1">{selectedRecipient.entityType}</div>
                        </div>
                        <div>
                          <div className="text-sm text-gray-600">Total Payout Amount</div>
                          <div className="text-2xl font-bold text-oe-dark">
                            {formatCurrency(productBreakdown.reduce((sum, p) => sum + p.payoutAmount, 0))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Households</th>
                        {selectedRecipient?.entityType !== 'Vendor' && (
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Cost</th>
                        )}
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                          {selectedRecipient?.entityType === 'Vendor' ? 'Total Vendor Payout' : 'Payout Amount'}
                        </th>
                        {selectedRecipient?.entityType === 'Vendor' && (
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Household Breakdown</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {productBreakdown.map((product, idx) => (
                        <tr key={product.productId || idx} className={`hover:bg-gray-50 ${product.isVendorProduct ? 'bg-blue-50 font-semibold' : ''}`}>
                          <td className={`px-4 py-3 text-sm ${product.isVendorProduct ? 'text-oe-dark font-bold' : 'text-oe-dark'}`}>
                            {product.productName}
                          </td>
                          <td className={`px-4 py-3 text-sm text-right ${product.isVendorProduct ? 'font-bold text-gray-900' : 'text-gray-600'}`}>
                            {selectedRecipient?.entityType === 'Vendor' ? (
                              <span>{product.enrolledHouseholdsCount}</span>
                            ) : (
                              <button
                                onClick={async () => {
                                  // Fetch vendor info for filter dropdown
                                  try {
                                    const productsResponse = await apiService.post<{ 
                                      success: boolean; 
                                      products?: Array<{ 
                                        ProductId: string; 
                                        Name: string; 
                                        VendorId?: string;
                                        VendorName?: string;
                                      }> 
                                    }>('/api/products/batch', { productIds: [product.productId] });
                                    
                                    if (productsResponse.success && productsResponse.products && productsResponse.products.length > 0) {
                                      const p = productsResponse.products[0];
                                      setAvailableProductsForFilter([{
                                        productId: p.ProductId,
                                        productName: p.Name || p.ProductId, // Use Name, fallback to ProductId if Name is missing
                                        vendorName: p.VendorName || (p.VendorId ? 'Unknown Vendor' : 'No Vendor')
                                      }]);
                                    } else {
                                      // Fallback if product fetch fails
                                      setAvailableProductsForFilter([{
                                        productId: product.productId,
                                        productName: product.productName || product.productId,
                                        vendorName: 'Unknown Vendor'
                                      }]);
                                    }
                                  } catch (error) {
                                    console.error('Error fetching product/vendor info:', error);
                                  }
                                  
                                  setSelectedProductForHouseholds({
                                    productId: product.productId,
                                    productName: product.productName,
                                    paymentId: selectedPaymentForProducts?.paymentId || ''
                                  });
                                  setCurrentPaymentForHouseholds(selectedPaymentForProducts);
                                  setHouseholdDetailsPagination({ page: 1, limit: 50, total: 0, totalPages: 0 });
                                  setFilteredProductId(product.productId);
                                  handleHouseholdDetailsClick(product.productId, selectedPaymentForProducts?.paymentId || '', 1);
                                }}
                                className={`${product.isVendorProduct ? 'font-bold text-blue-700' : 'text-blue-600'} hover:text-blue-800 hover:underline font-medium`}
                              >
                                {product.enrolledHouseholdsCount}
                              </button>
                            )}
                          </td>
                          {selectedRecipient?.entityType !== 'Vendor' && (
                            <td className={`px-4 py-3 text-sm text-right ${product.isVendorProduct ? 'font-bold text-gray-900' : 'text-gray-600'}`}>
                              {formatCurrency(product.totalCost)}
                            </td>
                          )}
                          <td className={`px-4 py-3 text-sm text-right ${product.isVendorProduct ? 'font-bold text-oe-dark' : 'font-medium text-oe-dark'}`}>
                            {formatCurrency(product.payoutAmount)}
                          </td>
                          {selectedRecipient?.entityType === 'Vendor' && (
                            <td className="px-4 py-3 text-sm text-gray-900">
                              <button
                                type="button"
                                onClick={() => {
                                  loadVendorBreakdownHouseholds(product.productId, product.productName);
                                }}
                                className="text-oe-primary hover:text-oe-dark hover:underline font-medium"
                              >
                                View household breakdown
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50">
                      <tr>
                        <td className="px-4 py-3 text-sm font-semibold text-gray-900">Total</td>
                        <td className="px-4 py-3 text-sm font-semibold text-gray-900 text-right">
                          {productBreakdown.reduce((sum, p) => sum + p.enrolledHouseholdsCount, 0)}
                        </td>
                        {selectedRecipient?.entityType !== 'Vendor' && (
                          <td className="px-4 py-3 text-sm font-semibold text-gray-900 text-right">
                            {formatCurrency(productBreakdown.reduce((sum, p) => sum + p.totalCost, 0))}
                          </td>
                        )}
                        <td className="px-4 py-3 text-sm font-semibold text-oe-dark text-right">
                          {formatCurrency(productBreakdown.reduce((sum, p) => sum + p.payoutAmount, 0))}
                        </td>
                        {selectedRecipient?.entityType === 'Vendor' && <td className="px-4 py-3" />}
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {selectedRecipient?.entityType === 'Vendor' && vendorBreakdownSelectedProductId && (
                  <div className="mt-6 bg-white rounded-lg border border-gray-200 overflow-hidden">
                    <div className="p-4 border-b border-gray-200 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-gray-900">Household breakdown</h3>
                        <p className="text-xs text-gray-600 mt-1 truncate">
                          {vendorBreakdownSelectedProductName}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={vendorBreakdownSelectedProductId}
                          onChange={(e) => {
                            const newProductId = e.target.value;
                            const product = productBreakdown.find((p) => p.productId === newProductId);
                            if (product) loadVendorBreakdownHouseholds(product.productId, product.productName);
                          }}
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                        >
                          {productBreakdown.map((p) => (
                            <option key={p.productId} value={p.productId}>
                              {p.productName}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            setVendorBreakdownSelectedProductId('');
                            setVendorBreakdownSelectedProductName('');
                            setVendorBreakdownHouseholds([]);
                            setVendorBreakdownHouseholdsError(null);
                          }}
                          className="px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm"
                        >
                          Hide
                        </button>
                      </div>
                    </div>

                    {vendorBreakdownHouseholdsError && (
                      <div className="p-4 bg-red-50 border-b border-red-200 text-red-800 text-sm">
                        {vendorBreakdownHouseholdsError}
                      </div>
                    )}

                    <div className="p-4">
                      {vendorBreakdownHouseholdsLoading ? (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 className="h-5 w-5 animate-spin text-oe-primary" />
                          <span className="ml-2 text-sm text-gray-600">Loading households…</span>
                        </div>
                      ) : vendorBreakdownHouseholds.length === 0 ? (
                        <div className="py-8 text-center text-sm text-gray-500">No households found.</div>
                      ) : (
                        <>
                          {(() => {
                            const expected = Number(
                              productBreakdown.find((p) => p.productId === vendorBreakdownSelectedProductId)?.payoutAmount || 0
                            );
                            const actual = vendorBreakdownHouseholds.reduce(
                              (sum: number, h: any) => sum + Number(h?.entityPayout || 0),
                              0
                            );
                            const delta = Math.abs(expected - actual);
                            if (delta <= 0.009) return null;
                            return (
                              <div className="mb-4 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-3 text-sm">
                                Household breakdown total <span className="font-semibold">{formatCurrency(actual)}</span> does not match expected{' '}
                                <span className="font-semibold">{formatCurrency(expected)}</span> for this product.
                              </div>
                            );
                          })()}
                          <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Household</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tier</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Vendor net rate</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {vendorBreakdownHouseholds.map((h: any, idx: number) => (
                                <tr key={h.householdId || idx} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 text-sm text-gray-900">
                                    {h.primaryMemberId ? (
                                      <button
                                        type="button"
                                        onClick={() => openMemberModal(h.primaryMemberId)}
                                        className="text-oe-primary hover:text-oe-dark hover:underline font-medium"
                                      >
                                        {h.householdName || '—'}
                                      </button>
                                    ) : (
                                      <span>{h.householdName || '—'}</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-2 text-sm text-gray-600">
                                    {h.householdTier || '—'}
                                  </td>
                                  <td className="px-4 py-2 text-sm text-right font-medium text-gray-900">
                                    {formatCurrency(Number(h.entityPayout || 0))}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-200 p-4 bg-gray-50">
              <div className="flex items-center justify-end">
                <button
                  onClick={() => {
                    setShowProductBreakdown(false);
                    setSelectedPaymentForProducts(null);
                    setProductBreakdown([]);
                    setVendorBreakdownSelectedProductId('');
                    setVendorBreakdownSelectedProductName('');
                    setVendorBreakdownHouseholds([]);
                    setVendorBreakdownHouseholdsError(null);
                  }}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Household Details Modal */}
      {showHouseholdDetails && selectedProductForHouseholds && selectedRecipient && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[85]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div className="flex-1">
                <h2 className="text-2xl font-semibold text-gray-900">
                  Household Details
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  {selectedRecipient.entityName} ({selectedRecipient.entityType})
                </p>
                
                {/* Product/Vendor Filter Dropdown */}
                {availableProductsForFilter.length > 0 && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Filter by Product/Vendor
                    </label>
                    <select
                      value={filteredProductId}
                      onChange={(e) => {
                        const newProductId = e.target.value;
                        setFilteredProductId(newProductId);
                        // Reload household details for the selected product
                        if (newProductId === 'ALL' && currentPaymentForHouseholds) {
                          // When "ALL" is selected, aggregate households from ALL products (not just filtered breakdown)
                          handlePaymentHouseholdsClick(currentPaymentForHouseholds, 1);
                        } else if (newProductId !== 'ALL' && currentPaymentForHouseholds) {
                          handleHouseholdDetailsClick(newProductId, currentPaymentForHouseholds.paymentId || '', 1);
                        }
                      }}
                      className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                    >
                      <option value="ALL">All Products</option>
                      {availableProductsForFilter.map((product) => {
                        // Ensure we don't show productId as productName
                        const displayName = product.productName && product.productId !== product.productName 
                          ? product.productName 
                          : 'Unknown Product';
                        const displayVendor = product.vendorName && product.vendorName !== 'Unknown Vendor' && product.vendorName !== 'No Vendor'
                          ? product.vendorName
                          : '';
                        return (
                          <option key={product.productId} value={product.productId}>
                            {displayName}{displayVendor ? ` (${displayVendor})` : ''}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  setShowHouseholdDetails(false);
                  setSelectedProductForHouseholds(null);
                  setHouseholdDetails([]);
                  setCurrentPaymentForHouseholds(null);
                  setAvailableProductsForFilter([]);
                  setFilteredProductId('ALL');
                }}
                className="text-gray-400 hover:text-gray-500 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {householdDetailsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-oe-primary" />
                </div>
              ) : householdDetails.length === 0 ? (
                <div className="text-center py-12 text-gray-500">No households found</div>
              ) : (
                <>
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Household</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Tier</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Age Band</th>
                          {householdConfigFieldName && (
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                              {householdConfigFieldName}
                            </th>
                          )}
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Household Payment</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                            {selectedRecipient.entityType === 'Vendor' 
                              ? 'Vendor Payout' 
                              : selectedRecipient.entityType === 'Agent' 
                              ? 'Agent Payout' 
                              : selectedRecipient.entityType === 'Agency' 
                              ? 'Agency Payout' 
                              : selectedRecipient.entityType === 'Tenant' 
                              ? 'Override Payout' 
                              : 'Entity Payout'}
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Fees</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {householdDetails.map((household, idx) => (
                          <tr key={household.householdId || idx} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm text-gray-900">
                              {household.householdName}
                            </td>
                            <td className="px-4 py-3 text-sm text-center">
                              {household.householdTier ? (
                                <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                                  {household.householdTier}
                                </span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-center text-gray-600">
                              {household.ageBand || <span className="text-gray-400">—</span>}
                            </td>
                            {householdConfigFieldName && (
                              <td className="px-4 py-3 text-right text-sm text-gray-600">
                                {household.configValue || <span className="text-gray-400">—</span>}
                              </td>
                            )}
                            <td className="px-4 py-3 text-sm text-gray-600 text-right">
                              {household.householdPayment !== null && household.householdPayment !== undefined 
                                ? formatCurrency(household.householdPayment) 
                                : <span className="text-gray-400">—</span>}
                            </td>
                            <td className="px-4 py-3 text-sm font-medium text-oe-dark text-right">
                              {formatCurrency(household.entityPayout)}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600 text-right">
                              <div className="relative group">
                                <span className="cursor-help">
                                  {formatCurrency((household.totalFees || 0))}
                                </span>
                                {(household.systemFees || 0) > 0 || (household.processingFees || 0) > 0 ? (
                                  <div className="absolute right-0 bottom-full mb-2 hidden group-hover:block z-10 bg-gray-900 text-white text-xs rounded-lg py-2 px-3 shadow-lg whitespace-nowrap">
                                    <div className="mb-1">
                                      <span className="font-semibold">System Fees:</span> {formatCurrency(household.systemFees || 0)}
                                    </div>
                                    <div>
                                      <span className="font-semibold">Processing Fees:</span> {formatCurrency(household.processingFees || 0)}
                                    </div>
                                    <div className="absolute bottom-0 right-4 transform translate-y-full">
                                      <div className="border-4 border-transparent border-t-gray-900"></div>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {householdDetailsPagination.totalPages > 1 && (
                    <div className="mt-4 flex items-center justify-between">
                      <div className="text-sm text-gray-600">
                        Showing {((householdDetailsPagination.page - 1) * householdDetailsPagination.limit) + 1} to{' '}
                        {Math.min(householdDetailsPagination.page * householdDetailsPagination.limit, householdDetailsPagination.total)} of{' '}
                        {householdDetailsPagination.total} households
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            if (householdDetailsPagination.page > 1) {
                              // Use appropriate handler based on whether we're showing all products or a specific product
                              if (selectedProductForHouseholds.productId === 'ALL' && currentPaymentForHouseholds) {
                                handlePaymentHouseholdsClick(currentPaymentForHouseholds, householdDetailsPagination.page - 1);
                              } else {
                                handleHouseholdDetailsClick(
                                  selectedProductForHouseholds.productId,
                                  selectedProductForHouseholds.paymentId,
                                  householdDetailsPagination.page - 1
                                );
                              }
                            }
                          }}
                          disabled={householdDetailsPagination.page === 1}
                          className="px-3 py-1 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Previous
                        </button>
                        <span className="text-sm text-gray-600">
                          Page {householdDetailsPagination.page} of {householdDetailsPagination.totalPages}
                        </span>
                        <button
                          onClick={() => {
                            if (householdDetailsPagination.page < householdDetailsPagination.totalPages) {
                              // Use appropriate handler based on whether we're showing all products or a specific product
                              if (selectedProductForHouseholds.productId === 'ALL' && currentPaymentForHouseholds) {
                                handlePaymentHouseholdsClick(currentPaymentForHouseholds, householdDetailsPagination.page + 1);
                              } else {
                                handleHouseholdDetailsClick(
                                  selectedProductForHouseholds.productId,
                                  selectedProductForHouseholds.paymentId,
                                  householdDetailsPagination.page + 1
                                );
                              }
                            }
                          }}
                          disabled={householdDetailsPagination.page === householdDetailsPagination.totalPages}
                          className="px-3 py-1 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-200 p-4 bg-gray-50">
              <div className="flex items-center justify-end">
                <button
                  onClick={() => {
                    setShowHouseholdDetails(false);
                    setSelectedProductForHouseholds(null);
                    setHouseholdDetails([]);
                  }}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ACH Details Modal */}
      {showACHDetails && achDetails && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[80]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h2 className="text-2xl font-semibold text-gray-900">
                  ACH Account Details
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  {achDetails.isSplit 
                    ? `${achDetails.accounts.length} ACH account${achDetails.accounts.length > 1 ? 's' : ''} with payment splits`
                    : 'Routing and account number for confirmation'}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowACHDetails(false);
                  setAchDetails(null);
                  setAchDetailsError(null);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto flex-1">
              {achDetailsError ? (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-red-800">{achDetailsError}</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {achDetails.isSplit && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Info className="h-5 w-5 text-oe-primary" />
                        <p className="text-sm font-medium text-blue-900">
                          Payment Split Configuration
                        </p>
                      </div>
                      <p className="text-xs text-blue-800">
                        This vendor has {achDetails.accounts.length} active ACH account{achDetails.accounts.length > 1 ? 's' : ''}. 
                        Payments will be split according to the distribution percentages shown below.
                        {achDetails.totalDistribution !== 100 && (
                          <span className="block mt-1 font-semibold text-red-600">
                            ⚠️ Total distribution: {achDetails.totalDistribution.toFixed(2)}% 
                            {achDetails.totalDistribution > 100 ? ' (exceeds 100%)' : ' (less than 100%)'}
                          </span>
                        )}
                      </p>
                    </div>
                  )}

                  {achDetails.accounts.map((account, index) => (
                    <div key={account.achAccountId || index} className="border border-gray-200 rounded-lg p-4">
                      {achDetails.isSplit && (
                        <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-200">
                          <h3 className="text-lg font-semibold text-gray-900">
                            Account {index + 1} of {achDetails.accounts.length}
                          </h3>
                          <div className="flex items-center gap-2">
                            {account.isDefault && (
                              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                Default
                              </span>
                            )}
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-blue-100 text-blue-800">
                              {account.distributionPercentage.toFixed(2)}% Distribution
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Holder Name
                          </label>
                          <p className="text-sm text-gray-900 bg-gray-50 p-2 rounded border border-gray-200">
                            {account.accountHolderName}
                          </p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Bank Name
                          </label>
                          <p className="text-sm text-gray-900 bg-gray-50 p-2 rounded border border-gray-200">
                            {account.bankName || 'N/A'}
                          </p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Type
                          </label>
                          <p className="text-sm text-gray-900 bg-gray-50 p-2 rounded border border-gray-200">
                            {account.accountType}
                          </p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Verification Status
                          </label>
                          <p className="text-sm text-gray-900 bg-gray-50 p-2 rounded border border-gray-200">
                            {account.verificationStatus || 'N/A'}
                          </p>
                        </div>
                      </div>

                      <div className="border-t border-gray-200 pt-4">
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                          <p className="text-xs text-blue-800 font-medium mb-2">
                            ⚠️ Sensitive Information - For Confirmation Only
                          </p>
                          <p className="text-xs text-oe-primary-dark">
                            Please verify these details match your records before generating the NACHA file.
                          </p>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Routing Number
                            </label>
                            <p className="text-sm font-mono text-gray-900 bg-gray-50 p-3 rounded border-2 border-gray-300 font-semibold">
                              {account.routingNumber || 'N/A'}
                            </p>
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Account Number
                            </label>
                            <p className="text-sm font-mono text-gray-900 bg-gray-50 p-3 rounded border-2 border-gray-300 font-semibold">
                              {account.accountNumber ? `****${account.accountNumber.slice(-4)}` : 'N/A'}
                            </p>
                          </div>
                        </div>

                        {account.accountNumberLast4 && (
                          <div className="mt-2">
                            <p className="text-xs text-gray-500">
                              Last 4 digits: {account.accountNumberLast4}
                            </p>
                          </div>
                        )}

                        {!achDetails.isSplit && account.isDefault && (
                          <div className="mt-4">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              Default Account
                            </span>
                          </div>
                        )}

                        {achDetails.accountSource === 'ProductOverrideACH' && (
                          <div className="mt-4">
                            <p className="text-xs text-gray-500 italic">
                              Source: Product Override ACH Account
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-200 p-4 bg-gray-50">
              <div className="flex items-center justify-end">
                <button
                  onClick={() => {
                    setShowACHDetails(false);
                    setAchDetails(null);
                    setAchDetailsError(null);
                  }}
                  className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {vendorNachaOmittedModalVendorId && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Sources not in this NACHA</h3>
                <p className="text-xs text-gray-500 mt-1">
                  {ymdToLocalLabel(startDate)} – {ymdToLocalLabel(endDate)} · vendor share is the full JSON slice
                  for this vendor (not adjusted for ACH split %).
                </p>
              </div>
              <button
                type="button"
                className="text-gray-500 hover:text-gray-700 p-1 rounded"
                onClick={() => setVendorNachaOmittedModalVendorId(null)}
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-auto flex-1 p-4">
              {(() => {
                const snap = vendorNachaOmittedByVendorId[vendorNachaOmittedModalVendorId];
                const rows = snap?.rows || [];
                if (!rows.length) {
                  return <p className="text-sm text-gray-600">No omitted sources loaded.</p>;
                }
                return (
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-gray-600">
                        <th className="py-2 pr-3">Member</th>
                        <th className="py-2 pr-3">Group</th>
                        <th className="py-2 pr-3">Type</th>
                        <th className="py-2 pr-3 text-right">Vendor share</th>
                        <th className="py-2 pr-3">Dates</th>
                        <th className="py-2">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr
                          key={`${r.anchorType}-${r.invoiceId || r.paymentId || r.memberName}`}
                          className="border-b border-gray-100 align-top"
                        >
                          <td className="py-2 pr-3">
                            {r.primaryMemberId ? (
                              <button
                                type="button"
                                className="text-oe-primary hover:underline font-medium text-left"
                                onClick={() => void openMemberModal(r.primaryMemberId!)}
                              >
                                {r.memberName}
                              </button>
                            ) : (
                              <span>{r.memberName}</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            {r.groupId && r.groupName ? (
                              <button
                                type="button"
                                className="text-oe-primary hover:underline font-medium text-left"
                                onClick={() => {
                                  if (!window.confirm('Leave this screen and open the group page?')) return;
                                  setVendorNachaOmittedModalVendorId(null);
                                  navigateToGroupFromClawback(r.groupId!);
                                }}
                              >
                                {r.groupName}
                              </button>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            {r.anchorType === 'orphan_payment' ? (
                              <span className="text-xs font-medium text-orange-800 bg-orange-50 px-2 py-0.5 rounded">
                                Orphan payment
                              </span>
                            ) : (
                              <span className="text-xs font-medium text-gray-700 bg-gray-100 px-2 py-0.5 rounded">
                                Invoice
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right font-medium whitespace-nowrap">
                            {formatCurrency(r.vendorShare)}
                          </td>
                          <td className="py-2 pr-3 text-xs text-gray-700 whitespace-nowrap">
                            {r.paymentDate ? <div>{formatDate(r.paymentDate)}</div> : <div>—</div>}
                            {r.billingPeriodStart && r.billingPeriodEnd ? (
                              <div className="text-gray-500">
                                {formatDate(r.billingPeriodStart)} – {formatDate(r.billingPeriodEnd)}
                              </div>
                            ) : null}
                          </td>
                          <td className="py-2 text-xs text-gray-600">{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              })()}
            </div>
            <div className="border-t border-gray-200 px-4 py-3 flex justify-end bg-gray-50 rounded-b-lg">
              <button
                type="button"
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
                onClick={() => setVendorNachaOmittedModalVendorId(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
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
          overlayZIndexClass="z-[90]"
          nestedOverlayZIndexClass="z-[100]"
        />
      )}
    </>
  );
};

export default NACHAOverviewModal;
