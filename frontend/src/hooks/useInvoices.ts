import { useQuery } from '@tanstack/react-query';
import { invoicesService, type InvoiceFilters, type InvoiceListSummary } from '../services/invoices.service';

export function useInvoices(filters: InvoiceFilters = {}, enabled = true) {
  return useQuery({
    queryKey: ['invoices', filters],
    queryFn: () => invoicesService.getInvoices(filters),
    enabled,
    select: (response) => ({
      invoices: response?.data || [],
      pagination: response?.pagination,
      summary: response?.summary as InvoiceListSummary | undefined,
    }),
  });
}

export function useInvoiceDetail(invoiceId: string | null) {
  return useQuery({
    queryKey: ['invoice-detail', invoiceId],
    queryFn: () => invoicesService.getInvoiceDetail(invoiceId!),
    enabled: !!invoiceId,
    select: (response) => response?.data || null,
  });
}

export function useInvoiceSummary(invoiceId: string | null) {
  return useQuery({
    queryKey: ['invoice-summary', invoiceId],
    queryFn: () => invoicesService.getInvoiceSummary(invoiceId!),
    enabled: !!invoiceId,
    select: (response) => response?.data || null,
  });
}

export function useInvoicePayoutFlags(householdId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['invoice-payout-flags', householdId],
    queryFn: () => invoicesService.getInvoicePayoutFlags(householdId!),
    enabled: enabled && !!householdId,
    select: (response) => response?.data || {},
  });
}

export function useMemberInvoices(enabled = true) {
  return useQuery({
    queryKey: ['member-invoices'],
    queryFn: () => invoicesService.getMemberInvoices(),
    enabled,
    select: (response) => response?.data || [],
  });
}

export function useAgentInvoices(filters: InvoiceFilters = {}, enabled = true) {
  return useQuery({
    queryKey: ['agent-invoices', filters],
    queryFn: () => invoicesService.getAgentInvoices(filters),
    enabled,
    select: (response) => response?.data || [],
  });
}

