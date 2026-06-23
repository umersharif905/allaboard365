import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import AgentService from '../../services/agent/agent.service';

export interface PendingTypeChangeAction {
  RequestId: string;
  GroupId: string;
  GroupName: string;
  CurrentType: 'Standard' | 'ListBill';
  RequestedType: 'Standard' | 'ListBill';
  ReviewedAt: string | null;
  ReviewNotes: string | null;
}

/**
 * Lists "Approved but not yet applied" group type-change requests for the
 * logged-in agent. Powers:
 *   - the banner on GroupDetails ("Conversion approved → continue to wizard")
 *   - the yellow dot on group rows in the agent's groups list
 *
 * Returns both the raw list and a Set of GroupIds for fast row lookups.
 */
export const useAgentPendingTypeChanges = () => {
  const { user, isLoading: isAuthLoading } = useAuth();
  const enabled = !isAuthLoading && !!user && user.currentRole === 'Agent';

  const query = useQuery<PendingTypeChangeAction[], Error>({
    queryKey: ['agentPendingTypeChanges', user?.userId, user?.tenantId],
    enabled,
    queryFn: async () => {
      const res = await AgentService.getPendingTypeChangeActions();
      if (!res.success || !res.data) return [];
      return res.data;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true
  });

  const groupIdsWithAction = new Set((query.data || []).map((r) => r.GroupId.toUpperCase()));
  const findForGroup = (groupId?: string | null): PendingTypeChangeAction | undefined => {
    if (!groupId) return undefined;
    const target = groupId.toUpperCase();
    return (query.data || []).find((r) => r.GroupId.toUpperCase() === target);
  };

  return { ...query, groupIdsWithAction, findForGroup };
};
