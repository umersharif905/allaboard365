import { apiService } from './api.service';

export interface Invoice {
  InvoiceId: string;
  InvoiceNumber: string;
  InvoiceType: 'Group' | 'Individual';
  Status: 'Unpaid' | 'Partial' | 'Paid' | 'Overdue' | 'Cancelled';
  TotalAmount: number;
  PaidAmount: number;
  BalanceDue: number;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  DueDate: string;
  HouseholdId?: string;
  GroupId?: string;
  MemberId?: string;
  CreatedDate: string;
  ModifiedDate?: string;
  MemberFirstName?: string;
  MemberLastName?: string;
  MemberEmail?: string;
  GroupName?: string;
  PaymentCount?: number;
  PendingPaymentCount?: number;
  PendingPaymentAmount?: number;
  LatestPendingPaymentDate?: string | null;
  LatestPendingPaymentMethod?: string | null;
  /** 1/true when the latest pending payment is not linked to this invoice yet (links automatically on settlement). */
  LatestPendingPaymentUnlinked?: number | boolean;
  ReminderSendCount?: number;
  LastReminderSentAt?: string | null;
  LastReminderHadEmail?: number | boolean;
  LastReminderHadSms?: number | boolean;
}

export interface InvoicePayment {
  PaymentId: string;
  Amount: number;
  Status: string;
  PaymentMethod: string;
  PaymentDate: string;
  CreatedDate: string;
}

export interface InvoiceDetail extends Invoice {
  payments: InvoicePayment[];
}

export interface InvoiceSummary {
  InvoiceId: string;
  InvoiceNumber: string;
  TotalAmount: number;
  PaidAmount: number;
  Status: string;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  HouseholdId?: string;
  GroupId?: string;
  InvoiceType: string;
  DueDate: string;
  PaymentCount: number;
  ActualCollected: number;
}

export interface InvoicePayoutFlags {
  commissions: boolean;
  vendors: boolean;
  overrides: boolean;
}

export interface InvoicePayoutLineItem {
  recipientName: string;
  amount: number;
  payoutDate: string | null;
  transactionType?: string | null;
  payoutType?: string | null;
}

export interface InvoicePayoutDetails {
  invoiceId: string;
  invoiceNumber: string | null;
  commissions: InvoicePayoutLineItem[];
  vendors: InvoicePayoutLineItem[];
  overrides: InvoicePayoutLineItem[];
}

export interface InvoiceListSummary {
  invoiceCount: number;
  totalAmount: number;
  totalPaid: number;
  totalBalanceDue: number;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  pagination?: { page: number; pageSize: number; total: number };
  summary?: InvoiceListSummary;
}

export interface InvoiceFilters {
  status?: string;
  type?: string;
  overdue?: boolean;
  householdId?: string;
  memberId?: string;
  groupId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  /** Overdue list only: most_overdue (default) | highest_balance | newest */
  sortBy?: string;
}

class InvoicesService {
  async getInvoices(filters: InvoiceFilters = {}): Promise<ApiResponse<Invoice[]>> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.type) params.set('type', filters.type);
    if (filters.overdue) params.set('overdue', 'true');
    if (filters.householdId) params.set('householdId', filters.householdId);
    if (filters.memberId) params.set('memberId', filters.memberId);
    if (filters.groupId) params.set('groupId', filters.groupId);
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    if (filters.search) params.set('search', filters.search);
    if (filters.page) params.set('page', String(filters.page));
    if (filters.pageSize) params.set('pageSize', String(filters.pageSize));
    if (filters.sortBy) params.set('sortBy', filters.sortBy);

    const qs = params.toString();
    return apiService.get<ApiResponse<Invoice[]>>(`/api/invoices${qs ? `?${qs}` : ''}`);
  }

  async getInvoiceDetail(invoiceId: string): Promise<ApiResponse<InvoiceDetail>> {
    return apiService.get<ApiResponse<InvoiceDetail>>(`/api/invoices/${invoiceId}`);
  }

  async getInvoiceSummary(invoiceId: string): Promise<ApiResponse<InvoiceSummary>> {
    return apiService.get<ApiResponse<InvoiceSummary>>(`/api/invoices/${invoiceId}/summary`);
  }

  async getInvoicePayoutFlags(householdId: string): Promise<ApiResponse<Record<string, InvoicePayoutFlags>>> {
    const params = new URLSearchParams({ householdId });
    return apiService.get<ApiResponse<Record<string, InvoicePayoutFlags>>>(
      `/api/invoices/payout-flags?${params.toString()}`
    );
  }

  async getInvoicePayoutDetails(invoiceId: string): Promise<ApiResponse<InvoicePayoutDetails>> {
    return apiService.get<ApiResponse<InvoicePayoutDetails>>(
      `/api/invoices/${encodeURIComponent(invoiceId)}/payout-details`
    );
  }

  async getMemberInvoices(): Promise<ApiResponse<Invoice[]>> {
    return apiService.get<ApiResponse<Invoice[]>>('/api/invoices/me/member');
  }

  /** Member self-serve: pay full BalanceDue on a single household invoice. */
  async payMemberInvoiceBalance(invoiceId: string): Promise<{
    success: boolean;
    message?: string;
    data?: {
      paymentId: string;
      amount: number;
      transactionId: string;
      invoice?: {
        invoiceId: string;
        invoiceNumber: string | null;
        billingPeriodStart: string | null;
        billingPeriodEnd: string | null;
        created: boolean;
      } | null;
      paymentRecordStatus?: string;
    };
    error?: { code?: string };
  }> {
    return apiService.post(`/api/me/member/invoices/pay-balance`, { invoiceId });
  }

  async getAgentInvoices(filters: InvoiceFilters = {}): Promise<ApiResponse<Invoice[]>> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.overdue) params.set('overdue', 'true');
    if (filters.page) params.set('page', String(filters.page));
    if (filters.pageSize) params.set('pageSize', String(filters.pageSize));

    const qs = params.toString();
    return apiService.get<ApiResponse<Invoice[]>>(`/api/invoices/me/agent${qs ? `?${qs}` : ''}`);
  }
  async updateInvoice(invoiceId: string, updates: { paidAmount?: number; status?: string }): Promise<ApiResponse<null>> {
    return apiService.patch<ApiResponse<null>>(`/api/invoices/${invoiceId}`, updates);
  }

  async deleteInvoice(invoiceId: string): Promise<ApiResponse<null>> {
    return apiService.delete<ApiResponse<null>>(`/api/invoices/${encodeURIComponent(invoiceId)}`);
  }

  /**
   * Same self-heal + reconcile + optional DIME sync the nightly job runs per open Individual invoice.
   */
  async resyncInvoiceOpenMaintenance(invoiceId: string): Promise<{
    success: boolean;
    message?: string;
    skipped?: boolean;
    data?: {
      selfHeal?: { linkedPayments: number; paidAmountApplied: number };
      reconcile?: { updated: boolean; newTotalAmount?: number; reason?: string };
      /** Paid invoice path: align TotalAmount/breakdown when PaidAmount matches enrollment sum */
      enrollmentTotalsSync?: {
        updated: boolean;
        reason?: string;
        newTotalAmount?: number;
        previousTotalAmount?: number;
      };
      ledgerSync?: { updated?: boolean; reason?: string };
      dimeRecurringSynced?: boolean;
      dimeSyncError?: string | null;
    };
  }> {
    return apiService.post(`/api/invoices/${encodeURIComponent(invoiceId)}/resync-open-maintenance`, {});
  }

  async getInvoiceAudit(invoiceId: string): Promise<ApiResponse<InvoiceAuditPayload>> {
    return apiService.get<ApiResponse<InvoiceAuditPayload>>(`/api/invoices/${invoiceId}/audit`);
  }

  async correctInvoiceBreakdowns(invoiceId: string): Promise<ApiResponse<InvoiceAuditPayload>> {
    return apiService.post<ApiResponse<InvoiceAuditPayload>>(`/api/invoices/${invoiceId}/audit/correct`, {});
  }

  async backfillBreakdowns(): Promise<ApiResponse<BackfillBreakdownsResult>> {
    return apiService.post<ApiResponse<BackfillBreakdownsResult>>('/api/invoices/backfill-breakdowns', {});
  }

  /**
   * Fetch Individual invoice PDF (requires auth). Omit download for inline / print preview.
   */
  async fetchIndividualInvoicePdfBlob(
    invoiceId: string,
    opts?: { download?: boolean; memberId?: string }
  ): Promise<Blob> {
    const qs = opts?.download ? '?download=1' : '';
    const path = opts?.memberId
      ? `/api/members/${encodeURIComponent(opts.memberId)}/invoices/${encodeURIComponent(invoiceId)}/pdf${qs}`
      : `/api/invoices/${encodeURIComponent(invoiceId)}/pdf${qs}`;
    return apiService.get(path, {
      responseType: 'blob',
    }) as unknown as Promise<Blob>;
  }

  /** Open PDF in a new tab for viewing / printing (on-demand generation). */
  async openIndividualInvoicePdfInNewTab(
    invoiceId: string,
    opts?: { memberId?: string }
  ): Promise<void> {
    const blob = await this.fetchIndividualInvoicePdfBlob(invoiceId, opts);
    if (blob.type === 'application/json') {
      let msg = 'Could not load invoice PDF';
      try {
        const body = JSON.parse(await blob.text()) as { message?: string };
        if (body.message) msg = body.message;
      } catch {
        /* ignore parse errors */
      }
      throw new Error(msg);
    }
    const url = URL.createObjectURL(blob);
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
    }
  }

  /** Trigger browser download of the PDF file. */
  async downloadIndividualInvoicePdf(
    invoiceId: string,
    filenameBase?: string,
    opts?: { memberId?: string }
  ): Promise<void> {
    const blob = await this.fetchIndividualInvoicePdfBlob(invoiceId, {
      download: true,
      memberId: opts?.memberId,
    });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = filenameBase ? `${filenameBase}.pdf` : `invoice-${invoiceId}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  /** TenantAdmin/SysAdmin: relink individual household payment; adjusts invoice PaidAmount/Status when payment is successful. */
  async linkPaymentToInvoice(
    paymentId: string,
    invoiceId: string | null
  ): Promise<
    ApiResponse<{
      previousInvoiceId: string | null;
      newInvoiceId: string | null;
      warnings?: string[];
      noOp?: boolean;
    }>
  > {
    return apiService.post(`/api/invoices/payments/${encodeURIComponent(paymentId)}/invoice-link`, {
      invoiceId
    });
  }
}

export interface BackfillBreakdownsResult {
  phase1CopiedFromPayments: number;
  phase2Recomputed: number;
  phase2Errors: number;
  remainingUnpopulated: number;
}

export interface InvoiceAuditBuckets {
  netRate: number;
  overrideRate: number;
  commission: number;
  systemFees: number;
  processingFeeAmount: number;
  setupFee: number;
  productCommissionsJSON: string;
  productVendorAmountsJSON: string;
  productOwnerAmountsJSON: string;
}

export interface InvoiceAuditPayload {
  context: 'group' | 'household';
  billingPeriod: { startDate: string; endDate: string } | null;
  invoice: {
    InvoiceId: string;
    TenantId: string;
    GroupId: string | null;
    HouseholdId: string | null;
    InvoiceType: string;
    InvoiceNumber: string;
    TotalAmount: number;
    PaidAmount: number;
    Status: string;
    DueDate: string;
    CreatedDate: string;
    ModifiedDate: string;
    NetRate: number;
    OverrideRate: number;
    Commission: number;
    SystemFees: number;
    ProcessingFeeAmount: number;
    SetupFee: number;
    ProductCommissions: string | null;
    ProductVendorAmounts: string | null;
    ProductOwnerAmounts: string | null;
  };
  computed: InvoiceAuditBuckets;
  totals: {
    computedSum: number;
    storedSum: number;
    totalAmount: number;
    computedVsTotalDiff: number;
    storedVsComputedDiff: number;
  };
}

export const invoicesService = new InvoicesService();
