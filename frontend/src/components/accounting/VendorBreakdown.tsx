import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Calendar, HelpCircle, Loader, RefreshCcw, User, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getVendorAchDetails, getVendorBreakdown, getVendorBreakdownDetails, getVendorBreakdownFilterOptions, getVendorCoveredUnpaid, getVendorInvoiceRows, CoveredUnpaidEnrollment, VendorBreakdownRow, VendorInvoiceRow } from '../../services/accounting/vendorBreakdown.service';
import { CommissionHoldSettings } from '../../services/accounting/commissionBreakdown.service';
import { apiService } from '../../services/api.service';
import { useAuth } from '../../contexts/AuthContext';
import { Member } from '../../types/member.types';
import MemberManagementModal from '../../pages/members/MemberManagementModal';
import SearchableDropdown from '../common/SearchableDropdown';
import PaymentVendorBreakdownModal from './PaymentVendorBreakdownModal';
import ClawbackDetailsModal from './ClawbackDetailsModal';

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

/**
 * Sub-section renderer for the Covered-but-Unpaid panel. Used twice — once for
 * "covered, invoice unpaid" and once for "covered, no invoice exists" — so the
 * UI can split the warning into the two distinct billing-engine outcomes.
 */
function CoveredUnpaidBucket({
  title,
  description,
  rows,
  openMemberModal,
  requestGroupNavigate,
  formatCurrency,
}: {
  title: string;
  description: string;
  rows: CoveredUnpaidEnrollment[];
  openMemberModal: (memberId: string) => void;
  requestGroupNavigate: (groupId: string | null, groupName: string | null) => void;
  formatCurrency: (n: number) => string;
}) {
  return (
    <div>
      <div className="px-4 py-2 bg-amber-50/60">
        <div className="font-medium text-gray-900 text-sm">
          {title}
          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-200">
            {rows.length}
          </span>
        </div>
        <div className="text-xs text-gray-600">{description}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Primary Member</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Group / Individual</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tier</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor Net Rate</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {rows.map((row) => (
              <tr key={row.enrollmentId}>
                <td className="px-4 py-2 text-sm text-gray-900">
                  {row.memberId ? (
                    <button
                      type="button"
                      onClick={() => openMemberModal(row.memberId)}
                      className="text-oe-primary hover:text-oe-dark hover:underline font-medium"
                    >
                      {row.primaryMemberName || 'Unknown'}
                    </button>
                  ) : (
                    row.primaryMemberName || 'Unknown'
                  )}
                </td>
                <td className="px-4 py-2 text-sm text-gray-700">
                  {row.groupName && row.groupId ? (
                    <span className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => requestGroupNavigate(row.groupId, row.groupName)}
                        className="text-oe-primary hover:text-oe-dark hover:underline font-medium"
                      >
                        {row.groupName}
                      </button>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600 uppercase tracking-wide">Group</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600 uppercase tracking-wide">Individual</span>
                  )}
                </td>
                <td className="px-4 py-2 text-sm text-gray-900">{row.productName}</td>
                <td className="px-4 py-2 text-sm text-gray-700">{row.pricingTier || '—'}</td>
                <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(row.netRate)}</td>
              </tr>
            ))}
            <tr className="bg-amber-50/60 font-medium">
              <td colSpan={4} className="px-4 py-2 text-sm text-gray-900 text-right">Subtotal:</td>
              <td className="px-4 py-2 text-sm text-gray-900 text-right">
                {formatCurrency(rows.reduce((s, r) => s + Number(r.netRate || 0), 0))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
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

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
}

/** Matches tenant AdvancedSettings payouts.vendorBasis (Unified Tenant Settings → Payouts). */
function vendorBreakdownBasisCallout(basis: string | null | undefined): { headline: string; detail: string } {
  if (basis === 'paymentReceived') {
    return {
      headline: 'Payout window: invoice paid (fulfillment date)',
      detail:
        '“Pay when payment is received” is enabled. This view includes Paid invoices whose fulfillment date (when the invoice became fully funded) falls in the date range below. Rows without a linked invoice still use the cash transaction date.',
    };
  }
  return {
    headline: 'Payout window: coverage period (invoice billing dates)',
    detail:
      '“Pay when coverage is effective” is enabled. This view includes Paid invoices whose billing period overlaps the date range below. Rows without a linked invoice still use the cash transaction date.',
  };
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

interface VendorBreakdownProps {
  holdSettings?: CommissionHoldSettings | null;
}

const VendorBreakdown: React.FC<VendorBreakdownProps> = ({ holdSettings = null }) => {
  const today = useMemo(() => new Date(), []);
  const [startDate, setStartDate] = useState(toYmd(startOfLastMonth(today)));
  const [endDate, setEndDate] = useState(holdSettings?.safeEndDate || toYmd(today));
  const [rows, setRows] = useState<VendorBreakdownRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [achLoading, setAchLoading] = useState(false);
  const [achError, setAchError] = useState<string | null>(null);
  const [showAchModal, setShowAchModal] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<{ vendorId: string; vendorName: string } | null>(null);
  const [clawbackVendor, setClawbackVendor] = useState<{ vendorId: string; vendorName: string } | null>(null);
  const [achDetails, setAchDetails] = useState<any | null>(null);
  const [showBreakdownModal, setShowBreakdownModal] = useState(false);
  const [breakdownData, setBreakdownData] = useState<any | null>(null);
  const [breakdownVendorPayoutBasis, setBreakdownVendorPayoutBasis] = useState<string | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const [breakdownTab, setBreakdownTab] = useState<'breakdown' | 'invoices'>('breakdown');
  const [invoiceRows, setInvoiceRows] = useState<VendorInvoiceRow[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  // Pending payout amount from the parent vendor row (matches the Unpaid column).
  // Sourced from VendorBreakdownRow.pendingPayoutAmount — invoice-anchored math.
  // Authoritative "Ready for payout" number sourced from the parent table row.
  // This is invoice-anchored math: vendor share of paid invoices in window
  // minus NACHA already disbursed for those payments. Matches the table's
  // Unpaid column so the modal headline never disagrees with it.
  const [vendorRowPendingPayout, setVendorRowPendingPayout] = useState<number>(0);
  // Amount paid to vendor via NACHA files dated within the selected window.
  // Used as the optional "already paid out from this period" sub-note.
  const [vendorRowPaidOutInWindow, setVendorRowPaidOutInWindow] = useState<number>(0);
  const [paidStatus, setPaidStatus] = useState<'all' | 'paid' | 'unpaid'>('all');
  const [filterOptions, setFilterOptions] = useState<any[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [mainTableFilter, setMainTableFilter] = useState<string>('all');
  const [mainTableFilterOptions, setMainTableFilterOptions] = useState<any[]>([]);
  const [mainTableFilterLoading, setMainTableFilterLoading] = useState(false);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [coveredUnpaid, setCoveredUnpaid] = useState<CoveredUnpaidEnrollment[]>([]);
  const [coveredInvoiceUnpaid, setCoveredInvoiceUnpaid] = useState<CoveredUnpaidEnrollment[]>([]);
  const [coveredNoInvoice, setCoveredNoInvoice] = useState<CoveredUnpaidEnrollment[]>([]);
  const [coveredUnpaidLoading, setCoveredUnpaidLoading] = useState(false);
  const [showCoveredUnpaid, setShowCoveredUnpaid] = useState(false);
  const breakdownRequestSeqRef = useRef(0);
  const invoicesRequestSeqRef = useRef(0);
  const coveredUnpaidSeqRef = useRef(0);

  const navigate = useNavigate();
  const { user } = useAuth();
  const [memberModalMember, setMemberModalMember] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<EnrollmentRow[]>([]);
  const [memberModalLoading, setMemberModalLoading] = useState(false);
  const [groupNavigateConfirm, setGroupNavigateConfirm] = useState<{ groupId: string; groupName: string } | null>(null);
  const [paymentBreakdown, setPaymentBreakdown] = useState<{
    paymentId: string;
    paymentDate?: string;
    paymentAmount?: number;
    sourceName?: string;
  } | null>(null);

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
    } finally {
      setMemberModalLoading(false);
    }
  };

  const requestGroupNavigate = (groupId?: string | null, groupName?: string | null) => {
    if (!groupId) return;
    setGroupNavigateConfirm({ groupId: String(groupId), groupName: groupName || 'this group' });
  };

  const confirmGroupNavigate = () => {
    if (!groupNavigateConfirm) return;
    const { groupId } = groupNavigateConfirm;
    const role = user?.currentRole || 'TenantAdmin';
    setGroupNavigateConfirm(null);
    setShowBreakdownModal(false);
    if (role === 'Agent') navigate(`/agent/groups/${groupId}`);
    else if (role === 'TenantAdmin') navigate(`/tenant-admin/groups/${groupId}`);
    else navigate(`/admin/groups/${groupId}`);
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      // Parse filter to get groupId, householdId, or individuals
      const [filterType, filterId] = mainTableFilter === 'all' ? ['all', null] : mainTableFilter.split('_');
      const params: any = { startDate, endDate };
      
      if (filterType === 'group') {
        params.groupId = filterId;
      } else if (filterType === 'individuals') {
        params.individuals = 'true';
      }

      const res = await getVendorBreakdown(params);
      if (res?.success) {
        setRows(res.data || []);
      } else {
        setRows([]);
        setError('Failed to load vendor breakdown');
      }
    } catch (e: any) {
      setRows([]);
      setError(e?.message || 'Failed to load vendor breakdown');
    } finally {
      setLoading(false);
    }
  };

  const fetchMainTableFilterOptions = async () => {
    setMainTableFilterLoading(true);
    try {
      // Get filter options for all vendors (no vendorId specified)
      const res = await getVendorBreakdownFilterOptions({
        startDate,
        endDate
      });
      if (res?.success) {
        setMainTableFilterOptions(res.data || []);
      }
    } catch (e: any) {
      console.error('Failed to load filter options:', e);
    } finally {
      setMainTableFilterLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, mainTableFilter]);

  // Fetch filter options when date range changes
  useEffect(() => {
    fetchMainTableFilterOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  useEffect(() => {
    if (holdSettings?.safeEndDate) {
      setEndDate(holdSettings.safeEndDate);
    }
  }, [holdSettings?.safeEndDate]);

  const totalPaidInRangeAmount = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.paidInRangeAmount || 0), 0),
    [rows]
  );
  const totalUnpaidAmount = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.pendingPayoutAmount || 0), 0),
    [rows]
  );
  const totalPendingClawbackAmount = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.pendingClawbackAmount || 0), 0),
    [rows]
  );

  const openAchModal = async (vendorId: string, vendorName: string) => {
    setSelectedVendor({ vendorId, vendorName });
    setShowAchModal(true);
    setAchLoading(true);
    setAchError(null);
    setAchDetails(null);
    try {
      const res = await getVendorAchDetails(vendorId);
      if (res?.success) {
        setAchDetails(res.data);
      } else {
        setAchError('Failed to load ACH details');
      }
    } catch (e: any) {
      setAchError(e?.message || 'Failed to load ACH details');
    } finally {
      setAchLoading(false);
    }
  };

  const openBreakdownModal = async (vendorId: string, vendorName: string, openUnpaidOnly: boolean = false) => {
    const requestId = ++breakdownRequestSeqRef.current;
    const initialPaidStatus: 'all' | 'paid' | 'unpaid' = openUnpaidOnly ? 'unpaid' : 'all';
    // Snapshot the parent vendor row totals so the modal headline matches
    // the table's Unpaid column (invoice-anchored, authoritative) instead of
    // the per-row breakdown sum which can drift slightly due to a different
    // aggregation algorithm.
    const parentRow = rows.find(r => r.vendorId === vendorId);
    setVendorRowPendingPayout(Number(parentRow?.pendingPayoutAmount || 0));
    setVendorRowPaidOutInWindow(Number(parentRow?.paidOutAmount || 0));
    setSelectedVendor({ vendorId, vendorName });
    setShowBreakdownModal(true);
    setSelectedFilter('all');
    setPaidStatus(initialPaidStatus);
    setBreakdownTab('breakdown');
    setBreakdownLoading(true);
    setBreakdownError(null);
    setBreakdownData(null);
    setBreakdownVendorPayoutBasis(null);
    setInvoiceRows([]);
    setInvoicesError(null);
    setFilterOptionsLoading(true);
    setCoveredUnpaid([]);
    setCoveredInvoiceUnpaid([]);
    setCoveredNoInvoice([]);
    setShowCoveredUnpaid(false);
    
    try {
      // Load filter options
      const filterRes = await getVendorBreakdownFilterOptions({
        vendorId,
        startDate,
        endDate
      });
      if (requestId !== breakdownRequestSeqRef.current) return;
      if (filterRes?.success) {
        setFilterOptions(filterRes.data || []);
      }

      // Load breakdown data
      const res = await getVendorBreakdownDetails({
        vendorId,
        startDate,
        endDate,
        paidStatus: initialPaidStatus
      });
      if (requestId !== breakdownRequestSeqRef.current) return;
      if (res?.success) {
        setBreakdownData(res.data);
        setBreakdownVendorPayoutBasis(res.vendorPayoutBasis ?? null);
        fetchCoveredUnpaid(vendorId, 'all');
      } else {
        setBreakdownError('Failed to load breakdown');
      }
    } catch (e: any) {
      if (requestId !== breakdownRequestSeqRef.current) return;
      setBreakdownError(e?.message || 'Failed to load breakdown');
    } finally {
      if (requestId !== breakdownRequestSeqRef.current) return;
      setBreakdownLoading(false);
      setFilterOptionsLoading(false);
    }
  };

  const fetchInvoices = async (
    vendorId: string,
    filterValue: string,
    paidStatusOverride?: 'all' | 'paid' | 'unpaid'
  ) => {
    const requestId = ++invoicesRequestSeqRef.current;
    setInvoicesLoading(true);
    setInvoicesError(null);
    try {
      const [filterType, filterId] = filterValue === 'all' ? ['all', null] : filterValue.split('_');
      const effectivePaidStatus = paidStatusOverride || paidStatus;
      const params: any = { vendorId, startDate, endDate };

      if (filterType === 'group') {
        params.groupId = filterId;
      } else if (filterType === 'individuals') {
        params.individuals = 'true';
      }

      const res = await getVendorInvoiceRows({ ...params, paidStatus: effectivePaidStatus });
      if (requestId !== invoicesRequestSeqRef.current) return;
      if (res?.success) {
        // Invoices are scoped by BillingPeriod overlap on the backend; no extra
        // client-side date filter needed (an invoice with period 4/1-4/24 paid
        // on 4/28 should still appear when the window is 4/1-4/24).
        setInvoiceRows(res.data || []);
      } else {
        setInvoiceRows([]);
        setInvoicesError('Failed to load invoices');
      }
    } catch (e: any) {
      if (requestId !== invoicesRequestSeqRef.current) return;
      setInvoiceRows([]);
      setInvoicesError(e?.message || 'Failed to load invoices');
    } finally {
      if (requestId !== invoicesRequestSeqRef.current) return;
      setInvoicesLoading(false);
    }
  };

  const fetchCoveredUnpaid = async (vendorId: string, filterValue: string) => {
    const requestId = ++coveredUnpaidSeqRef.current;
    setCoveredUnpaidLoading(true);
    try {
      const [filterType, filterId] = filterValue === 'all' ? ['all', null] : filterValue.split('_');
      const params: any = { vendorId, startDate, endDate };
      if (filterType === 'group') {
        params.groupId = filterId;
      } else if (filterType === 'individuals') {
        params.individuals = 'true';
      }
      const res = await getVendorCoveredUnpaid(params);
      if (requestId !== coveredUnpaidSeqRef.current) return;
      const all = res?.success ? (res.data || []) : [];
      setCoveredUnpaid(all);
      // Prefer split arrays from backend; fall back to deriving from `bucket`
      // on each row (or, last resort, treat all as covered-no-invoice for
      // backward compatibility before the BE split shipped).
      const splitInvoiceUnpaid = res?.coveredInvoiceUnpaid
        ?? all.filter(r => r.bucket === 'covered-invoice-unpaid');
      const splitNoInvoice = res?.coveredNoInvoice
        ?? all.filter(r => r.bucket === 'covered-no-invoice' || !r.bucket);
      setCoveredInvoiceUnpaid(splitInvoiceUnpaid);
      setCoveredNoInvoice(splitNoInvoice);
    } catch {
      if (requestId !== coveredUnpaidSeqRef.current) return;
      setCoveredUnpaid([]);
      setCoveredInvoiceUnpaid([]);
      setCoveredNoInvoice([]);
    } finally {
      if (requestId !== coveredUnpaidSeqRef.current) return;
      setCoveredUnpaidLoading(false);
    }
  };

  const handleFilterChange = async (value: string, _label: string) => {
    const requestId = ++breakdownRequestSeqRef.current;
    setSelectedFilter(value);
    if (!selectedVendor) return;

    setBreakdownLoading(true);
    setBreakdownError(null);
    
    try {
      const [filterType, filterId] = value === 'all' ? ['all', null] : value.split('_');
      const params: any = {
        vendorId: selectedVendor.vendorId,
        startDate,
        endDate
      };
      
      if (filterType === 'group') {
        params.groupId = filterId;
      } else if (filterType === 'individuals') {
        params.individuals = 'true';
      } else if (filterType === 'enrollment') {
        params.enrollmentId = filterId;
      }

      const res = await getVendorBreakdownDetails({ ...params, paidStatus });
      if (requestId !== breakdownRequestSeqRef.current) return;
      if (res?.success) {
        setBreakdownData(res.data);
        setBreakdownVendorPayoutBasis(res.vendorPayoutBasis ?? null);
        fetchCoveredUnpaid(selectedVendor.vendorId, value);
      } else {
        setBreakdownError('Failed to load breakdown');
      }

      if (breakdownTab === 'invoices') {
        await fetchInvoices(selectedVendor.vendorId, value);
      }
    } catch (e: any) {
      if (requestId !== breakdownRequestSeqRef.current) return;
      setBreakdownError(e?.message || 'Failed to load breakdown');
    } finally {
      if (requestId !== breakdownRequestSeqRef.current) return;
      setBreakdownLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center gap-2 mb-3">
          <span className="relative group/tip inline-flex items-center">
            <HelpCircle className="h-4 w-4 text-gray-400 cursor-help" />
            <span className="absolute bottom-full left-0 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-50 w-72 text-left leading-relaxed">
              Vendor amounts are calculated based on when enrolled members' coverage is effective, not when payment is collected. A payment collected in March for April coverage will appear in the April breakdown.
            </span>
          </span>
          <span className="text-xs text-gray-500">Amounts reflect effective enrollment periods</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div
            className={
              showAdvancedOptions ? 'border border-blue-200 bg-blue-50/50 rounded-md p-3' : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setShowAdvancedOptions((v) => !v)}
                className="px-3 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                {showAdvancedOptions ? 'Hide advanced options' : 'Advanced options'}
              </button>
              {showAdvancedOptions && mainTableFilterOptions.length > 0 && (
                <div className="w-64 min-w-[240px]">
                  <SearchableDropdown
                    options={mainTableFilterOptions}
                    value={mainTableFilter}
                    onChange={(value) => setMainTableFilter(value)}
                    placeholder="Filter by group or individual"
                    loading={mainTableFilterLoading}
                  />
                </div>
              )}
            </div>
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

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Paid</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Unpaid</th>
                <th
                  className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                  title="Pending refund clawbacks. Will be deducted from this vendor's next NACHA payout."
                >
                  Pending Clawback
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-10 text-center text-gray-500">
                    <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
                    Loading...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-10 text-center text-gray-500">
                    No vendors found for this date range.
                  </td>
                </tr>
              ) : (
                rows.map(r => (
                  <tr key={r.vendorId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      <button
                        className="text-blue-600 hover:underline"
                        onClick={() => openAchModal(r.vendorId, r.vendorName)}
                      >
                        <span className="inline-flex items-center">
                          {r.vendorName}
                          {(!r.ach?.hasActiveAch || Number(r.ach?.totalDistributionPercentage || 0) !== 100) && (
                            <span className="ml-2" title={!r.ach?.hasActiveAch ? 'No active ACH accounts' : 'ACH split does not total 100%'}>
                              <AlertTriangle className="h-4 w-4 text-yellow-600" />
                            </span>
                          )}
                        </span>
                      </button>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <span 
                        className={r.paidInRangeAmount > 0 ? 'font-medium' : 'text-gray-500'}
                        style={r.paidInRangeAmount > 0 ? { color: 'var(--oe-success, #4caf50)' } : undefined}
                      >
                        {formatCurrency(r.paidInRangeAmount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      {r.pendingPayoutAmount > 0 ? (
                        <button
                          onClick={() => openBreakdownModal(r.vendorId, r.vendorName, true)}
                          className="font-medium hover:underline"
                          style={{ color: 'var(--oe-error, #e53935)' }}
                          title="View unpaid payment details"
                        >
                          {formatCurrency(r.pendingPayoutAmount)}
                        </button>
                      ) : (
                        <span className="text-gray-500">{formatCurrency(r.pendingPayoutAmount)}</span>
                      )}
                    </td>
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-right"
                      title={
                        Number(r.pendingClawbackAmount || 0) > 0
                          ? `${r.pendingClawbackCount || 1} pending refund clawback${
                              (r.pendingClawbackCount || 1) === 1 ? '' : 's'
                            } will reduce this vendor's next NACHA payout`
                          : 'No pending clawbacks'
                      }
                    >
                      {Number(r.pendingClawbackAmount || 0) > 0 ? (
                        <button
                          type="button"
                          onClick={() => setClawbackVendor({ vendorId: r.vendorId, vendorName: r.vendorName })}
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
                      <button
                        onClick={() => openBreakdownModal(r.vendorId, r.vendorName)}
                        className="text-blue-600 hover:underline font-medium"
                        title="View breakdown by product and tier"
                      >
                        {formatCurrency(r.expectedAmount)}
                      </button>
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
                  className={totalPaidInRangeAmount > 0 ? 'font-semibold' : 'text-gray-500 font-normal'}
                  style={totalPaidInRangeAmount > 0 ? { color: 'var(--oe-success, #4caf50)' } : undefined}
                >
                  {formatCurrency(totalPaidInRangeAmount)}
                </span>
              </span>
              <span className="text-gray-300 hidden sm:inline">|</span>
              <span>
                Total unpaid:{' '}
                <span className="text-red-700">{formatCurrency(totalUnpaidAmount)}</span>
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

      {showAchModal && selectedVendor && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-lg border border-gray-200 w-full max-w-2xl">
            <div className="p-6 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium text-gray-900">Vendor ACH Details</h3>
                <p className="text-gray-600 mt-1">{selectedVendor.vendorName}</p>
              </div>
              <button
                onClick={() => {
                  setShowAchModal(false);
                  setSelectedVendor(null);
                  setAchDetails(null);
                  setAchError(null);
                }}
                className="p-2 rounded-lg hover:bg-gray-50"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>

            <div className="p-6">
              {achDetails && (
                <>
                  {(!achDetails.accounts || achDetails.accounts.length === 0) && (
                    <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 rounded-lg mb-4">
                      No active ACH accounts are configured for this vendor.
                    </div>
                  )}
                  {achDetails.accounts && achDetails.accounts.length > 0 && Number(achDetails.totalDistribution || 0) !== 100 && (
                    <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 rounded-lg mb-4">
                      ACH split totals {Number(achDetails.totalDistribution || 0)}%. It should total 100%.
                    </div>
                  )}
                </>
              )}
              {achError && (
                <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg mb-4">
                  {achError}
                </div>
              )}

              {achLoading ? (
                <div className="text-center text-gray-500 py-10">
                  <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
                  Loading ACH accounts...
                </div>
              ) : !achDetails ? (
                <div className="text-center text-gray-500 py-10">No ACH details found.</div>
              ) : (
                <div>
                  <div className="mb-4 text-sm text-gray-600">
                    {achDetails.isSplit ? (
                      <span>Split payout across {achDetails.accounts?.length || 0} accounts</span>
                    ) : (
                      <span>Single payout account</span>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Bank</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Split %</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {(achDetails.accounts || []).map((a: any) => (
                          <tr key={a.achAccountId}>
                            <td className="px-4 py-3 text-sm text-gray-900">
                              <div className="font-medium">{a.accountHolderName}</div>
                              <div className="text-gray-500">{a.accountType}{a.accountNumberLast4 ? ` • •••• ${a.accountNumberLast4}` : ''}</div>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">{a.bankName}</td>
                            <td className="px-4 py-3 text-sm text-gray-900 text-right">{Number(a.distributionPercentage || 0)}%</td>
                            <td className="px-4 py-3 text-sm text-gray-600">{a.status}</td>
                          </tr>
                        ))}
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
      {showBreakdownModal && selectedVendor && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-lg border border-gray-200 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-lg font-medium text-gray-900">Vendor Breakdown</h3>
                <p className="text-gray-600 mt-1">{selectedVendor.vendorName}</p>
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
                {breakdownVendorPayoutBasis != null && breakdownVendorPayoutBasis !== '' && (() => {
                  const basisBlurb = vendorBreakdownBasisCallout(breakdownVendorPayoutBasis);
                  return (
                  <div className="mt-3 text-xs text-gray-700 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 max-w-xl">
                    <div className="font-semibold text-gray-900">
                      {basisBlurb.headline}
                    </div>
                    <p className="mt-1 text-gray-600 leading-snug">
                      {basisBlurb.detail}
                    </p>
                  </div>
                  );
                })()}
              </div>
              <button
                onClick={() => {
                  breakdownRequestSeqRef.current += 1;
                  invoicesRequestSeqRef.current += 1;
                  setShowBreakdownModal(false);
                  setSelectedVendor(null);
                  setBreakdownData(null);
                  setBreakdownVendorPayoutBasis(null);
                  setBreakdownError(null);
                  setSelectedFilter('all');
                  setFilterOptions([]);
                  setBreakdownTab('breakdown');
                  setInvoiceRows([]);
                  setInvoicesError(null);
                  setPaidStatus('all');
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

              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Payout Status
                </label>
                <select
                  value={paidStatus}
                  onChange={async (e) => {
                    const next = e.target.value as 'all' | 'paid' | 'unpaid';
                    setPaidStatus(next);
                    if (!selectedVendor) return;

                    if (breakdownTab === 'invoices') {
                      await fetchInvoices(selectedVendor.vendorId, selectedFilter, next);
                    } else {
                      setBreakdownLoading(true);
                      setBreakdownError(null);
                      const requestId = ++breakdownRequestSeqRef.current;
                      try {
                        const [filterType, filterId] = selectedFilter === 'all' ? ['all', null] : selectedFilter.split('_');
                        const params: any = { vendorId: selectedVendor.vendorId, startDate, endDate };
                        if (filterType === 'group') params.groupId = filterId;
                        else if (filterType === 'individuals') params.individuals = 'true';
                        else if (filterType === 'enrollment') params.enrollmentId = filterId;

                        const res = await getVendorBreakdownDetails({ ...params, paidStatus: next });
                        if (requestId !== breakdownRequestSeqRef.current) return;
                        if (res?.success) {
                          setBreakdownData(res.data);
                          setBreakdownVendorPayoutBasis(res.vendorPayoutBasis ?? null);
                        } else setBreakdownError('Failed to load breakdown');
                      } catch (err: any) {
                        if (requestId !== breakdownRequestSeqRef.current) return;
                        setBreakdownError(err?.message || 'Failed to load breakdown');
                      } finally {
                        if (requestId !== breakdownRequestSeqRef.current) return;
                        setBreakdownLoading(false);
                      }
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All</option>
                  <option value="paid">Paid out</option>
                  <option value="unpaid">Pending payout</option>
                </select>
              </div>

            </div>

            <div className="px-6 pt-4 flex-shrink-0">
              <div className="flex items-center gap-2 border-b border-gray-200">
                <button
                  onClick={() => setBreakdownTab('breakdown')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    breakdownTab === 'breakdown'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Breakdown
                </button>
                <button
                  onClick={async () => {
                    setBreakdownTab('invoices');
                    if (selectedVendor) {
                      await fetchInvoices(selectedVendor.vendorId, selectedFilter);
                    }
                  }}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    breakdownTab === 'invoices'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Invoices
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {breakdownTab === 'breakdown' ? (
                breakdownLoading ? (
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
                    No breakdown data available for this vendor.
                  </div>
                ) : (
                  <div className="space-y-6">
                    {(() => {
                      if (paidStatus !== 'unpaid') return null;
                      const discrepancyRows = (breakdownData || []).flatMap((product: any) =>
                        (product?.tiers || [])
                          .filter((tier: any) =>
                            String(tier?.pricingTier || '').includes('Unmatched amount') ||
                            String(tier?.pricingTier || '').includes('Excess enrollment amount') ||
                            String(tier?.pricingTier || '').includes('Group mismatch') ||
                            String(tier?.pricingTier || '').includes('Individual snapshot-only amount')
                          )
                          .map((tier: any) => ({
                            productName: product?.productName || 'Unknown Product',
                            label: tier?.pricingTier || 'Discrepancy',
                            amount: Number(tier?.totalVendorAmount || 0)
                          }))
                      );
                      if (discrepancyRows.length === 0) return null;

                      const discrepancyTotal = discrepancyRows.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
                      return (
                        <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg">
                          <div className="font-semibold">Discrepancy detected in enrollment matching</div>
                          <div className="text-sm mt-1">
                            Total discrepancy: {formatCurrency(discrepancyTotal)} ({discrepancyRows.length} item{discrepancyRows.length === 1 ? '' : 's'})
                          </div>
                          <div className="mt-2 space-y-1 text-sm">
                            {discrepancyRows.map((item: any, idx: number) => (
                              <div key={`${item.productName}-${item.label}-${idx}`}>
                                {item.productName}: {item.label} - {formatCurrency(item.amount)}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    {(() => {
                      const anySnapshot = (breakdownData || []).some((p: any) => p?.breakdownType === 'snapshot');
                      if (!anySnapshot) return null;
                      const uniqueLatePaymentIds = new Set<string>();
                      (breakdownData || []).forEach((p: any) => {
                        (p?.tiers || []).forEach((t: any) => {
                          (t?.payments || []).forEach((pp: any) => {
                            if (pp?.isLate) {
                              const id = pp?.paymentId || pp?.invoiceId;
                              if (id) uniqueLatePaymentIds.add(String(id));
                            }
                          });
                        });
                      });
                      const totalLate = uniqueLatePaymentIds.size;
                      return paidStatus === 'unpaid' ? (
                        <div className="bg-blue-50 border border-blue-200 text-blue-900 p-4 rounded-lg">
                          <div className="font-semibold">
                            {totalLate > 0
                              ? 'Paid after coverage window — vendor not yet paid'
                              : 'Invoice paid — vendor not yet paid'}
                          </div>
                          {totalLate > 0 ? (
                            <div className="text-sm mt-1 text-blue-800">
                              {totalLate} settlement{totalLate === 1 ? '' : 's'} (invoice or payment date after the selected period){' '}
                              {totalLate === 1 ? 'was' : 'were'} not on the prior vendor NACHA — see rows flagged{' '}
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 uppercase tracking-wide align-middle">Late Payment</span>{' '}
                              below.
                            </div>
                          ) : (
                            <div className="text-sm mt-1 text-blue-800">
                              These will be included in the next vendor NACHA.
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="bg-green-50 border border-green-200 text-green-900 p-4 rounded-lg">
                          <div className="font-semibold">Invoice paid — vendor already paid</div>
                          <div className="text-sm mt-1 text-green-800">
                            Already forwarded to the vendor via a Sent NACHA file.
                          </div>
                        </div>
                      );
                    })()}
                    {breakdownData.map((product: any, idx: number) => {
                      const isSnapshot = product.breakdownType === 'snapshot';
                      const firstColLabel = isSnapshot ? 'Group / Member' : 'Pricing Tier';
                      return (
                        <div key={idx} className="border border-gray-200 rounded-lg overflow-hidden">
                          <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
                            <h4 className="font-medium text-gray-900">{product.productName}</h4>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                              <thead className="bg-gray-50">
                                <tr>
                                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{firstColLabel}</th>
                                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Households</th>
                                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor Amount</th>
                                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total Vendor Amount</th>
                                </tr>
                              </thead>
                              <tbody className="bg-white divide-y divide-gray-200">
                                {product.tiers.map((tier: any, tierIdx: number) => {
                                  const fmtDate = (d?: string | null) => d ? new Date(d).toLocaleDateString() : null;
                                  const earliest = fmtDate(tier.earliestPaymentDate);
                                  const latest = fmtDate(tier.latestPaymentDate);
                                  const dateLabel = earliest && latest && earliest !== latest
                                    ? `${earliest} – ${latest}`
                                    : (earliest || latest);
                                  const settlementLine =
                                    tier.paymentCount > 1
                                      ? `${tier.paymentCount} invoices paid · `
                                      : 'Invoice paid on ';
                                  const snapshotClickable = isSnapshot && (
                                    (tier.sourceType === 'group' && tier.groupId) ||
                                    (tier.sourceType === 'individual' && tier.primaryMemberId)
                                  );
                                  const handleSnapshotLabelClick = () => {
                                    if (!isSnapshot) return;
                                    if (tier.sourceType === 'group' && tier.groupId) {
                                      requestGroupNavigate(tier.groupId, tier.pricingTier);
                                    } else if (tier.sourceType === 'individual' && tier.primaryMemberId) {
                                      openMemberModal(tier.primaryMemberId);
                                    }
                                  };
                                  return (
                                    <tr key={tierIdx}>
                                      <td className="px-4 py-3 text-sm text-gray-900">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          {snapshotClickable ? (
                                            <button
                                              type="button"
                                              onClick={handleSnapshotLabelClick}
                                              className="text-oe-primary hover:text-oe-dark hover:underline font-medium"
                                            >
                                              {tier.pricingTier}
                                            </button>
                                          ) : (
                                            <span>{tier.pricingTier}</span>
                                          )}
                                          {tier.familyTierSummary ? (
                                            <span className="text-xs text-gray-500 font-normal whitespace-nowrap" title="Family size tier counts (EE/ES/EC/EF) for this product row">
                                              {' '}{tier.familyTierSummary}
                                            </span>
                                          ) : null}
                                          {isSnapshot && tier.sourceType === 'group' && (
                                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600 uppercase tracking-wide">Group</span>
                                          )}
                                          {isSnapshot && tier.sourceType === 'individual' && (
                                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600 uppercase tracking-wide">Individual</span>
                                          )}
                                          {isSnapshot && tier.lateCount > 0 && (
                                            <span
                                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 uppercase tracking-wide"
                                              title="Invoice or payment settled after the selected coverage window; may still be pending vendor payout."
                                            >
                                              Late Payment
                                            </span>
                                          )}
                                        </div>
                                        {isSnapshot && dateLabel && (
                                          <div className="text-xs text-gray-500 mt-0.5">
                                            {settlementLine}
                                            {dateLabel}
                                            {tier.lateCount > 0 && tier.paymentCount > 1 && (
                                              <span className="text-amber-700"> · {tier.lateCount} late</span>
                                            )}
                                          </div>
                                        )}
                                      </td>
                                      <td className="px-4 py-3 text-sm text-gray-900 text-right">
                                        {tier.householdCount ?? tier.enrollmentCount}
                                      </td>
                                      <td className="px-4 py-3 text-sm text-gray-900 text-right">{formatCurrency(tier.vendorAmount)}</td>
                                      <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">{formatCurrency(tier.totalVendorAmount)}</td>
                                    </tr>
                                  );
                                })}
                                <tr className="bg-gray-50 font-medium">
                                  <td className="px-4 py-3 text-sm text-gray-900 text-left">Product Total:</td>
                                  <td className="px-4 py-3 text-sm text-gray-900 text-right tabular-nums">
                                    {product.tiers.reduce(
                                      (s: number, t: any) =>
                                        s + Number(t.householdCount ?? t.enrollmentCount ?? 0),
                                      0
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-sm text-gray-500 text-right">—</td>
                                  <td className="px-4 py-3 text-sm text-gray-900 text-right">{formatCurrency(product.totalVendorAmount)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                    <div className="mt-4 pt-4 border-t border-gray-200">
                      <div className="flex justify-end">
                        <div className="text-right space-y-1 max-w-md">
                          {/* Authoritative payout figure sourced from the parent vendor row
                              (invoice-anchored: paid-invoice vendor share minus NACHA already
                              disbursed). Always matches the table's Unpaid column. */}
                          {(() => {
                            const breakdownSum = (breakdownData || []).reduce(
                              (s: number, p: any) => s + Number(p?.totalVendorAmount || 0),
                              0
                            );
                            const breakdownSumRounded = Math.round(breakdownSum * 100) / 100;
                            const overPaidPriorPeriod = Math.round(
                              Math.max(0, breakdownSumRounded - vendorRowPendingPayout) * 100
                            ) / 100;
                            const showReconciliation =
                              paidStatus === 'unpaid' && overPaidPriorPeriod > 0.01;
                            return (
                              <div>
                                {showReconciliation && (
                                  <div className="mb-2 space-y-0.5">
                                    <div className="flex items-center justify-end gap-3">
                                      <span className="text-[11px] text-gray-500">Sum of rows above</span>
                                      <span className="text-sm text-gray-700 font-medium tabular-nums">
                                        {formatCurrency(breakdownSumRounded)}
                                      </span>
                                    </div>
                                    <div
                                      className="flex items-center justify-end gap-3"
                                      title="Prior NACHA file already paid this vendor more than the current invoice JSON attributes to them. The over-payment is credited against this period's payout."
                                    >
                                      <span className="text-[11px] text-gray-500">
                                        Less prior over-payment
                                      </span>
                                      <span className="text-sm text-amber-700 font-medium tabular-nums">
                                        −{formatCurrency(overPaidPriorPeriod)}
                                      </span>
                                    </div>
                                    <div className="border-t border-gray-200 my-1" />
                                  </div>
                                )}
                                <div
                                  className="text-xs uppercase tracking-wide text-gray-500"
                                  title="Vendor share of paid invoices in this period that hasn't been NACHA'd yet. Matches the Unpaid column in the vendor breakdown table."
                                >
                                  Ready for payout
                                </div>
                                <div className="text-lg font-semibold text-gray-900">
                                  {formatCurrency(vendorRowPendingPayout)}
                                </div>
                                <div className="text-[11px] text-gray-500">
                                  Paid invoices not yet sent in NACHA
                                </div>
                                {vendorRowPaidOutInWindow > 0.01 && (
                                  <div
                                    className="text-[11px] text-gray-400 mt-1 italic"
                                    title="Portion already disbursed via a NACHA file dated within the same window."
                                  >
                                    {formatCurrency(vendorRowPaidOutInWindow)} already paid out from this period
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    {/* Covered but Unpaid section: members actively enrolled in this vendor's products during the
                        selected coverage window whose group/household has no Completed payment covering it yet.
                        Informational only — does not inflate Expected or Unpaid totals above. */}
                    <div className="mt-6 border border-amber-200 bg-amber-50/40 rounded-lg overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setShowCoveredUnpaid((v) => !v)}
                        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-amber-50 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-600" />
                          <span className="font-medium text-gray-900">Covered but Unpaid</span>
                          {coveredUnpaidLoading ? (
                            <Loader className="h-4 w-4 animate-spin text-gray-400" />
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                              {coveredUnpaid.length}
                            </span>
                          )}
                          <span className="text-xs text-gray-500 ml-1">
                            Members covered this period but no payment received — won't appear in next NACHA
                          </span>
                        </div>
                        <span className="text-xs text-oe-primary font-medium">{showCoveredUnpaid ? 'Hide' : 'Show'}</span>
                      </button>
                      {showCoveredUnpaid && (
                        coveredUnpaidLoading ? (
                          <div className="px-4 py-6 text-center text-gray-500 text-sm">
                            <Loader className="h-4 w-4 animate-spin inline-block mr-2" />
                            Loading covered-but-unpaid enrollments...
                          </div>
                        ) : coveredUnpaid.length === 0 ? (
                          <div className="px-4 py-6 text-center text-gray-500 text-sm border-t border-amber-200">
                            All covered members for this period have a received payment. Nothing missing.
                          </div>
                        ) : (
                          <div className="border-t border-amber-200 divide-y divide-amber-200">
                            {/* Bucket A: covered + invoice exists but unpaid */}
                            {coveredInvoiceUnpaid.length > 0 && (
                              <CoveredUnpaidBucket
                                title="Covered, invoice unpaid"
                                description="Invoice exists for the period but is Unpaid / Partial / Overdue. Customer still owes us."
                                rows={coveredInvoiceUnpaid}
                                openMemberModal={openMemberModal}
                                requestGroupNavigate={requestGroupNavigate}
                                formatCurrency={formatCurrency}
                              />
                            )}
                            {/* Bucket B: covered + no invoice exists for the period */}
                            {coveredNoInvoice.length > 0 && (
                              <CoveredUnpaidBucket
                                title="Covered, no invoice"
                                description="Member is covered for the period but no invoice was generated. Billing engine gap."
                                rows={coveredNoInvoice}
                                openMemberModal={openMemberModal}
                                requestGroupNavigate={requestGroupNavigate}
                                formatCurrency={formatCurrency}
                              />
                            )}
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )
              ) : (
                invoicesLoading ? (
                  <div className="text-center text-gray-500 py-10">
                    <Loader className="h-5 w-5 animate-spin inline-block mr-2" />
                    Loading invoices...
                  </div>
                ) : invoicesError ? (
                  <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg">
                    {invoicesError}
                  </div>
                ) : invoiceRows.length === 0 ? (
                  <div className="text-center text-gray-500 py-10">
                    No paid invoices found for this vendor in the selected coverage window.
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Paid Date</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice #</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Member / Group</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice Amount</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor Amount</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Already Paid</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Remaining</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payout Status</th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Details</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {invoiceRows.map((p) => (
                          <tr key={p.invoiceId} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm text-gray-900">
                              {(() => {
                                const [datePart] = String(p.paidDate).split('T');
                                const [y, m, d] = datePart.split('-').map(Number);
                                const dt = new Date(y, m - 1, d);
                                return dt.toLocaleDateString();
                              })()}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-700">
                              <div className="flex items-center gap-2">
                                <span>{p.invoiceNumber || p.invoiceId.slice(0, 8)}</span>
                                {p.fundingSource === 'Credit' && (
                                  <span
                                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-800 border border-purple-200"
                                    title="Invoice was paid via household credit (no oe.Payments row). Vendor still gets paid out for it."
                                  >
                                    Credit-funded
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-900">
                              {p.sourceType === 'group' && p.groupId ? (
                                <button
                                  type="button"
                                  onClick={() => requestGroupNavigate(p.groupId, p.groupName || p.sourceName)}
                                  className="text-oe-primary hover:text-oe-dark hover:underline font-medium text-left"
                                >
                                  {p.sourceName}
                                </button>
                              ) : p.sourceType === 'individual' && p.primaryMemberId ? (
                                <button
                                  type="button"
                                  onClick={() => openMemberModal(p.primaryMemberId!)}
                                  className="text-oe-primary hover:text-oe-dark hover:underline font-medium text-left"
                                >
                                  {p.sourceName}
                                </button>
                              ) : (
                                p.sourceName
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-900 text-right">{formatCurrency(p.invoiceAmount)}</td>
                            <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">{formatCurrency(p.vendorAmount)}</td>
                            <td className="px-4 py-3 text-sm text-gray-700 text-right">{formatCurrency(p.vendorAlreadyPaid)}</td>
                            <td className="px-4 py-3 text-sm text-gray-900 text-right">{formatCurrency(p.vendorRemaining)}</td>
                            <td className="px-4 py-3 text-sm">
                              <span
                                className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                  p.payoutStatus === 'Paid'
                                    ? 'bg-green-100 text-green-800'
                                    : p.payoutStatus === 'Partial'
                                      ? 'bg-yellow-100 text-yellow-800'
                                      : 'bg-red-100 text-red-800'
                                }`}
                              >
                                {p.payoutStatus}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-sm text-right">
                              {p.paymentId ? (
                                <button
                                  type="button"
                                  onClick={() => setPaymentBreakdown({
                                    paymentId: p.paymentId!,
                                    paymentDate: p.paidDate,
                                    paymentAmount: p.invoiceAmount,
                                    sourceName: p.sourceName
                                  })}
                                  className="text-oe-primary hover:text-oe-dark hover:underline font-medium"
                                >
                                  Details
                                </button>
                              ) : (
                                <span className="text-gray-400" title="Credit-funded invoice — no underlying payment to inspect">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}

      {memberModalMember && (
        <div className="relative z-[90]">
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
        </div>
      )}

      {paymentBreakdown && (
        <PaymentVendorBreakdownModal
          isOpen={!!paymentBreakdown}
          onClose={() => setPaymentBreakdown(null)}
          paymentId={paymentBreakdown.paymentId}
          vendorId={selectedVendor?.vendorId}
          paymentDate={paymentBreakdown.paymentDate}
          paymentAmount={paymentBreakdown.paymentAmount}
          sourceName={paymentBreakdown.sourceName}
          vendorName={selectedVendor?.vendorName}
        />
      )}

      <ClawbackDetailsModal
        isOpen={!!clawbackVendor}
        onClose={() => setClawbackVendor(null)}
        recipientLabel={clawbackVendor?.vendorName || ''}
        source={
          clawbackVendor
            ? { kind: 'payout', payoutType: 'Vendor', recipientEntityId: clawbackVendor.vendorId }
            : null
        }
        onOpenMember={(memberId) => {
          setClawbackVendor(null);
          openMemberModal(memberId);
        }}
        onOpenGroup={(groupId, groupName) => requestGroupNavigate(groupId, groupName)}
      />

      {groupNavigateConfirm && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-lg border border-gray-200 shadow-lg w-full max-w-md">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">Open group page?</h3>
              <p className="text-sm text-gray-600 mt-1">
                This will close the vendor breakdown and navigate to <span className="font-semibold">{groupNavigateConfirm.groupName}</span>.
              </p>
            </div>
            <div className="p-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setGroupNavigateConfirm(null)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmGroupNavigate}
                className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark text-sm font-medium"
              >
                Open group
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VendorBreakdown;


