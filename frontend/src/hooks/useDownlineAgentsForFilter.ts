import { useQuery } from '@tanstack/react-query';
import {
  AGENT_FILTER_SCOPE_AGENCY,
  AGENT_FILTER_SCOPE_DIRECT_DOWNLINE,
  AGENT_FILTER_SHOW_ALL
} from '../constants/agentFilterScope';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';

export { AGENT_FILTER_SHOW_ALL, AGENT_FILTER_SCOPE_AGENCY, AGENT_FILTER_SCOPE_DIRECT_DOWNLINE };

export interface DownlineAgentOption {
  id: string;
  label: string;
  value: string;
  email?: string;
  commissionTierLevel?: number | null;
}

export type UseDownlineAgentsForFilterResult = {
  data: DownlineAgentOption[];
  currentAgentId: string | null;
  agencyWideFilterAvailable: boolean;
  isLoading: boolean;
};

interface DownlineAgentsResponse {
  success: boolean;
  data?: {
    currentAgentId: string | null;
    agencyWideFilterAvailable?: boolean;
    agents: Array<{ AgentId: string; Name: string; Email?: string; CommissionTierLevel?: number | null }>;
  };
}

const LABEL_ALL_AGENCY_AGENTS = 'All Agency Agents';
const LABEL_DIRECT_DOWNLINES = 'Direct downlines';

function downlineTreeLabel(hasDownlines: boolean): string {
  return hasDownlines ? 'All Downline Agents' : 'Show all';
}

/**
 * Hook to get current agent + agents for filter dropdown (Agent role only).
 * **Agency owners / oe.AgencyAdmins** load selectable agents from the **whole agency** (`agencyPool=1`);
 * backend sets `agencyWideFilterAvailable` when that applies.
 * When includeShowAllOption, prepends scope rows for Members & Groups pages.
 */
export const useDownlineAgentsForFilter = (opts?: {
  includeShowAllOption?: boolean;
  /** Adds Agency / Direct downlines / Full downline scope rows (Members & Groups pages). */
  agencyOwnerFilter?: boolean;
}): UseDownlineAgentsForFilterResult => {
  const includeShowAllOption = opts?.includeShowAllOption === true;
  const agencyOwnerScopeRows = opts?.agencyOwnerFilter === true;
  const { user, isLoading: isAuthLoading } = useAuth();

  const agentPortalRole = user?.currentRole === 'Agent' || user?.currentRole === 'AgencyOwner';

  const query = useQuery({
    queryKey: ['downline-agents-for-filter', user?.currentRole, user?.userId, includeShowAllOption, agencyOwnerScopeRows],
    queryFn: async (): Promise<{
      options: DownlineAgentOption[];
      currentAgentId: string | null;
      agencyWideFilterAvailable: boolean;
    }> => {
      // Always send agencyPool=1; backend only applies agency-wide list when viewer is owner/admin.
      const response = await apiService.get<DownlineAgentsResponse>(
        `/api/me/agent/agents/downline-agents?agencyPool=1`
      );
      const agencyWideFilterAvailable = response.data?.agencyWideFilterAvailable === true;
      const currentAgentId = response.data?.currentAgentId ?? null;
      const agents = response.data?.agents ?? [];
      const hasDownlines = agents.length > 1;
      const treeLabel = downlineTreeLabel(hasDownlines);

      const showAllOption: DownlineAgentOption = {
        id: 'all',
        value: AGENT_FILTER_SHOW_ALL,
        label: treeLabel,
        email: undefined
      };

      const defaultOptions: DownlineAgentOption[] = includeShowAllOption
        ? [showAllOption, { id: 'me', value: '', label: 'Me', email: undefined }]
        : [{ id: 'me', value: '', label: 'Me', email: undefined }];

      const agencyOwnerDefaultOptions: DownlineAgentOption[] = includeShowAllOption
        ? [
            { id: 'agency', value: AGENT_FILTER_SCOPE_AGENCY, label: LABEL_ALL_AGENCY_AGENTS, email: undefined },
            { id: 'direct', value: AGENT_FILTER_SCOPE_DIRECT_DOWNLINE, label: LABEL_DIRECT_DOWNLINES, email: undefined },
            { id: 'tree', value: AGENT_FILTER_SHOW_ALL, label: treeLabel, email: undefined },
            { id: 'me', value: '', label: 'Me', email: undefined }
          ]
        : [{ id: 'me', value: '', label: 'Me', email: undefined }];

      const showAgencyOwnerScopeRows = agencyWideFilterAvailable && agencyOwnerScopeRows && includeShowAllOption;

      if (!response.success || agents.length === 0) {
        return {
          options: showAgencyOwnerScopeRows ? agencyOwnerDefaultOptions : defaultOptions,
          currentAgentId,
          agencyWideFilterAvailable
        };
      }
      const self = agents[0];
      const selfOption: DownlineAgentOption = {
        id: 'me',
        value: '',
        label: self.Name || self.Email || 'Me',
        email: self.Email,
        commissionTierLevel:
          self.CommissionTierLevel != null && Number.isFinite(Number(self.CommissionTierLevel))
            ? Number(self.CommissionTierLevel)
            : null
      };
      const downlineOptions: DownlineAgentOption[] = agents.slice(1).map((a) => ({
        id: a.AgentId,
        value: a.AgentId,
        label: a.Name || a.Email || 'Unknown',
        email: a.Email,
        commissionTierLevel:
          a.CommissionTierLevel != null && Number.isFinite(Number(a.CommissionTierLevel))
            ? Number(a.CommissionTierLevel)
            : null
      }));

      if (showAgencyOwnerScopeRows) {
        return {
          options: [
            { id: 'agency', value: AGENT_FILTER_SCOPE_AGENCY, label: LABEL_ALL_AGENCY_AGENTS, email: undefined },
            { id: 'direct', value: AGENT_FILTER_SCOPE_DIRECT_DOWNLINE, label: LABEL_DIRECT_DOWNLINES, email: undefined },
            { id: 'tree', value: AGENT_FILTER_SHOW_ALL, label: treeLabel, email: undefined },
            selfOption,
            ...downlineOptions
          ],
          currentAgentId,
          agencyWideFilterAvailable
        };
      }

      const rest = [selfOption, ...downlineOptions];
      return {
        options: includeShowAllOption ? [showAllOption, ...rest] : rest,
        currentAgentId,
        agencyWideFilterAvailable
      };
    },
    enabled: !isAuthLoading && !!user && agentPortalRole,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000
  });

  const agencyWideFilterAvailable = query.data?.agencyWideFilterAvailable ?? false;
  const fallbackAgencyRows =
    agencyWideFilterAvailable && agencyOwnerScopeRows && includeShowAllOption;
  const fallbackTreeLabel = downlineTreeLabel(false);
  const fallback: DownlineAgentOption[] = fallbackAgencyRows
    ? [
        { id: 'agency', value: AGENT_FILTER_SCOPE_AGENCY, label: LABEL_ALL_AGENCY_AGENTS, email: undefined },
        { id: 'direct', value: AGENT_FILTER_SCOPE_DIRECT_DOWNLINE, label: LABEL_DIRECT_DOWNLINES, email: undefined },
        { id: 'tree', value: AGENT_FILTER_SHOW_ALL, label: fallbackTreeLabel, email: undefined },
        { id: 'me', value: '', label: 'Me', email: undefined }
      ]
    : includeShowAllOption
      ? [
          {
            id: 'all',
            value: AGENT_FILTER_SHOW_ALL,
            label: fallbackTreeLabel,
            email: undefined
          },
          { id: 'me', value: '', label: 'Me', email: undefined }
        ]
      : [{ id: 'me', value: '', label: 'Me', email: undefined }];

  return {
    data: (query.data?.options ?? fallback) as DownlineAgentOption[],
    currentAgentId: query.data?.currentAgentId ?? null,
    agencyWideFilterAvailable,
    isLoading: query.isLoading
  };
};

