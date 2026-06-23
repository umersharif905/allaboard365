// frontend/src/services/nachaService.ts
import { apiService } from './api.service';

/**
 * A single NACHAPaymentDetail that isn't represented (or is refunded) in the payables CSV
 * for a given vendor/NACHA. Used by the Reconciliation Warning dialog to explain discrepancies.
 */
export interface PayablesDiscrepancy {
  nachaPaymentDetailId: string;
  paymentId: string;
  vendorAmount: number;
  paymentDate: string | null;
  paymentStatus: string;
  refundDate: string | null;
  refundAmount: number;
  achReturnCode: string | null;
  achReturnReason: string | null;
  chargebackReason: string | null;
  invoiceBillingPeriodStart: string | null;
  invoiceBillingPeriodEnd: string | null;
  invoiceCreatedDate: string | null;
  invoiceCreatedAfterNacha: boolean;
  primaryMemberId: string | null;
  primaryHouseholdMemberID: string | null;
  primaryMemberStatus: string | null;
  primaryName: string;
  enrollmentId: string | null;
  productName: string | null;
  enrollmentStatus: string | null;
  enrollmentEffectiveDate: string | null;
  enrollmentTerminationDate: string | null;
  enrollmentModifiedDate: string | null;
  enrollmentModifiedByName: string | null;
  reasons: string[];
}

/** Per NACHA payment-detail allocation notice (product caps, proration, excluded enrollments). */
export interface PayablesAllocationWarning {
  severity: 'warning' | 'info';
  code: string;
  /** Short label for the reconciliation table (user-facing). */
  title?: string;
  message: string;
  nachaPaymentDetailId?: string;
  groupName?: string | null;
  invoiceNumber?: string | null;
  accountLabel?: string | null;
  billingPeriodLabel?: string | null;
  productId?: string;
  productName?: string | null;
  vendorAmountPaid?: number;
  productCap?: number;
  weightPool?: number;
  prorationFactor?: number;
  enrollmentNetRate?: number;
  /** Invoice-level rollup: vendor $ not placed on member payables lines. */
  notOnPayablesFile?: number;
  lineItemCount?: number;
}

export interface PayablesReconciliationSummary {
  /** Sum of contract (enrollment) amounts on member lines. */
  payablesTotal: number;
  contractTotal?: number;
  /** Sum of paid (invoice/NACHA) amounts on member lines — should match net ACH. */
  paidTotal?: number;
  /** paidTotal - contractTotal */
  contractVsPaidVariance?: number;
  /** Net ACH sent to vendor (gross vendor credits minus clawbacks applied on this NACHA). */
  nachaPayout: number;
  /** Sum of positive vendor NACHA payment-detail lines before clawbacks. */
  nachaPayoutGross?: number;
  gap: number;
  /** paidTotal + exclusions - nachaPayout - clawbacksApplied; should be ~0 when reconciled. */
  unexplainedGap?: number;
  /** True when payables gross matches net ACH + clawbacks (no reconciliation warning needed). */
  reconciledWithClawbacks?: boolean;
  notOnPayablesFile: number;
  clawbacksApplied: number;
}

/** Rows eligible in the trailing window but outside the selected NACHA [startDate, endDate]. */
export interface StalePayablePaymentRow {
  paymentId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  anchorDate: string | null;
  payoutBasis?: string;
  sourceType: 'group' | 'individual';
  groupId: string | null;
  groupName: string | null;
  householdId: string | null;
  primaryMemberId: string | null;
  displayName: string;
}

export interface StalePayableCommissionRow {
  commissionId: string;
  paymentId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  anchorDate: string | null;
  sourceType: 'group' | 'individual';
  groupId: string | null;
  groupName: string | null;
  householdId: string | null;
  primaryMemberId: string | null;
  displayName: string;
}

export interface StalePayablesSummaryData {
  trailingDays: number;
  vendorBasis: string;
  overrideBasis: string;
  vendorStaleCount: number;
  overrideStaleCount: number;
  commissionStaleCount: number;
  vendorStaleRows?: StalePayablePaymentRow[];
  overrideStaleRows?: StalePayablePaymentRow[];
  commissionStaleRows?: StalePayableCommissionRow[];
  vendorStaleRowsTruncated?: boolean;
  overrideStaleRowsTruncated?: boolean;
  commissionStaleRowsTruncated?: boolean;
}

interface NACHAPreview {
  totalPayouts: number;
  totalAmount: number;
  totalRevenue?: number; // Total revenue calculated from unique payment IDs
  /** Sum of all clawback amounts that will actually net into this cycle. */
  totalClawbackApplied?: number;
  /** Sum of clawback amounts that exceed available payout this cycle (carries forward to next cycle). */
  totalClawbackCarryForward?: number;
  /** Final NACHA ACH total after netting (mirrors `totalAmount` for payment_types where netting is already applied). */
  totalNetAmount?: number;
  dateRange: {
    startDate: string;
    endDate: string;
  };
  payoutType: string;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  payoutBreakdown: Array<{
    entityType: string;
    entityId: string;
    amount: number;
    entityName?: string;
    hasACH?: boolean;
    achStatus?: string | null;
    isPrimaryAgency?: boolean;
    isOverflow?: boolean;
    isOverride?: boolean;
    achSplits?: Array<{
      achAccountId: string;
      accountHolderName: string;
      bankName?: string | null;
      accountType: string;
      accountNumberLast4?: string | null;
      distributionPercentage: number;
      splitAmount: number;
      status: string;
    }> | null;
    // Commission details (for Agent Commission Payouts)
    revenue?: number;
    commissionPool?: number;
    ruleId?: string | null;
    ruleName?: string | null;
    ruleIds?: string[];
    commissionType?: string | null;
    tierLevel?: number;
    commissionId?: string;
    // Clawback netting (Phase 6)
    /** Total pending clawback for this recipient (before capping by gross). */
    pendingClawbackAmount?: number;
    pendingClawbackCount?: number;
    /** Portion of pendingClawbackAmount that will actually net this cycle (capped by gross). */
    clawbackAppliedThisCycle?: number;
    /** Portion that will carry forward to the next cycle (pendingClawbackAmount - clawbackAppliedThisCycle). */
    clawbackCarryForwardAmount?: number;
    /** What this recipient earned before any clawback was applied. */
    grossAmount?: number;
    /** What this recipient will actually be paid this cycle (max(0, gross - clawback)). */
    netAmount?: number;
  }>;
  excludedPaymentsDueToHoldPeriods?: Array<{
    tenantId: string;
    tenantName: string;
    holdDays: number;
    holdDaysCountFrom: 'paymentDate' | 'nextDay';
    excludedPaymentCount: number;
    excludedAmount: number;
    earliestPaymentDate: string;
    latestEligibilityDate: string;
  }>;
  /** Payments missing ProductCommissions JSON (vendor / product-owner NACHA may not include per-product detail). */
  paymentsMissingProductSnapshot?: {
    count: number;
    paymentIds: string[];
  };
}

interface NACHAGeneration {
  nachaId: string;
  fileName: string;
  totalPayouts: number;
  totalAmount: number;
  status: 'Pending' | 'Sent';
  generatedDate: string;
  payoutType?: string;
  startDate?: string;
  endDate?: string;
  sentDate?: string;
  /** When set, this NACHA is a "Retry Bounces" file generated from another NACHA's selected lines */
  reissueOfNachaId?: string | null;
  /** Vendor payout recipients (Vendor Payouts NACHA); empty for other payout types or if none */
  vendorNames?: string[];
  includedPayouts?: number;
  includedAmount?: number;
  excludedPayouts?: number;
  excludedAmount?: number;
  excludedPayoutDetails?: Array<{
    entityType: string;
    entityId: string;
    amount: number;
    entityName?: string;
    reason?: string;
  }>;
  warnings?: Array<{
    code: string;
    message: string;
    existingNachaId?: string;
    existingStartDate?: string;
    existingEndDate?: string;
  }>;
}

interface NACHALineItem {
  nachaPaymentDetailId: string;
  recipientEntityType: string;
  recipientEntityId: string;
  amount: number;
  tierLevel: number | null;
  ruleId: string | null;
  ruleName: string | null;
  recipientName: string;
  totalAmount: number;
  paymentCount: number;
  /** Distinct invoices on this NACHA line (vendor/tenant payouts). */
  invoiceCount?: number;
  paymentIds: string[];
  invoiceId?: string | null;
  achBankName?: string; // Optional bank name for display
  /** Refund clawbacks applied against this recipient on this NACHA (debit lines + payout clawbacks). */
  clawbackTotal?: number;
  grossCredits?: number;
}

export interface PaymentDetail {
  nachaPaymentDetailId: string;
  paymentId: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  invoiceStatus?: string | null;
  invoicePaidDate?: string | null;
  fundingSource?: string;
  lineCount?: number;
  amount: number;
  tierLevel: number | null;
  ruleId: string | null;
  ruleName: string | null;
  commissionType?: string | null;
  commissionRate?: number | null;
  flatAmount?: number | null;
  paymentDate: string;
  paymentAmount: number;
  commissionAmount: number;
  ruleIds?: string[];
  netRate?: number;
  overrideRate?: number;
  overridePayout?: number; // Total override rate (for Tenant)
  entityOverridePayout?: number; // Entity-specific override amount (for Tenant)
  memberName: string;
  memberId?: string | null;
  sellingAgentId: string | null;
  sellingAgentName: string | null;
  groupId?: string | null;
  groupName?: string | null;
}


interface NACHAListResponse {
  success: boolean;
  nachas: NACHAGeneration[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface NACHALineItemsResponse {
  success: boolean;
  lineItems: NACHALineItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface CommissionHoldSettings {
  tenantId: string;
  tenantName: string | null;
  holdDays: number;
  holdDaysCountFrom: 'paymentDate' | 'nextDay';
  holdOffsetDays: number;
  todayDate: string;
  safeEndDate: string;
}

export interface FeeDetail {
  paymentId: string;
  paymentDate: string;
  groupId: string | null;
  groupName: string | null;
  memberName: string;
  systemFees: number;
  processingFee: number;
  totalFees: number;
}

interface FeesResponse {
  success: boolean;
  fees: FeeDetail[];
  totals: {
    totalSystemFees: number;
    totalProcessingFees: number;
    totalFees: number;
  };
}

export interface NACHAValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nachaId?: string;
  payoutType?: string;
  paymentId?: string;
  recipientEntityType?: string;
  recipientEntityId?: string;
  meta?: Record<string, any>;
}

export interface NACHAValidationGenerationSummary {
  nachaId: string;
  payoutType: string;
  status: 'Pending' | 'Sent';
  tenantId: string | null;
  startDate: string;
  endDate: string;
  totalPayouts: number;
  totalAmount: number;
  fileName: string;
  generatedDate: string;
  sentDate: string | null;
  detailsTotalAmount: number;
  detailsRowCount: number;
  detailsRecipientCount: number;
}

export interface NACHAValidationResponse {
  success: boolean;
  summary: {
    checkedGenerations: number;
    errorCount: number;
    warningCount: number;
  };
  generations: NACHAValidationGenerationSummary[];
  issues: NACHAValidationIssue[];
}

export interface RetryPreviewLine {
  nachaPaymentDetailId: string;
  paymentId: string | null;
  recipientEntityType: 'Agent' | 'Agency' | 'Vendor' | 'Tenant' | string;
  recipientEntityId: string;
  recipientName: string;
  ruleName: string | null;
  amount: number;
  /** ACH info that was on the original NACHA when the file was generated */
  original: {
    achAccountId: string | null;
    routingNumber: string | null;
    accountNumberLast4: string | null;
  };
  /** ACH info that the recipient currently has on file (what the retry will use) */
  current: {
    achAccountId: string;
    bankName: string | null;
    accountHolderName: string | null;
    accountType: string | null;
    routingNumber: string | null;
    accountNumberLast4: string | null;
    updatedDate: string | null;
  } | null;
  hasCurrentBankInfo: boolean;
  bankInfoChanged: boolean;
}

export interface RetryPreviewResponse {
  success: boolean;
  lines: RetryPreviewLine[];
  original: { nachaId: string; tenantId: string };
}

export interface RetryBouncesResponse {
  success: boolean;
  nachaId: string;
  fileName: string;
  totalPayouts: number;
  totalAmount: number;
  status: 'Pending' | 'Sent';
  reissueOfNachaId: string;
  excludedPayouts: Array<{
    entityType: string;
    entityId: string;
    entityName: string;
    amount: number;
    reason: string;
  }>;
}

// Use relative paths - apiService already has the correct baseURL configured
// This ensures we use the runtime config (from environment variables) instead of build-time fallback
const API_BASE = '/api/accounting/nacha';
// Preview can scan many payments + invoices but is read-only, 2 min is fine.
const NACHA_PREVIEW_TIMEOUT_MS = 2 * 60 * 1000;
// Generation persists per-line detail rows + commission allocations across
// every payment in the window. Big tenants / wide ranges hit minutes.
const NACHA_GENERATE_TIMEOUT_MS = 5 * 60 * 1000;

class NACHAService {
  async getCommissionHoldSettings(tenantId?: string): Promise<{ success: boolean; data: CommissionHoldSettings }> {
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    return apiService.get<{ success: boolean; data: CommissionHoldSettings }>(
      `${API_BASE}/commission-hold-settings${query}`
    );
  }

  async getStalePayablesSummary(params: {
    startDate: string;
    endDate: string;
    tenantId?: string;
    trailingDays?: number;
    includeVendor?: boolean;
    includeOverrides?: boolean;
    includeCommissions?: boolean;
    /** When true (default), response includes sample rows for the detail modal */
    includeDetails?: boolean;
    detailLimit?: number;
  }): Promise<{
    success: boolean;
    data: StalePayablesSummaryData;
  }> {
    const q = new URLSearchParams();
    q.set('startDate', params.startDate);
    q.set('endDate', params.endDate);
    if (params.tenantId) q.set('tenantId', params.tenantId);
    if (params.trailingDays != null) q.set('trailingDays', String(params.trailingDays));
    if (params.includeVendor === false) q.set('includeVendor', 'false');
    if (params.includeOverrides === false) q.set('includeOverrides', 'false');
    if (params.includeCommissions === false) q.set('includeCommissions', 'false');
    if (params.includeDetails === false) q.set('includeDetails', 'false');
    if (params.detailLimit != null) q.set('detailLimit', String(params.detailLimit));
    return apiService.get(`${API_BASE}/stale-payables-summary?${q.toString()}`);
  }

  /**
   * Preview payouts before generating NACHA file
   */
  async previewPayouts(params: {
    payoutType: string;
    startDate: string;
    endDate: string;
    tenantId?: string;
    page?: number;
    limit?: number;
  }): Promise<NACHAPreview> {
    const data = await apiService.post<{ preview: NACHAPreview }>(
      `${API_BASE}/preview`,
      params,
      { timeout: NACHA_PREVIEW_TIMEOUT_MS }
    );
    return data.preview;
  }

  /**
   * Generate NACHA file
   */
  async generateNACHA(params: {
    payoutType: string;
    startDate: string;
    endDate: string;
    tenantId?: string;
    vendorIds?: string[];
    agentIds?: string[];
    agencyIds?: string[];
    fundingAchAccountId?: string;
    companyIdentification: string;
    excludedPaymentIds?: string[];
    excludedInvoiceIds?: string[];
  }): Promise<NACHAGeneration> {
    // 5 min: NACHA generation iterates every payment/invoice in the window,
    // recomputes commissions, and persists per-line detail rows. The default
    // 30s axios ceiling is way too tight on large windows / multi-vendor runs.
    const data = await apiService.post<{ nacha: NACHAGeneration }>(
      `${API_BASE}/generate`,
      params,
      { timeout: NACHA_GENERATE_TIMEOUT_MS }
    );
    return data.nacha;
  }

  /**
   * Get all available ACH account options for funding NACHA files
   */
  async getACHOptions(
    tenantId: string,
    payoutType: string
  ): Promise<{
    success: boolean;
    options: Array<{
      achAccountId: string;
      accountHolderName: string;
      bankName: string;
      accountNumberLast4?: string;
      accountType: string;
      label: string;
      isDefault: boolean;
      accountSource: string;
      companyIdentification?: string | null;
    }>;
  }> {
    return await apiService.get<{
      success: boolean;
      options: Array<{
        achAccountId: string;
        accountHolderName: string;
        bankName: string;
        accountNumberLast4?: string;
        accountType: string;
        label: string;
        isDefault: boolean;
        accountSource: string;
        companyIdentification?: string | null;
      }>;
    }>(`${API_BASE}/ach-options/${tenantId}?payoutType=${encodeURIComponent(payoutType)}`);
  }

  /**
   * List NACHA files with pagination
   */
  async listNACHAs(params: {
    page?: number;
    limit?: number;
    status?: string;
    payoutType?: string;
    startDate?: string;
    endDate?: string;
    /** Only NACHA files that include this vendor as a payout recipient */
    vendorId?: string;
    /** Only NACHA files that include this agent (or agency) as a payout recipient */
    agentId?: string;
  } = {}): Promise<NACHAListResponse> {
    const queryParams = new URLSearchParams();
    if (params.page) queryParams.append('page', params.page.toString());
    if (params.limit) queryParams.append('limit', params.limit.toString());
    if (params.status) queryParams.append('status', params.status);
    if (params.payoutType) queryParams.append('payoutType', params.payoutType);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);
    if (params.vendorId) queryParams.append('vendorId', params.vendorId);
    if (params.agentId) queryParams.append('agentId', params.agentId);

    return await apiService.get<NACHAListResponse>(`${API_BASE}?${queryParams.toString()}`);
  }

  /**
   * Get NACHA details
   */
  async getNACHADetails(nachaId: string): Promise<NACHAGeneration> {
    const data = await apiService.get<{ nacha: NACHAGeneration }>(`${API_BASE}/${nachaId}`);
    return data.nacha;
  }

  /**
   * Get NACHA line items with pagination
   */
  async getNACHALineItems(nachaId: string, page: number = 1, limit: number = 50): Promise<NACHALineItemsResponse> {
    const queryParams = new URLSearchParams();
    queryParams.append('page', page.toString());
    queryParams.append('limit', limit.toString());

    return await apiService.get<NACHALineItemsResponse>(`${API_BASE}/${nachaId}/line-items?${queryParams.toString()}`);
  }

  /**
   * Download NACHA file
   */
  async getRecipientPaymentDetails(
    nachaId: string,
    entityType: string,
    entityId: string
  ): Promise<{ success: boolean; paymentDetails: PaymentDetail[]; groupedBy?: 'invoice' | 'payment' }> {
    return await apiService.get<{ success: boolean; paymentDetails: PaymentDetail[]; groupedBy?: 'invoice' | 'payment' }>(
      `${API_BASE}/${nachaId}/recipient/${entityType}/${entityId}/payments`
    );
  }

  /**
   * Get payment details for a recipient in preview (before NACHA generation)
   */
  async getPreviewRecipientPayments(
    entityType: string,
    entityId: string,
    startDate: string,
    endDate: string
  ): Promise<{ success: boolean; paymentDetails: Array<{
    paymentId: string | null;
    invoiceId?: string | null;
    fundingSource?: 'Payment' | 'Credit';
    paymentAmount: number;
    paymentDate: string;
    commissionPool: number;
    commissionAmount: number;
    memberName: string;
    memberId?: string;
    sellingAgentName: string | null;
    ruleId: string | null;
    ruleName: string | null;
    ruleIds?: string[];
    commissionType: string | null;
    tierLevel: number | null;
  }> }> {
    const queryParams = new URLSearchParams();
    queryParams.append('startDate', startDate);
    queryParams.append('endDate', endDate);
    
    return await apiService.get<{ success: boolean; paymentDetails: Array<any> }>(
      `${API_BASE}/preview/recipient/${entityType}/${entityId}/payments?${queryParams.toString()}`
    );
  }

  /**
   * Get detailed export data for entity (Agent/Agency)
   */
  async getExportDetails(
    entityType: string,
    entityId: string,
    startDate?: string,
    endDate?: string,
    nachaId?: string
  ): Promise<{
    success: boolean;
    summary: { totalRevenue: number; totalCommission: number; paymentCount: number };
    payments: any[];
    groups: any[];
    individuals: any[];
    products: any[];
  }> {
    const queryParams = new URLSearchParams();
    if (startDate) queryParams.append('startDate', startDate);
    if (endDate) queryParams.append('endDate', endDate);
    if (nachaId) queryParams.append('nachaId', nachaId);

    return await apiService.get<any>(`${API_BASE}/export-details/${entityType}/${entityId}?${queryParams.toString()}`);
  }

  async getAllExportDetails(
    startDate?: string,
    endDate?: string,
    nachaId?: string,
    entityTypes?: string[]
  ): Promise<{
    success: boolean;
    summary: any[];
    payments: any[];
  }> {
    const queryParams = new URLSearchParams();
    if (startDate) queryParams.append('startDate', startDate);
    if (endDate) queryParams.append('endDate', endDate);
    if (nachaId) queryParams.append('nachaId', nachaId);
    if (entityTypes) {
      entityTypes.forEach(t => queryParams.append('entityTypes', t));
    }

    return await apiService.get<any>(`${API_BASE}/export-all?${queryParams.toString()}`);
  }

  async downloadNACHA(nachaId: string, fileName: string): Promise<void> {
    await apiService.downloadFile(`${API_BASE}/${nachaId}/download`, fileName);
  }

  /**
   * Mark NACHA as sent
   */
  async markNACHAasSent(nachaId: string): Promise<void> {
    await apiService.put(`${API_BASE}/${nachaId}/mark-sent`);
  }

  /**
   * Mark NACHA as not sent (revert to Pending)
   */
  async markNACHAasNotSent(nachaId: string): Promise<void> {
    await apiService.put(`${API_BASE}/${nachaId}/mark-not-sent`);
  }

  /**
   * Delete NACHA file (only if Pending)
   */
  async deleteNACHA(nachaId: string): Promise<void> {
    await apiService.delete(`${API_BASE}/${nachaId}`);
  }

  /**
   * Get enrollments that make up a payment
   */
  async getPaymentEnrollments(paymentId: string): Promise<{ success: boolean; enrollments: Array<{
    enrollmentId: string;
    productName: string;
    memberName: string;
    netRate: number;
    overrideRate: number;
    commission: number;
    systemFees: number;
    effectiveDate: string;
    terminationDate: string | null;
    status: string;
  }> }> {
    return await apiService.get<{ success: boolean; enrollments: Array<{
      enrollmentId: string;
      productName: string;
      memberName: string;
      netRate: number;
      overrideRate: number;
      commission: number;
      systemFees: number;
      effectiveDate: string;
      terminationDate: string | null;
      status: string;
    }> }>(`${API_BASE}/payment/${paymentId}/enrollments`);
  }

  /**
   * Get payment breakdown - all recipients (agents/agencies/vendors/tenants) for a payment
   */
  async getPaymentBreakdown(paymentId: string): Promise<{ 
    success: boolean; 
    payment: {
      paymentId: string;
      amount: number;
      paymentDate: string;
      commissionPool: number;
      netRate: number;
      overrideRate: number;
    };
    recipients: Array<{
      entityType: string;
      entityId: string;
      entityName: string;
      amount: number;
      tierLevel: number | null;
      ruleId: string | null;
      ruleName: string | null;
      commissionType: string | null;
      isRuleBased: boolean;
      isOverflow: boolean;
    }>;
    summary: {
      totalRecipients: number;
      totalAmount: number;
      ruleBasedAmount: number;
      overflowAmount: number;
    };
  }> {
    return await apiService.get<{ 
      success: boolean; 
      payment: any;
      recipients: any[];
      summary: any;
    }>(`${API_BASE}/preview/payment/${paymentId}/breakdown`);
  }

  /**
   * Get fees breakdown (SystemFees + PaymentProcessingFee) grouped by group and member
   */
  async getFeesBreakdown(
    startDate: string,
    endDate: string,
    tenantId?: string
  ): Promise<FeesResponse> {
    const queryParams = new URLSearchParams();
    queryParams.append('startDate', startDate);
    queryParams.append('endDate', endDate);
    if (tenantId) {
      queryParams.append('tenantId', tenantId);
    }
    return await apiService.get<FeesResponse>(`${API_BASE}/preview/fees?${queryParams.toString()}`);
  }

  /**
   * Get default send destination vendor for a NACHA file (Vendor Payouts: single or largest vendor).
   */
  async getDefaultSendVendor(nachaId: string): Promise<{ success: boolean; vendorId: string | null }> {
    return await apiService.get<{ success: boolean; vendorId: string | null }>(
      `${API_BASE}/${nachaId}/default-send-vendor`
    );
  }

  /**
   * Send NACHA file to a vendor destination (SFTP + optional notification email).
   * Overrides sftpPath and exportEmailAddress apply only for this send.
   */
  async sendNACHA(
    nachaId: string,
    params: { vendorId: string; sftpPath?: string; exportEmailAddress?: string }
  ): Promise<{ success: boolean; data?: { sftp: any; emailQueued: boolean; fileName: string; remotePath: string }; message?: string }> {
    return await apiService.post<{ success: boolean; data?: any; message?: string }>(
      `${API_BASE}/${nachaId}/send`,
      params
    );
  }

  /**
   * Validate NACHA ledger integrity against oe.Payments snapshots
   */
  async validateLedger(params: {
    nachaId?: string;
    tenantId?: string; // SysAdmin only; TenantAdmin is scoped server-side
    status?: 'Sent' | 'Pending';
    payoutType?: string;
    limit?: number;
  } = {}): Promise<NACHAValidationResponse> {
    const queryParams = new URLSearchParams();
    if (params.nachaId) queryParams.append('nachaId', params.nachaId);
    if (params.tenantId) queryParams.append('tenantId', params.tenantId);
    if (params.status) queryParams.append('status', params.status);
    if (params.payoutType) queryParams.append('payoutType', params.payoutType);
    if (params.limit) queryParams.append('limit', params.limit.toString());

    return await apiService.get<NACHAValidationResponse>(
      `${API_BASE}/validate?${queryParams.toString()}`
    );
  }

  /**
   * Get vendor payables info for a NACHA (Vendor Payouts only).
   * Returns list of vendors with format info for Export Payables modal.
   */
  async getVendorPayablesInfo(nachaId: string): Promise<{
    success: boolean;
    vendors: Array<{ vendorId: string; vendorName: string; hasCustomFormat: boolean }>;
  }> {
    return await apiService.get<{
      success: boolean;
      vendors: Array<{ vendorId: string; vendorName: string; hasCustomFormat: boolean }>;
    }>(`${API_BASE}/${nachaId}/vendor-payables-info`);
  }

  /**
   * Export vendor payables CSV for a NACHA + vendor.
   * Returns csv, total, nachaPayout for reconciliation check.
   */
  async exportVendorPayables(
    nachaId: string,
    vendorId: string
  ): Promise<{
    success: boolean;
    csv: string;
    total: number;
    contractTotal?: number;
    paidTotal?: number;
    varianceTotal?: number;
    nachaPayout: number;
    rowCount: number;
    paidThroughStart?: string;
    paidThroughEnd?: string;
    nachaSentDate?: string;
    nachaGeneratedDate?: string;
    netTotal?: number;
    clawbacks?: { totalApplied: number; rowCount: number; includedInPayablesCsv?: boolean } | null;
    allocationWarnings?: PayablesAllocationWarning[];
    reconciliation?: PayablesReconciliationSummary | null;
  }> {
    return await apiService.get<{
      success: boolean;
      csv: string;
      total: number;
      contractTotal?: number;
      paidTotal?: number;
      varianceTotal?: number;
      netTotal?: number;
      nachaPayout: number;
      rowCount: number;
      paidThroughStart?: string;
      paidThroughEnd?: string;
      nachaSentDate?: string;
      nachaGeneratedDate?: string;
      reconciliation?: PayablesReconciliationSummary | null;
      clawbacks?: { totalApplied: number; rowCount: number; includedInPayablesCsv?: boolean } | null;
      allocationWarnings?: PayablesAllocationWarning[];
    }>(`${API_BASE}/${nachaId}/vendor/${vendorId}/payables-export`);
  }

  /**
   * Explain why the payables CSV total doesn't match NACHA payout for a vendor.
   * Returns a list of per-NACHAPaymentDetail discrepancies (retroactively terminated enrollments,
   * refunds, ACH returns, invoice/billing-period mismatches, etc.), each with the primary
   * member info and reasons — used by the Reconciliation Warning dialog.
   */
  async getVendorPayablesDiscrepancies(
    nachaId: string,
    vendorId: string
  ): Promise<{
    success: boolean;
    discrepancies: PayablesDiscrepancy[];
  }> {
    return await apiService.get<{
      success: boolean;
      discrepancies: PayablesDiscrepancy[];
    }>(`${API_BASE}/${nachaId}/vendor/${vendorId}/payables-discrepancies`);
  }

  /**
   * "Retry Bounces" — preview the line items of an existing NACHA, with each
   * recipient's ORIGINAL ACH snapshot vs CURRENT ACH info, so the admin can
   * pick which payouts to re-issue.
   */
  async getRetryPreview(nachaId: string): Promise<RetryPreviewResponse> {
    return await apiService.get<RetryPreviewResponse>(`${API_BASE}/${nachaId}/retry-preview`);
  }

  /**
   * "Retry Bounces" — generate a new NACHA file that re-issues the selected line
   * items from the original NACHA, using each recipient's CURRENT bank info.
   * Does NOT touch oe.Commissions / oe.Payments paid totals (markNACHAasSent
   * is reissue-aware).
   */
  async retryBounces(
    nachaId: string,
    payload: {
      paymentDetailIds: string[];
      fundingAchAccountId: string;
      companyIdentification: string;
    }
  ): Promise<RetryBouncesResponse> {
    // Same generation pipeline as generateNACHA — needs the same 5 min ceiling.
    return await apiService.post<RetryBouncesResponse>(
      `${API_BASE}/${nachaId}/retry`,
      payload,
      { timeout: NACHA_GENERATE_TIMEOUT_MS }
    );
  }

  /**
   * Get ACH account details with decrypted routing and account numbers
   * Returns all accounts for vendors (splits), single account for others
   */
  async getACHDetails(
    entityType: string,
    entityId: string,
    payoutType?: string
  ): Promise<{
    success: boolean;
    data: {
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
    };
  }> {
    const queryParams = new URLSearchParams();
    if (payoutType) {
      queryParams.append('payoutType', payoutType);
    }
    const queryString = queryParams.toString();
    return await apiService.get<{
      success: boolean;
      data: {
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
      };
    }>(`${API_BASE}/ach-details/${entityType}/${entityId}${queryString ? `?${queryString}` : ''}`);
  }
}

export const nachaService = new NACHAService();
export type {
  NACHAGeneration,
  NACHALineItem,
  NACHAPreview
};

