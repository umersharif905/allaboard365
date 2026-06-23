// frontend/src/services/enrollment-link-templates.service.ts
import { ApiResponse } from '../types/api.types';
import { AgentsService } from './agents.service';
import { apiService } from './api.service';
import type { AgentRecord } from './tenant-admin/agents.service';

// Types
export interface EnrollmentLinkTemplate {
  TemplateId: string;
  TemplateName: string;
  TemplateType: 'Individual' | 'Group';
  AgentId?: string;
  AgencyId?: string; // Added for agency support
  GroupId?: string; // For Group templates
  GroupName?: string; // Display name of the group (for Group templates)
  TenantId: string;
  LinkMetaData: string; // JSON string
  IsActive: boolean;
  Description?: string;
  CreatedDate: string;
  ModifiedDate: string;
  CreatedBy: string;
  ModifiedBy: string;
  ActiveLinksCount: number;
  HasStaticLink?: boolean | number; // Whether this template has a static link (1 or 0 from SQL)
  HasMarketingLink?: boolean | number; // Whether this template has a marketing link (1 or 0 from SQL)
  CreatedByName: string;
  ModifiedByName: string;
  TenantName: string;
  AgentName?: string; // Can be either agent name or agency name
}

export interface ParsedLinkMetaData {
  household: {
    collectSSN: boolean;
    collectDOB: boolean;
    collectGender: boolean;
    collectAddress: boolean;
    collectPhone: boolean;
  };
  products: Array<{
    page: string;
    header: string;
    productType: string;
    description: string;
    options?: any[];
  }>;
}

export interface EnrollmentLinkTemplateFilters {
  page?: number;
  limit?: number;
  searchTerm?: string;
  templateType?: 'Individual' | 'Group' | '';
  isActive?: boolean | '';
  tenantName?: string;
  groupId?: string; // Backend will look up AgentId from oe.Groups.AgentId
  agentId?: string; // Direct agent filter for individual members
  viewDownline?: boolean; // AgencyOwner: when true, list templates for self + all downline agents
  /** When true, only return templates that have a marketing link (for Marketing page). */
  hasMarketingLink?: boolean;
  /** When true, exclude templates that have a marketing link (for Enrollment Links page). */
  excludeHasMarketingLink?: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalCount: number;
    limit: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export interface CreateTemplateRequest {
  templateName: string;
  templateType: 'Individual' | 'Group';
  tenantId?: string; // Required for SysAdmin, auto-filled for others
  agentId?: string; // Optional for all roles
  groupId?: string; // Required for Group templates
  linkMetaData: string | object;
  description?: string;
}

export interface UpdateTemplateRequest {
  templateName?: string;
  templateType?: 'Individual' | 'Group';
  agentId?: string;
  groupId?: string; // For Group templates
  linkMetaData?: string | object;
  description?: string;
  isActive?: boolean;
  tenantId?: string; // For SysAdmin
}

export interface TenantOption {
  TenantId: string;
  TenantName: string;
  IsActive: boolean;
}

export interface AgentOption {
  AgentId: string;
  TenantId: string;
  AgentName: string;
  Email: string;
  AgentCode?: string;
  TenantName: string;
  AgencyName?: string;
  AgencyId?: string;
  Type: 'Agent' | 'Agency';
  /** For agencies only: assigned agent ID; null/undefined means agency has no agent (invalid for marketing/static links) */
  OwnerAgentId?: string | null;
  AgencyAdminAgentIds?: string[];
}

export class EnrollmentLinkTemplatesService {
  /**
   * Normalize template display name for consistent UI across tenants.
   * Strips redundant " : Individual" and " : Group" suffixes (type is already shown in TYPE column).
   */
  static getDisplayTemplateName(name: string | undefined): string {
    if (!name) return '';
    const stripped = name
      .replace(/\s*:\s*Individual\s*$/i, '')
      .replace(/\s*:\s*Group\s*$/i, '')
      .trim();
    return stripped || name;
  }

  /**
   * Get the appropriate API endpoint based on user role
   */
  private static getBaseUrl(currentRole: string): string {
    switch (currentRole) {
      case 'Agent':
      case 'AgencyOwner':
        return '/api/me/agent/enrollment-link-templates';
      case 'TenantAdmin':
        return '/api/me/tenant-admin/enrollment-link-templates';
      case 'GroupAdmin':
        return '/api/me/group-admin/enrollment-link-templates';
      case 'SysAdmin':
        return '/api/me/sysadmin/enrollment-link-templates';
      default:
        throw new Error(`Unsupported role: ${currentRole}`);
    }
  }

  /**
   * Get enrollment link templates with pagination and filtering
   * Calls the appropriate role-specific backend endpoint
   */
  static async getTemplates(filters?: EnrollmentLinkTemplateFilters, currentRole?: string): Promise<ApiResponse<PaginatedResponse<EnrollmentLinkTemplate>>> {
    try {
      if (!currentRole) {
        throw new Error('Current role is required');
      }

      const baseUrl = this.getBaseUrl(currentRole);
      const queryParams = new URLSearchParams();
      
      if (filters?.page) queryParams.append('page', filters.page.toString());
      if (filters?.limit) queryParams.append('limit', filters.limit.toString());
      if (filters?.searchTerm) queryParams.append('search', filters.searchTerm);
      if (filters?.templateType) queryParams.append('templateType', filters.templateType);
      if (filters?.isActive !== undefined && filters?.isActive !== '') {
        queryParams.append('isActive', filters.isActive.toString());
      }
      // Only SysAdmin can filter by tenant
      if (currentRole === 'SysAdmin' && filters?.tenantName) {
        queryParams.append('tenantId', filters.tenantName);
      }
      // Pass groupId - backend will look up AgentId from oe.Groups
      if (filters?.groupId) {
        queryParams.append('groupId', filters.groupId);
      }
      // Pass agentId directly for individual members
      if (filters?.agentId) {
        queryParams.append('agentId', filters.agentId);
      }
      // AgencyOwner: view all downline templates (agent portal only)
      if (filters?.viewDownline) {
        queryParams.append('viewDownline', '1');
      }
      if (filters?.hasMarketingLink === true) {
        queryParams.append('hasMarketingLink', '1');
      }
      if (filters?.excludeHasMarketingLink === true) {
        queryParams.append('excludeHasMarketingLink', '1');
      }
      
      const queryString = queryParams.toString();
      const url = `${baseUrl}${queryString ? `?${queryString}` : ''}`;
      
      return await apiService.get<ApiResponse<PaginatedResponse<EnrollmentLinkTemplate>>>(url);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch enrollment link templates',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'ENROLLMENT_TEMPLATES_ERROR'
        }
      };
    }
  }

  /**
   * Get a specific enrollment link template by ID
   * Uses role-specific endpoint for security
   */
  static async getTemplate(templateId: string, currentRole?: string): Promise<ApiResponse<EnrollmentLinkTemplate>> {
    try {
      if (!currentRole) {
        throw new Error('Current role is required');
      }

      const baseUrl = this.getBaseUrl(currentRole);
      return await apiService.get<ApiResponse<EnrollmentLinkTemplate>>(`${baseUrl}/${templateId}`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch enrollment link template',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'ENROLLMENT_TEMPLATE_ERROR'
        }
      };
    }
  }

  /**
   * Create a new enrollment link template
   */
  static async createTemplate(templateData: CreateTemplateRequest, currentRole?: string): Promise<ApiResponse<{ templateId: string }>> {
    try {
      if (!currentRole) {
        throw new Error('Current role is required');
      }

      const baseUrl = this.getBaseUrl(currentRole);
      // Don't send currentRole in payload - backend knows from the endpoint
      return await apiService.post<ApiResponse<{ templateId: string }>>(baseUrl, templateData);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create enrollment link template',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'CREATE_ENROLLMENT_TEMPLATE_ERROR'
        }
      };
    }
  }

  /**
   * Update an enrollment link template
   */
  static async updateTemplate(templateId: string, templateData: UpdateTemplateRequest, currentRole?: string): Promise<ApiResponse<any>> {
    try {
      if (!currentRole) {
        throw new Error('Current role is required');
      }

      const baseUrl = this.getBaseUrl(currentRole);
      // Don't send currentRole in payload - backend knows from the endpoint
      return await apiService.put<ApiResponse<any>>(`${baseUrl}/${templateId}`, templateData);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update enrollment link template',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPDATE_ENROLLMENT_TEMPLATE_ERROR'
        }
      };
    }
  }

  /**
   * Delete an enrollment link template
   */
  static async deleteTemplate(templateId: string, currentRole?: string): Promise<ApiResponse<any>> {
    try {
      if (!currentRole) {
        throw new Error('Current role is required');
      }

      const baseUrl = this.getBaseUrl(currentRole);
      const response = await apiService.delete<ApiResponse<any>>(`${baseUrl}/${templateId}`);
      
      // Return the response as-is, preserving the message and deletedLinksCount from backend
      return response;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to delete enrollment link template',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DELETE_ENROLLMENT_TEMPLATE_ERROR'
        }
      };
    }
  }

  /**
   * Sync all enrollment link templates for a group to use the given product set.
   * Updates LinkMetaData.products for every template with the group's GroupId.
   */
  static async syncGroupProducts(groupId: string, productIds: string[], currentRole?: string): Promise<ApiResponse<{ updatedCount: number }>> {
    try {
      if (!currentRole) {
        throw new Error('Current role is required');
      }
      const baseUrl = this.getBaseUrl(currentRole);
      return await apiService.post<ApiResponse<{ updatedCount: number }>>(`${baseUrl}/sync-group-products`, { groupId, productIds });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to sync enrollment link templates',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'SYNC_GROUP_PRODUCTS_ERROR'
        }
      };
    }
  }

  /**
   * Duplicate an enrollment link template
   */
  static async duplicateTemplate(templateId: string, currentRole?: string): Promise<ApiResponse<{ templateId: string; templateName: string }>> {
    try {
      if (!currentRole) {
        throw new Error('Current role is required');
      }

      const baseUrl = this.getBaseUrl(currentRole);
      return await apiService.post<ApiResponse<{ templateId: string; templateName: string }>>(`${baseUrl}/${templateId}/duplicate`, {});
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to duplicate enrollment link template',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DUPLICATE_ENROLLMENT_TEMPLATE_ERROR'
        }
      };
    }
  }

  /**
   * Copy a member-specific link as a static link
   */
  static async copyLinkAsStatic(linkId: string): Promise<ApiResponse<{ linkId: string; linkToken: string; shortCode: string; enrollmentUrl: string; templateName: string }>> {
    try {
      return await apiService.post<ApiResponse<{ linkId: string; linkToken: string; shortCode: string; enrollmentUrl: string; templateName: string }>>(`/api/me/enrollment-links/${linkId}/copy-as-static`, {});
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to copy link as static',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'COPY_AS_STATIC_ERROR'
        }
      };
    }
  }

  /**
   * Get tenants for SysAdmin dropdown (SysAdmin only)
   */
  static async getTenants(): Promise<ApiResponse<TenantOption[]>> {
    try {
      const baseUrl = this.getBaseUrl('SysAdmin');
      return await apiService.get<ApiResponse<TenantOption[]>>(`${baseUrl}/dropdown-data/tenants`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch tenants',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'TENANTS_DROPDOWN_ERROR'
        }
      };
    }
  }

  /**
   * Get agents for dropdown - Uses unified tenant-admin agents endpoint (Optional selection)
   * Following backend-system.md: reuse existing endpoints instead of creating specialized ones
   */
  static async getAgents(_tenantId?: string, currentRole?: string, search?: string): Promise<ApiResponse<AgentOption[]>> {
    try {
      if (!currentRole) {
        throw new Error('Current role is required');
      }

      // Agents must use /api/me/agent/agents (via AgentsService), not /api/tenant-admin/agents (TenantAdmin-only).
      if (currentRole === 'Agent') {
        const agentResponse = await AgentsService.getAgentsAndAgencies('Agent', {});
        if (!agentResponse.success || !agentResponse.data) {
          return {
            success: false,
            message: agentResponse.message || 'Failed to fetch agents',
            data: [],
            error: {
              message: agentResponse.message || 'Failed to fetch agents',
              code: 'AGENTS_DROPDOWN_ERROR'
            }
          };
        }
        let records: AgentRecord[] = agentResponse.data;
        if (search && search.trim()) {
          const q = search.trim().toLowerCase();
          records = records.filter(
            (r) =>
              (r.Name && r.Name.toLowerCase().includes(q)) ||
              (r.Email && r.Email.toLowerCase().includes(q)) ||
              (r.NPN != null && String(r.NPN).toLowerCase().includes(q))
          );
        }
        const mapRecord = (agent: AgentRecord): AgentOption => ({
          AgentId: agent.Id,
          TenantId: agent.TenantId || '',
          AgentName: agent.Name,
          Email: agent.Email || '',
          AgentCode: (agent.NPN ?? '') || '',
          TenantName: '',
          AgencyName: agent.AgencyName ?? undefined,
          AgencyId: agent.AgencyId || undefined,
          Type: agent.Type === 'Agency' ? 'Agency' : 'Agent',
          AgencyAdminAgentIds: agent.AgencyAdminAgentIds ?? [],
          OwnerAgentId:
            agent.OwnerAgentId ??
            (Array.isArray(agent.AgencyAdminAgentIds) ? agent.AgencyAdminAgentIds[0] ?? null : null)
        });
        return {
          success: true,
          data: records.map(mapRecord)
        };
      }

      let url = '';
      const params = new URLSearchParams();
      params.append('status', 'Active'); // Only active agents for dropdowns
      if (search) params.append('search', search);
      
      switch (currentRole) {
        case 'TenantAdmin':
          // Use the existing unified tenant-admin agents endpoint
          // Don't filter by type - get both agents and agencies
          url = `/api/tenant-admin/agents?${params.toString()}`;
          break;
        case 'SysAdmin':
          // SysAdmin can get all agents/agencies without tenant filter
          // Use tenant-admin endpoint which allows SysAdmin to see all
          url = `/api/tenant-admin/agents?${params.toString()}`;
          break;
        default:
          throw new Error(`Unsupported role: ${currentRole}`);
      }

      console.log(`[EnrollmentLinkTemplatesService] Fetching agents from: ${url}`);
      const response = await apiService.get<any>(url);
      console.log(`[EnrollmentLinkTemplatesService] Agents response:`, response);
      
      // Transform the response to match AgentOption interface
      if (response.success && response.data) {
        // Handle both paginated and non-paginated responses
        const agents = Array.isArray(response.data) ? response.data : response.data.data || [];
        
        // Transform to AgentOption interface format based on the current role
        let transformedAgents: AgentOption[] = [];
        
        const mapAgent = (agent: any) => ({
          AgentId: agent.Id,
          TenantId: agent.TenantId,
          AgentName: agent.Name ?? agent.AgentName,
          Email: agent.Email,
          AgentCode: (agent.NPN ?? agent.AgentCode) || '',
          TenantName: agent.TenantName || '',
          AgencyName: agent.AgencyName || null,
          AgencyId: agent.AgencyId || null,
          Type: agent.Type || 'Agent',
          AgencyAdminAgentIds: agent.AgencyAdminAgentIds ?? [],
          OwnerAgentId: agent.OwnerAgentId ?? (Array.isArray(agent.AgencyAdminAgentIds) ? agent.AgencyAdminAgentIds[0] ?? null : null)
        });
        if (currentRole === 'SysAdmin') {
          transformedAgents = agents.map(mapAgent);
        } else if (currentRole === 'TenantAdmin') {
          console.log(`[EnrollmentLinkTemplatesService] Raw ${currentRole} agents data:`, agents);
          console.log(`[EnrollmentLinkTemplatesService] Sample agent:`, agents[0]);
          transformedAgents = agents.map(mapAgent);
        }

        console.log(`[EnrollmentLinkTemplatesService] Transformed agents:`, transformedAgents);
        return {
          success: true,
          data: transformedAgents
        };
      }

      return response;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch agents',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'AGENTS_DROPDOWN_ERROR'
        }
      };
    }
  }

  /**
   * Parse LinkMetaData JSON string to typed object
   */
  static parseLinkMetaData(linkMetaData: string): ParsedLinkMetaData | null {
    try {
      return JSON.parse(linkMetaData);
    } catch (error) {
      console.error('Error parsing LinkMetaData:', error);
      return null;
    }
  }

  /**
   * Format template type for display
   */
  static formatTemplateType(templateType: string): string {
    switch (templateType) {
      case 'Individual':
        return 'Individual';
      case 'Group':
        return 'Group';
      default:
        return templateType;
    }
  }

  /**
   * Get template status based on IsActive flag
   */
  static getTemplateStatus(template: EnrollmentLinkTemplate): {
    status: 'Active' | 'Inactive';
    color: 'success' | 'error';
  } {
    return {
      status: template.IsActive ? 'Active' : 'Inactive',
      color: template.IsActive ? 'success' : 'error'
    };
  }

  /**
   * Get type icon class name
   */
  static getTypeIcon(templateType: string): string {
    return templateType === 'Individual' ? 'User' : 'Users';
  }

  /**
   * Get type color classes
   */
  static getTypeColor(templateType: string): string {
    return templateType === 'Individual' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800';
  }

  /**
   * Get status color classes
   */
  static getStatusColor(isActive: boolean): string {
    return isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800';
  }

  /**
   * Format date for display
   */
  static formatDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  /**
   * Get role-based UI configuration
   */
  static getRoleConfig(userRole: string): {
    canCreateTemplates: boolean;
    canEditTemplates: boolean;
    canDeleteTemplates: boolean;
    showTenantColumn: boolean;
    showAgentColumn: boolean;
    requireTenantSelection: boolean;
    requireAgentSelection: boolean;
  } {
    switch (userRole) {
      case 'SysAdmin':
        return {
          canCreateTemplates: true,
          canEditTemplates: true,
          canDeleteTemplates: true,
          showTenantColumn: true,
          showAgentColumn: true,
          requireTenantSelection: true,
          requireAgentSelection: true, // Required
        };
      case 'TenantAdmin':
        return {
          canCreateTemplates: true,
          canEditTemplates: true,
          canDeleteTemplates: true,
          showTenantColumn: false,
          showAgentColumn: true,
          requireTenantSelection: false,
          requireAgentSelection: true, // Required
        };
      case 'Agent':
        return {
          canCreateTemplates: true,
          canEditTemplates: true,
          canDeleteTemplates: true,
          showTenantColumn: false,
          showAgentColumn: false,
          requireTenantSelection: false,
          requireAgentSelection: false,
        };
      case 'GroupAdmin':
        return {
          canCreateTemplates: false, // GroupAdmins can only view and use templates
          canEditTemplates: false,
          canDeleteTemplates: false,
          showTenantColumn: false,
          showAgentColumn: true, // Can see which agent the template belongs to
          requireTenantSelection: false,
          requireAgentSelection: false,
        };
      default:
        return {
          canCreateTemplates: false,
          canEditTemplates: false,
          canDeleteTemplates: false,
          showTenantColumn: false,
          showAgentColumn: false,
          requireTenantSelection: false,
          requireAgentSelection: false,
        };
    }
  }
}

export default EnrollmentLinkTemplatesService;
