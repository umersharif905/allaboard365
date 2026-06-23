// File: frontend/src/services/tenant-admin/tenant-admin.service.ts
import type { AxiosRequestConfig } from 'axios';
import type {
    ApiResponse,
    ChangePrimaryTenantRequest,
    CreateTenantGroupRequest,
    DkimResponse,
    PasswordResetResponse,
    PrimaryTenantChangePreview,
    ProductSubscriptionRequest,
    RemoveTenantAdminRequest,
    TenantAdminRemovalPreview,
    TenantFinancialSummary,
    TenantGroup,
    TenantMetrics,
    TenantProductSubscription,
    TenantSettings,
    TenantUser,
    UpdateTenantGroupRequest,
    UploadResponse,
    VerificationResponse
} from '../../types/index';
import { apiService } from '../api.service';
import { TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS } from './agents.service';

/** Optional tenant scope for `/api/me/tenant-admin/*` when the signed-in user is SysAdmin. */
export type TenantAdminApiContext = {
  tenantId?: string;
};

function tenantAdminRequestConfig(context?: TenantAdminApiContext): AxiosRequestConfig | undefined {
  if (!context?.tenantId) return undefined;
  return { headers: { 'x-current-tenant-id': context.tenantId } };
}

export class TenantAdminService {
  // DASHBOARD & METRICS
  static async getTenantSettings(): Promise<ApiResponse<TenantSettings>> {
    try {
      console.log('🔍 Fetching tenant settings...');
      const response = await apiService.get<ApiResponse<TenantSettings>>('/api/tenant-admin/settings');
      console.log('✅ Tenant settings received:', response);
      return response;
    } catch (error) {
      console.error('❌ Failed to fetch tenant settings:', error);
      // Return a proper error response with correct shape
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch tenant settings',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'SETTINGS_ERROR'
        }
      };
    }
  }

  static async getTenantMetrics(): Promise<ApiResponse<TenantMetrics>> {
    try {
      return await apiService.get<ApiResponse<TenantMetrics>>('/api/tenant-admin/metrics');
    } catch (error) {
      console.error('❌ Failed to fetch tenant metrics:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch tenant metrics',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'METRICS_ERROR'
        }
      };
    }
  }

  static async getFinancialSummary(): Promise<ApiResponse<TenantFinancialSummary>> {
    try {
      return await apiService.get<ApiResponse<TenantFinancialSummary>>('/api/tenant-admin/financial-summary');
    } catch (error) {
      console.error('❌ Failed to fetch financial summary:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch financial summary',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'FINANCIAL_ERROR'
        }
      };
    }
  }

  // USER MANAGEMENT
  static async getTenantUsers(filters: any, context?: TenantAdminApiContext): Promise<ApiResponse<TenantUser[]>> {
    try {
      // Filter out undefined values to prevent "undefined" strings in query params
      const cleanFilters = Object.fromEntries(
        Object.entries(filters).filter(([_, value]) => value !== undefined && value !== null && value !== '')
      );
      const queryString = new URLSearchParams(cleanFilters as Record<string, string>).toString();
      const url = queryString ? `/api/me/tenant-admin/users?${queryString}` : '/api/me/tenant-admin/users';
      return await apiService.get<ApiResponse<TenantUser[]>>(url, tenantAdminRequestConfig(context));
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch users',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'USERS_ERROR'
        }
      };
    }
  }

  static async createTenantUser(userData: any, context?: TenantAdminApiContext): Promise<ApiResponse<TenantUser>> {
    try {
      // Use the correct tenant-admin endpoint
      return await apiService.post<ApiResponse<TenantUser>>(
        '/api/me/tenant-admin/users',
        userData,
        tenantAdminRequestConfig(context)
      );
    } catch (error: any) {
      const errBody: ApiResponse<TenantUser> = {
        success: false,
        message: typeof error?.message === 'string' ? error.message : 'Failed to create user',
        error: {
          message: typeof error?.message === 'string' ? error.message : 'Unknown error',
          code: 'CREATE_USER_ERROR'
        }
      };
      errBody.isAlreadyTenantAdmin = Boolean(error?.isAlreadyTenantAdmin);
      errBody.isDifferentTenant = Boolean(error?.isDifferentTenant);
      return errBody;
    }
  }

  static async resetUserPassword(userId: string): Promise<ApiResponse<PasswordResetResponse>> {
    try {
      return await apiService.post<ApiResponse<PasswordResetResponse>>(`/api/me/tenant-admin/users/${userId}/reset-password`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to reset password',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'RESET_PASSWORD_ERROR'
        }
      };
    }
  }

  static async updateUserStatus(userId: string, status: string): Promise<ApiResponse<TenantUser>> {
    try {
      return await apiService.put<ApiResponse<TenantUser>>(`/api/me/tenant-admin/users/${userId}/status`, { status });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update user status',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPDATE_STATUS_ERROR'
        }
      };
    }
  }

  static async getTenantAdminRemovalPreview(
    userId: string,
    context?: TenantAdminApiContext
  ): Promise<ApiResponse<TenantAdminRemovalPreview>> {
    try {
      return await apiService.get<ApiResponse<TenantAdminRemovalPreview>>(
        `/api/me/tenant-admin/users/${userId}/removal-preview`,
        tenantAdminRequestConfig(context)
      );
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to load removal options',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'REMOVAL_PREVIEW_ERROR'
        }
      };
    }
  }

  static async getPrimaryTenantChangePreview(
    userId: string,
    context?: TenantAdminApiContext
  ): Promise<ApiResponse<PrimaryTenantChangePreview>> {
    try {
      return await apiService.get<ApiResponse<PrimaryTenantChangePreview>>(
        `/api/me/tenant-admin/users/${userId}/primary-tenant-preview`,
        tenantAdminRequestConfig(context)
      );
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to load primary tenant options',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'PRIMARY_TENANT_PREVIEW_ERROR'
        }
      };
    }
  }

  static async changePrimaryTenant(
    userId: string,
    payload: ChangePrimaryTenantRequest,
    context?: TenantAdminApiContext
  ): Promise<ApiResponse<{ newPrimaryTenantId: string; unchanged?: boolean }>> {
    try {
      return await apiService.put<ApiResponse<{ newPrimaryTenantId: string; unchanged?: boolean }>>(
        `/api/me/tenant-admin/users/${userId}/primary-tenant`,
        payload,
        tenantAdminRequestConfig(context)
      );
    } catch (error: unknown) {
      const err = error as { response?: { data?: ApiResponse<any> }; message?: string };
      if (err.response?.data) {
        return err.response.data;
      }
      return {
        success: false,
        message: err.message || 'Failed to change primary tenant',
        error: {
          message: err.message || 'Unknown error',
          code: 'CHANGE_PRIMARY_TENANT_ERROR'
        }
      };
    }
  }

  static async deleteTenantUser(
    userId: string,
    options?: RemoveTenantAdminRequest,
    context?: TenantAdminApiContext
  ): Promise<ApiResponse<any>> {
    try {
      return await apiService.delete<ApiResponse<any>>(
        `/api/me/tenant-admin/users/${userId}`,
        {
          ...tenantAdminRequestConfig(context),
          data: options || {}
        }
      );
    } catch (error: unknown) {
      const err = error as { response?: { data?: ApiResponse<any> }; message?: string };
      if (err.response?.data) {
        return err.response.data;
      }
      return {
        success: false,
        message: err.message || 'Failed to remove tenant admin',
        error: {
          message: err.message || 'Unknown error',
          code: 'DELETE_USER_ERROR'
        }
      };
    }
  }

  static async resendInvitation(userId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.post<ApiResponse<any>>(`/api/me/tenant-admin/users/${userId}/resend-link`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to resend invitation',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'RESEND_INVITATION_ERROR'
        }
      };
    }
  }

  // GROUP MANAGEMENT - Using /api/groups endpoints for all group operations
  // frontend/src/services/tenant-admin/tenant-admin.service.ts
// Update these methods:

static async getTenantGroups(filters?: any): Promise<ApiResponse<TenantGroup[]>> {
    try {
      const queryString = filters ? `?${new URLSearchParams(filters).toString()}` : '';
      return await apiService.get<ApiResponse<TenantGroup[]>>(`/api/tenant-admin/groups${queryString}`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch groups',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'GROUPS_ERROR'
        }
      };
    }
  }

  static async getMyTenantGroups(includeArchived?: boolean, productId?: string, vendorId?: string, search?: string, groupType?: 'Standard' | 'ListBill'): Promise<ApiResponse<TenantGroup[]>> {
    try {
      const params = new URLSearchParams();
      if (includeArchived) params.set('includeArchived', 'true');
      if (productId) params.set('productId', productId);
      if (vendorId) params.set('vendorId', vendorId);
      if (search !== undefined && search !== null && String(search).trim() !== '') {
        params.set('search', String(search).trim());
      }
      if (groupType === 'Standard' || groupType === 'ListBill') params.set('groupType', groupType);
      const query = params.toString() ? `?${params.toString()}` : '';
      return await apiService.get<ApiResponse<TenantGroup[]>>(`/api/me/tenant-admin/groups${query}`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch groups',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'GROUPS_ERROR'
        }
      };
    }
  }

  static async getTenantGroup(groupId: string): Promise<ApiResponse<TenantGroup>> {
    try {
      return await apiService.get<ApiResponse<TenantGroup>>(`/api/tenant-admin/groups/${groupId}`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch group',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'GROUP_ERROR'
        }
      };
    }
  }

  static async createTenantGroup(groupData: CreateTenantGroupRequest): Promise<ApiResponse<TenantGroup>> {
    try {
      return await apiService.post<ApiResponse<TenantGroup>>('/api/me/tenant-admin/groups', groupData);
    } catch (error: unknown) {
      const msg =
        typeof (error as { message?: string })?.message === 'string' && (error as { message: string }).message.trim()
          ? (error as { message: string }).message
          : 'Failed to create group';
      return {
        success: false,
        message: msg,
        error: {
          message: msg,
          code: 'CREATE_GROUP_ERROR'
        }
      };
    }
  }

  static async updateTenantGroup(groupId: string, updates: UpdateTenantGroupRequest): Promise<ApiResponse<TenantGroup>> {
    try {
      return await apiService.put<ApiResponse<TenantGroup>>(`/api/tenant-admin/groups/${groupId}`, updates);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update group',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPDATE_GROUP_ERROR'
        }
      };
    }
  }

  // PRODUCT MANAGEMENT
  static async getSubscribedProducts(): Promise<ApiResponse<TenantProductSubscription[]>> {
    try {
      return await apiService.get<ApiResponse<TenantProductSubscription[]>>('/api/tenant-admin/products/subscribed');
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch subscribed products',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'PRODUCTS_ERROR'
        }
      };
    }
  }

  static async getMarketplaceProducts(): Promise<ApiResponse<any[]>> {
    try {
      return await apiService.get<ApiResponse<any[]>>('/api/tenant-admin/products/marketplace');
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch marketplace products',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'MARKETPLACE_ERROR'
        }
      };
    }
  }

  static async getProductRequests(): Promise<ApiResponse<any[]>> {
    try {
      return await apiService.get<ApiResponse<any[]>>('/api/tenant-admin/products/requests');
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch product requests',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'REQUESTS_ERROR'
        }
      };
    }
  }

  static async requestProduct(request: ProductSubscriptionRequest): Promise<ApiResponse<any>> {
    try {
      return await apiService.post<ApiResponse<any>>('/api/tenant-admin/products/request', request);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to request product',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'REQUEST_ERROR'
        }
      };
    }
  }

  static async toggleProductStatus(subscriptionId: string, isActive: boolean): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>(`/api/tenant-admin/products/subscribed/${subscriptionId}/toggle`, { isActive });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to toggle product status',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'TOGGLE_ERROR'
        }
      };
    }
  }

  static async cancelProductRequest(requestId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.delete<ApiResponse<any>>(`/api/tenant-admin/products/requests/${requestId}`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to cancel product request',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'CANCEL_ERROR'
        }
      };
    }
  }

  // TENANT SETTINGS
  static async updateTenantInfo(tenantData: any): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>('/api/tenant-admin/settings/info', tenantData);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update tenant info',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPDATE_INFO_ERROR'
        }
      };
    }
  }

  static async updateTenantSettings(settings: any): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>('/api/tenant-admin/settings', settings);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update tenant settings',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPDATE_SETTINGS_ERROR'
        }
      };
    }
  }

  // DKIM CONFIGURATION
  static async generateDkim(domain: string): Promise<ApiResponse<DkimResponse>> {
    try {
      return await apiService.post<ApiResponse<DkimResponse>>('/api/tenant-admin/dkim/generate', { domain });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to generate DKIM',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DKIM_ERROR'
        }
      };
    }
  }

  static async verifyDkim(domain: string): Promise<ApiResponse<VerificationResponse>> {
    try {
      return await apiService.post<ApiResponse<VerificationResponse>>('/api/tenant-admin/dkim/verify', { domain });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to verify DKIM',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DKIM_VERIFY_ERROR'
        }
      };
    }
  }

  // Test DKIM Configuration
  static async testTenantDKIM(testType: 'dns' | 'email' | 'both' = 'both'): Promise<ApiResponse<any>> {
    try {
      return await apiService.post<ApiResponse<any>>('/api/tenant-admin/dkim/test', { testType });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to test DKIM configuration',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DKIM_TEST_ERROR'
        }
      };
    }
  }

  // DOMAIN VERIFICATION
  static async verifyDomain(domain: string): Promise<ApiResponse<VerificationResponse>> {
    try {
      return await apiService.post<ApiResponse<VerificationResponse>>('/api/tenant-admin/domain/verify', { domain });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to verify domain',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DOMAIN_VERIFY_ERROR'
        }
      };
    }
  }

  // Alias for backward compatibility
  static async verifyCustomDomain(): Promise<ApiResponse<VerificationResponse>> {
    // For backward compatibility - the component expects this method
    // In the future, update the component to use verifyDomain instead
    return TenantAdminService.verifyDomain('')
      .then(response => {
        if (!response.success) {
          return {
            ...response,
            data: {
              verified: false,
              message: 'Domain verification requires a domain parameter',
              isValid: false
            } as VerificationResponse
          };
        }
        return response;
      });
  }

  // LOGO UPLOAD
  static async uploadLogo(file: File): Promise<ApiResponse<UploadResponse>> {
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      return await apiService.post<ApiResponse<UploadResponse>>('/api/tenant-admin/logo/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to upload logo',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPLOAD_ERROR'
        }
      };
    }
  }

  // AGENT MANAGEMENT
  static async getTenantAgents(filters?: any): Promise<ApiResponse<any[]>> {
    try {
      const queryString = filters ? `?${new URLSearchParams(filters).toString()}` : '';
      return await apiService.get<ApiResponse<any[]>>(`/api/tenant-admin/agents${queryString}`, {
        timeout: TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS
      });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch agents',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'AGENTS_ERROR'
        }
      };
    }
  }

  static async getTenantAgent(agentId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.get<ApiResponse<any>>(`/api/tenant-admin/agents/${agentId}`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch agent',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'AGENT_ERROR'
        }
      };
    }
  }

  static async createTenantAgent(agentData: any): Promise<ApiResponse<any>> {
    try {
      return await apiService.post<ApiResponse<any>>('/api/tenant-admin/agents', agentData);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create agent',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'CREATE_AGENT_ERROR'
        }
      };
    }
  }

  static async updateTenantAgent(agentId: string, updates: any): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>(`/api/tenant-admin/agents/${agentId}`, updates);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update agent',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPDATE_AGENT_ERROR'
        }
      };
    }
  }

  static async getTenantAgentBankInfo(agentId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.get<ApiResponse<any>>(`/api/tenant-admin/agents/${agentId}/bank-info`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch bank info',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'BANK_INFO_ERROR'
        }
      };
    }
  }

  static async updateTenantAgentBankInfo(agentId: string, bankInfo: any): Promise<ApiResponse<any>> {
    try {
      return await apiService.post<ApiResponse<any>>(`/api/tenant-admin/agents/${agentId}/bank-info`, bankInfo);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update bank info',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPDATE_BANK_INFO_ERROR'
        }
      };
    }
  }

  static async deleteTenantAgentBankInfo(agentId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.delete<ApiResponse<any>>(`/api/tenant-admin/agents/${agentId}/bank-info`);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to delete bank info',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DELETE_BANK_INFO_ERROR'
        }
      };
    }
  }
}

// Export for backward compatibility
export default TenantAdminService;