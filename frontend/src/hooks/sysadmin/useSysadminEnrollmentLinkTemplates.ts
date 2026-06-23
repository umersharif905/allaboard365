// frontend/src/hooks/sysadmin/useSysadminEnrollmentLinkTemplates.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateTemplateRequest,
  EnrollmentLinkTemplateFilters,
  SysadminEnrollmentLinkTemplatesService,
  UpdateTemplateRequest
} from '../../services/sysadmin/sysadmin-enrollment-link-templates.service';

// Query keys
const QUERY_KEYS = {
  templates: (filters?: EnrollmentLinkTemplateFilters) => ['sysadmin-enrollment-link-templates', filters],
  template: (templateId: string) => ['sysadmin-enrollment-link-template', templateId],
  tenants: () => ['sysadmin-tenants-dropdown'],
  agents: (tenantId?: string) => ['sysadmin-agents-dropdown', tenantId],
} as const;

/**
 * Hook to fetch enrollment link templates (sysadmin can see all)
 */
export const useSysadminEnrollmentLinkTemplates = (filters?: EnrollmentLinkTemplateFilters) => {
  return useQuery({
    queryKey: QUERY_KEYS.templates(filters),
    queryFn: () => SysadminEnrollmentLinkTemplatesService.getTemplates(filters),
    gcTime: 5 * 60 * 1000, // 5 minutes
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
};

/**
 * Hook to fetch a single enrollment link template by ID
 */
export const useSysadminEnrollmentLinkTemplate = (templateId: string) => {
  return useQuery({
    queryKey: QUERY_KEYS.template(templateId),
    queryFn: () => SysadminEnrollmentLinkTemplatesService.getTemplateById(templateId),
    enabled: !!templateId,
    gcTime: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
};

/**
 * Hook to fetch tenants for dropdown (sysadmin only)
 */
export const useSysadminTenantsForDropdown = () => {
  return useQuery({
    queryKey: QUERY_KEYS.tenants(),
    queryFn: () => SysadminEnrollmentLinkTemplatesService.getTenants(),
    gcTime: 10 * 60 * 1000, // 10 minutes
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/**
 * Hook to fetch agents for dropdown (sysadmin - all agents, optionally filtered by tenant)
 */
export const useSysadminAgentsForDropdown = (tenantId?: string) => {
  return useQuery({
    queryKey: QUERY_KEYS.agents(tenantId),
    queryFn: () => SysadminEnrollmentLinkTemplatesService.getAgents(tenantId),
    gcTime: 10 * 60 * 1000, // 10 minutes
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/**
 * Hook to create a new enrollment link template
 */
export const useCreateSysadminEnrollmentLinkTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (templateData: CreateTemplateRequest) => 
      SysadminEnrollmentLinkTemplatesService.createTemplate(templateData),
    onSuccess: () => {
      // Invalidate templates list to refetch
      queryClient.invalidateQueries({ 
        queryKey: ['sysadmin-enrollment-link-templates'] 
      });
    },
    onError: (error) => {
      console.error('Error creating enrollment link template:', error);
    },
  });
};

/**
 * Hook to update an enrollment link template
 */
export const useUpdateSysadminEnrollmentLinkTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ templateId, templateData }: { templateId: string; templateData: UpdateTemplateRequest }) => 
      SysadminEnrollmentLinkTemplatesService.updateTemplate(templateId, templateData),
    onSuccess: (_, { templateId }) => {
      // Invalidate both the templates list and the specific template
      queryClient.invalidateQueries({ 
        queryKey: ['sysadmin-enrollment-link-templates'] 
      });
      queryClient.invalidateQueries({ 
        queryKey: ['sysadmin-enrollment-link-template', templateId] 
      });
    },
    onError: (error) => {
      console.error('Error updating enrollment link template:', error);
    },
  });
};

/**
 * Hook to delete an enrollment link template
 */
export const useDeleteSysadminEnrollmentLinkTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (templateId: string) => 
      SysadminEnrollmentLinkTemplatesService.deleteTemplate(templateId),
    onSuccess: () => {
      // Invalidate templates list to refetch
      queryClient.invalidateQueries({ 
        queryKey: ['sysadmin-enrollment-link-templates'] 
      });
    },
    onError: (error) => {
      console.error('Error deleting enrollment link template:', error);
    },
  });
};