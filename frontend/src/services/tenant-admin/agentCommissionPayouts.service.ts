import { apiService } from '../apiServices';

export interface AgentPayoutRow {
  nachaId: string;
  fileName: string | null;
  generatedDate: string;
  totalPaidToAgent: number;
  paymentCount: number;
}

export interface AgentPayoutPaymentRow {
  paymentId: string;
  paymentDate: string;
  amount: number;
  status: string;
  paymentMethod: string | null;
  sellingAgentName: string | null;
  groupId: string | null;
  groupName: string | null;
  memberId: string | null;
  memberName: string | null;
  commissionAmount: number;
  payoutLineAmount: number;
  commissionTierLevelSnapshot: number | null;
  commissionTierLevelSnapshotLabel: string | null;
}

export interface AgentPayoutsPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export async function getAgentCommissionPayouts(
  agentId: string,
  params?: { startDate?: string; endDate?: string; page?: number; limit?: number }
): Promise<{ data: AgentPayoutRow[]; pagination: AgentPayoutsPagination }> {
  const query = new URLSearchParams();
  if (params?.startDate) query.set('startDate', params.startDate);
  if (params?.endDate) query.set('endDate', params.endDate);
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));

  const qs = query.toString();
  const url = `/api/tenant-admin/agents/${encodeURIComponent(agentId)}/commission-payouts${qs ? `?${qs}` : ''}`;
  const res = await apiService.get<{ success: boolean; data: AgentPayoutRow[]; pagination: AgentPayoutsPagination }>(url);
  if (!res.success) throw new Error('Failed to fetch agent commission payouts');
  return { data: res.data ?? [], pagination: res.pagination ?? { total: 0, page: 1, limit: 25, totalPages: 0 } };
}

export async function getAgentPayoutPayments(
  agentId: string,
  nachaId: string
): Promise<AgentPayoutPaymentRow[]> {
  const url = `/api/tenant-admin/agents/${encodeURIComponent(agentId)}/commission-payouts/${encodeURIComponent(nachaId)}/payments`;
  const res = await apiService.get<{ success: boolean; data: AgentPayoutPaymentRow[] }>(url);
  if (!res.success) throw new Error('Failed to fetch payout payments');
  return res.data ?? [];
}
