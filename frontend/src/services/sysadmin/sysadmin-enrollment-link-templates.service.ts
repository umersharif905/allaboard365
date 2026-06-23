// frontend/src/services/sysadmin/sysadmin-enrollment-link-templates.service.ts
import { ApiResponse } from '../../types/api.types';
import { apiService } from '../api.service';

// Types
export interface EnrollmentLinkTemplate {
  TemplateId: string;
  TemplateName: string;
  TemplateType: 'Individual' | 'Group';
  AgentId: string;
  TenantId: string;
  LinkMetaData: string; // JSON string
  IsActive: boolean;
  Description?: string;
  CreatedDate: string;
  ModifiedDate: string;
  CreatedBy: string;
  ModifiedBy: string;
  TenantName: string;
  AgentName: string;
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
  search?: string;
  templateType?: 'Individual' | 'Group' | '';
  isActive?: boolean | '';
  tenantId?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    itemsPerPage: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export interface CreateTemplateRequest {
  templateName: string;
  templateType: 'Individual' | 'Group';
  tenantId: string;
  agentId: string;
  linkMetaData: string;
  description?: string;
  isActive?: boolean;
}

export interface UpdateTemplateRequest {
  templateName?: string;
  templateType?: 'Individual' | 'Group';
  tenantId?: string;
  agentId?: string;
  linkMetaData?: string;
  description?: string;
  isActive?: boolean;
}

export interface TenantOption {
  id: string;
  label: string;
  Status: string;
}

export interface AgentOption {
  id: string;
  label: string;
  Email: string;
  Status: string;
  TenantId: string;
  TenantName: string;
}

export class SysadminEnrollmentLinkTemplatesService {
  private static readonly BASE_URL = '/api/me/sysadmin/enrollment-link-templates';

  /**
   * Get enrollment link templates (sysadmin can see all)
   */
  static async getTemplates(filters?: EnrollmentLinkTemplateFilters): Promise<ApiResponse<PaginatedResponse<EnrollmentLinkTemplate>>> {
    try {
      const queryParams = new URLSearchParams();
      
      if (filters?.page) queryParams.append('page', filters.page.toString());
      if (filters?.limit) queryParams.append('limit', filters.limit.toString());
      if (filters?.search) queryParams.append('search', filters.search);
      if (filters?.templateType !== undefined && filters.templateType !== '') {
        queryParams.append('templateType', filters.templateType);
      }
      if (filters?.isActive !== undefined && filters.isActive !== '') {
        queryParams.append('isActive', filters.isActive.toString());
      }
      if (filters?.tenantId) {
        queryParams.append('tenantId', filters.tenantId);
      }

      const url = queryParams.toString() 
        ? `${this.BASE_URL}?${queryParams.toString()}`
        : this.BASE_URL;

      return await apiService.get<ApiResponse<PaginatedResponse<EnrollmentLinkTemplate>>>(url);
    } catch (error) {
      console.error('Error fetching sysadmin enrollment link templates:', error);
      throw error;
    }
  }

  /**
   * Get a specific enrollment link template by ID
   */
  static async getTemplateById(templateId: string): Promise<ApiResponse<EnrollmentLinkTemplate>> {
    try {
      return await apiService.get<ApiResponse<EnrollmentLinkTemplate>>(`${this.BASE_URL}/${templateId}`);
    } catch (error) {
      console.error('Error fetching enrollment link template:', error);
      throw error;
    }
  }

  /**
   * Create a new enrollment link template
   */
  static async createTemplate(templateData: CreateTemplateRequest): Promise<ApiResponse<EnrollmentLinkTemplate>> {
    try {
      return await apiService.post<ApiResponse<EnrollmentLinkTemplate>>(this.BASE_URL, templateData);
    } catch (error) {
      console.error('Error creating enrollment link template:', error);
      throw error;
    }
  }

  /**
   * Update an existing enrollment link template
   */
  static async updateTemplate(templateId: string, templateData: UpdateTemplateRequest): Promise<ApiResponse<void>> {
    try {
      return await apiService.put<ApiResponse<void>>(`${this.BASE_URL}/${templateId}`, templateData);
    } catch (error) {
      console.error('Error updating enrollment link template:', error);
      throw error;
    }
  }

  /**
   * Delete an enrollment link template
   */
  static async deleteTemplate(templateId: string): Promise<ApiResponse<void>> {
    try {
      return await apiService.delete<ApiResponse<void>>(`${this.BASE_URL}/${templateId}`);
    } catch (error) {
      console.error('Error deleting enrollment link template:', error);
      throw error;
    }
  }

  /**
   * Get tenants for dropdown (sysadmin only)
   */
  static async getTenants(): Promise<ApiResponse<TenantOption[]>> {
    try {
      return await apiService.get<ApiResponse<TenantOption[]>>(`${this.BASE_URL}/dropdown-data/tenants`);
    } catch (error) {
      console.error('Error fetching tenants for dropdown:', error);
      throw error;
    }
  }

  /**
   * Get agents for dropdown (sysadmin - all agents, optionally filtered by tenant)
   */
  static async getAgents(tenantId?: string): Promise<ApiResponse<AgentOption[]>> {
    try {
      const url = tenantId 
        ? `${this.BASE_URL}/dropdown-data/agents?tenantId=${tenantId}`
        : `${this.BASE_URL}/dropdown-data/agents`;
      
      return await apiService.get<ApiResponse<AgentOption[]>>(url);
    } catch (error) {
      console.error('Error fetching agents for dropdown:', error);
      throw error;
    }
  }

  /**
   * Parse LinkMetaData JSON string
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
   * Get default LinkMetaData structure
   */
  static getDefaultLinkMetaData(): ParsedLinkMetaData {
    return {
      household: {
        collectSSN: false,
        collectDOB: true,
        collectGender: false,
        collectAddress: true,
        collectPhone: true,
      },
      products: [
        {
          page: "Medical Insurance",
          header: "Select Your Medical Insurance",
          productType: "medical",
          description: "Choose from our available medical insurance options"
        }
      ]
    };
  }
}

export default SysadminEnrollmentLinkTemplatesService;