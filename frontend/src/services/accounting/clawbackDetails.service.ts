import { apiService } from '../api.service';

export interface CommissionClawbackDetailRow {
  commissionId: string | null;
  paymentId: string | null;
  originalCommissionId: string | null;
  amount: number;
  transactionType: 'Refund' | 'Chargeback' | string | null;
  createdDate: string | null;
  householdId: string | null;
  householdName: string | null;
  primaryMemberId: string | null;
  groupId: string | null;
  groupName: string | null;
  paymentAmount: number | null;
  paymentDate: string | null;
  refundId: string | null;
  refundAmount: number | null;
  refundDate: string | null;
  refundReason: string | null;
  refundNotes: string | null;
  refundStatus: string | null;
  originalCommissionAmount: number | null;
}

export interface PayoutClawbackDetailRow {
  clawbackId: string | null;
  paymentId: string | null;
  refundId: string | null;
  amount: number;
  remainingAmount: number;
  status: string | null;
  clawbackNotes: string | null;
  createdDate: string | null;
  refundAmount: number | null;
  refundDate: string | null;
  refundReason: string | null;
  refundNotes: string | null;
  refundStatus: string | null;
  householdId: string | null;
  householdName: string | null;
  primaryMemberId: string | null;
  groupId: string | null;
  groupName: string | null;
  paymentAmount: number | null;
  paymentDate: string | null;
}

export interface ClawbackDetailsResponse<T> {
  success: boolean;
  data: {
    totalPending: number;
    count: number;
    items: T[];
  };
}

export async function getCommissionClawbackDetails(params: {
  entityType: 'Agent' | 'Agency';
  entityId: string;
}): Promise<ClawbackDetailsResponse<CommissionClawbackDetailRow>> {
  const q = new URLSearchParams();
  q.append('entityType', params.entityType);
  q.append('entityId', params.entityId);
  return apiService.get<ClawbackDetailsResponse<CommissionClawbackDetailRow>>(
    `/api/accounting/clawback-balances/commissions?${q.toString()}`
  );
}

export async function getPayoutClawbackDetails(params: {
  payoutType: 'Vendor' | 'TenantOverride';
  recipientEntityId: string;
}): Promise<ClawbackDetailsResponse<PayoutClawbackDetailRow>> {
  const q = new URLSearchParams();
  q.append('payoutType', params.payoutType);
  q.append('recipientEntityId', params.recipientEntityId);
  return apiService.get<ClawbackDetailsResponse<PayoutClawbackDetailRow>>(
    `/api/accounting/clawback-balances/payouts?${q.toString()}`
  );
}
