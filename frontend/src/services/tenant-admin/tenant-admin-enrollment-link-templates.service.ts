// frontend/src/services/tenant-admin/tenant-admin-enrollment-link-templates.service.ts
import { ApiResponse } from '../../types/api.types';
import { apiService } from '../api.service';

// Types
export interface EnrollmentLinkTemplate {
  TemplateId: string;
  TemplateName: string;
  TemplateType: 'Individual' | 'Group';
  AgentId: string;
  TenantId: string;
  GroupId?: string; // Optional - only for Group templates
  LinkMetaData: string; // JSON string
  IsActive: boolean;
  Description?: string;
  CreatedDate: string;
  ModifiedDate: string;
  CreatedBy: string;
  ModifiedBy: string;
  TenantName: string;
  AgentName: string;
  GroupName?: string; // Group name for Group templates
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
  agentId: string;
  linkMetaData: string;
  description?: string;
  isActive?: boolean;
  groupId?: string; // Required for Group templates
  tenantId?: string; // For SysAdmin
}

export interface UpdateTemplateRequest {
  templateName?: string;
  templateType?: 'Individual' | 'Group';
  agentId?: string;
  linkMetaData?: string;
  description?: string;
  isActive?: boolean;
  groupId?: string; // For Group templates
  tenantId?: string; // For SysAdmin
}

export interface AgentOption {
  id: string;
  label: string;
  Email: string;
  Status: string;
}

export class TenantAdminEnrollmentLinkTemplatesService {
  private static readonly BASE_URL = '/api/me/tenant-admin/enrollment-link-templates';

  /**
   * Get enrollment link templates for the authenticated tenant admin's tenant
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

      const url = queryParams.toString() 
        ? `${this.BASE_URL}?${queryParams.toString()}`
        : this.BASE_URL;

      return await apiService.get<ApiResponse<PaginatedResponse<EnrollmentLinkTemplate>>>(url);
    } catch (error) {
      console.error('Error fetching tenant admin enrollment link templates:', error);
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
   * Get agents for dropdown (tenant admin - only agents in their tenant)
   */
  static async getAgents(): Promise<ApiResponse<AgentOption[]>> {
    try {
      return await apiService.get<ApiResponse<AgentOption[]>>(`${this.BASE_URL}/dropdown-data/agents`);
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

export default TenantAdminEnrollmentLinkTemplatesService;