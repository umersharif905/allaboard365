import { apiService } from './api.service';

export interface CommissionGroup {
  CommissionGroupId: string;
  TenantId: string;
  Name: string;
  Description?: string | null;
  Status: string;
  /** When true, agents see payouts at all commission levels (theirs highlighted). */
  AgentsCanViewOtherCommissionLevels?: boolean;
  CreatedDate: string;
  ModifiedDate: string;
  RuleCount?: number;
}

export interface CommissionGroupRule {
  RuleId: string;
  RuleName: string;
  ProductId: string;
  ProductName?: string | null;
  /** oe.Products.SalesType — Individual | Group | Both */
  ProductSalesType?: string | null;
  ProductIsBundle?: boolean | number | null;
  ProductVendorId?: string | null;
  ProductVendorName?: string | null;
  /** Present on group rules list API — tier/subtitle text for AI catalog. */
  CommissionJson?: string | null;
  EntityType: string;
  TierLevel?: number | null;
  CommissionType: string;
  CommissionRate?: number | null;
  FlatAmount?: number | null;
  Priority?: number | null;
  EffectiveDate?: string | null;
  TerminationDate?: string | null;
  Locked?: boolean | number | null;
  Status?: string | null;
  AddedDate?: string | null;
}

export interface ListGroupsParams {
  page?: number;
  limit?: number;
  search?: string;
  agentId?: string;
  agencyId?: string;
}

export interface ListGroupsResult {
  groups: CommissionGroup[];
  pagination: { page: number; limit: number; total: number };
}

class CommissionGroupsService {
  async listGroups(params?: ListGroupsParams): Promise<ListGroupsResult> {
    const searchParams = new URLSearchParams();
    if (params?.page !== undefined) searchParams.append('page', String(params.page));
    if (params?.limit !== undefined) searchParams.append('limit', String(params.limit));
    if (params?.search) searchParams.append('search', params.search);
    if (params?.agentId) searchParams.append('agentId', params.agentId);
    if (params?.agencyId) searchParams.append('agencyId', params.agencyId);
    const qs = searchParams.toString();
    const data = await apiService.get<{ success: boolean; groups: CommissionGroup[]; pagination: { page: number; limit: number; total: number } }>(
      `/api/commissions/groups${qs ? `?${qs}` : ''}`
    );
    return {
      groups: data?.groups ?? [],
      pagination: data?.pagination ?? { page: 1, limit: 20, total: 0 }
    };
  }

  async createGroup(input: {
    name: string;
    description?: string | null;
    status?: string;
    agentsCanViewOtherCommissionLevels?: boolean;
  }): Promise<{ commissionGroupId: string }> {
    const data = await apiService.post<{ success: boolean; commissionGroupId: string }>('/api/commissions/groups', input);
    return { commissionGroupId: data.commissionGroupId };
  }

  async updateGroup(
    groupId: string,
    updates: {
      name?: string;
      description?: string | null;
      status?: string;
      agentsCanViewOtherCommissionLevels?: boolean;
    }
  ): Promise<void> {
    await apiService.put(`/api/commissions/groups/${groupId}`, updates);
  }

  async deleteGroup(groupId: string): Promise<void> {
    await apiService.delete(`/api/commissions/groups/${groupId}`);
  }

  async listGroupRules(groupId: string): Promise<CommissionGroupRule[]> {
    const data = await apiService.get<{ success: boolean; rules: CommissionGroupRule[] }>(`/api/commissions/groups/${groupId}/rules`);
    return data?.rules ?? [];
  }

  async addRuleToGroup(groupId: string, ruleId: string): Promise<void> {
    await apiService.post(`/api/commissions/groups/${groupId}/rules`, { ruleId });
  }

  async getAvailableRulesForGroup(groupId: string, params?: { search?: string; page?: number; limit?: number }): Promise<{ rules: CommissionGroupRule[]; pagination: { page: number; limit: number; total: number } }> {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.append('search', params.search);
    if (params?.page !== undefined) searchParams.append('page', String(params.page));
    if (params?.limit !== undefined) searchParams.append('limit', String(params.limit));
    const qs = searchParams.toString();
    const data = await apiService.get<{ success: boolean; rules: CommissionGroupRule[]; pagination: { page: number; limit: number; total: number } }>(
      `/api/commissions/groups/${groupId}/available-rules${qs ? `?${qs}` : ''}`
    );
    return {
      rules: data?.rules ?? [],
      pagination: data?.pagination ?? { page: 1, limit: 20, total: 0 }
    };
  }

  async removeRuleFromGroup(groupId: string, ruleId: string): Promise<void> {
    await apiService.delete(`/api/commissions/groups/${groupId}/rules/${ruleId}`);
  }
}

export const commissionGroupsService = new CommissionGroupsService();

