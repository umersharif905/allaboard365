// File: frontend/src/hooks/useAccounting.ts
import { useCallback, useEffect, useState } from 'react';
import {
  accountingService,
  CommissionRecord,
  ExportResponse,
  PaymentFilters,
  PaymentRecord,
  PaymentRetryResponse,
  PaymentSummary,
  RevenueReports
} from '../services/AccountingService';

// ===================================================================================================
// ACCOUNTING HOOK INTERFACES
// ===================================================================================================

interface UseAccountingReturn {
  // Payment data
  payments: PaymentRecord[];
  paymentSummary: PaymentSummary | null;
  paymentsLoading: boolean;
  paymentsError: string | null;
  
  // Commission data
  commissions: CommissionRecord[];
  commissionsLoading: boolean;
  commissionsError: string | null;
  
  // Revenue reports
  revenueReports: RevenueReports | null;
  reportsLoading: boolean;
  reportsError: string | null;
  
  // Filters
  filters: PaymentFilters;
  
  // Actions
  setFilters: (filters: PaymentFilters) => void;
  clearFilters: () => void;
  fetchPayments: (currentFilters?: PaymentFilters) => Promise<void>;
  refreshPayments: () => Promise<void>;
  refreshCommissions: () => Promise<void>;
  refreshReports: () => Promise<void>;
  retryPayment: (paymentId: string) => Promise<PaymentRetryResponse>;
  exportPayments: (format: 'csv' | 'pdf') => Promise<ExportResponse>;
  exportCommissions: (format: 'csv' | 'pdf') => Promise<ExportResponse>;
  exportReports: (format: 'csv' | 'pdf', reportType?: string) => Promise<ExportResponse>;
}

const defaultFilters: PaymentFilters = {
  search: '',
  status: '',
  paymentMethod: '',
  tenantName: '',
  dateRange: ''
};

const defaultSummary: PaymentSummary = {
  totalPayments: 0,
  successfulPayments: 0,
  failedPayments: 0,
  pendingPayments: 0,
  totalRevenue: 0,
  averagePayment: 0,
  monthlyGrowth: 0
};

// ===================================================================================================
// MAIN ACCOUNTING HOOK
// ===================================================================================================

export const useAccounting = (): UseAccountingReturn => {
  // State management
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary | null>(null);
  const [paymentsLoading, setPaymentsLoading] = useState<boolean>(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  
  const [commissions, setCommissions] = useState<CommissionRecord[]>([]);
  const [commissionsLoading, setCommissionsLoading] = useState<boolean>(false);
  const [commissionsError, setCommissionsError] = useState<string | null>(null);
  
  const [revenueReports, setRevenueReports] = useState<RevenueReports | null>(null);
  const [reportsLoading, setReportsLoading] = useState<boolean>(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  
  const [filters, setFiltersState] = useState<PaymentFilters>(defaultFilters);

  // ===================================================================================================
  // PAYMENT OPERATIONS
  // ===================================================================================================

  const fetchPayments = useCallback(async (currentFilters: PaymentFilters = filters) => {
    setPaymentsLoading(true);
    setPaymentsError(null);
    
    try {
      const response = await accountingService.getPayments(currentFilters);
      if (response.success) {
        setPayments(response.payments);
        setPaymentSummary(response.summary);
      } else {
        throw new Error('Failed to fetch payments');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      setPaymentsError(errorMessage);
      console.error('Error fetching payments:', error);
    } finally {
      setPaymentsLoading(false);
    }
  }, [filters]);

  const refreshPayments = useCallback(async () => {
    await fetchPayments();
  }, [fetchPayments]);

  const retryPayment = useCallback(async (paymentId: string): Promise<PaymentRetryResponse> => {
    try {
      const response = await accountingService.retryPayment(paymentId);
      
      // Refresh payments after retry attempt
      await fetchPayments();
      
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to retry payment';
      throw new Error(errorMessage);
    }
  }, [fetchPayments]);

  // ===================================================================================================
  // COMMISSION OPERATIONS
  // ===================================================================================================

  const fetchCommissions = useCallback(async (currentFilters: PaymentFilters = filters) => {
    setCommissionsLoading(true);
    setCommissionsError(null);
    
    try {
      const response = await accountingService.getCommissions(currentFilters);
      if (response.success) {
        setCommissions(response.commissions);
      } else {
        throw new Error('Failed to fetch commissions');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      setCommissionsError(errorMessage);
      console.error('Error fetching commissions:', error);
    } finally {
      setCommissionsLoading(false);
    }
  }, [filters]);

  const refreshCommissions = useCallback(async () => {
    await fetchCommissions();
  }, [fetchCommissions]);

  // ===================================================================================================
  // REVENUE REPORTS
  // ===================================================================================================

  const fetchReports = useCallback(async () => {
    setReportsLoading(true);
    setReportsError(null);
    
    try {
      const reports = await accountingService.getRevenueReports();
      setRevenueReports(reports);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      setReportsError(errorMessage);
      console.error('Error fetching revenue reports:', error);
    } finally {
      setReportsLoading(false);
    }
  }, []);

  const refreshReports = useCallback(async () => {
    await fetchReports();
  }, [fetchReports]);

  // ===================================================================================================
  // EXPORT OPERATIONS
  // ===================================================================================================

  const exportPayments = useCallback(async (format: 'csv' | 'pdf'): Promise<ExportResponse> => {
    try {
      return await accountingService.exportPayments({ format });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to export payments';
      throw new Error(errorMessage);
    }
  }, []);

  const exportCommissions = useCallback(async (format: 'csv' | 'pdf'): Promise<ExportResponse> => {
    try {
      return await accountingService.exportCommissions({ format });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to export commissions';
      throw new Error(errorMessage);
    }
  }, []);

  const exportReports = useCallback(async (format: 'csv' | 'pdf', reportType?: string): Promise<ExportResponse> => {
    try {
      return await accountingService.exportReports({ format, reportType });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to export reports';
      throw new Error(errorMessage);
    }
  }, []);

  // ===================================================================================================
  // FILTER MANAGEMENT
  // ===================================================================================================

  const setFilters = useCallback((newFilters: PaymentFilters) => {
    setFiltersState(newFilters);
  }, []);

  const clearFilters = useCallback(() => {
    setFiltersState(defaultFilters);
  }, []);

  // ===================================================================================================
  // EFFECTS
  // ===================================================================================================

  // Initial data load
  useEffect(() => {
    fetchPayments();
    fetchCommissions();
    fetchReports();
  }, []);

  // Refetch payments when filters change
  useEffect(() => {
    fetchPayments(filters);
  }, [filters, fetchPayments]);

  // Refetch commissions when filters change
  useEffect(() => {
    fetchCommissions(filters);
  }, [filters, fetchCommissions]);

  // ===================================================================================================
  // RETURN INTERFACE
  // ===================================================================================================

  return {
    // Payment data
    payments,
    paymentSummary: paymentSummary || defaultSummary,
    paymentsLoading,
    paymentsError,
    
    // Commission data
    commissions,
    commissionsLoading,
    commissionsError,
    
    // Revenue reports
    revenueReports,
    reportsLoading,
    reportsError,
    
    // Filters
    filters,
    
    // Actions
    setFilters,
    clearFilters,
    fetchPayments,
    refreshPayments,
    refreshCommissions,
    refreshReports,
    retryPayment,
    exportPayments,
    exportCommissions,
    exportReports
  };
};

// ===================================================================================================
// SPECIALIZED HOOKS FOR SPECIFIC DATA
// ===================================================================================================

/**
 * Hook specifically for payment management
 */
export const usePayments = (initialFilters?: PaymentFilters) => {
  const {
    payments,
    paymentSummary,
    paymentsLoading,
    paymentsError,
    refreshPayments,
    retryPayment,
    exportPayments,
    setFilters,
    clearFilters,
    filters
  } = useAccounting();

  useEffect(() => {
    if (initialFilters) {
      setFilters(initialFilters);
    }
  }, [initialFilters, setFilters]);

  return {
    payments,
    summary: paymentSummary,
    loading: paymentsLoading,
    error: paymentsError,
    refresh: refreshPayments,
    retryPayment,
    exportPayments,
    setFilters,
    clearFilters,
    filters
  };
};

/**
 * Hook specifically for commission management
 */
export const useCommissions = (initialFilters?: PaymentFilters) => {
  const {
    commissions,
    commissionsLoading,
    commissionsError,
    refreshCommissions,
    exportCommissions,
    setFilters,
    clearFilters,
    filters
  } = useAccounting();

  useEffect(() => {
    if (initialFilters) {
      setFilters(initialFilters);
    }
  }, [initialFilters, setFilters]);

  return {
    commissions,
    loading: commissionsLoading,
    error: commissionsError,
    refresh: refreshCommissions,
    exportCommissions,
    setFilters,
    clearFilters,
    filters
  };
};

/**
 * Hook specifically for revenue reports
 */
export const useRevenueReports = () => {
  const {
    revenueReports,
    reportsLoading,
    reportsError,
    refreshReports,
    exportReports
  } = useAccounting();

  return {
    reports: revenueReports,
    loading: reportsLoading,
    error: reportsError,
    refresh: refreshReports,
    exportReports
  };
};

export default useAccounting;