// frontend/src/hooks/useEnrollmentLinkTemplates.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { AgentsService } from '../services/agents.service';
import {
    AgentOption,
    CreateTemplateRequest,
    EnrollmentLinkTemplate,
    EnrollmentLinkTemplateFilters,
    EnrollmentLinkTemplatesService,
    PaginatedResponse,
    UpdateTemplateRequest
} from '../services/enrollment-link-templates.service';

// Query Keys
export const unifiedEnrollmentLinkTemplateKeys = {
  all: ['unified-enrollment-link-templates'] as const,
  lists: () => [...unifiedEnrollmentLinkTemplateKeys.all, 'list'] as const,
  list: (filters: EnrollmentLinkTemplateFilters) => [...unifiedEnrollmentLinkTemplateKeys.lists(), filters] as const,
  details: () => [...unifiedEnrollmentLinkTemplateKeys.all, 'detail'] as const,
  detail: (id: string) => [...unifiedEnrollmentLinkTemplateKeys.details(), id] as const,
};

/**
 * Hook to get enrollment link templates with pagination and filtering
 * Works for all roles: SysAdmin, TenantAdmin, Agent
 */
export const useEnrollmentLinkTemplates = (filters?: EnrollmentLinkTemplateFilters) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery({
    queryKey: unifiedEnrollmentLinkTemplateKeys.list(filters || {}),
    queryFn: async (): Promise<PaginatedResponse<EnrollmentLinkTemplate>> => {
      console.log('🔍 Fetching unified enrollment link templates', { filters, userRole: user?.currentRole });
      const response = await EnrollmentLinkTemplatesService.getTemplates(filters, user?.currentRole);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch enrollment link templates');
      }
      
      return response.data || { data: [], pagination: { currentPage: 1, totalPages: 0, totalCount: 0, limit: 20, hasNextPage: false, hasPreviousPage: false } };
    },
    enabled: !isAuthLoading && !!user && ['SysAdmin', 'TenantAdmin', 'Agent'].includes(user.currentRole || ''),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

/**
 * Hook to get a specific enrollment link template by ID
 */
export const useUnifiedEnrollmentLinkTemplate = (templateId: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery({
    queryKey: unifiedEnrollmentLinkTemplateKeys.detail(templateId),
    queryFn: async (): Promise<EnrollmentLinkTemplate> => {
      console.log('🔍 Fetching enrollment link template:', templateId);
      const response = await EnrollmentLinkTemplatesService.getTemplate(templateId, user?.currentRole);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch enrollment link template');
      }
      
      return response.data!;
    },
    enabled: !isAuthLoading && !!user && !!templateId && ['SysAdmin', 'TenantAdmin', 'Agent'].includes(user.currentRole || ''),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

/**
 * Hook to create a new enrollment link template
 */
export const useCreateEnrollmentLinkTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (templateData: CreateTemplateRequest & { currentRole?: string }) => {
      console.log('🔧 Creating enrollment link template:', templateData);
      const { currentRole, ...templateDataWithoutRole } = templateData;
      const response = await EnrollmentLinkTemplatesService.createTemplate(templateDataWithoutRole, currentRole);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to create enrollment link template');
      }
      
      return response.data;
    },
    onSuccess: () => {
      // Invalidate all template lists to refresh data
      queryClient.invalidateQueries({ queryKey: unifiedEnrollmentLinkTemplateKeys.lists() });
    },
  });
};

/**
 * Hook to update an enrollment link template
 */
export const useUpdateEnrollmentLinkTemplate = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ templateId, templateData }: { templateId: string; templateData: UpdateTemplateRequest }) => {
      console.log('🔧 Updating enrollment link template:', templateId, templateData);
      const response = await EnrollmentLinkTemplatesService.updateTemplate(templateId, templateData, user?.currentRole);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to update enrollment link template');
      }
      
      return response.data;
    },
    onSuccess: (_, { templateId }) => {
      // Invalidate the specific template and all lists
      queryClient.invalidateQueries({ queryKey: unifiedEnrollmentLinkTemplateKeys.detail(templateId) });
      queryClient.invalidateQueries({ queryKey: unifiedEnrollmentLinkTemplateKeys.lists() });
    },
  });
};

/**
 * Hook to delete an enrollment link template
 */
export const useDeleteEnrollmentLinkTemplate = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (templateId: string) => {
      console.log('🗑️ Deleting enrollment link template:', templateId);
      const response = await EnrollmentLinkTemplatesService.deleteTemplate(templateId, user?.currentRole);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to delete enrollment link template');
      }
      
      return response; // Return full response object to access message
    },
    onSuccess: (_, templateId) => {
      // Remove the specific template from cache and invalidate lists
      queryClient.removeQueries({ queryKey: unifiedEnrollmentLinkTemplateKeys.detail(templateId) });
      queryClient.invalidateQueries({ queryKey: unifiedEnrollmentLinkTemplateKeys.lists() });
    },
  });
};

/**
 * Hook to get tenants for SysAdmin dropdown
 */
export const useTenantsForDropdown = () => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery({
    queryKey: ['tenants-dropdown'],
    queryFn: async () => {
      console.log('🔍 Fetching tenants for dropdown');
      const response = await EnrollmentLinkTemplatesService.getTenants();
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch tenants');
      }
      
      return response.data || [];
    },
    enabled: !isAuthLoading && !!user && user.currentRole === 'SysAdmin',
    staleTime: 10 * 60 * 1000, // 10 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
  });
};

/**
 * Hook to get agents for dropdown (filtered by tenant) - Optional selection
 * For Agent role, returns current agent only. For AgencyOwner (Agent + AgencyOwner in roles), returns self + downline.
 */
export const useAgentsForDropdown = (tenantId?: string, search?: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  const isAgencyOwner = user?.currentRole === 'Agent' && (user?.roles as string[] | undefined)?.includes('AgencyOwner');

  return useQuery({
    queryKey: ['agents-dropdown', tenantId, search, user?.currentRole, user?.email, isAgencyOwner],
    queryFn: async (): Promise<AgentOption[]> => {
      if (user?.currentRole === 'Agent' && isAgencyOwner) {
        const response = await AgentsService.getAgentsAndAgencies('Agent', {});
        if (!response.success || !response.data) return [];
        const agents = response.data.filter((a: { Type: string }) => a.Type === 'Agent');
        return agents.map((a: { Id: string; Name: string; Email?: string; AgencyId?: string }) => ({
          AgentId: a.Id,
          AgentName: a.Name,
          Email: a.Email || '',
          TenantId: '',
          TenantName: '',
          Type: 'Agent' as const,
          AgencyId: a.AgencyId
        }));
      }
      console.log('🔍 Fetching agents for dropdown', { tenantId, search, currentRole: user?.currentRole, userEmail: user?.email });
      const response = await EnrollmentLinkTemplatesService.getAgents(tenantId, user?.currentRole, search);
      if (!response.success) throw new Error(response.message || 'Failed to fetch agents');
      if (user?.currentRole === 'Agent' && user?.email) {
        const currentAgent = response.data?.filter(agent => agent.Email === user.email) || [];
        return currentAgent;
      }
      return response.data || [];
    },
    enabled: !isAuthLoading && !!user && ['SysAdmin', 'TenantAdmin', 'Agent'].includes(user.currentRole || '') &&
             (user.currentRole === 'TenantAdmin' || user.currentRole === 'Agent' || user.currentRole === 'SysAdmin'),
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });
};

/**
 * Hook to get role-based configuration for the current user
 */
export const useEnrollmentLinkTemplateRoleConfig = () => {
  const { user } = useAuth();
  
  return EnrollmentLinkTemplatesService.getRoleConfig(user?.currentRole || '');
};
