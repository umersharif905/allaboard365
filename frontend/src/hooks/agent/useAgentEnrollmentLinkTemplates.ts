// frontend/src/hooks/agent/useAgentEnrollmentLinkTemplates.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    AgentEnrollmentLinkTemplatesService,
    CreateTemplateRequest,
    EnrollmentLinkTemplateFilters,
    UpdateTemplateRequest
} from '../../services/agent/agent-enrollment-link-templates.service';

// Query keys
const QUERY_KEYS = {
  templates: (filters?: EnrollmentLinkTemplateFilters) => ['agent-enrollment-link-templates', filters],
  template: (templateId: string) => ['agent-enrollment-link-template', templateId],
} as const;

/**
 * Hook to fetch enrollment link templates for the authenticated agent
 */
export const useAgentEnrollmentLinkTemplates = (filters?: EnrollmentLinkTemplateFilters) => {
  return useQuery({
    queryKey: QUERY_KEYS.templates(filters),
    queryFn: () => AgentEnrollmentLinkTemplatesService.getTemplates(filters),
    gcTime: 5 * 60 * 1000, // 5 minutes
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
};

/**
 * Hook to fetch a single enrollment link template by ID
 */
export const useAgentEnrollmentLinkTemplate = (templateId: string) => {
  return useQuery({
    queryKey: QUERY_KEYS.template(templateId),
    queryFn: () => AgentEnrollmentLinkTemplatesService.getTemplateById(templateId),
    enabled: !!templateId,
    gcTime: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
};

/**
 * Hook to create a new enrollment link template
 */
export const useCreateAgentEnrollmentLinkTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (templateData: CreateTemplateRequest) => 
      AgentEnrollmentLinkTemplatesService.createTemplate(templateData),
    onSuccess: () => {
      // Invalidate templates list to refetch
      queryClient.invalidateQueries({ 
        queryKey: ['agent-enrollment-link-templates'] 
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
export const useUpdateAgentEnrollmentLinkTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ templateId, templateData }: { templateId: string; templateData: UpdateTemplateRequest }) => 
      AgentEnrollmentLinkTemplatesService.updateTemplate(templateId, templateData),
    onSuccess: (_, { templateId }) => {
      // Invalidate both the templates list and the specific template
      queryClient.invalidateQueries({ 
        queryKey: ['agent-enrollment-link-templates'] 
      });
      queryClient.invalidateQueries({ 
        queryKey: ['agent-enrollment-link-template', templateId] 
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
export const useDeleteAgentEnrollmentLinkTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (templateId: string) => 
      AgentEnrollmentLinkTemplatesService.deleteTemplate(templateId),
    onSuccess: () => {
      // Invalidate templates list to refetch
      queryClient.invalidateQueries({ 
        queryKey: ['agent-enrollment-link-templates'] 
      });
    },
    onError: (error) => {
      console.error('Error deleting enrollment link template:', error);
    },
  });
};