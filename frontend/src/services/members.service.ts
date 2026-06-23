// frontend/src/services/members.service.ts
import axios from 'axios';
import { API_CONFIG } from '../config/api';
import {
  AGENT_FILTER_SCOPE_AGENCY,
  AGENT_FILTER_SCOPE_DIRECT_DOWNLINE,
  AGENT_FILTER_SHOW_ALL,
  isAgentFilterScopeSentinel
} from '../constants/agentFilterScope';
import type { ApiResponse } from '../types/api.types';
import type { Member } from '../types/member.types';
import { apiService } from './api.service';
import { authService } from './auth.service';

// Export types for use in other files
/** 'individual' = non-group primary (GroupId null), 'group' = group primary, 'all' = both */
export type MemberTypeFilter = 'individual' | 'group' | 'all';

export interface MemberHistoryRow {
  EventId: string;
  MemberId: string;
  EventType: string;
  OldGroupId?: string | null;
  NewGroupId?: string | null;
  OldGroupName?: string | null;
  NewGroupName?: string | null;
  /** Present when oe.MemberEventLog.EventDetails exists (e.g. plan modification summary). */
  EventDetails?: string | null;
  CreatedDate: string;
  CreatedBy?: string | null;
  CreatedByName?: string | null;
}

export interface MemberFilterState {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
  tenantId?: string;
  groupId?: string;
  agentId?: string;
  agencyId?: string;
  enrollmentType?: string;
  state?: string;
  relationshipType?: string;
  householdOnly?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  enrollmentStatus?: 'active' | 'activelyEnrolled' | 'futureEffective' | 'effectiveCurrently' | 'all';
  /** Enrollment journey filter (mutually exclusive with status in UI). */
  enrollmentLifecycleStatus?:
    | ''
    | 'paymentHold'
    | 'enrollmentLinkSent'
    | 'notEnrolled'
    | 'noLinkSent'
    | 'pendingMigration';
  /** Filter by individual (non-group) vs group primary members. Default 'individual'. */
  memberTypeFilter?: MemberTypeFilter;
  /** Advanced: filter by product (members enrolled in this product) */
  productId?: string;
  /** Advanced: filter by vendor (members enrolled in products from this vendor) */
  vendorId?: string;
  /** Advanced: enrollment EffectiveDate — day of month (1–31), empty = any */
  effectiveDay?: string;
  /** Advanced: month (1–12), empty = any */
  effectiveMonth?: string;
  /** Advanced: year (e.g. 2026), empty = any */
  effectiveYear?: string;
}

export interface MemberResponse {
  members: Member[];
  total: number;
  summary?: {
    householdCount: number;
    monthlyPremiums: number;
  };
}

export interface Enrollment {
  EnrollmentId: string;
  MemberId: string;
  ProductId: string;
  ProductName: string;
  PremiumAmount: number;
  EmployerContribution: number;
  Status: string;
  EffectiveDate: string;
  EndDate?: string;
}

export interface DashboardMetrics {
  totalMembers: number;
  membersChange: number;
  activeEnrollments: number;
  enrollmentsChange: number;
  monthlyPremiums: number;
  premiumsChange: number;
  avgPremium: number;
  avgPremiumChange: number;
  householdCount: number;
}

// Keep the MembersAPI class for backward compatibility
export class MembersAPI {
  async getMembers(filters: any): Promise<{ members: Member[], total: number }> {
    try {
      const response = await apiService.get<{ success: boolean, data: { members: Member[], total: number } }>('/api/members', { params: filters });
      return response.data;
    } catch (error) {
      console.error('Error fetching members:', error);
      throw error;
    }
  }

  async getMemberWithHousehold(memberId: string): Promise<{ member: Member, householdMembers: Member[] }> {
    try {
      const response = await apiService.get<{ success: boolean, data: { member: Member, householdMembers: Member[] } }>(`/api/members/${memberId}/with-household`);
      return response.data;
    } catch (error) {
      console.error('Error fetching member with household:', error);
      throw error;
    }
  }

  async getMemberEnrollments(memberId: string): Promise<any[]> {
    try {
      const response = await apiService.get<{ success: boolean, data: any[] }>(`/api/enrollments?memberId=${memberId}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching member enrollments:', error);
      throw error;
    }
  }

  async getDashboardMetrics(): Promise<any> {
    try {
      const response = await apiService.get<{ success: boolean, data: any }>('/api/metrics/dashboard');
      return response.data;
    } catch (error) {
      console.error('Error fetching dashboard metrics:', error);
      throw error;
    }
  }

  async updateMember(memberId: string, memberData: any): Promise<any> {
    try {
      const response = await MembersService.updateMember(memberId, memberData);
      if (response && response.success) {
        return response.data;
      }
      throw new Error((response && response.message) || 'Failed to update member');
    } catch (error) {
      console.error('Error updating member:', error);
      throw error;
    }
  }

  async deleteMember(memberId: string): Promise<void> {
    try {
      const response = await apiService.delete<ApiResponse<any>>(`/api/members/${memberId}`);
      if (!response.success) {
        throw new Error(response.message || 'Failed to delete member');
      }
    } catch (error) {
      console.error('Error deleting member:', error);
      throw error;
    }
  }

  async addDependent(householdId: string, dependentData: any): Promise<Member> {
    try {
      // Transform to match the format expected by our new service
      const transformedData = {
        ...dependentData,
        phoneNumber: dependentData.phone,
        primaryMemberId: householdId
      };
      
      const response = await MembersService.createMember(transformedData);
      if (response.success) {
        return response.data;
      }
      throw new Error(response.message || 'Failed to add dependent');
    } catch (error) {
      console.error('Error adding dependent:', error);
      throw error;
    }
  }

  async createHousehold(householdData: any): Promise<any> {
    try {
      // This is a special case - we're creating a primary member which automatically creates a household
      const response = await MembersService.createMember({
        ...householdData,
        relationshipType: 'P'
      });
      
      if (response.success) {
        return response.data;
      }
      throw new Error(response.message || 'Failed to create household');
    } catch (error) {
      console.error('Error creating household:', error);
      throw error;
    }
  }
}

export class MembersService {
  /**
   * Fetches all members with optional filtering
   * @param filters Optional filters like groupId, status, etc.
   */
  static async getMembers(filters?: MemberFilterState): Promise<ApiResponse<MemberResponse>> {
    try {
      console.log('📞 MembersService.getMembers called with filters:', filters);
      
      // Convert filters to query parameters
      const queryParams = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (key === 'agentId' && isAgentFilterScopeSentinel(String(value))) return;
          if (value !== undefined && value !== '') {
            queryParams.append(key, String(value));
          }
        });
      }
      
      const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
      const endpoint = `/api/members${queryString}`;
      console.log('🔗 Calling API endpoint:', endpoint);
      
      const response = await apiService.get<ApiResponse<MemberResponse | Member[]>>(endpoint);
      console.log('📥 API response received:', response);
      
      // Ensure we return the expected structure
      if (response.success) {
        // Handle different response formats
        if (Array.isArray(response.data)) {
          // If response is an array of members, convert to standard format
          return {
            success: true,
            message: response.message,
            data: { members: response.data, total: response.data.length }
          };
        } else if (response.data && (response.data as any).members) {
          // If response already has members field, return as is
          return {
            success: true,
            message: response.message,
            data: response.data as MemberResponse
          };
        }
      }
      
      // Default format for unsuccessful or empty responses
      return {
        success: response.success,
        message: response.message,
        data: { members: [], total: 0 }
      };
    } catch (error) {
      console.error('❌ Error fetching members:', error);
      return { 
        success: false, 
        data: { members: [], total: 0 }, 
        message: 'Failed to fetch members' 
      };
    }
  }

  /**
   * Fetches members for the current group admin
   * Uses the special endpoint for GroupAdmin role
   */
  static async getGroupAdminMembers(filters: MemberFilterState = {}): Promise<ApiResponse<MemberResponse>> {
    try {
      console.log('📞 MembersService.getGroupAdminMembers called with filters:', filters);
      
      const queryParams = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (key === 'memberTypeFilter') return;
          if (key === 'agentId' && isAgentFilterScopeSentinel(String(value))) return;
          if (value === undefined || value === '' || value === null) return;
          queryParams.append(key, String(value));
        });
      }
      if (filters.memberTypeFilter === 'individual' || filters.memberTypeFilter === 'group') {
        queryParams.append('memberTypeFilter', filters.memberTypeFilter);
      }
      const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
      const endpoint = `/api/me/group-admin/members${queryString}`;
      console.log('🔗 Calling GroupAdmin API endpoint:', endpoint);
      
      const response = await apiService.get<ApiResponse<MemberResponse | Member[]>>(endpoint);
      console.log('📥 GroupAdmin API full response:', JSON.stringify(response, null, 2));
      
      // Validate response structure
      if (!response.success) {
        console.error('❌ GroupAdmin API returned unsuccessful response:', response);
        return {
          success: false,
          message: response.message || 'API returned unsuccessful response',
          data: { members: [], total: 0 }
        };
      }
      
      if (!response.data) {
        console.error('❌ GroupAdmin API response missing data property:', response);
        return {
          success: true,
          data: { members: [], total: 0 }
        };
      }
      
      // Handle different response formats
      if (Array.isArray(response.data)) {
        // If response is an array of members, convert to standard format
        console.log('✅ GroupAdmin API returned array format with', response.data.length, 'members');
        return {
          success: true,
          message: response.message,
          data: { members: response.data, total: response.data.length }
        };
      } else if (response.data && (response.data as any).members) {
        // If response already has members field, make sure it's an array
        const members = Array.isArray((response.data as any).members) 
          ? (response.data as any).members 
          : [];
        const total = (response.data as any).total || members.length;
        const summary = (response.data as any).summary as MemberResponse['summary'] | undefined;

        console.log('✅ GroupAdmin API returned object format with', members.length, 'members');
        return {
          success: true,
          message: response.message,
          data: { members, total, ...(summary ? { summary } : {}) }
        };
      }
      
      // Fallback for unexpected format
      console.error('❌ GroupAdmin API returned unexpected data format:', response.data);
      return {
        success: true,
        data: { members: [], total: 0 }
      };
    } catch (error) {
      console.error('❌ Error fetching group admin members:', error);
      return { 
        success: false, 
        data: { members: [], total: 0 }, 
        message: 'Failed to fetch members for your group' 
      };
    }
  }

  /**
   * Fetches members for the current agent
   * Uses the special endpoint for Agent role
   */
  static async getAgentMembers(filters: MemberFilterState = {}): Promise<ApiResponse<MemberResponse>> {
    try {
      console.log('📞 MembersService.getAgentMembers called with filters:', filters);
      
      const queryParams = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (key === 'memberTypeFilter') return;
          if (key === 'agentId') return;
          if (value !== undefined && value !== '') {
            queryParams.append(key, String(value));
          }
        });
      }
      if (filters.agentId === AGENT_FILTER_SCOPE_AGENCY) {
        queryParams.append('scope', 'agency');
      } else if (filters.agentId === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE) {
        queryParams.append('scope', 'direct');
      } else if (filters.agentId === AGENT_FILTER_SHOW_ALL) {
        queryParams.append('scope', 'downline');
      } else if (filters.agentId !== undefined && filters.agentId !== '') {
        queryParams.append('agentId', String(filters.agentId));
      }
      if (filters.memberTypeFilter === 'individual' || filters.memberTypeFilter === 'group') {
        queryParams.append('memberTypeFilter', filters.memberTypeFilter);
      }
      
      const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
      const endpoint = `/api/me/agent/members${queryString}`;
      console.log('🔗 Calling Agent API endpoint:', endpoint);
      
      const response = await apiService.get<ApiResponse<MemberResponse | Member[]>>(endpoint);
      console.log('📥 Agent API full response:', JSON.stringify(response, null, 2));
      
      // Validate response structure
      if (!response.success) {
        console.error('❌ Agent API returned unsuccessful response:', response);
        return {
          success: false,
          message: response.message || 'API returned unsuccessful response',
          data: { members: [], total: 0 }
        };
      }
      
      if (!response.data) {
        console.error('❌ Agent API response missing data property:', response);
        return {
          success: true,
          data: { members: [], total: 0 }
        };
      }
      
      // Handle different response formats
      if (Array.isArray(response.data)) {
        // If response is an array of members, convert to standard format
        console.log('✅ Agent API returned array format with', response.data.length, 'members');
        return {
          success: true,
          message: response.message,
          data: { members: response.data, total: response.data.length }
        };
      } else if (response.data && (response.data as any).members) {
        // If response already has members field, make sure it's an array
        const members = Array.isArray((response.data as any).members) 
          ? (response.data as any).members 
          : [];
        const total = (response.data as any).total || members.length;
        const summary = (response.data as any).summary as MemberResponse['summary'] | undefined;

        console.log('✅ Agent API returned object format with', members.length, 'members');
        return {
          success: true,
          message: response.message,
          data: { members, total, ...(summary ? { summary } : {}) }
        };
      }
      
      // Fallback for unexpected format
      console.error('❌ Agent API returned unexpected data format:', response.data);
      return {
        success: true,
        data: { members: [], total: 0 }
      };
    } catch (error) {
      console.error('❌ Error fetching agent members:', error);
      return { 
        success: false, 
        data: { members: [], total: 0 }, 
        message: 'Failed to fetch members for your agent account' 
      };
    }
  }

  /**
   * Creates a new member
   * @param memberData The member data to create
   */
  /**
   * Creates an entire household atomically (primary + dependents)
   * If any member fails, the entire household is rolled back
   */
  static async createHouseholdAtomically(primaryMember: any, dependents: any[] = []): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>('/api/members/household', {
        primaryMember,
        dependents
      });
      return response;
    } catch (error: any) {
      console.error('Error creating household atomically:', error);
      return {
        success: false,
        message: error?.response?.data?.message || error?.message || 'Failed to create household',
        error: {
          message: error?.response?.data?.error?.message || error?.message || 'Unknown error',
          code: error?.response?.data?.error?.code || 'HOUSEHOLD_CREATION_ERROR'
        }
      };
    }
  }

  static async createMember(memberData: any): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>('/api/members', memberData);
      // Log response for debugging
      if (memberData.relationshipType && memberData.relationshipType !== 'P') {
        console.log(`📥 MembersService.createMember response for dependent:`, {
          success: response.success,
          message: response.message,
          data: response.data,
          hasMemberId: !!response.data?.memberId
        });
      }
      return response;
    } catch (error) {
      console.error('❌ Error creating member in MembersService:', error);
      // Re-throw the error so the caller can handle it
      throw error;
    }
  }

  /**
   * Updates an existing member
   * @param memberId The ID of the member to update
   * @param memberData The member data to update
   */
  static async updateMember(memberId: string, memberData: any): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>(`/api/members/${memberId}`, memberData);
    } catch (error) {
      console.error(`Error updating member ${memberId}:`, error);
      throw error;
    }
  }

  static async getMemberHistory(memberId: string): Promise<ApiResponse<MemberHistoryRow[]>> {
    return await apiService.get<ApiResponse<MemberHistoryRow[]>>(`/api/members/${memberId}/history`);
  }

  /**
   * Terminates a member by setting their status to 'Terminated'
   * @param memberId The ID of the member to terminate
   * @param terminationDate Optional termination date (defaults to today)
   */
  static async terminateMember(memberId: string, terminationDate?: string): Promise<ApiResponse<any>> {
    try {
      const requestData: any = { status: 'Terminated' };
      if (terminationDate) {
        requestData.terminationDate = terminationDate;
      }
      return await apiService.put<ApiResponse<any>>(`/api/members/${memberId}`, requestData);
    } catch (error) {
      console.error(`Error terminating member ${memberId}:`, error);
      return { success: false, data: null, message: `Failed to terminate member ${memberId}` };
    }
  }

  /**
   * Unterminates a member by setting their status back to 'Active'
   * @param memberId The ID of the member to unterminate
   */
  static async unterminateMember(memberId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>(`/api/members/${memberId}`, { 
        status: 'Active',
        terminationDate: null 
      });
    } catch (error) {
      console.error(`Error unterminating member ${memberId}:`, error);
      return { success: false, data: null, message: `Failed to unterminate member ${memberId}` };
    }
  }

  /**
   * Fetches all members for SysAdmin with pagination and filtering
   * Uses the general /api/members endpoint with proper query parameters
   * @param filters The filter parameters including pagination
   */
  static async getAllMembers(filters: MemberFilterState = {}): Promise<ApiResponse<MemberResponse>> {
    try {
      console.log('📞 MembersService.getAllMembers called with filters:', filters);
      
      // Build query parameters
      const params = new URLSearchParams();
      
      // Add pagination
      if (filters.page) params.append('page', filters.page.toString());
      if (filters.limit) params.append('limit', filters.limit.toString());
      
      // Add filters
      if (filters.search) params.append('search', filters.search);
      if (filters.status) params.append('status', filters.status);
      if (filters.tenantId) params.append('tenantId', filters.tenantId);
      if (filters.groupId) params.append('groupId', filters.groupId);
      if (filters.agentId && !isAgentFilterScopeSentinel(filters.agentId)) {
        params.append('agentId', filters.agentId);
      }
      if (filters.agencyId) params.append('agencyId', filters.agencyId);
      if (filters.enrollmentType) params.append('enrollmentType', filters.enrollmentType);
      if (filters.state) params.append('state', filters.state);
      if (filters.relationshipType) params.append('relationshipType', filters.relationshipType);
      if (filters.householdOnly) params.append('householdOnly', 'true');
      if (filters.memberTypeFilter === 'individual' || filters.memberTypeFilter === 'group') {
        params.append('memberTypeFilter', filters.memberTypeFilter);
      }
      if (filters.productId) params.append('productId', filters.productId);
      if (filters.vendorId) params.append('vendorId', filters.vendorId);
      if (filters.enrollmentStatus) {
        params.append('enrollmentStatus', filters.enrollmentStatus);
      }
      if (filters.enrollmentLifecycleStatus) {
        params.append('enrollmentLifecycleStatus', filters.enrollmentLifecycleStatus);
      }
      if (filters.effectiveDay) params.append('effectiveDay', filters.effectiveDay);
      if (filters.effectiveMonth) params.append('effectiveMonth', filters.effectiveMonth);
      if (filters.effectiveYear) params.append('effectiveYear', filters.effectiveYear);
      
      // Add sorting
      if (filters.sortBy) params.append('sortBy', filters.sortBy);
      if (filters.sortOrder) params.append('sortOrder', filters.sortOrder);
      
      const queryString = params.toString();
      const endpoint = `/api/members${queryString ? `?${queryString}` : ''}`;
      
      console.log('🔗 Calling SysAdmin API endpoint:', endpoint);
      
      const response = await apiService.get<ApiResponse<MemberResponse>>(endpoint);
      console.log('📥 SysAdmin API response:', response);
      
      // Validate response structure
      if (!response.success) {
        console.error('❌ SysAdmin API returned unsuccessful response:', response);
        return {
          success: false,
          message: response.message || 'Failed to fetch members',
          data: { members: [], total: 0 }
        };
      }

      // Handle the response data
      if (response.data && typeof response.data === 'object') {
        // Check if it's already in the expected format
        if ('members' in response.data && 'total' in response.data) {
          return {
            success: true,
            message: response.message,
            data: response.data as MemberResponse
          };
        }
        
        // If it's just an array of members (legacy format)
        if (Array.isArray(response.data)) {
          const members = response.data as any[];
          return {
            success: true,
            message: response.message,
            data: { members, total: members.length }
          };
        }
      }
      
      // Fallback for unexpected format
      console.error('❌ SysAdmin API returned unexpected data format:', response.data);
      return {
        success: true,
        data: { members: [], total: 0 },
        message: 'No members found'
      };
      
    } catch (error) {
      console.error('❌ Error fetching all members:', error);
      return { 
        success: false, 
        data: { members: [], total: 0 }, 
        message: error instanceof Error ? error.message : 'Failed to fetch members' 
      };
    }
  }

  /**
   * Fetches dashboard metrics for SysAdmin (all tenants)
   */
  static async getAllMembersMetrics(): Promise<ApiResponse<DashboardMetrics>> {
    try {
      console.log('📞 MembersService.getAllMembersMetrics called');
      
      const response = await apiService.get<ApiResponse<DashboardMetrics>>('/api/metrics/members');
      console.log('📥 SysAdmin Metrics API response:', response);
      
      if (!response.success) {
        console.error('❌ SysAdmin Metrics API returned unsuccessful response:', response);
        return {
          success: false,
          message: response.message || 'Failed to fetch metrics',
          data: {
            totalMembers: 0,
            membersChange: 0,
            activeEnrollments: 0,
            enrollmentsChange: 0,
            monthlyPremiums: 0,
            premiumsChange: 0,
            avgPremium: 0,
            avgPremiumChange: 0,
            householdCount: 0
          }
        };
      }

      return response;
      
    } catch (error) {
      console.error('❌ Error fetching all members metrics:', error);
      return { 
        success: false, 
        data: {
          totalMembers: 0,
          membersChange: 0,
          activeEnrollments: 0,
          enrollmentsChange: 0,
          monthlyPremiums: 0,
          premiumsChange: 0,
          avgPremium: 0,
          avgPremiumChange: 0,
          householdCount: 0
        }, 
        message: error instanceof Error ? error.message : 'Failed to fetch metrics' 
      };
    }
  }

  /**
   * Fetches members for the current tenant admin
   * Uses the dedicated /api/me/tenant-admin/members endpoint
   */
  static async getTenantAdminMembers(filters: MemberFilterState = {}): Promise<ApiResponse<MemberResponse>> {
    try {
      console.log('📞 MembersService.getTenantAdminMembers called with filters:', filters);
      
      const queryParams = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (key === 'memberTypeFilter') return;
          if (key === 'agentId' && isAgentFilterScopeSentinel(String(value))) return;
          if (value !== undefined && value !== '') {
            queryParams.append(key, String(value));
          }
        });
      }
      if (filters.memberTypeFilter === 'individual' || filters.memberTypeFilter === 'group') {
        queryParams.append('memberTypeFilter', filters.memberTypeFilter);
      }
      
      const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
      const endpoint = `/api/me/tenant-admin/members${queryString}`;
      console.log('🔗 TenantAdmin calling API endpoint:', endpoint);
      
      const response = await apiService.get<ApiResponse<MemberResponse>>(endpoint);
      console.log('📥 TenantAdmin API response received:', response);
      
      return response;
      
    } catch (error) {
      console.error('❌ Error fetching tenant admin members:', error);
      return { 
        success: false, 
        data: { members: [], total: 0 }, 
        message: error instanceof Error ? error.message : 'Failed to fetch tenant members' 
      };
    }
  }

  /**
   * Fetches dashboard metrics for TenantAdmin
   */
  static async getTenantAdminMetrics(): Promise<ApiResponse<DashboardMetrics>> {
    try {
      console.log('📞 MembersService.getTenantAdminMetrics called');
      
      // TenantAdmin uses the same metrics endpoint but backend filters by tenant
      return await this.getAllMembersMetrics();
      
    } catch (error) {
      console.error('❌ Error fetching tenant admin metrics:', error);
      return { 
        success: false, 
        data: {
          totalMembers: 0,
          membersChange: 0,
          activeEnrollments: 0,
          enrollmentsChange: 0,
          monthlyPremiums: 0,
          premiumsChange: 0,
          avgPremium: 0,
          avgPremiumChange: 0,
          householdCount: 0
        }, 
        message: error instanceof Error ? error.message : 'Failed to fetch tenant metrics' 
      };
    }
  }

  /**
   * Get a single member by ID
   */
  static async getMember(memberId: string): Promise<ApiResponse<Member>> {
    try {
      return await apiService.get<ApiResponse<Member>>(`/api/members/${memberId}`);
    } catch (error) {
      console.error(`Error fetching member ${memberId}:`, error);
      return { success: false, data: undefined, message: `Failed to fetch member ${memberId}` };
    }
  }

  /**
   * Delete a member
   */
  static async deleteMember(memberId: string): Promise<ApiResponse<any>> {
    try {
      return await apiService.delete<ApiResponse<any>>(`/api/members/${memberId}`);
    } catch (error) {
      console.error(`Error deleting member ${memberId}:`, error);
      return { success: false, data: null, message: `Failed to delete member ${memberId}` };
    }
  }

  /**
   * Get members for a specific group (used by TenantAdmin for specific group)
   */
  /**
   * Parse member census file with AI
   * @param groupId The ID of the group
   * @param file The census file (CSV, XLSX, XLS)
   * @param abortSignal Optional AbortSignal for cancellation
   * @returns Parsed households data
   */
  static async parseCensusWithAI(groupId: string, file: File, abortSignal?: AbortSignal): Promise<ApiResponse<any>> {
    try {
      console.log(`📊 Parsing census file for group ${groupId}: ${file.name}`);
      
      const formData = new FormData();
      formData.append('file', file);
      
      // Increase timeout to 7 minutes (420 seconds) for AI parsing
      // Create a custom axios instance for this long-running request
      // This ensures the timeout is properly applied and overrides the default 30s timeout
      const token = await authService.getAccessToken();
      
      if (!token) {
        throw new Error('No authentication token available');
      }
      
      // Create a custom axios instance with longer timeout
      const customAxios = axios.create({
        baseURL: API_CONFIG.BASE_URL || window.location.origin,
        timeout: 420000, // 7 minutes timeout for AI parsing
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      const response = await customAxios.post<ApiResponse<any>>(
        `/api/groups/${groupId}/parse-census`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          signal: abortSignal, // Support cancellation
        }
      );
      
      const apiResponse = response.data;
      
      if (apiResponse.success) {
        console.log('✅ Census file parsed successfully');
        return apiResponse;
      } else {
        console.error('❌ Failed to parse census file:', apiResponse.message);
        return {
          success: false,
          message: apiResponse.message || 'Failed to parse census file',
          data: null
        };
      }
    } catch (error: any) {
      // Check if request was cancelled
      if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
        console.log('🛑 Census parsing cancelled by user');
        return {
          success: false,
          message: 'Parsing was cancelled',
          data: null
        };
      }
      
      console.error('❌ Error parsing census file:', error);
      
      // Check if it's a timeout error
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        return {
          success: false,
          message: 'Parsing timed out. The file may be too large or complex. Please try the Standard Import option or contact support.',
          data: null
        };
      }
      
      return {
        success: false,
        message: error.response?.data?.message || error.message || 'Failed to parse census file',
        data: null
      };
    }
  }

  static async getGroupMembers(groupId: string): Promise<ApiResponse<Member[]>> {
    try {
      return await apiService.get<ApiResponse<Member[]>>(`/api/me/tenant-admin/groups/${groupId}/members`);
    } catch (error) {
      console.error(`Error fetching members for group ${groupId}:`, error);
      return { success: false, data: [], message: `Failed to fetch members for group ${groupId}` };
    }
  }

  /**
   * Get dependents for a member (by household)
   */
  static async getDependents(memberId: string): Promise<ApiResponse<Array<{
    MemberId: string;
    RelationshipType: string;
    DateOfBirth: string | null;
    Gender: string | null;
    FirstName: string;
    LastName: string;
    Email: string;
    PhoneNumber: string | null;
    RelationshipDescription: string;
  }>>> {
    try {
      return await apiService.get<ApiResponse<Array<{
        MemberId: string;
        RelationshipType: string;
        DateOfBirth: string | null;
        Gender: string | null;
        FirstName: string;
        LastName: string;
        Email: string;
        PhoneNumber: string | null;
        RelationshipDescription: string;
      }>>>(`/api/members/${memberId}/dependents`);
    } catch (error) {
      console.error(`Error fetching dependents for member ${memberId}:`, error);
      return { success: false, data: [], message: `Failed to fetch dependents` };
    }
  }

  /**
   * Export members to CSV
   * @param filters Optional filters to apply to the export
   * @returns Promise that resolves to a Blob for download
   */
  static async exportMembers(filters?: MemberFilterState): Promise<Blob> {
    try {
      console.log('📊 MembersService.exportMembers called with filters:', filters);
      
      // Build query parameters from filters
      const queryParams = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (key === 'agentId' && isAgentFilterScopeSentinel(String(value))) return;
          if (value !== undefined && value !== '' && value !== null) {
            queryParams.append(key, String(value));
          }
        });
      }
      
      const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
      const endpoint = `/api/members/export${queryString}`;
      
      console.log('🔗 Calling export endpoint:', endpoint);
      
      // Use axios directly to get blob response
      const token = await authService.getAccessToken();
      if (!token) {
        throw new Error('No authentication token available');
      }
      
      const response = await axios.get(`${API_CONFIG.BASE_URL || window.location.origin}${endpoint}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        responseType: 'blob',
      });
      
      return response.data;
    } catch (error) {
      console.error('❌ Error exporting members:', error);
      throw error;
    }
  }
} 