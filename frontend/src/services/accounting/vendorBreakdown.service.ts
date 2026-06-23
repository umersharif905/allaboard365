import { apiService } from '../api.service';

export interface VendorBreakdownRow {
  vendorId: string;
  vendorName: string;
  expectedAmount: number;
  // Paid out for payments whose PaymentDate is in the selected range
  paidInRangeAmount: number;
  // Paid out in NACHA files (Sent Vendor Payouts) whose GeneratedDate is in the selected range
  paidOutAmount: number;
  // Payments in range not yet paid out via NACHA (Expected - PaidInRange)
  pendingPayoutAmount: number;
  /** Sum of oe.PayoutClawbacks RemainingAmount (Available + PartiallyApplied). Will reduce next NACHA payout. */
  pendingClawbackAmount?: number;
  pendingClawbackCount?: number;
  /** Pending payout after applying pending clawback (max(0, pendingPayoutAmount - pendingClawbackAmount)). */
  netNextPayoutAmount?: number;
  /**
   * Vendor JSON on Completed payments with no InvoiceId — excluded from pending/NACHA vendor
   * totals (invoice-anchored payouts) but kept visible for data cleanup.
   */
  orphanPaymentVendorExposure?: number;
  ach?: {
    hasActiveAch: boolean;
    activeAccountCount: number;
    totalDistributionPercentage: number;
  };
}

export interface AchDetailsResponse {
  isSplit: boolean;
  totalDistribution: number;
  accounts: Array<{
    achAccountId: string;
    accountHolderName: string;
    bankName: string;
    accountType: string;
    accountNumberLast4?: string | null;
    distributionPercentage: number;
    isDefault: boolean;
    status: string;
  }>;
  accountSource: string;
}

export async function getVendorBreakdown(params: {
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
  individuals?: string;
}): Promise<{
  success: boolean;
  data: VendorBreakdownRow[];
}> {
  const query = new URLSearchParams();
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.householdId) query.append('householdId', params.householdId);
  if (params.individuals) query.append('individuals', params.individuals);

  return apiService.get<{ success: boolean; data: VendorBreakdownRow[] }>(
    `/api/accounting/vendor-breakdown?${query.toString()}`
  );
}

export async function getVendorAchDetails(vendorId: string): Promise<{ success: boolean; data: AchDetailsResponse }> {
  return apiService.get<{ success: boolean; data: AchDetailsResponse }>(
    `/api/accounting/nacha/ach-details/Vendor/${vendorId}`
  );
}

export interface VendorNachaPreviewGapRow {
  anchorType: 'invoice' | 'orphan_payment';
  invoiceId: string | null;
  paymentId: string | null;
  vendorShare: number;
  reason: string;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  paymentDate: string | null;
  primaryMemberId: string | null;
  memberName: string;
  groupId: string | null;
  groupName: string | null;
}

export async function getVendorNachaPreviewGap(params: {
  vendorId: string;
  startDate: string;
  endDate: string;
  includedInvoiceIds: string[];
  includedPaymentIds: string[];
}): Promise<{
  success: boolean;
  data?: {
    rows: VendorNachaPreviewGapRow[];
    count: number;
    totalVendorShare: number;
  };
  message?: string;
}> {
  const q = new URLSearchParams();
  q.append('vendorId', params.vendorId);
  q.append('startDate', params.startDate);
  q.append('endDate', params.endDate);
  if (params.includedInvoiceIds.length) q.append('includedInvoiceIds', params.includedInvoiceIds.join(','));
  if (params.includedPaymentIds.length) q.append('includedPaymentIds', params.includedPaymentIds.join(','));
  return apiService.get(`/api/accounting/vendor-breakdown/nacha-preview-gap?${q.toString()}`);
}

export interface VendorBreakdownItem {
  productId: string;
  productName: string;
  // When populated (snapshot mode under Paid/Pending filters) tier rows represent payment sources
  // (Group name or Primary member name) instead of pricing tiers.
  breakdownType?: 'snapshot' | 'tier';
  lateCount?: number;
  tiers: {
    productPricingId: string | null;
    pricingTier: string;
    sourceType?: 'group' | 'individual' | 'payment';
    groupId?: string | null;
    householdId?: string | null;
    primaryMemberId?: string | null;
    /** Distinct primary households (snapshot + tier breakdown); legacy alias enrollmentCount */
    householdCount?: number;
    enrollmentCount: number;
    familyTierCounts?: Record<string, number> | null;
    familyTierSummary?: string | null;
    paymentCount?: number;
    lateCount?: number;
    earliestPaymentDate?: string | null;
    latestPaymentDate?: string | null;
    payments?: Array<{
      paymentId: string;
      paymentDate: string | null;
      isLate: boolean;
    }>;
    vendorAmount: number;
    totalVendorAmount: number;
  }[];
  totalVendorAmount: number;
}

export interface CoveredUnpaidEnrollment {
  enrollmentId: string;
  memberId: string;
  primaryMemberName: string;
  email: string | null;
  groupId: string | null;
  groupName: string | null;
  householdId: string | null;
  productId: string;
  productName: string;
  productPricingId: string | null;
  pricingTier: string | null;
  netRate: number;
  effectiveDate: string | null;
  terminationDate: string | null;
  sourceType: 'group' | 'individual';
  /**
   * Bucket classification:
   *  - 'covered-invoice-unpaid' : an invoice exists for this period but is Unpaid/Partial/Overdue
   *  - 'covered-no-invoice'     : no invoice covers this period at all
   */
  bucket?: 'covered-invoice-unpaid' | 'covered-no-invoice';
}

export interface VendorPaymentRow {
  paymentId: string;
  paymentDate: string;
  paymentAmount: number;
  sourceName: string;
  sourceType?: 'group' | 'individual' | 'payment';
  groupId: string | null;
  groupName?: string | null;
  householdId?: string | null;
  primaryMemberId?: string | null;
  vendorAmount: number;
  vendorAlreadyPaid: number;
  vendorRemaining: number;
  payoutStatus: 'Paid' | 'Partial' | 'Unpaid';
}

export interface VendorInvoiceRow {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  paidDate: string;
  invoiceAmount: number;
  sourceName: string;
  sourceType?: 'group' | 'individual' | 'invoice';
  groupId: string | null;
  groupName?: string | null;
  householdId?: string | null;
  primaryMemberId?: string | null;
  paymentId: string | null;
  fundingSource: 'Payment' | 'Credit';
  vendorAmount: number;
  vendorAlreadyPaid: number;
  vendorRemaining: number;
  payoutStatus: 'Paid' | 'Partial' | 'Unpaid';
}

export interface FilterOption {
  id: string;
  label: string;
  type: 'all' | 'group' | 'member';
  value: string;
}

export async function getVendorBreakdownFilterOptions(params: {
  vendorId?: string;
  startDate: string;
  endDate: string;
}): Promise<{ success: boolean; data: FilterOption[] }> {
  const query = new URLSearchParams();
  if (params.vendorId) query.append('vendorId', params.vendorId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);

  return apiService.get<{ success: boolean; data: FilterOption[] }>(
    `/api/accounting/vendor-breakdown/filter-options?${query.toString()}`
  );
}

export async function getVendorBreakdownDetails(params: {
  vendorId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
  enrollmentId?: string;
  individuals?: string;
  paidStatus?: 'all' | 'paid' | 'unpaid';
}): Promise<{
  success: boolean;
  data: VendorBreakdownItem[];
  /** Tenant AdvancedSettings payouts.vendorBasis: effectiveEnrollment | paymentReceived */
  vendorPayoutBasis?: 'effectiveEnrollment' | 'paymentReceived' | string;
}> {
  const query = new URLSearchParams();
  query.append('vendorId', params.vendorId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.householdId) query.append('householdId', params.householdId);
  if (params.enrollmentId) query.append('enrollmentId', params.enrollmentId);
  if (params.individuals) query.append('individuals', params.individuals);
  if (params.paidStatus) query.append('paidStatus', params.paidStatus);

  return apiService.get<{
    success: boolean;
    data: VendorBreakdownItem[];
    vendorPayoutBasis?: 'effectiveEnrollment' | 'paymentReceived' | string;
  }>(`/api/accounting/vendor-breakdown/breakdown?${query.toString()}`);
}

export async function getVendorPaymentRows(params: {
  vendorId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
  individuals?: string;
  paidStatus?: 'all' | 'paid' | 'unpaid';
}): Promise<{ success: boolean; data: VendorPaymentRow[] }> {
  const query = new URLSearchParams();
  query.append('vendorId', params.vendorId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.householdId) query.append('householdId', params.householdId);
  if (params.individuals) query.append('individuals', params.individuals);
  if (params.paidStatus) query.append('paidStatus', params.paidStatus);

  return apiService.get<{ success: boolean; data: VendorPaymentRow[] }>(
    `/api/accounting/vendor-breakdown/payments?${query.toString()}`
  );
}

export async function getVendorInvoiceRows(params: {
  vendorId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
  individuals?: string;
  paidStatus?: 'all' | 'paid' | 'unpaid';
}): Promise<{ success: boolean; data: VendorInvoiceRow[] }> {
  const query = new URLSearchParams();
  query.append('vendorId', params.vendorId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.householdId) query.append('householdId', params.householdId);
  if (params.individuals) query.append('individuals', params.individuals);
  if (params.paidStatus) query.append('paidStatus', params.paidStatus);

  return apiService.get<{ success: boolean; data: VendorInvoiceRow[] }>(
    `/api/accounting/vendor-breakdown/invoices?${query.toString()}`
  );
}

export async function getVendorCoveredUnpaid(params: {
  vendorId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
  individuals?: string;
}): Promise<{
  success: boolean;
  data: CoveredUnpaidEnrollment[];
  coveredInvoiceUnpaid?: CoveredUnpaidEnrollment[];
  coveredNoInvoice?: CoveredUnpaidEnrollment[];
}> {
  const query = new URLSearchParams();
  query.append('vendorId', params.vendorId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.householdId) query.append('householdId', params.householdId);
  if (params.individuals) query.append('individuals', params.individuals);

  return apiService.get<{
    success: boolean;
    data: CoveredUnpaidEnrollment[];
    coveredInvoiceUnpaid?: CoveredUnpaidEnrollment[];
    coveredNoInvoice?: CoveredUnpaidEnrollment[];
  }>(
    `/api/accounting/vendor-breakdown/covered-unpaid?${query.toString()}`
  );
}

export interface VendorPaymentBreakdownProduct {
  productId: string;
  productName: string;
  productType: string | null;
  vendorId: string | null;
  vendorName: string | null;
  vendorAmount: number;
  enrolledCount: number;
  enrollments: Array<{
    enrollmentId: string;
    memberId: string;
    memberName: string;
    relationshipType: string | null;
    pricingTier: string | null;
    netRate: number;
    effectiveDate: string | null;
    terminationDate: string | null;
  }>;
}

export interface VendorPaymentBreakdownData {
  paymentId: string;
  paymentDate: string;
  paymentAmount: number;
  paymentStatus: string | null;
  sourceType: 'group' | 'individual';
  sourceName: string;
  groupId: string | null;
  groupName: string | null;
  householdId: string | null;
  primaryMemberId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  vendorTotal: number;
  alreadyPaid: number;
  remaining: number;
  products: VendorPaymentBreakdownProduct[];
}

export async function getVendorPaymentBreakdown(
  paymentId: string,
  vendorId?: string
): Promise<{ success: boolean; data: VendorPaymentBreakdownData }> {
  const query = new URLSearchParams();
  if (vendorId) query.append('vendorId', vendorId);
  const qs = query.toString();
  return apiService.get<{ success: boolean; data: VendorPaymentBreakdownData }>(
    `/api/accounting/vendor-breakdown/payment/${encodeURIComponent(paymentId)}/breakdown${qs ? `?${qs}` : ''}`
  );
}

export async function getVendorLastPayoutDate(vendorId: string): Promise<{ success: boolean; data: { lastPayoutDate: string | null } }> {
  const query = new URLSearchParams();
  query.append('vendorId', vendorId);
  return apiService.get<{ success: boolean; data: { lastPayoutDate: string | null } }>(
    `/api/accounting/vendor-breakdown/last-payout-date?${query.toString()}`
  );
}


