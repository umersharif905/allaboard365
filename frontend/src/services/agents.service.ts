// frontend/src/services/agents.service.ts
/**
 * Unified Agents Service - Role-Aware
 * Routes to appropriate endpoint based on user's current role
 */

import { apiService, withExplicitTenantScope } from './api.service';
import TenantAdminAgentsService, {
    AgentBankInfo,
    AgentDetails,
    AgentFilters,
    AgentHierarchy,
    AgentRecord,
    ApiResponse,
    CreateAgencyRequest,
    CreateAgentRequest,
    CreateDocumentRequest,
    CreateLicenseRequest,
    SaveBankInfoRequest,
    TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS,
    UpdateAgentRequest
} from './tenant-admin/agents.service';

export class AgentsService {
  /**
   * Get base URL based on current role
   */
  private static getBaseUrl(currentRole: string): string {
    switch (currentRole) {
      case 'Agent':
        return '/api/me/agent/agents';
      case 'TenantAdmin':
      case 'SysAdmin':
        return '/api/tenant-admin/agents';
      default:
        throw new Error(`Unsupported role for agents: ${currentRole}`);
    }
  }

  /**
   * Get agents and agencies (role-aware)
   * - Agent role: Gets all agents in their agency
   * - TenantAdmin role: Gets all agencies and agents in tenant
   */
  static async getAgentsAndAgencies(currentRole: string, filters: AgentFilters = {}): Promise<ApiResponse<AgentRecord[]>> {
    if (currentRole === 'Agent') {
      // Agent endpoint returns agents in their agency + agency info
      const response = await apiService.get<{ 
        success: boolean; 
        data: any[]; 
        agency?: any;
        agencies?: any[];
        isOwnerView?: boolean;
        isDownlineView?: boolean;
        currentAgentId?: string;
        message?: string;
      }>('/api/me/agent/agents');
      
      if (response.success && response.data) {
        // If owner view, data already includes agencies and agents with Type field
        if (response.isOwnerView) {
          const transformed = response.data.map((item: any) => {
            if (item.Type === 'Agency') {
              return {
                Id: item.AgencyId,
                Type: 'Agency' as const,
                Name: item.FirstName || item.BusinessName, // AgencyName stored in FirstName
                Email: item.Email || '',
                Phone: item.PhoneNumber || '',
                Status: item.Status,
                TenantId: '',
                CreatedDate: item.CreatedDate,
                ModifiedDate: item.CreatedDate,
                IsPrimary: item.IsPrimary,
                CommissionTierLevel: item.CommissionTierLevel,
                CommissionLevelName: item.CommissionLevelName ?? null,
                CommissionGroupId: item.CommissionGroupId ?? null,
                CommissionGroupName: item.CommissionGroupName ?? null,
                AgencyAdminAgentIds: Array.isArray(item.AgencyAdminAgentIds) ? item.AgencyAdminAgentIds : [],
                OwnerAgentId: item.OwnerAgentId ?? (Array.isArray(item.AgencyAdminAgentIds) ? item.AgencyAdminAgentIds[0] ?? null : null),
                TotalMrr: item.TotalMrr != null ? Number(item.TotalMrr) : undefined
              } as AgentRecord;
            } else {
              return {
                Id: item.AgentId,
                Type: 'Agent' as const,
                Name: `${item.FirstName} ${item.LastName}`,
                Email: item.Email,
                Phone: item.PhoneNumber,
                NPN: item.NPN,
                Status: item.Status,
                Role: item.CommissionRole,
                AgencyId: item.AgencyId,
                TenantId: '',
                CreatedDate: item.CreatedDate,
                ModifiedDate: item.CreatedDate,
                TotalMembers: item.TotalMembers,
                TotalGroups: item.TotalGroups,
                ActiveEnrollments: item.ActiveEnrollments
              } as AgentRecord;
            }
          });
          
          return {
            success: true,
            data: transformed,
            isOwnerView: true, // Pass through the owner view flag
            currentAgentId: response.currentAgentId
          } as ApiResponse<AgentRecord[]> & { isOwnerView?: boolean; currentAgentId?: string };
        }
        
        // All agents in agency (or downline) - transform to match expected format
        const toId = (v: unknown) => (v != null ? String(v).toLowerCase().replace(/[{}]/g, '').trim() : '');
        const toNullableId = (v: unknown) => {
          const s = toId(v);
          return s.length > 0 ? s : null;
        };
        const agents = response.data.map((agent: any) => ({
          Id: toId(agent.AgentId),
          Type: 'Agent' as const,
          Name: `${agent.FirstName} ${agent.LastName}`,
          Email: agent.Email,
          Phone: agent.PhoneNumber,
          NPN: agent.NPN,
          Status: agent.Status,
          Role: agent.CommissionRole,
          AgencyId: toId(agent.AgencyId),
          TenantId: agent.TenantId || '',
          CreatedDate: agent.CreatedDate,
          ModifiedDate: agent.CreatedDate,
          CommissionTierLevel:
            agent.CommissionTierLevel != null && Number.isFinite(Number(agent.CommissionTierLevel))
              ? Number(agent.CommissionTierLevel)
              : undefined,
          CommissionGroupId: agent.CommissionGroupId ?? null,
          CommissionGroupName: agent.CommissionGroupName ?? null,
          // ParentId comes from oe.AgentHierarchy.ParentId on the backend. Keep
          // it so AgentsPage can build a nested tree client-side when the
          // dedicated /hierarchy endpoint doesn't return a usable tree.
          ParentAgentId: toNullableId(agent.ParentId),
          TotalMembers: agent.TotalMembers,
          TotalGroups: agent.TotalGroups,
          ActiveEnrollments: agent.ActiveEnrollments,
          AgentCode: agent.AgentCode ?? null
        }));

        // Add agency as first item if available
        if (response.agency) {
          const agencyRecord: AgentRecord = {
            Id: toId(response.agency.AgencyId),
            Type: 'Agency' as const,
            Name: response.agency.AgencyName,
            Email: '',
            Status: response.agency.Status,
            TenantId: '',
            CreatedDate: response.agency.CreatedDate,
            ModifiedDate: response.agency.CreatedDate,
            IsPrimary: response.agency.IsPrimary ?? undefined,
            CommissionTierLevel: response.agency.CommissionTierLevel ?? undefined,
            CommissionLevelName: response.agency.CommissionLevelName ?? null,
            CommissionGroupId: response.agency.CommissionGroupId ?? null,
            CommissionGroupName: response.agency.CommissionGroupName ?? null,
            AgencyAdminAgentIds: Array.isArray(response.agency.AgencyAdminAgentIds) ? response.agency.AgencyAdminAgentIds : [],
            OwnerAgentId: response.agency.OwnerAgentId ?? (Array.isArray(response.agency.AgencyAdminAgentIds) ? response.agency.AgencyAdminAgentIds[0] ?? null : null)
          };
          return {
            success: true,
            data: [agencyRecord, ...agents],
            currentAgentId: response.currentAgentId
          } as ApiResponse<AgentRecord[]> & { currentAgentId?: string };
        }

        return {
          success: true,
          data: agents,
          currentAgentId: response.currentAgentId
        } as ApiResponse<AgentRecord[]> & { currentAgentId?: string };
      }
      
      return {
        success: false,
        data: [],
        message: response.message || 'Failed to fetch agents'
      };
    } else {
      // TenantAdmin uses existing service
      return TenantAdminAgentsService.getAgentsAndAgencies(filters);
    }
  }

  /**
   * Get agent stats (role-aware)
   */
  static async getAgentStats(currentRole: string): Promise<ApiResponse<any>> {
    if (currentRole === 'Agent') {
      return apiService.get('/api/me/agent/agents/stats');
    } else {
      // TenantAdmin can use the same endpoint or a different one
      return apiService.get('/api/tenant-admin/agents/stats');
    }
  }

  /**
   * Get agent hierarchy (role-aware)
   */
  static async getHierarchy(currentRole: string): Promise<ApiResponse<any>> {
    if (currentRole === 'Agent') {
      return apiService.get('/api/me/agent/agents/hierarchy');
    } else {
      return apiService.get('/api/tenant-admin/agents/hierarchy', {
        timeout: TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS
      });
    }
  }

  /** Full hierarchy with explicit tenant scope (SysAdmin admin/agents page). */
  static async getTenantAdminHierarchy(
    tenantId: string,
    search?: string,
    limit?: number,
    options?: { includeInactive?: boolean }
  ): Promise<ApiResponse<any>> {
    const params = new URLSearchParams();
    if (tenantId) params.set('tenantId', tenantId);
    if (search?.trim()) params.set('search', search.trim());
    if (limit != null && limit > 0) params.set('limit', String(limit));
    if (options?.includeInactive) params.set('includeInactive', 'true');
    const qs = params.toString();
    return apiService.get(
      `/api/tenant-admin/agents/hierarchy${qs ? `?${qs}` : ''}`,
      {
        timeout: TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS,
        ...withExplicitTenantScope(tenantId)
      }
    );
  }

  /** Agency shells + batched counts/MRR (no agent rows). TenantAdmin, SysAdmin, or Agent (administered agencies only). */
  static async getHierarchyMeta(
    currentRole: string,
    tenantId?: string,
    options?: { includeInactive?: boolean }
  ): Promise<ApiResponse<any>> {
    if (
      currentRole !== 'TenantAdmin' &&
      currentRole !== 'SysAdmin' &&
      currentRole !== 'Agent'
    ) {
      return {
        success: false,
        data: null as unknown as any,
        message: 'Unsupported role for hierarchy meta'
      };
    }
    const params = new URLSearchParams();
    if (tenantId) params.set('tenantId', tenantId);
    if (options?.includeInactive) params.set('includeInactive', 'true');
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiService.get(`/api/tenant-admin/agents/hierarchy/meta${qs}`, {
      timeout: TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS,
      ...withExplicitTenantScope(tenantId)
    });
  }

  /** Nested agents for one agency subtree (lazy load). */
  static async getHierarchyAgencySubtree(
    currentRole: string,
    agencyId: string,
    tenantId?: string
  ): Promise<ApiResponse<any>> {
    if (
      currentRole !== 'TenantAdmin' &&
      currentRole !== 'SysAdmin' &&
      currentRole !== 'Agent'
    ) {
      return {
        success: false,
        data: null as unknown as any,
        message: 'Unsupported role for hierarchy subtree'
      };
    }
    const enc = encodeURIComponent(String(agencyId).trim());
    const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    return apiService.get(`/api/tenant-admin/agents/hierarchy/agency/${enc}${qs}`, {
      timeout: TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS,
      ...withExplicitTenantScope(tenantId)
    });
  }

  /**
   * Get agent details (role-aware)
   */
  static async getAgentDetails(id: string, currentRole: string): Promise<ApiResponse<AgentDetails>> {
    if (currentRole === 'Agent') {
      return apiService.get(`/api/me/agent/agents/${id}`);
    } else {
      return TenantAdminAgentsService.getAgentDetails(id);
    }
  }

  // TenantAdmin-only methods (delegated to TenantAdminAgentsService)
  static async createAgent(agentData: CreateAgentRequest): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.createAgent(agentData);
  }

  static async createAgency(agencyData: CreateAgencyRequest): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.createAgency(agencyData);
  }

  static async updateAgent(id: string, agentData: UpdateAgentRequest): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.updateAgent(id, agentData);
  }

  static async updateAgency(agencyId: string, data: CreateAgencyRequest): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.updateAgency(agencyId, data);
  }

  static async getAgentsByAgency(
    agencyId: string,
    search?: string,
    limit?: number
  ): Promise<ApiResponse<AgentRecord[]>> {
    return TenantAdminAgentsService.getAgentsByAgency(agencyId, search, limit);
  }

  static async getAvailableAgencies(): Promise<ApiResponse<any[]>> {
    return TenantAdminAgentsService.getAvailableAgencies();
  }

  static async getAgencyDetails(agencyId: string): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.getAgencyDetails(agencyId);
  }

  static async addLicense(agentId: string, licenseData: CreateLicenseRequest): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.addLicense(agentId, licenseData);
  }

  static async removeLicense(agentId: string, licenseId: string): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.removeLicense(agentId, licenseId);
  }

  static async saveBankInfo(agentId: string, bankData: SaveBankInfoRequest): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.saveBankInfo(agentId, bankData);
  }

  static async getBankInfo(agentId: string): Promise<ApiResponse<AgentBankInfo | null>> {
    return TenantAdminAgentsService.getBankInfo(agentId);
  }

  static async getAgentDownline(agentId: string): Promise<ApiResponse<AgentHierarchy[]>> {
    return TenantAdminAgentsService.getAgentDownline(agentId);
  }

  static async getAgentUpline(agentId: string): Promise<ApiResponse<AgentHierarchy[]>> {
    return TenantAdminAgentsService.getAgentUpline(agentId);
  }

  static async updateAgentUpline(agentId: string, newUplineId: string): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.updateAgentUpline(agentId, newUplineId);
  }

  static async uploadDocument(agentId: string, documentData: CreateDocumentRequest): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.uploadDocument(agentId, documentData);
  }

  static async getCommissionRule(agentId: string): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.getCommissionRule(agentId);
  }

  static async updateCommissionRule(agentId: string, commissionRuleId: string): Promise<ApiResponse<any>> {
    return TenantAdminAgentsService.updateCommissionRule(agentId, commissionRuleId);
  }

  // Helper methods
  static getStateOptions() {
    return TenantAdminAgentsService.getStateOptions();
  }

  static getAgencyTypeOptions() {
    return TenantAdminAgentsService.getAgencyTypeOptions();
  }

  static getDistributionChannelOptions() {
    return TenantAdminAgentsService.getDistributionChannelOptions();
  }
}

// Re-export types
export type {
    AgentBankInfo, AgentDetails,
    AgentFilters, AgentHierarchy, AgentRecord, ApiResponse, CreateAgencyRequest, CreateAgentRequest, CreateDocumentRequest, CreateLicenseRequest,
    SaveBankInfoRequest, UpdateAgentRequest
};

export default AgentsService;

