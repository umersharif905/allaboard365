// frontend/src/hooks/useProspects.ts
// TanStack Query hooks for the Prospects CRM.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';
import ProspectService, {
  CreateProspectInput,
  CreateQuoteInput,
  ProspectListParams,
  ProspectStatsParams,
  UpdateProspectInput,
} from '../services/prospect.service';

const KEY = 'prospects';

export const useProspects = (params: ProspectListParams) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: [KEY, 'list', user?.currentRole, params],
    queryFn: () => ProspectService.list(params),
    enabled: !!user,
  });
};

/**
 * Insights dashboard aggregates. Scoped by the same agent/agency filters as the
 * list, plus optional `sourceId` and a `from`/`to` date range (ISO yyyy-MM-dd;
 * the backend defaults to the trailing 12 months when no range is given). All
 * filter params live on `params` and feed the queryKey, so changing the source
 * or date range refetches automatically.
 */
export const useProspectStats = (params: ProspectStatsParams, enabled = true) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: [KEY, 'stats', user?.currentRole, params],
    queryFn: () => ProspectService.getStats(params),
    enabled: enabled && !!user,
  });
};

export const useProspect = (prospectId: string | null | undefined) => {
  return useQuery({
    queryKey: [KEY, 'detail', prospectId],
    queryFn: () => ProspectService.get(prospectId as string),
    enabled: !!prospectId,
  });
};

export const useCreateProspect = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProspectInput) => ProspectService.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, 'list'] }),
  });
};

export const useUpdateProspect = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prospectId, input }: { prospectId: string; input: UpdateProspectInput }) =>
      ProspectService.update(prospectId, input),
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: [KEY, 'list'] });
      qc.invalidateQueries({ queryKey: [KEY, 'detail', detail.prospect.ProspectId] });
    },
  });
};

export const useProspectCommunications = (prospectId: string | null | undefined) => {
  return useQuery({
    queryKey: [KEY, 'communications', prospectId],
    queryFn: () => ProspectService.communications(prospectId as string),
    enabled: !!prospectId,
  });
};

export const useSendProspectCommunication = (prospectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { channel: 'email' | 'sms'; subject?: string; body: string }) =>
      ProspectService.sendCommunication(prospectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, 'communications', prospectId] }),
  });
};

export const useProspectProposals = (prospectId: string | null | undefined) => {
  return useQuery({
    queryKey: [KEY, 'proposals', prospectId],
    queryFn: () => ProspectService.proposals(prospectId as string),
    enabled: !!prospectId,
  });
};

export const useCreateQuote = (prospectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateQuoteInput) => ProspectService.createQuote(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, 'proposals', prospectId] });
      qc.invalidateQueries({ queryKey: [KEY, 'detail', prospectId] });
      qc.invalidateQueries({ queryKey: [KEY, 'list'] });
    },
  });
};

export const useDeleteProspect = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prospectId: string) => ProspectService.remove(prospectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, 'list'] }),
  });
};

// --- Admin (TenantAdmin/SysAdmin) agency + agent filter sources ---
export interface FilterAgency { AgencyId: string; AgencyName: string }
export interface FilterAgent { AgentId: string; AgencyId: string | null; FirstName: string | null; LastName: string | null; Email: string | null }

export const useTenantAgencies = (enabled = true) => {
  return useQuery({
    queryKey: [KEY, 'filter-agencies'],
    queryFn: async () => {
      const r = await apiService.get<{ success: boolean; data?: FilterAgency[] }>('/api/agencies?limit=500');
      return r.data ?? [];
    },
    enabled,
  });
};

export const useTenantAgentsForFilter = (enabled = true) => {
  return useQuery({
    queryKey: [KEY, 'filter-agents'],
    queryFn: async () => {
      const r = await apiService.get<{ success: boolean; data?: FilterAgent[] }>('/api/agencies/agents?limit=1000');
      return r.data ?? [];
    },
    enabled,
  });
};

export const useAgentApiKeys = (enabled = true) => {
  return useQuery({
    queryKey: [KEY, 'api-keys'],
    queryFn: () => ProspectService.listApiKeys(),
    enabled,
  });
};

export const useCreateAgentApiKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name?: string) => ProspectService.createApiKey(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, 'api-keys'] }),
  });
};

export const useRevokeAgentApiKey = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (apiKeyId: string) => ProspectService.revokeApiKey(apiKeyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, 'api-keys'] }),
  });
};

export const useConfirmMemberLink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prospectId, memberId }: { prospectId: string; memberId?: string }) =>
      ProspectService.confirmMemberLink(prospectId, memberId),
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: [KEY, 'list'] });
      qc.invalidateQueries({ queryKey: [KEY, 'detail', detail.prospect.ProspectId] });
    },
  });
};

// --- Tag hooks ---
export const useProspectTags = () => {
  return useQuery({
    queryKey: [KEY, 'tags'],
    queryFn: () => ProspectService.listTags(),
  });
};

export const useCreateTag = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; color: string }) => ProspectService.createTag(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, 'tags'] });
    },
  });
};

export const useDeleteTag = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagId: string) => ProspectService.deleteTag(tagId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, 'tags'] });
      qc.invalidateQueries({ queryKey: [KEY, 'list'] });
    },
  });
};

export const useAssignProspectTag = (prospectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagId: string) => ProspectService.assignTag(prospectId, tagId),
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: [KEY, 'list'] });
      qc.invalidateQueries({ queryKey: [KEY, 'detail', detail.prospect.ProspectId] });
    },
  });
};

export const useRemoveProspectTag = (prospectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagId: string) => ProspectService.removeTag(prospectId, tagId),
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: [KEY, 'list'] });
      qc.invalidateQueries({ queryKey: [KEY, 'detail', detail.prospect.ProspectId] });
    },
  });
};

export const useReassignProspect = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prospectId, agentId }: { prospectId: string; agentId: string }) =>
      ProspectService.reassign(prospectId, agentId),
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: [KEY, 'list'] });
      qc.invalidateQueries({ queryKey: [KEY, 'detail', detail.prospect.ProspectId] });
    },
  });
};
