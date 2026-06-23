import { apiService } from '../api.service';

export interface CommissionBreakdownRow {
  entityType: 'Agent' | 'Agency';
  entityId: string;
  entityName: string;
  agencyId?: string | null;
  expectedAmount: number;
  paidInRangeAmount: number;
  paidOutAmount: number;
  pendingPayoutAmount: number;
  /** Sum of pending negative oe.Commissions rows (Refund/Chargeback). Will be netted against this recipient's next NACHA payout. Always >= 0. */
  pendingClawbackAmount?: number;
  pendingClawbackCount?: number;
  /** Pending payout after applying pending clawback (max(0, pendingPayoutAmount - pendingClawbackAmount)). */
  netNextPayoutAmount?: number;
}

export interface CommissionBreakdownItem {
  productId: string;
  productName: string;
  tiers: {
    productPricingId: string;
    pricingTier: string;
    enrollmentCount: number;
    commissionAmount: number;
    totalCommission: number;
  }[];
  totalCommission: number;
}

export interface CommissionBreakdownPaymentRow {
  paymentId: string;
  paymentDate: string;
  paymentAmount: number;
  commissionAmount: number;
  agentName: string;
  clientName: string;
}

export interface FilterOption {
  id: string;
  label: string;
  type: 'all' | 'group' | 'member';
  value: string;
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

export async function getCommissionBreakdownHoldSettings(): Promise<{ success: boolean; data: CommissionHoldSettings }> {
  return apiService.get<{ success: boolean; data: CommissionHoldSettings }>(
    '/api/accounting/commission-breakdown/hold-settings'
  );
}

export async function getCommissionBreakdown(params: {
  startDate: string;
  endDate: string;
  groupId?: string;
  individuals?: string;
  agentSearch?: string;
  agencyId?: string;
}): Promise<{ success: boolean; data: CommissionBreakdownRow[] }> {
  const query = new URLSearchParams();
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.individuals) query.append('individuals', params.individuals);
  if (params.agentSearch) query.append('agentSearch', params.agentSearch);
  if (params.agencyId && params.agencyId !== 'all') query.append('agencyId', params.agencyId);

  return apiService.get<{ success: boolean; data: CommissionBreakdownRow[] }>(
    `/api/accounting/commission-breakdown?${query.toString()}`
  );
}

export async function getCommissionBreakdownFilterOptions(params: {
  startDate: string;
  endDate: string;
  entityId?: string;
  entityType?: string;
}): Promise<{ success: boolean; data: FilterOption[] }> {
  const query = new URLSearchParams();
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.entityId) query.append('entityId', params.entityId);
  if (params.entityType) query.append('entityType', params.entityType);

  return apiService.get<{ success: boolean; data: FilterOption[] }>(
    `/api/accounting/commission-breakdown/filter-options?${query.toString()}`
  );
}

export async function getCommissionBreakdownDetails(params: {
  entityType: string;
  entityId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
  individuals?: string;
}): Promise<{ success: boolean; data: CommissionBreakdownItem[] }> {
  const query = new URLSearchParams();
  query.append('entityType', params.entityType);
  query.append('entityId', params.entityId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.householdId) query.append('householdId', params.householdId);
  if (params.individuals) query.append('individuals', params.individuals);

  return apiService.get<{ success: boolean; data: CommissionBreakdownItem[] }>(
    `/api/accounting/commission-breakdown/breakdown?${query.toString()}`
  );
}

export async function getCommissionBreakdownPayments(params: {
  entityType: string;
  entityId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
  individuals?: string;
}): Promise<{ success: boolean; data: CommissionBreakdownPaymentRow[] }> {
  const query = new URLSearchParams();
  query.append('entityType', params.entityType);
  query.append('entityId', params.entityId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId) query.append('groupId', params.groupId);
  if (params.householdId) query.append('householdId', params.householdId);
  if (params.individuals) query.append('individuals', params.individuals);

  return apiService.get<{ success: boolean; data: CommissionBreakdownPaymentRow[] }>(
    `/api/accounting/commission-breakdown/payments?${query.toString()}`
  );
}

/** Export details for XLSX (same shape as NACHA statement: summary, payments, groups, individuals, products). */
export async function getCommissionBreakdownExportDetails(params: {
  entityType: string;
  entityId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  householdId?: string;
  individuals?: string;
}): Promise<{
  success: boolean;
  summary: { totalRevenue: number; totalCommission: number; paymentCount: number };
  payments: any[];
  groups: any[];
  individuals: any[];
  products: any[];
}> {
  const query = new URLSearchParams();
  query.append('entityType', params.entityType);
  query.append('entityId', params.entityId);
  query.append('startDate', params.startDate);
  query.append('endDate', params.endDate);
  if (params.groupId && params.groupId !== 'all') query.append('groupId', params.groupId);
  if (params.householdId && params.householdId !== 'all') query.append('householdId', params.householdId);
  if (params.individuals) query.append('individuals', params.individuals);

  return apiService.get<any>(`/api/accounting/commission-breakdown/export-details?${query.toString()}`);
}
