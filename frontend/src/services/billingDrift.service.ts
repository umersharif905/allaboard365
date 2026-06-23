// File: frontend/src/services/billingDrift.service.ts
//
// Client for the over-billed invoice detector. The GET endpoint is read-only
// and safe to call from any audit surface; the POST endpoint issues a credit
// through the existing household credit ledger.

import { apiService } from './api.service';

export interface BillingDriftDroppedItem {
  enrollmentId: string;
  productId: string | null;
  productName: string | null;
  premiumAmount: number;
  effectiveDate: string | null;
  terminationDate: string | null;
  status: string | null;
  enrollmentType: string | null;
}

export interface BillingDriftCandidate {
  invoiceId: string;
  invoiceNumber: string | null;
  tenantId: string;
  householdId: string;
  memberId: string | null;
  memberName: string | null;
  memberEmail: string | null;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  invoiceDate: string | null;
  totalAmount: number;
  paidAmount: number;
  creditAlreadyApplied: number;
  recomputedTotal: number;
  suggestedCredit: number;
  activeEnrollmentCount: number;
  status: string;
  droppedItems: BillingDriftDroppedItem[];
}

export interface BillingDriftSummary {
  count: number;
  totalSuggestedCredit: number;
}

export interface BillingDriftResponse {
  candidates: BillingDriftCandidate[];
  summary: BillingDriftSummary;
}

export const billingDriftService = {
  async list(params: { since?: string; limit?: number; minDrift?: number; tenantId?: string } = {}): Promise<BillingDriftResponse> {
    const qs = new URLSearchParams();
    if (params.since) qs.set('since', params.since);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.minDrift !== undefined) qs.set('minDrift', String(params.minDrift));
    if (params.tenantId) qs.set('tenantId', params.tenantId);
    const url = `/api/admin/billing-drift${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await apiService.get<{ success: boolean; data: BillingDriftResponse }>(url);
    return res.data;
  },

  issueCredit(payload: { invoiceId: string; amount?: number; notes?: string }) {
    return apiService.post<{
      success: boolean;
      data: {
        entryId: string;
        amount: number;
        applications: Array<{ invoiceId: string; appliedAmount: number; newStatus: string }>;
      };
    }>('/api/admin/billing-drift/issue-credit', payload);
  }
};
