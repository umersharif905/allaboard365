// File: frontend/src/services/TenantService.ts

import { apiService } from './api.service';
interface Tenant {
  TenantId: string;
  Name: string;
  Status: string;
  ContactEmail: string;
  ContactPhone?: string;
  Website?: string;
  PrimaryAddress?: string;
  PrimaryCity?: string;
  PrimaryState?: string;
  PrimaryZip?: string;
  CustomDomain?: string;
  DefaultUrlPath?: string;
  LogoUrl?: string;
  PrimaryColorHex?: string;
  SecondaryColorHex?: string;
  CreatedDate: string;
  ModifiedDate: string;
  TotalMembers: number;
  ActiveMembers: number;
  TotalAgents: number;
  MonthlyRevenue: number;
  TotalProducts: number;
  SubscribedProducts: number;
}

interface TenantStats {
  TotalMembers: number;
  ActiveMembers: number;
  NewMembersLastMonth: number;
  TotalUsers: number;
  TotalAgents: number;
  TotalGroupAdmins: number;
  TotalGroups: number;
  ActiveGroups: number;
  TotalEnrollments: number;
  ActiveEnrollments: number;
  MonthlyRevenue: number;
  AnnualizedMonthlyRevenue: number;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

class TenantService {
  async getTenants(options?: { status?: 'Inactive' }): Promise<ApiResponse<Tenant[]>> {
    try {
      const params = new URLSearchParams();
      if (options?.status === 'Inactive') {
        params.set('status', 'Inactive');
      }
      const qs = params.toString();
      const url = qs ? `/api/tenants?${qs}` : '/api/tenants';
      return await apiService.get<ApiResponse<Tenant[]>>(url);
    } catch (error) {
      console.error('Error fetching tenants:', error);
      throw error;
    }
  }

  async getTenant(id: string): Promise<ApiResponse<Tenant>> {
    try {
      return await apiService.get<ApiResponse<Tenant>>(`/api/tenants/${id}`);
    } catch (error) {
      console.error('Error fetching tenant:', error);
      throw error;
    }
  }

  async createTenant(tenantData: Partial<Tenant>): Promise<ApiResponse<Tenant>> {
    try {
      return await apiService.post<ApiResponse<Tenant>>('/api/tenants', tenantData);
    } catch (error) {
      console.error('Error creating tenant:', error);
      throw error;
    }
  }

  async updateTenant(id: string, updates: Partial<Tenant>): Promise<ApiResponse<Tenant>> {
    try {
      return await apiService.put<ApiResponse<Tenant>>(`/api/tenants/${id}`, updates);
    } catch (error) {
      console.error('Error updating tenant:', error);
      throw error;
    }
  }

  async deactivateTenant(id: string): Promise<ApiResponse<{ TenantId: string; Name: string; Status: string }>> {
    try {
      return await apiService.post<ApiResponse<{ TenantId: string; Name: string; Status: string }>>(
        `/api/tenants/${id}/deactivate`,
        {}
      );
    } catch (error) {
      console.error('Error deactivating tenant:', error);
      throw error;
    }
  }

  async getTenantStats(id: string): Promise<ApiResponse<TenantStats>> {
    try {
      return await apiService.get<ApiResponse<TenantStats>>(`/api/tenants/${id}/stats`);
    } catch (error) {
      console.error('Error fetching tenant stats:', error);
      throw error;
    }
  }

  // Export tenants data
  async exportTenants(format: 'csv' | 'xlsx' = 'csv'): Promise<Blob> {
    try {
      const response = await apiService.get(`/api/tenants/export?format=${format}`, {
        responseType: 'blob',
      });
      return response as unknown as Blob;
    } catch (error) {
      console.error('Error exporting tenants:', error);
      throw error;
    }
  }

  // Check URL availability
  async checkUrlAvailability(urlPath: string): Promise<ApiResponse<{ available: boolean }>> {
    try {
      return await apiService.get<ApiResponse<{ available: boolean }>>(`/api/tenant-identification/check-availability/${urlPath}`);
    } catch (error) {
      console.error('Error checking URL availability:', error);
      throw error;
    }
  }

  // Get users for a tenant
  async getTenantUsers(tenantId: string): Promise<ApiResponse<any[]>> {
    try {
      return await apiService.get<ApiResponse<any[]>>(`/api/users?tenantId=${tenantId}`);
    } catch (error) {
      console.error('Error fetching tenant users:', error);
      throw error;
    }
  }
}

export { TenantService };
export default new TenantService();
export type { ApiResponse, Tenant, TenantStats };

