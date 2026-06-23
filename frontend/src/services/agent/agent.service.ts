// src/services/agent/agent.service.ts - FIXED TYPESCRIPT ERRORS
import type { Group } from '../../services/groups.service';
import { AgentProfile } from '../../types/agent/agent.types';
import type {
    AgentMember,
    AgentMetrics,
    ApiResponse,
    CommissionRecord,
    SalesActivity,
    TenantGroup,
} from '../../types/index';
import { apiService } from '../api.service';
import { TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS } from '../tenant-admin/agents.service';
// Removed ProductPricing import - not needed

export class AgentService {
  /**
   * Fetches the dashboard data for the authenticated agent.
   * @returns A promise that resolves to the agent's dashboard data.
   */
  static async getAgentDashboard(): Promise<ApiResponse<AgentMetrics>> {
    return apiService.get<ApiResponse<AgentMetrics>>('/api/agents/dashboard');
  }

  /**
   * Fetches the list of products for the authenticated agent.
   * @returns A promise that resolves to an array of products.
   */
  static async getAgentProducts(includeHidden = false): Promise<ApiResponse<any[]>> {
    const params = includeHidden ? '' : '?includeHidden=false';
    return apiService.get<ApiResponse<any[]>>(`/api/me/agent/products${params}`);
  }

  static async getMyAgentGroups(
    includeArchived?: boolean,
    agentId?: string,
    productId?: string,
    vendorId?: string,
    scope?: 'downline' | 'agency' | 'direct',
    search?: string,
    limit?: number,
    groupType?: 'Standard' | 'ListBill'
  ): Promise<ApiResponse<Group[]>> {
    const params = new URLSearchParams();
    if (includeArchived) params.set('includeArchived', 'true');
    if (agentId) params.set('agentId', agentId);
    if (scope === 'downline' || scope === 'agency' || scope === 'direct') {
      params.set('scope', scope);
    }
    if (productId) params.set('productId', productId);
    if (vendorId) params.set('vendorId', vendorId);
    if (search && search.trim()) params.set('search', search.trim());
    if (limit != null && !Number.isNaN(limit)) params.set('limit', String(limit));
    if (groupType === 'Standard' || groupType === 'ListBill') params.set('groupType', groupType);
    const query = params.toString() ? `?${params.toString()}` : '';
    return apiService.get<ApiResponse<Group[]>>(`/api/me/agent/groups${query}`);
  }

  static async getUpcomingActivities(): Promise<ApiResponse<SalesActivity[]>> {
    return apiService.get<ApiResponse<SalesActivity[]>>('/api/agents/activities/upcoming');
  }

  static async getAssignedMembers(filters: any): Promise<ApiResponse<AgentMember[]>> {
    return apiService.get<ApiResponse<AgentMember[]>>(`/api/agents/members?${new URLSearchParams(filters)}`);
  }

  static async getAssignedGroups(filters: any): Promise<ApiResponse<TenantGroup[]>> {
    return apiService.get<ApiResponse<TenantGroup[]>>(`/api/agents/groups?${new URLSearchParams(filters)}`);
  }

  static async getCommissions(filters: any): Promise<ApiResponse<CommissionRecord[]>> {
    return apiService.get<ApiResponse<CommissionRecord[]>>(`/api/agents/commissions?${new URLSearchParams(filters)}`);
  }

  static async getSalesActivities(filters: any): Promise<ApiResponse<SalesActivity[]>> {
    return apiService.get<ApiResponse<SalesActivity[]>>(`/api/agents/sales-activities?${new URLSearchParams(filters)}`);
  }

  static async getLeads(filters: any): Promise<ApiResponse<any[]>> {
    return apiService.get<ApiResponse<any[]>>(`/api/agents/leads?${new URLSearchParams(filters)}`);
  }

  static async createSalesActivity(activityData: any): Promise<ApiResponse<SalesActivity>> {
    return apiService.post<ApiResponse<SalesActivity>>('/api/agents/sales-activities', activityData);
  }

  static async updateSalesActivity(activityId: string, updates: any): Promise<ApiResponse<SalesActivity>> {
    return apiService.put<ApiResponse<SalesActivity>>(`/api/agents/sales-activities/${activityId}`, updates);
  }

  static async getCommissionSummary(
    periodOrOptions?:
      | string
      | {
          period?: string;
          perspective?: 'self' | 'downline';
          commissionOwnerFilter?: string;
        }
  ): Promise<ApiResponse<any>> {
    const opts =
      typeof periodOrOptions === 'string' ? { period: periodOrOptions } : periodOrOptions || {};
    const query = new URLSearchParams();
    if (opts.period) query.append('period', opts.period);
    if (opts.perspective) query.append('perspective', opts.perspective);
    if (opts.commissionOwnerFilter != null && opts.commissionOwnerFilter !== '') {
      query.append('commissionOwnerFilter', opts.commissionOwnerFilter);
    }
    const qs = query.toString();
    return apiService.get<ApiResponse<any>>(`/api/agents/commissions/summary${qs ? `?${qs}` : ''}`);
  }

  static async updateMemberStage(memberId: string, stage: string): Promise<ApiResponse<AgentMember>> {
    return apiService.put<ApiResponse<AgentMember>>(`/api/agents/members/${memberId}/stage`, { stage });
  }

  static async updateMemberNotes(memberId: string, notes: any): Promise<ApiResponse<AgentMember>> {
    return apiService.put<ApiResponse<AgentMember>>(`/api/agents/members/${memberId}/notes`, notes);
  }

  static async getSalesPipeline(): Promise<ApiResponse<any>> {
    return apiService.get<ApiResponse<any>>('/api/agents/sales-pipeline');
  }

  static async getActivityReport(period: string): Promise<ApiResponse<any>> {
    return apiService.get<ApiResponse<any>>(`/api/agents/reports/activity?period=${period}`);
  }

  static async getCommissionRules(): Promise<ApiResponse<any[]>> {
    return apiService.get<ApiResponse<any[]>>('/api/commissions/agent-rules');
  }

  static async archiveGroup(groupId: string): Promise<ApiResponse<any>> {
    return apiService.post<ApiResponse<any>>(`/api/agents/groups/${groupId}/archive`, {});
  }

  /**
   * Fetches the tenant information for the authenticated agent.
   * @returns A promise that resolves to the agent's tenant information.
   */
  static async getAgentTenant(): Promise<ApiResponse<any>> {
    return apiService.get<ApiResponse<any>>('/api/me/agent/tenant');
  }

  // =======================
  // Agent payouts & payments
  // =======================

  static async getMyPayoutExportDetails(nachaId: string): Promise<ApiResponse<any>> {
    return apiService.get<ApiResponse<any>>(`/api/me/agent/payouts/${nachaId}/export-details`);
  }

  static async getMyPayments(filters?: {
    startDate?: string;
    endDate?: string;
    groupId?: string;
    memberId?: string;
    search?: string;
    /** Selling-agent scope: empty/me = direct only; scope constants or agent UUID */
    salesAgentFilter?: string;
    /** Whose commission rows/payouts to read: 'self' (default) or 'downline' */
    perspective?: 'self' | 'downline';
    /** When perspective='downline': scope constant or agent UUID for the commission owner */
    commissionOwnerFilter?: string;
    page?: number;
    limit?: number;
  }): Promise<
    ApiResponse<any[]> & {
      pagination?: { total: number; page: number; limit: number; totalPages: number };
    }
  > {
    const query = new URLSearchParams();
    if (filters?.startDate) query.append('startDate', filters.startDate);
    if (filters?.endDate) query.append('endDate', filters.endDate);
    if (filters?.groupId) query.append('groupId', filters.groupId);
    if (filters?.memberId) query.append('memberId', filters.memberId);
    if (filters?.search) query.append('search', filters.search);
    if (filters?.salesAgentFilter != null && filters.salesAgentFilter !== '') {
      query.append('salesAgentFilter', filters.salesAgentFilter);
    }
    if (filters?.perspective) query.append('perspective', filters.perspective);
    if (filters?.commissionOwnerFilter != null && filters.commissionOwnerFilter !== '') {
      query.append('commissionOwnerFilter', filters.commissionOwnerFilter);
    }
    if (filters?.page != null && filters.page > 0) query.append('page', String(filters.page));
    if (filters?.limit != null && filters.limit > 0) query.append('limit', String(filters.limit));
    const qs = query.toString();
    return apiService.get<ApiResponse<any[]> & { pagination?: { total: number; page: number; limit: number; totalPages: number } }>(
      `/api/me/agent/payments${qs ? `?${qs}` : ''}`
    );
  }

  static async getMyPaymentsAwaitingCommissions(filters?: {
    perspective?: 'self' | 'downline';
    commissionOwnerFilter?: string;
    page?: number;
    limit?: number;
  }): Promise<
    ApiResponse<any[]> & {
      pagination?: { total: number; page: number; limit: number; totalPages: number };
    }
  > {
    const query = new URLSearchParams();
    if (filters?.perspective) query.append('perspective', filters.perspective);
    if (filters?.commissionOwnerFilter != null && filters.commissionOwnerFilter !== '') {
      query.append('commissionOwnerFilter', filters.commissionOwnerFilter);
    }
    if (filters?.page != null && filters.page > 0) query.append('page', String(filters.page));
    if (filters?.limit != null && filters.limit > 0) query.append('limit', String(filters.limit));
    const qs = query.toString();
    return apiService.get<ApiResponse<any[]> & { pagination?: { total: number; page: number; limit: number; totalPages: number } }>(
      `/api/me/agent/payments/awaiting-commissions${qs ? `?${qs}` : ''}`
    );
  }

  /** Same payload shape as GET /api/commissions/missing-preview/:paymentId/breakdown (per-product who gets paid what). */
  static async getMyPaymentCommissionBreakdown(paymentId: string): Promise<ApiResponse<Record<string, unknown>>> {
    return apiService.get<ApiResponse<Record<string, unknown>>>(
      `/api/me/agent/payments/${encodeURIComponent(paymentId)}/commission-breakdown`
    );
  }

  static async getMyPayouts(filters?: {
    salesAgentFilter?: string;
    perspective?: 'self' | 'downline';
    commissionOwnerFilter?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<
    ApiResponse<any[]> & {
      pagination?: { total: number; page: number; limit: number; totalPages: number };
    }
  > {
    const query = new URLSearchParams();
    if (filters?.salesAgentFilter != null && filters.salesAgentFilter !== '') {
      query.append('salesAgentFilter', filters.salesAgentFilter);
    }
    if (filters?.perspective) query.append('perspective', filters.perspective);
    if (filters?.commissionOwnerFilter != null && filters.commissionOwnerFilter !== '') {
      query.append('commissionOwnerFilter', filters.commissionOwnerFilter);
    }
    if (filters?.startDate) query.append('startDate', filters.startDate);
    if (filters?.endDate) query.append('endDate', filters.endDate);
    if (filters?.page != null && filters.page > 0) query.append('page', String(filters.page));
    if (filters?.limit != null && filters.limit > 0) query.append('limit', String(filters.limit));
    const qs = query.toString();
    return apiService.get<ApiResponse<any[]> & { pagination?: { total: number; page: number; limit: number; totalPages: number } }>(
      `/api/me/agent/payouts${qs ? `?${qs}` : ''}`
    );
  }

  static async getMyPayoutIncludedPayments(
    nachaId: string,
    filters?: {
      startDate?: string;
      endDate?: string;
      groupId?: string;
      memberId?: string;
      search?: string;
      salesAgentFilter?: string;
      perspective?: 'self' | 'downline';
      commissionOwnerFilter?: string;
      /** Pin included-payments to a specific payout row's owner (set when drilling into an aggregate payouts row). */
      commissionOwnerAgentId?: string;
    }
  ): Promise<ApiResponse<any[]>> {
    const query = new URLSearchParams();
    if (filters?.startDate) query.append('startDate', filters.startDate);
    if (filters?.endDate) query.append('endDate', filters.endDate);
    if (filters?.groupId) query.append('groupId', filters.groupId);
    if (filters?.memberId) query.append('memberId', filters.memberId);
    if (filters?.search) query.append('search', filters.search);
    if (filters?.salesAgentFilter != null && filters.salesAgentFilter !== '') {
      query.append('salesAgentFilter', filters.salesAgentFilter);
    }
    if (filters?.perspective) query.append('perspective', filters.perspective);
    if (filters?.commissionOwnerFilter != null && filters.commissionOwnerFilter !== '') {
      query.append('commissionOwnerFilter', filters.commissionOwnerFilter);
    }
    if (filters?.commissionOwnerAgentId) {
      query.append('commissionOwnerAgentId', filters.commissionOwnerAgentId);
    }
    const qs = query.toString();
    return apiService.get<ApiResponse<any[]>>(
      `/api/me/agent/payouts/${encodeURIComponent(nachaId)}/included-payments${qs ? `?${qs}` : ''}`
    );
  }

  static async getMyMembers(filters?: {
    groupId?: string;
    search?: string;
    limit?: string;
  }): Promise<ApiResponse<any[]>> {
    const query = new URLSearchParams();
    if (filters?.groupId) query.append('groupId', filters.groupId);
    if (filters?.search) query.append('search', filters.search);
    if (filters?.limit) query.append('limit', filters.limit);
    const qs = query.toString();
    return apiService.get<ApiResponse<any[]>>(`/api/me/agent/members${qs ? `?${qs}` : ''}`);
  }

  static async getAgentDataFromUserId(userId: string): Promise<ApiResponse<AgentProfile>> {
    return apiService.get<ApiResponse<AgentProfile>>(`/api/agents/by-user/${userId}`);
  }

  /**
   * Fetches all agents belonging to a specific tenant.
   * Uses /api/tenant-admin/agents endpoint which works for both TenantAdmin and SysAdmin roles.
   * @param tenantId The ID of the tenant.
   * @param options Optional: search, limit, includeUserId (ensures this agent is in results even if inactive - for edit-mode dropdown).
   */
  static async getAgentsByTenant(tenantId: string, options?: { search?: string; limit?: number; includeUserId?: string }): Promise<ApiResponse<any[]>> {
    try {
      const params = new URLSearchParams();
      params.set('type', 'Agent');
      params.set('status', 'Active');
      params.set('limit', String(options?.limit ?? 500)); // Higher limit for dropdowns (backend default is 50)
      if (tenantId) params.set('tenantId', tenantId); // For SysAdmin: filter by selected tenant
      if (options?.search?.trim()) params.set('search', options.search.trim());
      if (options?.includeUserId?.trim()) params.set('includeUserId', options.includeUserId.trim()); // Backend includes this agent even if inactive
      const response = await apiService.get<ApiResponse<any[]>>(`/api/tenant-admin/agents?${params.toString()}`, {
        timeout: TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS
      });
      
      // For TenantAdmin, backend already filters by their tenant. For SysAdmin with tenantId param, backend filters.
      // No client-side filtering needed when tenantId is passed to API.
      const agents = response.data || [];
      
      return {
        success: response.success,
        data: agents,
        message: response.message
      };
    } catch (error) {
      console.error(`Error fetching agents for tenant ${tenantId}:`, error);
      return { success: false, data: [], message: `Failed to fetch agents for tenant ${tenantId}` };
    }
  }

  static async getAgentDataFromAgentId(agentId: string): Promise<ApiResponse<AgentProfile>> {
    return apiService.get<ApiResponse<AgentProfile>>(`/api/agents/${agentId}`);
  }

  /**
   * Fetches the assigned agent for a specific group.
   * @param groupId The ID of the group.
   */
  static async getAgentByGroupId(groupId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.get<ApiResponse<any>>(`/api/agent/groups/${groupId}/agent`);
    } catch (error) {
      console.error(`Error fetching agent for group ${groupId}:`, error);
      return { success: false, data: null, message: `Failed to fetch agent for group ${groupId}` };
    }
  }

  /**
   * Fetches a single agent by their Agent ID.
   * @param agentId The ID of the agent to fetch.
   */
  static async getAgentById(agentId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.get<ApiResponse<any>>(`/api/agents/${agentId}`);
    } catch (error) {
      console.error(`Error fetching agent ${agentId}:`, error);
      return { success: false, data: null, message: `Failed to fetch agent ${agentId}` };
    }
  }

  /**
   * Creates a new group.
   * @param groupData - The data for the new group.
   */
  static async createGroup(groupData: Partial<Group>): Promise<ApiResponse<Group>> {
    return apiService.post<ApiResponse<Group>>('/api/me/agent/groups', groupData);
  }

  /**
   * Updates an existing group.
   * @param groupId - The ID of the group to update.
   * @param groupData - The updated data for the group.
   */
  static async updateGroup(groupId: string, groupData: Partial<Group>): Promise<ApiResponse<Group>> {
    return apiService.put<ApiResponse<Group>>(`/api/groups/${groupId}`, groupData);
  }

  /**
   * Returns this agent's "approved but conversion wizard not yet run" group
   * type-change requests. Drives the in-app banner + group-row dot that tell
   * the agent to open the wizard after their request was approved.
   */
  static async getPendingTypeChangeActions(): Promise<ApiResponse<Array<{
    RequestId: string;
    GroupId: string;
    GroupName: string;
    CurrentType: 'Standard' | 'ListBill';
    RequestedType: 'Standard' | 'ListBill';
    ReviewedAt: string | null;
    ReviewNotes: string | null;
  }>>> {
    return apiService.get('/api/me/agent/group-type-change-requests/pending-action');
  }

  /**
   * Update an agency's enabledCommissionLevelIds (Agent Tiers tab).
   * Server-side merges into oe.Agencies.Settings JSON, preserving other keys.
   * @param agencyId target agency
   * @param enabledCommissionLevelIds list of CommissionLevelIds, or null to clear (= all enabled)
   */
  /**
   * Limited-edit an agent. Backend gates fields by caller's relationship
   * (self / upline / agency admin). Sensitive fields (CommissionGroupId,
   * AgencyId, UplineAgentId) are silently dropped — TenantAdmin uses the
   * tenant-admin route, not this one.
   */
  static async updateAgent(
    agentId: string,
    payload: {
      firstName?: string;
      lastName?: string;
      email?: string;
      phoneNumber?: string | null;
      status?: string;
      commissionLevelId?: string;
    }
  ): Promise<ApiResponse<void>> {
    return apiService.put(`/api/me/agent/agents/${agentId}`, payload);
  }

  static async updateAgencyEnabledTiers(
    agencyId: string,
    enabledCommissionLevelIds: string[] | null
  ): Promise<ApiResponse<{ enabledCommissionLevelIds: string[] | null }>> {
    return apiService.put(
      `/api/me/agent/agencies/${agencyId}/settings`,
      { enabledCommissionLevelIds }
    );
  }
}

export const agentService = new AgentService();
export default AgentService;