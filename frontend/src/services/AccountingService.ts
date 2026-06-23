// File: frontend/src/services/AccountingService.ts
import { apiService } from './api.service';

// ===================================================================================================
// ACCOUNTING SERVICE INTERFACES
// ===================================================================================================

export interface PaymentRecord {
  PaymentId: string;
  MemberName: string;
  TenantName: string;
  ProductName: string;
  Amount: number;
  Status: 'Completed' | 'Pending' | 'Failed' | 'Processing';
  PaymentMethod: 'Credit Card' | 'ACH' | 'Bank Transfer';
  PaymentDate: string;
  NextBillingDate?: string;
  ProcessorTransactionId?: string;
  FailureReason?: string;
}

export interface CommissionRecord {
  CommissionId: string;
  AgentName: string;
  TenantName: string;
  EnrollmentId: string;
  ProductName: string;
  Amount: number;
  Percentage: number;
  Status: 'Paid' | 'Pending' | 'Processing';
  PaymentDate?: string;
  CreatedDate: string;
}

export interface PaymentSummary {
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  pendingPayments: number;
  totalRevenue: number;
  averagePayment: number;
  monthlyGrowth: number;
}

export interface RevenueByMonth {
  month: string;
  revenue: number;
  payments: number;
  commissions: number;
  netRevenue: number;
}

export interface RevenueByTenant {
  tenantName: string;
  revenue: number;
  members: number;
  products: number;
}

export interface RevenueByProduct {
  productName: string;
  productType: string;
  revenue: number;
  subscriptions: number;
  averagePrice: number;
}

export interface CommissionsByAgent {
  agentName: string;
  tenantName: string;
  totalCommissions: number;
  totalSales: number;
  averageRate: number;
}

export interface RevenueReports {
  revenueByMonth: RevenueByMonth[];
  revenueByTenant: RevenueByTenant[];
  revenueByProduct: RevenueByProduct[];
  commissionsByAgent: CommissionsByAgent[];
  summary: {
    totalRevenue: number;
    totalPayments: number;
    totalCommissions: number;
    totalRefunds: number;
    growthRate: number;
    netRevenue: number;
  };
}

export interface PaymentFilters {
  search?: string;
  status?: string;
  paymentMethod?: string;
  tenantName?: string;
  dateRange?: string;
}

export interface PaymentRetryResponse {
  success: boolean;
  transactionId?: string;
  message: string;
}

export interface RetryPaymentMethodOption {
  paymentMethodId: string;
  label: string;
  type: 'ACH' | 'Card';
  isDefault: boolean;
}

export interface PaymentRetryOptionsResponse {
  success: boolean;
  context: 'group' | 'household';
  groupId?: string;
  householdId?: string;
  paymentMethods: RetryPaymentMethodOption[];
  linkedInvoice?: RetryLinkedInvoice | null;
  /** Household only: same shape as GET /members/:id/charge-now-preview data (period picker). */
  chargeNowPreview?: ChargeNowRetryPreviewPayload | null;
}

export interface RetryLinkedInvoice {
  invoiceId: string;
  invoiceNumber?: string | null;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
  status?: string | null;
}

export interface ChargeNowRetryPreviewExistingInvoice {
  invoiceId: string;
  invoiceNumber: string;
  totalAmount: number;
  paidAmount: number;
  creditAmount?: number;
  balanceDue?: number;
  status: string;
}

export interface ChargeNowRetrySelectablePeriod {
  billingPeriodStart: string;
  billingPeriodEnd: string;
  estimatedAmount: number;
  existingInvoice: ChargeNowRetryPreviewExistingInvoice | null;
}

export interface ChargeNowRetryPreviewPayload {
  defaultAmount: number;
  nextInvoice?: {
    invoiceId: string;
    invoiceNumber: string;
    billingPeriodStart: string;
    billingPeriodEnd: string;
    totalAmount: number;
    paidAmount: number;
    creditAmount?: number;
    balanceDue?: number;
    status: string;
  } | null;
  nextPeriod?: {
    billingPeriodStart: string;
    billingPeriodEnd: string;
    estimatedAmount: number;
  } | null;
  selectablePeriods?: ChargeNowRetrySelectablePeriod[];
}

export interface PaymentRetryRequestBody {
  groupPaymentMethodId?: string;
  memberPaymentMethodId?: string;
  /** Household retry: pins InvoiceId via getOrCreateInvoiceForPeriod (matches Charge now). */
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  invoiceId?: string;
}

export interface ExportRequest {
  format: 'csv' | 'pdf';
  reportType?: string;
}

export interface ExportResponse {
  success: boolean;
  data: string;
  filename?: string;  // Made optional to fix the error
  downloadUrl?: string;
}

// ===================================================================================================
// ACCOUNTING SERVICE CLASS
// ===================================================================================================

class AccountingService {
  
  // =======================
  // PAYMENT OPERATIONS
  // =======================
  
  /**
   * Get payments with optional filtering
   */
  async getPayments(filters?: PaymentFilters): Promise<{
    success: boolean;
    payments: PaymentRecord[];
    summary: PaymentSummary;
  }> {
    const queryParams = new URLSearchParams();
    
    if (filters?.status) queryParams.append('status', filters.status);
    if (filters?.paymentMethod) queryParams.append('paymentMethod', filters.paymentMethod);
    if (filters?.tenantName) queryParams.append('tenantName', filters.tenantName);
    if (filters?.dateRange) queryParams.append('dateRange', filters.dateRange);
    if (filters?.search) queryParams.append('search', filters.search);
    
    const url = `/api/accounting/payments${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const result = await apiService.get<{
      success: boolean;
      payments: PaymentRecord[];
      summary: PaymentSummary;
    }>(url);
    return result;
  }

  /**
   * Get payment methods available for retry (group or household). Use to show dropdown; default = option with isDefault.
   */
  async getRetryOptions(paymentId: string): Promise<PaymentRetryOptionsResponse> {
    const result = await apiService.get<PaymentRetryOptionsResponse>(`/api/accounting/payments/${paymentId}/retry-options`);
    return result;
  }

  /**
   * Retry a failed payment. Pass selected groupPaymentMethodId or memberPaymentMethodId when user chose a non-default method.
   */
  async retryPayment(paymentId: string, body?: PaymentRetryRequestBody): Promise<PaymentRetryResponse> {
    const result = await apiService.post<PaymentRetryResponse>(`/api/accounting/payments/${paymentId}/retry`, body ?? {});
    return result;
  }

  /**
   * Get payment details by ID
   */
  async getPaymentDetails(paymentId: string): Promise<PaymentRecord> {
    const result = await apiService.get<PaymentRecord>(`/api/accounting/payments/${paymentId}`);
    return result;
  }

  /**
   * Export payments data
   */
  async exportPayments(request: ExportRequest): Promise<ExportResponse> {
    const queryParams = new URLSearchParams();
    queryParams.append('format', request.format);
    
    const result = await apiService.get<ExportResponse>(`/api/accounting/payments/export?${queryParams.toString()}`);
    return result;
  }

  // =======================
  // COMMISSION OPERATIONS
  // =======================
  
  /**
   * Get commissions with optional filtering
   */
  async getCommissions(filters?: PaymentFilters): Promise<{
    success: boolean;
    commissions: CommissionRecord[];
    summary: any;
  }> {
    const queryParams = new URLSearchParams();
    
    if (filters?.status) queryParams.append('status', filters.status);
    if (filters?.tenantName) queryParams.append('tenantName', filters.tenantName);
    if (filters?.search) queryParams.append('search', filters.search);
    
    const url = `/api/accounting/commissions${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const result = await apiService.get<{
      success: boolean;
      commissions: CommissionRecord[];
      summary: any;
    }>(url);
    return result;
  }

  /**
   * Process commission payments
   */
  async processCommissionPayments(commissionIds: string[]): Promise<{
    success: boolean;
    processedCount: number;
    failedCount: number;
    message: string;
  }> {
    const result = await apiService.post<{
      success: boolean;
      processedCount: number;
      failedCount: number;
      message: string;
    }>('/api/accounting/commissions/process', {
      commissionIds
    });
    return result;
  }

  /**
   * Export commissions data
   */
  async exportCommissions(request: ExportRequest): Promise<ExportResponse> {
    const queryParams = new URLSearchParams();
    queryParams.append('format', request.format);
    
    const result = await apiService.get<ExportResponse>(`/api/accounting/commissions/export?${queryParams.toString()}`);
    return result;
  }

  // =======================
  // REVENUE REPORTING
  // =======================
  
  /**
   * Get comprehensive revenue reports
   */
  async getRevenueReports(): Promise<RevenueReports> {
    const result = await apiService.get<RevenueReports>('/api/accounting/reports');
    return result;
  }

  /**
   * Get revenue by month data for charts
   */
  async getRevenueByMonth(year?: number): Promise<RevenueByMonth[]> {
    const currentYear = year || new Date().getFullYear();
    const result = await apiService.get<{ revenueByMonth: RevenueByMonth[] }>(`/api/accounting/reports/revenue-by-month?year=${currentYear}`);
    return result.revenueByMonth || [];
  }

  /**
   * Get revenue by tenant breakdown
   */
  async getRevenueByTenant(): Promise<RevenueByTenant[]> {
    const result = await apiService.get<{ revenueByTenant: RevenueByTenant[] }>('/api/accounting/reports/revenue-by-tenant');
    return result.revenueByTenant || [];
  }

  /**
   * Get revenue by product breakdown
   */
  async getRevenueByProduct(): Promise<RevenueByProduct[]> {
    const result = await apiService.get<{ revenueByProduct: RevenueByProduct[] }>('/api/accounting/reports/revenue-by-product');
    return result.revenueByProduct || [];
  }

  /**
   * Get commissions by agent
   */
  async getCommissionsByAgent(): Promise<CommissionsByAgent[]> {
    const result = await apiService.get<{ commissionsByAgent: CommissionsByAgent[] }>('/api/accounting/reports/commissions-by-agent');
    return result.commissionsByAgent || [];
  }

  /**
   * Export revenue reports
   */
  async exportReports(request: ExportRequest): Promise<ExportResponse> {
    const queryParams = new URLSearchParams();
    queryParams.append('format', request.format);
    if (request.reportType) queryParams.append('reportType', request.reportType);
    
    const result = await apiService.get<ExportResponse>(`/api/accounting/reports/export?${queryParams.toString()}`);
    return result;
  }

  // =======================
  // UTILITY METHODS
  // =======================
  
  /**
   * Format currency values
   */
  formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  /**
   * Format percentage values
   */
  formatPercentage(value: number): string {
    return `${value.toFixed(2)}%`;
  }

  /**
   * Format date values
   */
  formatDate(date: string): string {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  /**
   * Get status badge color class
   */
  getStatusColor(status: string): string {
    switch (status.toLowerCase()) {
      case 'completed':
      case 'paid':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'processing':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  }
}

// Export singleton instance
export const accountingService = new AccountingService();