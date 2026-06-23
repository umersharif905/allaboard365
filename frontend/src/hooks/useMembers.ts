// frontend/src/hooks/useMembers.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';
import { MembersService, type MemberFilterState, type MemberResponse } from '../services/members.service';

export type AgentMemberMetricsQuery = {
  agentId?: string;
  /** auto: agency-wide if AgencyOwner or oe.AgencyAdmins; else self + full downline */
  scope?: 'downline' | 'agency' | 'direct' | 'auto';
};

/**
 * Custom hook for fetching members data with role-based logic
 * Follows the new backend-system.md patterns
 */
export const useMembers = (filters: MemberFilterState = {}) => {
  const { user, isLoading } = useAuth();

  return useQuery({
    queryKey: ['members', filters, user?.currentRole],
    queryFn: async (): Promise<MemberResponse> => {
      console.log('🔍 useMembers: Fetching members with role:', user?.currentRole);
      
      if (!user?.roles) {
        throw new Error('User roles not available');
      }

      // Role-based data fetching logic
      if (user.currentRole === 'SysAdmin') {
        // SysAdmin can see all members across all tenants
        console.log('📊 Using SysAdmin endpoint - all members');
        const response = await MembersService.getAllMembers(filters);
        if (!response.success || !response.data) {
          throw new Error(response.message || 'Failed to fetch members');
        }
        return response.data;
      } else if (user.currentRole === 'TenantAdmin') {
        // TenantAdmin can see all members in their tenant
        console.log('🏢 Using TenantAdmin endpoint - tenant members');
        const response = await MembersService.getTenantAdminMembers(filters);
        if (!response.success || !response.data) {
          throw new Error(response.message || 'Failed to fetch tenant members');
        }
        return response.data;
      } else if (user.currentRole === 'Agent') {
        // Agent can see members in their assigned groups
        console.log('👤 Using Agent endpoint - agent members with filters:', filters);
        const response = await MembersService.getAgentMembers(filters);
        if (!response.success || !response.data) {
          throw new Error(response.message || 'Failed to fetch agent members');
        }
        return response.data;
      } else if (user.currentRole === 'GroupAdmin') {
        // GroupAdmin can see members in their group
        console.log('👥 Using GroupAdmin endpoint - group members with filters:', filters);
        const response = await MembersService.getGroupAdminMembers(filters);
        if (!response.success || !response.data) {
          throw new Error(response.message || 'Failed to fetch group members');
        }
        return response.data;
      } else {
        throw new Error('User does not have permission to view members');
      }
    },
    enabled: !isLoading && !!user && !!user.roles,
    staleTime: 2 * 60 * 1000, // 2 minutes
    retry: 1, // Reduce retries to prevent rate limiting
    retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 10000), // Longer delays
  });
};

/**
 * Custom hook for fetching member metrics with role-based logic.
 * Sends `currentRole` so backend can scope TenantAdmin vs Agent (prompts/backend-system.md — validated server-side).
 * For Agent / AgencyOwner: pass scope (downline | agency | direct | auto) or agentId.
 */
export const useMemberMetrics = (agentQuery: AgentMemberMetricsQuery = {}) => {
  const { user, isLoading } = useAuth();

  return useQuery({
    queryKey: ['member-metrics', user?.currentRole, agentQuery.agentId, agentQuery.scope],
    queryFn: async () => {
      console.log('📊 useMemberMetrics: Fetching metrics with role:', user?.currentRole);
      
      if (!user?.roles) {
        throw new Error('User roles not available');
      }

      const params = new URLSearchParams();
      if (user.currentRole) {
        params.set('currentRole', user.currentRole);
      }
      const agentLikeRole =
        user.currentRole === 'Agent' ||
        user.currentRole === 'AgencyOwner';
      if (agentLikeRole) {
        if (agentQuery.scope === 'downline' || agentQuery.scope === 'agency' || agentQuery.scope === 'direct' || agentQuery.scope === 'auto') {
          params.set('scope', agentQuery.scope);
        } else if (agentQuery.agentId) {
          params.set('agentId', agentQuery.agentId);
        }
      }
      const qs = params.toString();
      const url = qs ? `/api/metrics/members?${qs}` : '/api/metrics/members';

      console.log('📊 Using unified role-aware metrics endpoint for:', user.currentRole);
      const response = await apiService.get<{ success: boolean, data: any, message?: string }>(url);
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch metrics');
      }
      return response.data;
    },
    enabled: !isLoading && !!user && !!user.roles,
    staleTime: 5 * 60 * 1000, // 5 minutes for metrics
    retry: 1, // Reduce retries to prevent rate limiting
  });
};

/**
 * Hook for refetching members data
 */
export const useRefreshMembers = () => {
  return {
    invalidateMembers: () => {
      // This would typically use queryClient.invalidateQueries
      // but for now we'll keep it simple
      window.location.reload();
    }
  };
};